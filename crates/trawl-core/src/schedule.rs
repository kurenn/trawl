//! Shared auto-sync due-rule, ported 1:1 from the app scheduler so the
//! desktop app and the CLI agree on exactly when a mapping is due.

use std::time::Duration;

use chrono::{DateTime, Utc};

use crate::models::{Mapping, Settings};

/// Minimum permitted auto-sync interval (guards against a zero/tiny
/// configured value that would hammer Drive with back-to-back syncs).
pub const MIN_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// True when `mapping` should sync right now, given `settings` and the
/// current time `now`.
///
/// - Off entirely unless the master switch (`settings.auto_sync_enabled`)
///   AND the mapping's own `enabled` + `auto_sync` flags are all true.
/// - The configured interval is clamped up to [`MIN_INTERVAL`].
/// - Never synced (`last_at` is `None`) => due immediately.
/// - An unparseable `last_at` => due (so a corrupt timestamp self-heals
///   rather than wedging the mapping forever).
/// - A `last_at` in the future (negative elapsed) => due, same as today's
///   scheduler, rather than erroring on the negative duration.
pub fn is_due(mapping: &Mapping, settings: &Settings, now: DateTime<Utc>) -> bool {
    if !settings.auto_sync_enabled || !mapping.enabled || !mapping.auto_sync {
        return false;
    }

    let configured = Duration::from_secs(settings.auto_sync_interval_minutes as u64 * 60);
    let interval = configured.max(MIN_INTERVAL);

    match &mapping.last_at {
        None => true,
        Some(ts) => match DateTime::parse_from_rfc3339(ts) {
            Ok(last_at) => {
                let elapsed = now.signed_duration_since(last_at);
                elapsed.to_std().map(|d| d >= interval).unwrap_or(true)
            }
            Err(_) => true,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{MappingStatus, SourceKind, SourceProvider};
    use chrono::Duration as ChronoDuration;

    fn mapping(enabled: bool, auto_sync: bool, last_at: Option<String>) -> Mapping {
        Mapping {
            id: "m1".to_string(),
            source_provider: SourceProvider::Gdrive,
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
            last_at,
            last_files: None,
            last_bytes: None,
            last_error: None,
        }
    }

    fn settings(auto_sync_enabled: bool, interval_minutes: u32) -> Settings {
        Settings {
            auto_sync_enabled,
            auto_sync_interval_minutes: interval_minutes,
            minimize_to_tray: true,
        }
    }

    #[test]
    fn is_due_never_synced() {
        let m = mapping(true, true, None);
        let s = settings(true, 15);
        assert!(is_due(&m, &s, Utc::now()));
    }

    #[test]
    fn is_due_clamps_interval_to_15m() {
        let now = Utc::now();
        // Configured interval is 1 minute, but MIN_INTERVAL clamps it to 15.
        let s = settings(true, 1);

        let ten_min_ago = (now - ChronoDuration::minutes(10)).to_rfc3339();
        let not_due = mapping(true, true, Some(ten_min_ago));
        assert!(!is_due(&not_due, &s, now), "10m elapsed < clamped 15m minimum");

        let sixteen_min_ago = (now - ChronoDuration::minutes(16)).to_rfc3339();
        let due = mapping(true, true, Some(sixteen_min_ago));
        assert!(is_due(&due, &s, now), "16m elapsed >= clamped 15m minimum");
    }

    #[test]
    fn is_due_respects_master_switch_and_flags() {
        let now = Utc::now();
        let long_ago = (now - ChronoDuration::hours(1)).to_rfc3339();

        let master_off = settings(false, 15);
        assert!(!is_due(&mapping(true, true, Some(long_ago.clone())), &master_off, now));

        let master_on = settings(true, 15);
        assert!(!is_due(&mapping(false, true, Some(long_ago.clone())), &master_on, now));
        assert!(!is_due(&mapping(true, false, Some(long_ago)), &master_on, now));
    }

    #[test]
    fn is_due_unparseable_last_at() {
        let m = mapping(true, true, Some("not-a-timestamp".to_string()));
        let s = settings(true, 15);
        assert!(is_due(&m, &s, Utc::now()));
    }

    #[test]
    fn is_due_future_last_at_is_due() {
        let now = Utc::now();
        let future = (now + ChronoDuration::hours(1)).to_rfc3339();
        let m = mapping(true, true, Some(future));
        let s = settings(true, 15);
        assert!(is_due(&m, &s, now));
    }
}
