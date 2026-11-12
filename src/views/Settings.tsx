import { useTrawl } from "../store";
import { fmtInterval, tildify } from "../format";
import { version } from "../../package.json";

const STANDARD = [15, 60, 360, 1440];

function intervalLabel(m: number): string {
  return m === 1440 ? "1 day" : fmtInterval(m).replace("hr", "h");
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
      <div className="rows">
        <div className="row">
          <label htmlFor="auto-interval" style={{ flex: 1 }}>Check for new files</label>
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
        <label className="row">
          <span style={{ flex: 1 }}>Keep running in the menu bar</span>
          <input
            type="checkbox"
            className="tog"
            checked={settings.minimize_to_tray}
            onChange={(e) => t.setMinimizeToTray(e.target.checked)}
          />
        </label>
        <div className="row">
          <div style={{ flex: 1 }}>
            <div>New folders go in</div>
            <div className="quiet mono">{tildify(libraryRoot)}</div>
          </div>
          <button type="button" className="lnk" onClick={t.changeLibraryRoot}>Change</button>
        </div>
        <div className="row">
          <div style={{ flex: 1 }}>
            <div>Google Drive</div>
            <div className="quiet">{signedIn ? "Signed in" : "Not signed in"}</div>
          </div>
          {!signedIn && (
            <button type="button" className="lnk" onClick={t.connect}>Sign in</button>
          )}
        </div>
        <div className="row">
          <div style={{ flex: 1 }}>
            <div>pCloud</div>
            <div className="quiet">Public links work without an account</div>
          </div>
        </div>
      </div>
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
