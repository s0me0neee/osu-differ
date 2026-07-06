# Timing Overlay — Implementation Task Breakdown

Companion to `timing_overlay_design_summary.md`. Each task below is scoped to be handed to Claude Code as a self-contained unit: clear inputs, outputs, files touched, and a concrete "done when" check. Do them in order — later phases depend on earlier ones compiling and passing their own checks first. Each task also lists explicit non-goals, to stop an agentic session from quietly expanding scope into the next phase.

## Reconciliation with the current app (read first)

This plan predates the current codebase; the following is already true and should be
**reused, not rebuilt**:

- **Backend surface** is four Tauri commands in `src-tauri/src/lib.rs`:
  `read_realm`, `read_mania_library`, `read_beatmap`, `read_audio` — each a thin
  `#[tauri::command]` wrapper over a pure `anyhow::Result` function. The app is
  **request/response `invoke` only** — there is currently **no `emit`/`listen`**
  anywhere (Phase 7 introduces the first event bridge).
- **Log dir already resolved**: `osu_logs_dir()` exists in `beatmap.rs`
  (`dirs::data_dir()/osu/logs` on macOS/Linux, `../osu/logs` on Windows). Append
  `runtime.log`. No new path helper needed.
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

Suggested module layout — the existing backend uses **flat files** in `src-tauri/src/`
(`beatmap.rs`, `realm.rs`, `lib.rs`), not nested `mod.rs` trees. Match that; add either
flat files or shallow subdirs:

```
src-tauri/
  src/
    lib.rs            -- register the new commands alongside the existing four
    lazer_log.rs      -- Phase 1  (watcher + parser; split if it grows)
    library.rs        -- Phase 2  (thin resolver over realm::mania_library)
    audio.rs          -- Phase 3-4 (reference decode/downsample, cpal capture, correlate)
    session.rs        -- Phase 5  (state machine)
    judgment.rs       -- Phase 6  (hit matching)
```

---

## Phase 0 — Scaffolding

**Goal:** dependencies compile; no logic yet.

- Add to `Cargo.toml` the **new** deps only: `cpal`, `symphonia` (enable the codec
  features for your beatmaps' audio — mp3/ogg/vorbis), `rubato`, `notify`. Already
  present, do **not** re-add: `serde`, `serde_json`, `rosu-map`, `rosu-pp`, `dirs`,
  `anyhow`, `which`, `log`, `tauri-plugin-log`.
- The log path helper already exists: `osu_logs_dir()` in `beatmap.rs`. On this
  machine it resolves to `~/Library/Application Support/osu/logs`; append
  `runtime.log`. Make the filename a constant, optionally overridable via env var. No
  new path function.

**Done when:** `cargo build` succeeds with all deps present, no warnings about unused-for-now crates needed.

**Non-goals:** no watcher, no parsing, no audio yet.

---

## Phase 1 — Log tail (`lazer_log/`)

### 1.1 Raw line watcher (`watcher.rs`)

Byte-offset-tracked file tail using `notify`, starting at current EOF (ignore history on startup). Emits raw `String` lines via a channel. Note the app already pulls in **Tokio** transitively via Tauri 2 and uses `async` commands (`read_audio` is `async`), so `tokio::sync::mpsc` is the natural fit; keep the watcher on a spawned task rather than blocking a command.

**Done when:** running it against a live `tail -f`-style test (or a script that appends lines to a scratch file on a timer) delivers each appended line exactly once, in order, with no duplicates or drops across at least 50 appended lines.

### 1.2 Line parser (`parser.rs`)

Turn raw lines into a typed `enum LazerEvent`:

```rust
enum LazerEvent {
    BeatmapSelected { artist: String, title: String, difficulty: String },
    GameplayEntered,                  // "entered SoloPlayer"
    LeadInMs(i64),                    // "GameplayClockContainer seeking to -N"
    GameplayStopped,                  // "GameplayClockContainer stopped"
    Unrecognized,
}
```

Use the three real log excerpts already collected in this conversation as literal test fixtures (paste them into `#[cfg(test)]` blocks) — parse each line of each fixture and assert the right variant comes out, including the exact artist/title/difficulty split and the correct sign/value of the lead-in.

**Done when:** all three pasted log excerpts parse with zero panics and the expected events extracted, including edge cases already seen (e.g. the aborted-play log where `PlayerLoader` exits back to song select without ever reaching `SoloPlayer`).

**Non-goals:** don't try to handle multiplayer or non-`SoloPlayer` screen names yet — `Unrecognized` is an acceptable catch-all for now.

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

### 7.1 Event bridge to frontend

Emit judged-hit events (`error_ms`, timestamp) from Rust to the webview. **This is new
plumbing** — the app currently uses only `invoke` request/response with no `emit`/`listen`
anywhere. Use `AppHandle::emit` on the Rust side and `@tauri-apps/plugin`-style
`listen()` from `@tauri-apps/api/event` on the TS side; the watcher/state machine runs on
a background task, so pass the `AppHandle` into it.

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
