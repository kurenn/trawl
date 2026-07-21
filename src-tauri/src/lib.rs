pub mod commands;
pub mod models;
pub mod pcloud;
pub mod rclone;
pub mod scheduler;
pub mod store;
pub mod tray;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Resolve the platform-appropriate app data directory.
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            let state = AppState::new(&app_data_dir);
            app.manage(state);

            // System tray (menu bar) icon + menu.
            if let Err(e) = tray::build_tray(app.handle()) {
                eprintln!("failed to build tray: {e}");
            }

            // Background auto-sync scheduler — ticks while the app is running
            // (window open or in the tray) and pulls due mappings.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(scheduler::run_scheduler(handle));

            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray: hide instead of quitting when enabled.
            tray::on_window_event(window, event);
        })
        .invoke_handler(tauri::generate_handler![
            commands::detect_connection,
            commands::connect_drive,
            commands::get_library_root,
            commands::pick_library_root,
            commands::list_source_folders,
            commands::resolve_source_name,
            commands::list_local_folders,
            commands::create_local_folder,
            commands::local_path_exists,
            commands::load_mappings,
            commands::save_mappings,
            commands::delete_mapping,
            commands::set_mapping_auto_sync,
            commands::set_mapping_skip_shortcuts,
            commands::get_settings,
            commands::set_settings,
            commands::start_sync,
            commands::cancel_sync,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {
            // macOS: clicking the Dock icon after close-to-tray re-opens the
            // window (otherwise a hidden-only window is hard to get back).
            // `Reopen` is a macOS-only `RunEvent` variant, so this handler must
            // be gated — matching it unconditionally fails to compile elsewhere.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                if let Some(w) = _app_handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
        });
}
