//! systemd `--user` integration: unit-file rendering, the `sync-due`
//! selection rule, and the handful of exact `systemctl` invocations the CLI
//! ever makes.
//!
//! Everything here that can be pure IS pure ([`systemctl_argv`],
//! [`render_units`], [`pick_due`]) so it's unit-testable without a real
//! systemd running. The only impure pieces are [`systemctl`] (runs the real
//! binary) and the file IO in [`write_units`]/[`remove_units`] — neither is
//! ever exercised by a test; `main.rs` is the only caller.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};

use trawl_core::models::{Mapping, Settings, SourceProvider};
use trawl_core::schedule;

// ─── sync-due selection (AC18) ───────────────────────────────────────────────

/// Picks which due mappings to start right now.
///
/// Pure: every external fact (the current time, whether Drive is reachable,
/// which mapping ids already have their run lock held) is passed in by the
/// caller rather than probed here.
///
/// - A mapping must pass [`schedule::is_due`] to be a candidate at all (that
///   covers the master switch, the per-mapping flags, and the interval).
/// - A due mapping already in `running_ids` is skipped (never double-started)
///   but still counts against `max` via `running_ids.len()`.
/// - A due Gdrive mapping is skipped when `drive_ok` is false (no configured
///   Drive remote) — pCloud mappings sync anonymously and are never gated by
///   this.
/// - At most `max - running_ids.len()` ids are returned, in mapping order.
pub fn pick_due(
    mappings: &[Mapping],
    settings: &Settings,
    now: DateTime<Utc>,
    drive_ok: bool,
    running_ids: &HashSet<String>,
    max: usize,
) -> Vec<String> {
    if running_ids.len() >= max {
        return Vec::new();
    }
    let budget = max - running_ids.len();

    let mut selected = Vec::new();
    for m in mappings {
        if selected.len() >= budget {
            break;
        }
        if !schedule::is_due(m, settings, now) {
            continue;
        }
        if running_ids.contains(&m.id) {
            continue; // already running: skip, but already counted in running_ids.len()
        }
        if m.source_provider == SourceProvider::Gdrive && !drive_ok {
            continue;
        }
        selected.push(m.id.clone());
    }
    selected
}

// ─── systemctl argv (AC20) ───────────────────────────────────────────────────

/// Every distinct `systemctl --user ...` shape the CLI invokes. Kept as
/// explicit variants (not a general argv builder) since these six calls are
/// the entire surface — see PLAN.md's precision section.
pub enum SystemctlOp<'a> {
    StartUnit(&'a str),
    StopUnit(&'a str),
    IsActiveUnit(&'a str),
    DaemonReload,
    EnableTimerNow,
    DisableTimerNow,
}

/// Builds the exact argv (minus the `systemctl` program name itself) for
/// `op`. Mapping ids are UUIDs containing `-`; systemd instance names allow
/// `-` literally in `%i` (only `%I` unescapes it to `/`), so the raw id is
/// used as-is.
pub fn systemctl_argv(op: SystemctlOp) -> Vec<String> {
    let mut argv = vec!["--user".to_string()];
    match op {
        SystemctlOp::StartUnit(id) => {
            argv.push("start".to_string());
            argv.push("--no-block".to_string());
            argv.push(format!("trawl-sync@{id}.service"));
        }
        SystemctlOp::StopUnit(id) => {
            argv.push("stop".to_string());
            argv.push(format!("trawl-sync@{id}.service"));
        }
        SystemctlOp::IsActiveUnit(id) => {
            argv.push("is-active".to_string());
            argv.push("--quiet".to_string());
            argv.push(format!("trawl-sync@{id}.service"));
        }
        SystemctlOp::DaemonReload => argv.push("daemon-reload".to_string()),
        SystemctlOp::EnableTimerNow => {
            argv.push("enable".to_string());
            argv.push("--now".to_string());
            argv.push("trawl-auto.timer".to_string());
        }
        SystemctlOp::DisableTimerNow => {
            argv.push("disable".to_string());
            argv.push("--now".to_string());
            argv.push("trawl-auto.timer".to_string());
        }
    }
    argv
}

/// Runs the real `systemctl` with `args`, mapping a spawn failure or nonzero
/// exit to `Err`. Never called from a test — see module docs.
pub fn systemctl(args: &[&str]) -> Result<(), String> {
    let status = std::process::Command::new("systemctl")
        .args(args)
        .status()
        .map_err(|e| format!("cannot run systemctl: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("systemctl {} failed ({status})", args.join(" ")))
    }
}

/// True if `trawl-sync@<id>.service` is currently active, per `systemctl
/// --user is-active --quiet`. Used only to decide whether `cancel` prints its
/// "not a systemd run" hint (assumption 13) — never as a correctness gate.
/// Treats any failure to even run systemctl as "not active".
pub fn is_unit_active(id: &str) -> bool {
    let argv = systemctl_argv(SystemctlOp::IsActiveUnit(id));
    let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    std::process::Command::new("systemctl")
        .args(&argv_refs)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// ─── Unit file rendering + IO (AC19) ─────────────────────────────────────────

const SYNC_SERVICE_NAME: &str = "trawl-sync@.service";
const AUTO_SERVICE_NAME: &str = "trawl-auto.service";
const AUTO_TIMER_NAME: &str = "trawl-auto.timer";

pub struct UnitFiles {
    pub sync_service: String,
    pub auto_service: String,
    pub auto_timer: String,
}

/// Quotes `exe` for use as (part of) a systemd `ExecStart=` line: wraps it in
/// double quotes (so an embedded space stays one argument) and doubles any
/// `%` (systemd's specifier escape char — otherwise e.g. a `%h` in a path
/// would be expanded as a specifier instead of taken literally).
fn quote_exe(exe: &Path) -> String {
    let raw = exe.to_string_lossy();
    let escaped = raw.replace('%', "%%");
    format!("\"{escaped}\"")
}

/// Renders the three unit files' contents. Pure: `path_env` (the installing
/// shell's `PATH`) is passed in rather than read from the environment here,
/// so this is testable without mutating process state.
pub fn render_units(exe: &Path, path_env: &str) -> UnitFiles {
    let quoted = quote_exe(exe);

    let sync_service = format!(
        "[Unit]\n\
         Description=Trawl sync for mapping %i\n\
         \n\
         [Service]\n\
         Type=exec\n\
         ExecStart={quoted} sync %i\n\
         KillMode=mixed\n\
         TimeoutStopSec=90\n\
         Environment=PATH={path_env}\n"
    );

    let auto_service = format!(
        "[Unit]\n\
         Description=Trawl auto-sync scheduler\n\
         \n\
         [Service]\n\
         Type=oneshot\n\
         ExecStart={quoted} sync-due\n"
    );

    let auto_timer = "[Unit]\n\
         Description=Trawl auto-sync timer\n\
         \n\
         [Timer]\n\
         OnBootSec=2min\n\
         OnUnitActiveSec=5min\n\
         \n\
         [Install]\n\
         WantedBy=timers.target\n"
        .to_string();

    UnitFiles { sync_service, auto_service, auto_timer }
}

/// Writes the three unit files into `dir` (typically
/// `~/.config/systemd/user`), creating it if missing. `PATH` is captured from
/// this process's own environment at install time (assumption 15).
pub fn write_units(dir: &Path, exe: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let path_env = std::env::var("PATH").unwrap_or_default();
    let units = render_units(exe, &path_env);

    fs::write(dir.join(SYNC_SERVICE_NAME), units.sync_service)
        .map_err(|e| format!("cannot write {SYNC_SERVICE_NAME}: {e}"))?;
    fs::write(dir.join(AUTO_SERVICE_NAME), units.auto_service)
        .map_err(|e| format!("cannot write {AUTO_SERVICE_NAME}: {e}"))?;
    fs::write(dir.join(AUTO_TIMER_NAME), units.auto_timer)
        .map_err(|e| format!("cannot write {AUTO_TIMER_NAME}: {e}"))?;
    Ok(())
}

/// Removes the three unit files from `dir`, if present. Running syncs are
/// left alone — this only ever touches unit *files*, never the run lock.
pub fn remove_units(dir: &Path) -> Result<(), String> {
    for name in [SYNC_SERVICE_NAME, AUTO_SERVICE_NAME, AUTO_TIMER_NAME] {
        let path = dir.join(name);
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("cannot remove {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// The directory unit files are installed into / removed from:
/// `dirs::config_dir()/systemd/user` (`~/.config/systemd/user` on Linux).
pub fn units_dir() -> Result<PathBuf, String> {
    dirs::config_dir()
        .map(|d| d.join("systemd").join("user"))
        .ok_or_else(|| "cannot determine the platform config directory".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use trawl_core::models::{MappingStatus, SourceKind};

    fn mapping(id: &str, provider: SourceProvider, enabled: bool, auto_sync: bool) -> Mapping {
        Mapping {
            id: id.to_string(),
            source_provider: provider,
            source_kind: SourceKind::FolderId,
            source_id: Some("folder".to_string()),
            source_host: None,
            source_subpath: String::new(),
            source_name: "Test".to_string(),
            src_label: "Test".to_string(),
            dest_subpath: String::new(),
            dest_path: "/tmp/dest".to_string(),
            acknowledge_abuse: false,
            enabled,
            auto_sync,
            skip_shortcuts: false,
            protect_local_edits: false,
            last_status: MappingStatus::Idle,
            last_at: None, // never synced => always due when enabled
            last_files: None,
            last_bytes: None,
            last_error: None,
        }
    }

    fn settings(auto_sync_enabled: bool) -> Settings {
        Settings {
            auto_sync_enabled,
            auto_sync_interval_minutes: 15,
            minimize_to_tray: true,
        }
    }

    // ─── AC18: pick_due ───────────────────────────────────────────────────

    #[test]
    fn pick_due_caps_at_three_counting_held_locks() {
        let mappings: Vec<Mapping> = (0..5)
            .map(|i| mapping(&format!("m{i}"), SourceProvider::Pcloud, true, true))
            .collect();
        let s = settings(true);
        let now = Utc::now();

        // Two locks already held (by mappings not even in this due set) means
        // only one more slot is left out of max=3.
        let running: HashSet<String> = ["held-a".to_string(), "held-b".to_string()].into_iter().collect();
        let picked = pick_due(&mappings, &s, now, false, &running, 3);
        assert_eq!(picked.len(), 1, "only 3 - 2 = 1 slot left: {picked:?}");

        // All 3 slots already held => nothing new starts, regardless of how
        // many mappings are due.
        let full: HashSet<String> =
            ["held-a".to_string(), "held-b".to_string(), "held-c".to_string()].into_iter().collect();
        assert!(pick_due(&mappings, &s, now, false, &full, 3).is_empty());
    }

    #[test]
    fn pick_due_skips_running() {
        let mappings = vec![
            mapping("m0", SourceProvider::Pcloud, true, true),
            mapping("m1", SourceProvider::Pcloud, true, true),
        ];
        let s = settings(true);
        let now = Utc::now();
        let running: HashSet<String> = ["m0".to_string()].into_iter().collect();

        let picked = pick_due(&mappings, &s, now, false, &running, 3);
        assert_eq!(picked, vec!["m1".to_string()], "m0 is already running, must not be re-started");
    }

    #[test]
    fn pick_due_skips_gdrive_without_drive_remote() {
        let mappings = vec![
            mapping("gdrive-due", SourceProvider::Gdrive, true, true),
            mapping("pcloud-due", SourceProvider::Pcloud, true, true),
        ];
        let s = settings(true);
        let now = Utc::now();
        let running = HashSet::new();

        let picked = pick_due(&mappings, &s, now, false, &running, 3);
        assert_eq!(picked, vec!["pcloud-due".to_string()], "gdrive must be skipped when Drive isn't connected");

        let picked_ok = pick_due(&mappings, &s, now, true, &running, 3);
        assert_eq!(picked_ok.len(), 2, "with Drive connected both are due: {picked_ok:?}");
    }

    #[test]
    fn pick_due_respects_master_switch() {
        let mappings = vec![mapping("m0", SourceProvider::Pcloud, true, true)];
        let now = Utc::now();
        let running = HashSet::new();

        let master_off = settings(false);
        assert!(pick_due(&mappings, &master_off, now, false, &running, 3).is_empty());

        let master_on = settings(true);
        assert_eq!(pick_due(&mappings, &master_on, now, false, &running, 3), vec!["m0".to_string()]);
    }

    // ─── AC19: unit rendering + IO ─────────────────────────────────────────

    #[test]
    fn render_units_content() {
        let exe = Path::new("/opt/100% weird/trawl-cli");
        let units = render_units(exe, "/usr/bin:/bin");

        assert!(
            units.sync_service.contains("ExecStart=\"/opt/100%% weird/trawl-cli\" sync %i"),
            "{}",
            units.sync_service
        );
        assert!(units.sync_service.contains("KillMode=mixed"), "{}", units.sync_service);
        assert!(units.sync_service.contains("TimeoutStopSec=90"), "{}", units.sync_service);
        assert!(units.sync_service.contains("Environment=PATH=/usr/bin:/bin"), "{}", units.sync_service);
        assert!(units.sync_service.contains("Type=exec"), "{}", units.sync_service);

        assert!(
            units.auto_service.contains("ExecStart=\"/opt/100%% weird/trawl-cli\" sync-due"),
            "{}",
            units.auto_service
        );
        assert!(units.auto_service.contains("Type=oneshot"), "{}", units.auto_service);

        assert!(units.auto_timer.contains("OnBootSec=2min"), "{}", units.auto_timer);
        assert!(units.auto_timer.contains("OnUnitActiveSec=5min"), "{}", units.auto_timer);
        assert!(units.auto_timer.contains("WantedBy=timers.target"), "{}", units.auto_timer);
    }

    #[test]
    fn write_then_remove_units_in_dir() {
        let dir = std::env::temp_dir().join(format!(
            "trawl_systemd_units_test_{}_{}",
            std::process::id(),
            uuid_like_suffix()
        ));

        let exe = Path::new("/usr/local/bin/trawl-cli");
        write_units(&dir, exe).expect("write_units should succeed");

        for name in [SYNC_SERVICE_NAME, AUTO_SERVICE_NAME, AUTO_TIMER_NAME] {
            let p = dir.join(name);
            assert!(p.exists(), "{name} should have been written");
        }
        let sync_contents = fs::read_to_string(dir.join(SYNC_SERVICE_NAME)).unwrap();
        assert!(sync_contents.contains("ExecStart=\"/usr/local/bin/trawl-cli\" sync %i"));

        remove_units(&dir).expect("remove_units should succeed");
        for name in [SYNC_SERVICE_NAME, AUTO_SERVICE_NAME, AUTO_TIMER_NAME] {
            assert!(!dir.join(name).exists(), "{name} should have been removed");
        }

        let _ = fs::remove_dir_all(&dir);
    }

    /// A small process-unique suffix so parallel test runs don't collide on
    /// the same temp directory — no need to pull in `uuid` just for this.
    fn uuid_like_suffix() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    // ─── AC20: systemctl argv ───────────────────────────────────────────────

    #[test]
    fn systemctl_argv() {
        assert_eq!(
            super::systemctl_argv(SystemctlOp::StartUnit("abc-123")),
            vec!["--user", "start", "--no-block", "trawl-sync@abc-123.service"]
        );
        assert_eq!(
            super::systemctl_argv(SystemctlOp::StopUnit("abc-123")),
            vec!["--user", "stop", "trawl-sync@abc-123.service"]
        );
        assert_eq!(
            super::systemctl_argv(SystemctlOp::IsActiveUnit("abc-123")),
            vec!["--user", "is-active", "--quiet", "trawl-sync@abc-123.service"]
        );
        assert_eq!(super::systemctl_argv(SystemctlOp::DaemonReload), vec!["--user", "daemon-reload"]);
        assert_eq!(
            super::systemctl_argv(SystemctlOp::EnableTimerNow),
            vec!["--user", "enable", "--now", "trawl-auto.timer"]
        );
        assert_eq!(
            super::systemctl_argv(SystemctlOp::DisableTimerNow),
            vec!["--user", "disable", "--now", "trawl-auto.timer"]
        );
    }
}
