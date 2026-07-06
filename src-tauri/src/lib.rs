mod beatmap;
mod lazer_log;
mod realm;

use tauri::Emitter;

/// Payload for the `live-play` event: what the live osu! session just started,
/// plus how many ms from *emit* until the song reaches position 0 (negative if
/// that instant already passed). The frontend uses this to play the same song in
/// sync — a manual latency check, not a shipped feature.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LivePlay {
    artist: String,
    title: String,
    difficulty: String,
    start_in_ms: f64,
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
                    lazer_log::LiveSignal::Start(s) => {
                        // Audio position 0 is reached |lead_in| ms after the
                        // gameplay clock starts; express that as ms-from-now.
                        let lead = s.lead_in_ms.unwrap_or(0).unsigned_abs();
                        let audio_zero = s.started_at + std::time::Duration::from_millis(lead);
                        let now = std::time::Instant::now();
                        let start_in_ms = if audio_zero >= now {
                            audio_zero.duration_since(now).as_secs_f64() * 1000.0
                        } else {
                            -(now.duration_since(audio_zero).as_secs_f64() * 1000.0)
                        };
                        let _ = handle.emit(
                            "live-play",
                            LivePlay {
                                artist: s.artist,
                                title: s.title,
                                difficulty: s.difficulty,
                                start_in_ms,
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
            beatmap::read_beatmap,
            beatmap::read_audio
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
