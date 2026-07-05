import type { BeatmapDetail, ManiaNote, TimingInfo } from "./api";
import type { ManiaDiff } from "./model";

function fmtTime(ms: number): string {
	const s = Math.round(ms / 1000);
	const m = Math.floor(s / 60);
	return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function fmtTimeMs(ms: number): string {
	const total = Math.max(0, Math.round(ms));
	const m = Math.floor(total / 60000);
	const s = Math.floor((total % 60000) / 1000);
	const mmm = total % 1000;
	return `${m}:${String(s).padStart(2, "0")}.${String(mmm).padStart(3, "0")}`;
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

	// two columns: info on the left, note chart filling the right
	const left = el("detail-left");
	const right = el("detail-right");
	container.appendChild(left);
	container.appendChild(right);

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
	left.appendChild(header);

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
	left.appendChild(grid);

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
	left.appendChild(sectionTitle("Difficulty"));
	left.appendChild(diffRow);

	// per-column density
	left.appendChild(sectionTitle("Column distribution"));
	left.appendChild(columnBars(d));

	// timing points
	left.appendChild(sectionTitle(`Timing points (${d.timing_points.length})`));
	left.appendChild(timingList(d));

	// note chart fills the right column, top to bottom
	right.appendChild(noteChart(d));
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

interface TimingSeg {
	ramp: boolean;
	time: number;
	bpm: number;
	meter: number;
	endTime: number;
	endBpm: number;
	count: number;
}

/**
 * Collapse runs of timing points whose BPM changes by a (near) constant step
 * into a single "ramp" segment — e.g. 165→180→…→300 BPM becomes one row.
 * A ramp needs ≥3 points, same meter, and consistent-signed, similar-sized steps.
 */
function summarizeTiming(tps: TimingInfo[]): TimingSeg[] {
	const segs: TimingSeg[] = [];
	const n = tps.length;
	let i = 0;
	while (i < n) {
		let j = i;
		if (i + 2 < n) {
			const d0 = tps[i + 1].bpm - tps[i].bpm;
			if (Math.abs(d0) > 0.01 && tps[i + 1].meter === tps[i].meter) {
				j = i + 1;
				while (j + 1 < n) {
					const d = tps[j + 1].bpm - tps[j].bpm;
					const sameSign = Math.sign(d) === Math.sign(d0);
					const closeMag = Math.abs(d - d0) <= Math.max(0.5, Math.abs(d0) * 0.25);
					const sameMeter = tps[j + 1].meter === tps[i].meter;
					if (sameSign && closeMag && sameMeter) j++;
					else break;
				}
			}
		}
		const isRamp = j - i >= 2; // ≥3 points
		segs.push({
			ramp: isRamp,
			time: tps[i].time,
			bpm: tps[i].bpm,
			meter: tps[i].meter,
			endTime: tps[j].time,
			endBpm: tps[j].bpm,
			count: j - i + 1,
		});
		i = j + 1;
	}
	return segs;
}

function timingList(d: BeatmapDetail): HTMLElement {
	const wrap = el("timing-list");
	for (const seg of summarizeTiming(d.timing_points)) {
		const row = el("timing-row");
		if (seg.ramp) {
			row.classList.add("ramp");
			row.appendChild(el("timing-t", `${fmtTime(seg.time)}–${fmtTime(seg.endTime)}`));
			const bpm = el("timing-bpm");
			const arrow = seg.endBpm >= seg.bpm ? "⤴" : "⤵";
			bpm.appendChild(
				document.createTextNode(
					`${Math.round(seg.bpm)} → ${Math.round(seg.endBpm)} BPM`,
				),
			);
			const badge = el("ramp-badge", `${arrow} gradual ×${seg.count}`);
			bpm.appendChild(badge);
			row.appendChild(bpm);
		} else {
			row.appendChild(el("timing-t", fmtTime(seg.time)));
			row.appendChild(el("timing-bpm", `${seg.bpm.toFixed(1)} BPM`));
		}
		row.appendChild(el("timing-meter", `${seg.meter}/4`));
		wrap.appendChild(row);
	}
	return wrap;
}

/**
 * Vertical, interactive mania note-chart (the centerpiece view).
 * Time runs bottom→top like gameplay; left gutter shows timestamps; a hover
 * crosshair reports the time, active BPM and the note under the cursor. The
 * whole panel can be maximized to fill the window.
 */
function noteChart(d: BeatmapDetail): HTMLElement {
	const notes = d.notes;
	const keys = d.key_count;
	const start = notes.length ? notes[0].start_time : 0;
	const span = Math.max(1, d.length_ms);
	const PX_PER_MS = Math.min(0.12, 28000 / span); // clamp total px height
	const PAD = 20;
	const GUTTER = 58;
	const RPAD = 14;
	const dpr = window.devicePixelRatio || 1;
	const contentH = PAD * 2 + span * PX_PER_MS;

	// bottom = start: later time is higher up the canvas
	const y = (t: number) => contentH - PAD - (t - start) * PX_PER_MS;

	// notes bucketed by column for cheap hover hit-testing
	const byCol: ManiaNote[][] = Array.from({ length: keys }, () => []);
	for (const n of notes) {
		if (n.column >= 0 && n.column < keys) byCol[n.column].push(n);
	}

	const timing = [...d.timing_points].sort((a, b) => a.time - b.time);
	const bpmAt = (t: number): number => {
		let bpm = timing.length ? timing[0].bpm : d.bpm.primary || 0;
		for (const tp of timing) {
			if (tp.time <= t) bpm = tp.bpm;
			else break;
		}
		return bpm;
	};

	// --- DOM ---
	const panel = el("chart-panel");
	const toolbar = el("chart-toolbar");
	toolbar.appendChild(el("chart-hint", "hover for time · BPM · note"));
	const maxBtn = document.createElement("button");
	maxBtn.className = "chart-btn";
	maxBtn.textContent = "⛶ Maximize";
	toolbar.appendChild(maxBtn);

	const body = el("chart-body");
	const viewport = el("chart-viewport");
	const stage = el("chart-stage");
	const canvas = document.createElement("canvas");
	canvas.className = "chart-notes";
	const overlay = document.createElement("canvas");
	overlay.className = "chart-overlay";
	const tip = el("chart-tooltip");
	tip.style.display = "none";

	stage.appendChild(canvas);
	viewport.appendChild(stage);
	body.appendChild(viewport);
	body.appendChild(overlay);
	body.appendChild(tip);
	panel.appendChild(toolbar);
	panel.appendChild(body);

	const NOTE_INSET = 4;
	let LANE_W = 34;
	let offsetX = 0; // playfield left margin inside the stage (for centering)
	let noteW = LANE_W - NOTE_INSET * 2;
	let tapH = 10;
	const laneX = (c: number) => GUTTER + c * LANE_W;
	let didInitScroll = false;

	function drawNotes(): void {
		const avail = viewport.clientWidth || 600;
		// playfield (lanes only, excluding the time gutter) spans 75% of the viewport
		LANE_W = Math.max(10, (avail * 0.6) / keys);
		const width = GUTTER + keys * LANE_W + RPAD;
		offsetX = Math.max(0, (avail - width) / 2); // center narrow playfields
		stage.style.width = `${width}px`;
		stage.style.height = `${contentH}px`;
		stage.style.marginLeft = `${offsetX}px`;
		canvas.style.width = `${width}px`;
		canvas.style.height = `${contentH}px`;
		canvas.width = Math.floor(width * dpr);
		canvas.height = Math.floor(contentH * dpr);

		const ctx = canvas.getContext("2d")!;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, contentH);

		// lanes + gutter strip
		for (let c = 0; c < keys; c++) {
			ctx.fillStyle = c % 2 === 0 ? "#221b23" : "#1b151c";
			ctx.fillRect(laneX(c), 0, LANE_W, contentH);
		}
		ctx.fillStyle = "#161016";
		ctx.fillRect(0, 0, GUTTER, contentH);

		// beat / measure gridlines from timing points (rhythm, unlabeled)
		const laneRight = GUTTER + keys * LANE_W;
		ctx.lineWidth = 1;
		const end = start + span;
		for (let i = 0; i < timing.length; i++) {
			const tp = timing[i];
			const next = i + 1 < timing.length ? timing[i + 1].time : end;
			const meter = tp.meter > 0 ? tp.meter : 4;
			const bl = tp.beat_len > 0 ? tp.beat_len : 500;
			let beat = 0;
			for (let t = tp.time; t < next + 1; t += bl, beat++) {
				const yy = y(t);
				if (yy < -1 || yy > contentH + 1) continue;
				const measure = beat % meter === 0;
				ctx.strokeStyle = measure
					? "rgba(255,102,170,0.22)"
					: "rgba(255,255,255,0.05)";
				ctx.beginPath();
				ctx.moveTo(GUTTER, Math.round(yy) + 0.5);
				ctx.lineTo(laneRight, Math.round(yy) + 0.5);
				ctx.stroke();
			}
		}

		// time axis: labels on a regular "nice" step so gaps read evenly
		ctx.font = "10px ui-monospace, monospace";
		ctx.textBaseline = "middle";
		const NICE_MS = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000];
		let step = NICE_MS[NICE_MS.length - 1];
		for (const s of NICE_MS) {
			if (s * PX_PER_MS >= 46) {
				step = s;
				break;
			}
		}
		const first = Math.ceil(start / step) * step;
		for (let t = first; t <= end; t += step) {
			const yy = y(t);
			if (yy < -1 || yy > contentH + 1) continue;
			ctx.strokeStyle = "rgba(255,255,255,0.14)";
			ctx.beginPath();
			ctx.moveTo(GUTTER - 6, Math.round(yy) + 0.5);
			ctx.lineTo(GUTTER, Math.round(yy) + 0.5);
			ctx.stroke();
			ctx.fillStyle = "#8a7a8b";
			ctx.fillText(fmtTime(t), 8, yy);
		}

		// notes (holds as bars, taps as chunky blocks) — square corners
		noteW = LANE_W - NOTE_INSET * 2;
		tapH = Math.max(8, Math.min(12, noteW * 0.5));
		const w = noteW;
		const TAP_H = tapH;
		for (const n of notes) {
			const nx = laneX(n.column) + NOTE_INSET;
			if (n.end_time != null) {
				const yHead = y(n.start_time); // bottom (start)
				const yTail = y(n.end_time); // top (end)
				ctx.fillStyle = "rgba(255,102,170,0.30)";
				ctx.fillRect(nx, yTail, w, yHead - yTail);
				ctx.fillStyle = "#ff66aa";
				ctx.fillRect(nx, yHead - TAP_H, w, TAP_H); // head block
			} else {
				ctx.fillStyle = "#ffd0e8";
				ctx.fillRect(nx, y(n.start_time) - TAP_H / 2, w, TAP_H);
			}
		}

		if (!didInitScroll) {
			viewport.scrollTop = contentH; // start at the bottom (song start)
			didInitScroll = true;
		}
	}

	function sizeOverlay(): void {
		const r = body.getBoundingClientRect();
		overlay.style.width = `${r.width}px`;
		overlay.style.height = `${r.height}px`;
		overlay.width = Math.floor(r.width * dpr);
		overlay.height = Math.floor(r.height * dpr);
	}

	function clearOverlay(): void {
		const ctx = overlay.getContext("2d")!;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, overlay.width, overlay.height);
		tip.style.display = "none";
	}

	function onMove(ev: MouseEvent): void {
		const bodyRect = body.getBoundingClientRect();
		const localX = ev.clientX - bodyRect.left;
		const localY = ev.clientY - bodyRect.top;
		if (localY < 0 || localY > bodyRect.height) return clearOverlay();

		const contentY = localY + viewport.scrollTop;
		const t = start + (contentH - PAD - contentY) / PX_PER_MS;
		const pfX = offsetX - viewport.scrollLeft; // playfield origin in body coords
		const cx = localX - pfX; // x in canvas space
		const col =
			cx >= GUTTER && cx < GUTTER + keys * LANE_W
				? Math.floor((cx - GUTTER) / LANE_W)
				: -1;

		const ctx = overlay.getContext("2d")!;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, bodyRect.width, bodyRect.height);

		// horizontal cursor line
		ctx.strokeStyle = "rgba(255,207,106,0.85)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, Math.round(localY) + 0.5);
		ctx.lineTo(bodyRect.width, Math.round(localY) + 0.5);
		ctx.stroke();

		// highlight EVERY note the line crosses (all columns); the hovered
		// column's note is captured for the tooltip.
		const sTop = viewport.scrollTop;
		ctx.strokeStyle = "#ffcf6a";
		ctx.lineWidth = 1.5;
		let hit: ManiaNote | null = null;
		for (let c = 0; c < keys; c++) {
			for (const n of byCol[c]) {
				// note bounds in content coords
				const nTopC =
					n.end_time != null ? y(n.end_time) : y(n.start_time) - tapH / 2;
				const nBotC =
					n.end_time != null ? y(n.start_time) : y(n.start_time) + tapH / 2;
				if (contentY < nTopC - 2 || contentY > nBotC + 2) continue;
				const hx = pfX + laneX(c) + NOTE_INSET;
				ctx.strokeRect(hx - 1.5, nTopC - sTop - 1.5, noteW + 3, nBotC - nTopC + 3);
				if (c === col) hit = n;
				break; // one note per column contains a given y
			}
		}

		// tooltip
		const bpm = bpmAt(t);
		let text = `⏱ ${fmtTimeMs(t)}\n♪ ${Math.round(bpm)} BPM`;
		if (hit) {
			text +=
				hit.end_time != null
					? `\n▮ Col ${hit.column + 1} · Hold ${Math.round(
						hit.end_time - hit.start_time,
					)}ms`
					: `\n▪ Col ${hit.column + 1} · Tap`;
		}
		tip.textContent = text;
		tip.style.display = "block";
		const tx = Math.min(localX + 14, bodyRect.width - 160);
		const ty = Math.min(localY + 14, bodyRect.height - 70);
		tip.style.left = `${Math.max(4, tx)}px`;
		tip.style.top = `${Math.max(4, ty)}px`;
	}

	viewport.addEventListener("mousemove", onMove);
	viewport.addEventListener("mouseleave", clearOverlay);
	viewport.addEventListener("scroll", clearOverlay);

	// maximize / minimize
	let maximized = false;
	const onKey = (e: KeyboardEvent): void => {
		if (e.key === "Escape" && maximized) toggle();
	};
	const toggle = (): void => {
		maximized = !maximized;
		panel.classList.toggle("maximized", maximized);
		maxBtn.textContent = maximized ? "⛶ Minimize" : "⛶ Maximize";
		if (maximized) document.addEventListener("keydown", onKey);
		else document.removeEventListener("keydown", onKey);
		requestAnimationFrame(() => {
			drawNotes();
			sizeOverlay();
			clearOverlay();
		});
	};
	maxBtn.addEventListener("click", toggle);

	// initial draw + keep lanes filling the width on resize
	const ro = new ResizeObserver(() => {
		drawNotes();
		sizeOverlay();
	});
	ro.observe(viewport);
	ro.observe(body);

	return panel;
}
