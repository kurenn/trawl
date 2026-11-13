# Trawl

Desktop app (Tauri v2) that copies shared Google Drive folders and pCloud
public links into a local library with `rclone copy`. It only adds files and
never deletes anything at the destination. There's also a headless
`trawl-cli` with systemd units for Linux. Both share the app's data and run
locks. MIT licensed and published from `kurenn/trawl`.

## Stack & entry points

- Frontend: React 19 + TypeScript + Vite (`src/`). `src/api.ts` picks the real
  Tauri adapter (`src/tauri/tauriApi.ts`) or the browser simulation (`src/sim/`)
  at runtime. `src/types.ts` is the shared contract.
- Desktop backend: `src-tauri/src/` (commands, scheduler, tray). The Tauri crate
  is named `trawl`.
- Shared Rust logic: `crates/trawl-core/src/` (rclone, pCloud, store, locks,
  schedule, models). Headless CLI: `crates/trawl-cli/`.
- rclone ships as a Tauri sidecar (`externalBin: binaries/rclone`), fetched per
  target by `scripts/fetch-rclone.sh` into the gitignored `src-tauri/binaries/`.
- Website: one static page, `docs/index.html`, plus its images in `docs/`.
  GitHub Pages serves it from `main:/docs` at https://kurenn.github.io/trawl/
  (verify with `gh api repos/kurenn/trawl/pages`). README images live in
  `assets/`.

## Commands

| Task | Command |
|---|---|
| UI on the simulated backend | `npm run dev` (http://localhost:1420) |
| frontend typecheck + build | `npm run build` |
| frontend logic tests | `npm run check` (`scripts/check-format.mjs` against `src/format.ts`) |
| fetch rclone sidecar (once, before any cargo build/test) | `./scripts/fetch-rclone.sh [target-triple]` |
| backend tests | `cargo test --workspace --exclude trawl` then `cargo test -p trawl --lib` |
| CLI stays GUI-free | `! cargo tree -p trawl-cli -e normal \| grep -Ei 'tauri\|gtk\|webkit\|wry'` |
| full desktop app | `npm run tauri dev` / `npm run tauri build` |

CI (`.github/workflows/ci.yml`) runs `npm run build`, both cargo test commands
and the GUI-dep gate on every PR and push to main. It does not run
`npm run check`, so run that locally.

## Conventions

- Conventional-style commit subjects (`feat:`, `fix:`, `docs:`, `chore: release vX`).
- Releases: bump the version in `package.json`, `src-tauri/tauri.conf.json`,
  `src-tauri/Cargo.toml` and both `crates/*/Cargo.toml`, add a
  `## [x.y.z]` section to `CHANGELOG.md` (the release workflow copies that
  section into the GitHub Release), then push a `vX.Y.Z` tag.
- User-facing copy (app, website, CHANGELOG) is plain and short, built around
  the paste-a-link flow. Folders "copy", they don't "sync"; nothing is ever
  "deleted".
- The website reuses the app's "Paper" tokens from `src/theme.css`. Keep the two
  in step.
- `.worktrees/` is git-excluded locally and holds dev-loop worktrees and loop
  artifacts. Never commit it.
- Exercise UI changes in a real browser on the sim (`npm run dev`), not just by
  reading the code (see `docs/dev-loop-learnings/2026-11-11-ui-redesign.md`).

## Critical / security paths

- `crates/trawl-core/src/store.rs`: `resolve_dest` contains every destination
  subpath inside the library root. `effective_dest` trusts an absolute
  `dest_path`, so the frontend sanitiser `cleanFolderName` in `src/format.ts`
  is the only guard on it. Keep it covered by `npm run check`.
- `crates/trawl-core/src/locks.rs`: cross-process run locks shared by app and CLI.
- `crates/trawl-cli/src/systemd.rs`: writes user units with the install-time PATH.
- `.github/workflows/release.yml`: updater signing keys and the pinned Apple
  Developer ID identity for macOS signing and notarization. Never loosen the pin.

## Context pointers

- Decisions: `docs/decisions.md`
- Dev-loop learnings: `docs/dev-loop-learnings/` (format in its `README.md`)
- Also read by other agents: none. No AGENTS.md or CLAUDE.md exists, so this
  file is new and not reconciled from anything.
