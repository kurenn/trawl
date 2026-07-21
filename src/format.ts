/* ============================================================================
   Trawl — shared formatting + status presentation.
   Transcribed from the prototype (Trawl App.dc.html) so numbers/labels match.
   ============================================================================ */

import type { MappingStatus, StatusMeta } from "./types";

/** STATUS map — verbatim from prototype. */
export const STATUS: Record<MappingStatus, StatusMeta> = {
  succeeded: {
    label: "Synced",
    color: "#2dd4bf",
    bg: "rgba(45,212,191,.12)",
    cardBd: "#2c2f3a",
  },
  failed: {
    label: "Failed",
    color: "#f43f5e",
    bg: "rgba(244,63,94,.12)",
    cardBd: "#3a2329",
  },
  running: {
    label: "Syncing",
    color: "#f59e0b",
    bg: "rgba(245,158,11,.12)",
    cardBd: "#3a3320",
  },
  cancelled: {
    label: "Cancelled",
    color: "#9499a3",
    bg: "rgba(148,153,163,.12)",
    cardBd: "#2c2f3a",
  },
  idle: {
    label: "Not synced",
    color: "#7b808c",
    bg: "rgba(123,128,140,.12)",
    cardBd: "#2c2f3a",
  },
};

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

export function fmtDur(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.round(s);
  const m = Math.floor(s / 60),
    ss = s % 60;
  return (m < 10 ? "0" : "") + m + ":" + (ss < 10 ? "0" : "") + ss;
}

export function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}

export function zeroPadRunId(n: number): string {
  return ("00000" + n).slice(-5);
}

/** "x files · y" meta line builder, or "never · manual" for idle. */
export function metaLine(m: {
  last_status: MappingStatus;
  enabled: boolean;
  last_at: string | null;
  last_files: number | null;
  last_bytes: number | null;
}): string {
  if (m.last_status === "idle") {
    return "Last sync · never · " + (m.enabled ? "manual" : "disabled");
  }
  const when = m.last_at ? relTime(m.last_at) : "just now";
  const stats =
    m.last_files != null && m.last_bytes != null
      ? " · " + m.last_files + " files · " + fmtBytes(m.last_bytes)
      : "";
  return "Last sync · " + when + stats;
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
export function srcLabel(
  kind: "folder_id" | "shared_with_me",
  remote: string,
  sourceId: string | null,
): string {
  if (kind === "folder_id") {
    return `${remote},root_folder_id=${sourceId ?? "…"}:`;
  }
  return `${remote},shared_with_me:`;
}

/* ---------------------------------------------------------------------------
   Provider detection (gdrive vs pcloud) for the pasted-link flow.
   --------------------------------------------------------------------------- */

import type { SourceProvider } from "./types";

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

/** Short provider tag for cards. */
export function providerLabel(provider: SourceProvider): string {
  return provider === "pcloud" ? "pCloud" : "Drive";
}
