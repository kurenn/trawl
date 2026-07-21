//! Persistence + path-safety module for Trawl.
//!
//! All filesystem writes to the library stay inside `library_root` via
//! `resolve_dest`, which is the single critical security control.

use std::fs;
use std::io::Write as IoWrite;
use std::path::{Component, Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use uuid::Uuid;

use crate::models::{
    FolderNode, Mapping, MappingStatus, NewMapping, OpResult, Settings, SourceKind, SourceProvider,
};

/// Serializes every read-modify-write of mappings.json (save / delete /
/// update-run-result / toggle-auto). Without this, two near-simultaneous run
/// completions each load the same snapshot and the later write clobbers the
/// earlier one's last-run result. Held only across synchronous work (no awaits).
static MAPPINGS_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

// ─── Path Safety ─────────────────────────────────────────────────────────────

/// Normalise a path *lexically* (no syscalls): collapse `.` and empty segments,
/// leave `..` in place (callers must have already rejected them).
fn lexical_normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}                // drop "."
            Component::Prefix(x) => out.push(x.as_os_str()),
            Component::RootDir => out.push("/"),
            Component::Normal(n) => out.push(n),
            Component::ParentDir => {
                // Should never appear after our component scan rejects ".."
                // but be safe — pop one level rather than silently accepting.
                out.pop();
            }
        }
    }
    out
}

/// THE CRITICAL SAFETY CHECK.
///
/// Resolves `subpath` (a relative, user-supplied string) to an absolute
/// `PathBuf` that is guaranteed to be inside `library_root`.
///
/// Rejection criteria (any one is sufficient):
/// - `subpath` is an absolute path (starts with `/` or a Windows drive letter).
/// - Any path component equals `..`.
/// - Any path component contains a control character (U+0000–U+001F, U+007F).
/// - After joining and lexical normalisation, the result escapes `library_root`.
///
/// Empty `subpath` → returns `library_root` itself (the root is a valid dest).
pub fn resolve_dest(library_root: &Path, subpath: &str) -> Result<PathBuf, String> {
    // Empty means the root itself.
    if subpath.is_empty() {
        let canonical = library_root
            .canonicalize()
            .map_err(|e| format!("Cannot resolve library root: {e}"))?;
        return Ok(canonical);
    }

    // Reject absolute paths (Unix "/" prefix or Windows drive "C:\").
    if subpath.starts_with('/') || subpath.starts_with('\\') {
        return Err("Invalid destination path: must be relative".to_string());
    }
    // Windows drive letters like "C:" – only relevant on Windows but guard anyway.
    if subpath.len() >= 2 {
        let mut chars = subpath.chars();
        let first = chars.next().unwrap_or('\0');
        let second = chars.next().unwrap_or('\0');
        if second == ':' && first.is_ascii_alphabetic() {
            return Err("Invalid destination path: absolute paths are not allowed".to_string());
        }
    }

    // Component-by-component validation.
    let candidate_raw = Path::new(subpath);
    for comp in candidate_raw.components() {
        match comp {
            Component::ParentDir => {
                return Err("Invalid destination path: '..' is not allowed".to_string());
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("Invalid destination path: must be relative".to_string());
            }
            Component::Normal(name) => {
                let s = name.to_string_lossy();
                if s.chars().any(|c| c.is_control()) {
                    return Err(
                        "Invalid destination path: control characters are not allowed".to_string(),
                    );
                }
            }
            Component::CurDir => {} // "." is harmless; lexical_normalize drops it.
        }
    }

    // Canonicalise the library root (requires it to exist — it must for writes to work).
    let root_canonical = library_root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve library root: {e}"))?;

    // Join and lexically normalise (the candidate need not exist yet).
    let joined = root_canonical.join(subpath);
    let candidate = lexical_normalize(&joined);

    // Containment check: candidate must start with root_canonical.
    // We compare byte-for-byte after normalisation, and require a separator
    // (or exact equality) so "rootfoo" doesn't wrongly match root "root".
    let root_str = root_canonical.to_string_lossy();
    let cand_str = candidate.to_string_lossy();

    let inside = if cand_str == root_str {
        true
    } else {
        cand_str.starts_with(root_str.as_ref())
            && cand_str
                .as_bytes()
                .get(root_str.len())
                .copied()
                == Some(b'/')
    };

    if !inside {
        return Err("Invalid destination path: must remain inside the library root".to_string());
    }

    // Symlink-escape defense (the lexical check above is necessary but NOT
    // sufficient): a symlink that lives *inside* library_root but points
    // outside it would let `..`-free subpaths escape. Walk the deepest part of
    // `candidate` that actually exists on disk and canonicalize it — that
    // resolves every intermediate symlink. The resolved real path must STILL be
    // inside the canonical root. The not-yet-existing tail can't follow a
    // symlink (it will be created with create_dir_all as real directories).
    let existing = deepest_existing_ancestor(&candidate);
    if let Ok(real) = existing.canonicalize() {
        let real_str = real.to_string_lossy();
        let still_inside = real_str == root_str
            || (real_str.starts_with(root_str.as_ref())
                && real_str.as_bytes().get(root_str.len()).copied() == Some(b'/'));
        if !still_inside {
            return Err(
                "Invalid destination path: resolves outside the library root (symlink?)"
                    .to_string(),
            );
        }
    }

    Ok(candidate)
}

/// Verify a destination is reachable BEFORE trying to create it. Catches the
/// common "the external/network volume isn't mounted" case — otherwise the user
/// gets a cryptic `create_dir_all` "Permission denied" (the app can't create a
/// `/Volumes/<name>` mount point, nor a top-level dir under `/`).
pub fn check_dest_available(dest_abs: &Path) -> Result<(), String> {
    if dest_abs.exists() {
        return Ok(());
    }
    let existing = deepest_existing_ancestor(dest_abs);
    if existing == Path::new("/Volumes") || existing == Path::new("/") {
        let vol = dest_abs
            .strip_prefix("/Volumes")
            .ok()
            .and_then(|p| p.components().next())
            .map(|c| c.as_os_str().to_string_lossy().into_owned());
        return Err(match vol {
            Some(v) => format!(
                "Destination unavailable — the volume \u{201c}{v}\u{201d} isn't mounted. Connect it and sync again."
            ),
            None => format!(
                "Destination unavailable — can't create \u{201c}{}\u{201d}.",
                dest_abs.display()
            ),
        });
    }
    Ok(())
}

/// Walk up from `path` until a component that exists on disk is found.
/// Returns that existing ancestor (at minimum the path's root). Used so we can
/// canonicalize the real, on-disk portion of a not-yet-created destination.
fn deepest_existing_ancestor(path: &Path) -> PathBuf {
    let mut p = path.to_path_buf();
    loop {
        if p.exists() {
            return p;
        }
        match p.parent() {
            Some(parent) => p = parent.to_path_buf(),
            None => return p,
        }
    }
}

// ─── Folder Listing ──────────────────────────────────────────────────────────

/// Lists immediate subdirectories of `library_root/subpath`, skipping dotfiles
/// (names starting with ".").  Names starting with "_" (e.g. "_Archive") are
/// kept.  Returns an empty Vec if the directory doesn't exist yet.
pub fn list_local_folders(
    library_root: &Path,
    subpath: &str,
) -> Result<Vec<FolderNode>, String> {
    let dir = resolve_dest(library_root, subpath)?;

    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&dir)
        .map_err(|e| format!("Cannot read directory: {e}"))?;

    let mut nodes: Vec<FolderNode> = Vec::new();

    for entry in entries.flatten() {
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }

        let name_os = entry.file_name();
        let name = name_os.to_string_lossy();

        // Skip dotfiles.
        if name.starts_with('.') {
            continue;
        }

        // Build the relative path for this node.
        let node_path = if subpath.is_empty() {
            name.to_string()
        } else {
            format!("{}/{}", subpath.trim_end_matches('/'), name)
        };

        // has_children: true if the subdir contains at least one directory.
        let has_children = fs::read_dir(entry.path())
            .map(|mut rd| {
                rd.any(|e| {
                    e.ok()
                        .and_then(|e| e.file_type().ok())
                        .map(|ft| ft.is_dir())
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);

        nodes.push(FolderNode {
            path: node_path,
            name: name.to_string(),
            has_children,
        });
    }

    // Sort case-insensitively.
    nodes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    Ok(nodes)
}

// ─── Folder Creation ─────────────────────────────────────────────────────────

/// Creates a folder (and all missing ancestors) at `library_root/subpath`.
pub fn create_local_folder(library_root: &Path, subpath: &str) -> OpResult {
    match resolve_dest(library_root, subpath) {
        Err(e) => OpResult {
            ok: false,
            error: Some(e),
        },
        Ok(path) => match fs::create_dir_all(&path) {
            Ok(_) => OpResult { ok: true, error: None },
            Err(e) => OpResult {
                ok: false,
                error: Some(format!("Could not create folder: {e}")),
            },
        },
    }
}

// ─── Path Existence ──────────────────────────────────────────────────────────

/// Returns `true` if the resolved path exists; `false` on any error or
/// containment failure.
pub fn local_path_exists(library_root: &Path, subpath: &str) -> bool {
    resolve_dest(library_root, subpath)
        .map(|p| p.exists())
        .unwrap_or(false)
}

// ─── Atomic Write Helper ─────────────────────────────────────────────────────

/// Writes `data` to a temp file in the same directory as `dest`, then renames
/// into place.  The rename is atomic on POSIX; on Windows it is best-effort.
fn atomic_write(dest: &Path, data: &[u8]) -> Result<(), String> {
    let dir = dest.parent().ok_or("Mappings file has no parent directory")?;

    // Ensure the parent directory exists.
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create config dir: {e}"))?;

    // Temp file in the same directory so the rename stays on one filesystem.
    let tmp_path = dir.join(format!(
        ".trawl-mappings-{}.tmp",
        Uuid::new_v4()
    ));

    let mut tmp = fs::File::create(&tmp_path)
        .map_err(|e| format!("Cannot create temp file: {e}"))?;
    tmp.write_all(data)
        .map_err(|e| format!("Cannot write temp file: {e}"))?;
    tmp.flush()
        .map_err(|e| format!("Cannot flush temp file: {e}"))?;
    drop(tmp);

    fs::rename(&tmp_path, dest)
        .map_err(|e| {
            let _ = fs::remove_file(&tmp_path);
            format!("Cannot rename temp file: {e}")
        })?;

    Ok(())
}

// ─── Persistence ─────────────────────────────────────────────────────────────

/// Reads and deserialises the mappings JSON file.
/// Returns an empty Vec if the file is missing or contains invalid JSON.
pub fn load_mappings(file: &Path) -> Vec<Mapping> {
    match fs::read_to_string(file) {
        Err(_) => Vec::new(),
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
    }
}

/// One-time migration: freeze every legacy mapping (empty `dest_path`) to its
/// CURRENT resolved absolute path, so it stops tracking the mutable global
/// library root. Called once at startup. After this, no mapping silently moves
/// when the root (or another mapping's destination) changes.
pub fn migrate_legacy_dests(file: &Path, library_root: &Path) {
    let _guard = MAPPINGS_LOCK.lock().unwrap();
    let mut mappings = load_mappings(file);
    let mut changed = false;
    for m in mappings.iter_mut() {
        if m.dest_path.trim().is_empty() {
            if let Ok(abs) = resolve_dest(library_root, &m.dest_subpath) {
                m.dest_path = abs.display().to_string();
                changed = true;
            }
        }
    }
    if changed {
        let _ = write_mappings(file, &mappings);
    }
}

/// The absolute destination folder for a mapping. Prefers the per-mapping
/// absolute `dest_path`; falls back to the legacy (global-root + dest_subpath)
/// for mappings created before per-mapping destinations existed.
pub fn effective_dest(
    library_root: &Path,
    dest_path: &str,
    dest_subpath: &str,
) -> Result<PathBuf, String> {
    if !dest_path.trim().is_empty() {
        let p = PathBuf::from(dest_path);
        if !p.is_absolute() {
            return Err("Destination path must be absolute".to_string());
        }
        Ok(p)
    } else {
        resolve_dest(library_root, dest_subpath)
    }
}

/// The destination component used for dedup identity (absolute when set).
fn dest_key<'a>(dest_path: &'a str, dest_subpath: &'a str) -> &'a str {
    if dest_path.trim().is_empty() {
        dest_subpath
    } else {
        dest_path
    }
}

/// Stable identity for dedup: a mapping is a true duplicate only when its
/// provider, source, source subpath, AND destination all match.
fn mapping_identity(
    provider: SourceProvider,
    source_id: Option<&str>,
    source_subpath: &str,
    dest: &str,
) -> String {
    format!(
        "{:?}\u{1f}{}\u{1f}{}\u{1f}{}",
        provider,
        source_id.unwrap_or(""),
        source_subpath,
        dest
    )
}

fn write_mappings(file: &Path, mappings: &[Mapping]) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(mappings)
        .map_err(|e| format!("Serialisation error: {e}"))?;
    atomic_write(file, &json)
}

/// Validates and appends new mappings, then writes the updated file atomically.
///
/// Per-item dedup: skips any NewMapping whose `dest_subpath` already exists
/// among current mappings (first occurrence wins; duplicates within `news` are
/// also skipped after the first is processed).
///
/// Returns the full updated Vec on success, or an error string describing which
/// subpath failed validation and why.
pub fn save_new_mappings(
    file: &Path,
    library_root: &Path,
    news: &[NewMapping],
) -> Result<Vec<Mapping>, String> {
    // Validate ALL new subpaths before touching the file (fail-fast, atomically).
    for nm in news {
        resolve_dest(library_root, &nm.dest_subpath).map_err(|e| {
            format!("Invalid destination '{}': {}", nm.dest_subpath, e)
        })?;

        // Provider-field sanity so we never persist an unsyncable mapping.
        match nm.source_provider {
            SourceProvider::Pcloud => {
                if nm.source_id.as_deref().unwrap_or("").trim().is_empty() {
                    return Err("pCloud mapping is missing its link code".to_string());
                }
            }
            SourceProvider::Gdrive => {
                if matches!(nm.source_kind, SourceKind::FolderId)
                    && nm.source_id.as_deref().unwrap_or("").trim().is_empty()
                {
                    return Err("Drive mapping is missing its folder id".to_string());
                }
            }
        }
    }

    let _guard = MAPPINGS_LOCK.lock().unwrap();
    let mut mappings = load_mappings(file);
    // Dedup by FULL identity (provider + source + dest), not destination alone.
    // Two different source folders may legitimately target the same destination
    // (e.g. several pCloud links left at the library root) — those are distinct
    // mappings, only an identical source→dest pair is a true duplicate.
    let mut seen: std::collections::HashSet<String> = mappings
        .iter()
        .map(|m| {
            mapping_identity(
                m.source_provider,
                m.source_id.as_deref(),
                &m.source_subpath,
                dest_key(&m.dest_path, &m.dest_subpath),
            )
        })
        .collect();

    for nm in news {
        let key = mapping_identity(
            nm.source_provider,
            nm.source_id.as_deref(),
            &nm.source_subpath,
            dest_key(&nm.dest_path, &nm.dest_subpath),
        );
        if seen.contains(&key) {
            continue; // true duplicate (same source AND dest)
        }
        seen.insert(key);

        mappings.push(Mapping {
            id: Uuid::new_v4().to_string(),
            source_provider: nm.source_provider,
            source_kind: nm.source_kind,
            source_id: nm.source_id.clone(),
            source_host: nm.source_host.clone(),
            source_subpath: nm.source_subpath.clone(),
            source_name: nm.source_name.clone(),
            src_label: nm.src_label.clone(),
            dest_subpath: nm.dest_subpath.clone(),
            dest_path: nm.dest_path.clone(),
            acknowledge_abuse: nm.acknowledge_abuse,
            skip_shortcuts: nm.skip_shortcuts,
            enabled: true,
            auto_sync: false,
            last_status: MappingStatus::Idle,
            last_at: None,
            last_files: None,
            last_bytes: None,
            last_error: None,
        });
    }

    write_mappings(file, &mappings)?;
    Ok(mappings)
}

/// Removes the mapping with the given `id` and writes the file atomically.
pub fn delete_mapping(file: &Path, id: &str) -> Result<(), String> {
    let _guard = MAPPINGS_LOCK.lock().unwrap();
    let mut mappings = load_mappings(file);
    mappings.retain(|m| m.id != id);
    write_mappings(file, &mappings)
}

/// Updates the run result fields of a mapping by `id` and writes atomically.
/// No-ops silently if the id is not found.
pub fn update_run_result(
    file: &Path,
    id: &str,
    status: MappingStatus,
    at: Option<String>,
    files: Option<i64>,
    bytes: Option<i64>,
    error: Option<String>,
) -> Result<(), String> {
    let _guard = MAPPINGS_LOCK.lock().unwrap();
    let mut mappings = load_mappings(file);

    if let Some(m) = mappings.iter_mut().find(|m| m.id == id) {
        m.last_status = status;
        m.last_at = at;
        m.last_files = files;
        m.last_bytes = bytes;
        m.last_error = error;
    }

    write_mappings(file, &mappings)
}

// ─── Settings Persistence ────────────────────────────────────────────────────

/// Reads and deserialises the settings JSON file.
/// Returns `Settings::default()` if the file is missing or contains invalid JSON.
/// Never panics.
pub fn load_settings(file: &Path) -> Settings {
    match fs::read_to_string(file) {
        Err(_) => Settings::default(),
        Ok(contents) => serde_json::from_str(&contents).unwrap_or_default(),
    }
}

/// Serialises `settings` to pretty JSON and writes atomically (temp + rename).
/// Maps IO/serde errors to a `String`.
pub fn save_settings(file: &Path, settings: &Settings) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| format!("Serialisation error: {e}"))?;
    atomic_write(file, &json)
}

/// Finds the mapping with the given `id`, flips its `auto_sync` flag to `auto`,
/// writes the full list atomically, and returns the updated Vec.
/// If the `id` is not found the list is written unchanged and returned as-is.
pub fn set_mapping_auto_sync(
    file: &Path,
    id: &str,
    auto: bool,
) -> Result<Vec<Mapping>, String> {
    let _guard = MAPPINGS_LOCK.lock().unwrap();
    let mut mappings = load_mappings(file);

    if let Some(m) = mappings.iter_mut().find(|m| m.id == id) {
        m.auto_sync = auto;
    }

    write_mappings(file, &mappings)?;
    Ok(mappings)
}

/// Finds the mapping with the given `id`, sets its `skip_shortcuts` flag,
/// writes the full list atomically, and returns the updated Vec.
/// If the `id` is not found the list is written unchanged and returned as-is.
pub fn set_mapping_skip_shortcuts(
    file: &Path,
    id: &str,
    skip: bool,
) -> Result<Vec<Mapping>, String> {
    let _guard = MAPPINGS_LOCK.lock().unwrap();
    let mut mappings = load_mappings(file);

    if let Some(m) = mappings.iter_mut().find(|m| m.id == id) {
        m.skip_shortcuts = skip;
    }

    write_mappings(file, &mappings)?;
    Ok(mappings)
}
