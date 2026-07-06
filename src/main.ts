import { info } from "@tauri-apps/plugin-log";
import { loadBeatmap, loadManiaLibrary } from "./api";
import { renderDetail } from "./detail";
import { initLiveSync } from "./livesync";
import { renderSidebar } from "./sidebar";
import type { ManiaSet } from "./model";

const REALM_PATH =
	"/Users/maot27/Library/Application Support/osu/client.realm.copy";

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
		sets = await loadManiaLibrary(REALM_PATH);
		info(`loaded ${sets.length} mania sets`);

		const handle = renderSidebar(sidebar, sets, async (diff) => {
			detail.innerHTML = `<div class="placeholder">Loading ${diff.name}…</div>`;
			try {
				const d = await loadBeatmap(diff.hash);
				renderDetail(detail, diff, d);
			} catch (e) {
				detail.innerHTML = `<div class="placeholder error">Failed to parse map: ${String(e)}</div>`;
			}
		});
		selectByHash = handle.selectByHash;
	} catch (e) {
		sidebar.innerHTML = `<div class="placeholder error">Failed to load realm: ${String(e)}</div>`;
		info("boot failed: " + String(e));
	}
}

window.addEventListener("DOMContentLoaded", boot, { once: true });
