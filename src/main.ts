import { info } from "@tauri-apps/plugin-log";
import { loadBeatmap, loadManiaLibrary } from "./api";
import { renderDetail } from "./detail";
import { initLiveSync } from "./livesync";
import { renderSidebar } from "./sidebar";
import { invoke } from '@tauri-apps/api/core';
import type { ManiaSet } from "./model";

async function boot() {
	const sidebar = document.getElementById("sidebar")!;
	const detail = document.getElementById("detail")!;
	detail.innerHTML = `<div class="placeholder">Select a difficulty to view its stats.</div>`;

	// Live-sync latency test: play whatever the live osu! session plays and jump
	// to its info page. Needs the library + sidebar, both populated after load, so
	// hand it lazy getters/closures.
	let sets: ManiaSet[] = [];
	let selectByHash: (hash: string) => boolean = () => false;
	initLiveSync(
		() => sets,
		(diff) => selectByHash(diff.hash),
	);

	try {
		const realmPath: string = await invoke("get_realm_path");
		sets = await loadManiaLibrary(realmPath);
		info(`loaded ${sets.length} mania sets`);

		// Guards against overlapping selections (e.g. a duplicate live-play):
		// only the most recent one is allowed to touch the UI, so a late,
		// out-of-order response can't clobber a newer selection.
		let selectionSeq = 0;
		const handle = renderSidebar(sidebar, sets, async (diff) => {
			const seq = ++selectionSeq;
			detail.innerHTML = `<div class="placeholder">Loading ${diff.name}…</div>`;
			try {
				const d = await loadBeatmap(diff.hash);
				if (seq !== selectionSeq) return; // superseded
				renderDetail(detail, diff, d);
			} catch (e) {
				if (seq !== selectionSeq) return;
				detail.innerHTML = `<div class="placeholder error">Failed to parse map: ${String(e)}</div>`;
			}
		});
		selectByHash = handle.selectByHash;
	} catch (e) {
		sidebar.innerHTML = `<div class="placeholder error">Failed to load realm: ${String(e)}</div>`;
		info("boot failed: " + String(e));
	}
}


boot()
// For some reason DOMContentLoaded dosen't work on linux
// window.addEventListener("DOMContentLoaded", () => {
// 	boot()
// });
