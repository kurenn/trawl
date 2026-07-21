//! rclone integration — shells out to the rclone CLI (v1.74+).
//!
//! Design: NO rc daemon. All sync calls use std::process::Command; the streaming
//! copy uses tokio::process::Command so we can read stderr line-by-line without
//! blocking the async executor.
//!
//! rclone fs connection strings used throughout:
//!   folder_id     → "<remote>,root_folder_id=<ID>:"
//!   shared_with_me→ "<remote>,shared_with_me=true:"
//! Append ",acknowledge_abuse=true" (before the colon) when the mapping requests it.
//! The subpath follows the colon: "<fs>:<subpath>".

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::models::{
    ConnectionPhase, ConnectionState, FolderNode, ListSourceArgs, Mapping, MappingStatus,
    RunLogKind, RunLogLine, RunProgress, SourceKind, RUN_UPDATE_EVENT,
};

// ---------------------------------------------------------------------------
// Drive folder ID charset — Drive IDs are [A-Za-z0-9_-]
// ---------------------------------------------------------------------------
fn is_valid_drive_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

// ---------------------------------------------------------------------------
// Build the rclone "fs" (connection-string) portion that precedes the colon.
// Examples:
//   build_fs("gdrive", SourceKind::FolderId, Some("1abc_XYZ"), false, false)
//     → Ok("gdrive,root_folder_id=1abc_XYZ")
//   build_fs("gdrive", SourceKind::SharedWithMe, None, true, true)
//     → Ok("gdrive,shared_with_me=true,acknowledge_abuse=true,skip_shortcuts=true")
// ---------------------------------------------------------------------------
fn build_fs(
    remote: &str,
    kind: SourceKind,
    source_id: Option<&str>,
    acknowledge_abuse: bool,
    skip_shortcuts: bool,
) -> Result<String, String> {
    let mut fs = match kind {
        SourceKind::FolderId => {
            let id = source_id.unwrap_or("").trim();
            if !is_valid_drive_id(id) {
                return Err(format!(
                    "Invalid Drive folder ID '{}'. Expected characters: A-Z a-z 0-9 _ -",
                    id
                ));
            }
            format!("{},root_folder_id={}", remote, id)
        }
        SourceKind::SharedWithMe => {
            format!("{},shared_with_me=true", remote)
        }
    };
    if acknowledge_abuse {
        fs.push_str(",acknowledge_abuse=true");
    }
    // Ignore Google Drive shortcuts. A shortcut that points back to an ancestor
    // folder makes rclone recurse forever (a folder loop); skipping shortcuts
    // breaks the cycle while still copying all real files.
    if skip_shortcuts {
        fs.push_str(",skip_shortcuts=true");
    }
    Ok(fs)
}

// ---------------------------------------------------------------------------
// 1. detect_connection
// ---------------------------------------------------------------------------

/// Probe rclone to find a configured Google Drive remote.
///
/// - Runs `rclone listremotes --long` (non-interactive, fast).
/// - Returns Connected if the named remote (or any drive-type) exists.
/// - Returns Disconnected if rclone runs but has no drive remote.
/// - Returns Error if the rclone binary is absent or crashes.
pub fn detect_connection(remote: &str) -> ConnectionState {
    // `rclone listremotes --long` outputs lines like:
    //   gdrive:  drive
    //   s3:      s3
    let output = match Command::new("rclone").args(["listremotes", "--long"]).output() {
        Ok(o) => o,
        Err(e) => {
            let msg = if e.kind() == std::io::ErrorKind::NotFound {
                "rclone not found — install rclone".to_string()
            } else {
                format!("rclone not found — install rclone ({})", e)
            };
            return ConnectionState {
                phase: ConnectionPhase::Error,
                remote: remote.to_string(),
                error: Some(msg),
            };
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return ConnectionState {
            phase: ConnectionPhase::Error,
            remote: remote.to_string(),
            error: Some(friendly_error(&stderr)),
        };
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    // Parse "name:  type" lines. rclone uses at least one space + optional trailing spaces.
    let mut first_drive: Option<String> = None;
    let mut exact_match = false;

    for line in stdout.lines() {
        // Lines are "<name>:<spaces><type>" — split on first ':'
        let mut parts = line.splitn(2, ':');
        let name = match parts.next() {
            Some(n) => n.trim().to_string(),
            None => continue,
        };
        let type_str = parts.next().unwrap_or("").trim();

        if type_str == "drive" {
            if first_drive.is_none() {
                first_drive = Some(name.clone());
            }
            if name == remote {
                exact_match = true;
            }
        }
    }

    match (exact_match, first_drive) {
        (true, _) => ConnectionState {
            phase: ConnectionPhase::Connected,
            remote: remote.to_string(),
            error: None,
        },
        (false, Some(alt)) => ConnectionState {
            phase: ConnectionPhase::Connected,
            remote: alt,
            error: None,
        },
        (false, None) => ConnectionState {
            phase: ConnectionPhase::Disconnected,
            remote: remote.to_string(),
            error: None,
        },
    }
}

// ---------------------------------------------------------------------------
// 2. connect_drive
// ---------------------------------------------------------------------------

/// Launch `rclone config create <remote> drive` which opens the system browser
/// for OAuth and writes the token to rclone's config file.
///
/// Inherits stdio so the interactive OAuth prompt/callback can proceed.
/// Blocks until rclone exits (the user completes the flow).
pub fn connect_drive(remote: &str) -> ConnectionState {
    // `rclone config create <name> type` — inherits stdio so OAuth can open browser
    let status = Command::new("rclone")
        .args(["config", "create", remote, "drive"])
        .status();

    match status {
        Ok(s) if s.success() => detect_connection(remote),
        Ok(s) => ConnectionState {
            phase: ConnectionPhase::Error,
            remote: remote.to_string(),
            error: Some(format!(
                "rclone config failed (exit {}). Re-run connection setup.",
                s.code().unwrap_or(-1)
            )),
        },
        Err(e) => {
            let msg = if e.kind() == std::io::ErrorKind::NotFound {
                "rclone not found — install rclone".to_string()
            } else {
                format!("rclone not found — install rclone ({})", e)
            };
            ConnectionState {
                phase: ConnectionPhase::Error,
                remote: remote.to_string(),
                error: Some(msg),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 3. list_source_folders
// ---------------------------------------------------------------------------

/// Serde shape for one entry from `rclone lsjson`.
#[derive(Deserialize)]
struct LsJsonEntry {
    #[serde(rename = "Path")]
    path: String,
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "IsDir", default)]
    is_dir: bool,
}

/// List immediate child directories of the given source location.
///
/// Uses `rclone lsjson "<fs>:<subpath>" --dirs-only` (no recursion).
/// has_children is conservatively set to `true` for every dir because lsjson
/// doesn't cheaply report grandchildren — the UI will reveal "no subfolders"
/// on expand if the next level is empty.
pub fn list_source_folders(remote: &str, args: &ListSourceArgs) -> Result<Vec<FolderNode>, String> {
    let source_id = args.source_id.as_deref();
    // Listing/browsing follows shortcuts normally; skip_shortcuts only matters
    // for the recursive copy, where a shortcut loop would otherwise recurse.
    let fs = build_fs(remote, args.kind, source_id, false, false)?;

    // Build the rclone target: "<fs>:<subpath>"
    // Command args are NOT shell-interpreted, so we compose the full path as a
    // single string argument — no injection risk.
    let target = format!("{}:{}", fs, args.subpath);

    let output = Command::new("rclone")
        .args([
            "lsjson",
            &target,
            "--dirs-only", // list directories only
            "--no-modtime", // skip mtime fetch for speed
        ])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "rclone not found — install rclone".to_string()
            } else {
                friendly_error(&e.to_string())
            }
        })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(friendly_error(&stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries: Vec<LsJsonEntry> =
        serde_json::from_str(&stdout).map_err(|e| format!("Failed to parse rclone output: {}", e))?;

    let mut nodes: Vec<FolderNode> = entries
        .into_iter()
        .filter(|e| e.is_dir)
        .map(|e| {
            // Build the relative path from the source root.
            // If we're at the root (subpath is empty) the path IS the name.
            // Otherwise prefix the current subpath.
            let path = if args.subpath.is_empty() {
                e.path.clone()
            } else {
                // Normalise: strip trailing slash from subpath just in case.
                format!("{}/{}", args.subpath.trim_end_matches('/'), e.path)
            };
            FolderNode {
                path,
                name: e.name,
                has_children: true, // conservative — expand reveals emptiness
            }
        })
        .collect();

    nodes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(nodes)
}

// ---------------------------------------------------------------------------
// 4. resolve_source_name
// ---------------------------------------------------------------------------

/// Serde shape for `rclone lsjson --stat` (single-entry array or object).
/// rclone v1.74 --stat returns the directory entry itself as a JSON array
/// with one element. We reuse LsJsonEntry.
#[derive(Deserialize)]
struct LsStatEntry {
    #[serde(rename = "Name")]
    name: String,
}

/// Best-effort human display name for a source root. Never errors.
///
/// Returns an EMPTY string when the name can't be resolved — note that for a
/// `root_folder_id` remote, rclone's `--stat` reports an empty Name for the
/// root itself (the folder has no name *within* the remote), so this commonly
/// can't determine the pasted folder's own name. Callers treat "" as "unknown"
/// and fall back to a sensible label (e.g. the destination folder name).
pub fn resolve_source_name(remote: &str, kind: SourceKind, source_id: Option<&str>) -> String {
    match kind {
        SourceKind::SharedWithMe => "Shared with me".to_string(),
        SourceKind::FolderId => {
            let id = source_id.unwrap_or("").trim();
            if !is_valid_drive_id(id) {
                return String::new();
            }
            let fs = format!("{},root_folder_id={}:", remote, id);
            let result = Command::new("rclone")
                .args(["lsjson", &fs, "--stat", "--no-modtime"])
                .output();

            if let Ok(out) = result {
                if out.status.success() {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    // `--stat` may return either a single object or a 1-element
                    // array depending on rclone version — try both.
                    if let Ok(e) = serde_json::from_str::<LsStatEntry>(&stdout) {
                        if !e.name.is_empty() {
                            return e.name;
                        }
                    }
                    if let Ok(mut v) = serde_json::from_str::<Vec<LsStatEntry>>(&stdout) {
                        if let Some(e) = v.pop() {
                            if !e.name.is_empty() {
                                return e.name;
                            }
                        }
                    }
                }
            }
            String::new()
        }
    }
}

// ---------------------------------------------------------------------------
// 5. run_sync (async, streaming)
// ---------------------------------------------------------------------------

/// Serde shapes for rclone's --use-json-log output.
///
/// rclone emits one JSON object per line to stderr. Two main shapes:
///
/// Stats line (level "notice", msg contains "Transferred:" or object is empty):
///   { "level":"notice", "msg":"Transferred: ...", "stats": { "bytes":…, "totalBytes":…,
///     "transfers":…, "totalTransfers":…, "speed":…, "eta":… } }
///
/// Log line:
///   { "level":"info"|"notice"|"error"|"warning",
///     "msg":"some message", "object":"optional/path" }
///
/// We decode into a single flexible struct.
#[derive(Deserialize, Default)]
struct RcloneJsonLine {
    #[serde(default)]
    level: String,
    #[serde(default)]
    msg: String,
    #[serde(default)]
    object: String,
    #[serde(default)]
    stats: Option<RcloneStats>,
}

#[derive(Deserialize, Default, Clone)]
struct RcloneStats {
    #[serde(default)]
    bytes: i64,
    #[serde(rename = "totalBytes", default)]
    total_bytes: i64,
    #[serde(default)]
    transfers: i64,
    #[serde(rename = "totalTransfers", default)]
    total_transfers: i64,
    #[serde(default)]
    speed: f64,
    #[serde(default)]
    eta: Option<f64>,
    /// rclone reports the running error count here. Per the product spec a run
    /// is only "succeeded" when errors == 0, so we track the max seen.
    #[serde(default)]
    errors: i64,
}

/// A running rclone job: the child process plus a cancel flag set by `cancel()`.
/// Keeping the flag alongside the child lets `run_sync` distinguish a real
/// cancellation from a normal completion that merely raced with a late cancel.
pub struct Job {
    /// rclone child process (gdrive). None for the pCloud engine, which has no
    /// subprocess and cooperatively checks `cancel` between files.
    pub child: Option<Child>,
    /// Shared cancel flag — set by `cancel()`, observed by both engines.
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
}

/// Maximum log lines kept in the progress snapshot sent to the UI.
const MAX_LOG_LINES: usize = 50;

/// Hard cap on a single log line's length (defends against a maliciously huge
/// Drive object name blowing up the JSON-log line / the UI payload).
const MAX_LOG_LINE_CHARS: usize = 400;

/// Throttle: minimum gap between emitted progress events (milliseconds).
const EMIT_INTERVAL_MS: u64 = 300;

/// Run `rclone copy` for a single mapping, streaming progress events to the
/// Tauri frontend via the RUN_UPDATE_EVENT channel.
///
/// # Arguments
/// - `app`       — Tauri AppHandle for `app.emit(…)`.
/// - `jobs`      — Shared map of active Child processes, keyed by run_id.
/// - `remote`    — rclone remote name (e.g. "gdrive").
/// - `mapping`   — The saved mapping to execute.
/// - `dest_abs`  — Absolute filesystem path for the destination.
/// - `run_id`    — Unique ID for this run (monotonic i64 from the commands layer).
pub async fn run_sync(
    app: tauri::AppHandle,
    jobs: Arc<Mutex<HashMap<i64, Job>>>,
    remote: String,
    mapping: Mapping,
    dest_abs: PathBuf,
    run_id: i64,
) -> RunProgress {
    // ---------- build rclone source fs ----------
    let fs = match build_fs(
        &remote,
        mapping.source_kind,
        mapping.source_id.as_deref(),
        mapping.acknowledge_abuse,
        mapping.skip_shortcuts,
    ) {
        Ok(f) => f,
        Err(e) => {
            let progress = RunProgress {
                run_id,
                mapping_id: mapping.id.clone(),
                name: mapping.source_name.clone(),
                src: String::new(),
                dest: dest_abs.display().to_string(),
                status: MappingStatus::Failed,
                bytes_done: 0,
                bytes_total: 0,
                files_done: 0,
                files_total: 0,
                speed: 0.0,
                eta_sec: 0.0,
                log: vec![RunLogLine {
                    text: e,
                    kind: RunLogKind::Error,
                }],
            };
            let _ = app.emit(RUN_UPDATE_EVENT, &progress);
            return progress;
        }
    };

    let src_label = format!("{}:{}", fs, mapping.source_subpath);
    let dest_str = dest_abs.display().to_string();

    // ---------- ensure destination directory exists ----------
    // Pre-flight: clear message when the destination volume isn't mounted.
    let dir_result = match crate::store::check_dest_available(&dest_abs) {
        Err(msg) => Err(msg),
        Ok(()) => tokio::fs::create_dir_all(&dest_abs)
            .await
            .map_err(|e| format!("Cannot create destination folder “{}”: {}", dest_str, e)),
    };
    if let Err(msg) = dir_result {
        let progress = RunProgress {
            run_id,
            mapping_id: mapping.id.clone(),
            name: mapping.source_name.clone(),
            src: src_label.clone(),
            dest: dest_str.clone(),
            status: MappingStatus::Failed,
            bytes_done: 0,
            bytes_total: 0,
            files_done: 0,
            files_total: 0,
            speed: 0.0,
            eta_sec: 0.0,
            log: vec![RunLogLine {
                text: msg,
                kind: RunLogKind::Error,
            }],
        };
        let _ = app.emit(RUN_UPDATE_EVENT, &progress);
        return progress;
    }

    // ---------- spawn rclone copy ----------
    // Args:
    //   rclone copy <src> <dest>
    //     --use-json-log        → machine-readable JSON per line on stderr
    //     --stats 1s            → emit stats every second
    //     --stats-log-level NOTICE → stats appear in JSON log stream
    //     --create-empty-src-dirs → mirror empty directories
    //     -v                    → verbose — includes per-file Copied/Failed notices
    let mut child = match tokio::process::Command::new("rclone")
        .args([
            "copy",
            &src_label,
            &dest_str,
            "--use-json-log",
            "--stats",
            "1s",
            "--stats-log-level",
            "NOTICE",
            "--create-empty-src-dirs",
            "-v",
        ])
        .stderr(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null()) // rclone copy sends everything to stderr with --use-json-log
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let msg = if e.kind() == std::io::ErrorKind::NotFound {
                "rclone not found — install rclone".to_string()
            } else {
                friendly_error(&e.to_string())
            };
            let progress = RunProgress {
                run_id,
                mapping_id: mapping.id.clone(),
                name: mapping.source_name.clone(),
                src: src_label.clone(),
                dest: dest_str.clone(),
                status: MappingStatus::Failed,
                bytes_done: 0,
                bytes_total: 0,
                files_done: 0,
                files_total: 0,
                speed: 0.0,
                eta_sec: 0.0,
                log: vec![RunLogLine { text: msg, kind: RunLogKind::Error }],
            };
            let _ = app.emit(RUN_UPDATE_EVENT, &progress);
            return progress;
        }
    };

    // Take stderr before inserting into jobs (Child is moved)
    let stderr = child.stderr.take().expect("stderr was piped");

    // Register child in the shared jobs map so cancel() can kill it.
    // cancel() flips the shared `cancel` flag in place (and kills the child);
    // run_sync stays the sole owner that waits/reaps the child.
    {
        let mut guard = jobs.lock().await;
        guard.insert(
            run_id,
            Job {
                child: Some(child),
                cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            },
        );
    }

    // ---------- stream stderr ----------
    let mut lines = BufReader::new(stderr).lines();

    let mut progress = RunProgress {
        run_id,
        mapping_id: mapping.id.clone(),
        name: mapping.source_name.clone(),
        src: src_label.clone(),
        dest: dest_str.clone(),
        status: MappingStatus::Running,
        bytes_done: 0,
        bytes_total: 0,
        files_done: 0,
        files_total: 0,
        speed: 0.0,
        eta_sec: 0.0,
        log: vec![RunLogLine {
            text: format!("Starting copy: {} → {}", src_label, dest_str),
            kind: RunLogKind::Meta,
        }],
    };

    let _ = app.emit(RUN_UPDATE_EVENT, &progress);

    let mut last_emit = Instant::now();
    let mut error_lines: Vec<String> = Vec::new();
    let mut had_errors = false;
    let mut max_errors: i64 = 0; // highest stats.errors seen (spec: success ⇒ errors == 0)
    // Folder-loop guard: set to the repeated folder name when a source cycle is
    // detected (see runaway_component), which then aborts the run.
    let mut loop_culprit: Option<String> = None;

    while let Ok(Some(line)) = lines.next_line().await {
        let parsed: RcloneJsonLine = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => {
                // Non-JSON line — treat as raw info
                push_log(
                    &mut progress.log,
                    RunLogLine { text: line, kind: RunLogKind::Info },
                );
                continue;
            }
        };

        // ---------- stats update ----------
        if let Some(stats) = &parsed.stats {
            progress.bytes_done = stats.bytes;
            progress.bytes_total = stats.total_bytes;
            progress.files_done = stats.transfers;
            progress.files_total = stats.total_transfers;
            progress.speed = stats.speed;
            progress.eta_sec = stats.eta.unwrap_or(0.0);
            max_errors = max_errors.max(stats.errors);
        }

        // ---------- folder-loop guard ----------
        // A source cycle makes rclone recurse forever, re-copying the same files
        // at ever-deeper paths until the OS path limit — a single run can balloon
        // to hundreds of GB. Catch the repeated-path signature early and hard-kill
        // rclone before that happens. Only the first hit matters.
        if loop_culprit.is_none() {
            if let Some(name) = runaway_component(&parsed.object) {
                loop_culprit = Some(name);
                {
                    let mut guard = jobs.lock().await;
                    if let Some(job) = guard.get_mut(&run_id) {
                        if let Some(child) = job.child.as_mut() {
                            let _ = child.start_kill();
                        }
                    }
                }
                break;
            }
        }

        // ---------- log line ----------
        let (kind, relevant) = classify_log_line(&parsed);
        if relevant {
            let text = format_log_text(&parsed);
            if matches!(kind, RunLogKind::Error) {
                had_errors = true;
                error_lines.push(text.clone());
            }
            // Detect "Copied" → mark as success-flavour
            let actual_kind = if parsed.msg.contains("Copied") || parsed.msg.starts_with("Copied") {
                RunLogKind::Success
            } else {
                kind
            };
            push_log(&mut progress.log, RunLogLine { text, kind: actual_kind });
        }

        // ---------- throttled emit ----------
        let now = Instant::now();
        if now.duration_since(last_emit) >= Duration::from_millis(EMIT_INTERVAL_MS)
            || parsed.stats.is_some()
        {
            let _ = app.emit(RUN_UPDATE_EVENT, &progress);
            last_emit = now;
        }
    }

    // ---------- wait for child ----------
    // Remove the Job from the map (capturing the cancel flag), DROP the guard,
    // then await wait() OUTSIDE the lock so a stalled wait never blocks cancel()
    // or other job registration.
    let (mut child, was_cancelled) = {
        let mut guard = jobs.lock().await;
        match guard.remove(&run_id) {
            Some(job) => (
                job.child,
                job.cancel.load(std::sync::atomic::Ordering::SeqCst),
            ),
            None => (None, false),
        }
    };
    let exit_status = match child.as_mut() {
        Some(c) => c.wait().await.ok(),
        None => None,
    };

    // ---------- finalize status ----------
    // `was_cancelled` is authoritative: cancel() set it BEFORE the stream ended.
    // A cancel that races in after normal completion (child already removed)
    // leaves was_cancelled == false, so a finished run is never mislabeled.
    let final_status = if was_cancelled {
        MappingStatus::Cancelled
    } else if loop_culprit.is_some() {
        // We killed rclone on purpose after detecting a source folder loop.
        MappingStatus::Failed
    } else {
        match exit_status {
            None => MappingStatus::Failed,
            Some(status) if status.success() && !had_errors && max_errors == 0 => {
                MappingStatus::Succeeded
            }
            Some(status) => {
            // Check for 403 abuse-flagged in collected errors
            let stderr_tail = error_lines.join("\n");
            if is_abuse_flagged(&stderr_tail) {
                push_log(
                    &mut progress.log,
                    RunLogLine {
                        text:
                            "403 abuse-flagged file — enable Acknowledge abuse on this mapping"
                                .to_string(),
                        kind: RunLogKind::Error,
                    },
                );
            } else if !error_lines.is_empty() {
                push_log(
                    &mut progress.log,
                    RunLogLine {
                        text: friendly_error(&stderr_tail),
                        kind: RunLogKind::Error,
                    },
                );
            } else {
                push_log(
                    &mut progress.log,
                    RunLogLine {
                        text: format!(
                            "rclone exited with code {}",
                            status.code().unwrap_or(-1)
                        ),
                        kind: RunLogKind::Error,
                    },
                );
            }
                MappingStatus::Failed
            }
        }
    };

    // Detailed, actionable log line for the loop case (shown in the run log).
    if let Some(culprit) = &loop_culprit {
        push_log(
            &mut progress.log,
            RunLogLine {
                text: format!(
                    "Stopped: source contains a folder loop — “{}” is nested inside itself, so \
                     the copy would recurse forever. Fix the folder at the source (remove the \
                     duplicate/looping subfolder) or exclude it, then re-sync.",
                    culprit
                ),
                kind: RunLogKind::Error,
            },
        );
    }

    progress.status = final_status;

    // Summary line
    let summary = match final_status {
        MappingStatus::Succeeded => format!(
            "Done — {} files, {} transferred",
            progress.files_done,
            format_bytes(progress.bytes_done)
        ),
        MappingStatus::Cancelled => "Run cancelled.".to_string(),
        // Keep the loop reason as the *last* error line so it's what gets
        // persisted to mappings.json as `last_error`.
        MappingStatus::Failed if loop_culprit.is_some() => format!(
            "Folder loop in source (“{}”) — fix or exclude it, then re-sync.",
            loop_culprit.as_deref().unwrap_or_default()
        ),
        MappingStatus::Failed => "Run failed — see errors above.".to_string(),
        _ => String::new(),
    };
    if !summary.is_empty() {
        let summary_kind = match final_status {
            MappingStatus::Succeeded => RunLogKind::Success,
            MappingStatus::Cancelled => RunLogKind::Notice,
            _ => RunLogKind::Error,
        };
        push_log(&mut progress.log, RunLogLine { text: summary, kind: summary_kind });
    }

    let _ = app.emit(RUN_UPDATE_EVENT, &progress);
    progress
}

// ---------------------------------------------------------------------------
// 6. cancel
// ---------------------------------------------------------------------------

/// Request cancellation of the rclone child for `run_id`. We flip the Job's
/// `cancelled` flag IN PLACE and kill the child, leaving ownership/reaping to
/// `run_sync` (which will observe EOF, wait the child, and finalize as
/// Cancelled). If the job is already gone (run finished), this is a no-op — so
/// a late cancel can never turn a completed run into a "cancelled" one.
pub async fn cancel(jobs: Arc<Mutex<HashMap<i64, Job>>>, run_id: i64) {
    let mut guard = jobs.lock().await;
    if let Some(job) = guard.get_mut(&run_id) {
        // Flag is observed by both engines; rclone also gets a hard kill.
        job.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(child) = job.child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

// ---------------------------------------------------------------------------
// 7. friendly_error
// ---------------------------------------------------------------------------

/// Map common rclone stderr snippets to user-facing messages.
/// Never leaks full stack traces.
pub fn friendly_error(stderr_tail: &str) -> String {
    let s = stderr_tail.to_lowercase();

    if s.contains("executable file not found")
        || s.contains("no such file")
        || s.contains("not found in $path")
        || s.contains("rclone: command not found")
    {
        return "rclone not found — install rclone".to_string();
    }

    if is_abuse_flagged(stderr_tail) {
        return "403 abuse-flagged file — enable Acknowledge abuse on this mapping".to_string();
    }

    if s.contains("403") || s.contains("forbidden") || s.contains("access denied") {
        return "Access denied — check your Google Drive permissions".to_string();
    }

    if s.contains("404") || s.contains("couldn't find") || s.contains("not found") {
        return "Folder not found or you don't have access".to_string();
    }

    if s.contains("401")
        || s.contains("oauth")
        || s.contains("token")
        || s.contains("auth")
        || s.contains("expired")
    {
        return "Google authorization failed — reconnect".to_string();
    }

    if s.contains("rate limit") || s.contains("429") || s.contains("user rate limit") {
        return "Google Drive rate limit hit — the next run will retry automatically".to_string();
    }

    if s.contains("timeout") || s.contains("timed out") {
        return "Connection timed out — check your network and try again".to_string();
    }

    // Fall back to the last non-empty line of the tail, trimmed.
    let meaningful = stderr_tail
        .lines()
        .rev()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .unwrap_or("Unknown error — check logs for details");

    // Trim to ≤ 200 chars so we never dump a stack trace into the UI.
    if meaningful.len() > 200 {
        format!("{}…", &meaningful[..197])
    } else {
        meaningful.to_string()
    }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// Keep the log ring at ≤ MAX_LOG_LINES by dropping oldest entries.
/// Long lines are truncated to MAX_LOG_LINE_CHARS so a hostile object name
/// can't bloat the event payload.
fn push_log(log: &mut Vec<RunLogLine>, mut line: RunLogLine) {
    if line.text.chars().count() > MAX_LOG_LINE_CHARS {
        let truncated: String = line.text.chars().take(MAX_LOG_LINE_CHARS).collect();
        line.text = format!("{truncated}…");
    }
    log.push(line);
    if log.len() > MAX_LOG_LINES {
        log.drain(0..log.len() - MAX_LOG_LINES);
    }
}

/// Classify a parsed JSON log line into a (RunLogKind, is_relevant) pair.
/// Stats-only lines are not pushed to the visible log.
fn classify_log_line(parsed: &RcloneJsonLine) -> (RunLogKind, bool) {
    // Lines whose sole purpose is carrying stats data are identified by having
    // no meaningful msg or an empty object field AND having stats present.
    // We suppress pure-stats lines from the log (they're surfaced as numbers).
    let msg = parsed.msg.trim();
    if msg.is_empty() {
        return (RunLogKind::Info, false);
    }

    // Suppress rclone's own "Transferred:", "Checks:", "Elapsed time:" stats summary
    // lines that get duplicated from the numeric stats block.
    if msg.starts_with("Transferred:")
        || msg.starts_with("Checks:")
        || msg.starts_with("Elapsed time:")
        || msg.starts_with("ETA")
    {
        return (RunLogKind::Notice, false);
    }

    let kind = match parsed.level.as_str() {
        "error" | "critical" => RunLogKind::Error,
        "warning" => RunLogKind::Error, // surface warnings prominently
        "notice" => RunLogKind::Notice,
        _ => RunLogKind::Info,
    };

    (kind, true)
}

/// Format a log line for display: "object: msg" or just "msg".
fn format_log_text(parsed: &RcloneJsonLine) -> String {
    let obj = parsed.object.trim();
    let msg = parsed.msg.trim();
    if obj.is_empty() {
        msg.to_string()
    } else {
        format!("{}: {}", obj, msg)
    }
}

/// Returns true when the stderr snippet indicates a Drive 403 abuse/malware block.
fn is_abuse_flagged(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    (s.contains("403") || s.contains("forbidden"))
        && (s.contains("abuse") || s.contains("malware") || s.contains("cannotdownloadabusivefile"))
}

/// Detect a "folder loop" in an rclone object path.
///
/// A source cycle — e.g. a Google Drive folder that is multi-parented into one
/// of its own descendants, or duplicate same-named folders that point back at
/// each other — makes rclone recurse without end, emitting paths where the same
/// directory name repeats over and over (…/A/B/A/B/A/B/…). It re-copies the same
/// files at ever-deeper paths until the OS path limit, so a single run can
/// balloon to hundreds of GB. Genuine media/asset trees don't repeat one folder
/// name this many times in a single path, so a repeat count at or above the
/// threshold is a reliable loop signal.
///
/// Returns the offending folder name so the caller can name it in the error.
///
/// The threshold is deliberately > 4 to avoid tripping on legitimately
/// self-similar trees (e.g. nested `node_modules`); loops are unbounded, so any
/// finite threshold still catches them — just a few levels deeper.
fn runaway_component(path: &str) -> Option<String> {
    const MAX_SAME_COMPONENT: usize = 5;
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for comp in path.split('/').filter(|c| !c.is_empty()) {
        let n = counts.entry(comp).or_insert(0);
        *n += 1;
        if *n >= MAX_SAME_COMPONENT {
            return Some(comp.to_string());
        }
    }
    None
}

/// Format bytes into a human-readable string (B / KiB / MiB / GiB).
fn format_bytes(bytes: i64) -> String {
    const KIB: i64 = 1024;
    const MIB: i64 = KIB * 1024;
    const GIB: i64 = MIB * 1024;
    if bytes >= GIB {
        format!("{:.1} GiB", bytes as f64 / GIB as f64)
    } else if bytes >= MIB {
        format!("{:.1} MiB", bytes as f64 / MIB as f64)
    } else if bytes >= KIB {
        format!("{:.1} KiB", bytes as f64 / KIB as f64)
    } else {
        format!("{} B", bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runaway_component_flags_a_folder_loop() {
        // The real Yosh Studios loop: Mini Poster Size ⟷ Spider Man Poster -Final.
        let looped = "Spider Man Poster/Mini Poster Size/Spider Man Poster -Final/\
                      Mini Poster Size/Spider Man Poster -Final/Mini Poster Size/\
                      Spider Man Poster -Final/Mini Poster Size/Spider Man Poster -Final/\
                      Mini Poster Size/small.3mf";
        assert_eq!(runaway_component(looped).as_deref(), Some("Mini Poster Size"));
    }

    #[test]
    fn runaway_component_ignores_normal_paths() {
        assert_eq!(
            runaway_component("Posters/Spider Man/Mini Poster Size/Final/render.png"),
            None
        );
        assert_eq!(runaway_component(""), None);
    }

    #[test]
    fn runaway_component_tolerates_a_few_repeats_below_threshold() {
        // A folder name repeating up to 4× is fine — only a runaway loop trips it.
        assert_eq!(runaway_component("a/a/a/a/leaf.txt"), None);
    }

    #[test]
    fn build_fs_appends_skip_shortcuts_only_when_requested() {
        // Off → no flag.
        assert_eq!(
            build_fs("gdrive", SourceKind::FolderId, Some("1abc_XYZ"), false, false).unwrap(),
            "gdrive,root_folder_id=1abc_XYZ"
        );
        // On → connection-string option appended after the fs, before the colon.
        assert_eq!(
            build_fs("gdrive", SourceKind::FolderId, Some("1abc_XYZ"), false, true).unwrap(),
            "gdrive,root_folder_id=1abc_XYZ,skip_shortcuts=true"
        );
        // Composes with acknowledge_abuse and shared_with_me.
        assert_eq!(
            build_fs("gdrive", SourceKind::SharedWithMe, None, true, true).unwrap(),
            "gdrive,shared_with_me=true,acknowledge_abuse=true,skip_shortcuts=true"
        );
    }
}
