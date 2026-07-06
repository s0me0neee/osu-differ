// Latency test (not a feature): when the live osu! session starts a play, the
// Rust log tail emits `live-play`; we play the *same* song here, aligned so its
// position 0 sounds at the same instant osu's audio does. If they're in sync you
// hear a single sound; any offset is the real osu→app latency (dominated by
// osu's log-flush delay). `live-stop` halts it.

import { listen } from "@tauri-apps/api/event";
import { loadAudio } from "./api";
import type { ManiaDiff, ManiaSet } from "./model";

interface LivePlay {
	artist: string;
	title: string;
	difficulty: string;
	startInMs: number; // ms from emit until song position 0 (negative if passed)
	leadInMs: number;
}

let ctx: AudioContext | null = null;
let current: AudioBufferSourceNode | null = null;
const decoded = new Map<string, AudioBuffer>(); // audioHash -> buffer

function ensureCtx(): AudioContext {
	if (!ctx) ctx = new AudioContext();
	if (ctx.state === "suspended") void ctx.resume();
	return ctx;
}

function norm(s: string): string {
	return s.trim().toLowerCase();
}

// Match the log's "{artist} - {title} [{difficulty}]" against the loaded library.
// The log uses romanized metadata; fall back to the unicode title just in case.
function resolveDiff(sets: ManiaSet[], p: LivePlay): ManiaDiff | undefined {
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

async function getBuffer(c: AudioContext, hash: string): Promise<AudioBuffer> {
	const hit = decoded.get(hash);
	if (hit) return hit;
	const bytes = await loadAudio(hash);
	const buf = await c.decodeAudioData(bytes);
	decoded.set(hash, buf);
	return buf;
}

function stop(): void {
	if (current) {
		try {
			current.stop();
		} catch {
			/* already stopped */
		}
		current = null;
	}
}

async function onPlay(
	p: LivePlay,
	sets: ManiaSet[],
	navigate: (diff: ManiaDiff) => void,
): Promise<void> {
	const c = ensureCtx();
	const recvAt = c.currentTime; // audio-clock time we started handling this
	const diff = resolveDiff(sets, p);
	if (!diff) {
		console.warn(`[livesync] no library match for ${p.artist} - ${p.title} [${p.difficulty}]`);
		return;
	}
	// Jump the app to the played difficulty's info page (independent of audio).
	navigate(diff);
	if (!diff.audioHash) {
		console.warn(`[livesync] no audio file for ${p.artist} - ${p.title}`);
		return;
	}
	const buf = await getBuffer(c, diff.audioHash);
	stop();

	// Compensate for the time spent resolving/decoding since we received the
	// event, so the schedule still targets the original audio-zero instant.
	const spent = c.currentTime - recvAt;
	const startIn = p.startInMs / 1000 - spent;

	const src = c.createBufferSource();
	src.buffer = buf;
	src.connect(c.destination);
	if (startIn >= 0) {
		src.start(c.currentTime + startIn, 0); // wait, then play from the top
	} else {
		// audio-zero already passed: jump into the track by that much
		src.start(c.currentTime, Math.min(-startIn, buf.duration));
	}
	current = src;
	console.info(
		`[livesync] ${p.artist} - ${p.title} [${p.difficulty}] — scheduled in ${(startIn * 1000).toFixed(1)}ms (lead-in ${p.leadInMs}ms)`,
	);
}

/**
 * Wire up the live-sync latency test. `getSets` returns the loaded library;
 * `navigate` jumps the app UI to the played difficulty's info page.
 */
export function initLiveSync(
	getSets: () => ManiaSet[],
	navigate: (diff: ManiaDiff) => void,
): void {
	// AudioContext often starts suspended until a user gesture; unlock on first click.
	document.addEventListener(
		"pointerdown",
		() => {
			ensureCtx();
		},
		{ once: true },
	);
	void listen<LivePlay>("live-play", (e) => {
		void onPlay(e.payload, getSets(), navigate);
	});
	void listen("live-stop", () => stop());
}
