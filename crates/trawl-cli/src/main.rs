//! `trawl-cli` — headless CLI for the Trawl sync engine.
//!
//! Hand-rolled argv dispatch (no arg-parsing crate — two subcommands don't
//! need one). Exit codes: 0 succeeded/cancelled, 1 failed/any error, 2 usage.

mod status;
mod sync;

use std::path::{Path, PathBuf};

use trawl_core::locks;
use trawl_core::models::Mapping;

const USAGE: &str = "usage: trawl-cli status [--json]\n       trawl-cli sync <id>";

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
