use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc, Mutex,
    },
};

use tauri::{AppHandle, Emitter, Manager};

use crate::models::{
    ConnectionPhase, ConnectionState, FolderNode, ListSourceArgs, Mapping, NewMapping, OpResult,
    Settings, SourceKind, SourceProvider, STATE_CHANGED_EVENT,
};
use crate::{pcloud, rclone, store};

// ---------------------------------------------------------------------------
// AppState
// ---------------------------------------------------------------------------

pub struct AppState {
    pub mappings_file: PathBuf,
    pub settings_file: PathBuf,
    pub library_root: Mutex<PathBuf>,
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

        // Determine library root: persisted value or ~/Trawl default.
        let lib_root_txt = app_data_dir.join("library_root.txt");
        let library_root = if lib_root_txt.exists() {
            std::fs::read_to_string(&lib_root_txt)
                .ok()
                .map(|s| PathBuf::from(s.trim()))
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or_else(default_library_root)
        } else {
            default_library_root()
        };

        // Ensure the library root directory exists.
        std::fs::create_dir_all(&library_root).ok();

        // One-time: pin any legacy mapping (no absolute dest_path) to its current
        // location so it no longer drifts when the library root changes.
        store::migrate_legacy_dests(&mappings_file, &library_root);

        let settings_file = app_data_dir.join("settings.json");
        let settings = store::load_settings(&settings_file);

        AppState {
            mappings_file,
            settings_file,
            library_root: Mutex::new(library_root),
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

fn default_library_root() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join("Trawl")
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
    // legacy mappings fall back to library_root + dest_subpath.
    let dest_abs = store::effective_dest(&library_root, &mapping.dest_path, &mapping.dest_subpath)?;

    // Concurrency guard: refuse a second concurrent run of the same mapping.
    {
        let mut active = state.active_mappings.lock().unwrap();
        if active.contains(&mapping_id) {
            return Err("This mapping is already syncing.".to_string());
        }
        active.insert(mapping_id.clone());
    }

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
        // mapping already shows as "running" (it's in active_mappings) while it
        // waits its turn, which is fine — "running" means queued-or-transferring.
        let _permit = semaphore.acquire_owned().await;

        let progress = match mapping.source_provider {
            crate::models::SourceProvider::Gdrive => {
                rclone::run_sync(
                    app.clone(),
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
                    app.clone(),
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

        // Write the final result back to the store.
        let at = Some(chrono::Utc::now().to_rfc3339());
        let _ = store::update_run_result(
            &mappings_file,
            &mapping.id,
            progress.status,
            at,
            // Use files_done / bytes_done as the authoritative totals if
            // total fields are zero (rclone may not know totals in advance).
            Some(if progress.files_total > 0 {
                progress.files_total
            } else {
                progress.files_done
            }),
            Some(if progress.bytes_total > 0 {
                progress.bytes_total
            } else {
                progress.bytes_done
            }),
            progress.log.iter().rev().find_map(|l| {
                if matches!(l.kind, crate::models::RunLogKind::Error) {
                    Some(l.text.clone())
                } else {
                    None
                }
            }),
        );

        // Release the mapping so it can be synced again.
        active_mappings.lock().unwrap().remove(&mapping.id);

        // Reconcile signal: tells the UI to reload the now-persisted result —
        // a safety net so a card can't get stuck "running" if a live run event
        // was dropped (the frontend preserves still-running cards on reload).
        let _ = app.emit(STATE_CHANGED_EVENT, ());
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
pub async fn cancel_sync(
    state: tauri::State<'_, AppState>,
    run_id: i64,
) -> Result<(), String> {
    rclone::cancel(Arc::clone(&state.jobs), run_id).await;
    Ok(())
}
