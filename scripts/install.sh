#!/usr/bin/env bash
#
# Trawl one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/kurenn/trawl/main/scripts/install.sh | bash
#
# Downloads the latest Trawl release for your OS/arch and installs it. rclone is
# bundled inside the app, so nothing else is required. macOS → /Applications;
# Linux → an AppImage in ~/.local/bin. (Windows: use the .msi from Releases.)
set -euo pipefail

REPO="kurenn/trawl"
API="https://api.github.com/repos/${REPO}/releases/latest"

say()  { printf '\033[36m==>\033[0m %s\n' "$1"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

OS="$(uname -s)"
ARCH="$(uname -m)"

command -v curl >/dev/null 2>&1 || die "curl is required."

say "Finding the latest Trawl release…"
ASSETS="$(curl -fsSL "$API" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"/\1/')"
[ -n "$ASSETS" ] || die "Could not read releases for $REPO — has a release been published yet?"

pick() { printf '%s\n' "$ASSETS" | grep -iE "$1" | head -1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

case "$OS" in
  Darwin)
    case "$ARCH" in
      arm64|aarch64) URL="$(pick 'aarch64.*\.dmg$')" ;;
      x86_64)        URL="$(pick '(x64|x86_64).*\.dmg$')" ;;
      *) die "Unsupported macOS arch: $ARCH" ;;
    esac
    [ -n "$URL" ] || die "No macOS .dmg asset found for $ARCH in the latest release."
    say "Downloading $(basename "$URL")…"
    curl -fsSL "$URL" -o "$TMP/Trawl.dmg"
    say "Mounting and copying to /Applications…"
    MP="$(hdiutil attach -nobrowse -readonly "$TMP/Trawl.dmg" | grep -o '/Volumes/.*' | head -1)"
    APP="$(find "$MP" -maxdepth 1 -name '*.app' | head -1)"
    [ -n "$APP" ] || { hdiutil detach "$MP" >/dev/null 2>&1 || true; die "No .app inside the DMG."; }
    rm -rf "/Applications/$(basename "$APP")"
    cp -R "$APP" /Applications/
    hdiutil detach "$MP" >/dev/null 2>&1 || true
    # Unsigned build → clear the download quarantine so it opens without the
    # "damaged" warning. (Sign+notarize later to drop this entirely.)
    xattr -dr com.apple.quarantine "/Applications/$(basename "$APP")" 2>/dev/null || true
    say "Installed → /Applications/$(basename "$APP"). Launch it from Applications."
    ;;
  Linux)
    case "$ARCH" in
      x86_64|amd64) URL="$(pick '(amd64|x86_64).*\.AppImage$')" ;;
      aarch64|arm64) URL="$(pick '(aarch64|arm64).*\.AppImage$')" ;;
      *) die "Unsupported Linux arch: $ARCH" ;;
    esac
    [ -n "$URL" ] || die "No Linux .AppImage asset found for $ARCH (try the .deb/.rpm from Releases)."
    DEST="${HOME}/.local/bin"; mkdir -p "$DEST"
    say "Downloading $(basename "$URL")…"
    curl -fsSL "$URL" -o "$DEST/Trawl.AppImage"
    chmod +x "$DEST/Trawl.AppImage"
    say "Installed → $DEST/Trawl.AppImage"
    case ":$PATH:" in *":$DEST:"*) : ;; *) say "Add $DEST to your PATH to run 'Trawl.AppImage' from anywhere." ;; esac
    ;;
  *) die "Unsupported OS: $OS (Windows: download the .msi from https://github.com/$REPO/releases/latest)." ;;
esac

say "Done. Trawl bundles rclone — on first launch, connect Google Drive when prompted."
