import { useEffect, useState, type ReactNode } from "react";
import { useTrawl } from "../store";
import { fmtBytes, fmtInterval, tildify } from "../format";
import type { StorageUsage } from "../types";
import { version } from "../../package.json";

const STANDARD = [15, 60, 360, 1440];

function intervalLabel(m: number): string {
  return m === 1440 ? "1 day" : fmtInterval(m).replace("hr", "h");
}

const col = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 } as const;
const sub = { fontSize: 13.5, color: "var(--quiet)" } as const;

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h2 className="lbl">{title}</h2>
      <div className="rows">{children}</div>
    </section>
  );
}

/** Space used by Trawl's folders against the library disk. */
function SpaceUsed({ load }: { load: () => Promise<StorageUsage> }) {
  const [u, setU] = useState<StorageUsage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    load()
      .then((x) => live && setU(x))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [load]);

  const pct = (n: number) => `${u && u.diskTotal ? Math.min(100, Math.max(0, (n / u.diskTotal) * 100)) : 0}%`;
  return (
    <div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <span>Space used</span>
        <span style={{ ...sub, fontVariantNumeric: "tabular-nums" }}>
          {error ? "" : u ? `${fmtBytes(u.foldersBytes)} in your folders · ${fmtBytes(u.diskFree)} free` : "Adding up…"}
        </span>
      </div>
      {error ? (
        <span style={sub}>{error}</span>
      ) : (
        <div className="bar" style={{ display: "flex" }} aria-hidden="true">
          <span style={{ width: pct(u?.foldersBytes ?? 0), background: "var(--text)" }} />
          <span style={{ width: pct(u ? u.diskTotal - u.diskFree - u.foldersBytes : 0), background: "var(--toggle-off)" }} />
        </div>
      )}
    </div>
  );
}

/** "Open Trawl when I log in" — lives in the OS, not in Trawl's settings file. */
function OpenAtLogin({ get, set }: { get: () => Promise<boolean>; set: (on: boolean) => Promise<void> }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    get().then(setOn).catch(() => setOn(false));
  }, [get]);
  const toggle = (next: boolean) => {
    setError("");
    setOn(next);
    set(next).catch((e: unknown) => {
      setOn(!next);
      setError(e instanceof Error ? e.message : String(e));
    });
  };
  return (
    <label className="row" style={{ cursor: "pointer" }}>
      <span style={col}>
        <span>Open Trawl when I log in</span>
        {error && <span className="err">{error}</span>}
      </span>
      <input type="checkbox" className="tog" checked={!!on} disabled={on === null} onChange={(e) => toggle(e.target.checked)} />
    </label>
  );
}

export default function Settings() {
  const t = useTrawl();
  const { settings, autoIntervalMinutes, libraryRoot, connection, update } = t;
  const options = STANDARD.includes(autoIntervalMinutes) || autoIntervalMinutes === 0
    ? STANDARD
    : [...STANDARD, autoIntervalMinutes].sort((a, b) => a - b);
  const signedIn = connection.phase === "connected";

  return (
    <main className="page">
      <h1 className="big">Settings</h1>
      <Group title="Updates">
        <div className="row">
          <label htmlFor="auto-interval" style={col}>
            <span>Check for new files</span>
            <span style={sub}>For every folder that isn't paused</span>
          </label>
          <select
            id="auto-interval"
            className="btn"
            value={autoIntervalMinutes}
            onChange={(e) => t.setAutoIntervalMinutes(Number(e.target.value))}
          >
            {options.map((m) => (
              <option key={m} value={m}>{intervalLabel(m)}</option>
            ))}
            <option value={0}>Only when I ask</option>
          </select>
        </div>
      </Group>

      <Group title="Storage">
        <div className="row">
          <span style={col}>
            <span>New folders go in</span>
            <span className="quiet mono" style={{ fontSize: 13 }}>{tildify(libraryRoot)}</span>
          </span>
          <button type="button" className="lnk" onClick={t.changeLibraryRoot}>Change</button>
        </div>
        <SpaceUsed key={libraryRoot} load={t.storageUsage} />
      </Group>

      <Group title="Accounts">
        <div className="row">
          <span style={col}>
            <span>Google Drive</span>
            <span style={sub}>{signedIn ? "Signed in" : "Not signed in"}</span>
          </span>
          {!signedIn && (
            <button type="button" className="lnk" onClick={t.connect}>Sign in</button>
          )}
        </div>
        <div className="row">
          <span style={col}>
            <span>pCloud</span>
            <span style={sub}>Public links work without an account</span>
          </span>
        </div>
      </Group>

      <Group title="App">
        <OpenAtLogin get={t.getOpenAtLogin} set={t.setOpenAtLogin} />
        <label className="row" style={{ cursor: "pointer" }}>
          <span style={col}>
            <span>Keep running in the menu bar</span>
            <span style={sub}>Folders keep updating with the window closed</span>
          </span>
          <input
            type="checkbox"
            className="tog"
            checked={settings.minimize_to_tray}
            onChange={(e) => t.setMinimizeToTray(e.target.checked)}
          />
        </label>
      </Group>

      <p className="lbl" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span>Trawl {version}</span>
        {update.phase === "checking" && <span>Checking…</span>}
        {update.phase === "current" && <span>Up to date</span>}
        {update.phase === "available" && (
          <>
            <span>Update to v{update.version} ·</span>
            <button type="button" className="lnk" onClick={t.installUpdate}>Install</button>
          </>
        )}
        {update.phase === "downloading" && <span>Installing…</span>}
        {update.phase === "error" && (
          <>
            <span className="err">{update.error ?? "Couldn't check for updates"}</span>
            <button type="button" className="lnk" onClick={t.checkForUpdate}>Check again</button>
          </>
        )}
        {update.phase === "idle" && (
          <button type="button" className="lnk" onClick={t.checkForUpdate}>Check for updates</button>
        )}
      </p>
    </main>
  );
}
