use anyhow::{Context, Result};
use log::info;
use rosu_map::section::general::GameMode;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;

/// osu! lazer's own per-OS data root: `~/Library/Application Support/osu` /
/// `~/.local/share/osu` on macOS/Linux; on Windows lazer nests the launcher's
/// data dir one level deeper than the game's own `osu` folder, so it's a `../`
/// sibling of `dirs::data_dir()` instead. Every osu!-owned path (the `files/`
/// store, `logs/`, the realm copy) hangs off this single root.
pub(crate) fn osu_root_dir() -> PathBuf {
    let base = dirs::data_dir().expect("no data dir");
    #[cfg(windows)]
    {
        base.join("../osu")
    }
    #[cfg(not(windows))]
    {
        base.join("osu")
    }
}

/// osu! lazer stores files content-addressed under its data dir.
fn osu_files_dir() -> PathBuf {
    let p = osu_root_dir().join("files");
    info!("using osu files path: {}", p.display());
    p
}

pub(crate) fn osu_logs_dir() -> PathBuf {
    let p = osu_root_dir().join("logs");
    info!("using osu logs path: {}", p.display());
    p
}

/// A content hash `abcdef...` lives at `files/a/ab/abcdef...`.
fn osu_file_path(hash: &str) -> PathBuf {
    osu_files_dir()
        .join(&hash[0..1])
        .join(&hash[0..2])
        .join(hash)
}

#[derive(Serialize)]
pub struct DifficultySettings {
    pub ar: f32,
    pub od: f32,
    pub cs: f32,
    pub hp: f32,
    pub slider_multiplier: f64,
    pub slider_tick_rate: f64,
}

#[derive(Serialize)]
pub struct TimingInfo {
    pub time: f64,
    pub bpm: f64,
    pub beat_len: f64,
    pub meter: i32,
}

/// A mania scroll-speed (green line / effect) point. `sv` is the scroll-speed
/// multiplier active from `time` onward (default 1.0).
#[derive(Serialize)]
pub struct SvPoint {
    pub time: f64,
    pub sv: f64,
}

/// A mania note. `end_time` is set for long notes (holds), `None` for taps.
#[derive(Serialize)]
pub struct ManiaNote {
    pub start_time: f64,
    pub column: u32,
    pub end_time: Option<f64>,
}

#[derive(Serialize)]
pub struct BpmSummary {
    pub min: f64,
    pub max: f64,
    pub primary: f64,
}

#[derive(Serialize)]
pub struct BeatmapDetail {
    pub mode: String,
    pub key_count: u32,
    pub difficulty: DifficultySettings,
    pub bpm: BpmSummary,
    pub timing_points: Vec<TimingInfo>,
    /// mania scroll-speed multipliers over time (from green lines / effect points)
    pub sv_points: Vec<SvPoint>,
    pub notes: Vec<ManiaNote>,
    pub star_rating: f64,
    /// span from first note start to last note end, in ms
    pub length_ms: f64,
    pub tap_count: u32,
    pub hold_count: u32,
    /// note count per column, indexed 0..key_count
    pub column_counts: Vec<u32>,
}

/// mania column from an x position: floor(x * keys / 512), clamped into range.
fn column_for(x: f32, key_count: u32) -> u32 {
    if key_count == 0 {
        return 0;
    }
    ((x * key_count as f32 / 512.0).floor() as i64).clamp(0, key_count as i64 - 1) as u32
}

/// Parse the `.osu` file for the given map hash and extract timing/notes/difficulty.
/// Pure logic (no Tauri types) so it can run headlessly under `cargo test`.
pub fn read_beatmap_detail(hash: &str) -> Result<BeatmapDetail> {
    let path = osu_file_path(hash);
    let map = rosu_map::Beatmap::from_path(&path)
        .with_context(|| format!("failed to parse {}", path.display()))?;

    // Mania-convert via rosu-pp: a no-op for an already-mania file, a real
    // osu!std->mania conversion (matching lazer's own algorithm) otherwise —
    // this is how lazer lets you play any std map as mania. Notes/key-count/
    // difficulty stats all come from this converted map, not the raw parse
    // above (which stays around for timing points, unaffected by conversion).
    let mut pp_map = rosu_pp::Beatmap::from_path(&path)
        .with_context(|| format!("failed to parse {} for pp", path.display()))?;
    pp_map
        .convert_mut(GameMode::Mania, &rosu_pp::GameMods::default())
        .with_context(|| format!("{} can't convert to mania", path.display()))?;

    let key_count = pp_map.cs.round().max(1.0) as u32;

    let notes = pp_map
        .hit_objects
        .iter()
        .filter_map(|obj| match &obj.kind {
            rosu_pp::model::hit_object::HitObjectKind::Circle => Some(ManiaNote {
                start_time: obj.start_time,
                column: column_for(obj.pos.x, key_count),
                end_time: None,
            }),
            rosu_pp::model::hit_object::HitObjectKind::Hold(h) => Some(ManiaNote {
                start_time: obj.start_time,
                column: column_for(obj.pos.x, key_count),
                end_time: Some(obj.start_time + h.duration),
            }),
            _ => None,
        })
        .collect::<Vec<_>>();

    let timing_points = map
        .control_points
        .timing_points
        .iter()
        .map(|tp| TimingInfo {
            time: tp.time,
            bpm: 60_000.0 / tp.beat_len,
            beat_len: tp.beat_len,
            meter: tp.time_signature.numerator.get() as i32,
        })
        .collect::<Vec<_>>();

    // mania scroll-speed multipliers from green lines (effect points)
    let sv_points = map
        .control_points
        .effect_points
        .iter()
        .map(|ep| SvPoint {
            time: ep.time,
            sv: ep.scroll_speed,
        })
        .collect::<Vec<_>>();

    let bpm = bpm_summary(&timing_points, &map.hit_objects);

    let attrs = rosu_pp::Difficulty::new()
        .calculate_for_mode::<rosu_pp::mania::Mania>(&pp_map)
        .map(|a| a.stars)
        .unwrap_or(0.0);

    // derived stats (kept in Rust)
    let hold_count = notes.iter().filter(|n| n.end_time.is_some()).count() as u32;
    let tap_count = notes.len() as u32 - hold_count;

    let mut column_counts = vec![0u32; key_count as usize];
    for n in &notes {
        if let Some(c) = column_counts.get_mut(n.column as usize) {
            *c += 1;
        }
    }

    let length_ms = {
        let start = notes.iter().map(|n| n.start_time).fold(f64::MAX, f64::min);
        let end = notes
            .iter()
            .map(|n| n.end_time.unwrap_or(n.start_time))
            .fold(f64::MIN, f64::max);
        if notes.is_empty() {
            0.0
        } else {
            (end - start).max(0.0)
        }
    };

    Ok(BeatmapDetail {
        mode: format!("{:?}", map.mode),
        key_count,
        difficulty: DifficultySettings {
            ar: map.approach_rate,
            od: map.overall_difficulty,
            cs: pp_map.cs, // converted key count (== key_count) for converts
            hp: map.hp_drain_rate,
            slider_multiplier: map.slider_multiplier,
            slider_tick_rate: map.slider_tick_rate,
        },
        bpm,
        timing_points,
        sv_points,
        star_rating: attrs,
        length_ms,
        tap_count,
        hold_count,
        column_counts,
        notes,
    })
}

/// min/max BPM plus the duration-weighted most-common ("primary") BPM.
fn bpm_summary(
    points: &[TimingInfo],
    hit_objects: &[rosu_map::section::hit_objects::HitObject],
) -> BpmSummary {
    if points.is_empty() {
        return BpmSummary {
            min: 0.0,
            max: 0.0,
            primary: 0.0,
        };
    }

    let mut min = f64::MAX;
    let mut max = f64::MIN;
    for p in points {
        min = min.min(p.bpm);
        max = max.max(p.bpm);
    }

    // last timing section runs until the final hit object
    let track_end = hit_objects
        .iter()
        .map(|o| o.start_time)
        .fold(0.0_f64, f64::max);

    // accumulate how long each (rounded) BPM is active, pick the longest
    let mut weight: HashMap<u64, f64> = HashMap::new();
    for (i, p) in points.iter().enumerate() {
        let end = points.get(i + 1).map(|n| n.time).unwrap_or(track_end);
        let dur = (end - p.time).max(0.0);
        *weight.entry(p.bpm.round() as u64).or_insert(0.0) += dur;
    }
    let primary = weight
        .into_iter()
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(bpm, _)| bpm as f64)
        .unwrap_or(points[0].bpm);

    BpmSummary { min, max, primary }
}

#[tauri::command]
pub async fn read_beatmap(hash: String) -> Result<BeatmapDetail, String> {
    read_beatmap_detail(&hash).map_err(|e| e.to_string())
}

/// Read a content-addressed file (e.g. the beatmap's audio) by hash and return
/// its raw bytes. The JS side receives an ArrayBuffer.
#[tauri::command]
pub async fn read_audio(hash: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(osu_file_path(&hash))
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_mania_beatmap() {
        // Resolve a real mania difficulty from whatever's in the local
        // library instead of hardcoding one machine's beatmap hash.
        let json = crate::realm::fetch_realm(&crate::realm::get_realm_path())
            .expect("fetch_realm failed");
        let hash =
            crate::realm::first_mania_hash(&json).expect("no mania beatmap in local library");
        let d = read_beatmap_detail(&hash).expect("read_beatmap_detail failed");

        println!(
            "mode={} keys={} notes={} timing_points={} bpm(min={} max={} primary={}) stars={:.2}",
            d.mode,
            d.key_count,
            d.notes.len(),
            d.timing_points.len(),
            d.bpm.min,
            d.bpm.max,
            d.bpm.primary,
            d.star_rating,
        );
        for n in d.notes.iter().take(5) {
            println!(
                "  note t={} col={} end={:?}",
                n.start_time, n.column, n.end_time
            );
        }

        assert!(!d.notes.is_empty(), "expected notes");
        assert!(!d.timing_points.is_empty(), "expected timing points");
        assert!(
            d.notes.iter().all(|n| n.column < d.key_count),
            "column out of range"
        );
        assert!(d.bpm.primary > 0.0, "expected a positive primary BPM");
        assert_eq!(
            d.column_counts.len(),
            d.key_count as usize,
            "one count per column"
        );
        assert_eq!(
            d.tap_count + d.hold_count,
            d.notes.len() as u32,
            "taps + holds == notes"
        );
        assert_eq!(
            d.column_counts.iter().sum::<u32>(),
            d.notes.len() as u32,
            "column counts sum to notes"
        );
        assert!(d.length_ms > 0.0, "expected positive length");
    }

    #[test]
    fn reads_converted_beatmap() {
        // an osu!standard difficulty auto-converted to mania, so this only
        // runs meaningfully on a library that has at least one such map.
        let json = crate::realm::fetch_realm(&crate::realm::get_realm_path())
            .expect("fetch_realm failed");
        let hash =
            crate::realm::first_convert_hash(&json).expect("no convert-eligible beatmap");
        let d = read_beatmap_detail(&hash).expect("read_beatmap_detail failed");

        assert_eq!(d.mode, "Osu", "source file should be osu!standard");
        assert!(!d.notes.is_empty(), "expected converted notes");
        assert!(
            d.notes.iter().all(|n| n.column < d.key_count),
            "column out of range"
        );
        assert!(d.key_count >= 1, "expected a converted key count");
    }
}
