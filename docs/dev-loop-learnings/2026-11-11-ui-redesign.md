# ui-redesign — 2026-11-11

- **`last_status` is final-only** — the backend writes it only when a run ends (app and CLI alike); "running" lives in the run lock / `active_mappings`, never in mappings.json. Frontend guards like `last_status !== "running"` after a reload never fire. Detect a lock conflict by the rejection message ("already syncing") instead.
- **`trigger_sync` rejects before spawning** — destination stalls and the cross-process run lock reject the invoke with no run event. Any optimistic "Starting…" placeholder must turn into a visible failure on rejection, or the UI sits on 0% forever.
- **The sim's `startSync` never rejects** — so rejected-start paths can't be exercised in the browser sim. Add a sim fail mode for rejections before relying on a walkthrough to cover them.
- **`dest_path` is trusted if absolute** — the backend validates `dest_subpath` only (`effective_dest`); the frontend's folder-name sanitiser is the sole guard on `dest_path`. Keep it under test (`npm run check`).
- **Browser-harness in a background tab** — CDP key events didn't reach React handlers; DOM-dispatched `KeyboardEvent`/`MouseEvent` (and the native value setter + `input` event for controlled inputs) did. Screenshots of a background tab can time out.
- **Drive the walkthrough, don't trace it** — a code trace "passed" while a real browser pass surfaced the stuck-placeholder and dead-end failure paths. Budget the browser pass into the integration unit.
