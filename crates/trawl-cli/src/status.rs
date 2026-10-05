//! `trawl-cli status` — read-only snapshot of every mapping's last-run result
//! plus whether it's syncing right now.
//!
//! Deliberately never resolves/creates/checks a destination path: `dest` here
//! is for display only (see AC13). Resolving a real destination (symlink
//! containment checks, canonicalizing the library root, mount probing) is
//! exactly what a stuck network mount can hang on, and a status read must
//! never be able to hang.

use std::path::{Path, PathBuf};

use serde::Serialize;
use trawl_core::locks;
use trawl_core::models::{MappingStatus, RunProgress, SourceProvider};
use trawl_core::store;

#[derive(Debug, Serialize)]
pub struct StatusReport {
    pub schema: u32,
    pub mappings: Vec<MappingStatusEntry>,
}

#[derive(Debug, Serialize)]
pub struct MappingStatusEntry {
    pub id: String,
    pub name: String,
    pub provider: SourceProvider,
    pub src: String,
    pub dest: String,
    pub auto_sync: bool,
    pub enabled: bool,
    pub last_status: MappingStatus,
    pub last_at: Option<String>,
    pub last_files: Option<i64>,
    pub last_bytes: Option<i64>,
    pub last_error: Option<String>,
    pub running: bool,
    pub progress: Option<RunProgress>,
}

/// Builds the full status report.
///
/// `mappings_file` is read WITHOUT `locks::lock_mappings` — writers replace it
/// with an atomic rename, so a reader never observes a half-written file, and
/// a stuck writer (e.g. blocked on `lock_mappings` elsewhere) can never freeze
/// this read.
pub fn build_status(mappings_file: &Path, library_root: &Path, run_dir: &Path) -> StatusReport {
    let mappings = store::load_mappings(mappings_file);

    let entries = mappings
        .into_iter()
        .map(|m| {
            let running = locks::is_running(run_dir, &m.id);

            // Only ever consult the progress file while the run lock is held —
            // a leftover `<id>.json` from a crashed/killed run with no lock is
            // ignored, not reported as live progress.
            let progress = if running {
                locks::progress_file(run_dir, &m.id)
                    .ok()
                    .and_then(|p| std::fs::read_to_string(p).ok())
                    .and_then(|s| serde_json::from_str::<RunProgress>(&s).ok())
            } else {
                None
            };

            let dest = if !m.dest_path.trim().is_empty() {
                PathBuf::from(&m.dest_path)
            } else {
                library_root.join(&m.dest_subpath)
            };

            MappingStatusEntry {
                id: m.id,
                name: m.source_name,
                provider: m.source_provider,
                src: m.src_label,
                dest: dest.display().to_string(),
                auto_sync: m.auto_sync,
                enabled: m.enabled,
                last_status: m.last_status,
                last_at: m.last_at,
                last_files: m.last_files,
                last_bytes: m.last_bytes,
                last_error: m.last_error,
                running,
                progress,
            }
        })
        .collect();

    StatusReport { schema: 1, mappings: entries }
}
