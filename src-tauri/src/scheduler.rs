//! Background auto-sync scheduler for Trawl.
//!
//! This module runs a single in-process loop that fires on a coarse 30-second
//! ticker and decides which mappings are due for a sync run. There is no OS
//! cron involvement: the scheduler is spawned at app startup by `lib.rs` via
//! `tauri::async_runtime::spawn(scheduler::run_scheduler(handle))`.
//!
//! # Design rationale
//!
//! Polling (rather than watching) is the only practical change-detection
//! strategy for Google Drive → local sync on a desktop app: Drive's push
//! notifications require a public HTTPS endpoint, and the rclone backend has
//! no persistent watch capability. Each sync uses `rclone copy`, which is
//! incremental — only changed/new files are transferred per run — so running
//! on a cadence is cheap when nothing has changed.

use std::collections::HashSet;
use std::time::Duration;

use tauri::Manager;
use trawl_core::schedule;

use crate::commands::{self, AppState};
use crate::models::{ConnectionPhase, SourceProvider};
use crate::{rclone, store};

/// The main scheduler loop. Runs forever (until the Tauri runtime drops the
/// spawned task). Ticks every 30 seconds; each tick evaluates whether any
/// auto-sync-enabled mappings are due and fires them, staggered by 1 second
/// each to avoid Drive rate-limit bursts.
pub async fn run_scheduler(app: tauri::AppHandle) {
    let mut ticker = tokio::time::interval(Duration::from_secs(30));
    // After a long stagger overruns the period, don't fire a burst of catch-up
    // ticks — just resume the cadence from now.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;

        // ── 1. Snapshot shared state WITHOUT holding guards across awaits ──────
        let state = app.state::<AppState>();
        let settings = match state.settings.lock() {
            Ok(g) => g.clone(),
            Err(e) => {
                eprintln!("[scheduler] settings lock poisoned: {e}");
                continue;
            }
        };
        // Skip everything (including the connection probe) when paused.
        if !settings.auto_sync_enabled {
            drop(state);
            continue;
        }
        let mappings = store::load_mappings(&state.mappings_file);
        // Nothing to do (and nothing to probe) if no mapping is auto-enabled.
        if !mappings.iter().any(|m| m.enabled && m.auto_sync) {
            drop(state);
            continue;
        }
        let remote = state.remote.lock().map(|g| g.clone()).unwrap_or_default();
        let active_snapshot: HashSet<String> = match state.active_mappings.lock() {
            Ok(g) => g.clone(),
            Err(e) => {
                eprintln!("[scheduler] active_mappings lock poisoned: {e}");
                continue;
            }
        };
        // Only GOOGLE DRIVE mappings depend on the rclone connection; pCloud
        // public links sync anonymously and never need a connection.
        let has_gdrive_auto = mappings
            .iter()
            .any(|m| m.enabled && m.auto_sync && m.source_provider == SourceProvider::Gdrive);
        drop(state); // release the State borrow before awaits

        // ── 2. Re-probe the Drive connection (only if a Drive mapping needs it)
        //       so a sleep/wake or removed-remote actually pauses Drive auto-sync
        //       (the cached value would otherwise go stale). ──
        let gdrive_connected = if has_gdrive_auto {
            match tauri::async_runtime::spawn_blocking({
                let remote = remote.clone();
                move || rclone::detect_connection(&remote)
            })
            .await
            {
                Ok(conn) => {
                    if let Ok(mut c) = app.state::<AppState>().connection.lock() {
                        *c = conn.clone();
                    }
                    conn.phase == ConnectionPhase::Connected
                }
                Err(_) => false,
            }
        } else {
            false // no Drive mapping is due — value is unused
        };

        let now = chrono::Utc::now();

        // ── 3. Evaluate each mapping ───────────────────────────────────────────
        for mapping in mappings {
            if !mapping.enabled || !mapping.auto_sync {
                continue;
            }

            // Skip if a run for this mapping is already in flight.
            if active_snapshot.contains(&mapping.id) {
                continue;
            }

            // Drive mappings are paused while Drive is disconnected; pCloud
            // mappings sync regardless (anonymous public links).
            if mapping.source_provider == SourceProvider::Gdrive && !gdrive_connected {
                continue;
            }

            // Determine whether this mapping is due for a sync — shared with
            // the CLI so both agree on exactly when a mapping is due.
            if !schedule::is_due(&mapping, &settings, now) {
                continue;
            }

            // Spawn the sync (trigger_sync returns as soon as the rclone job
            // is registered — the actual transfer runs in a separate task).
            let _ = commands::trigger_sync(app.clone(), mapping.id.clone()).await;

            // Stagger subsequent launches to avoid a thundering-herd burst
            // against Drive's API rate limits.
            tokio::time::sleep(Duration::from_millis(1_000)).await;
        }
    }
}
