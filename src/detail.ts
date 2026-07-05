import type { BeatmapDetail } from "./api";
import type { ManiaDiff } from "./model";

function fmtTime(ms: number): string {
	const s = Math.round(ms / 1000);
	const m = Math.floor(s / 60);
	return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function el(cls: string, text?: string): HTMLElement {
	const e = document.createElement("div");
	e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
}

function statCard(label: string, value: string): HTMLElement {
	const card = el("stat");
	card.appendChild(el("stat-value", value));
	card.appendChild(el("stat-label", label));
	return card;
}

export function renderDetail(
	container: HTMLElement,
	diff: ManiaDiff,
	d: BeatmapDetail,
): void {
	container.textContent = "";
	const meta = diff.beatmap.Metadata;

	// header
	const header = el("detail-header");
	const titleEl = el("detail-title", meta.TitleUnicode || meta.Title);
	if (meta.Title && meta.TitleUnicode && meta.Title !== meta.TitleUnicode) {
		const alt = document.createElement("span");
		alt.className = "title-alt";
		alt.textContent = ` — ${meta.Title}`;
		titleEl.appendChild(alt);
	}
	header.appendChild(titleEl);
	header.appendChild(
		el("detail-sub", `${meta.Artist}${meta.Author?.Username ? `  ·  mapped by ${meta.Author.Username}` : ""}`),
	);
	header.appendChild(el("detail-diff", `[${d.key_count}K] ${diff.name}`));
	container.appendChild(header);

	// stat cards
	const bpmStr =
		Math.round(d.bpm.min) === Math.round(d.bpm.max)
			? `${Math.round(d.bpm.primary)}`
			: `${Math.round(d.bpm.min)}–${Math.round(d.bpm.max)}`;

	const grid = el("stat-grid");
	grid.appendChild(statCard("Star Rating", `★ ${d.star_rating.toFixed(2)}`));
	grid.appendChild(statCard("Keys", `${d.key_count}K`));
	grid.appendChild(statCard("BPM", bpmStr));
	grid.appendChild(statCard("Length", fmtTime(d.length_ms)));
	grid.appendChild(statCard("Notes", String(d.notes.length)));
	grid.appendChild(statCard("Taps", String(d.tap_count)));
	grid.appendChild(statCard("Holds", String(d.hold_count)));
	grid.appendChild(
		statCard("NPS", (d.notes.length / Math.max(d.length_ms / 1000, 1)).toFixed(1)),
	);
	container.appendChild(grid);

	// difficulty settings
	const diffRow = el("chip-row");
	const chips: [string, number][] = [
		["OD", d.difficulty.od],
		["HP", d.difficulty.hp],
		["AR", d.difficulty.ar],
		["CS", d.difficulty.cs],
	];
	for (const [k, v] of chips) {
		const c = el("chip");
		c.innerHTML = `<b>${k}</b> ${v.toFixed(1)}`;
		diffRow.appendChild(c);
	}
	container.appendChild(sectionTitle("Difficulty"));
	container.appendChild(diffRow);

	// per-column density
	container.appendChild(sectionTitle("Column distribution"));
	container.appendChild(columnBars(d));

	// note chart
	container.appendChild(sectionTitle("Note chart"));
	container.appendChild(noteChart(d));

	// timing points
	container.appendChild(sectionTitle(`Timing points (${d.timing_points.length})`));
	container.appendChild(timingList(d));
}

function sectionTitle(text: string): HTMLElement {
	return el("section-title", text);
}

function columnBars(d: BeatmapDetail): HTMLElement {
	const wrap = el("col-bars");
	const max = Math.max(...d.column_counts);
	const min = Math.min(...d.column_counts);
	const span = max - min;
	// Scale to the min→max range (not 0→max) so near-equal columns still
	// show a visible difference. The lowest column keeps a small floor.
	const FLOOR = 45; // % height for the smallest column
	d.column_counts.forEach((count, i) => {
		const col = el("col-bar");
		const fill = el("col-bar-fill");
		const norm = span === 0 ? 1 : (count - min) / span;
		fill.style.height = `${FLOOR + norm * (100 - FLOOR)}%`;
		if (count === max) fill.classList.add("peak");
		const val = el("col-bar-val", String(count));
		const lbl = el("col-bar-lbl", String(i + 1));
		col.appendChild(val);
		col.appendChild(fill);
		col.appendChild(lbl);
		wrap.appendChild(col);
	});
	return wrap;
}

function timingList(d: BeatmapDetail): HTMLElement {
	const wrap = el("timing-list");
	for (const tp of d.timing_points) {
		const row = el("timing-row");
		row.appendChild(el("timing-t", fmtTime(tp.time)));
		row.appendChild(el("timing-bpm", `${tp.bpm.toFixed(1)} BPM`));
		row.appendChild(el("timing-meter", `${tp.meter}/4`));
		wrap.appendChild(row);
	}
	return wrap;
}

/** Scrollable mania note-chart: lanes as rows, x = time. Uses canvas for perf. */
function noteChart(d: BeatmapDetail): HTMLElement {
	const scroller = el("chart-scroller");
	const canvas = document.createElement("canvas");
	scroller.appendChild(canvas);

	const PX_PER_MS = 0.06;
	const LANE_H = 16;
	const PAD = 8;
	const dpr = window.devicePixelRatio || 1;

	const start = d.notes.length ? d.notes[0].start_time : 0;
	const width = Math.max(600, d.length_ms * PX_PER_MS + PAD * 2);
	const height = d.key_count * LANE_H + PAD * 2;

	canvas.style.width = `${width}px`;
	canvas.style.height = `${height}px`;
	canvas.width = Math.floor(width * dpr);
	canvas.height = Math.floor(height * dpr);

	const ctx = canvas.getContext("2d")!;
	ctx.scale(dpr, dpr);

	// lane backgrounds
	for (let c = 0; c < d.key_count; c++) {
		ctx.fillStyle = c % 2 === 0 ? "#241d24" : "#1d171d";
		ctx.fillRect(0, PAD + c * LANE_H, width, LANE_H);
	}

	const x = (t: number) => PAD + (t - start) * PX_PER_MS;
	for (const n of d.notes) {
		const y = PAD + n.column * LANE_H + 2;
		const h = LANE_H - 4;
		if (n.end_time != null) {
			ctx.fillStyle = "#ff66aa";
			ctx.fillRect(x(n.start_time), y, Math.max(3, (n.end_time - n.start_time) * PX_PER_MS), h);
		} else {
			ctx.fillStyle = "#ffd0e8";
			ctx.fillRect(x(n.start_time), y, 4, h);
		}
	}

	return scroller;
}
