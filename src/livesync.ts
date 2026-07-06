// Mirror the live osu! session in the app:
//  - `live-select` (song pick / preview in song select): jump the sidebar +
//    detail view to that difficulty.
//  - `live-play` (gameplay start): jump there AND start the note chart's own
//    playback in sync, so the chart scrolls and plays audio aligned to osu!'s
//    audio (position 0 lands at the same instant). `live-stop` halts it.

import { listen } from "@tauri-apps/api/event";
import { isChartShowing, requestLivePlay, stopLivePlay } from "./detail";
import type { ManiaDiff, ManiaSet } from "./model";

// Enough to identify a difficulty in the library. Both live events carry these.
interface LiveId {
	artist: string;
	title: string;
	difficulty: string;
}

interface LivePlay extends LiveId {
	audioZeroEpochMs: number; // Unix epoch ms when song position 0 happens
	leadInMs: number;
}

function norm(s: string): string {
	return s.trim().toLowerCase();
}

// Browsers/webviews only let audio actually play after a real user gesture.
// Live-play starts a chart's AudioContext from an IPC event, not a gesture,
// so without this a chart the user never clicked into stays silently muted.
// One throwaway context resumed on the first real interaction unlocks audio
// for the whole page, including AudioContexts created later by live-sync.
function unlockAudioOnFirstGesture(): void {
	const unlock = () => {
		const ctx = new AudioContext();
		void ctx.resume().finally(() => void ctx.close());
	};
	document.addEventListener("pointerdown", unlock, { once: true });
	document.addEventListener("keydown", unlock, { once: true });
}

// Match the log's "{artist} - {title} [{difficulty}]" against the loaded library.
// The log uses romanized metadata; fall back to the unicode title just in case.
function resolveDiff(sets: ManiaSet[], p: LiveId): ManiaDiff | undefined {
	const a = norm(p.artist);
	const t = norm(p.title);
	const d = norm(p.difficulty);
	for (const set of sets) {
		for (const diff of set.difficulties) {
			if (norm(diff.name) !== d) continue;
			if (norm(diff.meta.artist) !== a) continue;
			if (norm(diff.meta.title) === t || norm(diff.meta.titleUnicode) === t) {
				return diff;
			}
		}
	}
	return undefined;
}

/**
 * Wire up live sync. `getSets` returns the loaded library; `navigate` jumps the
 * app UI to a difficulty's info page (which renders its note chart).
 */
export function initLiveSync(
	getSets: () => ManiaSet[],
	navigate: (diff: ManiaDiff) => void,
): void {
	unlockAudioOnFirstGesture();

	// Song pick in song select: jump the app to that difficulty (no audio).
	void listen<LiveId>("live-select", (e) => {
		const p = e.payload;
		const diff = resolveDiff(getSets(), p);
		if (diff) navigate(diff);
		else console.warn(`[livesync] no library match for pick ${p.artist} - ${p.title} [${p.difficulty}]`);
	});

	// Gameplay start: jump to the map, then start its note chart in sync.
	// audioZeroEpochMs is passed straight through — detail.ts converts it
	// directly to the AudioContext clock at the last possible moment.
	void listen<LivePlay>("live-play", (e) => {
		const p = e.payload;
		const diff = resolveDiff(getSets(), p);
		if (!diff) {
			console.warn(`[livesync] no library match for play ${p.artist} - ${p.title} [${p.difficulty}]`);
			return;
		}
		// a resume re-fires live-play for the same difficulty — skip
		// navigating so it re-syncs the existing chart instead of tearing
		// it down and re-decoding its audio from scratch.
		if (!isChartShowing(diff.hash)) navigate(diff);
		requestLivePlay(diff.hash, p.audioZeroEpochMs);
		console.info(
			`[livesync] ▶ ${p.artist} - ${p.title} [${p.difficulty}] — audio-zero in ${(p.audioZeroEpochMs - Date.now()).toFixed(1)}ms (lead-in ${p.leadInMs}ms)`,
		);
	});

	void listen("live-stop", () => stopLivePlay());
}
