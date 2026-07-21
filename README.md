# Trawl

A small desktop app that syncs **Google Drive folders by link** into a **local folder**, using [`rclone`](https://rclone.org) under the hood. Paste a Drive folder URL, pick a local destination, and pull — additive copy only, it never deletes at the destination.

Built with **Tauri v2** (Rust) + **React/TypeScript**. The UI is a faithful rebuild of the "Slate" design handoff (dark dev-tool aesthetic, IBM Plex, teal accent).

## Why rclone (not rsync)

rsync has no Google Drive transport — it's local/SSH only. rclone's `drive` backend is the standard tool. Note: even "anyone with the link" folders require an authenticated rclone remote (there is no anonymous link download), so Trawl does a one-time Google connect on first launch. "By link" then means: extract the folder ID from the pasted URL and root rclone at it (`gdrive,root_folder_id=<ID>:`).

## Prerequisites

- **rclone** on your `PATH` (`brew install rclone`).
- Node 20+, Rust (stable), and the Tauri prerequisites for your OS.

## Run

```bash
npm install
npm run tauri dev      # native desktop app
```

On first launch, if no Google Drive remote is configured, Trawl shows a **Connect Google Drive** screen. Clicking *Connect* runs rclone's OAuth flow (opens your browser); the token is saved to `~/.config/rclone/rclone.conf` and you're never asked again.

You can also run just the web frontend for design work — it uses a built-in **simulation adapter** (fake Drive/local catalog + animated runs) so the whole UI is clickable without a real Drive:

```bash
npm run dev            # http://localhost:1420  (browser, simulated backend)
```

## How it works

- **Library root** — one local base folder (default `~/Trawl`, auto-created). Every destination is a path *relative to* this root; the right-hand pane browses it.
- **Mappings** persist as JSON in the app data dir (`~/Library/Application Support/com.trawl.app/mappings.json`).
- **Sync** shells out to `rclone copy` with `--use-json-log --stats`; the Rust backend streams parsed progress to the UI as live events.
- **Copy, never sync** — transfers are additive and never delete at the destination.

## Architecture

```
src/                      React + TS frontend
  types.ts                shared type contract (domain, Api, useTrawl hook)
  store.tsx               state brain (TrawlProvider + useTrawl)
  api.ts                  selects the real (Tauri) or sim (browser) adapter
  tauri/tauriApi.ts       real adapter — invoke() + run events
  sim/                    browser simulation adapter + fake catalog
  views/                  Connect · Dashboard · NewMapping · Run
  components/Sidebar.tsx
  theme.css               Slate design tokens (CSS variables)

src-tauri/src/            Rust backend
  rclone.rs               detect/connect/list/copy/cancel + error mapping
  store.rs                mappings.json + path-safety containment
  commands.rs             #[tauri::command] glue, AppState, run lifecycle
  models.rs               serde mirror of types.ts
```

### Security note

The single most important control is **destination containment** (`store.rs::resolve_dest`): every user-supplied destination subpath must resolve inside the library root. It rejects `..`, absolute paths, and control chars, and canonicalizes the deepest existing ancestor to defeat symlink escapes. Folder IDs are sanitized to the Drive charset before use. Concurrent runs of the same mapping are rejected, and run IDs are assigned by the backend.

## Scope

In: Mappings list · New mapping (by-link source + local destination) · Sync with live progress · Cancel / Retry / Delete · one-time Connect.
Out (intentionally, for v1): settings screen, scheduled/cron sync, run-history pages, the "Remote path" source mode.
