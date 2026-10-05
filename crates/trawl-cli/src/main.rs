//! `trawl-cli` — headless CLI for the Trawl sync engine.
//!
//! Hand-rolled argv dispatch (no arg-parsing crate — two subcommands don't
//! need one). Exit codes: 0 succeeded/cancelled, 1 failed/any error, 2 usage.

mod status;
mod sync;
mod systemd;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use trawl_core::locks;
use trawl_core::models::{ConnectionPhase, Mapping, SourceProvider};

const USAGE: &str = "usage: trawl-cli status [--json]\n       trawl-cli sync <id>\n       trawl-cli start <id>\n       trawl-cli cancel <id>\n       trawl-cli sync-due\n       trawl-cli install-units\n       trawl-cli uninstall-units";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(run(&args));
}

fn run(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("status") => match args.get(1).map(String::as_str) {
            None | Some("--json") if args.len() <= 2 => cmd_status(),
            _ => usage_error(&format!("unexpected arguments for 'status': {}", args[1..].join(" "))),
        },
        Some("sync") => match (args.get(1), args.len()) {
            (Some(id), 2) => cmd_sync(id),
            _ => usage_error("'sync' takes exactly one <id> argument"),
        },
        Some("start") => match (args.get(1), args.len()) {
            (Some(id), 2) => cmd_start(id),
            _ => usage_error("'start' takes exactly one <id> argument"),
        },
        Some("cancel") => match (args.get(1), args.len()) {
            (Some(id), 2) => cmd_cancel(id),
            _ => usage_error("'cancel' takes exactly one <id> argument"),
        },
        Some("sync-due") => match args.len() {
            1 => cmd_sync_due(),
            _ => usage_error("'sync-due' takes no arguments"),
        },
        Some("install-units") => match args.len() {
            1 => cmd_install_units(),
            _ => usage_error("'install-units' takes no arguments"),
        },
        Some("uninstall-units") => match args.len() {
            1 => cmd_uninstall_units(),
            _ => usage_error("'uninstall-units' takes no arguments"),
        },
        Some(other) => usage_error(&format!("unknown command '{other}'")),
        None => usage_error("missing command"),
    }
}

fn usage_error(msg: &str) -> i32 {
    eprintln!("trawl-cli: {msg}");
    eprintln!("{USAGE}");
    2
}

fn fail(msg: &str) -> i32 {
    eprintln!("trawl-cli: {msg}");
    1
}

/// `dirs::data_dir()/com.trawl.app` — matches Tauri's `app_data_dir` on both
/// Linux and macOS.
fn app_data_dir() -> Result<PathBuf, String> {
    dirs::data_dir()
        .map(|d| d.join("com.trawl.app"))
        .ok_or_else(|| "cannot determine the platform data directory".to_string())
}

/// Loads mapping `id` out of `mappings_file`, validating `id` first — before
/// any path or lock use, since an id that passes this check is about to be
/// used to build run-lock/progress-file paths (a destination-containment
/// critical path).
fn load_mapping(mappings_file: &Path, id: &str) -> Result<Mapping, String> {
    if !locks::is_valid_id(id) {
        return Err(format!("invalid mapping id '{id}'"));
    }
    trawl_core::store::load_mappings(mappings_file)
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("no mapping with id '{id}'"))
}

fn cmd_status() -> i32 {
    let app_data_dir = match app_data_dir() {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };
    let mappings_file = app_data_dir.join("mappings.json");
    let library_root = trawl_core::store::read_library_root(&app_data_dir);
    let run_dir = match locks::run_dir(&app_data_dir) {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };

    let report = status::build_status(&mappings_file, &library_root, &run_dir);
    match serde_json::to_string_pretty(&report) {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(e) => fail(&format!("cannot serialize status: {e}")),
    }
}

fn cmd_sync(id: &str) -> i32 {
    let app_data_dir = match app_data_dir() {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };
    let mappings_file = app_data_dir.join("mappings.json");

    let mapping = match load_mapping(&mappings_file, id) {
        Ok(m) => m,
        Err(e) => return fail(&e),
    };

    let run_dir = match locks::run_dir(&app_data_dir) {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };

    sync::run(app_data_dir, mappings_file, run_dir, mapping)
}

/// Runs `systemctl` for `op`, converting [`systemd::systemctl_argv`]'s owned
/// `Vec<String>` to the `&[&str]` the runner takes.
fn run_systemctl(op: systemd::SystemctlOp) -> Result<(), String> {
    let argv = systemd::systemctl_argv(op);
    let argv_refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    systemd::systemctl(&argv_refs)
}

fn cmd_start(id: &str) -> i32 {
    let app_data_dir = match app_data_dir() {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };
    let mappings_file = app_data_dir.join("mappings.json");

    // Validate the id exists before ever shelling out — same critical-path
    // discipline as `cmd_sync` (see `load_mapping`'s docs).
    if let Err(e) = load_mapping(&mappings_file, id) {
        return fail(&e);
    }

    match run_systemctl(systemd::SystemctlOp::StartUnit(id)) {
        Ok(()) => 0,
        Err(e) => fail(&e),
    }
}

/// `cancel <id>` stops only systemd/CLI runs, not a run started by the
/// desktop app (assumption 13): a run started by the app holds the run lock
/// but has no corresponding active systemd unit, so `systemctl stop` on it is
/// a no-op. When that shape is detected, print a hint to stderr before still
/// issuing the stop (harmless either way, and correct for the systemd-started
/// case racing with this check).
fn cmd_cancel(id: &str) -> i32 {
    let app_data_dir = match app_data_dir() {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };
    let mappings_file = app_data_dir.join("mappings.json");

    if let Err(e) = load_mapping(&mappings_file, id) {
        return fail(&e);
    }

    let run_dir = match locks::run_dir(&app_data_dir) {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };

    if locks::is_running(&run_dir, id) && !systemd::is_unit_active(id) {
        eprintln!("trawl-cli: not a systemd run (started by the desktop app?)");
    }

    match run_systemctl(systemd::SystemctlOp::StopUnit(id)) {
        Ok(()) => 0,
        Err(e) => fail(&e),
    }
}

/// `sync-due` — the body of `trawl-auto.service`'s oneshot `ExecStart`. Picks
/// which mappings are due ([`systemd::pick_due`]) and starts each as its own
/// `trawl-sync@<id>.service` with `--no-block` (returns immediately; no
/// in-process stagger needed since systemd fires the start and this process
/// moves straight on to the next one).
fn cmd_sync_due() -> i32 {
    let app_data_dir = match app_data_dir() {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };
    let mappings_file = app_data_dir.join("mappings.json");
    let settings_file = app_data_dir.join("settings.json");
    let run_dir = match locks::run_dir(&app_data_dir) {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };

    let mappings = trawl_core::store::load_mappings(&mappings_file);
    let settings = trawl_core::store::load_settings(&settings_file);
    let now = chrono::Utc::now();

    let running_ids: HashSet<String> = mappings
        .iter()
        .filter(|m| locks::is_running(&run_dir, &m.id))
        .map(|m| m.id.clone())
        .collect();

    // Only probe Drive if some due candidate actually needs it — a probe is
    // an rclone subprocess call, not worth paying for on a pCloud-only setup.
    let due_gdrive = mappings
        .iter()
        .any(|m| m.source_provider == SourceProvider::Gdrive && trawl_core::schedule::is_due(m, &settings, now));
    let drive_ok = due_gdrive
        && trawl_core::rclone::detect_connection("gdrive").phase == ConnectionPhase::Connected;

    let to_start = systemd::pick_due(&mappings, &settings, now, drive_ok, &running_ids, 3);

    let mut exit_code = 0;
    for id in &to_start {
        if let Err(e) = run_systemctl(systemd::SystemctlOp::StartUnit(id)) {
            eprintln!("trawl-cli: {e}");
            exit_code = 1;
        }
    }
    exit_code
}

fn cmd_install_units() -> i32 {
    let units_dir = match systemd::units_dir() {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => return fail(&format!("cannot determine current executable: {e}")),
    };

    if let Err(e) = systemd::write_units(&units_dir, &exe) {
        return fail(&e);
    }
    if let Err(e) = run_systemctl(systemd::SystemctlOp::DaemonReload) {
        return fail(&e);
    }
    match run_systemctl(systemd::SystemctlOp::EnableTimerNow) {
        Ok(()) => 0,
        Err(e) => fail(&e),
    }
}

/// Disables the timer, removes the unit files, then reloads — running syncs
/// (if any) are left alone (assumption 15).
fn cmd_uninstall_units() -> i32 {
    let units_dir = match systemd::units_dir() {
        Ok(d) => d,
        Err(e) => return fail(&e),
    };

    if let Err(e) = run_systemctl(systemd::SystemctlOp::DisableTimerNow) {
        eprintln!("trawl-cli: {e}");
    }
    if let Err(e) = systemd::remove_units(&units_dir) {
        return fail(&e);
    }
    match run_systemctl(systemd::SystemctlOp::DaemonReload) {
        Ok(()) => 0,
        Err(e) => fail(&e),
    }
}
