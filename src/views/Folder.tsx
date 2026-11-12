import { useTrawl } from "../store";
import { fmtInterval } from "../format";
import Contents from "./Contents";

const sub = { fontSize: 13.5, color: "var(--quiet)" } as const;
const col = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 } as const;

export default function Folder() {
  const { folder: f, goHome, settings } = useTrawl();
  if (!f) return null;

  return (
    <main className="page" style={{ gap: 52 }}>
      <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <button type="button" className="lnk quiet" style={{ alignSelf: "flex-start", textDecoration: "none", fontSize: 14 }} onClick={goHome}>
          ← All folders
        </button>
        <h1 className="big" style={{ marginTop: 8 }}>{f.source_name}</h1>
        <p className="quiet" style={{ fontSize: 16 }}>{f.statusLine}</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", paddingTop: 12 }}>
          <button type="button" className="btn p" onClick={f.openFolder}>Open folder</button>
          <button type="button" className="btn" onClick={f.checkNow} disabled={f.running}>Check now</button>
        </div>
        {f.openFolderError && <p className="err" role="alert">{f.openFolderError}</p>}
        {f.problem && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
            <p className="err" style={{ fontWeight: 500 }}><span className="dot" /> {f.problem.title}</p>
            <p className="quiet" style={{ fontSize: 14 }}>{f.problem.body}</p>
            <button type="button" className="btn" onClick={f.problem.fix}>{f.problem.fixLabel}</button>
          </div>
        )}
        {f.running && (
          <button type="button" className="lnk" style={{ alignSelf: "flex-start", fontSize: 14 }} onClick={f.openRun}>Show progress</button>
        )}
      </section>

      <Contents key={f.id} f={f} />

      <section className="rows">
        <div className="row">
          <span style={col}>
            <span>On this computer</span>
            <span className="mono quiet" style={{ fontSize: 13, overflowWrap: "anywhere" }}>{f.destDisplay}</span>
          </span>
        </div>
        <div className="row">
          <span style={col}>
            <span>Comes from</span>
            <span style={sub}>{f.fromLabel}</span>
          </span>
        </div>
        <div className="row">
          <span style={col}>
            <span>What to copy</span>
            <span style={sub}>{f.whatLabel}</span>
          </span>
        </div>
        <label className="row" style={{ cursor: "pointer" }}>
          <span style={col}>
            <span>Keep it up to date</span>
            <span style={sub}>
              {f.auto_sync && settings.auto_sync_enabled
                ? `Every ${fmtInterval(settings.auto_sync_interval_minutes)}`
                : "Only when you check"}
            </span>
          </span>
          <input className="tog" type="checkbox" checked={f.auto_sync} onChange={f.toggleAuto} />
        </label>
        <label className="row" style={{ cursor: "pointer" }}>
          <span style={col}>
            <span>Keep my edits</span>
            <span style={sub}>Files you change here are never lost</span>
          </span>
          <input className="tog" type="checkbox" checked={f.protect_local_edits} onChange={f.toggleProtectLocalEdits} />
        </label>
      </section>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
        {f.running ? (
          <span style={sub}>Stop the copy first</span>
        ) : f.pendingStop ? (
          <>
            <p style={{ fontSize: 14 }}>Stop syncing this folder? The files already copied stay on your computer.</p>
            <div style={{ display: "flex", gap: 16, fontSize: 14 }}>
              <button type="button" className="lnk danger" onClick={f.confirmStop}>Yes, stop syncing</button>
              <button type="button" className="lnk" onClick={f.cancelStop}>Keep it</button>
            </div>
          </>
        ) : (
          <>
            <button type="button" className="lnk danger" style={{ fontSize: 14 }} onClick={f.askStop}>Stop syncing this folder</button>
            <span style={sub}>The files already copied stay on your computer.</span>
          </>
        )}
      </div>
    </main>
  );
}
