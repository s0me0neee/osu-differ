mod beatmap;
mod lazer_log;
mod realm;

use tauri::Emitter;

/// Payload for the `live-select` event: the beatmap the live osu! session just
/// made its game-wide working beatmap (i.e. what the player currently has picked
/// in song select). The frontend uses this to jump to that difficulty.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveSelect {
    artist: String,
    title: String,
    difficulty: String,
}

/// Payload for the `live-play` event: an absolute wall-clock epoch-ms timestamp
/// for when the song reaches position 0 (not "ms from now" — the frontend is a
/// different process/clock, so a relative value would bake in IPC transit time).
/// A manual latency check, not a shipped feature.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LivePlay {
    artist: String,
    title: String,
    difficulty: String,
    audio_zero_epoch_ms: f64,
    lead_in_ms: i64,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                .build(),
        )
        .setup(|app| {
            // Follow osu! lazer's runtime.log in the background: log the
            // currently-playing beatmap, and on gameplay start emit a `live-play`
            // event so the frontend can play the same song in sync (latency test).
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let dir = beatmap::osu_logs_dir();
                lazer_log::follow_forever(&dir, move |sig| match sig {
                    lazer_log::LiveSignal::Select(s) => {
                        // The player picked (or previewed) a map in song select —
                        // tell the frontend to jump to it.
                        let _ = handle.emit(
                            "live-select",
                            LiveSelect {
                                artist: s.artist,
                                title: s.title,
                                difficulty: s.difficulty,
                            },
                        );
                    }
                    lazer_log::LiveSignal::Start(s) => {
                        // fires on the session's first start and every resume;
                        // audio_zero is already resume-adjusted by lazer_log.
                        let audio_zero_epoch_ms = s
                            .audio_zero
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_secs_f64()
                            * 1000.0;
                        let _ = handle.emit(
                            "live-play",
                            LivePlay {
                                artist: s.artist,
                                title: s.title,
                                difficulty: s.difficulty,
                                audio_zero_epoch_ms,
                                lead_in_ms: s.lead_in_ms.unwrap_or(0),
                            },
                        );
                    }
                    lazer_log::LiveSignal::Stop => {
                        let _ = handle.emit("live-stop", ());
                    }
                });
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            realm::read_realm,
            realm::read_mania_library,
            realm::get_realm_path,
            beatmap::read_beatmap,
            beatmap::read_audio
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
