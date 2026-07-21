### Install

- **macOS** — open the `.dmg`, drag Trawl to **Applications**. Not notarized yet, so clear the quarantine flag once: `xattr -dr com.apple.quarantine /Applications/Trawl.app` (Apple Silicon → `aarch64.dmg`, Intel → `x64.dmg`).
- **Windows** — run the `.msi` or `-setup.exe`. On SmartScreen: **More info → Run anyway**.
- **Linux** — `.AppImage` (chmod +x and run), `.deb`, or `.rpm`.

> Trawl shells out to [`rclone`](https://rclone.org) — make sure it's installed and on your `PATH` (`brew install rclone`).

If Trawl earns a spot in your workflow, you can [buy me a coffee](https://buymeacoffee.com/kurito) ☕.
