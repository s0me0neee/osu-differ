# Timing Overlay — Implementation Task Breakdown

Companion to `timing_overlay_design_summary.md`. Each task below is scoped to be handed to Claude Code as a self-contained unit: clear inputs, outputs, files touched, and a concrete "done when" check. Do them in order — later phases depend on earlier ones compiling and passing their own checks first. Each task also lists explicit non-goals, to stop an agentic session from quietly expanding scope into the next phase.

## Progress status (updated 2026-07-06)

Where each phase actually stands in the current tree:

- **Phase 0 — Partial.** No audio/correlation deps added yet (`cpal`/`symphonia`/`rubato`
  are absent). `notify` is present but only as a **dev-dependency** for the
  `bench_detection_latency` benchmark, not for the watcher. `osu_logs_dir()` exists.
- **Phase 1 (log tail + parser) — DONE**, in a single flat `src-tauri/src/lazer_log.rs`
  with passing unit tests. Architecture differs from the sketch below (poll, not
  `notify`; sync thread + callback, not tokio mpsc; different `LazerEvent` variants) —
  see the corrected notes in Phase 0/1.
- **Phase 7.1 (Rust→frontend event bridge) — DONE, out of order.** The app emits three
  events from `lib.rs` and listens in `src/livesync.ts`:
  `live-select` (working beatmap changed → app jumps to that difficulty),
  `live-play` (gameplay start → jump there and start the note chart's own audio+scroll
  playback in sync with osu!), and `live-stop` (halts it). No judged-hit events yet.
- **Phases 2, 3, 4, 5, 6, 7.2, 8 — not started.**

Current strategy note: instead of jumping to audio capture + correlation (Phases 3–4),
the app first shipped a **log-only live-sync latency test** — on gameplay start it computes
`start_in_ms` from the log's lead-in plus the monotonic observation instant and plays the
same song in the frontend, so we can *measure by ear/eye* how much error the log-only path
actually has. `lib.rs` calls this "a manual latency check, not a shipped feature." This is
effectively Phase 8.1's validation done early; if the log-only error budget turns out
acceptable, the audio-correlation phases (3–4) may be reduced or dropped. Decide that
before building the correlation engine.

## Reconciliation with the current app (read first)

This plan predates the current codebase; the following is already true and should be
**reused, not rebuilt**:

- **Backend surface** is **five** Tauri commands in `src-tauri/src/lib.rs`:
  `read_realm`, `read_mania_library`, `get_realm_path`, `read_beatmap`, `read_audio` —
  each a thin `#[tauri::command]` wrapper over a pure `anyhow::Result` function.
  ⚠️ The app is **no longer `invoke`-only**: an `emit`/`listen` bridge already exists
  (`AppHandle::emit` for `live-play`/`live-stop` in `lib.rs`; `listen()` in
  `src/livesync.ts`). Phase 7.1 is therefore already built — reuse it.
- **Log dir already resolved**: `osu_logs_dir()` exists in `beatmap.rs`
  (`dirs::data_dir()/osu/logs` on macOS/Linux, `../osu/logs` on Windows). Append
  `runtime.log`. No new path helper needed. On **this** (Linux) machine it resolves to
  `~/.local/share/osu/logs` — the earlier "~/Library/Application Support" note was macOS.
  Note osu writes a *new* `<sessionId>.runtime.log` per launch, so the tail follows the
  newest `*.runtime.log` and rotates when a fresher one appears (already handled).
- **Library already indexed**: `realm::mania_library` groups mania difficulties into
  sets, each carrying `hash` (beatmap `.osu` content hash), difficulty `name`,
  `audio_hash`, `audio_file`, `stars`, `key_count`, and `DiffMeta { title,
  title_unicode, artist, author }`. Source is the Node.js `scripts/realm-reader.mjs`
  dump (Realm is read via Node, not Rust — see CLAUDE.md). Phase 2 wraps this, it does
  not re-implement it. No "BeatmapExporter".
- **Hit objects already parsed in Rust**: `beatmap::read_beatmap_detail(hash)` parses
  the `.osu` with `rosu-map` and returns `ManiaNote { start_time, column,
  end_time: Option<f64> }` plus timing/SV points. Phase 6 consumes these — do **not**
  re-parse the `.osu`.
- **Audio bytes already resolvable**: `osu_file_path(hash)` maps a content hash to
  `files/a/ab/abcdef…`; `read_audio` streams the bytes. Note decoding currently happens
  **in the frontend** via Web Audio (`decodeAudioData`) — the Rust-side `symphonia`
  decode in Phase 3 is genuinely new and independent of that.
- **Frontend is vanilla TS, no framework, no charting lib** (deps: only
  `@tauri-apps/api` + plugins). The note chart in `src/detail.ts` is a hand-rolled
  `<canvas>` component; it also already contains a *simulated* play mode with
  sample-accurate Web-Audio tick scheduling. Phase 7 reuses that canvas approach —
  there is no "ariu"/framework to match. Note the live overlay (this feature) is
  distinct from that in-app simulated playback: it renders against *live lazer*
  gameplay it does not clock-control, which is exactly why the audio correlation in
  Phases 3–4 is needed.

Module layout — the backend uses **flat files** in `src-tauri/src/`, not nested `mod.rs`
trees. Match that. Current + planned:

```
src-tauri/
  src/
    lib.rs            -- registers the five commands; owns the log-tail thread +
                         `live-play`/`live-stop` emit (Phase 1 wiring + Phase 7.1 bridge)
    lazer_log.rs      -- Phase 1 DONE: watcher + parser in ONE flat file (no split needed
                         yet). Poll-based `Tail`, sync thread + `on_signal` callback.
    library.rs        -- Phase 2  (thin resolver over realm::mania_library) — TODO
    audio.rs          -- Phase 3-4 (reference decode/downsample, cpal capture, correlate)
                         — TODO, and possibly de-scoped; see the strategy note above
    session.rs        -- Phase 5  (state machine) — TODO
    judgment.rs       -- Phase 6  (hit matching) — TODO
```

Frontend: `src/livesync.ts` already owns the `live-play`/`live-stop` listener and the
in-sync playback for the latency test — the overlay widget (Phase 7.2) should build
alongside it, in the same hand-rolled `<canvas>` style as `src/detail.ts`.

---

## Phase 0 — Scaffolding  *(status: partial)*

**Goal:** dependencies compile; no logic yet.

- Deps still to add when Phases 3–4 begin: `cpal`, `symphonia` (enable the codec
  features for your beatmaps' audio — mp3/ogg/vorbis), `rubato`. Already present, do
  **not** re-add: `serde`, `serde_json`, `rosu-map`, `rosu-pp`, `dirs`, `anyhow`,
  `which`, `log`, `tauri-plugin-log`.
- ⚠️ **`notify` is NOT a runtime dep and should not become one.** Phase 1 evaluated it
  and **rejected** it: `bench_detection_latency` (in `lazer_log.rs`) measured a 1ms
  held-handle `read` poll noticing appends in ~0.2ms median, while `notify` (FSEvents)
  coalesced writes so badly it missed 299/300. `notify` is kept only as a
  **dev-dependency** for that benchmark. The live tail uses the poll.
- The log path helper already exists: `osu_logs_dir()` in `beatmap.rs`. On this (Linux)
  machine it resolves to `~/.local/share/osu/logs`. The follower already targets the
  newest `*.runtime.log` (osu rotates per launch) — the filename is not a fixed constant.

**Done when:** `cargo build` succeeds with all deps present, no warnings about unused-for-now crates needed.

**Non-goals:** no audio yet. (Watcher + parsing are already done — see Phase 1.)

---

## Phase 1 — Log tail (`lazer_log.rs`)  *(status: DONE)*

Built as a **single flat `lazer_log.rs`**, not a `watcher.rs`/`parser.rs` split — it's
small enough that the split wasn't worth it. What actually shipped, and where it differs
from the original sketch below:

### 1.1 Raw line watcher — DONE (poll, not `notify`; sync thread, not tokio)

Implemented as a held-open `Tail` struct: one `read` syscall per 1ms `POLL` tick on a
handle kept at EOF (starts at EOF, ignores history), draining `\n`-terminated lines and
keeping any trailing fragment. Rotation to a fresher `*.runtime.log` is checked every
`ROTATE_CHECK` (500ms). It runs on a plain `std::thread` and delivers results via an
`FnMut(LiveSignal)` **callback** (`follow_forever` / `Follower::handle`) — **not** a
`tokio::sync::mpsc` channel. The monotonic `Instant` is stamped the moment `poll` returns
new bytes, before parsing, so the start anchor isn't pushed by our own work. Covered by
`tail_reads_only_appends_from_eof` and `read_new_lines_tails_appends` tests.

> The original sketch here called for a `notify`-based watcher on a tokio task. That was
> tried and **rejected** on latency grounds (see Phase 0). Don't revert to it.

### 1.2 Line parser — DONE (different variants than sketched)

The real `LazerEvent` (osu emits a game-wide *working beatmap* line + `GameplayClockContainer`
lifecycle lines — there is no "entered SoloPlayer" signal in practice):

```rust
enum LazerEvent {
    WorkingBeatmap { artist, title, creator, difficulty },  // "Game-wide working beatmap updated to …"
    LeadIn(i64),                                             // "GameplayClockContainer seeking to -N"
    GameplayStarted,                                         // "GameplayClockContainer started …"
    GameplayStopped,                                         // "GameplayClockContainer stopped …"
    Unrecognized,
}
```

Notes vs the sketch: it captures the **creator/mapper** too, and parses
`"{artist} - {title} ({creator}) [{difficulty}]"` by peeling fields off the right
(difficulty → creator → split remainder on first `" - "`) so titles/artists containing
`-`, `(`, `[` still parse. Real log lines are embedded as `#[cfg(test)]` fixtures
(`parses_working_beatmap`, `parses_working_beatmap_with_tricky_creator`,
`parses_clock_events`, `ignores_noise_and_header`). All passing.

`Follower` holds the cross-line state (last working beatmap + pending lead-in) and turns
the event stream into `LiveSignal::Start { artist, title, difficulty, started_at, lead_in_ms }`
/ `LiveSignal::Stop`, which `lib.rs` consumes.

**Non-goals (still true):** no multiplayer / non-solo screens — `Unrecognized` catch-all is fine.

---

## Phase 2 — Beatmap library resolution (`library.rs`)

### 2.1 Build a lookup over the existing library

**Do not re-dump the realm.** Reuse `realm::mania_library` (fed by
`scripts/realm-reader.mjs`), which already yields sets → difficulties with `hash`,
`name`, `audio_hash`, `audio_file`, and `DiffMeta { title, title_unicode, artist,
author }`. Build an in-memory index keyed by a normalized
`"{artist} - {title} [{difficulty}]"` string.

Open item to resolve empirically: whether lazer's log line uses the romanized
`title`/`artist` or the `title_unicode` form — build the key from whichever the real
log excerpts use, and keep both available for fallback matching. The value should carry
the beatmap `hash` (so Phase 3 can fetch audio via `osu_file_path`/`read_audio`) and the
already-parsed hit objects from `read_beatmap_detail` (so Phase 6 needs no re-parse).

### 2.2 Resolve on `BeatmapSelected`

Given a `LazerEvent::BeatmapSelected`, look up the matching entry in the 2.1 index.

---

## Phase 3 — Audio capture + reference prep (`audio/reference.rs`, `audio/capture.rs`)

### 3.1 Reference decode + downsample (`audio.rs`)

Given a beatmap `audio_hash`, resolve the file with the existing `osu_file_path(hash)`
helper (content-addressed `files/a/ab/…`), then decode via `symphonia`, mix to mono, and
resample via `rubato` to a low target rate (start at 8kHz); return `Vec<f32>` plus the
rate used. Note this is a **new Rust decode path** — the frontend's existing Web-Audio
`decodeAudioData` is unrelated and not reusable here.

**Done when:** running against one real beatmap audio file produces a non-empty, correctly-length buffer (spot check: length in samples / target rate ≈ known track duration).

### 3.2 Loopback capture stream (`capture.rs`)

---

## Phase 4 — Correlation engine (`audio/correlate.rs`)

### 4.1 Naive normalized cross-correlation

Implement `score(τ)` as in the design doc. Unit test against a synthetic case first, not real audio: generate a known sine/noise reference, embed it at a known offset inside a longer synthetic buffer, assert the detected offset matches within a few samples.

### 4.2 Confidence gating

Wrap the raw correlation with: require score above threshold (start at 0.9, tune empirically later) across 2-3 consecutive calls before accepting a match.

### 4.3 Epoch computation

```
epoch_time = buffer_capture_host_time + (matched_sample_offset / sample_rate)
```

Expose this as the single value the rest of the system consumes.

**Done when:** run against a real captured loopback session — play any beatmap through lazer with loopback armed, feed the real reference audio, and confirm it locks onto a high-confidence match within a few seconds of playback starting, producing a sane epoch value (i.e., not wildly before "now" or in the future).

**Non-goals:** no FFT-based speedup yet (`rustfft`) — only revisit if the naive version is measurably too slow in practice (profile before optimizing). No rate-changing-mod handling.

---

## Phase 5 — State machine (`session/state_machine.rs`)

Wire Phases 1-4 together:

```
Idle
  --BeatmapSelected(resolved)--> MapLoaded { audio, timing }
MapLoaded
  --GameplayEntered--> Armed { predicted_onset: now + lead_in_ms }
Armed
  --(correlation locks)--> EpochResolved { epoch }
EpochResolved
  --GameplayStopped--> Idle
```

Include the sanity check from the design doc: when correlation resolves, log a warning (not a hard failure) if the resolved epoch differs from `predicted_onset` by more than some threshold (start at ±250ms) — this is a debugging aid, not something to gate functionality on.

**Done when:** a full real play (map select → play → finish/quit) drives the state machine through all states in order, observable via log/print statements at each transition, using a real `runtime.log` tail rather than fixture data.

**Non-goals:** no UI yet. No hit judgment yet. Just prove the orchestration.

---

## Phase 6 — Hit judgment (`judgment/hit_match.rs`)

### 6.1 Keypress integration

use the rdev carte on windows and mac and evdev on linux, emit timestamped press events into this system, using the same clock domain as the epoch (`Instant`/`mach_absolute_time`-backed).

### 6.2 Matching logic

As sketched in the design doc: for each press, find nearest unmatched hit-object within a
hit window, compute `error_ms`, mark matched. Reuse the already-parsed
`ManiaNote { start_time, column, end_time }` from `read_beatmap_detail` as the hit-object
source — mania is per-column, so match a press to its column's notes (map the physical key
→ column via `key_count`).

**Done when:** unit test with a synthetic list of hit objects and synthetic press timestamps produces the expected error values and correctly ignores presses outside any hit window.

---

## Phase 7 — Overlay rendering

### 7.1 Event bridge to frontend  *(status: DONE — reuse, don't rebuild)*

⚠️ The `emit`/`listen` plumbing **already exists**. `lib.rs` clones the `AppHandle` into
the log-tail thread and emits `live-select` (working beatmap changed), `live-play`
(gameplay start, payload `artist/title/difficulty/start_in_ms/lead_in_ms`), and
`live-stop`; `src/livesync.ts` uses `listen()` from `@tauri-apps/api/event`. On
`live-select` it jumps the sidebar/detail to the picked map; on `live-play` it navigates
there and drives the note chart's own playback (`requestLivePlay`/`startLive` in
`detail.ts`) so the chart scrolls and plays audio aligned to osu!'s position 0.

Remaining work for this feature: add a judged-hit event (`error_ms`, timestamp) alongside
these (or extend a payload) once Phase 6 produces judgments — the transport itself is done.

### 7.2 Visualization widget

Scrolling hit-error bar/graph in the frontend. There is **no framework or charting lib**
(vanilla TS, only `@tauri-apps/api`); build it as a hand-rolled `<canvas>` component in
the same style as the existing note chart in `src/detail.ts` (which already does canvas
draw loops, a `ResizeObserver`, and DPR scaling — reuse those patterns). Run
`pnpm exec tsc --noEmit` after every frontend edit (strict + noUnusedLocals).

**Done when:** during a real play, the overlay visibly updates per judged hit, including the small retroactive catch-up burst for the first 1-2 seconds of hits judged right after epoch resolution (per the known limitation in the design doc) — this burst should be visually acceptable, not jarring; revisit only if it's actually distracting in practice.

---

## Phase 8 — Validation

### 8.1 Log-vs-correlation comparison harness

For several real plays, record both the log-derived rough estimate and the correlation-derived epoch; output the delta distribution to quantify the actual log-only error budget on this machine (per the open item in the design doc).

### 8.2 End-to-end soundness pass

Play a real map start-to-finish with the full pipeline running; confirm no panics, no obviously wrong error values (e.g. sanity-check a few hits by ear/eye against the map).
