import { loadAudio } from "./api";
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

let currentChart: ChartHandle | null = null;
let currentChartHash: string | null = null; // hash currentChart renders, if any
// A live-play whose target chart hasn't rendered yet (navigate() re-renders
// async). Held until a matching renderDetail fires it, unless it's gone stale
// (the beatmap load that should have delivered it failed).
let pendingLivePlay: { hash: string; audioZeroEpochMs: number; requestedAt: number } | null = null;
const LIVE_REQUEST_STALE_MS = 10_000;

/** Whether `hash`'s chart is already the one on screen — e.g. a pause/resume
 * re-syncs the same difficulty, not a new selection. Callers use this to skip
 * re-navigating (which would tear down and re-decode the existing chart). */
export function isChartShowing(hash: string): boolean {
	return currentChartHash === hash && currentChart != null;
}

/** Start (or queue) a live-synced play for `hash`. `audioZeroEpochMs` is a
 * Unix epoch ms timestamp (not perf/AudioContext time) — each side converts
 * it into its own clock right when it's used, so IPC/queueing delay can't
 * bias the schedule. If `hash`'s chart is already showing, starts it
 * immediately instead of queuing (a pause/resume shouldn't wait on a
 * navigate() that isn't going to happen). */
export function requestLivePlay(hash: string, audioZeroEpochMs: number): void {
	if (isChartShowing(hash)) {
		currentChart!.startLive(audioZeroEpochMs);
		return;
	}
	pendingLivePlay = { hash, audioZeroEpochMs, requestedAt: performance.now() };
}

/** Stop any live-synced playback (gameplay ended / quit). */
export function stopLivePlay(): void {
	pendingLivePlay = null;
	currentChart?.stopLive();
}

// chart preferences that persist across beatmap changes.
// prefScrollSpeed = null means "use each map's density-based default".
let prefScrollSpeed: number | null = null;
let prefNoteHeight = 15;
let prefHitSound = false; // tick on each note crossing the receptor during play

export function renderDetail(
	container: HTMLElement,
	diff: ManiaDiff,
	d: BeatmapDetail,
): void {
	currentChart?.destroy(); // stop the previous chart's audio/loops
	currentChart = null;
	currentChartHash = null;
	container.textContent = "";
	const meta = diff.meta;

	// two columns: info on the left, note chart filling the right
	const left = el("detail-left");
	const right = el("detail-right");
	container.appendChild(left);
	container.appendChild(right);

	// header
	const header = el("detail-header");
	const titleEl = el("detail-title", meta.titleUnicode || meta.title);
	if (meta.title && meta.titleUnicode && meta.title !== meta.titleUnicode) {
		const alt = document.createElement("span");
		alt.className = "title-alt";
		alt.textContent = ` — ${meta.title}`;
		titleEl.appendChild(alt);
	}
	// title row: song title + star rating beside it
	const titleRow = el("detail-title-row");
	titleRow.appendChild(titleEl);
	titleRow.appendChild(el("detail-stars", `★ ${d.star_rating.toFixed(2)}`));
	header.appendChild(titleRow);
	header.appendChild(
		el("detail-sub", `${meta.artist}${meta.author ? `  ·  mapped by ${meta.author}` : ""}`),
	);
	header.appendChild(el("detail-diff", `[${d.key_count}K] ${diff.name}`));
	left.appendChild(header);

	// stat cards
	const bpmStr =
		Math.round(d.bpm.min) === Math.round(d.bpm.max)
			? `${Math.round(d.bpm.primary)}`
			: `${Math.round(d.bpm.min)}–${Math.round(d.bpm.max)}`;

	const grid = el("stat-grid");
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

	// note chart fills the right column, top to bottom
	const chart = noteChart(d, diff);
	currentChart = chart;
	currentChartHash = diff.hash;
	// a live-play arrived before this chart existed — start it now that it does,
	// unless it's been stuck long enough that it's clearly a stale leftover from
	// a failed load rather than this navigation's own live-play.
	if (pendingLivePlay?.hash === diff.hash) {
		const { audioZeroEpochMs, requestedAt } = pendingLivePlay;
		pendingLivePlay = null;
		if (performance.now() - requestedAt <= LIVE_REQUEST_STALE_MS) {
			chart.startLive(audioZeroEpochMs);
		} else {
			console.warn(`[livesync] dropping stale queued live-play for ${diff.hash}`);
		}
	}

	// timing points — clicking scrolls the chart there; ramps highlight their span
	left.appendChild(sectionTitle(`Timing points (${d.timing_points.length})`));
	left.appendChild(
		timingList(d, (seg) => {
			if (!seg) return chart.clearHighlight(); // deselected
			chart.scrollToTime(seg.time); // jump to the start of the section
			chart.highlight(seg.time, seg.ramp ? seg.endTime : seg.time);
		}),
	);

	right.appendChild(chart.el);
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

function timingList(
	d: BeatmapDetail,
	onSelect: (seg: TimingSeg | null) => void,
): HTMLElement {
	const wrap = el("timing-list");
	let active: HTMLElement | null = null;
	for (const seg of summarizeTiming(d.timing_points)) {
		const row = el("timing-row");
		row.addEventListener("click", () => {
			if (active === row) {
				// click the selected row again -> deselect
				row.classList.remove("selected");
				active = null;
				onSelect(null);
				return;
			}
			active?.classList.remove("selected");
			row.classList.add("selected");
			active = row;
			onSelect(seg);
		});
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
interface ChartHandle {
	el: HTMLElement;
	scrollToTime: (t: number) => void;
	highlight: (from: number, to: number) => void;
	clearHighlight: () => void;
	startLive: (audioZeroEpochMs: number) => void;
	stopLive: () => void;
	destroy: () => void;
}

function noteChart(d: BeatmapDetail, diff: ManiaDiff): ChartHandle {
	const notes = d.notes;
	const keys = d.key_count;
	const onsets = notes.map((n) => n.start_time).sort((a, b) => a - b);
	const start = onsets.length ? onsets[0] : 0;
	const span = Math.max(1, d.length_ms);
	const end = start + span;

	const PAD = 20;
	const GUTTER = 58;
	const RPAD = 14;
	const NOTE_INSET = 4;
	const RECEPTOR_OFFSET = 72; // judgement line distance from viewport bottom
	const BOT_PAD = RECEPTOR_OFFSET + PAD; // scroll room below the first note
	// Fixed scale constant defining how scroll speed maps to on-screen distance
	// (px per beat at scroll speed 1, sv 1). This is the scroll-speed scale and
	// must NOT be tuned to chase a particular default value — keeps typical
	// speeds within ~100.
	const BEAT_PX = 1.0;
	const dpr = window.devicePixelRatio || 1;

	// density-based default scroll speed: pick V_scroll (a value on the fixed
	// BEAT_PX scale) so the densest notes (5th-percentile onset gap) land
	// ~DEFAULT_DENSE_PX apart. Only sets the initial number — it does not change
	// how scroll speed behaves. Unclamped; denser maps → faster.
	const DEFAULT_DENSE_PX = 110;
	const gaps: number[] = [];
	for (let k = 1; k < onsets.length; k++) {
		const g = onsets[k] - onsets[k - 1];
		if (g > 1) gaps.push(g); // ignore chords (simultaneous notes)
	}
	gaps.sort((a, b) => a - b);
	const denseGap = gaps.length ? gaps[Math.floor(gaps.length * 0.05)] : 400;
	const primaryBeatLen = d.bpm.primary > 0 ? 60000 / d.bpm.primary : 500;
	const densityDefault = Math.min(
		550,
		Math.max(1, Math.round((DEFAULT_DENSE_PX * primaryBeatLen) / (BEAT_PX * denseGap))),
	);

	let vScroll = prefScrollSpeed ?? densityDefault; // user override, else per-map default
	let noteHeight = prefNoteHeight; // px height of a tap / hold head

	// notes bucketed by column (sorted by start) for hover + receptor hit-testing
	const byCol: ManiaNote[][] = Array.from({ length: keys }, () => []);
	for (const n of notes) {
		if (n.column >= 0 && n.column < keys) byCol[n.column].push(n);
	}
	for (const col of byCol) col.sort((a, b) => a.start_time - b.start_time);

	// notes sorted by start + longest hold, so draw() can cull to the visible
	// window via binary search instead of scanning every note each frame.
	const notesByStart = [...notes].sort((a, b) => a.start_time - b.start_time);
	let maxNoteSpan = 0;
	for (const n of notes) {
		if (n.end_time != null) maxNoteSpan = Math.max(maxNoteSpan, n.end_time - n.start_time);
	}
	// first index whose start_time >= t (binary search)
	const lowerBoundByStart = (arr: ManiaNote[], t: number): number => {
		let lo = 0;
		let hi = arr.length;
		while (lo < hi) {
			const m = (lo + hi) >> 1;
			if (arr[m].start_time < t) lo = m + 1;
			else hi = m;
		}
		return lo;
	};

	const timing = [...d.timing_points].sort((a, b) => a.time - b.time);
	const svPts = [...d.sv_points].sort((a, b) => a.time - b.time);
	// section changes for BPM markers (ramps collapse to one, like the timing list)
	const segments = summarizeTiming(timing);
	const bpmAt = (t: number): number => {
		let bpm = timing.length ? timing[0].bpm : d.bpm.primary || 0;
		for (const tp of timing) {
			if (tp.time <= t) bpm = tp.bpm;
			else break;
		}
		return bpm;
	};

	// --- osu!mania scroll-distance model: D(t) = vScroll * unitD(t) ----------
	// V_fall = V_scroll × BPM × SV, so scroll distance integrates local velocity.
	// unitD is the vScroll=1 distance; a step function of beat_len (BPM) and sv.
	const beatLenAt = (t: number) => {
		let bl = timing.length ? timing[0].beat_len : 500;
		for (const tp of timing) {
			if (tp.time <= t) bl = tp.beat_len;
			else break;
		}
		return bl > 0 ? bl : 500;
	};
	const svAt = (t: number) => {
		let sv = 1;
		for (const p of svPts) {
			if (p.time <= t) sv = p.sv;
			else break;
		}
		return sv > 0 ? sv : 1;
	};
	const bset = new Set<number>([start]);
	for (const tp of timing) if (tp.time > start && tp.time < end) bset.add(tp.time);
	for (const p of svPts) if (p.time > start && p.time < end) bset.add(p.time);
	const bpTime = [...bset].sort((a, b) => a - b);
	const unitSlope: number[] = []; // px per ms at vScroll=1, per segment
	const bpDist: number[] = [0]; // cumulative unit distance at each breakpoint
	for (let i = 0; i < bpTime.length; i++) {
		const slope = (BEAT_PX * svAt(bpTime[i])) / beatLenAt(bpTime[i]);
		unitSlope.push(slope);
		const t1 = i + 1 < bpTime.length ? bpTime[i + 1] : end;
		bpDist.push(bpDist[i] + slope * (t1 - bpTime[i]));
	}
	const unitTotal = bpDist[bpTime.length] || 1;
	const lastSlope = unitSlope[unitSlope.length - 1] || BEAT_PX / 500;
	const unitD = (t: number): number => {
		if (t <= start) return 0;
		if (t >= end) return unitTotal + (t - end) * lastSlope;
		let lo = 0;
		let hi = bpTime.length - 1;
		while (lo < hi) {
			const m = (lo + hi + 1) >> 1;
			if (bpTime[m] <= t) lo = m;
			else hi = m - 1;
		}
		return bpDist[lo] + unitSlope[lo] * (t - bpTime[lo]);
	};
	const tAtUnit = (ud: number): number => {
		if (ud <= 0) return start;
		if (ud >= unitTotal) return end + (ud - unitTotal) / lastSlope;
		let lo = 0;
		let hi = bpTime.length - 1;
		while (lo < hi) {
			const m = (lo + hi + 1) >> 1;
			if (bpDist[m] <= ud) lo = m;
			else hi = m - 1;
		}
		return bpTime[lo] + (ud - bpDist[lo]) / unitSlope[lo];
	};

	// --- DOM ---
	const panel = el("chart-panel");
	const toolbar = el("chart-toolbar");
	toolbar.appendChild(el("chart-hint", "hover for detail"));
	const controls = el("chart-controls");
	const playBtn = document.createElement("button");
	playBtn.className = "chart-btn";
	playBtn.textContent = "▶ Play";
	playBtn.disabled = true;
	const hitBtn = document.createElement("button");
	hitBtn.className = "chart-btn chart-toggle";
	hitBtn.textContent = "♪ Hit sound";
	hitBtn.title = "tick on each note during play";
	hitBtn.classList.toggle("on", prefHitSound);
	const speedWrap = el("chart-speed-wrap");
	speedWrap.appendChild(el("chart-speed-label", "speed"));
	const speedInput = document.createElement("input");
	speedInput.type = "number";
	speedInput.className = "chart-speed";
	speedInput.min = "1";
	speedInput.value = String(vScroll);
	speedWrap.appendChild(speedInput);
	const heightWrap = el("chart-speed-wrap");
	heightWrap.appendChild(el("chart-speed-label", "note"));
	const heightInput = document.createElement("input");
	heightInput.type = "number";
	heightInput.className = "chart-speed";
	heightInput.min = "2";
	heightInput.value = String(noteHeight);
	heightWrap.appendChild(heightInput);
	const maxBtn = document.createElement("button");
	maxBtn.className = "chart-btn";
	maxBtn.textContent = "⛶ Maximize";
	controls.appendChild(playBtn);
	controls.appendChild(hitBtn);
	controls.appendChild(speedWrap);
	controls.appendChild(heightWrap);
	controls.appendChild(maxBtn);
	toolbar.appendChild(controls);

	const body = el("chart-body");
	const viewport = el("chart-viewport");
	const spacer = el("chart-stage"); // tall scroll spacer (drives the scrollbar)
	const canvas = document.createElement("canvas");
	canvas.className = "chart-notes";
	const overlay = document.createElement("canvas");
	overlay.className = "chart-overlay";
	const tip = el("chart-tooltip");
	tip.style.display = "none";

	viewport.appendChild(spacer);
	body.appendChild(viewport);
	body.appendChild(canvas); // viewport-sized; repainted on scroll
	body.appendChild(overlay);
	body.appendChild(tip);
	panel.appendChild(toolbar);
	panel.appendChild(body);

	// layout state (recomputed on resize)
	let vpW = 600;
	let vpH = 400;
	let LANE_W = 34;
	let offsetX = 0; // playfield block left (centers a narrow playfield)
	let noteW = 26;
	let tapH = 10; // constant px height, independent of the scroll speed
	let virtualH = 0; // full song height in the scroll spacer
	let didInitScroll = false;
	let hlFrom: number | null = null; // selected time range (from timing list)
	let hlTo: number | null = null;

	// playback state — song and hit ticks share ONE AudioContext (one sample
	// clock, one output path) so ticks stay locked to the song within ~1ms.
	let actx: AudioContext | null = null;
	let songBuf: AudioBuffer | null = null; // decoded song
	let songGain: GainNode | null = null;
	let songSrc: AudioBufferSourceNode | null = null; // one-shot, recreated per play
	let songStartCtx = 0; // actx.currentTime when playback began
	let songStartOff = 0; // song position (s) at that moment
	let hitNoise: AudioBuffer | null = null; // reused short noise burst
	let playing = false;
	let playMs = 0;
	let rafPlay = 0;
	let hitSound = prefHitSound; // play a tick as notes reach the receptor
	let hitCursor = 0; // next note in notesByStart not yet ticked
	// a live-sync start requested before audio finished decoding (epoch ms of
	// song position 0); replayed once songBuf is ready.
	let pendingLive: number | null = null;
	let audioUnavailable = false; // no audioHash, or decode failed — startLive can never proceed
	let destroyed = false; // this chart was torn down; ignore any late async callbacks
	// whether the *current* (or most recently started) playback was driven by
	// live-sync vs. the user's own Play button — so a `live-stop` only stops
	// playback it actually started, not an unrelated manual preview.
	let liveOwned = false;

	const laneX = (c: number) => offsetX + GUTTER + c * LANE_W;
	const yFull = (t: number) => virtualH - BOT_PAD - vScroll * unitD(t); // bottom = start
	const receptorY = () => vpH - RECEPTOR_OFFSET;
	const timeAtCanvasY = (cyv: number) =>
		tAtUnit((virtualH - BOT_PAD - (cyv + viewport.scrollTop)) / vScroll);
	const clampScroll = (v: number) =>
		Math.max(0, Math.min(Math.max(0, virtualH - vpH), v));

	function draw(): void {
		const sTop = viewport.scrollTop;
		const ctx = canvas.getContext("2d")!;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, vpW, vpH);

		const gx = offsetX; // gutter left
		const laneRight = offsetX + GUTTER + keys * LANE_W;
		const cy = (t: number) => yFull(t) - sTop; // -> canvas y

		// lanes + gutter strip (full viewport height)
		for (let c = 0; c < keys; c++) {
			ctx.fillStyle = c % 2 === 0 ? "#221b23" : "#1b151c";
			ctx.fillRect(laneX(c), 0, LANE_W, vpH);
		}
		ctx.fillStyle = "#161016";
		ctx.fillRect(gx, 0, GUTTER, vpH);

		// selected time range (from a timing-list click)
		if (hlFrom != null && hlTo != null) {
			const yA = cy(hlTo); // later time (top)
			const yB = cy(hlFrom); // earlier time (bottom)
			if (yB > yA) {
				ctx.fillStyle = "rgba(255,207,106,0.10)";
				ctx.fillRect(offsetX + GUTTER, yA, keys * LANE_W, yB - yA);
			}
			ctx.strokeStyle = "rgba(255,207,106,0.7)";
			ctx.lineWidth = 1.5;
			for (const yy of [yA, yB]) {
				ctx.beginPath();
				ctx.moveTo(offsetX + GUTTER, Math.round(yy) + 0.5);
				ctx.lineTo(laneRight, Math.round(yy) + 0.5);
				ctx.stroke();
			}
		}

		// visible time range (+ margin), from the two screen edges
		const lo = timeAtCanvasY(vpH) - 300;
		const hi = timeAtCanvasY(0) + 300;

		// beat / measure gridlines from timing points (only the visible span)
		const gridLine = (t: number, color: string, width: number) => {
			const yy = Math.round(cy(t)) + 0.5;
			ctx.strokeStyle = color;
			ctx.lineWidth = width;
			ctx.beginPath();
			ctx.moveTo(offsetX + GUTTER, yy);
			ctx.lineTo(laneRight, yy);
			ctx.stroke();
		};
		for (let i = 0; i < timing.length; i++) {
			const tp = timing[i];
			const next = i + 1 < timing.length ? timing[i + 1].time : end;
			if (next < lo || tp.time > hi) continue;
			const meter = tp.meter > 0 ? tp.meter : 4;
			const bl = tp.beat_len > 0 ? tp.beat_len : 500;
			const secEnd = Math.min(next, hi);
			const beatPx = vScroll * BEAT_PX * svAt(tp.time); // px between beats here
			// subdivisions only when there's room, so zoomed-out views stay clean
			const subdiv = beatPx >= 64 ? 4 : beatPx >= 28 ? 2 : 1;
			let beat = Math.max(0, Math.ceil((lo - tp.time) / bl));
			for (let t = tp.time + beat * bl; t <= secEnd; t += bl, beat++) {
				// faint subdivisions between this beat and the next
				for (let s = 1; s < subdiv; s++) {
					const st = t + (bl * s) / subdiv;
					if (st > secEnd) break;
					gridLine(st, "rgba(255,255,255,0.045)", 1);
				}
				if (beat % meter === 0) {
					gridLine(t, "rgba(255,102,170,0.32)", 1.5); // downbeat
				} else {
					gridLine(t, "#3D373D", 1); // beat
				}
			}
		}

		// BPM markers at section changes (ramps collapse to a single marker)
		for (const seg of segments) {
			if (seg.time < lo || seg.time > hi) continue;
			const yy = Math.round(cy(seg.time)) + 0.5;
			ctx.strokeStyle = "rgba(124,198,255,0.85)";
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			ctx.moveTo(offsetX + GUTTER, yy);
			ctx.lineTo(laneRight, yy);
			ctx.stroke();

			const label = seg.ramp
				? `${Math.round(seg.bpm)}→${Math.round(seg.endBpm)} BPM`
				: `${Math.round(seg.bpm)} BPM`;
			ctx.font = "10px ui-monospace, monospace";
			ctx.textBaseline = "middle";
			const tw = ctx.measureText(label).width;
			// place the label outside the track, to the right (clamped to canvas)
			const px = Math.min(laneRight + 10, vpW - tw - 4);
			ctx.fillStyle = "rgba(16,24,34,0.9)";
			ctx.fillRect(px - 4, yy - 8, tw + 8, 16);
			ctx.fillStyle = "#7cc6ff";
			ctx.fillText(label, px, yy);
		}

		// time axis labels on a whole-second step (spacing varies with sv, so pick
		// the step from the average px/ms)
		const avgPpm = (vScroll * unitTotal) / span;
		ctx.font = "10px ui-monospace, monospace";
		ctx.textBaseline = "middle";
		const NICE_MS = [1000, 2000, 5000, 10000, 15000, 30000, 60000];
		let step = NICE_MS[NICE_MS.length - 1];
		for (const s of NICE_MS) {
			if (s * avgPpm >= 46) {
				step = s;
				break;
			}
		}
		for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) {
			const yy = cy(t);
			ctx.strokeStyle = "rgba(255,255,255,0.14)";
			ctx.beginPath();
			ctx.moveTo(offsetX + GUTTER - 6, Math.round(yy) + 0.5);
			ctx.lineTo(offsetX + GUTTER, Math.round(yy) + 0.5);
			ctx.stroke();
			ctx.fillStyle = "#8a7a8b";
			ctx.fillText(fmtTime(t), offsetX + 8, yy);
		}

		// notes in view (holds as bars, taps as constant-height blocks).
		// Cull via binary search: only notes starting within [lo-maxSpan, hi] can
		// be visible; the per-note check below still filters the exact bounds.
		const startIdx = lowerBoundByStart(notesByStart, lo - maxNoteSpan);
		for (let ni = startIdx; ni < notesByStart.length; ni++) {
			const n = notesByStart[ni];
			if (n.start_time > hi) break;
			const e = n.end_time;
			if (e != null ? e < lo : n.start_time < lo) continue;
			const nx = laneX(n.column) + NOTE_INSET;
			if (e != null) {
				const yHead = cy(n.start_time); // bottom (start)
				const yTail = cy(e); // top (end)
				ctx.fillStyle = "rgba(255,102,170,0.30)";
				ctx.fillRect(nx, yTail, noteW, yHead - yTail);
				ctx.fillStyle = "#ff66aa";
				ctx.fillRect(nx, yHead - tapH, noteW, tapH); // head block
			} else {
				ctx.fillStyle = "#ffd0e8";
				ctx.fillRect(nx, cy(n.start_time) - tapH, noteW, tapH); // start = bottom edge
			}
		}

		// judgement line + per-lane receptors near the bottom
		const recY = receptorY();
		const recH = Math.max(10, tapH + 2);
		for (let c = 0; c < keys; c++) {
			const lit = playing && laneHit(c, playMs);
			const rx = laneX(c) + 2;
			const rw = LANE_W - 4;
			ctx.fillStyle = lit ? "rgba(124,198,255,0.5)" : "rgba(255,255,255,0.05)";
			ctx.fillRect(rx, recY - recH, rw, recH);
			ctx.strokeStyle = lit ? "#7cc6ff" : "rgba(255,255,255,0.22)";
			ctx.lineWidth = 1;
			ctx.strokeRect(rx + 0.5, recY - recH + 0.5, rw - 1, recH - 1);
		}
		ctx.strokeStyle = "rgba(255,255,255,0.6)";
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(offsetX + GUTTER, Math.round(recY) + 0.5);
		ctx.lineTo(laneRight, Math.round(recY) + 0.5);
		ctx.stroke();
	}

	// is a note in column `c` being hit at time `ms` (for receptor flash)?
	// Binary-search to the window around `ms` instead of scanning the column.
	function laneHit(c: number, ms: number): boolean {
		const W = 55;
		const col = byCol[c];
		// a hold could start before the window but still be active, so search back
		// from `ms - W - maxNoteSpan`
		let i = lowerBoundByStart(col, ms - W - maxNoteSpan);
		for (; i < col.length; i++) {
			const n = col[i];
			if (n.start_time > ms + W) break;
			if (n.end_time != null) {
				if (ms >= n.start_time - W && ms <= n.end_time + W) return true;
			} else if (Math.abs(n.start_time - ms) <= W) return true;
		}
		return false;
	}

	function layout(): void {
		vpW = viewport.clientWidth || 600;
		vpH = viewport.clientHeight || 400;
		LANE_W = Math.max(10, (vpW * 0.6) / keys);
		const blockW = GUTTER + keys * LANE_W + RPAD;
		offsetX = Math.max(0, (vpW - blockW) / 2);
		noteW = LANE_W - NOTE_INSET * 2;
		tapH = noteHeight; // user-set; independent of the scroll speed
		virtualH = PAD + vScroll * unitTotal + BOT_PAD;
		spacer.style.width = "100%";
		spacer.style.height = `${virtualH}px`;
		for (const cv of [canvas, overlay]) {
			cv.style.width = `${vpW}px`;
			cv.style.height = `${vpH}px`;
			cv.width = Math.floor(vpW * dpr);
			cv.height = Math.floor(vpH * dpr);
		}
		if (!didInitScroll) {
			// open with the song start sitting on the receptor line
			viewport.scrollTop = clampScroll(yFull(start) - receptorY());
			didInitScroll = true;
		}
		draw();
	}

	// keep a given song time pinned at the receptor (used on speed/resize change)
	function timeAtReceptor(): number {
		return timeAtCanvasY(receptorY());
	}
	function pinTime(ms: number): void {
		viewport.scrollTop = clampScroll(yFull(ms) - receptorY());
		draw();
	}
	function setSpeed(v: number): void {
		if (!Number.isFinite(v) || v < 1) return;
		const anchor = timeAtReceptor();
		vScroll = v;
		prefScrollSpeed = v; // persist across beatmaps
		layout();
		pinTime(anchor);
	}

	let rafPending = false;
	function requestDraw(): void {
		if (rafPending) return;
		rafPending = true;
		requestAnimationFrame(() => {
			rafPending = false;
			draw();
		});
	}

	function clearOverlay(): void {
		const ctx = overlay.getContext("2d")!;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, overlay.width, overlay.height);
		tip.style.display = "none";
	}

	function onMove(ev: MouseEvent): void {
		const rect = viewport.getBoundingClientRect();
		const localX = ev.clientX - rect.left;
		const localY = ev.clientY - rect.top;
		if (localY < 0 || localY > vpH || localX < 0 || localX > vpW) return clearOverlay();

		const sTop = viewport.scrollTop;
		const t = timeAtCanvasY(localY);
		const col =
			localX >= offsetX + GUTTER && localX < offsetX + GUTTER + keys * LANE_W
				? Math.floor((localX - offsetX - GUTTER) / LANE_W)
				: -1;

		const ctx = overlay.getContext("2d")!;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, vpW, vpH);

		// horizontal cursor line
		ctx.strokeStyle = "rgba(255,207,106,0.85)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, Math.round(localY) + 0.5);
		ctx.lineTo(vpW, Math.round(localY) + 0.5);
		ctx.stroke();

		// highlight EVERY note the line crosses; capture the hovered column's
		const cy = (tt: number) => yFull(tt) - sTop;
		ctx.strokeStyle = "#ffcf6a";
		ctx.lineWidth = 1.5;
		let hit: ManiaNote | null = null;
		for (let c = 0; c < keys; c++) {
			for (const n of byCol[c]) {
				const nTop = n.end_time != null ? cy(n.end_time) : cy(n.start_time) - tapH;
				const nBot = cy(n.start_time); // start = bottom edge for both taps and holds
				if (localY < nTop - 2 || localY > nBot + 2) continue;
				const hx = laneX(c) + NOTE_INSET;
				ctx.strokeRect(hx - 1.5, nTop - 1.5, noteW + 3, nBot - nTop + 3);
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
		const tx = Math.min(localX + 14, vpW - 160);
		const ty = Math.min(localY + 14, vpH - 70);
		tip.style.left = `${Math.max(4, tx)}px`;
		tip.style.top = `${Math.max(4, ty)}px`;
	}

	viewport.addEventListener("mousemove", onMove);
	viewport.addEventListener("mouseleave", clearOverlay);
	viewport.addEventListener("scroll", () => {
		requestDraw();
		if (!playing) clearOverlay();
	});

	// --- playback (single shared AudioContext for song + ticks) ---
	function ensureCtx(): AudioContext {
		if (!actx) {
			actx = new AudioContext();
			songGain = actx.createGain();
			songGain.connect(actx.destination);
			const n = Math.floor(actx.sampleRate * 0.04);
			hitNoise = actx.createBuffer(1, n, actx.sampleRate);
			const data = hitNoise.getChannelData(0);
			for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
		}
		return actx;
	}
	// synth a short filtered-noise "tick", played at AudioContext time `when` (s)
	function playTick(when: number): void {
		const ctx = ensureCtx();
		const src = ctx.createBufferSource();
		src.buffer = hitNoise;
		const filter = ctx.createBiquadFilter();
		filter.type = "bandpass";
		filter.frequency.value = 2200;
		filter.Q.value = 0.8;
		const gain = ctx.createGain();
		gain.gain.setValueAtTime(3.8, when);
		gain.gain.exponentialRampToValueAtTime(0.001, when + 0.045);
		src.connect(filter).connect(gain).connect(ctx.destination);
		src.start(when);
	}
	// Look-ahead scheduler: queue ticks for notes reaching the receptor within
	// the next window. Each tick's time is anchored to the song's start on the
	// SAME clock — songStartCtx + (noteTime - songStartOff) — so it lands on the
	// exact sample the song reaches that note (no frame jitter, ~sub-ms sync).
	const HIT_LOOKAHEAD_MS = 100;
	function scheduleTicks(): void {
		const ctx = ensureCtx();
		const horizon = playMs + HIT_LOOKAHEAD_MS;
		let lastTime = -Infinity; // collapse simultaneous notes (chords) into one tick
		while (hitCursor < notesByStart.length && notesByStart[hitCursor].start_time <= horizon) {
			const st = notesByStart[hitCursor].start_time;
			hitCursor++;
			if (st === lastTime) continue;
			lastTime = st;
			const when = songStartCtx + (st / 1000 - songStartOff);
			playTick(Math.max(ctx.currentTime, when));
		}
	}
	function stepPlay(): void {
		if (!playing || !actx) return;
		playMs = (songStartOff + (actx.currentTime - songStartCtx)) * 1000;
		if (hitSound) scheduleTicks();
		viewport.scrollTop = clampScroll(yFull(playMs) - receptorY());
		draw();
		rafPlay = requestAnimationFrame(stepPlay);
	}
	function setPlayUI(on: boolean): void {
		playing = on;
		playBtn.textContent = on ? "⏸ Pause" : "▶ Play";
		panel.classList.toggle("playing", on);
	}
	function stopSource(): void {
		if (songSrc) {
			const s = songSrc;
			songSrc = null; // clear first so onended treats this as a manual stop
			s.onended = null;
			try {
				s.stop();
			} catch {
				/* already stopped */
			}
		}
	}
	function stopPlay(): void {
		stopSource();
		setPlayUI(false);
		cancelAnimationFrame(rafPlay);
		draw();
	}
	// Begin playback from song position `offsetSec`. `whenCtx` (an AudioContext
	// clock time) lets the caller schedule the start in the future — used by live
	// sync to begin exactly when osu!'s audio reaches position 0. Until then
	// `stepPlay` computes a negative `playMs` and the chart holds at the start.
	function startPlay(offsetSec: number, whenCtx?: number): void {
		const ctx = ensureCtx();
		if (!songBuf || !songGain) return;
		if (ctx.state === "suspended") ctx.resume();
		stopSource();
		const src = ctx.createBufferSource();
		src.buffer = songBuf;
		src.connect(songGain);
		const off = Math.max(0, Math.min(offsetSec, songBuf.duration));
		const when = Math.max(ctx.currentTime, whenCtx ?? ctx.currentTime);
		songSrc = src;
		songStartCtx = when;
		songStartOff = off;
		src.onended = () => {
			if (songSrc === src) {
				songSrc = null; // natural end of the track
				stopPlay();
			}
		};
		src.start(when, off);
		// skip notes already behind the receptor so we don't tick the backlog
		hitCursor = lowerBoundByStart(notesByStart, off * 1000);
		setPlayUI(true);
		cancelAnimationFrame(rafPlay);
		rafPlay = requestAnimationFrame(stepPlay);
	}
	// Start playing in sync with the live osu! session. `audioZeroEpochMs` is a
	// Unix epoch ms timestamp (may be in the past if gameplay already began).
	// Converted straight to the AudioContext clock here, at the last possible
	// moment — one clock hop instead of relaying through performance.now().
	// If the audio is still decoding, defer.
	function startLive(audioZeroEpochMs: number): void {
		if (destroyed) return; // chart was torn down before this fired
		if (audioUnavailable) {
			console.warn(`[livesync] no usable audio for ${diff.name} — cannot start in sync`);
			return;
		}
		if (!songBuf) {
			pendingLive = audioZeroEpochMs; // replayed from the decode handler
			return;
		}
		const ctx = ensureCtx();
		if (ctx.state === "suspended") {
			// not a user gesture, so the browser may refuse to actually resume —
			// surface that instead of silently staying muted.
			void ctx.resume().then(
				() => {
					if (ctx.state !== "running") {
						console.warn(`[livesync] AudioContext still ${ctx.state} for ${diff.name} — click anywhere in the app once to enable audio sync`);
					}
				},
				(e) => console.warn(`[livesync] AudioContext.resume() rejected for ${diff.name}:`, e),
			);
		}
		const audioZeroCtx = ctx.currentTime + (audioZeroEpochMs - Date.now()) / 1000;
		const offNow = ctx.currentTime - audioZeroCtx; // seconds into the song right now
		liveOwned = true;
		if (offNow >= 0) startPlay(offNow); // gameplay already running: jump in
		else startPlay(0, audioZeroCtx); // schedule the start at audio-zero
	}
	function togglePlay(): void {
		if (!songBuf) return;
		if (playing) stopPlay();
		else {
			liveOwned = false; // user-initiated: a live-stop must not touch this
			startPlay(timeAtReceptor() / 1000); // play from the receptor
		}
	}
	if (diff.audioHash) {
		playBtn.title = "loading audio…";
		loadAudio(diff.audioHash)
			.then((buf) => ensureCtx().decodeAudioData(buf))
			.then((decoded) => {
				if (destroyed) return; // chart was torn down while decoding
				songBuf = decoded;
				playBtn.disabled = false;
				playBtn.title = "";
				if (pendingLive != null) {
					const at = pendingLive;
					pendingLive = null;
					startLive(at); // a live start arrived while we were decoding
				}
			})
			.catch(() => {
				playBtn.title = "audio unavailable";
				audioUnavailable = true;
				if (pendingLive != null) {
					console.warn(`[livesync] audio decode failed for ${diff.name} — dropping pending live-sync start`);
					pendingLive = null;
				}
			});
	} else {
		playBtn.title = "no audio file";
		audioUnavailable = true;
	}
	playBtn.addEventListener("click", togglePlay);
	hitBtn.addEventListener("click", () => {
		hitSound = !hitSound;
		prefHitSound = hitSound; // persist across beatmaps
		hitBtn.classList.toggle("on", hitSound);
		if (hitSound) {
			const ctx = ensureCtx(); // create/resume the audio context inside the gesture
			if (ctx.state === "suspended") ctx.resume();
			if (playing) hitCursor = lowerBoundByStart(notesByStart, playMs); // resume mid-play
		}
	});
	speedInput.addEventListener("input", () => setSpeed(parseFloat(speedInput.value)));
	heightInput.addEventListener("input", () => {
		const v = parseFloat(heightInput.value);
		if (Number.isFinite(v) && v >= 2) {
			noteHeight = v;
			prefNoteHeight = v; // persist across beatmaps
			tapH = v;
			draw();
		}
	});

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
		const anchor = timeAtReceptor();
		requestAnimationFrame(() => {
			layout();
			pinTime(anchor);
			clearOverlay();
		});
	};
	maxBtn.addEventListener("click", toggle);

	// initial layout + re-layout on resize (pinning the receptor time)
	const ro = new ResizeObserver(() => {
		if (!didInitScroll) return layout();
		const anchor = timeAtReceptor();
		layout();
		pinTime(anchor);
	});
	ro.observe(viewport);

	// scroll the chart so time `t` sits near the bottom of the window (the
	// section then reads upward into view, since bottom = earlier time)
	function scrollToTime(t: number): void {
		viewport.scrollTo({ top: clampScroll(yFull(t) - vpH * 0.85), behavior: "smooth" });
		requestDraw();
	}
	// highlight a time range (from == to draws a single marker line)
	function highlight(from: number, to: number): void {
		hlFrom = Math.min(from, to);
		hlTo = Math.max(from, to);
		requestDraw();
	}
	function clearHighlight(): void {
		hlFrom = null;
		hlTo = null;
		requestDraw();
	}
	function destroy(): void {
		destroyed = true;
		pendingLive = null;
		playing = false;
		cancelAnimationFrame(rafPlay);
		stopSource();
		if (actx) actx.close();
		document.removeEventListener("keydown", onKey);
		ro.disconnect();
	}

	const stopLive = (): void => {
		pendingLive = null;
		if (playing && liveOwned) stopPlay(); // don't touch an unrelated manual preview
	};

	return { el: panel, scrollToTime, highlight, clearHighlight, startLive, stopLive, destroy };
}
