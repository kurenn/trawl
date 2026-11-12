import { useRef, useState } from "react";
import { useTrawl } from "../store";

const col = { display: "flex", flexDirection: "column" } as const;
const wrap = { display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" } as const;
const sub = { fontSize: 13.5 } as const;

export default function Preview() {
  const { preview: pv, connection, connect } = useTrawl();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const done = useRef(false); // Enter/Esc already settled; ignore the blur that follows
  if (!pv) return null;

  const edit = () => {
    done.current = false;
    setDraft(pv.name);
    setEditing(true);
  };
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    if (save) pv.setName(draft);
    setEditing(false);
  };

  if (pv.phase === "signin") {
    const busy = connection.phase === "connecting";
    return (
      <main className="page" style={{ gap: 40 }}>
        <div className="row" style={{ background: "var(--field)", borderRadius: "var(--r)", border: 0, height: 60, padding: "0 20px" }}>
          <span className="mono quiet" style={{ flex: 1, minWidth: 0, fontSize: 13.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {pv.link}
          </span>
          <button type="button" className="lnk quiet" onClick={pv.cancel}>Clear</button>
        </div>
        <div style={{ ...col, gap: 14 }}>
          <h1 style={{ fontSize: 30, lineHeight: 1.2, fontWeight: 600, letterSpacing: "-0.03em" }}>This folder is on Google Drive</h1>
          <p className="quiet" style={{ fontSize: 16, lineHeight: 1.6 }}>
            Google asks you to approve Trawl once. After that, every Drive link you paste just works.
          </p>
        </div>
        <div className="rows">
          <div className="row">Trawl can see folders shared with you</div>
          <div className="row">It never changes or deletes anything in your Drive</div>
          <div className="row">Your sign-in stays on this computer</div>
        </div>
        {connection.error && <p className="err" role="alert">{connection.error}</p>}
        <div style={wrap}>
          <button type="button" className="btn p" disabled={busy} onClick={connect}>
            {busy ? "Waiting for Google…" : "Continue with Google"}
          </button>
          <button type="button" className="btn" onClick={pv.cancel}>Not now</button>
        </div>
        <p className="lbl" style={{ fontWeight: 400 }}>pCloud links never need this step.</p>
      </main>
    );
  }

  if (pv.phase === "loading") {
    return (
      <main className="page">
        <p className="quiet" role="status">Reading the link…</p>
      </main>
    );
  }

  if (pv.phase === "error") {
    return (
      <main className="page">
        <p className="err" role="alert">{pv.error}</p>
        <div style={wrap}>
          <button type="button" className="btn p" onClick={pv.retry}>Try again</button>
          <button type="button" className="lnk quiet" onClick={pv.cancel}>Cancel</button>
        </div>
      </main>
    );
  }

  const choices = [{ path: "", name: "Everything" }, ...pv.subfolders];
  return (
    <main className="page">
      <div style={{ ...col, gap: 10 }}>
        <p className="lbl">{pv.providerLabel}</p>
        <h1 className="big">{pv.sourceName}</h1>
      </div>

      <section style={{ ...col, gap: 12 }}>
        <h2 className="lbl">Copy to</h2>
        <div className="mono" style={{ display: "flex", alignItems: "center", gap: 2, minHeight: 52, padding: "0 16px", borderRadius: "var(--r)", background: "var(--field)", fontSize: 14 }}>
          <span className="quiet" style={{ flex: "none" }}>{pv.destPrefix}</span>
          {editing ? (
            <input
              aria-label="Folder name"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") finish(true);
                if (e.key === "Escape") finish(false);
              }}
              onBlur={() => finish(true)}
              className="mono"
              style={{ flex: 1, minWidth: 0, fontSize: "inherit", background: "var(--bg)", border: "1px solid var(--text)", borderRadius: 3, padding: "5px 6px", outline: "none" }}
            />
          ) : (
            <button type="button" className="mono" title="Double-click to rename" onDoubleClick={edit}
              style={{ background: "none", border: 0, padding: "2px 4px", margin: "0 -4px", fontSize: "inherit", textAlign: "left", overflowWrap: "anywhere", cursor: "text" }}>
              {pv.name}
            </button>
          )}
        </div>
        <div className="quiet" style={{ ...sub, display: "flex", gap: 20, flexWrap: "wrap", alignItems: "baseline" }}>
          {pv.exists ? (
            <span style={{ flex: "1 1 260px", color: "var(--text)" }}>
              A folder with this name is already here. New files will be added to it.
              {!pv.keepEdits && " Files with the same name will be replaced."}
            </span>
          ) : (
            <span style={{ flex: "1 1 260px" }}>Double-click the name to rename it.</span>
          )}
          {pv.renamed && <button type="button" className="lnk quiet" onClick={pv.resetName}>Use original name</button>}
          <button type="button" className="lnk" onClick={edit}>Rename</button>
          <button type="button" className="lnk" onClick={pv.changeLocation}>Change location</button>
        </div>
      </section>

      <fieldset style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <legend className="lbl" style={{ padding: "0 0 8px" }}>What to copy</legend>
        <div className="rows">
          {choices.map((c) => (
            <label key={c.path} className="row" style={{ cursor: "pointer" }}>
              <input type="radio" name="what" checked={pv.choice === c.path} onChange={() => pv.choose(c.path)}
                style={{ width: 16, height: 16, margin: 0, accentColor: "var(--text)" }} />
              <span>{c.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="rows">
        <label className="row" style={{ cursor: "pointer" }}>
          <span style={{ flex: 1, ...col, gap: 3 }}>
            <span>Keep it up to date</span>
            <span className="quiet" style={sub}>Checks for new files on its own</span>
          </span>
          <input type="checkbox" className="tog" checked={pv.keepUpToDate} onChange={pv.toggleKeepUpToDate} />
        </label>
        <label className="row" style={{ cursor: "pointer" }}>
          <span style={{ flex: 1, ...col, gap: 3 }}>
            <span>Keep my edits</span>
            <span className="quiet" style={sub}>Files you change here are never lost</span>
          </span>
          <input type="checkbox" className="tog" checked={pv.keepEdits} onChange={pv.toggleKeepEdits} />
        </label>
      </div>

      <div style={wrap}>
        <button type="button" className="btn p" disabled={pv.phase !== "ready" || pv.starting} onClick={pv.start}>
          Start copying
        </button>
        <button type="button" className="lnk quiet" onClick={pv.cancel}>Cancel</button>
      </div>
    </main>
  );
}
