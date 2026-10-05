//! Integration tests for `trawl-cli`, driving the real built binary against a
//! fake `rclone` and a throwaway `XDG_DATA_HOME`/`XDG_RUNTIME_DIR`.
//!
//! Linux-only: macOS ignores `XDG_DATA_HOME`, so on macOS the binary would
//! read/write the real `~/Library/Application Support/com.trawl.app` instead
//! of the test's sandbox.
#![cfg(target_os = "linux")]

use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use trawl_core::locks;
use trawl_core::models::{Mapping, MappingStatus, RunProgress, SourceKind, SourceProvider};

// ─── Fake rclone ──────────────────────────────────────────────────────────
//
// Answers `listremotes` with a single Drive remote named "gdrive". For
// `copy` it logs its argv (space-joined) to $RCLONE_ARGSFILE and its own pid
// to $RCLONE_PIDFILE, emits one rclone-shaped JSON stats line to stderr, then
// either `exec sleep 30` (when $RCLONE_SLEEP is set — so a signal has
// something real to cancel) or exits with $RCLONE_EXIT_CODE (default 0).
const FAKE_RCLONE_SH: &str = r#"#!/bin/sh
case "$1" in
  listremotes)
    echo "gdrive:  drive"
    exit 0
    ;;
esac

if [ -n "${RCLONE_ARGSFILE:-}" ]; then
  printf '%s\n' "$*" > "$RCLONE_ARGSFILE"
fi
if [ -n "${RCLONE_PIDFILE:-}" ]; then
  echo "$$" > "$RCLONE_PIDFILE"
fi

>&2 echo '{"level":"notice","msg":"","stats":{"bytes":123,"totalBytes":123,"transfers":1,"totalTransfers":1,"speed":1.0,"eta":0,"errors":0}}'

if [ -n "${RCLONE_SLEEP:-}" ]; then
  exec sleep 30
fi
exit "${RCLONE_EXIT_CODE:-0}"
"#;

// ─── Harness ──────────────────────────────────────────────────────────────

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Base directory for per-test harness roots: next to the built binaries
/// (same filesystem as `CARGO_BIN_EXE_trawl-cli`), NOT the system temp dir —
/// `/tmp` is commonly a separate tmpfs mount, and copying the exe there then
/// exec-ing it immediately is a known flaky combination (transient
/// `ExecutableFileBusy` across the copy/exec boundary on some filesystems).
/// Hard-linking the exe here instead sidesteps that: it only adds a
/// directory entry to an inode that was fully written and closed long ago by
/// the build, so there's never a "just closed, about to exec" race.
fn harness_base() -> PathBuf {
    Path::new(env!("CARGO_BIN_EXE_trawl-cli"))
        .parent()
        .expect("CARGO_BIN_EXE_trawl-cli has a parent directory")
        .join("trawl-cli-it")
}

fn unique_dir(label: &str) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    harness_base().join(format!("{label}_{}_{nanos}_{n}", std::process::id()))
}

struct Harness {
    root: PathBuf,
    bin: PathBuf,
    data_home: PathBuf,
    runtime_dir: PathBuf,
    app_data_dir: PathBuf,
    mappings_file: PathBuf,
    argsfile: PathBuf,
    pidfile: PathBuf,
}

impl Harness {
    fn new(label: &str) -> Self {
        let root = unique_dir(label);
        let bin_dir = root.join("bin");
        let data_home = root.join("data");
        let runtime_dir = root.join("runtime");
        fs::create_dir_all(&bin_dir).unwrap();
        fs::create_dir_all(&data_home).unwrap();
        fs::create_dir_all(&runtime_dir).unwrap();

        let bin = bin_dir.join("trawl-cli");
        fs::hard_link(env!("CARGO_BIN_EXE_trawl-cli"), &bin).unwrap();

        let rclone_path = bin_dir.join("rclone");
        fs::write(&rclone_path, FAKE_RCLONE_SH).unwrap();
        let mut perms = fs::metadata(&rclone_path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&rclone_path, perms).unwrap();

        let app_data_dir = data_home.join("com.trawl.app");
        fs::create_dir_all(&app_data_dir).unwrap();
        let mappings_file = app_data_dir.join("mappings.json");

        let argsfile = root.join("rclone_args.txt");
        let pidfile = root.join("rclone_pid.txt");

        Harness {
            root,
            bin,
            data_home,
            runtime_dir,
            app_data_dir,
            mappings_file,
            argsfile,
            pidfile,
        }
    }

    fn write_mappings(&self, mappings: &[Mapping]) {
        fs::write(&self.mappings_file, serde_json::to_vec_pretty(mappings).unwrap()).unwrap();
    }

    /// The run dir the CLI will compute for this harness's XDG_RUNTIME_DIR —
    /// a pure path computation; doesn't create anything.
    fn run_dir(&self) -> PathBuf {
        locks::run_dir_from(Some(self.runtime_dir.to_str().unwrap()), &self.app_data_dir)
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut cmd = Command::new(&self.bin);
        cmd.args(args)
            .env("XDG_DATA_HOME", &self.data_home)
            .env("XDG_RUNTIME_DIR", &self.runtime_dir)
            .env("RCLONE_ARGSFILE", &self.argsfile)
            .env("RCLONE_PIDFILE", &self.pidfile);
        cmd
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn test_mapping(id: &str, dest: &Path) -> Mapping {
    Mapping {
        id: id.to_string(),
        source_provider: SourceProvider::Gdrive,
        source_kind: SourceKind::FolderId,
        source_id: Some("folderid123".to_string()),
        source_host: None,
        source_subpath: String::new(),
        source_name: format!("Source {id}"),
        src_label: format!("gdrive:{id}"),
        dest_subpath: String::new(),
        dest_path: dest.display().to_string(),
        acknowledge_abuse: false,
        enabled: true,
        auto_sync: false,
        skip_shortcuts: false,
        protect_local_edits: false,
        last_status: MappingStatus::Idle,
        last_at: None,
        last_files: None,
        last_bytes: None,
        last_error: None,
    }
}

fn sample_progress(id: &str) -> RunProgress {
    RunProgress {
        run_id: 1,
        mapping_id: id.to_string(),
        name: "Test".to_string(),
        src: "src".to_string(),
        dest: "dest".to_string(),
        status: MappingStatus::Running,
        bytes_done: 1,
        bytes_total: 2,
        files_done: 1,
        files_total: 2,
        speed: 1.0,
        eta_sec: 1.0,
        log: Vec::new(),
        error: None,
    }
}

/// Polls the pidfile until it holds a parseable pid — `echo "$$" >
/// "$RCLONE_PIDFILE"` is a create-then-write, not atomic, so a bare
/// `.exists()` check can observe a truncated, momentarily-empty file.
fn read_pidfile(path: &Path, timeout: Duration) -> i32 {
    let start = Instant::now();
    loop {
        if let Ok(content) = fs::read_to_string(path) {
            if let Ok(pid) = content.trim().parse() {
                return pid;
            }
        }
        if start.elapsed() >= timeout {
            panic!("{path:?} never held a valid pid within {timeout:?}");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> Option<ExitStatus> {
    let start = Instant::now();
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Some(status);
        }
        if start.elapsed() >= timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn pid_alive(pid: i32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

fn load_mappings(path: &Path) -> Vec<Mapping> {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

// ─── AC12: `status --json` schema ────────────────────────────────────────

#[test]
fn status_json_schema() {
    let h = Harness::new("status_schema");
    let dest1 = h.root.join("dest1");
    let dest2 = h.root.join("dest2");

    let running_id = "running-id";
    let leftover_id = "leftover-id";

    h.write_mappings(&[test_mapping(running_id, &dest1), test_mapping(leftover_id, &dest2)]);

    let run_dir = h.run_dir();
    fs::create_dir_all(&run_dir).unwrap();

    // Hold the run lock for `running_id` — this is what "running" means.
    let held = locks::try_run_lock(&run_dir, running_id).unwrap().unwrap();

    let progress_path = locks::progress_file(&run_dir, running_id).unwrap();
    fs::write(&progress_path, serde_json::to_vec(&sample_progress(running_id)).unwrap()).unwrap();

    // A leftover progress file with NO lock held must be ignored.
    let leftover_path = locks::progress_file(&run_dir, leftover_id).unwrap();
    fs::write(&leftover_path, serde_json::to_vec(&sample_progress(leftover_id)).unwrap()).unwrap();

    let output = h.command(&["status", "--json"]).output().unwrap();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));

    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schema"], 1);

    let expected_keys: HashSet<&str> = [
        "id",
        "name",
        "provider",
        "src",
        "dest",
        "auto_sync",
        "enabled",
        "last_status",
        "last_at",
        "last_files",
        "last_bytes",
        "last_error",
        "running",
        "progress",
    ]
    .into_iter()
    .collect();

    let arr = value["mappings"].as_array().unwrap();
    assert_eq!(arr.len(), 2);
    for entry in arr {
        let obj = entry.as_object().unwrap();
        let keys: HashSet<&str> = obj.keys().map(|s| s.as_str()).collect();
        assert_eq!(keys, expected_keys, "unexpected key set for {entry}");
    }

    let running_entry = arr.iter().find(|e| e["id"] == running_id).unwrap();
    assert_eq!(running_entry["running"], true);
    assert!(running_entry["progress"].is_object(), "progress: {running_entry}");

    let leftover_entry = arr.iter().find(|e| e["id"] == leftover_id).unwrap();
    assert_eq!(leftover_entry["running"], false);
    assert!(leftover_entry["progress"].is_null());

    // `status` without --json prints the same JSON (assumption 10).
    let plain = h.command(&["status"]).output().unwrap();
    assert!(plain.status.success());
    let plain_value: serde_json::Value = serde_json::from_slice(&plain.stdout).unwrap();
    assert_eq!(plain_value["schema"], 1);

    drop(held);
}

// ─── AC13: `status` never touches destination paths ─────────────────────

#[test]
fn status_source_has_no_destination_io() {
    let src = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/status.rs")).unwrap();
    for needle in ["check_dest", "effective_dest", "resolve_dest", "canonicalize", "exists(", "metadata"] {
        assert!(!src.contains(needle), "status.rs must not contain {needle:?}");
    }
}

// ─── AC14: `sync <id>` end-to-end with fake rclone ───────────────────────

#[test]
fn sync_success_persists_and_cleans_up() {
    let h = Harness::new("sync_success");
    let dest = h.root.join("dest");
    let id = "sync-ok";
    h.write_mappings(&[test_mapping(id, &dest)]);

    let output = h.command(&["sync", id]).output().unwrap();
    assert!(output.status.success(), "stderr: {}", String::from_utf8_lossy(&output.stderr));

    let mappings = load_mappings(&h.mappings_file);
    let m = mappings.iter().find(|m| m.id == id).unwrap();
    assert_eq!(m.last_status, MappingStatus::Succeeded);
    assert!(m.last_files.is_some());

    let run_dir = h.run_dir();
    let progress_path = locks::progress_file(&run_dir, id).unwrap();
    assert!(!progress_path.exists(), "progress file should be removed after the run");
    assert!(locks::try_run_lock(&run_dir, id).unwrap().is_some(), "run lock should be free");

    let args = fs::read_to_string(&h.argsfile).unwrap();
    let tokens: Vec<&str> = args.split_whitespace().collect();
    assert_eq!(tokens.first().copied(), Some("copy"));
    assert!(
        !tokens.iter().any(|t| *t == "sync" || *t == "move" || t.starts_with("--delete")),
        "unexpected destructive flag in argv: {tokens:?}"
    );
}

// ─── AC14b: App/CLI serialize on mappings.json across processes ─────────

#[test]
fn sync_waits_for_mappings_lock() {
    let h = Harness::new("sync_waits_lock");
    let dest = h.root.join("dest");
    let id = "sync-wait";
    h.write_mappings(&[test_mapping(id, &dest)]);

    let before = fs::read(&h.mappings_file).unwrap();

    // Hold the cross-process mappings lock, as a concurrent app/CLI run would.
    let held = locks::lock_mappings(&h.mappings_file).unwrap();

    let mut child = h.command(&["sync", id]).spawn().unwrap();

    std::thread::sleep(Duration::from_secs(1));
    assert!(child.try_wait().unwrap().is_none(), "child should still be waiting on the mappings lock");

    let during = fs::read(&h.mappings_file).unwrap();
    assert_eq!(before, during, "mappings.json must be untouched while the lock is held");

    drop(held);

    let status = wait_for_exit(&mut child, Duration::from_secs(10)).expect("child should exit after lock release");
    assert!(status.success());

    let mappings = load_mappings(&h.mappings_file);
    let m = mappings.iter().find(|m| m.id == id).unwrap();
    assert_eq!(m.last_status, MappingStatus::Succeeded);
}

// ─── AC15: `sync` fails fast when run lock held ──────────────────────────

#[test]
fn sync_fails_fast_when_locked() {
    let h = Harness::new("sync_fails_fast");
    let dest = h.root.join("dest");
    let id = "sync-locked";
    h.write_mappings(&[test_mapping(id, &dest)]);

    let run_dir = h.run_dir();
    fs::create_dir_all(&run_dir).unwrap();
    let held = locks::try_run_lock(&run_dir, id).unwrap().unwrap();

    let before = fs::read(&h.mappings_file).unwrap();
    let start = Instant::now();
    let output = h.command(&["sync", id]).output().unwrap();
    let elapsed = start.elapsed();

    assert!(!output.status.success());
    assert!(elapsed < Duration::from_secs(2), "took {elapsed:?}");

    let after = fs::read(&h.mappings_file).unwrap();
    assert_eq!(before, after);

    drop(held);
}

// ─── AC16: SIGTERM cancels ────────────────────────────────────────────────

#[test]
fn sigterm_cancels_and_persists_cancelled() {
    let h = Harness::new("sigterm_cancel");
    let dest = h.root.join("dest");
    let id = "sync-sigterm";
    h.write_mappings(&[test_mapping(id, &dest)]);

    let mut cmd = h.command(&["sync", id]);
    cmd.env("RCLONE_SLEEP", "1");
    let mut child = cmd.spawn().unwrap();

    let rclone_pid = read_pidfile(&h.pidfile, Duration::from_secs(5));
    assert!(pid_alive(rclone_pid), "fake rclone should be alive before signalling");

    let status_kill = Command::new("kill").args(["-TERM", &child.id().to_string()]).status().unwrap();
    assert!(status_kill.success());

    let status = wait_for_exit(&mut child, Duration::from_secs(10)).expect("trawl-cli should exit after SIGTERM");
    assert!(status.success(), "a cancelled run should exit 0");
    assert!(!pid_alive(rclone_pid), "fake rclone should be dead after cancel");

    let run_dir = h.run_dir();
    let progress_path = locks::progress_file(&run_dir, id).unwrap();
    assert!(!progress_path.exists());

    let mappings = load_mappings(&h.mappings_file);
    let m = mappings.iter().find(|m| m.id == id).unwrap();
    assert_eq!(m.last_status, MappingStatus::Cancelled);
}

/// The Ctrl-C shape: SIGTERM delivered to the CLI's whole process group (as a
/// shell's Ctrl-C does), so the fake-rclone child dies from the signal
/// itself, not from our code's cancel()/kill(). Still must persist Cancelled.
#[test]
fn sigterm_to_process_group_also_persists_cancelled() {
    let h = Harness::new("sigterm_pgroup");
    let dest = h.root.join("dest");
    let id = "sync-pgroup";
    h.write_mappings(&[test_mapping(id, &dest)]);

    let mut cmd = h.command(&["sync", id]);
    cmd.env("RCLONE_SLEEP", "1");
    cmd.process_group(0); // CLI becomes the leader of a new process group
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().unwrap();

    let rclone_pid = read_pidfile(&h.pidfile, Duration::from_secs(5));

    // Negative pid => signal the whole process group (trawl-cli + rclone).
    let status_kill =
        Command::new("kill").args(["-TERM", &format!("-{}", child.id())]).status().unwrap();
    assert!(status_kill.success());

    let status = wait_for_exit(&mut child, Duration::from_secs(10)).expect("trawl-cli should exit");
    if !status.success() {
        use std::io::Read;
        let mut out = String::new();
        let mut err = String::new();
        let _ = child.stdout.take().unwrap().read_to_string(&mut out);
        let _ = child.stderr.take().unwrap().read_to_string(&mut err);
        panic!("trawl-cli exited {status:?}\nstdout: {out}\nstderr: {err}");
    }
    assert!(!pid_alive(rclone_pid), "fake rclone should be dead too");

    let mappings = load_mappings(&h.mappings_file);
    let m = mappings.iter().find(|m| m.id == id).unwrap();
    assert_eq!(m.last_status, MappingStatus::Cancelled);
}

// ─── AC16b: failure path ──────────────────────────────────────────────────

#[test]
fn sync_failure_persists_failed() {
    let h = Harness::new("sync_failure");
    let dest = h.root.join("dest");
    let id = "sync-fail";
    h.write_mappings(&[test_mapping(id, &dest)]);

    let mut cmd = h.command(&["sync", id]);
    cmd.env("RCLONE_EXIT_CODE", "1");
    let output = cmd.output().unwrap();

    assert_eq!(output.status.code(), Some(1));

    let mappings = load_mappings(&h.mappings_file);
    let m = mappings.iter().find(|m| m.id == id).unwrap();
    assert_eq!(m.last_status, MappingStatus::Failed);
    assert!(m.last_error.is_some());

    let run_dir = h.run_dir();
    let progress_path = locks::progress_file(&run_dir, id).unwrap();
    assert!(!progress_path.exists());
    assert!(locks::try_run_lock(&run_dir, id).unwrap().is_some(), "run lock should be free");
}

// ─── AC17: bad ids rejected ───────────────────────────────────────────────

#[test]
fn rejects_unknown_and_unsafe_ids() {
    let h = Harness::new("bad_ids");
    let dest = h.root.join("dest");
    h.write_mappings(&[test_mapping("real-id", &dest)]);

    let run_dir = h.run_dir();

    for bad in ["../x", "unknown-uuid-0000"] {
        let output = h.command(&["sync", bad]).output().unwrap();
        assert!(!output.status.success(), "id {bad:?} should be rejected");
        assert!(!String::from_utf8_lossy(&output.stderr).trim().is_empty(), "expected a stderr message for {bad:?}");

        if locks::is_valid_id(bad) {
            assert!(!run_dir.join(format!("{bad}.lock")).exists());
            assert!(!run_dir.join(format!("{bad}.json")).exists());
        }
    }
}
