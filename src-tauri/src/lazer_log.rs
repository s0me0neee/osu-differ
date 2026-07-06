//! Tail osu! lazer's `runtime.log` and surface the events we care about for the
//! timing overlay. For this first cut we track two things: which beatmap is the
//! game-wide "working" beatmap (i.e. what's selected / being played) and when
//! gameplay actually starts (with its audio lead-in offset).
//!
//! osu! writes a *new* `<sessionId>.runtime.log` per launch, so we always follow
//! the newest one and switch over if a fresher session file appears (osu
//! restarted while we're running).
//!
//! ## Timing accuracy
//!
//! The log's embedded timestamps are **whole-second resolution** (`HH:MM:SS`, no
//! fraction), so we never use them as the start instant. Instead, for timing-
//! critical lines we capture a wall-clock [`SystemTime`] the moment we *read*
//! the line. Wall-clock, not [`Instant`], because this value crosses into the
//! frontend's process (a different clock domain) — see `StartSignal`. To keep
//! the observation instant as close to the true event as possible we poll the
//! file on a tight interval rather than relying on FSEvents (which coalesces/
//! defers notifications and would add tens of ms of slop).
//!
//! The residual, uncontrollable error is osu's own log-flush latency: the gap
//! between `StartGameplayClock` firing and the line being flushed to disk. That
//! floor is why absolute ms-accuracy ultimately comes from the audio-correlation
//! epoch (design doc Phases 3–4), not from this tail. What the log *does* give
//! precisely is the ms lead-in offset, which pins the audio onset relative to
//! clock start.

use log::{info, warn};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// A parsed line of interest from `runtime.log`. Everything we don't recognise
/// collapses to `Unrecognized` — the log is overwhelmingly noise we don't need.
#[derive(Debug, Clone, PartialEq)]
pub enum LazerEvent {
    /// The game-wide working beatmap changed (song select, preview, or the map
    /// that's about to be played). This is our "what song" signal.
    WorkingBeatmap {
        artist: String,
        title: String,
        creator: String,
        difficulty: String,
    },
    /// Gameplay clock seeked to a lead-in offset in ms (usually negative — the
    /// pre-roll before the audio's zero point).
    LeadIn(i64),
    /// Gameplay clock started — playback begins ~now. Fires on the initial
    /// start AND on every resume after a pause.
    GameplayStarted,
    /// Gameplay clock stopped. Fires on a pause exactly like it does on the
    /// final stop — only `ExitedSoloPlayer` tells them apart.
    GameplayStopped,
    /// The play screen was entered — a new play session is beginning.
    EnteredSoloPlayer,
    /// The play screen was exited — the play session is definitely over.
    ExitedSoloPlayer,
    Unrecognized,
}

/// Split a runtime.log line into its `YYYY-MM-DD HH:MM:SS` timestamp and the
/// message after the `[level]: ` prefix. Returns `(None, whole)` for lines that
/// don't match the standard prefix (e.g. the banner header).
fn split_line(line: &str) -> (Option<&str>, &str) {
    // Format: "2026-07-06 07:59:07 [verbose]: message"
    let Some(bracket) = line.find(" [") else {
        return (None, line);
    };
    let ts = &line[..bracket];
    // 19 chars = "YYYY-MM-DD HH:MM:SS"; anything shorter isn't a real timestamp.
    if ts.len() != 19 {
        return (None, line);
    }
    match line.find("]: ") {
        Some(i) => (Some(ts), &line[i + 3..]),
        None => (Some(ts), line),
    }
}

/// Parse `"{artist} - {title} ({creator}) [{difficulty}]"` (osu!'s own
/// `BeatmapInfo.ToString()` shape). We peel fields off the right-hand side —
/// difficulty, then creator, then split the rest on the first `" - "` — because
/// artist/title can themselves contain `-`, `(`, and `[`.
fn parse_beatmap_string(s: &str) -> Option<(String, String, String, String)> {
    let s = s.trim();
    // difficulty: trailing "[...]"
    let (head, difficulty) = if s.ends_with(']') {
        let open = s.rfind(" [")?;
        (s[..open].trim_end(), s[open + 2..s.len() - 1].to_string())
    } else {
        (s, String::new())
    };
    // creator: trailing "(...)"
    let (head, creator) = if head.ends_with(')') {
        match head.rfind(" (") {
            Some(open) => (
                head[..open].trim_end(),
                head[open + 2..head.len() - 1].to_string(),
            ),
            None => (head, String::new()),
        }
    } else {
        (head, String::new())
    };
    // remainder: "artist - title"
    let (artist, title) = head.split_once(" - ")?;
    Some((
        artist.trim().to_string(),
        title.trim().to_string(),
        creator,
        difficulty,
    ))
}

/// Classify a single log line.
pub fn parse_line(line: &str) -> LazerEvent {
    let (_, msg) = split_line(line);

    if let Some(rest) = msg.strip_prefix("Game-wide working beatmap updated to ") {
        if let Some((artist, title, creator, difficulty)) = parse_beatmap_string(rest) {
            return LazerEvent::WorkingBeatmap {
                artist,
                title,
                creator,
                difficulty,
            };
        }
    }
    if let Some(rest) = msg.strip_prefix("GameplayClockContainer seeking to ") {
        if let Ok(ms) = rest.trim().parse::<i64>() {
            return LazerEvent::LeadIn(ms);
        }
    }
    if msg.starts_with("GameplayClockContainer started") {
        return LazerEvent::GameplayStarted;
    }
    if msg.starts_with("GameplayClockContainer stopped") {
        return LazerEvent::GameplayStopped;
    }
    // screen-stack lines: "📺 OsuScreenStack#N(depth:D) entered SoloPlayer#M"
    // (must be "SoloPlayer#", not "SoloPlayer+PlayerLoader#" — that's the
    // loading screen before gameplay actually starts).
    if let Some(rest) = msg.strip_prefix("📺 ") {
        if let Some(idx) = rest.find(" entered ") {
            if rest[idx + " entered ".len()..].starts_with("SoloPlayer#") {
                return LazerEvent::EnteredSoloPlayer;
            }
        } else if let Some(idx) = rest.find(" exit from ") {
            if rest[idx + " exit from ".len()..].starts_with("SoloPlayer#") {
                return LazerEvent::ExitedSoloPlayer;
            }
        }
    }
    LazerEvent::Unrecognized
}

/// Newest `*.runtime.log` in `dir` by mtime, if any.
pub fn newest_runtime_log(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(".runtime.log"))
        })
        .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
}

/// Pull every complete (`\n`-terminated) line out of `partial`, leaving any
/// trailing fragment for the next read. Shared by the live tail and the tests.
fn drain_lines(partial: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(nl) = partial.iter().position(|&b| b == b'\n') {
        let line: Vec<u8> = partial.drain(..=nl).collect();
        // logs are UTF-8; be lossy rather than drop a line on a stray byte.
        lines.push(String::from_utf8_lossy(&line).trim_end().to_string());
    }
    lines
}

/// A held-open tail over one file. Reads only newly-appended bytes per `poll`
/// with a single `read` syscall (no re-open/stat/seek), which is the lowest-
/// latency way to notice an append once the OS has flushed it.
struct Tail {
    file: File,
    partial: Vec<u8>,
    buf: Vec<u8>,
}

impl Tail {
    /// Open `path`; if `from_eof`, skip existing content (start at end).
    fn open(path: &Path, from_eof: bool) -> std::io::Result<Self> {
        let mut file = File::open(path)?;
        if from_eof {
            file.seek(SeekFrom::End(0))?;
        }
        Ok(Self {
            file,
            partial: Vec::new(),
            buf: vec![0u8; 64 * 1024],
        })
    }

    /// Drain all bytes appended since the last call into complete lines. A held
    /// handle at EOF simply returns 0 until more is written, then returns the new
    /// bytes without any seek.
    fn poll(&mut self) -> std::io::Result<Vec<String>> {
        loop {
            let n = self.file.read(&mut self.buf)?;
            if n == 0 {
                break;
            }
            self.partial.extend_from_slice(&self.buf[..n]);
            if n < self.buf.len() {
                break;
            }
        }
        Ok(drain_lines(&mut self.partial))
    }
}

/// Incrementally read whole lines appended to `path` past `offset` (re-opening
/// each call). Retained for the tail-behaviour test; the live loop uses `Tail`.
#[cfg(test)]
fn read_new_lines(
    path: &Path,
    offset: &mut u64,
    partial: &mut Vec<u8>,
) -> std::io::Result<Vec<String>> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    if len < *offset {
        *offset = 0;
        partial.clear();
    }
    f.seek(SeekFrom::Start(*offset))?;
    let mut buf = Vec::new();
    let n = f.read_to_end(&mut buf)?;
    *offset += n as u64;
    partial.extend_from_slice(&buf);
    Ok(drain_lines(partial))
}

/// Emitted on every gameplay start — the session's first start AND every
/// resume after a pause. `audio_zero` is the wall-clock instant song position
/// 0 occurs, already resume-adjusted; the frontend/lib.rs use it as-is, no
/// further lead-in math needed. `lead_in_ms` is `Some` only for the very
/// first start of a session (there's no lead-in count-in on a resume).
#[derive(Debug, Clone)]
pub struct StartSignal {
    pub artist: String,
    pub title: String,
    pub difficulty: String,
    pub audio_zero: SystemTime,
    pub lead_in_ms: Option<i64>,
}

/// Emitted when the game-wide working beatmap changes (song select / preview /
/// the map about to be played). Identity only — no timing. The frontend uses it
/// to jump to whatever the player currently has picked.
#[derive(Debug, Clone)]
pub struct SelectSignal {
    pub artist: String,
    pub title: String,
    pub difficulty: String,
}

/// What the follower hands to its sink. `Select` fires on every song pick;
/// `Start`/`Stop` mirror gameplay beginning and ending.
#[derive(Debug)]
pub enum LiveSignal {
    Select(SelectSignal),
    Start(StartSignal),
    Stop,
}

/// One "SoloPlayer" gameplay session, from entering the play screen to
/// exiting it. Multiple Start/Stop pairs can happen within one session
/// (pause/resume) — only the session's first Start uses the lead-in; later
/// ones resume from wherever the clock was frozen at the last Stop.
struct PlaySession {
    artist: String,
    title: String,
    difficulty: String,
    /// wall-clock instant at which song position 0 occurs, recomputed on
    /// every Start (lead-in based the first time, resume-based after).
    audio_zero: SystemTime,
    /// song position (ms) frozen at the last Stop. Negative means still in
    /// the lead-in (position 0 hadn't been reached yet). `None` until the
    /// session has been paused at least once.
    paused_position_ms: Option<f64>,
}

/// Holds cross-line state (last working beatmap, pending lead-in, the current
/// play session) and turns the event stream into log lines plus
/// `LiveSignal`s. Public + separately testable so it doesn't need a live tail
/// to exercise. Only one `PlaySession` exists at a time, so there's never any
/// ambiguity about which play is currently live.
#[derive(Default)]
pub struct Follower {
    current: Option<(String, String, String, String)>, // artist, title, creator, difficulty
    lead_in_ms: Option<i64>, // pending lead-in for the next session's first start
    session: Option<PlaySession>,
}

impl Follower {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one event. `ts` is the line's (±1s) embedded timestamp, kept only
    /// for display; `wall_now` is a wall-clock sample taken when the line was
    /// read. Returns a `LiveSignal` when gameplay starts or stops.
    pub fn handle(
        &mut self,
        event: LazerEvent,
        ts: Option<&str>,
        wall_now: SystemTime,
    ) -> Option<LiveSignal> {
        let at = ts.unwrap_or("(unknown time)");
        match event {
            LazerEvent::WorkingBeatmap {
                artist,
                title,
                creator,
                difficulty,
            } => {
                // osu! can log a repeat "working beatmap" line for the map
                // that's already selected (e.g. re-entering song select); skip
                // the clone + emit + frontend rebuild when nothing changed.
                let unchanged = self
                    .current
                    .as_ref()
                    .is_some_and(|(a, t, c, d)| *a == artist && *t == title && *c == creator && *d == difficulty);
                if unchanged {
                    return None;
                }
                info!("♪ Selected: {artist} - {title} [{difficulty}] (mapper: {creator})");
                let signal = LiveSignal::Select(SelectSignal {
                    artist: artist.clone(),
                    title: title.clone(),
                    difficulty: difficulty.clone(),
                });
                self.current = Some((artist, title, creator, difficulty));
                Some(signal)
            }
            LazerEvent::LeadIn(ms) => {
                self.lead_in_ms = Some(ms);
                None
            }
            LazerEvent::EnteredSoloPlayer => {
                // a new play is beginning; drop anything left over from a
                // prior session that didn't clean up (e.g. a crash).
                self.session = None;
                None
            }
            LazerEvent::GameplayStarted => {
                let Some((artist, title, _, difficulty)) = self.current.clone() else {
                    return None; // no known beatmap to attach a session to
                };
                let paused_ms = self.session.as_ref().and_then(|s| s.paused_position_ms);
                let (audio_zero, lead_in_ms) = match paused_ms {
                    Some(ms) if ms >= 0.0 => {
                        // resume: shift audio-zero back so the frozen position lands at "now"
                        (
                            wall_now
                                .checked_sub(Duration::from_millis(ms as u64))
                                .unwrap_or(wall_now),
                            None,
                        )
                    }
                    Some(ms) => {
                        // paused during the lead-in (position still negative): the
                        // remaining count-in still applies on resume
                        (wall_now + Duration::from_millis((-ms) as u64), None)
                    }
                    None => {
                        // first start of a new session
                        let lead = self.lead_in_ms.take();
                        (
                            wall_now + Duration::from_millis(lead.unwrap_or(0).unsigned_abs()),
                            lead,
                        )
                    }
                };
                self.session = Some(PlaySession {
                    artist: artist.clone(),
                    title: title.clone(),
                    difficulty: difficulty.clone(),
                    audio_zero,
                    paused_position_ms: None,
                });
                let kind = if paused_ms.is_some() { "Resumed" } else { "Playing" };
                let lead = match lead_in_ms {
                    Some(ms) => format!("lead-in {ms} ms → audio onset +{} ms", ms.unsigned_abs()),
                    None => "resuming from pause".into(),
                };
                info!("▶ {kind}: {artist} - {title} [{difficulty}] — clock start ~{at} (±1s); {lead}");
                Some(LiveSignal::Start(StartSignal {
                    artist,
                    title,
                    difficulty,
                    audio_zero,
                    lead_in_ms,
                }))
            }
            LazerEvent::GameplayStopped => {
                if let Some(session) = &mut self.session {
                    let position_ms = match wall_now.duration_since(session.audio_zero) {
                        Ok(d) => d.as_secs_f64() * 1000.0,
                        Err(e) => -(e.duration().as_secs_f64() * 1000.0),
                    };
                    session.paused_position_ms = Some(position_ms);
                    info!(
                        "⏹ Clock stopped: {} - {} [{}] at {at} (pause or end — position {position_ms:.0}ms)",
                        session.artist, session.title, session.difficulty
                    );
                }
                Some(LiveSignal::Stop)
            }
            LazerEvent::ExitedSoloPlayer => {
                self.session = None;
                None
            }
            LazerEvent::Unrecognized => None,
        }
    }
}

/// How often we check the current log for appended bytes. Kept tight so the
/// monotonic instant we stamp on a gameplay-start line lands within ~1ms of the
/// flush. Each tick is a single `read` syscall on an already-open handle that
/// returns 0 when nothing is pending, so this is cheap even at 1kHz.
const POLL: Duration = Duration::from_millis(1);
/// Scanning the directory for a newer session file is heavier than a `read`, and
/// osu only rotates on relaunch, so we do it far less often than `POLL`.
const ROTATE_CHECK: Duration = Duration::from_millis(500);

/// Follow the newest runtime.log in `dir` forever, driving a `Follower`. Blocks;
/// meant to be run on a dedicated thread. Starts at EOF of the current newest
/// file (history is ignored) and switches to any fresher session file that
/// appears, reading such a new file from its start.
///
/// Uses a tight poll on a held-open handle rather than filesystem notifications.
/// `bench_detection_latency` measured both on macOS: the 1ms `read` poll notices
/// an append in ~0.2ms median (sub-ms p95), while `notify` (FSEvents) coalesces
/// per-append writes so aggressively it missed 299/300 and delivered the one hit
/// 5s late. FSEvents is directory-granular and wrong for a single hot log; the
/// poll costs only one `read` syscall per ms (returns 0 when idle).
///
/// `on_signal` is invoked (on this thread) for each gameplay start/stop, so the
/// caller can e.g. tell the app's frontend to play the same song in sync.
pub fn follow_forever(dir: &Path, mut on_signal: impl FnMut(LiveSignal)) -> ! {
    let mut current: Option<PathBuf> = None;
    let mut tail: Option<Tail> = None;
    let mut follower = Follower::new();
    let mut last_rotate_check = Instant::now() - ROTATE_CHECK; // force an immediate check

    loop {
        // Occasionally look for a newer session file (osu relaunched) or the
        // first one if none exists yet.
        if last_rotate_check.elapsed() >= ROTATE_CHECK {
            last_rotate_check = Instant::now();
            if let Some(newest) = newest_runtime_log(dir) {
                if current.as_ref() != Some(&newest) {
                    // The very first file we attach to: skip history (start at
                    // EOF). A later session file: read it from the top.
                    let from_eof = current.is_none();
                    match Tail::open(&newest, from_eof) {
                        Ok(t) => {
                            info!("tailing lazer runtime log: {}", newest.display());
                            tail = Some(t);
                            current = Some(newest);
                        }
                        Err(e) => warn!("opening {}: {e}", newest.display()),
                    }
                }
            } else if current.is_none() {
                warn!("no *.runtime.log yet in {}", dir.display());
            }
        }

        if let Some(t) = &mut tail {
            match t.poll() {
                // Stamp before parsing, so our own work doesn't push it later.
                Ok(lines) if !lines.is_empty() => {
                    let wall_now = SystemTime::now();
                    for line in lines {
                        if let Some(sig) =
                            follower.handle(parse_line(&line), split_line(&line).0, wall_now)
                        {
                            on_signal(sig);
                        }
                    }
                }
                Ok(_) => {}
                Err(e) => {
                    warn!("reading log: {e}");
                    tail = None;
                    current = None; // force reattach on next rotate check
                }
            }
        }

        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parses_working_beatmap() {
        let line = "2026-07-06 07:37:37 [verbose]: Game-wide working beatmap updated to NOMA - Brain Power (Akasha-) [7K EXHAUST]";
        assert_eq!(
            parse_line(line),
            LazerEvent::WorkingBeatmap {
                artist: "NOMA".into(),
                title: "Brain Power".into(),
                creator: "Akasha-".into(),
                difficulty: "7K EXHAUST".into(),
            }
        );
    }

    #[test]
    fn parses_working_beatmap_with_tricky_creator() {
        // creator "nyu -" contains a dash and a trailing space before ')'
        let line = "2026-07-06 07:43:17 [verbose]: Game-wide working beatmap updated to Kikuo - Aishite Aishite Aishite (nyu -) [ApplePie's Normal]";
        assert_eq!(
            parse_line(line),
            LazerEvent::WorkingBeatmap {
                artist: "Kikuo".into(),
                title: "Aishite Aishite Aishite".into(),
                creator: "nyu -".into(),
                difficulty: "ApplePie's Normal".into(),
            }
        );
    }

    #[test]
    fn parses_clock_events() {
        assert_eq!(
            parse_line("2026-07-06 07:59:07 [verbose]: GameplayClockContainer seeking to -1830"),
            LazerEvent::LeadIn(-1830)
        );
        assert_eq!(
            parse_line(
                "2026-07-06 07:59:07 [verbose]: GameplayClockContainer started via call to StartGameplayClock"
            ),
            LazerEvent::GameplayStarted
        );
        assert_eq!(
            parse_line(
                "2026-07-06 07:59:31 [verbose]: GameplayClockContainer stopped via call to StopGameplayClock"
            ),
            LazerEvent::GameplayStopped
        );
    }

    #[test]
    fn parses_solo_player_screen_transitions() {
        assert_eq!(
            parse_line("2026-07-06 19:31:18 [verbose]: 📺 OsuScreenStack#408(depth:6) entered SoloPlayer#497"),
            LazerEvent::EnteredSoloPlayer
        );
        assert_eq!(
            parse_line("2026-07-06 19:32:19 [verbose]: 📺 OsuScreenStack#408(depth:5) exit from SoloPlayer#497"),
            LazerEvent::ExitedSoloPlayer
        );
        // the loading screen before gameplay actually starts — must not be
        // mistaken for the real SoloPlayer screen.
        assert_eq!(
            parse_line("2026-07-06 19:51:59 [verbose]: 📺 OsuScreenStack#408(depth:5) entered SoloSongSelect+PlayerLoader#633"),
            LazerEvent::Unrecognized
        );
    }

    #[test]
    fn tracks_pause_and_resume_within_one_session() {
        let mut f = Follower::new();
        let t0 = SystemTime::now();

        f.handle(
            LazerEvent::WorkingBeatmap {
                artist: "A".into(),
                title: "T".into(),
                creator: "C".into(),
                difficulty: "D".into(),
            },
            None,
            t0,
        );
        f.handle(LazerEvent::EnteredSoloPlayer, None, t0);
        f.handle(LazerEvent::LeadIn(-1000), None, t0);

        let start1 = match f.handle(LazerEvent::GameplayStarted, None, t0) {
            Some(LiveSignal::Start(s)) => s,
            other => panic!("expected Start, got {other:?}"),
        };
        assert_eq!(start1.lead_in_ms, Some(-1000));
        assert_eq!(start1.audio_zero.duration_since(t0).unwrap().as_millis(), 1000);

        // 3s into the song (1s lead-in + 3s played), pause for 10 real seconds
        let t_pause = t0 + Duration::from_millis(4000);
        assert!(matches!(
            f.handle(LazerEvent::GameplayStopped, None, t_pause),
            Some(LiveSignal::Stop)
        ));
        let t_resume = t_pause + Duration::from_secs(10);
        let start2 = match f.handle(LazerEvent::GameplayStarted, None, t_resume) {
            Some(LiveSignal::Start(s)) => s,
            other => panic!("expected Start, got {other:?}"),
        };
        assert_eq!(start2.lead_in_ms, None, "a resume has no lead-in count-in");
        // resumes 3000ms into the song, so audio_zero shifts to t0+11000ms
        assert_eq!(start2.audio_zero.duration_since(t0).unwrap().as_millis(), 11000);

        // end this play entirely
        let t_end = t_resume + Duration::from_secs(5);
        f.handle(LazerEvent::GameplayStopped, None, t_end);
        f.handle(LazerEvent::ExitedSoloPlayer, None, t_end);

        // a brand new session must not inherit the old paused position
        let t2 = t_end + Duration::from_secs(20);
        f.handle(LazerEvent::EnteredSoloPlayer, None, t2);
        let start3 = match f.handle(LazerEvent::GameplayStarted, None, t2) {
            Some(LiveSignal::Start(s)) => s,
            other => panic!("expected Start, got {other:?}"),
        };
        assert_eq!(start3.audio_zero, t2, "fresh session, no lead-in, no stale pause state");
    }

    #[test]
    fn ignores_noise_and_header() {
        assert_eq!(
            parse_line("runtime Log (LogLevel: Verbose)"),
            LazerEvent::Unrecognized
        );
        assert_eq!(
            parse_line("2026-07-06 07:37:36 [verbose]: Loaded RealmDetachedBeatmapStore!"),
            LazerEvent::Unrecognized
        );
    }

    #[test]
    fn split_line_extracts_timestamp() {
        let (ts, msg) = split_line("2026-07-06 07:59:07 [verbose]: GameplayClockContainer started");
        assert_eq!(ts, Some("2026-07-06 07:59:07"));
        assert_eq!(msg, "GameplayClockContainer started");
    }

    #[test]
    fn read_new_lines_tails_appends() {
        let dir = std::env::temp_dir().join(format!("osu_diff_tail_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.runtime.log");
        std::fs::write(&path, b"first\n").unwrap();

        let mut offset = 0u64;
        let mut partial = Vec::new();
        let l = read_new_lines(&path, &mut offset, &mut partial).unwrap();
        assert_eq!(l, vec!["first".to_string()]);

        // append a full line plus a partial (no trailing newline yet)
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            f.write_all(b"second\nthi").unwrap();
        }
        let l = read_new_lines(&path, &mut offset, &mut partial).unwrap();
        assert_eq!(l, vec!["second".to_string()]);

        // finish the partial line
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            f.write_all(b"rd\n").unwrap();
        }
        let l = read_new_lines(&path, &mut offset, &mut partial).unwrap();
        assert_eq!(l, vec!["third".to_string()]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tail_reads_only_appends_from_eof() {
        let dir = std::env::temp_dir().join(format!("osu_diff_tail2_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.runtime.log");
        std::fs::write(&path, b"history line\n").unwrap();

        // from_eof: existing content is skipped.
        let mut tail = Tail::open(&path, true).unwrap();
        assert!(tail.poll().unwrap().is_empty());

        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            f.write_all(b"new line\n").unwrap();
        }
        assert_eq!(tail.poll().unwrap(), vec!["new line".to_string()]);

        std::fs::remove_dir_all(&dir).ok();
    }

    // Latency comparison: raw held-handle poll vs the `notify` crate. Ignored by
    // default (spawns threads and takes ~seconds). Run with:
    //   cargo test bench_detection_latency -- --ignored --nocapture
    #[test]
    #[ignore = "latency benchmark; run with --ignored --nocapture"]
    fn bench_detection_latency() {
        use std::sync::mpsc;
        use std::time::Instant;

        const N: usize = 300;
        const GAP: Duration = Duration::from_millis(15);

        fn stats(mut v: Vec<f64>) -> String {
            if v.is_empty() {
                return "no samples".to_string();
            }
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let n = v.len();
            let mean = v.iter().sum::<f64>() / n as f64;
            let pct = |p: f64| v[((n as f64 * p) as usize).min(n - 1)];
            format!(
                "min {:.2}  median {:.2}  p95 {:.2}  max {:.2}  mean {:.2}  (ms, n={n})",
                v[0],
                pct(0.50),
                pct(0.95),
                v[n - 1],
                mean
            )
        }

        // Spawn a writer that appends one line every GAP, sending the pre-write
        // Instant so a detector can compute write->detect latency.
        fn spawn_writer(path: &Path) -> (std::thread::JoinHandle<()>, mpsc::Receiver<Instant>) {
            let (tx, rx) = mpsc::channel();
            let p = path.to_path_buf();
            let h = std::thread::spawn(move || {
                let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
                for i in 0..N {
                    std::thread::sleep(GAP);
                    let t = Instant::now();
                    writeln!(f, "2026-07-06 07:59:07 [verbose]: bench line {i}").unwrap();
                    f.flush().unwrap();
                    tx.send(t).unwrap();
                }
            });
            (h, rx)
        }

        let dir = std::env::temp_dir().join(format!("osu_diff_bench_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        println!("\n=== append detection latency (write -> observed), n={N} ===");

        // --- Raw held-handle poll @ 1ms ---
        {
            let path = dir.join("poll.runtime.log");
            std::fs::write(&path, b"").unwrap();
            let mut tail = Tail::open(&path, true).unwrap();
            let (writer, rx) = spawn_writer(&path);
            let mut lat = Vec::with_capacity(N);
            for _ in 0..N {
                let t_write = rx.recv().unwrap();
                loop {
                    if !tail.poll().unwrap().is_empty() {
                        lat.push(Instant::now().duration_since(t_write).as_secs_f64() * 1000.0);
                        break;
                    }
                    std::thread::sleep(POLL);
                }
            }
            writer.join().unwrap();
            println!("raw poll @1ms : {}", stats(lat));
        }

        // --- notify crate (FSEvents on macOS) ---
        // Watch the *directory* (FSEvents is directory-granular) and gate on the
        // file actually growing. recv_timeout keeps a missed/coalesced event from
        // deadlocking the run — a miss is recorded as a drop rather than hanging.
        {
            use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
            let path = dir.join("notify.runtime.log");
            std::fs::write(&path, b"").unwrap();
            let (ev_tx, ev_rx) = mpsc::channel();
            let mut watcher = RecommendedWatcher::new(ev_tx, Config::default()).unwrap();
            watcher.watch(&dir, RecursiveMode::NonRecursive).unwrap();
            let (writer, rx) = spawn_writer(&path);
            let mut last_len = 0u64;
            let mut lat = Vec::with_capacity(N);
            let mut drops = 0usize;
            for _ in 0..N {
                let t_write = rx.recv().unwrap();
                let deadline = Instant::now() + Duration::from_millis(500);
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match ev_rx.recv_timeout(remaining) {
                        Ok(_) => {
                            let len = std::fs::metadata(&path)
                                .map(|m| m.len())
                                .unwrap_or(last_len);
                            if len > last_len {
                                last_len = len;
                                lat.push(
                                    Instant::now().duration_since(t_write).as_secs_f64() * 1000.0,
                                );
                                break;
                            }
                        }
                        Err(_) => {
                            drops += 1;
                            break;
                        }
                    }
                }
            }
            writer.join().unwrap();
            println!(
                "notify crate  : {}   [missed/timed-out: {drops}]",
                stats(lat)
            );
        }

        std::fs::remove_dir_all(&dir).ok();
    }
}
