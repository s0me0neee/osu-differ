# osu!diff

A desktop app for analyzing osu! **lazer** mania beatmaps. It reads your local osu!
library, lists your mania maps in a sidebar, and opens a detailed per-difficulty
view built around an interactive note chart.

Built with [Tauri 2](https://tauri.app/) — a Rust backend with a vanilla
TypeScript + [Vite](https://vitejs.dev/) frontend (no UI framework).

## Features

- **Mania library sidebar** — beatmap sets grouped by song, each expandable into
  its difficulties (with key count and star rating), searchable by original or
  romanized title and artist.
- **Detail view** — star rating, keys, BPM (range + primary), length, note/tap/hold
  counts, NPS, difficulty settings, and a per-column note distribution.
- **Interactive note chart** — a vertical, gameplay-oriented canvas (song start at
  the bottom) with a time-axis gutter and beat/measure gridlines. Hovering shows a
  crosshair with the time, active BPM, and note details, highlighting every note
  the line crosses. Can be maximized to fill the window.
- **Timing summary** — constant-step BPM ramps (e.g. 165→180→…→300) are collapsed
  into a single row instead of dozens.

## How it works

osu! lazer stores metadata in a Realm database and beatmap files
content-addressed by hash. The app:

1. Reads the Realm via `read_realm` and lists mania difficulties.
2. On selection, resolves the map hash to its `.osu` file and parses it with
   `rosu-map` (+ `rosu-pp` for star rating) via `read_beatmap`, returning
   fully-computed stats to the frontend.

See [CLAUDE.md](./CLAUDE.md) for the architecture in depth.

## Prerequisites

- **osu! lazer** installed with at least some mania maps.
- **Rust** toolchain and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).
- **Node.js on your `PATH`** — the backend shells out to it to read the Realm
  (the `realm` package requires Node; Bun does not work).
- **pnpm** for the frontend/Tauri tooling.

## Development

```sh
pnpm install
pnpm tauri dev          # run the app (dev window + HMR)
pnpm exec tsc --noEmit  # typecheck the frontend
```

Work on the backend headlessly (no window) via its tests:

```sh
cd src-tauri
cargo test                                  # all backend tests
cargo test reads_mania_beatmap -- --nocapture
```

## Build

```sh
pnpm tauri build
```

## Known limitations

The osu! Realm path (in `src/main.ts`) and the paths in the Rust tests are
currently **hardcoded** to a specific machine. Point them at your own osu! install
(and use a copy of `client.realm`, since osu! locks the live database) to run
locally.

## License

See [LICENSE](./LICENSE).
