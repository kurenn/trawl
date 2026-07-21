//! pCloud public-link sync engine.
//!
//! Mirrors the shape and quality of rclone.rs, but uses pCloud's anonymous
//! public-link HTTP API (no auth, no subprocess).
//!
//! # pCloud API summary
//!
//! ## Metadata / tree
//!   GET https://{host}/showpublink?code={code}
//!   → { result: 0, metadata: { name, isfolder, folderid, contents: [...] } }
//!   Each entry in `contents` (recursive): { name, isfolder, fileid, folderid,
//!     size, hash, modified, contents (for folders) }.
//!   Non-zero result means error (7001 invalid link, 7002 deleted, 7004 expired).
//!
//! ## Per-file download URL
//!   GET https://{host}/getpublinkdownload?code={code}&fileid={fileid}
//!   → { result: 0, hosts: ["c1.pcloud.com", ...], path: "/.../filename" }
//!   Final download URL = https://{hosts[0]}{path}
//!
//! ## Region fallback
//!   pCloud has two API endpoints:
//!     api.pcloud.com  (US datacenter)
//!     eapi.pcloud.com (EU datacenter)
//!   A link only works on the correct region's host. If showpublink returns a
//!   non-zero result we retry with the alternate host once.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::Emitter;
use uuid::Uuid;

use crate::models::{FolderNode, Mapping, MappingStatus, RunLogKind, RunLogLine, RunProgress, RUN_UPDATE_EVENT};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Throttle: minimum gap between emitted progress events (matches rclone.rs).
const EMIT_INTERVAL_MS: u64 = 300;

/// Maximum log lines kept in any emitted progress snapshot.
const MAX_LOG_LINES: usize = 50;

/// Hard cap on a single log line's length — pCloud filenames are untrusted.
const MAX_LOG_LINE_CHARS: usize = 400;

/// In-process tree cache TTL.
const CACHE_TTL_SECS: u64 = 60;

/// Download chunk size (64 KiB) — balance between memory pressure and cancel
/// responsiveness.
const CHUNK_SIZE: usize = 65536;

/// Alternate of the US host.
const HOST_US: &str = "api.pcloud.com";

/// Alternate of the EU host.
const HOST_EU: &str = "eapi.pcloud.com";

/// Caps on the showpublink tree so a hostile/huge public link can't exhaust
/// memory or run forever.
const MAX_FILES: usize = 200_000;
const MAX_DEPTH: usize = 64;

/// Pin the API host to a known pCloud endpoint. NEVER trust an arbitrary
/// `source_host` (from mappings.json or a direct invoke) — that could point
/// showpublink/getpublinkdownload at an internal/attacker host (SSRF).
fn pin_api_host(host: &str) -> &'static str {
    if host.contains("eapi") {
        HOST_EU
    } else {
        HOST_US
    }
}

/// A download host returned by getpublinkdownload must be a BARE pCloud CDN
/// hostname. Reject schemes/ports/userinfo/paths/whitespace and any non-pcloud
/// suffix so a hostile public-link API response can't redirect downloads to an
/// arbitrary host (SSRF).
fn is_valid_download_host(h: &str) -> bool {
    let h = h.trim();
    if h.is_empty() || h.len() > 253 {
        return false;
    }
    if h
        .bytes()
        .any(|b| matches!(b, b'/' | b'@' | b':' | b'?' | b'#' | b'\\' | b' '))
    {
        return false;
    }
    if !h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return false;
    }
    let lower = h.to_ascii_lowercase();
    lower == "pcloud.com" || lower.ends_with(".pcloud.com")
}

/// Shared HTTP agent with connect/read timeouts so a stuck DNS/TLS/read can't
/// hang a sync forever (cancel is only observed between reads).
static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .build()
});

// ---------------------------------------------------------------------------
// pCloud API serde shapes
// ---------------------------------------------------------------------------

/// One entry in the showpublink `contents` tree. Fields are `#[serde(default)]`
/// because pCloud omits them for inapplicable types (e.g. files have no
/// `contents`, folders have no `fileid`).
#[derive(Debug, Clone, Deserialize)]
struct PcloudEntry {
    pub name: String,
    #[serde(default)]
    pub isfolder: bool,
    /// Present for files.
    #[serde(default)]
    pub fileid: u64,
    /// Present for folders. (Parsed but not used for traversal — we walk the
    /// embedded `contents` tree directly.)
    #[serde(default)]
    #[allow(dead_code)]
    pub folderid: u64,
    /// Byte size — present for files; 0 default for folders.
    #[serde(default)]
    pub size: u64,
    /// Recursive children — only for folders, and only when pCloud returns them.
    #[serde(default)]
    pub contents: Vec<PcloudEntry>,
}

/// Top-level showpublink response.
#[derive(Deserialize)]
struct ShowPubLinkResponse {
    pub result: i32,
    #[serde(default)]
    pub metadata: Option<PcloudMeta>,
    /// Human-readable error message on failure (may be absent).
    #[serde(default)]
    pub error: Option<String>,
}

/// The `metadata` block inside ShowPubLinkResponse.
#[derive(Deserialize, Clone)]
struct PcloudMeta {
    pub name: String,
    #[serde(default)]
    pub contents: Vec<PcloudEntry>,
}

/// getpublinkdownload response.
#[derive(Deserialize)]
struct DownloadLinkResponse {
    pub result: i32,
    #[serde(default)]
    pub hosts: Vec<String>,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Tree cache
// ---------------------------------------------------------------------------

/// Cached tree payload (the root metadata from showpublink).
struct CachedTree {
    fetched_at: Instant,
    /// The resolved host that successfully returned the tree (may differ from
    /// the user-supplied host if region fallback kicked in).
    resolved_host: String,
    meta: PcloudMeta,
}

/// In-process cache: key = "host|code" → CachedTree.
static TREE_CACHE: LazyLock<Mutex<HashMap<String, CachedTree>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// ---------------------------------------------------------------------------
// Region fallback helper
// ---------------------------------------------------------------------------

/// Returns the other pCloud region host.
fn alternate_host(host: &str) -> &'static str {
    if host.contains("eapi") { HOST_US } else { HOST_EU }
}

/// Fetch the showpublink tree for `code` from `host`, with one retry on the
/// alternate host if the first call returns a non-zero result code.
///
/// On success returns `(resolved_host, PcloudMeta)`.
///
/// pCloud error codes:
///   7001 — invalid link    7002 — link deleted    7004 — link expired
fn fetch_tree_uncached(host: &str, code: &str) -> Result<(String, PcloudMeta), String> {
    // SSRF defense: only ever talk to a pinned pCloud API endpoint.
    let host = pin_api_host(host);
    let url = format!("https://{}/showpublink?code={}", host, code);
    let resp = AGENT
        .get(&url)
        .call()
        .map_err(|e| format!("pCloud request failed ({}): {}", host, e))?;

    let body: ShowPubLinkResponse = resp
        .into_json()
        .map_err(|e| format!("pCloud response parse error: {}", e))?;

    if body.result == 0 {
        let meta = body.metadata.ok_or_else(|| "pCloud returned no metadata".to_string())?;
        return Ok((host.to_string(), meta));
    }

    // Non-zero — try the alternate region once (also a pinned host).
    let alt = alternate_host(host);
    let alt_url = format!("https://{}/showpublink?code={}", alt, code);
    let resp2 = AGENT
        .get(&alt_url)
        .call()
        .map_err(|e| format!("pCloud request failed ({} and {}): {}", host, alt, e))?;

    let body2: ShowPubLinkResponse = resp2
        .into_json()
        .map_err(|e| format!("pCloud response parse error (alt host): {}", e))?;

    if body2.result == 0 {
        let meta = body2.metadata.ok_or_else(|| "pCloud returned no metadata".to_string())?;
        Ok((alt.to_string(), meta))
    } else {
        // Report the original host's error (more likely user-facing).
        let msg = body
            .error
            .or(body2.error)
            .unwrap_or_else(|| format!("pCloud error code {}", body.result));
        Err(pcloud_friendly_error(body.result, &msg))
    }
}

/// Fetch the pCloud tree for `code`, using the in-process cache when possible.
///
/// Keyed by "host|code"; TTL = CACHE_TTL_SECS.  Returns the resolved host
/// (may differ from `host` after a region-fallback cache hit) alongside the
/// metadata.
fn fetch_tree(host: &str, code: &str) -> Result<(String, PcloudMeta), String> {
    let key = format!("{}|{}", host, code);

    // Fast path: valid cache entry.
    {
        let guard = TREE_CACHE.lock().unwrap();
        if let Some(cached) = guard.get(&key) {
            if cached.fetched_at.elapsed() < Duration::from_secs(CACHE_TTL_SECS) {
                return Ok((cached.resolved_host.clone(), cached.meta.clone()));
            }
        }
    }

    // Slow path: fetch and populate cache.
    let (resolved_host, meta) = fetch_tree_uncached(host, code)?;

    {
        let mut guard = TREE_CACHE.lock().unwrap();
        guard.insert(
            key,
            CachedTree {
                fetched_at: Instant::now(),
                resolved_host: resolved_host.clone(),
                meta: meta.clone(),
            },
        );
    }

    Ok((resolved_host, meta))
}

/// Fetch a FRESH tree, bypassing the cache (used inside `run_pcloud_sync` to
/// pick up any changes since the last browse interaction).
fn fetch_tree_fresh(host: &str, code: &str) -> Result<(String, PcloudMeta), String> {
    let (resolved_host, meta) = fetch_tree_uncached(host, code)?;

    // Also update the cache with the fresh result.
    let key = format!("{}|{}", host, code);
    {
        let mut guard = TREE_CACHE.lock().unwrap();
        guard.insert(
            key,
            CachedTree {
                fetched_at: Instant::now(),
                resolved_host: resolved_host.clone(),
                meta: meta.clone(),
            },
        );
    }

    Ok((resolved_host, meta))
}

// ---------------------------------------------------------------------------
// Tree navigation
// ---------------------------------------------------------------------------

/// Navigate from the root `meta.contents` to the node at `subpath` (slash-
/// separated folder names).  Empty `subpath` means the root itself (returns a
/// synthetic entry wrapping `meta.contents`).
///
/// Each path component is matched by exact case-sensitive name. Returns the
/// matching entry's `contents` slice or an error.
fn navigate_to_subpath<'a>(
    root_contents: &'a [PcloudEntry],
    subpath: &str,
) -> Result<&'a [PcloudEntry], String> {
    if subpath.is_empty() {
        return Ok(root_contents);
    }

    let mut current: &[PcloudEntry] = root_contents;
    for component in subpath.split('/') {
        if component.is_empty() {
            continue;
        }
        let found = current
            .iter()
            .find(|e| e.isfolder && e.name == component)
            .ok_or_else(|| format!("Subfolder '{}' not found in pCloud link", component))?;
        current = &found.contents;
    }
    Ok(current)
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/// A file discovered during recursive tree traversal.
struct PcloudFile {
    /// Path relative to the sync root (e.g. "subdir/file.txt").
    pub relative_path: String,
    pub fileid: u64,
    pub size: u64,
}

/// Recursively collect all files under `entries`, prepending `prefix` to each
/// relative path. Bounded by MAX_DEPTH / MAX_FILES so a hostile public link
/// (huge/deeply-nested tree) can't exhaust memory or time.
fn collect_files(entries: &[PcloudEntry], prefix: &str, depth: usize, out: &mut Vec<PcloudFile>) {
    if depth > MAX_DEPTH {
        return;
    }
    for entry in entries {
        if out.len() >= MAX_FILES {
            return;
        }
        let rel = if prefix.is_empty() {
            entry.name.clone()
        } else {
            format!("{}/{}", prefix, entry.name)
        };

        if entry.isfolder {
            collect_files(&entry.contents, &rel, depth + 1, out);
        } else {
            out.push(PcloudFile {
                relative_path: rel,
                fileid: entry.fileid,
                size: entry.size,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Download link resolution
// ---------------------------------------------------------------------------

/// Fetch the download URL for a single file by fileid.
///
/// Uses the resolved host (which may differ from the user-supplied one if
/// region fallback kicked in during tree fetch).
fn get_download_url(host: &str, code: &str, fileid: u64) -> Result<String, String> {
    let host = pin_api_host(host); // SSRF defense
    let url = format!(
        "https://{}/getpublinkdownload?code={}&fileid={}",
        host, code, fileid
    );
    let resp = AGENT
        .get(&url)
        .call()
        .map_err(|e| format!("getpublinkdownload request failed: {}", e))?;

    let body: DownloadLinkResponse = resp
        .into_json()
        .map_err(|e| format!("getpublinkdownload parse error: {}", e))?;

    if body.result != 0 {
        let msg = body
            .error
            .unwrap_or_else(|| format!("pCloud download error code {}", body.result));
        return Err(pcloud_friendly_error(body.result, &msg));
    }

    // SSRF defense: the download host comes from the (untrusted) API response —
    // only follow a bare pcloud.com CDN hostname.
    let dl_host = body
        .hosts
        .iter()
        .find(|h| is_valid_download_host(h))
        .ok_or_else(|| "pCloud returned no valid download host".to_string())?;

    Ok(format!("https://{}{}", dl_host, body.path))
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/// Map pCloud error codes to user-friendly messages.
fn pcloud_friendly_error(result: i32, raw: &str) -> String {
    match result {
        7001 => "Invalid pCloud public link — check the link code".to_string(),
        7002 => "This pCloud public link has been deleted by its owner".to_string(),
        7004 => "This pCloud public link has expired".to_string(),
        _ => {
            if raw.len() > 200 {
                format!("{}…", &raw[..197])
            } else if raw.is_empty() {
                format!("pCloud error (code {})", result)
            } else {
                raw.to_string()
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Log helpers (mirrors rclone.rs)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Byte formatting (same logic as rclone.rs)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Failed-RunProgress constructor
// ---------------------------------------------------------------------------

fn failed_progress(run_id: i64, mapping: &Mapping, src: &str, dest: &str, msg: &str) -> RunProgress {
    RunProgress {
        run_id,
        mapping_id: mapping.id.clone(),
        name: mapping.source_name.clone(),
        src: src.to_string(),
        dest: dest.to_string(),
        status: MappingStatus::Failed,
        bytes_done: 0,
        bytes_total: 0,
        files_done: 0,
        files_total: 0,
        speed: 0.0,
        eta_sec: 0.0,
        log: vec![RunLogLine {
            text: msg.to_string(),
            kind: RunLogKind::Error,
        }],
    }
}

// ---------------------------------------------------------------------------
// Public API — 1. list_pcloud_folders
// ---------------------------------------------------------------------------

/// List the immediate sub-folders of the node at `subpath` inside the pCloud
/// public link identified by `code`.
///
/// Uses the in-process tree cache (60 s TTL) so repeated expand clicks do not
/// re-fetch the full tree every time.
///
/// Returns folders sorted case-insensitively by name.  `has_children` is `true`
/// iff that sub-folder itself contains at least one folder.
pub fn list_pcloud_folders(host: &str, code: &str, subpath: &str) -> Result<Vec<FolderNode>, String> {
    let (_resolved_host, meta) = fetch_tree(host, code)?;

    let contents = navigate_to_subpath(&meta.contents, subpath)?;

    let mut nodes: Vec<FolderNode> = contents
        .iter()
        .filter(|e| e.isfolder)
        .map(|e| {
            let path = if subpath.is_empty() {
                e.name.clone()
            } else {
                format!("{}/{}", subpath.trim_end_matches('/'), e.name)
            };
            // has_children = true iff this folder's contents includes at least
            // one sub-folder (the tree is fully recursive, so we can be exact).
            let has_children = e.contents.iter().any(|c| c.isfolder);
            FolderNode {
                path,
                name: e.name.clone(),
                has_children,
            }
        })
        .collect();

    nodes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(nodes)
}

// ---------------------------------------------------------------------------
// Public API — 2. resolve_pcloud_name
// ---------------------------------------------------------------------------

/// Return the display name of the pCloud public link's root folder.
///
/// Never errors — returns `""` on any failure so the UI can fall back to a
/// sensible label.
pub fn resolve_pcloud_name(host: &str, code: &str) -> String {
    match fetch_tree(host, code) {
        Ok((_resolved, meta)) => meta.name,
        Err(_) => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Public API — 3. run_pcloud_sync (async)
// ---------------------------------------------------------------------------

/// Sync a pCloud public-link folder into a local destination directory.
///
/// Mirrors `rclone::run_sync` in shape: registers a `Job`, offloads all
/// blocking HTTP work to `spawn_blocking`, streams `RUN_UPDATE_EVENT` progress
/// to the Tauri frontend, and returns the final `RunProgress`.
///
/// Behaviour:
/// - Additive: never deletes local files.
/// - Incremental: skips files whose local byte count matches the source size.
/// - Path-safe: every local path is validated through `store::resolve_dest`
///   before any write.  Files with hostile names (e.g. `../escape`) are skipped
///   with an error log line.
/// - Cancel-aware: checks the cancel flag between chunks and between files;
///   finalises as Cancelled if set.
/// - Keep-going: a single file error is logged but does not abort the rest of
///   the run; the final status is Failed if any error occurred.
pub async fn run_pcloud_sync(
    app: tauri::AppHandle,
    jobs: Arc<tokio::sync::Mutex<HashMap<i64, crate::rclone::Job>>>,
    host: String,
    code: String,
    mapping: Mapping,
    dest_abs: PathBuf,
    run_id: i64,
) -> RunProgress {
    let src_label = format!("pcloud:{}", code);
    let dest_str = dest_abs.display().to_string();

    // Create the cancel flag and register a Job (no child process for pCloud).
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut guard = jobs.lock().await;
        guard.insert(
            run_id,
            crate::rclone::Job {
                child: None,
                cancel: cancel.clone(),
            },
        );
    }

    // Clone everything the blocking closure needs (AppHandle is Clone+Send).
    let app2 = app.clone();
    let host2 = host.clone();
    let code2 = code.clone();
    let mapping2 = mapping.clone();
    let dest_abs2 = dest_abs.clone();
    let cancel2 = cancel.clone();
    let src_label2 = src_label.clone();
    let dest_str2 = dest_str.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        sync_blocking(
            app2,
            host2,
            code2,
            mapping2,
            dest_abs2,
            run_id,
            cancel2,
            src_label2,
            dest_str2,
        )
    })
    .await;

    // Remove the job regardless of outcome.
    jobs.lock().await.remove(&run_id);

    match result {
        Ok(progress) => progress,
        Err(join_err) => {
            // spawn_blocking panicked.
            let p = failed_progress(
                run_id,
                &mapping,
                &src_label,
                &dest_str,
                &format!("Internal error (thread panic): {}", join_err),
            );
            let _ = app.emit(RUN_UPDATE_EVENT, &p);
            p
        }
    }
}

// ---------------------------------------------------------------------------
// Blocking sync worker (runs inside spawn_blocking)
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn sync_blocking(
    app: tauri::AppHandle,
    host: String,
    code: String,
    mapping: Mapping,
    dest_abs: PathBuf,
    run_id: i64,
    cancel: Arc<AtomicBool>,
    src_label: String,
    dest_str: String,
) -> RunProgress {
    // --- a. Fetch a FRESH tree (bypass cache for sync) -----------------------
    let (resolved_host, meta) = match fetch_tree_fresh(&host, &code) {
        Ok(r) => r,
        Err(e) => {
            let p = failed_progress(run_id, &mapping, &src_label, &dest_str, &e);
            let _ = app.emit(RUN_UPDATE_EVENT, &p);
            return p;
        }
    };

    // --- b. Navigate to source_subpath and collect all files -----------------
    let subpath_contents = match navigate_to_subpath(&meta.contents, &mapping.source_subpath) {
        Ok(c) => c,
        Err(e) => {
            let p = failed_progress(run_id, &mapping, &src_label, &dest_str, &e);
            let _ = app.emit(RUN_UPDATE_EVENT, &p);
            return p;
        }
    };

    let mut all_files: Vec<PcloudFile> = Vec::new();
    collect_files(subpath_contents, "", 0, &mut all_files);

    let files_total = all_files.len() as i64;
    // Saturating u64 -> i64 so an absurd reported size can't wrap totals negative.
    let bytes_total: i64 = all_files
        .iter()
        .fold(0i64, |acc, f| acc.saturating_add(i64::try_from(f.size).unwrap_or(i64::MAX)));

    // --- c. Initial progress event -------------------------------------------
    let mut progress = RunProgress {
        run_id,
        mapping_id: mapping.id.clone(),
        name: mapping.source_name.clone(),
        src: src_label.clone(),
        dest: dest_str.clone(),
        status: MappingStatus::Running,
        bytes_done: 0,
        bytes_total,
        files_done: 0,
        files_total,
        speed: 0.0,
        eta_sec: 0.0,
        log: vec![RunLogLine {
            text: format!(
                "Syncing {} files from pCloud link",
                files_total
            ),
            kind: RunLogKind::Meta,
        }],
    };
    let _ = app.emit(RUN_UPDATE_EVENT, &progress);

    // Pre-flight: catch the common "destination volume isn't mounted" case with
    // a clear message before the cryptic create_dir_all permission error.
    if let Err(msg) = crate::store::check_dest_available(&dest_abs) {
        push_log(&mut progress.log, RunLogLine { text: msg, kind: RunLogKind::Error });
        progress.status = MappingStatus::Failed;
        let _ = app.emit(RUN_UPDATE_EVENT, &progress);
        return progress;
    }
    // Ensure destination root exists.
    if let Err(e) = std::fs::create_dir_all(&dest_abs) {
        push_log(
            &mut progress.log,
            RunLogLine {
                text: format!("Cannot create destination folder “{}”: {}", dest_abs.display(), e),
                kind: RunLogKind::Error,
            },
        );
        progress.status = MappingStatus::Failed;
        let _ = app.emit(RUN_UPDATE_EVENT, &progress);
        return progress;
    }

    // --- d. Per-file download loop -------------------------------------------
    let mut last_emit = Instant::now();
    let mut had_errors = false;
    let run_start = Instant::now();

    for file in &all_files {
        // Cancel check between files.
        if cancel.load(Ordering::SeqCst) {
            break;
        }

        // PATH SAFETY (critical): route through store::resolve_dest to guarantee
        // the final local path stays inside dest_abs, even if a pCloud filename
        // contains "../" or other escape sequences.
        let local_path = match crate::store::resolve_dest(&dest_abs, &file.relative_path) {
            Ok(p) => p,
            Err(e) => {
                had_errors = true;
                push_log(
                    &mut progress.log,
                    RunLogLine {
                        text: format!(
                            "Skipped '{}': unsafe path — {}",
                            file.relative_path, e
                        ),
                        kind: RunLogKind::Error,
                    },
                );
                // Still count this file as "done" so progress doesn't stall.
                progress.files_done += 1;
                progress.bytes_done += file.size as i64;
                continue;
            }
        };

        // INCREMENTAL: skip if local file size matches source size. NOTE: this
        // is size-only (like rclone's `--size-only`), so a same-size content
        // change won't re-download. Acceptable for this app's domain (files are
        // typically added or replaced wholesale); delete the local file to force
        // a re-pull. A future improvement could compare the pCloud `hash`.
        if local_path.exists() {
            if let Ok(meta_local) = std::fs::metadata(&local_path) {
                if meta_local.len() == file.size {
                    progress.files_done += 1;
                    progress.bytes_done += file.size as i64;
                    // Throttled emit.
                    let now = Instant::now();
                    if now.duration_since(last_emit) >= Duration::from_millis(EMIT_INTERVAL_MS) {
                        let _ = app.emit(RUN_UPDATE_EVENT, &progress);
                        last_emit = now;
                    }
                    continue;
                }
            }
        }

        // Fetch the download URL for this file.
        let download_url = match get_download_url(&resolved_host, &code, file.fileid) {
            Ok(u) => u,
            Err(e) => {
                had_errors = true;
                push_log(
                    &mut progress.log,
                    RunLogLine {
                        text: format!("Error downloading '{}': {}", file.relative_path, e),
                        kind: RunLogKind::Error,
                    },
                );
                progress.files_done += 1;
                // Don't add to bytes_done — file wasn't received.
                continue;
            }
        };

        // Ensure parent directory exists.
        if let Some(parent) = local_path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                had_errors = true;
                push_log(
                    &mut progress.log,
                    RunLogLine {
                        text: format!(
                            "Cannot create directory for '{}': {}",
                            file.relative_path, e
                        ),
                        kind: RunLogKind::Error,
                    },
                );
                progress.files_done += 1;
                continue;
            }
        }

        // Stream to a unique temp file then rename into place (download_file
        // owns the temp path — atomic on POSIX, no clobber).
        match download_file(
            &download_url,
            &local_path,
            file.size,
            file.relative_path.clone(),
            &cancel,
            &mut progress,
            &app,
            &mut last_emit,
            run_start,
            bytes_total,
        ) {
            DownloadOutcome::Done => {
                // push_log already called inside download_file.
            }
            DownloadOutcome::Cancelled => {
                // Cancel flag is set; the outer loop will break on next iteration.
                break;
            }
            DownloadOutcome::Error => {
                had_errors = true;
            }
        }
    }

    // --- e. Finalize ---------------------------------------------------------
    let was_cancelled = cancel.load(Ordering::SeqCst);

    let final_status = if was_cancelled {
        MappingStatus::Cancelled
    } else if had_errors {
        MappingStatus::Failed
    } else {
        MappingStatus::Succeeded
    };

    progress.status = final_status;

    let (summary_text, summary_kind) = match final_status {
        MappingStatus::Succeeded => (
            format!(
                "Done — {} files, {} transferred",
                progress.files_done,
                format_bytes(progress.bytes_done)
            ),
            RunLogKind::Success,
        ),
        MappingStatus::Cancelled => ("Run cancelled.".to_string(), RunLogKind::Notice),
        MappingStatus::Failed => (
            "Run failed — see errors above.".to_string(),
            RunLogKind::Error,
        ),
        _ => (String::new(), RunLogKind::Info),
    };

    if !summary_text.is_empty() {
        push_log(
            &mut progress.log,
            RunLogLine {
                text: summary_text,
                kind: summary_kind,
            },
        );
    }

    let _ = app.emit(RUN_UPDATE_EVENT, &progress);
    progress
}

// ---------------------------------------------------------------------------
// Per-file download helper
// ---------------------------------------------------------------------------

enum DownloadOutcome {
    Done,
    Cancelled,
    Error,
}

/// Stream a single pCloud file to disk.
///
/// - Downloads in CHUNK_SIZE chunks, checking `cancel` between each.
/// - Writes to a temp file, then renames into place atomically.
/// - Updates `progress.bytes_done` and emits throttled events as it goes.
/// - Pushes a success or error log line before returning.
#[allow(clippy::too_many_arguments)]
fn download_file(
    url: &str,
    final_path: &Path,
    expected_size: u64,
    relative_path: String,
    cancel: &AtomicBool,
    progress: &mut RunProgress,
    app: &tauri::AppHandle,
    last_emit: &mut Instant,
    run_start: Instant,
    bytes_total: i64,
) -> DownloadOutcome {
    // Open HTTP response (via the shared timeout agent).
    let resp = match AGENT.get(url).call() {
        Ok(r) => r,
        Err(e) => {
            push_log(
                &mut progress.log,
                RunLogLine {
                    text: format!("Download error '{}': {}", relative_path, e),
                    kind: RunLogKind::Error,
                },
            );
            progress.files_done += 1;
            return DownloadOutcome::Error;
        }
    };

    // Unique temp file in the destination's parent dir, opened with create_new
    // so a hostile filename can never truncate/clobber an existing real file.
    let tmp_owned = final_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".trawl-tmp-{}", Uuid::new_v4()));
    let tmp_path = tmp_owned.as_path();
    let mut tmp_file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(tmp_path)
    {
        Ok(f) => f,
        Err(e) => {
            push_log(
                &mut progress.log,
                RunLogLine {
                    text: format!(
                        "Cannot create temp file for '{}': {}",
                        relative_path, e
                    ),
                    kind: RunLogKind::Error,
                },
            );
            progress.files_done += 1;
            return DownloadOutcome::Error;
        }
    };

    let mut reader = resp.into_reader();
    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut file_bytes_done: u64 = 0;

    loop {
        // Cancel check inside the download loop.
        if cancel.load(Ordering::SeqCst) {
            drop(tmp_file);
            let _ = std::fs::remove_file(tmp_path);
            return DownloadOutcome::Cancelled;
        }

        let n = match reader.read(&mut buf) {
            Ok(0) => break, // EOF
            Ok(n) => n,
            Err(e) => {
                drop(tmp_file);
                let _ = std::fs::remove_file(tmp_path);
                push_log(
                    &mut progress.log,
                    RunLogLine {
                        text: format!("Read error for '{}': {}", relative_path, e),
                        kind: RunLogKind::Error,
                    },
                );
                progress.files_done += 1;
                return DownloadOutcome::Error;
            }
        };

        if let Err(e) = tmp_file.write_all(&buf[..n]) {
            drop(tmp_file);
            let _ = std::fs::remove_file(tmp_path);
            push_log(
                &mut progress.log,
                RunLogLine {
                    text: format!("Write error for '{}': {}", relative_path, e),
                    kind: RunLogKind::Error,
                },
            );
            progress.files_done += 1;
            return DownloadOutcome::Error;
        }

        file_bytes_done += n as u64;
        progress.bytes_done += n as i64;

        // Update speed and ETA.
        let elapsed = run_start.elapsed().as_secs_f64();
        if elapsed > 0.0 {
            progress.speed = progress.bytes_done as f64 / elapsed;
            let remaining = (bytes_total - progress.bytes_done).max(0) as f64;
            progress.eta_sec = if progress.speed > 0.0 {
                remaining / progress.speed
            } else {
                0.0
            };
        }

        // Throttled emit.
        let now = Instant::now();
        if now.duration_since(*last_emit) >= Duration::from_millis(EMIT_INTERVAL_MS) {
            let _ = app.emit(RUN_UPDATE_EVENT, &*progress);
            *last_emit = now;
        }
    }

    drop(tmp_file);

    // Integrity: a clean early-EOF would otherwise rename a truncated file and
    // report success — and the size-based incremental check would then skip it
    // forever. Require the byte count to match pCloud's reported size.
    if expected_size > 0 && file_bytes_done != expected_size {
        let _ = std::fs::remove_file(tmp_path);
        push_log(
            &mut progress.log,
            RunLogLine {
                text: format!(
                    "Incomplete download for '{}' ({} of {} bytes) — will retry next sync",
                    relative_path, file_bytes_done, expected_size
                ),
                kind: RunLogKind::Error,
            },
        );
        progress.files_done += 1;
        return DownloadOutcome::Error;
    }

    // Rename temp → final (atomic on POSIX).
    if let Err(e) = std::fs::rename(tmp_path, final_path) {
        let _ = std::fs::remove_file(tmp_path);
        push_log(
            &mut progress.log,
            RunLogLine {
                text: format!(
                    "Cannot move temp file to '{}': {}",
                    relative_path, e
                ),
                kind: RunLogKind::Error,
            },
        );
        progress.files_done += 1;
        return DownloadOutcome::Error;
    }

    progress.files_done += 1;

    push_log(
        &mut progress.log,
        RunLogLine {
            text: format!(
                "Copied: {} ({})",
                relative_path,
                format_bytes(file_bytes_done as i64)
            ),
            kind: RunLogKind::Success,
        },
    );

    DownloadOutcome::Done
}
