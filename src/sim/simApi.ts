/* ============================================================================
   Trawl — browser simulation adapter.
   Implements the Api interface without any Tauri runtime. Every method either
   resolves immediately (with a brief async pause to mimic latency) or runs an
   animated tick-loop that mirrors the prototype's pacing in Trawl App.dc.html.
   ============================================================================ */

import type {
  Api,
  ConnectionState,
  FolderNode,
  ListSourceArgs,
  Mapping,
  MappingStatus,
  NewMapping,
  RunLogLine,
  RunLogKind,
  RunProgress,
  Settings,
  SourceKind,
  SourceProvider,
  UpdateInfo,
} from "../types";
import {
  simSourceChildren,
  simResolveSourceName,
  simPcloudChildren,
  simPcloudResolveName,
  simLocalChildren,
  genTotals,
  FILES,
  NAS,
} from "./catalog";

/* ---------------------------------------------------------------------------
   Tiny helpers
   --------------------------------------------------------------------------- */

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}

/** HH:MM:SS clock from a run-start timestamp + elapsed seconds. */
function fmtClock(t0: number, elapsed: number): string {
  const d = new Date(t0 + elapsed * 1000);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function fmtBytes(n: number): string {
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

function fmtDur(s: number): string {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.round(s);
  const m = Math.floor(s / 60),
    ss = s % 60;
  return (m < 10 ? "0" : "") + m + ":" + (ss < 10 ? "0" : "") + ss;
}

function logLine(text: string, kind: RunLogKind): RunLogLine {
  return { text, kind };
}

/* ---------------------------------------------------------------------------
   Active run state (per runId)
   --------------------------------------------------------------------------- */

interface ActiveRun {
  intervalId: ReturnType<typeof setInterval>;
  mappingId: string;
  snapshot: RunProgress;
  t0: number;
  elapsed: number;
  simSeconds: number;
}

/* ---------------------------------------------------------------------------
   simApi implementation
   --------------------------------------------------------------------------- */

class SimApi implements Api {
  readonly isReal = false;

  // local folder creation tracking (for simLocalChildren)
  private created: string[] = [];

  // in-memory mappings store
  private mappings: Mapping[] = [];

  // run subscribers
  private listeners: Set<(p: RunProgress) => void> = new Set();

  // state-change subscribers (for onStateChanged)
  private stateListeners: Set<() => void> = new Set();

  // active intervals keyed by runId
  private runs: Map<number, ActiveRun> = new Map();

  // sim-owned run id source (mirrors the backend assigning ids)
  private runCounter = 43;

  // in-memory settings
  private settings: Settings = {
    auto_sync_enabled: true,
    auto_sync_interval_minutes: 15,
    minimize_to_tray: true,
  };

  // tracks last auto-run wallclock time per mappingId (undefined = never / due immediately)
  private lastAutoRunMs: Map<string, number> = new Map();

  // handle for the ~3s scheduler interval
  private schedulerIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.startScheduler();
  }

  // ---------- scheduler ----------

  private startScheduler(): void {
    if (this.schedulerIntervalId !== null) return;
    // Guard against Vite HMR / a second SimApi creating a duplicate interval:
    // clear any prior one stashed on globalThis before starting ours.
    const g = globalThis as unknown as { __trawlSimSched?: ReturnType<typeof setInterval> };
    if (g.__trawlSimSched) clearInterval(g.__trawlSimSched);
    this.schedulerIntervalId = setInterval(() => this.schedulerTick(), 3_000);
    g.__trawlSimSched = this.schedulerIntervalId;
  }

  private schedulerTick(): void {
    if (!this.settings.auto_sync_enabled) return;
    const intervalMs = this.settings.auto_sync_interval_minutes * 60 * 1_000;
    const now = Date.now();

    for (const mapping of this.mappings) {
      if (!mapping.enabled || !mapping.auto_sync) continue;

      // Skip if already running
      const alreadyRunning = [...this.runs.values()].some(
        (r) => r.mappingId === mapping.id,
      );
      if (alreadyRunning) continue;

      // Due when never auto-synced this session, or last run was ≥ interval ago
      const last = this.lastAutoRunMs.get(mapping.id);
      const isDue = last === undefined || now - last >= intervalMs;
      if (!isDue) continue;

      this.lastAutoRunMs.set(mapping.id, now);
      // Fire-and-forget; startSync is async but we don't need to await here
      void this.startSync(mapping.id);
    }
  }

  // ---------- emit state changed ----------

  private emitStateChanged(): void {
    for (const cb of this.stateListeners) {
      cb();
    }
  }

  // ---------- connection ----------

  async detectConnection(): Promise<ConnectionState> {
    // Sim is always connected so the full UI is explorable
    return { phase: "connected", remote: "gdrive", error: null };
  }

  async connectDrive(): Promise<ConnectionState> {
    await delay(600);
    return { phase: "connected", remote: "gdrive", error: null };
  }

  // ---------- library root ----------

  private libraryRoot = "~/Trawl";

  async getLibraryRoot(): Promise<string> {
    return this.libraryRoot;
  }

  async pickLibraryRoot(): Promise<string | null> {
    // No native picker in sim; simulate the user choosing a different folder.
    await delay(300);
    this.libraryRoot =
      this.libraryRoot === "~/Trawl" ? "/Users/you/3D Library" : "~/Trawl";
    return this.libraryRoot;
  }

  // ---------- folder listings ----------

  async listSourceFolders(args: ListSourceArgs): Promise<FolderNode[]> {
    if (args.provider === "pcloud") {
      await delay(450);
      return simPcloudChildren(args.subpath);
    }
    await delay(480);
    return simSourceChildren(args.kind, args.subpath);
  }

  async resolveSourceName(
    provider: SourceProvider,
    kind: SourceKind,
    _sourceId: string | null,
    _host: string | null,
  ): Promise<string> {
    if (provider === "pcloud") return simPcloudResolveName();
    return simResolveSourceName(kind);
  }

  async listLocalFolders(subpath: string): Promise<FolderNode[]> {
    await delay(380);
    return simLocalChildren(subpath, this.created);
  }

  async createLocalFolder(subpath: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.created.includes(subpath)) {
      this.created.push(subpath);
    }
    return { ok: true };
  }

  async localPathExists(subpath: string): Promise<boolean> {
    // Known in NAS catalog or in the sim-created list
    return subpath in NAS || this.created.includes(subpath);
  }

  // ---------- mappings persistence ----------

  async loadMappings(): Promise<Mapping[]> {
    // Start empty so the empty-state UI is reachable
    return [...this.mappings];
  }

  async saveMappings(news: NewMapping[]): Promise<Mapping[]> {
    const identity = (m: {
      source_provider: string;
      source_id: string | null;
      source_subpath: string;
      dest_subpath: string;
      dest_path: string;
    }) =>
      `${m.source_provider}${m.source_id ?? ""}${m.source_subpath}${m.dest_path || m.dest_subpath}`;
    for (const nm of news) {
      // Dedup by FULL identity (provider + source + dest), not destination alone.
      const existing = this.mappings.find((m) => identity(m) === identity(nm));
      if (existing) continue;

      const m: Mapping = {
        ...nm,
        id: crypto.randomUUID(),
        enabled: true,
        auto_sync: false,
        last_status: "idle" as MappingStatus,
        last_at: null,
        last_files: null,
        last_bytes: null,
        last_error: null,
      };
      this.mappings.push(m);
    }
    return [...this.mappings];
  }

  async deleteMapping(id: string): Promise<void> {
    this.mappings = this.mappings.filter((m) => m.id !== id);
    this.lastAutoRunMs.delete(id);
  }

  async setMappingAutoSync(id: string, auto: boolean): Promise<Mapping[]> {
    this.mappings = this.mappings.map((m) =>
      m.id === id ? { ...m, auto_sync: auto } : m,
    );
    if (auto) {
      // Treat as due immediately so the scheduler picks it up within ~3s
      this.lastAutoRunMs.delete(id);
    }
    return [...this.mappings];
  }

  async setMappingSkipShortcuts(id: string, skip: boolean): Promise<Mapping[]> {
    this.mappings = this.mappings.map((m) =>
      m.id === id ? { ...m, skip_shortcuts: skip } : m,
    );
    return [...this.mappings];
  }

  // ---------- updates ----------

  async checkForUpdate(): Promise<UpdateInfo | null> {
    // Browser sim has no real update channel — always "current".
    await delay(400);
    return null;
  }

  async installUpdate(): Promise<void> {
    // no-op in the sim
  }

  // ---------- settings ----------

  async getSettings(): Promise<Settings> {
    return { ...this.settings };
  }

  async setSettings(settings: Settings): Promise<Settings> {
    this.settings = { ...settings };
    this.emitStateChanged();
    return { ...this.settings };
  }

  async onStateChanged(cb: () => void): Promise<() => void> {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  // ---------- runs ----------

  async startSync(mappingId: string): Promise<number> {
    const runId = this.runCounter++;
    const mapping = this.mappings.find((m) => m.id === mappingId);
    if (!mapping) return runId;

    const { bytes: bytesTotal, files: filesTotal } = genTotals(mapping.source_name);
    // Prototype: simSeconds = (7 + files%6) at normal speed
    const simSeconds = 7 + (filesTotal % 6);

    const t0 = Date.now();

    const initialSnapshot: RunProgress = {
      runId,
      mappingId,
      name: mapping.source_name,
      src: mapping.src_label + " " + mapping.source_name,
      dest: "~/Trawl/" + mapping.dest_subpath,
      status: "running",
      bytesDone: 0,
      bytesTotal,
      filesDone: 0,
      filesTotal,
      speed: 0,
      etaSec: 0,
      log: [
        logLine(
          "rclone sync/copy → group=run-" + runId,
          "meta",
        ),
      ],
    };

    // Track mutable run state alongside the active interval
    const activeRun: ActiveRun = {
      intervalId: undefined as unknown as ReturnType<typeof setInterval>,
      mappingId,
      snapshot: { ...initialSnapshot, log: [...initialSnapshot.log] },
      t0,
      elapsed: 0,
      simSeconds,
    };

    const isFailMode = /dragon/i.test(mapping.source_name);

    const tick = () => {
      const r = activeRun;
      const snap = r.snapshot;
      if (snap.status !== "running") {
        clearInterval(r.intervalId);
        return;
      }

      const dt = 0.28;
      r.elapsed += dt;

      // Prototype: add = bytesTotal*(dt/simSeconds)*(0.55+Math.random()*0.95)
      const add =
        snap.bytesTotal *
        (dt / r.simSeconds) *
        (0.55 + Math.random() * 0.95);

      const newLog = [...snap.log];

      // --- FAILURE path ---
      if (isFailMode && snap.bytesDone + add >= snap.bytesTotal * 0.4) {
        const bytesDone = snap.bytesTotal * 0.4;
        const clock = fmtClock(r.t0, r.elapsed);
        newLog.push(
          logLine(
            clock +
              " ERROR : " +
              mapping.dest_subpath +
              "/dragon_body.stl: Failed to copy: googleapi 403 — file flagged as malware/spam",
            "error",
          ),
        );
        newLog.push(
          logLine(
            clock +
              " NOTICE: retry with --drive-acknowledge-abuse to override",
            "notice",
          ),
        );
        r.snapshot = {
          ...snap,
          status: "failed",
          bytesDone,
          log: newLog,
        };
        this.emit(r.snapshot);
        clearInterval(r.intervalId);
        this.runs.delete(runId);
        return;
      }

      let newBytesDone = snap.bytesDone + add;
      const speed = add / dt;

      // --- SUCCESS path ---
      if (newBytesDone >= snap.bytesTotal) {
        const clock = fmtClock(r.t0, r.elapsed);
        newLog.push(
          logLine(
            clock +
              " INFO  : Transferred: " +
              fmtBytes(snap.bytesTotal) +
              " / " +
              fmtBytes(snap.bytesTotal) +
              ", 100%",
            "success",
          ),
        );
        newLog.push(
          logLine(
            clock +
              " INFO  : Copied " +
              snap.filesTotal +
              " files (new) in " +
              fmtDur(r.elapsed),
            "success",
          ),
        );
        r.snapshot = {
          ...snap,
          status: "succeeded",
          bytesDone: snap.bytesTotal,
          filesDone: snap.filesTotal,
          speed,
          etaSec: 0,
          log: newLog,
        };
        this.emit(r.snapshot);
        clearInterval(r.intervalId);
        this.runs.delete(runId);
        return;
      }

      // --- NORMAL tick ---
      const newFilesDone = Math.min(
        snap.filesTotal,
        Math.floor(snap.filesTotal * (newBytesDone / snap.bytesTotal)),
      );
      const newly = newFilesDone - snap.filesDone;
      const etaSec = speed > 0 ? (snap.bytesTotal - newBytesDone) / speed : 0;
      const clock = fmtClock(r.t0, r.elapsed);

      for (let k = 0; k < Math.min(newly, 3); k++) {
        newLog.push(
          logLine(
            clock +
              " INFO  : " +
              mapping.dest_subpath +
              "/" +
              FILES[Math.floor(Math.random() * FILES.length)] +
              ": Copied (new)",
            "info",
          ),
        );
      }

      // Cap log at 50 lines (prototype does same)
      const trimmedLog = newLog.length > 50 ? newLog.slice(-50) : newLog;

      r.snapshot = {
        ...snap,
        bytesDone: newBytesDone,
        filesDone: newFilesDone,
        speed,
        etaSec,
        log: trimmedLog,
      };
      this.emit(r.snapshot);
    };

    // Store the active run before starting the interval
    const intervalId = setInterval(tick, 280);
    activeRun.intervalId = intervalId;
    this.runs.set(runId, activeRun);

    // Emit initial snapshot immediately
    this.emit(initialSnapshot);

    return runId;
  }

  async cancelSync(runId: number): Promise<void> {
    const active = this.runs.get(runId);
    if (!active) return;

    clearInterval(active.intervalId);
    this.runs.delete(runId);

    const clock = fmtClock(active.t0, active.elapsed);
    const finalSnap: RunProgress = {
      ...active.snapshot,
      status: "cancelled",
      log: [
        ...active.snapshot.log,
        logLine(
          clock +
            " NOTICE: job/stop received — transfer cancelled",
          "notice",
        ),
      ],
    };
    this.emit(finalSnap);
  }

  async onRunUpdate(cb: (p: RunProgress) => void): Promise<() => void> {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ---------- private ----------

  private emit(p: RunProgress): void {
    for (const cb of this.listeners) {
      cb(p);
    }
  }
}

export const simApi: Api = new SimApi();
