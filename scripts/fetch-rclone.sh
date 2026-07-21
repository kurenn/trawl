#!/usr/bin/env bash
#
# Fetch the official rclone binary for a target triple and place it where
# Tauri's `externalBin` expects it: src-tauri/binaries/rclone-<triple>[.exe].
# Trawl bundles rclone as a sidecar so installed apps are self-contained — no
# separate `brew install rclone` needed.
#
# Usage:
#   scripts/fetch-rclone.sh [target-triple]
#     (no arg → the host triple, for local `npm run tauri dev` / `build`)
#
# rclone is MIT-licensed, so redistribution inside Trawl's bundle is fine.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/binaries"
mkdir -p "$DEST"

TRIPLE="${1:-$(rustc -vV | sed -n 's/^host: //p')}"

# Map Rust target triple → rclone download slug + binary name.
case "$TRIPLE" in
  aarch64-apple-darwin)      SLUG="osx-arm64";     BIN="rclone" ;;
  x86_64-apple-darwin)       SLUG="osx-amd64";     BIN="rclone" ;;
  x86_64-unknown-linux-gnu)  SLUG="linux-amd64";   BIN="rclone" ;;
  aarch64-unknown-linux-gnu) SLUG="linux-arm64";   BIN="rclone" ;;
  x86_64-pc-windows-msvc)    SLUG="windows-amd64"; BIN="rclone.exe" ;;
  aarch64-pc-windows-msvc)   SLUG="windows-arm64"; BIN="rclone.exe" ;;
  *) echo "fetch-rclone: unsupported target triple: $TRIPLE" >&2; exit 1 ;;
esac

URL="https://downloads.rclone.org/rclone-current-${SLUG}.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "fetch-rclone: downloading rclone for $TRIPLE ($SLUG) …"
curl -fsSL "$URL" -o "$TMP/rclone.zip"

# Extract with whatever's available: unzip (Linux/macOS) or bsdtar (Windows/macOS).
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$TMP/rclone.zip" -d "$TMP"
elif tar --version >/dev/null 2>&1; then
  ( cd "$TMP" && tar -xf rclone.zip )
else
  echo "fetch-rclone: need 'unzip' or 'tar' to extract the archive" >&2
  exit 1
fi

SRC="$(find "$TMP" -type f -name "$BIN" -path '*rclone-*' | head -1)"
[ -n "$SRC" ] || { echo "fetch-rclone: rclone binary not found in archive" >&2; exit 1; }

if [ "$BIN" = "rclone.exe" ]; then
  OUT="$DEST/rclone-${TRIPLE}.exe"
else
  OUT="$DEST/rclone-${TRIPLE}"
fi
cp "$SRC" "$OUT"
chmod +x "$OUT" 2>/dev/null || true
echo "fetch-rclone: → $OUT ($("$SRC" version 2>/dev/null | head -1 || echo rclone))"
