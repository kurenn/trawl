// tray.rs — system-tray integration for Trawl (Tauri v2).
//
// Two public entry-points called from lib.rs:
//   tray::build_tray(app.handle())               → called inside .setup()
//   tray::on_window_event(window, event)          → called inside .on_window_event()
//
// Tauri v2 API notes (version-sensitive, double-check on build failure):
//   - tauri::tray::TrayIconBuilder  (not tray::SystemTray)
//   - tauri::menu::{Menu, MenuItem, PredefinedMenuItem}
//   - app.get_webview_window("main")  (WebviewWindow, not Window)
//   - WindowEvent::CloseRequested { api, .. }  (same as v1 but re-exported path)

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

use crate::commands::AppState;
use crate::store;

/// Build the tray icon and attach its menu event handler.
/// Called once from `.setup()` in lib.rs.
pub fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    // ── Build the drop-down menu ──────────────────────────────────────────────
    let open_item = MenuItem::with_id(app, "open", "Open Trawl", true, None::<&str>)?;
    let sync_all_item = MenuItem::with_id(app, "sync_all", "Sync all now", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Trawl", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open_item, &sync_all_item, &separator, &quit_item])?;

    // ── Build the tray icon ───────────────────────────────────────────────────
    // Use the application's default window icon so the tray matches the dock.
    // If no icon is bundled, TrayIconBuilder::build returns an error — that is
    // intentional: a tray without an icon is invisible on macOS.
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("default window icon".to_string()))?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Trawl")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "sync_all" => {
                // Skip entirely while disconnected (don't queue doomed runs).
                let state = app.state::<AppState>();
                let connected = state
                    .connection
                    .lock()
                    .map(|c| matches!(c.phase, crate::models::ConnectionPhase::Connected))
                    .unwrap_or(false);
                if connected {
                    // Fire a sync per enabled mapping. trigger_sync registers the
                    // mapping and returns; the global semaphore caps how many
                    // actually transfer at once, so this can't burst.
                    let mappings = store::load_mappings(&state.mappings_file);
                    for m in mappings.into_iter().filter(|m| m.enabled) {
                        let app2 = app.clone();
                        let id = m.id.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = crate::commands::trigger_sync(app2, id).await;
                        });
                    }
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    // Tauri keeps the TrayIcon alive internally — dropping _tray here is fine
    // because TrayIconBuilder::build registers it with the app runtime.
    Ok(())
}

/// Forward window events from lib.rs's `.on_window_event` closure.
/// Hides the main window instead of closing it when `minimize_to_tray` is on.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();

        // Read the setting and drop the MutexGuard immediately — we must not
        // hold it across any suspension point or into the hide() call.
        let minimize = app
            .state::<AppState>()
            .settings
            .lock()
            .unwrap()
            .minimize_to_tray;

        if minimize {
            // Intercept the close and hide instead.
            api.prevent_close();
            let _ = window.hide();
        }
        // If minimize == false, do nothing: the event propagates and the
        // window (and app, if it's the last one) closes normally.
    }
}
