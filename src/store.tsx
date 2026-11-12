/* ============================================================================
   Trawl — State Brain (store.tsx)
   Implements the UseTrawl interface consumed by all views.
   API calls are routed exclusively through getApi() from src/api.ts.
   ============================================================================ */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getApi } from "./api";
import {
  cleanFolderName,
  fmtBytes,
  fmtInterval,
  fmtTimeLeft,
  folderStatus,
  headline as headlineOf,
  parseLink,
  problemOf,
  providerLabel,
  srcLabel,
  tildify,
} from "./format";
import type {
  Api,
  ConnectionState,
  FolderNode,
  FolderRow,
  Mapping,
  MappingStatus,
  NewMapping,
  PreviewModel,
  Problem,
  RunProgress,
  RunView,
  Settings,
  SourceProvider,
  UpdateState,
  UseTrawl,
  View,
} from "./types";

/* ---------------------------------------------------------------------------
   Preview (the paste-first add flow) — local state shape
   --------------------------------------------------------------------------- */

interface PreviewState {
  phase: PreviewModel["phase"];
  link: string;
  error: string;
  provider: SourceProvider;
  id: string;
  host: string | null;
  sourceName: string;
  name: string;
  subfolders: FolderNode[];
  choice: string;
  keepUpToDate: boolean;
  keepEdits: boolean;
  exists: boolean;
  starting: boolean;
}

/** Optimistic "Starting…" snapshot, shown until the first real run event. */
const startingRun = (mappingId: string, m: Mapping | undefined): RunProgress => ({
  runId: 0,
  mappingId,
  name: m?.source_name ?? "",
  src: m?.src_label ?? "",
  dest: m?.dest_path ?? "",
  status: "running",
  bytesDone: 0,
  bytesTotal: 0,
  filesDone: 0,
  filesTotal: 0,
  speed: 0,
  etaSec: 0,
  log: [],
  error: null,
});

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ---------------------------------------------------------------------------
   Context
   --------------------------------------------------------------------------- */

const TrawlContext = createContext<UseTrawl | null>(null);

/** How long an "couldn't open that folder" message stays on screen. */
const OPEN_FOLDER_ERROR_MS = 6000;

/* ---------------------------------------------------------------------------
   Provider
   --------------------------------------------------------------------------- */

export function TrawlProvider({ children }: { children: React.ReactNode }) {
  // ---- API ref ----
  const apiRef = useRef<Api | null>(null);

  // ---- Shell / nav ----
  const [view, setView] = useState<View>("home");
  // The folder shown in the "folder" / "copying" views.
  const [folderId, setFolderId] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>({
    phase: "checking",
    remote: "gdrive",
    error: null,
  });
  const [libraryRoot, setLibraryRoot] = useState<string>("");
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [pendingStop, setPendingStop] = useState<string | null>(null);
  // Transient "couldn't open that folder" message, scoped to the mapping whose
  // button was clicked so it renders next to the thing that failed.
  const [openFolderError, setOpenFolderError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const openFolderErrorTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // ---- In-app updater ----
  const [update, setUpdate] = useState<UpdateState>({
    phase: "idle",
    version: null,
    error: null,
  });

  // ---- Settings ----
  const [settings, setSettingsState] = useState<Settings>({
    auto_sync_enabled: true,
    auto_sync_interval_minutes: 15,
    minimize_to_tray: true,
  });

  // ---- 30s ticker so relative times ("2m ago") stay fresh without re-rendering every view each second ----
  const [tick, setNowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  // ---- Run ----
  const [activeRun, setActiveRun] = useState<RunProgress | null>(null);
  // Live progress for EVERY in-flight run, keyed by mappingId, so library
  // rows can show a progress bar.
  const [liveProgress, setLiveProgress] = useState<Map<string, RunProgress>>(
    new Map(),
  );
  // mappingId of the run shown in the Copying view. Run events are correlated
  // by mappingId; only one run per mapping is allowed.
  const activeMappingRef = useRef<string | null>(null);
  // Refs so the once-mounted onRunUpdate subscription reads current values.
  const mappingsRef = useRef<Mapping[]>([]);
  const liveProgressRef = useRef<Map<string, RunProgress>>(new Map());
  const libraryRootRef = useRef<string>("");
  // Monotonic token to discard stale preview-listing responses (#race guard).
  const listSeqRef = useRef<number>(0);
  // Same, for the "does this folder already exist" check.
  const existsSeqRef = useRef<number>(0);
  // Highest runId seen per mapping — discards stale events from an older run.
  const lastRunIdRef = useRef<Map<string, number>>(new Map());

  // ---- Paste / preview ----
  const [pasteError, setPasteError] = useState<string>("");
  const [pv, setPv] = useState<PreviewState | null>(null);
  const patchPv = useCallback(
    (p: Partial<PreviewState>) => setPv((s) => (s ? { ...s, ...p } : s)),
    [],
  );

  /* -------------------------------------------------------------------------
     Mount: boot API, detect connection, load library root + mappings,
     subscribe to run updates.
     ---------------------------------------------------------------------- */
  useEffect(() => {
    let unsubRun: (() => void) | null = null;
    let unsubState: (() => void) | null = null;
    let mounted = true;

    (async () => {
      const api = await getApi();
      if (!mounted) return;
      apiRef.current = api;

      // Kick off all four in parallel
      const [conn, root, maps, sett] = await Promise.all([
        api.detectConnection(),
        api.getLibraryRoot(),
        api.loadMappings(),
        api.getSettings(),
      ]);
      if (!mounted) return;
      setConnection(conn);
      setLibraryRoot(root);
      libraryRootRef.current = root;
      setMappings(maps);
      mappingsRef.current = maps;
      setSettingsState(sett);

      // Fire-and-forget: check for a newer version on launch. Drive-independent
      // (works for pCloud-only users too); failures are silent (offline, etc.).
      setUpdate((u) => ({ ...u, phase: "checking", error: null }));
      api
        .checkForUpdate()
        .then((info) => {
          if (!mounted) return;
          setUpdate(
            info
              ? { phase: "available", version: info.version, error: null }
              : { phase: "current", version: null, error: null },
          );
        })
        .catch(() => {
          if (mounted) setUpdate({ phase: "idle", version: null, error: null });
        });

      // Reload mappings + settings whenever the backend changes shared state
      // (tray toggle, auto-sync scheduler, etc.)
      unsubState = await api.onStateChanged(async () => {
        if (!mounted) return;
        const [freshMaps, freshSett] = await Promise.all([
          api.loadMappings(),
          api.getSettings(),
        ]);
        if (!mounted) return;
        // Preserve cards that are optimistically "running": a reload from
        // persisted state (triggered when ANY mapping completes) would
        // otherwise downgrade an unrelated in-flight card mid-run. The run's
        // own terminal event sets its final status.
        // Merge inside a functional update so it sees a terminal event that
        // landed during the await above. Reading mappingsRef here instead (it
        // lags a render behind) re-marked just-finished runs "running", and
        // nothing ever cleared them.
        setMappings((prev) =>
          freshMaps.map((fm) => {
            const cur = prev.find((m) => m.id === fm.id);
            if (cur && cur.last_status === "running") {
              return {
                ...fm,
                last_status: "running" as MappingStatus,
                last_at: cur.last_at,
                last_files: cur.last_files,
                last_bytes: cur.last_bytes,
                last_error: cur.last_error,
              };
            }
            return fm;
          }),
        );
        setSettingsState(freshSett);
      });

      // Subscribe to run updates.
      // - For EVERY event: update the matching mapping's transient status on the
      //   card (so background/auto syncs are reflected even without user action).
      // - Gated on activeMappingRef: only update the run-view snapshot when the
      //   event belongs to the actively displayed run.
      unsubRun = await api.onRunUpdate((progress: RunProgress) => {
        if (!mounted) return;

        // Ordering guard: ignore a late event from an older run of this mapping
        // (runs are serialized per mapping, but this is cheap insurance against
        // a stale terminal event clobbering a newer run's state).
        const lastSeen = lastRunIdRef.current.get(progress.mappingId) ?? -1;
        if (progress.runId < lastSeen) return;
        lastRunIdRef.current.set(progress.mappingId, progress.runId);

        const terminal =
          progress.status === "succeeded" ||
          progress.status === "failed" ||
          progress.status === "cancelled";

        // Track per-mapping live progress for the dashboard card bars.
        setLiveProgress((prev) => {
          const next = new Map(prev);
          if (terminal) next.delete(progress.mappingId);
          else next.set(progress.mappingId, progress);
          return next;
        });

        // Always update the card for the matching mapping.
        setMappings((prev) =>
          prev.map((m) => {
            if (m.id !== progress.mappingId) return m;
            if (terminal) {
              const now = new Date().toISOString();
              return {
                ...m,
                last_status: progress.status as MappingStatus,
                last_at: now,
                last_files:
                  progress.status === "succeeded" ? progress.filesTotal : null,
                last_bytes:
                  progress.status === "succeeded" ? progress.bytesTotal : null,
                // The engine states the reason explicitly — don't re-derive it
                // from the log, whose closing line summarises rather than
                // explains and which is length-capped anyway.
                last_error:
                  progress.status === "failed"
                    ? progress.error ?? "Couldn't finish copying"
                    : null,
              };
            }
            // Running — update the live status so the card badge reflects it,
            // and drop any prior error so the banner reflects THIS run, not the
            // last failure. (Only non-terminal statuses reach here.)
            return {
              ...m,
              last_status: progress.status as MappingStatus,
              last_error: null,
            };
          }),
        );

        // Keep the Run view's snapshot live only while its mapping is open.
        if (progress.mappingId === activeMappingRef.current) {
          setActiveRun(progress);
        }
      });
    })().catch(console.error);

    return () => {
      mounted = false;
      unsubRun?.();
      unsubState?.();
    };
  }, []);

  // Don't let a pending "couldn't open that folder" timeout fire after unmount.
  useEffect(
    () => () => {
      if (openFolderErrorTimer.current !== null) {
        clearTimeout(openFolderErrorTimer.current);
      }
    },
    [],
  );

  // Keep refs read by the once-mounted run subscription fresh.
  useEffect(() => {
    mappingsRef.current = mappings;
  }, [mappings]);
  useEffect(() => {
    libraryRootRef.current = libraryRoot;
  }, [libraryRoot]);
  useEffect(() => {
    liveProgressRef.current = liveProgress;
  }, [liveProgress]);

  /* -------------------------------------------------------------------------
     NAV
     ---------------------------------------------------------------------- */

  const goHome = useCallback(() => {
    listSeqRef.current++; // abandon any in-flight preview listing
    activeMappingRef.current = null;
    setActiveRun(null);
    setPv(null);
    setPendingStop(null);
    setFolderId(null);
    setPasteError("");
    setView("home");
  }, []);

  const goSettings = useCallback(() => {
    setPasteError("");
    setView("settings");
  }, []);

  const connect = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    setConnection((prev) => ({ ...prev, phase: "connecting", error: null }));
    api
      .connectDrive()
      .then(setConnection)
      .catch((e: unknown) =>
        setConnection({
          phase: "error",
          remote: "gdrive",
          error: String(e),
        }),
      );
  }, []);

  // Where NEW folders land. Existing folders keep their own dest_path.
  const changeLibraryRoot = useCallback(() => {
    apiRef.current
      ?.pickLibraryRoot()
      .then((path) => {
        if (!path) return; // user cancelled
        setLibraryRoot(path);
        libraryRootRef.current = path;
      })
      .catch(console.error);
  }, []);

  /* -------------------------------------------------------------------------
     IN-APP UPDATER
     ---------------------------------------------------------------------- */

  const checkForUpdate = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    setUpdate((u) => ({ ...u, phase: "checking", error: null }));
    api
      .checkForUpdate()
      .then((info) =>
        setUpdate(
          info
            ? { phase: "available", version: info.version, error: null }
            : { phase: "current", version: null, error: null },
        ),
      )
      .catch((e: unknown) =>
        setUpdate({ phase: "error", version: null, error: String(e) }),
      );
  }, []);

  const installUpdate = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    // Downloads, installs, and relaunches into the new version — the process
    // exits on success, so there's no "done" state to set here.
    setUpdate((u) => ({ ...u, phase: "downloading", error: null }));
    api.installUpdate().catch((e: unknown) =>
      setUpdate((u) => ({ ...u, phase: "error", error: String(e) })),
    );
  }, []);

  /* -------------------------------------------------------------------------
     RUNS
     ---------------------------------------------------------------------- */

  // Start a sync WITHOUT navigating — progress shows on the folder's own row.
  // An optimistic running snapshot makes the bar appear instantly.
  const startRun = useCallback((mappingId: string) => {
    const api = apiRef.current;
    if (!api || liveProgressRef.current.has(mappingId)) return; // already running
    setPendingStop(null);
    // Drop a finished run still shown in Copying so the new one replaces it.
    if (activeMappingRef.current === mappingId) setActiveRun(null);

    setLiveProgress((prev) => {
      if (prev.has(mappingId)) return prev;
      const next = new Map(prev);
      next.set(
        mappingId,
        startingRun(mappingId, mappingsRef.current.find((x) => x.id === mappingId)),
      );
      return next;
    });
    setMappings((prev) =>
      prev.map((m) =>
        m.id === mappingId
          ? { ...m, last_status: "running" as MappingStatus, last_error: null }
          : m,
      ),
    );

    api.startSync(mappingId).catch((e: unknown) => {
      console.error(e);
      // Drop the optimistic placeholder if no real run took over, and refresh
      // the true status (incl. last_error) from disk.
      const errMessage = errMsg(e);
      // Decide from `prev`, not liveProgressRef: the ref is only refreshed on
      // render and can be stale if startSync rejects before the placeholder renders.
      setLiveProgress((prev) => {
        const lp = prev.get(mappingId);
        if (!lp || lp.runId !== 0) return prev;
        if (activeMappingRef.current === mappingId) {
          setActiveRun({ ...lp, status: "failed", error: errMessage });
        }
        const n = new Map(prev);
        n.delete(mappingId);
        return n;
      });
      // Overlay the failure so Home/Folder show the problem article; the next
      // loadMappings or run event replaces the row. A lock conflict ("already
      // syncing") means a run already holds the lock, so no failure is shown
      // and the row stays as reloaded. Rows still running locally are kept.
      const locked = /already syncing/i.test(errMessage);
      apiRef.current
        ?.loadMappings()
        .then((maps) =>
          setMappings((prev) =>
            maps.map((m) => {
              const cur = prev.find((x) => x.id === m.id);
              if (cur && cur.last_status === "running" && m.id !== mappingId) return cur;
              return m.id === mappingId && !locked
                ? { ...m, last_status: "failed" as MappingStatus, last_error: errMessage }
                : m;
            }),
          ),
        )
        .catch(() => {});
    });
  }, []);

  // Reveal a mapping's destination folder in Finder/Explorer. Failures (folder
  // never created, volume unmounted) surface inline on the card and clear
  // themselves, so a one-off miss doesn't linger as if it were run state.
  const openFolder = useCallback((mappingId: string) => {
    const api = apiRef.current;
    if (!api) return;
    setOpenFolderError(null);
    api.openMappingFolder(mappingId).catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      setOpenFolderError({ id: mappingId, message });
      if (openFolderErrorTimer.current !== null) {
        clearTimeout(openFolderErrorTimer.current);
      }
      openFolderErrorTimer.current = setTimeout(
        () => setOpenFolderError(null),
        OPEN_FOLDER_ERROR_MS,
      );
    });
  }, []);

  // Open the Copying view for a folder's in-flight (or just-finished) run.
  const openRun = useCallback((mappingId: string) => {
    activeMappingRef.current = mappingId;
    setActiveRun(liveProgressRef.current.get(mappingId) ?? null);
    setFolderId(mappingId);
    setView("copying");
  }, []);

  // Check every folder now; the backend semaphore caps concurrency.
  const checkAll = useCallback(() => {
    mappingsRef.current
      .filter((m) => m.enabled && !liveProgressRef.current.has(m.id))
      .forEach((m) => startRun(m.id));
  }, [startRun]);

  // Set (never toggle) skip_shortcuts, persist it, and only then re-run.
  const fixProblem = useCallback(
    (id: string) => {
      apiRef.current
        ?.setMappingSkipShortcuts(id, true)
        .then((updated) => {
          setMappings(updated);
          mappingsRef.current = updated;
          startRun(id);
        })
        .catch(console.error);
    },
    [startRun],
  );

  const makeProblem = useCallback(
    (m: Mapping, lastError: string | null): Problem => {
      const p = problemOf(lastError, m.skip_shortcuts);
      const skip = p.kind === "skipShortcuts";
      return {
        title: p.title,
        body: p.body,
        fixLabel: skip ? "Skip shortcuts and try again" : "Try again",
        fix: () => (skip ? fixProblem(m.id) : startRun(m.id)),
      };
    },
    [fixProblem, startRun],
  );

  /* -------------------------------------------------------------------------
     SETTINGS — setAutoIntervalMinutes
     ---------------------------------------------------------------------- */

  const setAutoIntervalMinutes = useCallback(
    (m: number) => {
      const api = apiRef.current;
      if (!api) return;
      const next: Settings =
        m <= 0
          ? { ...settings, auto_sync_enabled: false }
          : {
              ...settings,
              auto_sync_enabled: true,
              auto_sync_interval_minutes: m,
            };
      // Optimistic update
      setSettingsState(next);
      api.setSettings(next).then(setSettingsState).catch(console.error);
    },
    [settings],
  );

  /* -------------------------------------------------------------------------
     PER-MAPPING AUTO TOGGLE
     ---------------------------------------------------------------------- */

  const toggleAuto = useCallback(
    (id: string) => {
      const api = apiRef.current;
      if (!api) return;
      const current = mappingsRef.current.find((m) => m.id === id);
      if (!current) return;
      api
        .setMappingAutoSync(id, !current.auto_sync)
        .then((updated) => {
          setMappings(updated);
          mappingsRef.current = updated;
        })
        .catch(console.error);
    },
    [],
  );

  const toggleProtectLocalEdits = useCallback(
    (id: string) => {
      const api = apiRef.current;
      if (!api) return;
      const current = mappingsRef.current.find((m) => m.id === id);
      if (!current) return;
      api
        .setMappingProtectLocalEdits(id, !current.protect_local_edits)
        .then((updated) => {
          setMappings(updated);
          mappingsRef.current = updated;
        })
        .catch(console.error);
    },
    [],
  );

  const setMinimizeToTray = useCallback(
    (on: boolean) => {
      const api = apiRef.current;
      if (!api) return;
      const next: Settings = { ...settings, minimize_to_tray: on };
      setSettingsState(next);
      api.setSettings(next).then(setSettingsState).catch(console.error);
    },
    [settings],
  );

  /* -------------------------------------------------------------------------
     PREVIEW — paste a link, look inside, start copying
     ---------------------------------------------------------------------- */

  const loadPreview = useCallback(
    (src: { provider: SourceProvider; id: string; host: string | null }) => {
      const api = apiRef.current;
      if (!api) return;
      const seq = ++listSeqRef.current; // supersedes any in-flight listing
      patchPv({ phase: "loading", error: "" });
      Promise.all([
        api.resolveSourceName(src.provider, "folder_id", src.id, src.host),
        api.listSourceFolders({
          provider: src.provider,
          kind: "folder_id",
          sourceId: src.id,
          host: src.host,
          subpath: "",
        }),
      ])
        .then(([resolved, nodes]) => {
          if (seq !== listSeqRef.current) return; // stale
          const sourceName = cleanFolderName(
            resolved,
            src.provider === "pcloud" ? "pCloud folder" : "Drive folder",
          );
          patchPv({ phase: "ready", sourceName, name: sourceName, subfolders: nodes });
        })
        .catch((e: unknown) => {
          if (seq !== listSeqRef.current) return;
          patchPv({ phase: "error", error: errMsg(e) });
        });
    },
    [patchPv],
  );

  const pasteLink = useCallback(
    (text: string) => {
      const p = parseLink(text);
      if (!p) {
        setPasteError("That doesn't look like a Google Drive or pCloud folder link.");
        return;
      }
      setPasteError("");
      // Drive needs a signed-in remote (also while still "checking"); pCloud never does.
      const needSignin = p.provider === "gdrive" && connection.phase !== "connected";
      setPv({
        phase: needSignin ? "signin" : "loading",
        link: text.trim(),
        error: "",
        provider: p.provider,
        id: p.id,
        host: p.host,
        sourceName: "",
        name: "",
        subfolders: [],
        choice: "",
        keepUpToDate: true,
        keepEdits: true,
        exists: false,
        starting: false,
      });
      setView("preview");
      if (!needSignin) loadPreview(p);
    },
    [connection.phase, loadPreview],
  );

  // Sign-in finished while the preview was waiting for it: carry on.
  const pvPhase = pv?.phase;
  useEffect(() => {
    if (pv && pvPhase === "signin" && connection.phase === "connected") {
      loadPreview(pv);
    }
  }, [pvPhase, connection.phase, loadPreview]);

  // Does the destination folder already exist on disk? (drives the merge note)
  const pvName = pv?.name;
  useEffect(() => {
    const api = apiRef.current;
    if (!api || pvPhase !== "ready" || !pvName) return;
    const seq = ++existsSeqRef.current;
    api
      .localPathExists(pvName)
      .then((exists) => {
        if (seq === existsSeqRef.current) patchPv({ exists });
      })
      .catch(() => {});
  }, [pvPhase, pvName, libraryRoot, patchPv]);

  const startPreview = useCallback(() => {
    const api = apiRef.current;
    const s = pv;
    if (!api || !s || s.phase !== "ready" || s.starting) return;
    patchPv({ starting: true });
    const seq = listSeqRef.current; // goHome (Cancel) bumps it
    (async () => {
      try {
        const seg = cleanFolderName(s.name, s.sourceName);
        const nm: NewMapping = {
          source_provider: s.provider,
          source_kind: "folder_id",
          source_id: s.id,
          source_host: s.host,
          source_subpath: s.choice,
          source_name: seg,
          src_label:
            s.provider === "pcloud"
              ? `pcloud:${s.id}`
              : srcLabel(connection.remote || "gdrive", s.id),
          dest_subpath: seg,
          dest_path: `${libraryRoot}/${seg}`,
          acknowledge_abuse: true,
          skip_shortcuts: false,
          protect_local_edits: s.keepEdits,
        };
        const saved = await api.saveMappings([nm]);
        setMappings(saved);
        mappingsRef.current = saved; // startRun builds its placeholder from this
        // Also picks up a dedup'd duplicate.
        const m = saved.find(
          (x) =>
            x.source_id === s.id &&
            x.source_subpath === s.choice &&
            x.dest_path === nm.dest_path,
        );
        if (!m) throw new Error("Couldn't add that folder.");
        if (seq !== listSeqRef.current) return; // cancelled
        if (s.keepUpToDate) {
          const updated = await api.setMappingAutoSync(m.id, true);
          setMappings(updated);
          mappingsRef.current = updated;
        }
        if (seq !== listSeqRef.current) return; // cancelled
        startRun(m.id);
        openRun(m.id);
        setPv(null);
      } catch (e) {
        patchPv({ starting: false, phase: "error", error: errMsg(e) });
      }
    })();
  }, [pv, patchPv, connection.remote, libraryRoot, startRun, openRun]);

  const preview = useMemo<PreviewModel | null>(() => {
    if (view !== "preview" || !pv) return null;
    const defaultFor = (choice: string) =>
      cleanFolderName(
        choice === ""
          ? pv.sourceName
          : (pv.subfolders.find((n) => n.path === choice)?.name ?? pv.sourceName),
        pv.sourceName,
      );
    const dflt = defaultFor(pv.choice);
    return {
      phase: pv.phase,
      link: pv.link,
      error: pv.error,
      providerLabel: providerLabel(pv.provider),
      sourceName: pv.sourceName,
      name: pv.name,
      renamed: pv.name !== dflt,
      setName: (draft) => patchPv({ name: cleanFolderName(draft, dflt) }),
      resetName: () => patchPv({ name: dflt }),
      destPrefix: tildify(libraryRoot) + "/",
      exists: pv.exists,
      changeLocation: changeLibraryRoot,
      subfolders: pv.subfolders,
      choice: pv.choice,
      // The name follows the chosen folder unless the user renamed it.
      choose: (path) =>
        patchPv({ choice: path, ...(pv.name === dflt ? { name: defaultFor(path) } : {}) }),
      keepUpToDate: pv.keepUpToDate,
      toggleKeepUpToDate: () => patchPv({ keepUpToDate: !pv.keepUpToDate }),
      keepEdits: pv.keepEdits,
      toggleKeepEdits: () => patchPv({ keepEdits: !pv.keepEdits }),
      starting: pv.starting,
      start: startPreview,
      retry: () => loadPreview(pv),
      cancel: goHome,
    };
  }, [view, pv, patchPv, libraryRoot, changeLibraryRoot, startPreview, loadPreview, goHome]);

  /* -------------------------------------------------------------------------
     LIBRARY — folder rows
     ---------------------------------------------------------------------- */

  const folders = useMemo<FolderRow[]>(
    () =>
      mappings.map((m) => {
        const lp = liveProgress.get(m.id);
        const running = lp ? lp.status === "running" : m.last_status === "running";
        const ratio =
          lp && lp.bytesTotal > 0
            ? Math.min(1, Math.max(0, lp.bytesDone / lp.bytesTotal))
            : 0;
        const pct = Math.round(ratio * 100);
        const { tone, line } = folderStatus(m, running, pct);
        const problem = tone === "problem" ? makeProblem(m, m.last_error) : null;

        let action: FolderRow["action"] = null;
        if (running) action = { label: "Show progress", run: () => openRun(m.id) };
        else if (problem) action = { label: problem.fixLabel, run: problem.fix };
        else if (tone === "paused")
          action = { label: "Resume", run: () => toggleAuto(m.id) };
        else if (tone === "waiting")
          action = {
            label: m.last_status === "cancelled" ? "Resume" : "Copy now",
            run: () => startRun(m.id),
          };

        return {
          ...m,
          tone,
          statusLine: line,
          running,
          barWidth: `${(ratio * 100).toFixed(1)}%`,
          action,
          problem,
          destDisplay: tildify(
            m.dest_path ||
              (m.dest_subpath ? `${libraryRoot}/${m.dest_subpath}` : libraryRoot),
          ),
          fromLabel: providerLabel(m.source_provider),
          whatLabel: m.source_subpath || "Everything",
          open: () => {
            setPendingStop(null);
            setFolderId(m.id);
            setView("folder");
          },
          openRun: () => openRun(m.id),
          openFolder: () => openFolder(m.id),
          openFolderError:
            openFolderError?.id === m.id ? openFolderError.message : "",
          checkNow: () => startRun(m.id),
          toggleAuto: () => toggleAuto(m.id),
          toggleProtectLocalEdits: () => toggleProtectLocalEdits(m.id),
          pendingStop: pendingStop === m.id,
          askStop: () => {
            if (!running) setPendingStop(m.id);
          },
          // Config entry only; the files already copied stay on disk.
          confirmStop: () => {
            if (running || liveProgressRef.current.has(m.id)) return;
            apiRef.current?.deleteMapping(m.id).catch(console.error);
            setMappings((prev) => prev.filter((x) => x.id !== m.id));
            goHome();
          },
          cancelStop: () => setPendingStop(null),
        };
      }),
    [mappings, libraryRoot, pendingStop, liveProgress, openFolderError, settings, tick,
     makeProblem, startRun, openRun, openFolder, toggleAuto, toggleProtectLocalEdits, goHome],
  );

  const isEmpty = mappings.length === 0;
  const headline = headlineOf(
    folders.map((f) => ({ tone: f.tone, name: f.source_name })),
  );
  const subline = settings.auto_sync_enabled
    ? `Checks for new files every ${fmtInterval(settings.auto_sync_interval_minutes)}`
    : "Automatic checks are off";
  const folder = folders.find((f) => f.id === folderId) ?? null;

  /* -------------------------------------------------------------------------
     RUN VIEW MODEL
     ---------------------------------------------------------------------- */

  const run = useMemo<RunView | null>(() => {
    if (view !== "copying" || !folderId) return null;
    const m = mappings.find((x) => x.id === folderId);
    if (!m) return null;
    // The placeholder is only for a start that is genuinely pending (liveProgress
    // has it); otherwise show what the mapping itself last recorded.
    const live = activeRun?.mappingId === folderId ? activeRun : liveProgress.get(folderId);
    const ar =
      live ?? { ...startingRun(folderId, m), status: m.last_status, error: m.last_error };
    const isRunning = ar.status === "running";
    const pct =
      ar.status === "succeeded"
        ? 100
        : ar.bytesTotal > 0
          ? Math.min(100, (ar.bytesDone / ar.bytesTotal) * 100)
          : 0;
    const noTotals = ar.bytesTotal <= 0 && ar.filesTotal <= 0;
    const stats = noTotals
      ? isRunning
        ? ar.runId === 0 && liveProgress.has(folderId) ? "Starting…" : "Copying…"
        : ""
      : [
          `${fmtBytes(ar.bytesDone)} of ${fmtBytes(ar.bytesTotal)}`,
          `${ar.filesDone} of ${ar.filesTotal} files`,
          isRunning && ar.speed > 0 ? `${fmtBytes(ar.speed)}/s` : "",
        ]
          .filter(Boolean)
          .join(" · ");

    return {
      name: m.source_name,
      status: ar.status,
      isRunning,
      starting: ar.runId === 0, // no run id yet: Stop can't target it
      pct: Math.round(pct),
      barWidth: pct.toFixed(2) + "%",
      timeLeft: isRunning ? fmtTimeLeft(ar.etaSec) : "",
      stats,
      log: ar.log.slice(-13),
      problem:
        ar.status === "failed" ? makeProblem(m, ar.error ?? m.last_error) : null,
      stop: () => {
        if (ar.runId === 0) return; // run id not known yet
        apiRef.current?.cancelSync(ar.runId).catch(console.error);
      },
      retry: () => startRun(folderId),
      back: goHome,
      openFolder: () => openFolder(folderId),
      openFolderError:
        openFolderError?.id === folderId ? openFolderError.message : "",
    };
  }, [view, folderId, mappings, activeRun, liveProgress, makeProblem, startRun, openFolder, openFolderError, goHome]);

  /* -------------------------------------------------------------------------
     Assemble UseTrawl
     ---------------------------------------------------------------------- */

  const autoIntervalMinutes = settings.auto_sync_enabled
    ? settings.auto_sync_interval_minutes
    : 0;

  const value: UseTrawl = {
    view,
    goHome,
    goSettings,
    connection,
    connect,
    update,
    checkForUpdate,
    installUpdate,
    libraryRoot,
    changeLibraryRoot,
    settings,
    autoIntervalMinutes,
    setAutoIntervalMinutes,
    setMinimizeToTray,
    isEmpty,
    headline,
    subline,
    folders,
    checkAll,
    pasteLink,
    pasteError,
    preview,
    folder,
    run,
  };

  return (
    <TrawlContext.Provider value={value}>{children}</TrawlContext.Provider>
  );
}

/* ---------------------------------------------------------------------------
   Hook
   --------------------------------------------------------------------------- */

export function useTrawl(): UseTrawl {
  const ctx = useContext(TrawlContext);
  if (!ctx) throw new Error("useTrawl must be used inside <TrawlProvider>");
  return ctx;
}
