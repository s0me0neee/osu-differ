use anyhow::{bail, Result};
use std::{path::PathBuf, process::Command, sync::OnceLock};

fn node_path() -> &'static PathBuf {
    static NODE: OnceLock<PathBuf> = OnceLock::new();
    NODE.get_or_init(|| which::which_global("node").expect("Failed to find node"))
}

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
    let script = root.join("scripts/realm-reader.mjs");

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_osu_realm() {
        let path = "/Users/maot27/Library/Application Support/osu/client.realm.copy";
        let json = fetch_realm(path).expect("fetch_realm failed");
        let data: serde_json::Value = serde_json::from_str(&json).expect("invalid json");
        let obj = data.as_object().expect("expected top-level object");
        println!("schema types: {:?}", obj.keys().collect::<Vec<_>>());
        assert!(obj.contains_key("Beatmap"), "expected a Beatmap table");
    }
}
