import { useEffect, useState } from "react";
import type { DirEntry, FolderRow } from "../types";
import { fmtBytes, relTime } from "../format";

const SHOW = 200; // rows rendered before "Show all"
const MONTH = 30 * 86400;

/** "3h ago" for recent files, a plain date for anything older than a month. */
function when(secs: number | null): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  return Date.now() / 1000 - secs < MONTH ? relTime(d.toISOString()) : d.toLocaleDateString();
}

/** Browse the files a folder has copied: click a folder to go in, a file to open it. */
export default function Contents({ f }: { f: FolderRow }) {
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);

  // Reload on navigation and whenever a copy finishes (last_at changes).
  useEffect(() => {
    let live = true;
    setError("");
    setAll(false);
    f.listDir(path)
      .then((list) => live && setEntries(list))
      .catch((e: unknown) => {
        if (!live) return;
        setEntries([]);
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
    // f.listDir is recreated every render; f.id covers it.
  }, [f.id, path, f.last_at]);

  const go = (p: string) => {
    setEntries(null);
    setPath(p);
  };
  const parts = path ? path.split("/") : [];
  const shown = entries && !all ? entries.slice(0, SHOW) : entries;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 className="lbl">Contents</h2>
      <nav aria-label="Folder path" style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 14 }}>
        {[f.source_name, ...parts].map((name, i) =>
          i === parts.length ? (
            <span key={i} aria-current="location">{name}</span>
          ) : (
            <span key={i} style={{ display: "contents" }}>
              <button type="button" className="lnk quiet" onClick={() => go(parts.slice(0, i).join("/"))}>{name}</button>
              <span className="quiet">/</span>
            </span>
          ),
        )}
      </nav>

      {error ? (
        <p className="err" role="alert">{error}</p>
      ) : entries === null ? (
        <p className="quiet" style={{ fontSize: 14 }}>Loading…</p>
      ) : entries.length === 0 ? (
        <p className="quiet" style={{ fontSize: 14 }}>{path ? "This folder is empty." : "Nothing copied yet."}</p>
      ) : (
        <div className="rows">
          {shown!.map((e) => (
            <button type="button" key={e.path} className="row item" onClick={() => (e.isDir ? go(e.path) : f.openItem(e.path))}>
              <span className="name">{e.isDir ? `${e.name}/` : e.name}</span>
              <span className="meta">
                {e.isDir ? "›" : [fmtBytes(e.size), when(e.modified)].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </div>
      )}
      {entries && !all && entries.length > SHOW && (
        <button type="button" className="lnk" style={{ alignSelf: "flex-start", fontSize: 14 }} onClick={() => setAll(true)}>
          Show all {entries.length}
        </button>
      )}
    </section>
  );
}
