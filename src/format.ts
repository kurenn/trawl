/* ============================================================================
   Trawl — shared formatting + status presentation.
   Transcribed from the prototype (Trawl App.dc.html) so numbers/labels match.
   ============================================================================ */

import type { MappingStatus, SourceProvider, Tone } from "./types";

export function fmtBytes(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—";
  const u = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0,
    v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return (
    (i === 0 ? v.toFixed(0) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)) +
    " " +
    u[i]
  );
}

/** Coarse relative-time for the meta line. */
export function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.round(h / 24);
  return d + "d ago";
}

/**
 * Extract a Google Drive folder ID from a pasted URL or bare ID.
 * Handles:
 *   https://drive.google.com/drive/folders/<ID>[?...]
 *   https://drive.google.com/drive/u/0/folders/<ID>
 *   https://drive.google.com/open?id=<ID>
 *   https://drive.google.com/folderview?id=<ID>
 *   <ID>            (bare)
 * Returns the sanitized ID, or null if nothing valid is found.
 */
export function extractFolderId(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  // /folders/<ID>
  let m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  // id=<ID>
  m = s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  // bare id (whole string is a valid-looking id)
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  // last-ditch: longest id-like token
  const tokens = s.match(/[A-Za-z0-9_-]{10,}/g);
  if (tokens) return tokens.sort((a, b) => b.length - a.length)[0];
  return null;
}

/** Build the rclone fs/connection-string label for display + commands. */
export function srcLabel(remote: string, sourceId: string | null): string {
  return `${remote},root_folder_id=${sourceId ?? "…"}:`;
}

/* ---------------------------------------------------------------------------
   Provider detection (gdrive vs pcloud) for the pasted-link flow.
   --------------------------------------------------------------------------- */

/** Detect the provider from a pasted URL. Bare IDs (no host) default to gdrive
 *  (the original Drive-by-id behavior). */
export function detectProvider(raw: string): SourceProvider {
  const s = (raw || "").trim();
  if (/pcloud\.|pc\.cd/i.test(s)) return "pcloud";
  // drive.google.com or a bare Drive id → gdrive
  return "gdrive";
}

/**
 * Parse a pCloud public link into its `code` and the API host to use.
 *   US  links (my.pcloud.com)                    → api.pcloud.com
 *   EU  links (e.pcloud.link / u.pcloud.link / …) → eapi.pcloud.com
 * Returns null if no `code` can be found. The backend re-tries the other host
 * if the region guess is wrong.
 */
export function parsePcloudLink(
  raw: string,
): { code: string; host: string } | null {
  const s = (raw || "").trim();
  // code lives in the ?code= / &code= query param of publink URLs.
  const m = s.match(/[?&]code=([A-Za-z0-9_-]+)/);
  const code = m ? m[1] : null;
  if (!code) return null;

  let host = "api.pcloud.com"; // US default
  if (/e\.pcloud\.(link|com)|u\.pcloud\.link|eapi\./i.test(s)) {
    host = "eapi.pcloud.com"; // EU
  }
  return { code, host };
}

/** Provider name as shown to the user. */
export function providerLabel(provider: SourceProvider): string {
  return provider === "pcloud" ? "pCloud" : "Google Drive";
}

/* ---------------------------------------------------------------------------
   Paper-UI helpers (pure; checked by scripts/check-format.mjs).
   --------------------------------------------------------------------------- */

/** Pasted link -> provider + id (+ pCloud host), or null if unusable. */
export function parseLink(
  raw: string,
): { provider: SourceProvider; id: string; host: string | null } | null {
  const provider = detectProvider(raw);
  if (provider === "pcloud") {
    const p = parsePcloudLink(raw);
    return p && { provider, id: p.code, host: p.host };
  }
  const id = extractFolderId(raw);
  return id ? { provider, id, host: null } : null;
}

const clean = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\:]/g, "-")
    .trim();

/** One safe path segment: control chars stripped, `/ \ :` -> `-`, and
 *  "", "." and ".." fall back (the only guard on dest_path). */
export function cleanFolderName(draft: string, fallback: string): string {
  const ok = (s: string) => s !== "" && s !== "." && s !== "..";
  const d = clean(draft);
  if (ok(d)) return d;
  const f = clean(fallback);
  return ok(f) ? f : "Folder";
}

/** Home-directory prefix -> "~". */
export function tildify(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+/, "~");
}

export function fmtInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.round(minutes / 60);
  return h === 1 ? "1 hr" : `${h} hr`;
}

export function fmtTimeLeft(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return "";
  if (sec < 60) return "less than a minute left";
  const m = Math.round(sec / 60);
  if (m < 60) return `about ${m} ${m === 1 ? "minute" : "minutes"} left`;
  const h = Math.round(m / 60);
  return `about ${h} ${h === 1 ? "hour" : "hours"} left`;
}

/** Status precedence: running > failed > cancelled > paused > idle > ok. */
export function folderStatus(
  m: { last_status: MappingStatus; last_at: string | null; auto_sync: boolean },
  running: boolean,
  pct: number,
): { tone: Tone; line: string } {
  const when = m.last_at ? relTime(m.last_at) : "";
  if (running) return { tone: "busy", line: `Copying · ${Math.round(pct)}%` };
  if (m.last_status === "failed") return { tone: "problem", line: "Needs attention" };
  if (m.last_status === "cancelled") return { tone: "waiting", line: "Stopped" };
  if (!m.auto_sync)
    return {
      tone: "paused",
      line: when ? `Paused · copied ${when}` : "Paused · not copied yet",
    };
  if (m.last_status === "idle") return { tone: "waiting", line: "Not copied yet" };
  return { tone: "ok", line: `Up to date · ${when || "just now"}` };
}

/** Failure text -> card copy + which fix applies. */
export function problemOf(
  lastError: string | null,
  skipShortcuts: boolean,
): { title: string; body: string; kind: "retry" | "skipShortcuts" } {
  if (/folder loop/i.test(lastError ?? ""))
    return {
      title: "This folder loops back on itself",
      body: "A shortcut inside it points to one of its own parent folders, so the copy would never finish. Skipping shortcuts copies everything else normally.",
      kind: skipShortcuts ? "retry" : "skipShortcuts",
    };
  return {
    title: "Couldn't finish copying",
    body: lastError || "Something went wrong while copying.",
    kind: "retry",
  };
}

export function headline(rows: { tone: Tone; name: string }[]): string {
  const n = (t: Tone) => rows.filter((r) => r.tone === t);
  const bad = n("problem").length;
  if (bad) return bad === 1 ? "1 folder needs you." : `${bad} folders need you.`;
  const busy = n("busy");
  if (busy.length)
    return busy.length === 1
      ? `Copying ${busy[0].name}`
      : `Copying ${busy.length} folders`;
  const wait = n("waiting").length;
  if (wait) return `${wait} ${wait === 1 ? "folder" : "folders"} waiting.`;
  return "Everything's up to date.";
}
