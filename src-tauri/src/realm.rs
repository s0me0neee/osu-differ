use anyhow::{bail, Context, Result};
use log::info;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::{path::PathBuf, process::Command, sync::OnceLock};

fn node_path() -> &'static PathBuf {
    static NODE: OnceLock<PathBuf> = OnceLock::new();
    NODE.get_or_init(|| which::which_global("node").expect("Failed to find node"))
}

#[tauri::command]
pub fn get_realm_path() -> String {
    let p = std::path::absolute(crate::beatmap::osu_root_dir().join("client.realm.copy"))
        .expect("Failed to get abs path of osu");
    info!("using osu realm path: {}", p.display());
    p.to_string_lossy().to_string()
}

// fn logger() -> &'static

fn project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("failed to resolve project root")
        .to_path_buf()
}

/// Core logic: run the node reader script and return its JSON output.
/// Takes no Tauri types, so it can be exercised headlessly with `cargo test`.
pub fn fetch_realm(path: &str) -> Result<String> {
    let root = project_root();
    info!("using root {}", root.display());
    let script = root.join("scripts/realm-reader.mjs");

    info!("using script {}", script.display());
    let output = Command::new(node_path())
        .current_dir(&root)
        .args([script.to_str().unwrap(), path])
        .output()?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        bail!(String::from_utf8_lossy(&output.stderr).into_owned())
    }
}

#[tauri::command]
pub async fn read_realm(path: String) -> Result<String, String> {
    fetch_realm(&path).map_err(|e| e.to_string())
}

// --- Mania library: parse the realm dump and build the sidebar model in Rust ---
// The realm reader emits every table; we deserialize only the fields we need
// (serde ignores the rest) and return a compact list of mania sets so the
// frontend never has to parse the full ~6.6 MB dump.

#[derive(Deserialize)]
struct RealmRef {
    #[serde(rename = "_pk")]
    pk: String,
}

#[derive(Deserialize)]
struct RealmAuthor {
    #[serde(rename = "Username")]
    username: Option<String>,
}

#[derive(Deserialize)]
struct RealmMetadata {
    #[serde(rename = "Title")]
    title: Option<String>,
    #[serde(rename = "TitleUnicode")]
    title_unicode: Option<String>,
    #[serde(rename = "Artist")]
    artist: Option<String>,
    #[serde(rename = "Author")]
    author: Option<RealmAuthor>,
    #[serde(rename = "AudioFile")]
    audio_file: Option<String>,
}

#[derive(Deserialize)]
struct RealmDifficulty {
    #[serde(rename = "CircleSize")]
    circle_size: Option<f64>,
}

#[derive(Deserialize)]
struct RealmBeatmap {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "DifficultyName")]
    difficulty_name: Option<String>,
    #[serde(rename = "Ruleset")]
    ruleset: Option<RealmRef>,
    #[serde(rename = "Difficulty")]
    difficulty: Option<RealmDifficulty>,
    #[serde(rename = "Metadata")]
    metadata: Option<RealmMetadata>,
    #[serde(rename = "Hash")]
    hash: Option<String>,
    #[serde(rename = "StarRating")]
    star_rating: Option<f64>,
}

#[derive(Deserialize)]
struct RealmNamedFile {
    #[serde(rename = "Filename")]
    filename: Option<String>,
    #[serde(rename = "File")]
    file: Option<RealmRef>,
}

#[derive(Deserialize)]
struct RealmBeatmapSet {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Beatmaps")]
    beatmaps: Option<Vec<RealmRef>>,
    #[serde(rename = "Files")]
    files: Option<Vec<RealmNamedFile>>,
}

#[derive(Deserialize)]
struct RealmDump {
    #[serde(rename = "Beatmap", default)]
    beatmap: Vec<RealmBeatmap>,
    #[serde(rename = "BeatmapSet", default)]
    beatmap_set: Vec<RealmBeatmapSet>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiffMeta {
    title: String,
    title_unicode: String,
    artist: String,
    author: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManiaDiffDto {
    hash: String,
    name: String,
    stars: f64,
    key_count: u32,
    /// true if this is an auto-converted (not mapper-authored mania) diff.
    /// `key_count`/`stars` here are the original std beatmap's, not converted.
    is_convert: bool,
    audio_hash: Option<String>,
    audio_file: Option<String>,
    meta: DiffMeta,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManiaSetDto {
    id: String,
    title: String,
    title_romanized: String,
    artist: String,
    author: String,
    difficulties: Vec<ManiaDiffDto>,
}

/// Parse the realm dump JSON and group mania difficulties into sets. Pure logic
/// (no Tauri types) so it runs headlessly under `cargo test`.
pub fn mania_library(dump_json: &str) -> Result<Vec<ManiaSetDto>> {
    let dump: RealmDump = serde_json::from_str(dump_json).context("invalid realm dump json")?;

    let by_id: HashMap<&str, &RealmBeatmap> =
        dump.beatmap.iter().map(|b| (b.id.as_str(), b)).collect();

    let mut sets: Vec<ManiaSetDto> = Vec::new();
    for set in &dump.beatmap_set {
        // filename (lowercased) -> content hash, for resolving the audio file
        let mut file_hash: HashMap<String, &str> = HashMap::new();
        for f in set.files.iter().flatten() {
            if let (Some(name), Some(file)) = (&f.filename, &f.file) {
                file_hash.insert(name.to_lowercase(), file.pk.as_str());
            }
        }

        let mut diffs: Vec<ManiaDiffDto> = Vec::new();
        for r in set.beatmaps.iter().flatten() {
            let Some(b) = by_id.get(r.pk.as_str()) else {
                continue;
            };
            // osu!lazer auto-converts osu!standard beatmaps into mania at
            // play time; taiko/catch have no such mania conversion.
            let is_convert = match b.ruleset.as_ref().map(|x| x.pk.as_str()) {
                Some("mania") => false,
                Some("osu") => true,
                _ => continue,
            };
            let meta = b.metadata.as_ref();
            let audio_file = meta.and_then(|m| m.audio_file.clone());
            let audio_hash = audio_file
                .as_ref()
                .and_then(|a| file_hash.get(&a.to_lowercase()).map(|s| s.to_string()));
            let cs = b
                .difficulty
                .as_ref()
                .and_then(|d| d.circle_size)
                .unwrap_or(0.0);
            diffs.push(ManiaDiffDto {
                hash: b.hash.clone().unwrap_or_default(),
                name: b.difficulty_name.clone().unwrap_or_default(),
                stars: b.star_rating.unwrap_or(0.0),
                key_count: cs.round().max(0.0) as u32,
                is_convert,
                audio_hash,
                audio_file,
                meta: DiffMeta {
                    title: meta.and_then(|m| m.title.clone()).unwrap_or_default(),
                    title_unicode: meta
                        .and_then(|m| m.title_unicode.clone())
                        .unwrap_or_default(),
                    artist: meta.and_then(|m| m.artist.clone()).unwrap_or_default(),
                    author: meta
                        .and_then(|m| m.author.as_ref())
                        .and_then(|a| a.username.clone())
                        .unwrap_or_default(),
                },
            });
        }
        if diffs.is_empty() {
            continue;
        }

        diffs.sort_by(|a, b| a.stars.total_cmp(&b.stars));
        let first = &diffs[0].meta;
        let romanized = first.title.clone();
        let title = if !first.title_unicode.is_empty() {
            first.title_unicode.clone()
        } else if !romanized.is_empty() {
            romanized.clone()
        } else {
            "(unknown)".to_string()
        };
        sets.push(ManiaSetDto {
            id: set.id.clone(),
            title,
            title_romanized: romanized,
            artist: first.artist.clone(),
            author: first.author.clone(),
            difficulties: diffs,
        });
    }

    // sort by the romanized title so latin ordering is intuitive
    sets.sort_by(|a, b| {
        let ka = if a.title_romanized.is_empty() {
            &a.title
        } else {
            &a.title_romanized
        };
        let kb = if b.title_romanized.is_empty() {
            &b.title
        } else {
            &b.title_romanized
        };
        ka.to_lowercase().cmp(&kb.to_lowercase())
    });
    Ok(sets)
}

/// Resolve the hash of some real mania difficulty in the local library, so
/// tests can exercise `read_beatmap_detail` against whatever's actually
/// installed rather than one machine's hardcoded beatmap hash.
#[cfg(test)]
pub(crate) fn first_mania_hash(dump_json: &str) -> Result<String> {
    let sets = mania_library(dump_json)?;
    sets.into_iter()
        .flat_map(|s| s.difficulties)
        .filter(|d| !d.is_convert)
        .map(|d| d.hash)
        .find(|h| !h.is_empty())
        .context("no mania difficulty with a hash found in the local library")
}

/// Same as [`first_mania_hash`] but for a convert-eligible (osu!standard)
/// difficulty, so convert support can be tested without a hardcoded hash.
#[cfg(test)]
pub(crate) fn first_convert_hash(dump_json: &str) -> Result<String> {
    let sets = mania_library(dump_json)?;
    sets.into_iter()
        .flat_map(|s| s.difficulties)
        .filter(|d| d.is_convert)
        .map(|d| d.hash)
        .find(|h| !h.is_empty())
        .context("no convert-eligible beatmap found in the local library")
}

#[tauri::command]
pub async fn read_mania_library(path: String) -> Result<Vec<ManiaSetDto>, String> {
    let json = fetch_realm(&path).map_err(|e| e.to_string())?;
    mania_library(&json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_osu_realm() {
        let path = &get_realm_path();
        let json = fetch_realm(path).expect("fetch_realm failed");
        let data: serde_json::Value = serde_json::from_str(&json).expect("invalid json");
        let obj = data.as_object().expect("expected top-level object");
        println!("schema types: {:?}", obj.keys().collect::<Vec<_>>());
        assert!(obj.contains_key("Beatmap"), "expected a Beatmap table");
    }

    #[test]
    fn builds_mania_library() {
        let path = &get_realm_path();
        let json = fetch_realm(path).expect("fetch_realm failed");
        let sets = mania_library(&json).expect("mania_library failed");
        println!(
            "mania sets={} diffs={}",
            sets.len(),
            sets.iter().map(|s| s.difficulties.len()).sum::<usize>()
        );
        assert!(!sets.is_empty(), "expected mania sets");
        let with_audio = sets
            .iter()
            .flat_map(|s| &s.difficulties)
            .filter(|d| d.audio_hash.is_some())
            .count();
        assert!(with_audio > 0, "expected at least one resolved audio hash");
    }
}
