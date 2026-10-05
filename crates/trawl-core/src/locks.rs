//! Cross-process locking for Trawl.
//!
//! Two independent lock domains live here:
//!
//! - [`lock_mappings`]: a single `<file>.lock` serializes every
//!   read-modify-write of `mappings.json`, across both processes (an
//!   OS-level `flock`) and threads within one process (`flock` is scoped to
//!   an open file description, so two threads opening the lock file
//!   separately still serialize against each other).
//! - the run-lock family ([`try_run_lock`], [`is_running`], [`running_count`]):
//!   one `<run_dir>/<id>.lock` per mapping id gives an exclusive, crash-safe
//!   "is this mapping syncing right now" flag — crash-safe because the OS
//!   releases the flock the moment the holding process exits, with nothing to
//!   clean up. Lock files are never deleted, which avoids an unlink-then-recreate
//!   race between a holder and a prober.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Blocking cross-process + cross-thread lock for `mappings.json`. Opens (or
/// creates) `<file>.lock` next to `file`, creating the parent directory if
/// needed, and blocks until an exclusive lock is acquired. The returned
/// `File` holds the lock for as long as it lives — drop it to release.
///
/// Never returns an unlocked handle: on any IO error this returns `Err`
/// instead, so a caller can never fall through to an unlocked write.
pub fn lock_mappings(file: &Path) -> Result<File, String> {
    let lock_path = lock_path_for(file);
    if let Some(dir) = lock_path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Cannot create config dir: {e}"))?;
    }
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false) // lock files carry no content worth keeping or wiping
        .open(&lock_path)
        .map_err(|e| format!("Cannot open mappings lock file: {e}"))?;
    f.lock()
        .map_err(|e| format!("Cannot acquire mappings lock: {e}"))?;
    Ok(f)
}

fn lock_path_for(file: &Path) -> PathBuf {
    let mut name = file.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".lock");
    file.with_file_name(name)
}

/// Directory holding run lock/progress files, creating it (mode 0700 on
/// unix) if missing: `$XDG_RUNTIME_DIR/trawl` when that's set and non-empty,
/// else `<app_data_dir>/run`.
pub fn run_dir(app_data_dir: &Path) -> Result<PathBuf, String> {
    let xdg = std::env::var("XDG_RUNTIME_DIR").ok();
    let dir = run_dir_from(xdg.as_deref(), app_data_dir);
    create_run_dir(&dir)?;
    Ok(dir)
}

/// Pure path-selection half of [`run_dir`], usable in tests without mutating
/// the process environment.
pub fn run_dir_from(xdg_runtime_dir: Option<&str>, app_data_dir: &Path) -> PathBuf {
    match xdg_runtime_dir {
        Some(x) if !x.is_empty() => Path::new(x).join("trawl"),
        _ => app_data_dir.join("run"),
    }
}

#[cfg(unix)]
fn create_run_dir(dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| format!("Cannot create run dir: {e}"))
}

#[cfg(not(unix))]
fn create_run_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create run dir: {e}"))
}

/// A run/mapping id is safe to use as a filename component: 1-64 characters,
/// each an ASCII letter, digit, or hyphen.
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The progress-snapshot file for `id` inside `run_dir`. Rejects an unsafe
/// `id` with `Err` before touching the filesystem.
pub fn progress_file(run_dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_valid_id(id) {
        return Err(format!("Invalid run id: {id:?}"));
    }
    Ok(run_dir.join(format!("{id}.json")))
}

/// Attempts to claim the exclusive run lock for `id` inside `run_dir`.
///
/// - `Ok(Some(file))`: claimed — the lock is held for as long as `file` lives.
/// - `Ok(None)`: held by someone else.
/// - `Err`: invalid id, or an IO error opening/locking the file.
///
/// A `WouldBlock` is retried up to 5 times, 20ms apart, before reporting
/// "held": a probe ([`is_running`] / [`running_count`]) only holds the lock
/// for microseconds, so a real claim should not lose a race against one.
pub fn try_run_lock(run_dir: &Path, id: &str) -> Result<Option<File>, String> {
    if !is_valid_id(id) {
        return Err(format!("Invalid run id: {id:?}"));
    }
    let path = run_dir.join(format!("{id}.lock"));
    let f = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false) // lock files carry no content worth keeping or wiping
        .open(&path)
        .map_err(|e| format!("Cannot open run lock: {e}"))?;

    const ATTEMPTS: u32 = 5;
    for attempt in 0..ATTEMPTS {
        match f.try_lock() {
            Ok(()) => return Ok(Some(f)),
            Err(TryLockError::WouldBlock) => {
                if attempt + 1 < ATTEMPTS {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            Err(TryLockError::Error(e)) => return Err(format!("Cannot acquire run lock: {e}")),
        }
    }
    Ok(None)
}

/// True if `id`'s run lock is currently held by anyone (this process or
/// another). Opens the lock file without creating it — a mapping that has
/// never run has no lock file yet and correctly reports not-running.
pub fn is_running(run_dir: &Path, id: &str) -> bool {
    if !is_valid_id(id) {
        return false;
    }
    let path = run_dir.join(format!("{id}.lock"));
    let Ok(f) = OpenOptions::new().read(true).open(&path) else {
        return false; // no lock file yet => never run => not running
    };
    match f.try_lock() {
        Ok(()) => false, // we could claim it => nobody else holds it
        Err(TryLockError::WouldBlock) => true,
        Err(TryLockError::Error(_)) => false,
    }
}

/// Counts how many of `ids` currently have their run lock held.
pub fn running_count<S: AsRef<str>>(run_dir: &Path, ids: &[S]) -> usize {
    ids.iter().filter(|id| is_running(run_dir, id.as_ref())).count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "trawl_locks_test_{label}_{}_{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn run_lock_is_exclusive_and_released_on_drop() {
        let dir = unique_temp_dir("exclusive");
        fs::create_dir_all(&dir).unwrap();

        let first = try_run_lock(&dir, "abc").unwrap();
        assert!(first.is_some(), "first claim should succeed");

        let second = try_run_lock(&dir, "abc").unwrap();
        assert!(second.is_none(), "second claim must not succeed while held");

        drop(first);

        let third = try_run_lock(&dir, "abc").unwrap();
        assert!(third.is_some(), "claim must succeed after the holder drops it");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_running_reports_held_lock() {
        let dir = unique_temp_dir("is_running");
        fs::create_dir_all(&dir).unwrap();

        assert!(!is_running(&dir, "xyz"), "no lock file yet => not running");

        let held = try_run_lock(&dir, "xyz").unwrap().expect("claim should succeed");
        assert!(is_running(&dir, "xyz"), "lock is held => running");

        drop(held);
        assert!(!is_running(&dir, "xyz"), "released => not running");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_paths_reject_unsafe_ids() {
        let dir = unique_temp_dir("unsafe_ids");
        fs::create_dir_all(&dir).unwrap();

        let too_long = "a".repeat(65);
        for bad in ["", "../etc", "has space", "has/slash", too_long.as_str()] {
            assert!(try_run_lock(&dir, bad).is_err(), "should reject id {bad:?}");
            assert!(progress_file(&dir, bad).is_err(), "should reject id {bad:?}");
            assert!(!is_running(&dir, bad), "an unsafe id is never reported as running");
        }

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_dir_prefers_xdg_runtime_dir() {
        let app_data = Path::new("/tmp/trawl-app-data-example");
        assert_eq!(
            run_dir_from(Some("/run/user/1000"), app_data),
            PathBuf::from("/run/user/1000/trawl")
        );
        assert_eq!(run_dir_from(Some(""), app_data), app_data.join("run"));
        assert_eq!(run_dir_from(None, app_data), app_data.join("run"));
    }

    #[test]
    fn try_run_lock_survives_concurrent_probe() {
        let dir = unique_temp_dir("concurrent_probe");
        fs::create_dir_all(&dir).unwrap();

        // Hold one lock so the prober thread has something real to contend
        // for, not a vacuous try_lock against a nonexistent file.
        let probe_target = try_run_lock(&dir, "probe-target").unwrap().unwrap();

        let stop = Arc::new(AtomicBool::new(false));
        let stop_probe = Arc::clone(&stop);
        let probe_dir = dir.clone();
        let prober = thread::spawn(move || {
            while !stop_probe.load(Ordering::Relaxed) {
                let _ = is_running(&probe_dir, "probe-target");
            }
        });

        let mut claims = Vec::new();
        for i in 0..100 {
            let id = format!("job-{i}");
            let claimed = try_run_lock(&dir, &id).unwrap();
            assert!(claimed.is_some(), "claim {i} must succeed despite concurrent probing");
            claims.push(claimed);
        }

        stop.store(true, Ordering::Relaxed);
        prober.join().unwrap();
        drop(probe_target);

        let _ = fs::remove_dir_all(&dir);
    }
}
