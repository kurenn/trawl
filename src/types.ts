/* ============================================================================
   Trawl — shared type contract.
   This file is the integration contract between the store, the views, and the
   two API adapters (real Tauri + browser sim). Treat it as frozen: implement
   against it, don't change signatures without coordinating.
   ============================================================================ */

/* ---------------------------------------------------------------------------
   Domain model
   --------------------------------------------------------------------------- */

/** Source addressing modes. "by link" == folder_id (primary). shared_with_me
 *  is a cheap bonus. ("path" from the spec is intentionally out of scope.) */
export type SourceKind = "folder_id" | "shared_with_me";

/** Which cloud the source lives on. gdrive → rclone; pcloud → anonymous
 *  public-link API. */
export type SourceProvider = "gdrive" | "pcloud";

export type MappingStatus =
  | "succeeded"
  | "failed"
  | "running"
  | "cancelled"
  | "idle";

/** A saved Drive-folder -> local-folder mapping. Persisted by the Rust store
 *  (mappings.json). Mirrors PRODUCT_SPEC SyncMapping, trimmed for desktop. */
export interface Mapping {
  id: string;
  source_provider: SourceProvider;
  source_kind: SourceKind;
  /** Drive folder ID (gdrive) OR pCloud public-link code (pcloud). */
  source_id: string | null;
  /** pCloud API host (api/eapi). null for gdrive. */
  source_host: string | null;
  /** Subpath within the source root that was selected in the tree (""=root). */
  source_subpath: string;
  /** Human label (folder name). */
  source_name: string;
  /** rclone fs label shown in mono on the card, e.g. "gdrive,root_folder_id=ABC:". */
  src_label: string;
  /** Legacy: destination relative to the library root. */
  dest_subpath: string;
  /** Absolute destination folder for this mapping (authoritative when set). */
  dest_path: string;
  acknowledge_abuse: boolean;
  enabled: boolean;
  /** Participates in the background auto-sync scheduler when true. */
  auto_sync: boolean;
  /** Pass `skip_shortcuts=true` to the Drive backend: rclone ignores Google
   *  Drive shortcuts, breaking shortcut-induced folder loops. Gdrive-only. */
  skip_shortcuts: boolean;
  /** Last-run summary (the dashboard card reads these). */
  last_status: MappingStatus;
  last_at: string | null; // ISO timestamp, or null = never
  last_files: number | null;
  last_bytes: number | null;
  last_error: string | null;
}

/* ---------------------------------------------------------------------------
   Connection (Google Drive via rclone remote)
   --------------------------------------------------------------------------- */

export type ConnectionPhase =
  | "checking" // initial detection in flight
  | "disconnected" // no usable drive remote -> show Connect gate
  | "connecting" // OAuth flow running
  | "connected" // a drive remote exists
  | "error";

export interface ConnectionState {
  phase: ConnectionPhase;
  /** Remote name in use (default "gdrive"). */
  remote: string;
  /** Friendly error if phase==="error". */
  error: string | null;
}

/* ---------------------------------------------------------------------------
   Settings (persisted; powers the background auto-sync scheduler)
   --------------------------------------------------------------------------- */

export interface Settings {
  /** Master switch for the background scheduler. */
  auto_sync_enabled: boolean;
  /** Cadence in minutes for auto-sync. */
  auto_sync_interval_minutes: number;
  /** Hide-to-tray on window close instead of quitting. */
  minimize_to_tray: boolean;
}

/* ---------------------------------------------------------------------------
   Folder listings (lazy tree). Both Drive and local use the same node shape.
   --------------------------------------------------------------------------- */

export interface FolderNode {
  /** Stable id for the row. Drive: subpath under source root. Local: subpath
   *  under library root. "" is never a node (root is rendered separately). */
  path: string;
  /** Leaf display name. */
  name: string;
  /** Whether it has subfolders (drives the chevron). May be a best-effort
   *  guess; the real list happens on expand. */
  hasChildren: boolean;
}

export interface ListSourceArgs {
  provider: SourceProvider;
  kind: SourceKind;
  /** Drive folder ID (gdrive) or pCloud public-link code (pcloud). */
  sourceId: string | null;
  /** pCloud API host (api/eapi). null for gdrive. */
  host: string | null;
  /** Subpath under the source root to list ("" = root's direct children). */
  subpath: string;
}

/* ---------------------------------------------------------------------------
   Runs (live sync progress, streamed from rclone)
   --------------------------------------------------------------------------- */

export type RunLogKind = "info" | "success" | "error" | "notice" | "meta";

export interface RunLogLine {
  text: string;
  kind: RunLogKind;
}

/** Progress event payload streamed from the backend (Tauri event "run://update")
 *  or emitted by the sim. One snapshot of an in-flight (or finished) run. */
export interface RunProgress {
  runId: number;
  mappingId: string;
  name: string;
  src: string; // mono "src" line
  dest: string; // mono "dst ->" line (absolute)
  status: MappingStatus; // running | succeeded | failed | cancelled
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  speed: number; // bytes/sec
  etaSec: number;
  log: RunLogLine[]; // full log; view shows the last ~13 lines
}

/* ---------------------------------------------------------------------------
   The backend API. Implemented by:
     - src/tauri/tauriApi.ts  (real: invoke + events)
     - src/sim/simApi.ts      (browser: prototype catalog + animated run)
   The store talks only to this interface (see src/api.ts for selection).
   --------------------------------------------------------------------------- */

/** A newer version available via the in-app updater (Tauri updater plugin). */
export interface UpdateInfo {
  version: string; // the available version, e.g. "0.2.0"
  notes: string | null; // release notes body, if any
}

/** Sidebar update affordance state. */
export type UpdatePhase =
  | "idle" // not checked yet
  | "checking" // querying the release endpoint
  | "available" // a newer version is ready to install
  | "downloading" // installing + about to relaunch
  | "current" // running the latest version
  | "error"; // check/install failed

export interface UpdateState {
  phase: UpdatePhase;
  version: string | null; // available version when phase === "available"
  error: string | null;
}

export interface Api {
  /** True when running under the real Tauri runtime (vs browser sim). */
  readonly isReal: boolean;

  // --- connection ---
  detectConnection(): Promise<ConnectionState>;
  /** Run rclone's OAuth flow; resolves when a usable remote exists. */
  connectDrive(): Promise<ConnectionState>;

  // --- library root ---
  getLibraryRoot(): Promise<string>;
  /** Native folder picker to relocate the library root. Returns the new root,
   *  or null if cancelled. */
  pickLibraryRoot(): Promise<string | null>;

  // --- folder listings (lazy) ---
  listSourceFolders(args: ListSourceArgs): Promise<FolderNode[]>;
  /** Resolve the display name of a pasted source root (best-effort). */
  resolveSourceName(
    provider: SourceProvider,
    kind: SourceKind,
    sourceId: string | null,
    host: string | null,
  ): Promise<string>;
  /** List real local subfolders under <libraryRoot>/<subpath>. */
  listLocalFolders(subpath: string): Promise<FolderNode[]>;
  /** Create <libraryRoot>/<subpath>; returns ok or a friendly error. */
  createLocalFolder(subpath: string): Promise<{ ok: boolean; error?: string }>;
  /** Does <libraryRoot>/<subpath> already exist on disk? */
  localPathExists(subpath: string): Promise<boolean>;

  // --- mappings persistence ---
  loadMappings(): Promise<Mapping[]>;
  /** Persist a batch of new mappings (dedup on dest_subpath handled by store/back). */
  saveMappings(mappings: NewMapping[]): Promise<Mapping[]>;
  deleteMapping(id: string): Promise<void>;
  /** Toggle a mapping's auto-sync flag; returns the full updated list. */
  setMappingAutoSync(id: string, auto: boolean): Promise<Mapping[]>;
  /** Toggle a mapping's skip-shortcuts flag; returns the full updated list. */
  setMappingSkipShortcuts(id: string, skip: boolean): Promise<Mapping[]>;

  // --- updates ---
  /** Check the release endpoint for a newer version. Resolves to update info
   *  if one is available, or null if the app is already current. */
  checkForUpdate(): Promise<UpdateInfo | null>;
  /** Download + install the pending update, then relaunch into it. Only valid
   *  after checkForUpdate() returned a non-null result. */
  installUpdate(): Promise<void>;

  // --- settings ---
  getSettings(): Promise<Settings>;
  setSettings(settings: Settings): Promise<Settings>;
  /** Fired when the backend changes shared state (tray toggle, auto-sync,
   *  sync-all). The UI should reload mappings/settings. Returns unsubscribe. */
  onStateChanged(cb: () => void): Promise<() => void>;

  // --- runs ---
  /** Start a sync. The backend assigns and returns the run id, and emits
   *  "run://update" RunProgress events carrying that runId + the mappingId.
   *  Rejects if the mapping is already syncing. */
  startSync(mappingId: string): Promise<number>;
  cancelSync(runId: number): Promise<void>;
  /** Subscribe to streamed run updates. Returns an unsubscribe fn. */
  onRunUpdate(cb: (p: RunProgress) => void): Promise<() => void>;
}

/** Shape sent to saveMappings (pre-persistence; id/last_* assigned by backend). */
export interface NewMapping {
  source_provider: SourceProvider;
  source_kind: SourceKind;
  source_id: string | null;
  source_host: string | null;
  source_subpath: string;
  source_name: string;
  src_label: string;
  dest_subpath: string;
  /** Absolute destination folder for this mapping. */
  dest_path: string;
  acknowledge_abuse: boolean;
  skip_shortcuts: boolean;
}

/* ---------------------------------------------------------------------------
   View-models the store hands to the views (keeps views ~pure markup).
   --------------------------------------------------------------------------- */

export type View = "connect" | "dashboard" | "newMapping" | "run" | "settings";

/** Status -> presentation, transcribed from prototype STATUS map. */
export interface StatusMeta {
  label: string;
  color: string;
  bg: string;
  cardBd: string;
}

/** One row in a lazy tree (source or dest), already flattened with indentation
 *  and handlers — mirrors the prototype's renderVals rows. */
export interface TreeRow {
  key: string;
  kind: "row" | "loading" | "empty";
  /** left padding in px (depth-based). */
  pad: number;
  name: string;
  hasChildren: boolean;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onSelect: () => void;
}

export interface StagedPair {
  key: string;
  name: string;
  dest: string; // relative dest subpath (legacy/display)
  /** Absolute destination folder captured at add time. */
  destPath: string;
  remove: () => void;
}

/** A run shaped for the Run view (formatted strings + flags). */
export interface RunView {
  runId: string; // zero-padded "00043"
  name: string;
  src: string;
  dest: string;
  status: MappingStatus;
  statusMeta: StatusMeta;
  isRunning: boolean;
  isDone: boolean;
  pct: number;
  barWidth: string; // "42.31%"
  barColor: string;
  shineOpacity: string; // "1" | "0"
  transferred: string; // fmtBytes
  total: string;
  files: number;
  filesTotal: number;
  speed: string; // "12.3 MiB/s" | "—"
  eta: string; // "01:23" | "—"
  log: RunLogLine[]; // last ~13
  hasQueue: boolean;
  queueRemaining: number;
  cancel: () => void;
  retry: () => void;
  back: () => void;
}

/** Mapping shaped for a dashboard card. */
export interface MappingCard extends Mapping {
  statusMeta: StatusMeta;
  metaLine: string;
  /** Short provider tag for the card, e.g. "pCloud" | "Drive". */
  providerLabel: string;
  srcLabel: string;
  destDisplay: string; // "<libraryRoot>/<dest>"
  syncLabel: string; // "Sync now" | "Retry"
  /** Relative time the last run failed, e.g. "12m ago"; "" unless failed. */
  failedAgo: string;
  pendingDelete: boolean;
  /** Auto-sync state for this card. */
  autoLabel: string; // "Auto · every 15 min · next ~8m" | "Manual"
  /** Live progress (when a run is in flight for this mapping). */
  running: boolean;
  pct: number; // 0–100
  barWidth: string; // "42.3%"
  progressLabel: string; // "42% · 3.2 / 19 GiB · 72/433 files · 12 MiB/s · ETA 01:23"
  toggleAuto: () => void;
  /** Flip this mapping's skip-shortcuts flag (Drive-only; no-op UI for pCloud). */
  toggleSkipShortcuts: () => void;
  syncNow: () => void;
  cancelNow: () => void;
  /** Open the Run view (live log) for this mapping's in-flight sync. */
  openRun: () => void;
  askDelete: () => void;
  confirmDelete: () => void;
  cancelDelete: () => void;
}

/* ---------------------------------------------------------------------------
   The useTrawl() hook return — the full surface the views consume.
   The store (src/store.tsx) implements this; views import the type only.
   --------------------------------------------------------------------------- */

export interface UseTrawl {
  // shell / nav
  view: View;
  goDashboard: () => void;
  goNewMapping: () => void;
  /** Navigate to the (optional) Google Drive connect screen. */
  goConnect: () => void;
  connection: ConnectionState;
  connect: () => void;
  /** In-app updater state + actions (sidebar affordance). */
  update: UpdateState;
  /** Manually re-check for a newer version. */
  checkForUpdate: () => void;
  /** Install the available update and relaunch. */
  installUpdate: () => void;
  libraryRoot: string;
  /** Open a native folder picker to choose where syncs land (the library root). */
  changeLibraryRoot: () => void;
  mappingCount: number;

  // auto-sync (global)
  settings: Settings;
  /** Effective cadence: 0 when auto-sync is off (master switch), else minutes. */
  autoIntervalMinutes: number;
  /** Set the global cadence; 0 turns the master switch off. */
  setAutoIntervalMinutes: (minutes: number) => void;

  // dashboard
  isEmpty: boolean;
  cards: MappingCard[];
  syncAll: () => void;

  // new mapping — source mode
  mode: SourceKind;
  setMode: (m: SourceKind) => void;
  folderIdInput: string;
  setFolderIdInput: (v: string) => void;
  listSource: () => void; // the "List" button
  listing: boolean;
  sourceFsLabel: string; // mono fs-label in the pane header
  sourceEmptyMsg: string;

  // new mapping — source tree
  sourceRows: TreeRow[];
  hasSourceRows: boolean;

  // new mapping — dest tree
  rootSelected: boolean;
  selectRoot: () => void;
  destRows: TreeRow[];
  destEmpty: boolean;
  showNewFolder: boolean;
  toggleNewFolder: () => void;
  newFolderInput: string;
  setNewFolderInput: (v: string) => void;
  createFolder: () => void;

  // new mapping — composer
  hasSource: boolean;
  sourceName: string;
  finalName: string;
  setFinalName: (v: string) => void;
  destPrefixLabel: string; // "<libraryRoot>/<destSel>/"
  addPair: () => void;
  exists: boolean;

  // new mapping — staged
  staged: StagedPair[];
  saveStaged: () => void;
  clearStaged: () => void;

  // run
  run: RunView | null;
}
