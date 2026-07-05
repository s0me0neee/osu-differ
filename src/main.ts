import { info } from "@tauri-apps/plugin-log";
import { loadBeatmap, loadRealm } from "./api";
import { renderDetail } from "./detail";
import { buildManiaSets } from "./model";
import { renderSidebar } from "./sidebar";

const REALM_PATH =
	"/Users/maot27/Library/Application Support/osu/client.realm.copy";

async function boot() {
	const sidebar = document.getElementById("sidebar")!;
	const detail = document.getElementById("detail")!;

	detail.innerHTML = `<div class="placeholder">Select a difficulty to view its stats.</div>`;

	try {
		const dump = await loadRealm(REALM_PATH);
		const sets = buildManiaSets(dump);
		info(`loaded ${sets.length} mania sets`);

		renderSidebar(sidebar, sets, async (diff) => {
			detail.innerHTML = `<div class="placeholder">Loading ${diff.name}…</div>`;
			try {
				const d = await loadBeatmap(diff.hash);
				renderDetail(detail, diff, d);
			} catch (e) {
				detail.innerHTML = `<div class="placeholder error">Failed to parse map: ${String(e)}</div>`;
			}
		});
	} catch (e) {
		sidebar.innerHTML = `<div class="placeholder error">Failed to load realm: ${String(e)}</div>`;
		info("boot failed: " + String(e));
	}
}

window.addEventListener("DOMContentLoaded", boot, { once: true });
