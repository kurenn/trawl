# Changelog

All notable changes to Trawl are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the release
workflow pulls the matching `## [version]` section into each GitHub Release.

## [0.3.0]

- **Survives a dropped destination** — if the destination volume disconnects mid-sync, Trawl now stops the run and reports a mount problem. Before, rclone saw an empty folder and started copying the whole library again. A disk that was ejected uncleanly and left an empty `/Volumes/<name>` folder behind is also treated as missing now, so a sync can't quietly fill up your internal drive.
- **Protect edits** — a new per-mapping toggle that keeps your changes to synced files. A file you edited locally is never overwritten by an older copy from the source, and if the source copy is newer, your version is moved to a hidden backup folder instead of being lost.
- **Open destination folder** — open a mapping's local folder in Finder/Explorer from its dashboard card or the Run view. Clicking the destination path works too.
- **Clearer failure messages** — a failed run's card now says why it failed in one complete sentence, instead of "see errors above" with no log in sight.

## [0.2.0]

- **In-app updater** — Trawl now checks GitHub Releases on launch and the sidebar shows an **"↑ Update to vX"** button that downloads, verifies, installs, and relaunches into the new version. Also surfaces checking / up-to-date / re-check states. (This is the first release that can auto-update; installs from here forward stay current in-app.)

## [0.1.0]

Initial release.

- Sync **Google Drive** (folder link/ID or *Shared with me*) and **pCloud** public links into a local library via `rclone copy` — additive, never deletes at the destination.
- Live per-run progress (percent, bytes, files, speed, ETA) streamed from the Rust backend.
- Per-mapping **auto-sync** on an interval, **Cancel / Retry / Delete**, and a persisted last-run status with a clear error banner.
- **Folder-loop guard** that stops a source which recurses forever, plus a per-Drive-mapping **Skip shortcuts** toggle that ignores Google Drive shortcuts to copy through the loop.
- Destination **containment** (no escaping the library root) and a one-time Google Drive OAuth connect.
