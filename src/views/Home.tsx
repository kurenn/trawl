import { useRef } from "react";
import { useTrawl } from "../store";
import { fmtInterval } from "../format";
import type { FolderRow } from "../types";

function PasteField({ label, placeholder }: { label: string; placeholder: string }) {
  const { pasteLink } = useTrawl();
  const ref = useRef<HTMLInputElement>(null);
  const submit = (text: string) => {
    const t = text.trim();
    if (!t) return;
    pasteLink(t);
    if (ref.current) ref.current.value = "";
  };
  return (
    <input
      ref={ref}
      className="field"
      type="text"
      aria-label={label}
      placeholder={placeholder}
      autoComplete="off"
      spellCheck={false}
      onPaste={(e) => {
        e.preventDefault();
        submit(e.clipboardData.getData("text"));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") submit(e.currentTarget.value);
      }}
    />
  );
}

function PlainRow({ f }: { f: FolderRow }) {
  return (
    <div className="row">
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <button type="button" className="lnk" style={{ alignSelf: "flex-start", textAlign: "left", fontWeight: 500 }} onClick={f.open}>
          {f.source_name}
        </button>
        <span className="quiet" style={{ fontSize: 14 }}>{f.statusLine}</span>
        {f.running && (
          <div className="bar thin" role="progressbar" aria-label={`Copying ${f.source_name}`}>
            <span style={{ width: f.barWidth }} />
          </div>
        )}
      </div>
      {f.action && (
        <button type="button" className="lnk" style={{ fontSize: 14 }} onClick={f.action.run}>
          {f.action.label}
        </button>
      )}
    </div>
  );
}

export default function Home() {
  const { isEmpty, headline, subline, folders, checkAll, pasteError, settings } = useTrawl();
  const err = pasteError && <p className="err" role="alert">{pasteError}</p>;

  if (isEmpty) {
    const checks = settings.auto_sync_enabled && settings.auto_sync_interval_minutes > 0
      ? `Checks for new ones every ${fmtInterval(settings.auto_sync_interval_minutes)}`
      : "Checks when you ask";
    return (
      <main className="page">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h1 className="hero">Keep a copy of any shared folder.</h1>
          <p className="quiet" style={{ fontSize: 17, lineHeight: 1.6 }}>
            Paste a Google Drive or pCloud folder link. Trawl copies it to this computer and keeps it up to date. It never deletes anything.
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <PasteField label="Paste a folder link" placeholder="Paste a folder link" />
          {err}
          <p className="lbl">Find the link in Drive or pCloud under Share › Copy link.</p>
        </div>
        <p className="quiet" style={{ paddingTop: 24, borderTop: "1px solid var(--line)", fontSize: 14, lineHeight: 1.7 }}>
          Only adds files · {checks} · pCloud links need no account
        </p>
      </main>
    );
  }

  const problems = folders.filter((f) => f.problem);
  const rest = problems.length ? folders.filter((f) => !f.problem) : folders;

  return (
    <main className="page">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h1 className="big">{headline}</h1>
        <p className="quiet" style={{ fontSize: 16 }}>
          {subline} ·{" "}
          <button type="button" className="lnk quiet" onClick={checkAll}>Check now</button>
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <PasteField label="Paste a folder link to add it" placeholder="Paste a folder link to add it" />
        {err}
      </div>

      {problems.map((f) => (
        <article key={f.id} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span className="lbl" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="dot" aria-hidden="true" />
            {f.source_name}
          </span>
          <h2 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.02em" }}>{f.problem!.title}</h2>
          <p className="quiet">{f.problem!.body}</p>
          <div>
            <button type="button" className="btn p" onClick={f.problem!.fix}>{f.problem!.fixLabel}</button>
          </div>
        </article>
      ))}

      {rest.length > 0 && (
        <section>
          {problems.length > 0 && <h2 className="lbl" style={{ paddingBottom: 8 }}>Everything else</h2>}
          <div className="rows">
            {rest.map((f) => <PlainRow key={f.id} f={f} />)}
          </div>
        </section>
      )}
    </main>
  );
}
