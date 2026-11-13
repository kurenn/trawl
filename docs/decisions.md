# Decisions

Dated, evidenced decision log. One entry per decision that future work needs to
know about before it changes the same area. Not a changelog. Each entry cites
its evidence so a later reader can check that it still holds.

## Entry format

```
## YYYY-MM-DD — <short decision title>

- **Decision:** <what was decided>
- **Why:** <the rationale>
- **Scope:** <files/paths/subsystems>
- **Evidence:** <commit sha, PR #, or two independent signals>
- **Status:** active | superseded by <link/date>
```

## 2026-07-21 — Copy only; never delete at the destination

- **Decision:** Every transfer is an additive `rclone copy`. Trawl never prunes
  the destination, never pushes, and never does two-way sync.
- **Why:** Users mirror folders other people share. A two-way or mirroring sync
  could wipe their local files.
- **Scope:** `crates/trawl-core/src/rclone.rs`, product copy (README, `docs/index.html`).
- **Evidence:** README "Why Trawl?" and "Out of scope"; CHANGELOG 0.1.0.
- **Status:** active

## 2026-07-21 — Bundle rclone as a Tauri sidecar

- **Decision:** rclone ships inside the app via `externalBin`, fetched per
  target by `scripts/fetch-rclone.sh`. The backend resolves the bundled binary
  first and falls back to PATH.
- **Why:** Installed apps need nothing else installed.
- **Scope:** `src-tauri/tauri.conf.json`, `scripts/fetch-rclone.sh`, CI and release workflows.
- **Evidence:** commit 2fa0a7e (explicit rationale).
- **Status:** active

## 2026-07-21 — Website is one static page served from `main:/docs`

- **Decision:** The site is a hand-written `docs/index.html` with its images
  next to it, published by GitHub Pages (legacy build, branch `main`, path
  `/docs`). No site generator. Since #10 it uses the app's Paper tokens.
- **Why:** One page with no build step. Matching the app keeps the screenshots
  and the page consistent.
- **Scope:** `docs/index.html`, `docs/*.webp|png|jpg`.
- **Evidence:** commits 2241642, a9df4e6 (#10); `gh api repos/kurenn/trawl/pages`.
- **Status:** active

## 2026-10-05 — Split shared logic into `trawl-core`; keep `trawl-cli` GUI-free

- **Decision:** rclone, store, locks and schedule logic live in
  `crates/trawl-core`. The headless `trawl-cli` must not depend on
  tauri/gtk/webkit/wry, and CI enforces this.
- **Why:** Headless and Omarchy setups run on servers and tiling WMs without a
  desktop.
- **Scope:** `crates/`, `.github/workflows/ci.yml`.
- **Evidence:** commit 9033d9b and PR #4; CI GUI-dep gate; README "Headless / Omarchy".
- **Status:** active

## 2026-10-05 — App and CLI share data and cross-process run locks

- **Decision:** The CLI uses the app's data directory and run locks. A mapping
  never runs twice at once, and `mappings.json` writes are serialized across
  processes. `last_status` is written only when a run ends. "Running" comes
  from the lock.
- **Why:** Lets the desktop app and the systemd timer run side by side safely.
- **Scope:** `crates/trawl-core/src/locks.rs`, `store.rs`, frontend status logic.
- **Evidence:** commit 7813934; README; `docs/dev-loop-learnings/2026-11-11-ui-redesign.md`.
- **Status:** active

## 2026-11-12 — Sign and notarize macOS builds with a pinned Developer ID

- **Decision:** Release builds are signed and notarized. The signing identity
  and team ID are pinned in `release.yml`.
- **Why:** Stops the "Trawl is damaged" quarantine warning, and the pin means a
  build can't pick another team's certificate.
- **Scope:** `.github/workflows/release.yml`, install copy in README and `docs/index.html`.
- **Evidence:** commit 9c8686e (#11), CHANGELOG 0.4.1.
- **Status:** active
