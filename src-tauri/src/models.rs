//! Shared data models — the Rust mirror of `src/types.ts`.
//! Serde attributes are chosen so JSON field names match the TypeScript types
//! EXACTLY. Do not change field names/casing without updating types.ts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    FolderId,
    SharedWithMe,
}

/// Which cloud provider a mapping's source lives on. `gdrive` uses the rclone
/// `drive` backend; `pcloud` uses pCloud's anonymous public-link API directly.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SourceProvider {
    #[default]
    Gdrive,
    Pcloud,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MappingStatus {
    Succeeded,
    Failed,
    Running,
    Cancelled,
    Idle,
}

/// Persisted mapping. snake_case fields == TS `Mapping`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Mapping {
    pub id: String,
    /// `#[serde(default)]` → Gdrive, so pre-pCloud mappings.json still loads.
    #[serde(default)]
    pub source_provider: SourceProvider,
    pub source_kind: SourceKind,
    /// Drive folder ID (gdrive) OR pCloud public-link code (pcloud).
    pub source_id: Option<String>,
    /// pCloud API host (api.pcloud.com / eapi.pcloud.com). None for gdrive.
    #[serde(default)]
    pub source_host: Option<String>,
    pub source_subpath: String,
    pub source_name: String,
    pub src_label: String,
    /// Legacy: destination RELATIVE to the global library root. Kept for
    /// back-compat; `dest_path` (absolute, per-mapping) is authoritative when set.
    pub dest_subpath: String,
    /// Absolute destination folder for THIS mapping, captured when it was
    /// created. Decoupled from the global library root so changing the root (or
    /// another mapping's destination) never moves this one. `#[serde(default)]`
    /// → "" for pre-existing mappings, which fall back to dest_subpath.
    #[serde(default)]
    pub dest_path: String,
    pub acknowledge_abuse: bool,
    pub enabled: bool,
    /// Participates in the background auto-sync scheduler when true.
    /// `#[serde(default)]` keeps older mappings.json files (without this field)
    /// loadable.
    #[serde(default)]
    pub auto_sync: bool,
    /// Pass `skip_shortcuts=true` to the Drive backend so rclone ignores Google
    /// Drive shortcuts. Breaks shortcut-induced folder loops (a shortcut that
    /// points back up its own tree) while still copying every real file.
    /// Gdrive-only; ignored for pCloud. `#[serde(default)]` keeps older
    /// mappings.json files (without this field) loadable.
    #[serde(default)]
    pub skip_shortcuts: bool,
    pub last_status: MappingStatus,
    pub last_at: Option<String>,
    pub last_files: Option<i64>,
    pub last_bytes: Option<i64>,
    pub last_error: Option<String>,
}

/// Incoming new mapping (id + last_* assigned on persist). == TS `NewMapping`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewMapping {
    #[serde(default)]
    pub source_provider: SourceProvider,
    pub source_kind: SourceKind,
    pub source_id: Option<String>,
    #[serde(default)]
    pub source_host: Option<String>,
    pub source_subpath: String,
    pub source_name: String,
    pub src_label: String,
    pub dest_subpath: String,
    /// Absolute destination folder for this mapping (authoritative).
    #[serde(default)]
    pub dest_path: String,
    pub acknowledge_abuse: bool,
    #[serde(default)]
    pub skip_shortcuts: bool,
}

/// One lazy-tree node. == TS `FolderNode` (camelCase: hasChildren).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderNode {
    pub path: String,
    pub name: String,
    pub has_children: bool,
}

/// == TS `ListSourceArgs` (camelCase: sourceId).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSourceArgs {
    #[serde(default)]
    pub provider: SourceProvider,
    pub kind: SourceKind,
    pub source_id: Option<String>,
    /// pCloud API host (api/eapi). Ignored for gdrive.
    #[serde(default)]
    pub host: Option<String>,
    pub subpath: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionPhase {
    Checking,
    Disconnected,
    Connecting,
    Connected,
    Error,
}

/// == TS `ConnectionState`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionState {
    pub phase: ConnectionPhase,
    pub remote: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunLogKind {
    Info,
    Success,
    Error,
    Notice,
    Meta,
}

/// == TS `RunLogLine`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunLogLine {
    pub text: String,
    pub kind: RunLogKind,
}

/// Streamed progress snapshot. == TS `RunProgress` (camelCase).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProgress {
    pub run_id: i64,
    pub mapping_id: String,
    pub name: String,
    pub src: String,
    pub dest: String,
    pub status: MappingStatus,
    pub bytes_done: i64,
    pub bytes_total: i64,
    pub files_done: i64,
    pub files_total: i64,
    pub speed: f64,
    pub eta_sec: f64,
    pub log: Vec<RunLogLine>,
}

/// Result of createLocalFolder. == TS `{ ok, error? }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// App-wide settings (persisted to settings.json). snake_case == TS `Settings`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Master switch for the background scheduler.
    pub auto_sync_enabled: bool,
    /// Cadence in minutes for auto-sync.
    pub auto_sync_interval_minutes: u32,
    /// Hide-to-tray on window close instead of quitting.
    pub minimize_to_tray: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            auto_sync_enabled: true,
            auto_sync_interval_minutes: 15,
            minimize_to_tray: true,
        }
    }
}

/// The single Tauri event name used to stream run progress to the UI.
pub const RUN_UPDATE_EVENT: &str = "run://update";

/// Event emitted when settings or a mapping's auto flag changes, so the UI can
/// refresh (also used after a tray-triggered "sync all").
pub const STATE_CHANGED_EVENT: &str = "state://changed";
