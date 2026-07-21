/* ============================================================================
   Trawl — API selection.
   Under the Tauri runtime, use the real backend (invoke + events). In a plain
   browser (Vite dev / design QA), fall back to the simulation adapter so the
   entire UI is exercisable without a live Google Drive.

   Backend command names (Rust #[tauri::command]) the real adapter must call:
     detect_connection, connect_drive, get_library_root, pick_library_root,
     list_source_folders, resolve_source_name, list_local_folders,
     create_local_folder, local_path_exists, load_mappings, save_mappings,
     delete_mapping, start_sync, cancel_sync
   Streamed event: "run://update" carrying RunProgress.
   ============================================================================ */

import type { Api } from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let cached: Promise<Api> | null = null;

/** Resolve the active API adapter (memoized). */
export function getApi(): Promise<Api> {
  if (!cached) {
    cached = isTauri()
      ? import("./tauri/tauriApi").then((m) => m.tauriApi)
      : import("./sim/simApi").then((m) => m.simApi);
  }
  return cached;
}
