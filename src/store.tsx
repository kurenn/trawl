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
  STATUS,
  detectProvider,
  extractFolderId,
  fmtBytes,
  fmtDur,
  metaLine,
  parsePcloudLink,
  providerLabel,
  srcLabel,
  zeroPadRunId,
} from "./format";
import type {
  Api,
  ConnectionState,
  FolderNode,
  Mapping,
  MappingCard,
  MappingStatus,
  NewMapping,
  RunLogLine,
  RunProgress,
  RunView,
  Settings,
  SourceKind,
  SourceProvider,
  StagedPair,
  TreeRow,
  UpdateState,
  UseTrawl,
  View,
} from "./types";

/* ---------------------------------------------------------------------------
   Internal staged item — extends StagedPair with source capture fields
   --------------------------------------------------------------------------- */

interface InternalStagedItem {
  key: string;
  name: string;
  dest: string;
  /** Absolute destination folder captured when this pair was added. */
  destPath: string;
  sourceProvider: SourceProvider;
  sourceKind: SourceKind;
  sourceId: string | null;
  sourceHost: string | null;
  sourceSubpath: string;
  remove: () => void;
}

/* ---------------------------------------------------------------------------
   Context
   --------------------------------------------------------------------------- */

const TrawlContext = createContext<UseTrawl | null>(null);

/* ---------------------------------------------------------------------------
   Provider
   --------------------------------------------------------------------------- */

export function TrawlProvider({ children }: { children: React.ReactNode }) {
  // ---- API ref ----
  const apiRef = useRef<Api | null>(null);

  // ---- Shell / nav ----
  const [view, setView] = useState<View>("dashboard");
  const [connection, setConnection] = useState<ConnectionState>({
    phase: "checking",
    remote: "gdrive",
    error: null,
  });
  const [libraryRoot, setLibraryRoot] = useState<string>("");
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

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

  // ---- 1-second ticker for autoLabel countdown ----
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // ---- Run ----
  const [activeRun, setActiveRun] = useState<RunProgress | null>(null);
  // Live progress for EVERY in-flight run, keyed by mappingId, so the dashboard
  // cards can show a progress bar (not just a "Syncing" pill).
  const [liveProgress, setLiveProgress] = useState<Map<string, RunProgress>>(
    new Map(),
  );
  // mappingId of the run currently shown in the Run view (when opened). Run
  // events are correlated by mappingId; only one run per mapping is allowed.
  const activeMappingRef = useRef<string | null>(null);
  // Refs so the once-mounted onRunUpdate subscription reads current values.
  const mappingsRef = useRef<Mapping[]>([]);
  const liveProgressRef = useRef<Map<string, RunProgress>>(new Map());
  const libraryRootRef = useRef<string>("");
  // Monotonic token to discard stale source-listing responses (#race guard).
  const listSeqRef = useRef<number>(0);
  // Highest runId seen per mapping — discards stale events from an older run.
  const lastRunIdRef = useRef<Map<string, number>>(new Map());

  // ---- New mapping — source ----
  const [mode, setModeRaw] = useState<SourceKind>("folder_id");
  // Provider of the currently-listed source (auto-detected from the pasted link).
  const [sourceProvider, setSourceProvider] = useState<SourceProvider>("gdrive");
  // pCloud API host for the currently-listed source (null for gdrive).
  const [sourceHost, setSourceHost] = useState<string | null>(null);
  const [folderIdInput, setFolderIdInput] = useState<string>("");
  const [listedFolderId, setListedFolderId] = useState<string | null>(null);
  const [listing, setListing] = useState<boolean>(false);
  const [rootName, setRootName] = useState<string>("");
  const [sourceExpanded, setSourceExpanded] = useState<Set<string>>(
    new Set<string>(),
  );
  const [sourceLoading, setSourceLoading] = useState<Set<string>>(
    new Set<string>(),
  );
  // childrenCache: keyed by subpath ("" = root-level children)
  const [sourceCache, setSourceCache] = useState<Map<string, FolderNode[]>>(
    new Map<string, FolderNode[]>(),
  );
  const [selectedSource, setSelectedSource] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [finalName, setFinalName] = useState<string>("");
  const [sourceEmptyMsgOverride, setSourceEmptyMsgOverride] = useState<
    string | null
  >(null);

  // ---- New mapping — dest ----
  const [destSel, setDestSel] = useState<string>("");
  const [destExpanded, setDestExpanded] = useState<Set<string>>(
    new Set<string>(),
  );
  const [destLoading, setDestLoading] = useState<Set<string>>(
    new Set<string>(),
  );
  const [destCache, setDestCache] = useState<Map<string, FolderNode[]>>(
    new Map<string, FolderNode[]>(),
  );
  const [created, setCreated] = useState<string[]>([]);
  const [showNewFolder, setShowNewFolder] = useState<boolean>(false);
  const [newFolderInput, setNewFolderInput] = useState<string>("");

  // ---- Staged ----
  const [stagedItems, setStagedItems] = useState<InternalStagedItem[]>([]);
  const stagedKeyCounter = useRef<number>(0);

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
        const merged = freshMaps.map((fm) => {
          const cur = mappingsRef.current.find((m) => m.id === fm.id);
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
        });
        setMappings(merged);
        mappingsRef.current = merged;
        setSettingsState(freshSett);
      });

      // Subscribe to run updates.
      // - For EVERY event: update the matching mapping's transient status on the
      //   card (so background/auto syncs are reflected even without user action).
      // - Gated on activeMappingRef: only update the run-view snapshot and
      //   advance the queue when the event belongs to the actively displayed run.
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
                last_error:
                  progress.status === "failed"
                    ? progress.log
                        .filter((l: RunLogLine) => l.kind === "error")
                        .map((l: RunLogLine) => l.text)
                        .slice(-1)[0] ?? "Sync failed"
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

  const goDashboard = useCallback(() => {
    setView("dashboard");
  }, []);

  const goNewMapping = useCallback(() => {
    setView("newMapping");
  }, []);

  const goConnect = useCallback(() => {
    setView("connect");
  }, []);

  const connect = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    setConnection((prev) => ({ ...prev, phase: "connecting", error: null }));
    api
      .connectDrive()
      .then((conn) => {
        setConnection(conn);
        // On success, leave the Connect screen for the dashboard.
        if (conn.phase === "connected") setView("dashboard");
      })
      .catch((e: unknown) =>
        setConnection({
          phase: "error",
          remote: "gdrive",
          error: String(e),
        }),
      );
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
     DASHBOARD helpers
     ---------------------------------------------------------------------- */

  // Start a sync WITHOUT navigating — progress shows on the mapping's own card.
  // An optimistic running snapshot makes the card's bar appear instantly.
  const startRun = useCallback((mappingId: string) => {
    const api = apiRef.current;
    if (!api) return;
    setPendingDelete(null);

    setLiveProgress((prev) => {
      if (prev.has(mappingId)) return prev; // already running
      const m = mappingsRef.current.find((x) => x.id === mappingId);
      const next = new Map(prev);
      next.set(mappingId, {
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
      });
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
      // the true status from disk.
      setLiveProgress((prev) => {
        const lp = prev.get(mappingId);
        if (lp && lp.runId === 0) {
          const n = new Map(prev);
          n.delete(mappingId);
          return n;
        }
        return prev;
      });
      apiRef.current?.loadMappings().then((maps) => setMappings(maps)).catch(() => {});
    });
  }, []);

  // Open the Run view (live log) for a mapping that's currently syncing.
  const openRun = useCallback((mappingId: string) => {
    activeMappingRef.current = mappingId;
    setActiveRun(liveProgressRef.current.get(mappingId) ?? null);
    setView("run");
  }, []);

  const syncAll = useCallback(() => {
    // Start every enabled mapping; the backend semaphore caps concurrency, so no
    // frontend queue is needed and each card shows its own progress.
    mappings.filter((m) => m.enabled).forEach((m) => startRun(m.id));
  }, [mappings, startRun]);

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

  const toggleSkipShortcuts = useCallback(
    (id: string) => {
      const api = apiRef.current;
      if (!api) return;
      const current = mappingsRef.current.find((m) => m.id === id);
      if (!current) return;
      api
        .setMappingSkipShortcuts(id, !current.skip_shortcuts)
        .then((updated) => {
          setMappings(updated);
          mappingsRef.current = updated;
        })
        .catch(console.error);
    },
    [],
  );

  /* -------------------------------------------------------------------------
     NEW MAPPING — SOURCE MODE
     ---------------------------------------------------------------------- */

  const resetSourceTree = useCallback(() => {
    // Invalidate any in-flight listing so a slow response can't repopulate a
    // tree the user has since reset/changed.
    listSeqRef.current++;
    setSourceExpanded(new Set<string>());
    setSourceLoading(new Set<string>());
    setSourceCache(new Map<string, FolderNode[]>());
    setSelectedSource(null);
    setFinalName("");
    setListedFolderId(null);
    setRootName("");
    setSourceProvider("gdrive");
    setSourceHost(null);
    setSourceEmptyMsgOverride(null);
  }, []);

  const setMode = useCallback(
    (m: SourceKind) => {
      setModeRaw(m);
      resetSourceTree(); // bumps listSeqRef
      const seq = listSeqRef.current;

      // "Shared with me" is Drive-only and auto-lists on mode switch.
      if (m === "shared_with_me") {
        const api = apiRef.current;
        if (!api) return;
        setListing(true);
        api
          .listSourceFolders({
            provider: "gdrive",
            kind: "shared_with_me",
            sourceId: null,
            host: null,
            subpath: "",
          })
          .then((nodes) => {
            if (seq !== listSeqRef.current) return; // stale — discard
            setSourceCache(new Map<string, FolderNode[]>([["", nodes]]));
            setListing(false);
          })
          .catch(() => {
            if (seq !== listSeqRef.current) return;
            setListing(false);
          });
      }
    },
    [resetSourceTree],
  );

  const listSource = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    if (mode !== "folder_id") return;

    // Auto-detect the provider from the pasted link.
    const provider = detectProvider(folderIdInput);
    let id: string | null;
    let host: string | null = null;

    if (provider === "pcloud") {
      const parsed = parsePcloudLink(folderIdInput);
      if (!parsed) {
        setSourceEmptyMsgOverride("Paste a valid pCloud public folder link");
        return;
      }
      id = parsed.code;
      host = parsed.host;
    } else {
      id = extractFolderId(folderIdInput);
      if (!id) {
        setSourceEmptyMsgOverride("Paste a Drive or pCloud folder link, then List");
        return;
      }
      // Drive needs a connected rclone remote; pCloud links never do.
      if (connection.phase !== "connected") {
        setSourceEmptyMsgOverride(
          "Connect Google Drive (top-left status) to use Drive links",
        );
        return;
      }
    }

    const seq = ++listSeqRef.current; // new listing supersedes any in-flight one
    setSourceEmptyMsgOverride(null);
    setSourceProvider(provider);
    setSourceHost(host);
    setListedFolderId(id);
    setListing(true);
    setSourceCache(new Map<string, FolderNode[]>());
    setSourceExpanded(new Set<string>([""])); // root is expanded by default

    Promise.all([
      api.resolveSourceName(provider, "folder_id", id, host),
      api.listSourceFolders({
        provider,
        kind: "folder_id",
        sourceId: id,
        host,
        subpath: "",
      }),
    ])
      .then(([name, nodes]) => {
        if (seq !== listSeqRef.current) return; // stale — a newer List won
        setRootName(name);
        setSourceCache(new Map<string, FolderNode[]>([["", nodes]]));
        setListing(false);
      })
      .catch(() => {
        if (seq !== listSeqRef.current) return;
        setListing(false);
      });
  }, [mode, folderIdInput, connection.phase]);

  /* -------------------------------------------------------------------------
     SOURCE TREE — toggle + lazy load
     ---------------------------------------------------------------------- */

  const toggleSourceExpand = useCallback(
    (path: string) => {
      const api = apiRef.current;
      const isExpanded = sourceExpanded.has(path);

      if (isExpanded) {
        setSourceExpanded((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        return;
      }

      setSourceExpanded((prev) => new Set([...prev, path]));

      // Lazy-load if not cached
      if (!sourceCache.has(path) && api) {
        const seq = listSeqRef.current; // tie this fetch to the current tree
        setSourceLoading((prev) => new Set([...prev, path]));
        api
          .listSourceFolders({
            provider: sourceProvider,
            kind: mode,
            sourceId: mode === "folder_id" ? listedFolderId : null,
            host: sourceHost,
            subpath: path,
          })
          .then((nodes) => {
            if (seq !== listSeqRef.current) return; // tree was reset — discard
            setSourceCache((prev) => {
              const next = new Map(prev);
              next.set(path, nodes);
              return next;
            });
            setSourceLoading((prev) => {
              const next = new Set(prev);
              next.delete(path);
              return next;
            });
          })
          .catch(() => {
            if (seq !== listSeqRef.current) return;
            setSourceLoading((prev) => {
              const next = new Set(prev);
              next.delete(path);
              return next;
            });
          });
      }
    },
    [sourceExpanded, sourceCache, mode, listedFolderId, sourceProvider, sourceHost],
  );

  /* -------------------------------------------------------------------------
     SOURCE TREE — flat row builder
     ---------------------------------------------------------------------- */

  const sourceRows = useMemo<TreeRow[]>(() => {
    const rows: TreeRow[] = [];

    // For folder_id: add the synthetic ROOT ROW at top (path="", name=rootName)
    if (mode === "folder_id") {
      if (!listedFolderId) return rows; // nothing listed yet

      // rclone usually can't resolve a linked folder's own name, so show a
      // friendly label for the pasted root rather than a blank/"…".
      const rootLabel = rootName || "Drive folder (linked)";
      const isRootSelected = selectedSource?.path === "";
      const isRootExpanded = sourceExpanded.has("");
      const rootChildren = sourceCache.get("") ?? null;
      const rootHasChildren = rootChildren === null || rootChildren.length > 0;

      rows.push({
        key: "__root__",
        kind: "row",
        pad: 8,
        name: rootLabel,
        hasChildren: rootHasChildren,
        expanded: isRootExpanded,
        selected: !!isRootSelected,
        onToggle: () => toggleSourceExpand(""),
        onSelect: () => {
          // Empty name on the root signals "use a fallback label" at addPair.
          setSelectedSource({ path: "", name: rootName });
          setFinalName(rootName);
        },
      });

      if (isRootExpanded) {
        if (sourceLoading.has("")) {
          rows.push({
            key: "__root__loading",
            kind: "loading",
            pad: 30,
            name: "",
            hasChildren: false,
            expanded: false,
            selected: false,
            onToggle: () => {},
            onSelect: () => {},
          });
        } else if (rootChildren !== null) {
          walkSourceNodes(rootChildren, 1, rows);
        }
      }
    } else {
      // shared_with_me: root nodes are the top-level shared folders
      if (listing) {
        rows.push({
          key: "__shared_loading",
          kind: "loading",
          pad: 8,
          name: "",
          hasChildren: false,
          expanded: false,
          selected: false,
          onToggle: () => {},
          onSelect: () => {},
        });
        return rows;
      }
      const roots = sourceCache.get("") ?? [];
      walkSourceNodes(roots, 0, rows);
    }

    return rows;

    function walkSourceNodes(
      nodes: FolderNode[],
      depth: number,
      out: TreeRow[],
    ) {
      for (const node of nodes) {
        const isExpanded = sourceExpanded.has(node.path);
        const isLoading = sourceLoading.has(node.path);
        const isSelected =
          selectedSource?.path === node.path &&
          selectedSource?.name === node.name;
        const cachedChildren = sourceCache.get(node.path) ?? null;
        const hasChildren =
          node.hasChildren ||
          (cachedChildren !== null && cachedChildren.length > 0);

        out.push({
          key: node.path,
          kind: "row",
          pad: depth * 20 + 8,
          name: node.name,
          hasChildren,
          expanded: isExpanded,
          selected: isSelected,
          onToggle: () => toggleSourceExpand(node.path),
          onSelect: () => {
            setSelectedSource({ path: node.path, name: node.name });
            setFinalName(node.name);
          },
        });

        if (isExpanded) {
          if (isLoading) {
            out.push({
              key: node.path + "__loading",
              kind: "loading",
              pad: depth * 20 + 30,
              name: "",
              hasChildren: false,
              expanded: false,
              selected: false,
              onToggle: () => {},
              onSelect: () => {},
            });
          } else if (cachedChildren !== null) {
            if (cachedChildren.length > 0) {
              walkSourceNodes(cachedChildren, depth + 1, out);
            } else {
              out.push({
                key: node.path + "__empty",
                kind: "empty",
                pad: depth * 20 + 30,
                name: "",
                hasChildren: false,
                expanded: false,
                selected: false,
                onToggle: () => {},
                onSelect: () => {},
              });
            }
          }
        }
      }
    }
  }, [
    mode,
    listedFolderId,
    rootName,
    sourceExpanded,
    sourceLoading,
    sourceCache,
    selectedSource,
    listing,
    toggleSourceExpand,
  ]);

  const hasSourceRows = sourceRows.length > 0;

  const sourceFsLabel = useMemo<string>(() => {
    if (sourceProvider === "pcloud") {
      return `pcloud:${listedFolderId ?? "…"}`;
    }
    if (mode === "folder_id") {
      return `root_folder_id=${listedFolderId ?? "…"}`;
    }
    return "gdrive,shared_with_me:";
  }, [sourceProvider, mode, listedFolderId]);

  const sourceEmptyMsg = useMemo<string>(() => {
    if (sourceEmptyMsgOverride) return sourceEmptyMsgOverride;
    if (mode === "folder_id") {
      if (!listedFolderId) return "Paste a Drive folder URL or ID, then List";
      if (sourceRows.length === 0) return "No subfolders found";
      return "";
    }
    // shared_with_me
    if (listing) return "Loading…";
    if (sourceRows.length === 0) return "No shared folders found";
    return "";
  }, [
    mode,
    listedFolderId,
    listing,
    sourceRows.length,
    sourceEmptyMsgOverride,
  ]);

  /* -------------------------------------------------------------------------
     DEST TREE — toggle + lazy load
     ---------------------------------------------------------------------- */

  // Children of a dest node = API children + locally-created children for that subpath
  const destChildrenForPath = useCallback(
    (subpath: string): FolderNode[] | null => {
      const cached = destCache.get(subpath);
      if (cached === undefined) return null; // not yet loaded

      // Merge with locally created folders at this level
      const localCreated = created
        .filter((p) => {
          const lastSlash = p.lastIndexOf("/");
          const parentPath = lastSlash < 0 ? "" : p.slice(0, lastSlash);
          return parentPath === subpath;
        })
        .map((p) => ({
          path: p,
          name: p.slice(p.lastIndexOf("/") + 1),
          hasChildren: false,
        }));

      const merged = [...cached];
      for (const lc of localCreated) {
        if (!merged.find((n) => n.path === lc.path)) {
          merged.push(lc);
        }
      }
      merged.sort((a, b) => a.name.localeCompare(b.name));
      return merged;
    },
    [destCache, created],
  );

  const toggleDestExpand = useCallback(
    (subpath: string) => {
      const api = apiRef.current;
      const isExpanded = destExpanded.has(subpath);

      if (isExpanded) {
        setDestExpanded((prev) => {
          const next = new Set(prev);
          next.delete(subpath);
          return next;
        });
        return;
      }

      setDestExpanded((prev) => new Set([...prev, subpath]));

      if (!destCache.has(subpath) && api) {
        setDestLoading((prev) => new Set([...prev, subpath]));
        api
          .listLocalFolders(subpath)
          .then((nodes) => {
            setDestCache((prev) => {
              const next = new Map(prev);
              next.set(subpath, nodes);
              return next;
            });
            setDestLoading((prev) => {
              const next = new Set(prev);
              next.delete(subpath);
              return next;
            });
          })
          .catch(() => {
            setDestLoading((prev) => {
              const next = new Set(prev);
              next.delete(subpath);
              return next;
            });
          });
      }
    },
    [destExpanded, destCache],
  );

  /* -------------------------------------------------------------------------
     DEST TREE — flat row builder
     ---------------------------------------------------------------------- */

  // Load root children on first render of newMapping view
  useEffect(() => {
    if (view !== "newMapping") return;
    const api = apiRef.current;
    if (!api || destCache.has("")) return;
    api
      .listLocalFolders("")
      .then((nodes) => {
        setDestCache((prev) => {
          const next = new Map(prev);
          next.set("", nodes);
          return next;
        });
      })
      .catch(console.error);
  }, [view, destCache]);

  const destRows = useMemo<TreeRow[]>(() => {
    const rows: TreeRow[] = [];
    const rootChildren = destChildrenForPath("");
    if (rootChildren === null) return rows; // not yet loaded

    walkDestNodes(rootChildren, 0, rows);
    return rows;

    function walkDestNodes(
      nodes: FolderNode[],
      depth: number,
      out: TreeRow[],
    ) {
      for (const node of nodes) {
        const isExpanded = destExpanded.has(node.path);
        const isLoading = destLoading.has(node.path);
        const isSelected = destSel === node.path;
        const cachedChildren = destChildrenForPath(node.path);
        const hasChildren =
          node.hasChildren ||
          (cachedChildren !== null && cachedChildren.length > 0);

        out.push({
          key: node.path,
          kind: "row",
          pad: depth * 18 + 8,
          name: node.name,
          hasChildren,
          expanded: isExpanded,
          selected: isSelected,
          onToggle: () => toggleDestExpand(node.path),
          onSelect: () => setDestSel(node.path),
        });

        if (isExpanded) {
          if (isLoading) {
            out.push({
              key: node.path + "__loading",
              kind: "loading",
              pad: depth * 18 + 30,
              name: "",
              hasChildren: false,
              expanded: false,
              selected: false,
              onToggle: () => {},
              onSelect: () => {},
            });
          } else if (cachedChildren !== null) {
            if (cachedChildren.length > 0) {
              walkDestNodes(cachedChildren, depth + 1, out);
            } else {
              out.push({
                key: node.path + "__empty",
                kind: "empty",
                pad: depth * 18 + 30,
                name: "",
                hasChildren: false,
                expanded: false,
                selected: false,
                onToggle: () => {},
                onSelect: () => {},
              });
            }
          }
        }
      }
    }
  }, [destExpanded, destLoading, destSel, destChildrenForPath, toggleDestExpand]);

  const destEmpty = useMemo<boolean>(() => {
    const rootChildren = destChildrenForPath("");
    if (rootChildren === null) return false;
    return rootChildren.length === 0;
  }, [destChildrenForPath]);

  const rootSelected = destSel === "";
  const selectRoot = useCallback(() => setDestSel(""), []);

  // Native folder picker → re-root the whole destination tree wherever the
  // user chooses. The backend persists the choice; clearing destCache makes
  // the root-listing effect re-list from the new root.
  const changeLibraryRoot = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    api
      .pickLibraryRoot()
      .then((path) => {
        if (!path) return; // user cancelled
        setLibraryRoot(path);
        libraryRootRef.current = path;
        // Reset the destination browser to the new root.
        setDestSel("");
        setShowNewFolder(false);
        setNewFolderInput("");
        setCreated([]);
        setDestExpanded(new Set<string>());
        setDestLoading(new Set<string>());
        setDestCache(new Map<string, FolderNode[]>());
      })
      .catch(console.error);
  }, []);

  const toggleNewFolder = useCallback(() => {
    setShowNewFolder((prev) => !prev);
    setNewFolderInput("");
  }, []);

  const createFolder = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const name = newFolderInput.trim().replace(/^\/+|\/+$/g, "");
    if (!name) return;
    const path = destSel ? destSel + "/" + name : name;
    api
      .createLocalFolder(path)
      .then((result) => {
        if (result.ok) {
          setCreated((prev) => [...prev, path]);
          setDestSel(path);
          // Expand parent so newly created folder is visible
          if (destSel) {
            setDestExpanded((prev) => new Set([...prev, destSel]));
            // Refresh parent's cache
            setDestCache((prev) => {
              const next = new Map(prev);
              next.delete(destSel); // will re-fetch on next expand
              return next;
            });
          } else {
            // Root — invalidate root cache
            setDestCache((prev) => {
              const next = new Map(prev);
              next.delete("");
              return next;
            });
          }
          setShowNewFolder(false);
          setNewFolderInput("");
        }
      })
      .catch(console.error);
  }, [destSel, newFolderInput]);

  /* -------------------------------------------------------------------------
     COMPOSER
     ---------------------------------------------------------------------- */

  const hasSource = !!selectedSource;
  const sourceName = selectedSource?.name ?? "";

  // The full destination folder the Drive contents merge into (no leaf folder).
  const destPrefixLabel = useMemo<string>(() => {
    return destSel ? `${libraryRoot}/${destSel}` : libraryRoot;
  }, [libraryRoot, destSel]);

  // The CURRENT absolute destination folder (library root + selected subfolder).
  const fullDest = useMemo<string>(
    () => (destSel ? `${libraryRoot}/${destSel}` : libraryRoot),
    [libraryRoot, destSel],
  );

  const exists = useMemo<boolean>(() => {
    // Compare ABSOLUTE destinations so the "Already a target" hint is accurate
    // across mappings with different library roots.
    const knownDests = new Set<string>([
      ...mappings.map((m) =>
        m.dest_path
          ? m.dest_path
          : m.dest_subpath
            ? `${libraryRoot}/${m.dest_subpath}`
            : libraryRoot,
      ),
      ...stagedItems.map((s) => s.destPath),
    ]);
    return !!fullDest && knownDests.has(fullDest);
  }, [mappings, stagedItems, fullDest, libraryRoot]);

  const addPair = useCallback(() => {
    if (!selectedSource) return;
    // The source folder's contents sync DIRECTLY into the selected destination
    // folder. Capture the ABSOLUTE destination NOW so that later changing the
    // library root (or another mapping's destination) can never move this one.
    const dest = destSel;
    const destPath = destSel ? `${libraryRoot}/${destSel}` : libraryRoot;
    // The name is just the card label. Prefer the typed name, then the selected
    // source folder's name, then the destination folder's name, then a generic.
    const destLeaf = destSel ? destSel.split("/").pop() || "" : "";
    const label =
      finalName.trim() ||
      selectedSource.name.trim() ||
      destLeaf ||
      (sourceProvider === "pcloud" ? "pCloud folder" : "Drive folder");
    const key = String(stagedKeyCounter.current++);
    const capturedPath = selectedSource.path;
    const capturedKind = mode;
    const capturedId = mode === "folder_id" ? listedFolderId : null;

    setStagedItems((prev) => [
      ...prev,
      {
        key,
        name: label,
        dest,
        destPath,
        sourceProvider,
        sourceKind: capturedKind,
        sourceId: capturedId,
        sourceHost,
        sourceSubpath: capturedPath,
        remove: () =>
          setStagedItems((p) => p.filter((item) => item.key !== key)),
      },
    ]);
    setSelectedSource(null);
    setFinalName("");
  }, [
    selectedSource,
    finalName,
    destSel,
    libraryRoot,
    mode,
    listedFolderId,
    sourceProvider,
    sourceHost,
  ]);

  /* -------------------------------------------------------------------------
     STAGED
     ---------------------------------------------------------------------- */

  const staged = useMemo<StagedPair[]>(() =>
    stagedItems.map((item) => ({
      key: item.key,
      name: item.name,
      dest: item.dest,
      destPath: item.destPath,
      remove: item.remove,
    })),
    [stagedItems],
  );

  const saveStaged = useCallback(() => {
    const api = apiRef.current;
    if (!api || stagedItems.length === 0) return;
    const remote = connection.remote || "gdrive";
    const newMappings: NewMapping[] = stagedItems.map((item) => ({
      source_provider: item.sourceProvider,
      source_kind: item.sourceKind,
      source_id: item.sourceId,
      source_host: item.sourceHost,
      source_subpath: item.sourceSubpath,
      source_name: item.name,
      src_label:
        item.sourceProvider === "pcloud"
          ? `pcloud:${item.sourceId ?? "…"}`
          : srcLabel(item.sourceKind, remote, item.sourceId),
      dest_subpath: item.dest,
      dest_path: item.destPath,
      acknowledge_abuse: true,
      skip_shortcuts: false,
    }));
    api
      .saveMappings(newMappings)
      .then((saved) => {
        setMappings(saved);
        setStagedItems([]);
        setView("dashboard");
      })
      .catch(console.error);
  }, [stagedItems, connection.remote]);

  const clearStaged = useCallback(() => setStagedItems([]), []);

  /* -------------------------------------------------------------------------
     DASHBOARD — cards
     ---------------------------------------------------------------------- */

  const cards = useMemo<MappingCard[]>(() => {
    const now = Date.now();
    const intervalMin = settings.auto_sync_interval_minutes;

    function fmtInterval(minutes: number): string {
      if (minutes < 60) return `${minutes} min`;
      if (minutes % 60 === 0) {
        const h = minutes / 60;
        return h === 1 ? "1 hr" : `${h} hr`;
      }
      const h = Math.round(minutes / 60);
      return `${h} hr`;
    }

    function fmtCountdown(msLeft: number): string {
      if (msLeft <= 0) return "soon";
      const totalSec = Math.ceil(msLeft / 1000);
      const totalMin = Math.ceil(totalSec / 60);
      const totalHr = Math.round(totalMin / 60);
      if (totalMin < 1) return "soon";
      if (totalMin < 60) return `~${totalMin}m`;
      return `~${totalHr}h`;
    }

    // Relative "time since" label for a past event (e.g. when a run failed),
    // so a persisted error reads as history, not a live/ongoing failure.
    function fmtAgo(iso: string | null): string {
      if (!iso) return "";
      const then = new Date(iso).getTime();
      if (Number.isNaN(then)) return "";
      const sec = Math.max(0, Math.round((now - then) / 1000));
      if (sec < 60) return "just now";
      const min = Math.round(sec / 60);
      if (min < 60) return `${min}m ago`;
      const hr = Math.round(min / 60);
      if (hr < 24) return `${hr}h ago`;
      const days = Math.round(hr / 24);
      return `${days}d ago`;
    }

    function buildAutoLabel(m: Mapping): string {
      if (!m.auto_sync) return "Manual";
      if (!settings.auto_sync_enabled) return "Auto · paused";
      const intervalLabel = fmtInterval(intervalMin);
      if (!m.last_at) {
        return `Auto · every ${intervalLabel} · next: soon`;
      }
      const lastMs = new Date(m.last_at).getTime();
      const nextMs = lastMs + intervalMin * 60 * 1000;
      const countdown = fmtCountdown(nextMs - now);
      return `Auto · every ${intervalLabel} · next ${countdown}`;
    }

    return mappings.map((m) => {
      const statusMeta = STATUS[m.last_status] ?? STATUS.idle;

      // Live progress (from the active run, if any) for the card's progress bar.
      const lp = liveProgress.get(m.id);
      const running = !!lp && lp.status === "running";
      const ratio =
        lp && lp.bytesTotal > 0
          ? Math.min(1, Math.max(0, lp.bytesDone / lp.bytesTotal))
          : 0;
      const pct = Math.round(ratio * 100);
      const progressLabel = !lp
        ? ""
        : lp.bytesTotal <= 0 && lp.filesTotal <= 0
          ? "Starting…"
          : `${pct}% · ${fmtBytes(lp.bytesDone)} / ${fmtBytes(lp.bytesTotal)} · ${lp.filesDone}/${lp.filesTotal} files${
              lp.speed > 0 ? ` · ${fmtBytes(lp.speed)}/s` : ""
            }${lp.etaSec > 0 ? ` · ETA ${fmtDur(lp.etaSec)}` : ""}`;

      return {
        ...m,
        statusMeta,
        metaLine: metaLine(m),
        providerLabel: providerLabel(m.source_provider),
        srcLabel: m.src_label,
        destDisplay: m.dest_path
          ? m.dest_path
          : m.dest_subpath
            ? `${libraryRoot}/${m.dest_subpath}`
            : libraryRoot,
        syncLabel: m.last_status === "failed" ? "Retry" : "Sync now",
        failedAgo: m.last_status === "failed" ? fmtAgo(m.last_at) : "",
        pendingDelete: pendingDelete === m.id,
        autoLabel: buildAutoLabel(m),
        running,
        pct,
        barWidth: `${(ratio * 100).toFixed(1)}%`,
        progressLabel,
        toggleAuto: () => toggleAuto(m.id),
        toggleSkipShortcuts: () => toggleSkipShortcuts(m.id),
        syncNow: () => startRun(m.id),
        cancelNow: () => apiRef.current?.cancelSync(lp?.runId ?? -1).catch(console.error),
        openRun: () => openRun(m.id),
        askDelete: () => setPendingDelete(m.id),
        confirmDelete: () => {
          const api = apiRef.current;
          api?.deleteMapping(m.id).catch(console.error);
          setMappings((prev) => prev.filter((x) => x.id !== m.id));
          setPendingDelete(null);
        },
        cancelDelete: () => setPendingDelete(null),
      };
    });
  }, [
    mappings,
    libraryRoot,
    pendingDelete,
    startRun,
    openRun,
    settings,
    toggleAuto,
    toggleSkipShortcuts,
    liveProgress,
  ]);

  const isEmpty = mappings.length === 0;
  const mappingCount = mappings.length;

  /* -------------------------------------------------------------------------
     RUN VIEW MODEL
     ---------------------------------------------------------------------- */

  const run = useMemo<RunView | null>(() => {
    if (!activeRun) return null;
    const ar = activeRun;
    const statusMeta = STATUS[ar.status] ?? STATUS.running;
    const pct =
      ar.bytesTotal > 0
        ? Math.min(100, (ar.bytesDone / ar.bytesTotal) * 100)
        : 0;
    const isRunning = ar.status === "running";

    const barColor =
      ar.status === "running"
        ? "#f59e0b"
        : ar.status === "succeeded"
          ? "#2dd4bf"
          : ar.status === "failed"
            ? "#f43f5e"
            : "#9499a3";

    return {
      runId: zeroPadRunId(ar.runId),
      name: ar.name,
      src: ar.src,
      dest: ar.dest,
      status: ar.status,
      statusMeta,
      isRunning,
      isDone: !isRunning,
      pct: Math.round(pct),
      barWidth: pct.toFixed(2) + "%",
      barColor,
      shineOpacity: isRunning ? "1" : "0",
      transferred: fmtBytes(ar.bytesDone),
      total: fmtBytes(ar.bytesTotal),
      files: ar.filesDone,
      filesTotal: ar.filesTotal,
      speed: isRunning ? fmtBytes(ar.speed) + "/s" : "—",
      eta: isRunning ? fmtDur(ar.etaSec) : "—",
      log: ar.log.slice(-13),
      hasQueue: false,
      queueRemaining: 0,
      cancel: () => {
        apiRef.current?.cancelSync(ar.runId).catch(console.error);
      },
      retry: () => startRun(ar.mappingId),
      back: () => {
        activeMappingRef.current = null;
        setActiveRun(null);
        setView("dashboard");
      },
    };
  }, [activeRun, startRun]);

  /* -------------------------------------------------------------------------
     Assemble UseTrawl
     ---------------------------------------------------------------------- */

  const autoIntervalMinutes = settings.auto_sync_enabled
    ? settings.auto_sync_interval_minutes
    : 0;

  const value = useMemo<UseTrawl>(
    () => ({
      // shell / nav
      view,
      goDashboard,
      goNewMapping,
      goConnect,
      connection,
      connect,
      update,
      checkForUpdate,
      installUpdate,
      libraryRoot,
      changeLibraryRoot,
      mappingCount,

      // auto-sync (global)
      settings,
      autoIntervalMinutes,
      setAutoIntervalMinutes,

      // dashboard
      isEmpty,
      cards,
      syncAll,

      // new mapping — source mode
      mode,
      setMode,
      folderIdInput,
      setFolderIdInput,
      listSource,
      listing,
      sourceFsLabel,
      sourceEmptyMsg,

      // new mapping — source tree
      sourceRows,
      hasSourceRows,

      // new mapping — dest tree
      rootSelected,
      selectRoot,
      destRows,
      destEmpty,
      showNewFolder,
      toggleNewFolder,
      newFolderInput,
      setNewFolderInput,
      createFolder,

      // new mapping — composer
      hasSource,
      sourceName,
      finalName,
      setFinalName,
      destPrefixLabel,
      addPair,
      exists,

      // new mapping — staged
      staged,
      saveStaged,
      clearStaged,

      // run
      run,
    }),
    [
      view,
      goDashboard,
      goNewMapping,
      goConnect,
      connection,
      connect,
      update,
      checkForUpdate,
      installUpdate,
      libraryRoot,
      changeLibraryRoot,
      mappingCount,
      settings,
      autoIntervalMinutes,
      setAutoIntervalMinutes,
      isEmpty,
      cards,
      syncAll,
      mode,
      setMode,
      folderIdInput,
      listSource,
      listing,
      sourceFsLabel,
      sourceEmptyMsg,
      sourceRows,
      hasSourceRows,
      rootSelected,
      selectRoot,
      destRows,
      destEmpty,
      showNewFolder,
      toggleNewFolder,
      newFolderInput,
      createFolder,
      hasSource,
      sourceName,
      finalName,
      addPair,
      exists,
      staged,
      saveStaged,
      clearStaged,
      run,
      destPrefixLabel,
    ],
  );

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
