use std::{
    collections::{HashMap, HashSet},
    fs::File,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use trawl_core::locks;

use crate::models::{
    ConnectionPhase, ConnectionState, FolderNode, ListSourceArgs, Mapping, NewMapping, OpResult,
    ProgressFn, Settings, SourceKind, SourceProvider, RUN_UPDATE_EVENT, STATE_CHANGED_EVENT,
};
use crate::{pcloud, rclone, store};

// ---------------------------------------------------------------------------
// AppState
// ---------------------------------------------------------------------------

pub struct AppState {
    pub mappings_file: PathBuf,
    pub settings_file: PathBuf,
    pub library_root: Mutex<PathBuf>,
    /// Directory holding run lock/progress files for this app instance,
    /// computed once at startup (see `trawl_core::locks::run_dir`).
    pub run_dir: PathBuf,
    pub remote: Mutex<String>,
    /// Active rclone jobs keyed by the BACKEND-assigned run id.
    pub jobs: Arc<tokio::sync::Mutex<HashMap<i64, rclone::Job>>>,
    /// Mapping ids with a run currently in flight — guards against the same
    /// mapping syncing twice concurrently (double-click / Sync-all races).
    pub active_mappings: Arc<Mutex<HashSet<String>>>,
    /// Monotonic source of run ids. Owned by the backend so a webview reload
    /// (which resets any frontend counter) can never collide with a live job.
    pub run_counter: Arc<AtomicI64>,
    /// Last known connection state — read by the scheduler to pause auto-sync
    /// while disconnected (kept fresh by detect_connection / connect_drive).
    pub connection: Arc<Mutex<ConnectionState>>,
    /// Persisted app settings (auto-sync cadence + master switch + tray).
    pub settings: Arc<Mutex<Settings>>,
    /// Caps how many rclone runs execute concurrently across ALL triggers
    /// (manual, sync-all, tray, and the scheduler) so a sleep/wake "everything
    /// is due" burst can't spawn dozens of transfers at once.
    pub sync_semaphore: Arc<tokio::sync::Semaphore>,
}

/// Max concurrent rclone runs.
pub const MAX_CONCURRENT_SYNCS: usize = 3;

impl AppState {
    /// Build the initial state from `app_data_dir`.
    ///
    /// - `mappings_file` = `<app_data_dir>/mappings.json`
    /// - `library_root`  = `~/Trawl` (created with create_dir_all)
    /// - `remote`        = `"gdrive"`
    ///
    /// The library root is also persisted to / loaded from
    /// `<app_data_dir>/library_root.txt` so the user's choice survives
    /// restarts.  Defaults to `~/Trawl` when the file is absent.
    pub fn new(app_data_dir: &Path) -> Self {
        // Ensure the app data directory exists.
        std::fs::create_dir_all(app_data_dir).ok();

        let mappings_file = app_data_dir.join("mappings.json");

        // Determine library root: persisted value or ~/Trawl default. Reading
        // it never touches the filesystem beyond the one small text file.
        let library_root = store::read_library_root(app_data_dir);

        // Creating the library root (possibly a slow/flaky network mount) and
        // migrating legacy destinations (which canonicalizes it) are bounded
        // so a wedged mount can't hang app startup — on timeout we log and
        // continue with whatever state exists; the next sync attempt will
        // surface the same mount problem through the normal dest-unreachable
        // path instead of silently wedging the UI forever.
        {
            let library_root = library_root.clone();
            let mappings_file = mappings_file.clone();
            if rclone::with_timeout(Duration::from_secs(10), move || {
                std::fs::create_dir_all(&library_root).ok();
                // One-time: pin any legacy mapping (no absolute dest_path) to
                // its current location so it no longer drifts when the
                // library root changes.
                store::migrate_legacy_dests(&mappings_file, &library_root);
            })
            .is_none()
            {
                eprintln!(
                    "[AppState::new] library root setup timed out after 10s; continuing startup"
                );
            }
        }

        // Run-lock directory, computed once. Falls back (without creating it)
        // to the same path selection on error — a claim against a missing
        // directory fails closed (IO error => Err, never an unlocked run).
        let run_dir = locks::run_dir(app_data_dir).unwrap_or_else(|e| {
            eprintln!("[AppState::new] couldn't create run dir: {e}");
            locks::run_dir_from(std::env::var("XDG_RUNTIME_DIR").ok().as_deref(), app_data_dir)
        });

        let settings_file = app_data_dir.join("settings.json");
        let settings = store::load_settings(&settings_file);

        AppState {
            mappings_file,
            settings_file,
            library_root: Mutex::new(library_root),
            run_dir,
            remote: Mutex::new("gdrive".to_string()),
            jobs: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            active_mappings: Arc::new(Mutex::new(HashSet::new())),
            run_counter: Arc::new(AtomicI64::new(1)),
            connection: Arc::new(Mutex::new(ConnectionState {
                phase: ConnectionPhase::Checking,
                remote: "gdrive".to_string(),
                error: None,
            })),
            settings: Arc::new(Mutex::new(settings)),
            sync_semaphore: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_SYNCS)),
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Grab the remote string out of the Mutex without holding the lock across
/// any await point.
fn get_remote(state: &tauri::State<AppState>) -> String {
    state.remote.lock().unwrap().clone()
}

/// Grab the library root PathBuf out of the Mutex.
fn library_root_path(state: &tauri::State<AppState>) -> PathBuf {
    state.library_root.lock().unwrap().clone()
}

/// Claim the right to run `id` now: the in-process `active` guard (fast,
/// catches same-process races like a double-click) THEN the cross-process
/// run lock (catches another Trawl process, e.g. a CLI run, syncing the same
/// mapping). Held for as long as the returned `File` lives.
///
/// - `Ok(file)`: claimed — caller now owns the lock and must keep `file`
///   alive until the run's result is persisted.
/// - `Err("This mapping is already syncing.")`: already claimed in this
///   process, or the cross-process lock is held elsewhere.
/// - `Err(_)`: IO error acquiring the lock.
///
/// On every error path `id` is removed from `active` before returning, so a
/// failed claim never leaves a phantom "running" mapping behind.
fn claim_run(active: &Mutex<HashSet<String>>, run_dir: &Path, id: &str) -> Result<File, String> {
    {
        let mut guard = active.lock().unwrap();
        if guard.contains(id) {
            return Err("This mapping is already syncing.".to_string());
        }
        guard.insert(id.to_string());
    }

    match locks::try_run_lock(run_dir, id) {
        Ok(Some(file)) => Ok(file),
        Ok(None) => {
            active.lock().unwrap().remove(id);
            Err("This mapping is already syncing.".to_string())
        }
        Err(e) => {
            active.lock().unwrap().remove(id);
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn detect_connection(state: tauri::State<'_, AppState>) -> Result<ConnectionState, String> {
    let remote = get_remote(&state);
    let result = tauri::async_runtime::spawn_blocking(move || rclone::detect_connection(&remote))
        .await
        .map_err(|e| e.to_string())?;

    // Store the detected remote name + cache connection for the scheduler.
    {
        let mut r = state.remote.lock().unwrap();
        *r = result.remote.clone();
    }
    *state.connection.lock().unwrap() = result.clone();

    Ok(result)
}

#[tauri::command]
pub async fn connect_drive(state: tauri::State<'_, AppState>) -> Result<ConnectionState, String> {
    let remote = get_remote(&state);
    let result =
        tauri::async_runtime::spawn_blocking(move || rclone::connect_drive(&remote))
            .await
            .map_err(|e| e.to_string())?;

    // Persist the remote name in case connect_drive returned a different one.
    {
        let mut r = state.remote.lock().unwrap();
        *r = result.remote.clone();
    }
    *state.connection.lock().unwrap() = result.clone();

    Ok(result)
}

#[tauri::command]
pub fn get_library_root(state: tauri::State<AppState>) -> String {
    library_root_path(&state)
        .display()
        .to_string()
}

/// Open a native folder-picker dialog.  If the user picks a folder, update
/// the in-memory library root, persist it to `library_root.txt`, and return
/// `Some(path_string)`.  Returns `None` if the user cancels.
#[tauri::command]
pub async fn pick_library_root(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    // The dialog API is blocking from the perspective of the async command.
    let folder = app
        .dialog()
        .file()
        .blocking_pick_folder();

    let chosen: Option<PathBuf> = folder.map(|fp| fp.into_path().unwrap_or_else(|_| PathBuf::new())).filter(|p| !p.as_os_str().is_empty());

    match chosen {
        None => Ok(None),
        Some(path) => {
            // Ensure the chosen folder exists.
            std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;

            // Derive the settings file path from the mappings_file parent.
            let lib_root_txt = state
                .mappings_file
                .parent()
                .map(|p| p.join("library_root.txt"))
                .unwrap_or_else(|| PathBuf::from("library_root.txt"));

            std::fs::write(&lib_root_txt, path.display().to_string())
                .map_err(|e| e.to_string())?;

            let display = path.display().to_string();
            {
                let mut lr = state.library_root.lock().unwrap();
                *lr = path;
            }
            Ok(Some(display))
        }
    }
}

#[tauri::command]
pub async fn list_source_folders(
    state: tauri::State<'_, AppState>,
    args: ListSourceArgs,
) -> Result<Vec<FolderNode>, String> {
    let remote = get_remote(&state);
    tauri::async_runtime::spawn_blocking(move || match args.provider {
        SourceProvider::Gdrive => rclone::list_source_folders(&remote, &args),
        SourceProvider::Pcloud => {
            let host = args.host.clone().unwrap_or_default();
            let code = args.source_id.clone().unwrap_or_default();
            pcloud::list_pcloud_folders(&host, &code, &args.subpath)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn resolve_source_name(
    state: tauri::State<'_, AppState>,
    provider: SourceProvider,
    kind: SourceKind,
    source_id: Option<String>,
    host: Option<String>,
) -> Result<String, String> {
    let remote = get_remote(&state);
    Ok(tauri::async_runtime::spawn_blocking(move || match provider {
        SourceProvider::Gdrive => {
            rclone::resolve_source_name(&remote, kind, source_id.as_deref())
        }
        SourceProvider::Pcloud => pcloud::resolve_pcloud_name(
            &host.unwrap_or_default(),
            &source_id.unwrap_or_default(),
        ),
    })
    .await
    .map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn list_local_folders(
    state: tauri::State<AppState>,
    subpath: String,
) -> Result<Vec<FolderNode>, String> {
    let root = library_root_path(&state);
    store::list_local_folders(&root, &subpath)
}

#[tauri::command]
pub fn create_local_folder(state: tauri::State<AppState>, subpath: String) -> OpResult {
    let root = library_root_path(&state);
    store::create_local_folder(&root, &subpath)
}

#[tauri::command]
pub fn local_path_exists(state: tauri::State<AppState>, subpath: String) -> bool {
    let root = library_root_path(&state);
    store::local_path_exists(&root, &subpath)
}

/// Reveal a mapping's destination folder in the OS file manager (Finder,
/// Explorer, …). The path is resolved here rather than passed in from the
/// frontend so it always matches what a sync would actually write to.
#[tauri::command]
pub fn open_mapping_folder(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mapping = store::load_mappings(&state.mappings_file)
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| "That mapping no longer exists.".to_string())?;

    let root = library_root_path(&state);
    let dest = store::effective_dest(&root, &mapping.dest_path, &mapping.dest_subpath)?;

    // Distinguish "volume not mounted" (actionable) from "never synced yet".
    store::check_dest_available(&dest)?;
    if !dest.exists() {
        return Err(format!(
            "“{}” doesn't exist yet — sync this mapping once to create it.",
            dest.display()
        ));
    }

    app.opener()
        .open_path(dest.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("Couldn't open the folder: {e}"))
}

#[tauri::command]
pub fn load_mappings(state: tauri::State<AppState>) -> Vec<Mapping> {
    store::load_mappings(&state.mappings_file)
}

#[tauri::command]
pub fn save_mappings(
    state: tauri::State<AppState>,
    mappings: Vec<NewMapping>,
) -> Result<Vec<Mapping>, String> {
    let root = library_root_path(&state);
    store::save_new_mappings(&state.mappings_file, &root, &mappings)
}

#[tauri::command]
pub fn delete_mapping(state: tauri::State<AppState>, id: String) -> Result<(), String> {
    store::delete_mapping(&state.mappings_file, &id)
}

/// Core sync trigger shared by the `start_sync` command, the background
/// scheduler, and the tray menu. Resolves state from the `AppHandle` so callers
/// that only hold an `AppHandle` (scheduler/tray) can use it. Spawns the rclone
/// run, streams `run://update` events, writes the final result back to
/// mappings.json, and returns the BACKEND-assigned run id. Rejects (without
/// starting anything) if the same mapping is already syncing.
pub async fn trigger_sync(app: AppHandle, mapping_id: String) -> Result<i64, String> {
    let state = app.state::<AppState>();

    // Load mappings and find the requested one.
    let mappings = store::load_mappings(&state.mappings_file);
    let mapping = mappings
        .into_iter()
        .find(|m| m.id == mapping_id)
        .ok_or_else(|| format!("mapping {} not found", mapping_id))?;

    let library_root = state.library_root.lock().unwrap().clone();
    let remote = state.remote.lock().unwrap().clone();

    // Resolve the absolute destination. Per-mapping `dest_path` (absolute) wins;
    // legacy mappings fall back to library_root + dest_subpath (which
    // canonicalizes library_root — possibly a slow/flaky network mount).
    // Bounded + off the async executor thread so a wedged mount can't hang
    // the command instead of failing with a clear error.
    let dest_abs = {
        let library_root = library_root.clone();
        let dest_path = mapping.dest_path.clone();
        let dest_subpath = mapping.dest_subpath.clone();
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            rclone::with_timeout(rclone::DEST_CHECK_TIMEOUT, move || {
                store::effective_dest(&library_root, &dest_path, &dest_subpath)
            })
        })
        .await
        .map_err(|e| e.to_string())?;
        match outcome {
            Some(result) => result?,
            None => return Err("Destination stopped responding".to_string()),
        }
    };

    // Concurrency guard: the in-process `active` set, THEN the cross-process
    // run lock. The lock `File` is held (moved into the spawned task below)
    // until the run's result is persisted.
    let lock = claim_run(&state.active_mappings, &state.run_dir, &mapping_id)?;

    // Backend-owned, collision-free run id.
    let run_id = state.run_counter.fetch_add(1, Ordering::SeqCst);

    let mappings_file = state.mappings_file.clone();
    let jobs = Arc::clone(&state.jobs);
    let active_mappings = Arc::clone(&state.active_mappings);
    let semaphore = Arc::clone(&state.sync_semaphore);
    // Release the State borrow before moving `app` into the spawned task.
    drop(state);

    tauri::async_runtime::spawn(async move {
        // Wait for a global concurrency slot before launching the run. The
        // mapping already shows as "running" (it's in active_mappings, and the
        // run lock is held) while it waits its turn, which is fine —
        // "running" means queued-or-transferring.
        let _permit = semaphore.acquire_owned().await;

        let emit: ProgressFn = Arc::new({
            let app = app.clone();
            move |p| {
                let _ = app.emit(RUN_UPDATE_EVENT, p);
            }
        });

        let progress = match mapping.source_provider {
            crate::models::SourceProvider::Gdrive => {
                rclone::run_sync(
                    emit,
                    Arc::clone(&jobs),
                    remote,
                    mapping.clone(),
                    dest_abs,
                    run_id,
                )
                .await
            }
            crate::models::SourceProvider::Pcloud => {
                let host = mapping.source_host.clone().unwrap_or_default();
                let code = mapping.source_id.clone().unwrap_or_default();
                pcloud::run_pcloud_sync(
                    emit,
                    Arc::clone(&jobs),
                    host,
                    code,
                    mapping.clone(),
                    dest_abs,
                    run_id,
                )
                .await
            }
        };

        // Write the final result back to the store. The run lock is still
        // held at this point (it outlives the write) — released explicitly
        // below, after the mapping is observably done.
        let _ = store::persist_run_result(&mappings_file, &progress);

        // Release the mapping so it can be synced again.
        active_mappings.lock().unwrap().remove(&mapping.id);

        // Reconcile signal: tells the UI to reload the now-persisted result —
        // a safety net so a card can't get stuck "running" if a live run event
        // was dropped (the frontend preserves still-running cards on reload).
        let _ = app.emit(STATE_CHANGED_EVENT, ());

        // Release the cross-process run lock now that the result is
        // persisted and the UI has been told to reconcile.
        drop(lock);
    });

    Ok(run_id)
}

/// Fire-and-forget sync command (thin wrapper over `trigger_sync`).
#[tauri::command]
pub async fn start_sync(app: AppHandle, mapping_id: String) -> Result<i64, String> {
    trigger_sync(app, mapping_id).await
}

// ---------------------------------------------------------------------------
// Settings + auto-sync
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: tauri::State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_settings(
    app: AppHandle,
    state: tauri::State<AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    store::save_settings(&state.settings_file, &settings)?;
    *state.settings.lock().unwrap() = settings.clone();
    let _ = app.emit(STATE_CHANGED_EVENT, ());
    Ok(settings)
}

#[tauri::command]
pub fn set_mapping_auto_sync(
    state: tauri::State<AppState>,
    id: String,
    auto: bool,
) -> Result<Vec<Mapping>, String> {
    store::set_mapping_auto_sync(&state.mappings_file, &id, auto)
}

#[tauri::command]
pub fn set_mapping_skip_shortcuts(
    state: tauri::State<AppState>,
    id: String,
    skip: bool,
) -> Result<Vec<Mapping>, String> {
    store::set_mapping_skip_shortcuts(&state.mappings_file, &id, skip)
}

#[tauri::command]
pub fn set_mapping_protect_local_edits(
    state: tauri::State<AppState>,
    id: String,
    protect: bool,
) -> Result<Vec<Mapping>, String> {
    store::set_mapping_protect_local_edits(&state.mappings_file, &id, protect)
}

#[tauri::command]
pub async fn cancel_sync(
    state: tauri::State<'_, AppState>,
    run_id: i64,
) -> Result<(), String> {
    rclone::cancel(Arc::clone(&state.jobs), run_id).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    /// A unique temp dir per test run — no tempfile crate: pid + a monotonic
    /// counter + the current time is unique enough for a test binary.
    fn unique_temp_dir(label: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, AtomicOrdering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "trawl_commands_test_{label}_{}_{}_{}",
            std::process::id(),
            nanos,
            n
        ))
    }

    #[test]
    fn claim_run_refuses_when_lock_held_elsewhere_and_leaves_active_clean() {
        let dir = unique_temp_dir("held_elsewhere");
        std::fs::create_dir_all(&dir).unwrap();

        // A separate handle holds the cross-process run lock for "m1", as a
        // concurrent process (or an earlier claim in this one) would.
        let held = locks::try_run_lock(&dir, "m1")
            .unwrap()
            .expect("the held-elsewhere claim itself should succeed");

        let active: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
        let err = claim_run(&active, &dir, "m1").expect_err("lock is held elsewhere");
        assert_eq!(err, "This mapping is already syncing.");
        assert!(
            active.lock().unwrap().is_empty(),
            "a failed claim must not leave the id in `active`"
        );

        drop(held);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claim_run_refuses_duplicate_in_process() {
        let dir = unique_temp_dir("duplicate_in_process");
        std::fs::create_dir_all(&dir).unwrap();

        let active: Mutex<HashSet<String>> = Mutex::new(HashSet::new());

        let first = claim_run(&active, &dir, "m1").expect("first claim should succeed");
        let err = claim_run(&active, &dir, "m1")
            .expect_err("a second in-process claim for the same id must be refused");
        assert_eq!(err, "This mapping is already syncing.");

        // The in-process guard rejects before touching the lock file at all,
        // so the original (still-valid) claim's membership must be untouched.
        assert!(active.lock().unwrap().contains("m1"));

        drop(first);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
