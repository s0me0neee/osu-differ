# CLAUDE.md

## Commands

Don't write long comments, is the code is too hard to understand keep comments short and helpful

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`osu!diff` is a Tauri 2 desktop app for analyzing osu! **lazer** mania beatmaps
(the Rust crate / npm package are named `osu_diff`, since `!` isn't a valid
identifier). A
Rust backend reads osu!'s local data (a Realm database + content-addressed `.osu`
files) and a vanilla-TypeScript frontend renders a sidebar of mania sets and a
per-difficulty detail view whose centerpiece is an interactive canvas note chart.

## Commands

Package manager is **pnpm**. Run frontend/Tauri commands from the repo root,
`cargo` commands from `src-tauri/`.

- `pnpm tauri dev` — run the full app (spawns a window; Vite HMR for the frontend).
- `pnpm exec tsc --noEmit` — typecheck the frontend. `tsconfig.json` has
  `strict` + `noUnusedLocals`, so unused vars/functions fail the check. Run this
  after every frontend edit.
- `pnpm tauri build` — production build. `pnpm build` builds only the frontend.
- `cd src-tauri && cargo test` — run backend tests **headlessly (no window)**.
  Single test with output: `cargo test reads_mania_beatmap -- --nocapture`.

### Working on the backend without a window

`fetch_realm` (`realm.rs`) and `read_beatmap_detail` (`beatmap.rs`) take no Tauri
types on purpose, so they run under `cargo test`. Prefer exercising backend logic
through these tests rather than launching `pnpm tauri dev`.

## Architecture

### Two Tauri commands (the entire backend surface)

Registered in `src-tauri/src/lib.rs`; each has a thin `#[tauri::command]` wrapper
over a pure function that returns `anyhow::Result` and is mapped to
`Result<_, String>` for the IPC boundary.

- `read_realm(path)` → `realm::fetch_realm` → JSON string of the whole Realm.
- `read_beatmap(hash)` → `beatmap::read_beatmap_detail` → `BeatmapDetail`.

The TS side calls these via `invoke` in `src/api.ts` (`loadRealm`, `loadBeatmap`);
the `BeatmapDetail` / `Realm*` interfaces there **mirror the Rust structs** — keep
them in sync when you change either side.

### Reading the Realm goes through Node.js, not Rust

The `realm` NAPI package only runs under **Node.js** (it crashes under Bun with a
`uv_cwd` error). So `fetch_realm` shells out: `node scripts/realm-reader.mjs <path>`
and captures stdout. Consequences to respect:

- **Node.js must be on `PATH`** (`which::which_global("node")`).
- `realm-reader.mjs` dumps every non-embedded table to one JSON object. Linked
  objects become `{_type, _pk}` reference stubs (not re-expanded); embedded
  objects (no primary key) are expanded up to depth 3.
- The script **must** end with `process.stdout.write(json, () => process.exit(0))`
  — Realm keeps the event loop alive, so without the explicit exit the Rust
  `.output()` call hangs forever.
- osu! locks the live `client.realm`, so a **copy** (`client.realm.copy`) is used.

### Beatmap parsing is content-addressed

`read_beatmap_detail` resolves a map hash to `<osu data dir>/files/a/ab/abcdef…`
(first char / first two chars / full hash), parses the `.osu` with `rosu-map`, and
computes star rating with `rosu-pp`. osu! data dir via the `dirs` crate: append
`osu/files` on macOS/Linux, `../osu/files` on Windows.

Mania specifics: `key_count = round(CircleSize)`; a note's column is
`floor(x * key_count / 512)`; `HitObjectKind::Hold` → hold (has `end_time`),
`Circle` → tap. BPM = `60000 / beat_len`. All derived stats (tap/hold counts,
per-column counts, length, duration-weighted "primary" BPM) are **computed in
Rust** — the frontend just renders; keep new stats on the backend.

### Frontend flow (vanilla TS, no framework)

`src/main.ts` boots: `loadRealm` → `buildManiaSets` → `renderSidebar`; selecting a
diff calls `loadBeatmap` → `renderDetail`.

- `src/model.ts` — `buildManiaSets` groups `Beatmap`s under their `BeatmapSet`,
  keeps only `Ruleset._pk === "mania"`, exposes `TitleUnicode` as the primary
  title with romanized `Title` alongside.
- `src/sidebar.ts` — collapsible sets, search over original+romanized title+artist.
- `src/detail.ts` — two-column layout: stats/difficulty/column-distribution/timing
  on the left, the note chart filling the right. The note chart is a self-contained
  canvas component (vertical, bottom=start; static notes canvas + a viewport-sized
  overlay canvas for the hover crosshair; maximize; a ResizeObserver keeps lanes
  filling 75% of the column). `summarizeTiming` collapses constant-step BPM ramps
  into single rows.

## Gotchas

- **Realm path is resolved, not hardcoded**: `src/main.ts` and the `realm.rs` /
  `beatmap.rs` tests all call the `get_realm_path` command / `osu_root_dir()`
  helper (`beatmap.rs`) instead of a fixed path, so they work on any machine with
  a local osu! install — `beatmap.rs`'s test additionally resolves its beatmap
  hash via `realm::first_mania_hash` rather than a fixed content hash, so it only
  requires *some* mania difficulty to be present, not one specific map.
- `asset/*.realm*` and `src-tauri/binaries/` are git-ignored (personal data / a
  large abandoned sidecar binary); the app shells out to system `node` instead.
