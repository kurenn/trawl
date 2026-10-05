//! `trawl-cli sync <id>` — run one mapping's sync to completion, headless.
//!
//! Shape: run-lock -> engine (rclone or pCloud) -> throttled progress-file
//! callback -> signal-cancel -> `persist_run_result` -> remove progress file.
//! Mirrors `src-tauri/src/commands.rs::trigger_sync`, minus the Tauri event
//! bus (there's no UI to stream to) and minus the app's own in-process
//! concurrency bookkeeping (the cross-process run-lock already does that job
//! here, for both the CLI and the app).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use trawl_core::models::{Mapping, MappingStatus, ProgressFn, RunProgress, SourceProvider};
use trawl_core::{locks, pcloud, rclone, store};

/// Runs `mapping` to completion and returns the process exit code (0
/// succeeded/cancelled, 1 failed/any error — see module docs in `main.rs`).
///
/// `mapping` must already be validated (a safe id that exists in
/// `mappings_file`) — that happens in `main.rs` before this is ever called.
pub fn run(app_data_dir: PathBuf, mappings_file: PathBuf, run_dir: PathBuf, mapping: Mapping) -> i32 {
    let lock = match locks::try_run_lock(&run_dir, &mapping.id) {
        Ok(Some(f)) => f,
        Ok(None) => {
            eprintln!("trawl-cli: mapping '{}' is already syncing", mapping.id);
            return 1;
        }
        Err(e) => {
            eprintln!("trawl-cli: {e}");
            return 1;
        }
    };

    let progress_path = match locks::progress_file(&run_dir, &mapping.id) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("trawl-cli: {e}");
            drop(lock);
            return 1;
        }
    };

    let rt = match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("trawl-cli: cannot start async runtime: {e}");
            drop(lock);
            return 1;
        }
    };

    let exit_code = rt.block_on(run_async(app_data_dir, mappings_file, progress_path, mapping));

    // Never rely on runtime teardown to release the lock — drop it explicitly
    // right here, then the caller does `std::process::exit`.
    drop(lock);
    exit_code
}

async fn run_async(
    app_data_dir: PathBuf,
    mappings_file: PathBuf,
    progress_path: PathBuf,
    mapping: Mapping,
) -> i32 {
    let run_id = chrono::Utc::now().timestamp_millis();
    let jobs: Arc<tokio::sync::Mutex<HashMap<i64, rclone::Job>>> =
        Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    // Never shared across tasks (only read/written within this function's own
    // select loop below), so a plain `AtomicBool` needs no `Arc` around it.
    let signalled = AtomicBool::new(false);

    // Resolve the destination off the async executor, bounded so a wedged
    // network mount can't hang the run before it even starts.
    let dest_result = {
        let library_root = store::read_library_root(&app_data_dir);
        let dest_path = mapping.dest_path.clone();
        let dest_subpath = mapping.dest_subpath.clone();
        tokio::task::spawn_blocking(move || {
            rclone::with_timeout(rclone::DEST_CHECK_TIMEOUT, move || {
                store::effective_dest(&library_root, &dest_path, &dest_subpath)
            })
        })
        .await
        .ok()
        .flatten()
    };

    let dest_abs = match dest_result {
        Some(Ok(p)) => p,
        Some(Err(e)) => {
            return finalize(&mappings_file, &progress_path, failed_progress(&mapping, run_id, e), false)
                .await;
        }
        None => {
            return finalize(
                &mappings_file,
                &progress_path,
                failed_progress(&mapping, run_id, "Destination resolution timed out".to_string()),
                false,
            )
            .await;
        }
    };

    // Progress-file emitter: first snapshot written immediately, after that at
    // most once per second (rclone/pCloud call this far more often than that).
    let last_write: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    let progress_path_cb = progress_path.clone();
    let emit: ProgressFn = Arc::new(move |p: &RunProgress| {
        let now = Instant::now();
        let due = {
            let mut guard = last_write.lock().unwrap();
            let due = guard.map(|last| now.duration_since(last) >= Duration::from_secs(1)).unwrap_or(true);
            if due {
                *guard = Some(now);
            }
            due
        };
        if due {
            if let Ok(json) = serde_json::to_vec_pretty(p) {
                let _ = store::atomic_write(&progress_path_cb, &json);
            }
        }
    });

    let run_future = run_mapping(emit, Arc::clone(&jobs), mapping, dest_abs, run_id);
    tokio::pin!(run_future);

    // Signal handlers are installed BEFORE the select loop ever polls the run
    // future, so a signal that arrives before the rclone/pCloud job is even
    // registered is never missed — the 250ms ticker below keeps retrying
    // cancel() until it lands.
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("install SIGTERM handler");
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .expect("install SIGINT handler");
    let mut ticker = tokio::time::interval(Duration::from_millis(250));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    let progress = loop {
        tokio::select! {
            // Biased: a process-group-wide signal (the Ctrl-C shape) can kill
            // the rclone child directly AND resolve `run_future` in the very
            // same instant the signal arrives here. Checking the signal
            // branches first means that if both are ready in the same poll,
            // the signal always wins instead of a coin-flip.
            biased;
            _ = sigterm.recv() => {
                signalled.store(true, Ordering::SeqCst);
                rclone::cancel(Arc::clone(&jobs), run_id).await;
            }
            _ = sigint.recv() => {
                signalled.store(true, Ordering::SeqCst);
                rclone::cancel(Arc::clone(&jobs), run_id).await;
            }
            p = &mut run_future => break p,
            _ = ticker.tick() => {
                if signalled.load(Ordering::SeqCst) {
                    rclone::cancel(Arc::clone(&jobs), run_id).await;
                }
            }
        }
    };

    // Belt-and-suspenders for the same race: a process-group-wide signal
    // kills the rclone child directly (the kernel's default disposition,
    // applied the instant the signal is delivered) while OUR OWN copy of
    // that same signal still has to travel through tokio's async signal
    // plumbing (handler -> self-pipe -> reactor -> task wakeup) — a real
    // round trip that can easily lose a footrace against a child dying
    // outright, especially under load. So: a run that finished anything
    // other than Succeeded, with no signal observed yet, gets one short,
    // bounded wait for a signal that may simply not have arrived here yet.
    // Real (non-raced) failures just pay a small fixed delay before exiting.
    if !signalled.load(Ordering::SeqCst) && !matches!(progress.status, MappingStatus::Succeeded) {
        tokio::select! {
            _ = sigterm.recv() => { signalled.store(true, Ordering::SeqCst); }
            _ = sigint.recv() => { signalled.store(true, Ordering::SeqCst); }
            _ = tokio::time::sleep(Duration::from_millis(300)) => {}
        }
    }

    finalize(&mappings_file, &progress_path, progress, signalled.load(Ordering::SeqCst)).await
}

/// Dispatches to the right engine for the mapping's provider. Gdrive re-reads
/// the live remote name on every run (`rclone::detect_connection`) rather
/// than caching it — the CLI has no long-lived state to keep it fresh in.
async fn run_mapping(
    emit: ProgressFn,
    jobs: Arc<tokio::sync::Mutex<HashMap<i64, rclone::Job>>>,
    mapping: Mapping,
    dest_abs: PathBuf,
    run_id: i64,
) -> RunProgress {
    match mapping.source_provider {
        SourceProvider::Gdrive => {
            let remote = tokio::task::spawn_blocking(|| rclone::detect_connection("gdrive").remote)
                .await
                .unwrap_or_else(|_| "gdrive".to_string());
            rclone::run_sync(emit, jobs, remote, mapping, dest_abs, run_id).await
        }
        SourceProvider::Pcloud => {
            let host = mapping.source_host.clone().unwrap_or_default();
            let code = mapping.source_id.clone().unwrap_or_default();
            pcloud::run_pcloud_sync(emit, jobs, host, code, mapping, dest_abs, run_id).await
        }
    }
}

fn failed_progress(mapping: &Mapping, run_id: i64, msg: String) -> RunProgress {
    RunProgress {
        run_id,
        mapping_id: mapping.id.clone(),
        name: mapping.source_name.clone(),
        src: mapping.src_label.clone(),
        dest: mapping.dest_path.clone(),
        status: MappingStatus::Failed,
        bytes_done: 0,
        bytes_total: 0,
        files_done: 0,
        files_total: 0,
        speed: 0.0,
        eta_sec: 0.0,
        log: Vec::new(),
        error: Some(msg),
    }
}

/// Persists the final result and removes the progress file, exactly once,
/// regardless of outcome. If a signal was received and the engine didn't
/// already land on Succeeded, the result is reported as Cancelled (with no
/// error) rather than whatever the engine happened to finalize as — a child
/// killed by an external SIGTERM (the Ctrl-C/process-group shape) may finish
/// as a bare "Failed", but a signalled run is a cancellation, not a failure.
async fn finalize(
    mappings_file: &Path,
    progress_path: &Path,
    mut progress: RunProgress,
    signalled: bool,
) -> i32 {
    if signalled && !matches!(progress.status, MappingStatus::Succeeded) {
        progress.status = MappingStatus::Cancelled;
        progress.error = None;
    }

    let mappings_file = mappings_file.to_path_buf();
    let persisted = progress.clone();
    let _ = tokio::task::spawn_blocking(move || store::persist_run_result(&mappings_file, &persisted))
        .await;

    let _ = std::fs::remove_file(progress_path);

    match progress.status {
        MappingStatus::Succeeded | MappingStatus::Cancelled => 0,
        _ => 1,
    }
}
