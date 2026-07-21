/* ============================================================================
   Trawl — real Tauri adapter.
   Thin bridge from the Api interface to Tauri's invoke() + event bus.
   All business logic lives in the Rust backend; this file is just wiring.
   ============================================================================ */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  Api,
  ConnectionState,
  FolderNode,
  ListSourceArgs,
  Mapping,
  NewMapping,
  RunProgress,
  Settings,
  SourceKind,
  SourceProvider,
} from "../types";

/* ---------------------------------------------------------------------------
   tauriApi implementation
   --------------------------------------------------------------------------- */

const tauriApiImpl: Api = {
  isReal: true,

  // ---------- connection ----------

  detectConnection(): Promise<ConnectionState> {
    return invoke<ConnectionState>("detect_connection");
  },

  connectDrive(): Promise<ConnectionState> {
    return invoke<ConnectionState>("connect_drive");
  },

  // ---------- library root ----------

  getLibraryRoot(): Promise<string> {
    return invoke<string>("get_library_root");
  },

  pickLibraryRoot(): Promise<string | null> {
    return invoke<string | null>("pick_library_root");
  },

  // ---------- folder listings ----------

  listSourceFolders(args: ListSourceArgs): Promise<FolderNode[]> {
    return invoke<FolderNode[]>("list_source_folders", { args });
  },

  resolveSourceName(
    provider: SourceProvider,
    kind: SourceKind,
    sourceId: string | null,
    host: string | null,
  ): Promise<string> {
    return invoke<string>("resolve_source_name", { provider, kind, sourceId, host });
  },

  listLocalFolders(subpath: string): Promise<FolderNode[]> {
    return invoke<FolderNode[]>("list_local_folders", { subpath });
  },

  createLocalFolder(subpath: string): Promise<{ ok: boolean; error?: string }> {
    return invoke<{ ok: boolean; error?: string }>("create_local_folder", {
      subpath,
    });
  },

  localPathExists(subpath: string): Promise<boolean> {
    return invoke<boolean>("local_path_exists", { subpath });
  },

  // ---------- mappings persistence ----------

  loadMappings(): Promise<Mapping[]> {
    return invoke<Mapping[]>("load_mappings");
  },

  saveMappings(mappings: NewMapping[]): Promise<Mapping[]> {
    return invoke<Mapping[]>("save_mappings", { mappings });
  },

  deleteMapping(id: string): Promise<void> {
    return invoke<void>("delete_mapping", { id });
  },

  setMappingAutoSync(id: string, auto: boolean): Promise<Mapping[]> {
    return invoke<Mapping[]>("set_mapping_auto_sync", { id, auto });
  },

  setMappingSkipShortcuts(id: string, skip: boolean): Promise<Mapping[]> {
    return invoke<Mapping[]>("set_mapping_skip_shortcuts", { id, skip });
  },

  // ---------- settings ----------

  getSettings(): Promise<Settings> {
    return invoke<Settings>("get_settings");
  },

  setSettings(settings: Settings): Promise<Settings> {
    return invoke<Settings>("set_settings", { settings });
  },

  async onStateChanged(cb: () => void): Promise<() => void> {
    const unlisten = await listen("state://changed", () => cb());
    return () => unlisten();
  },

  // ---------- runs ----------

  startSync(mappingId: string): Promise<number> {
    return invoke<number>("start_sync", { mappingId });
  },

  cancelSync(runId: number): Promise<void> {
    return invoke<void>("cancel_sync", { runId });
  },

  async onRunUpdate(cb: (p: RunProgress) => void): Promise<() => void> {
    const unlisten = await listen<RunProgress>("run://update", (e) =>
      cb(e.payload),
    );
    return () => unlisten();
  },
};

export const tauriApi: Api = tauriApiImpl;
