import { useTrawl } from "../store";

export default function Copying() {
  const { run, settings } = useTrawl();
  if (!run) return null;

  const { status, isRunning, problem } = run;
  const label =
    status === "succeeded" ? "Copied" : status === "cancelled" ? "Stopped" : status === "failed" ? "Needs attention" : "Copying";

  return (
    <main className="page">
      <section style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <p className="lbl">{label}</p>
          <h1 className="big">{run.name}</h1>
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
          <span style={{ fontSize: 72, lineHeight: 1, fontWeight: 300, letterSpacing: "-0.04em", fontVariantNumeric: "tabular-nums" }}>
            {run.pct}%
          </span>
          {run.timeLeft && <span className="quiet" style={{ fontSize: 16 }}>{run.timeLeft}</span>}
        </div>

        <div className="bar" role="progressbar" aria-valuenow={run.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Copy progress">
          <span style={{ width: run.barWidth }} />
        </div>

        {run.stats && <p className="quiet" style={{ fontSize: 14, fontVariantNumeric: "tabular-nums" }}>{run.stats}</p>}

        {problem && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p className="err">{problem.title}</p>
            <p className="quiet" style={{ fontSize: 14 }}>{problem.body}</p>
            <div style={{ display: "flex", gap: 16 }}>
              <button type="button" className="lnk" onClick={problem.fix}>{problem.fixLabel}</button>
              <button type="button" className="lnk quiet" onClick={run.back}>Back to folders</button>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {isRunning && (
            <button type="button" className="btn" disabled={run.starting} onClick={run.stop}>Stop</button>
          )}
          {status === "succeeded" && <button type="button" className="btn p" onClick={run.back}>Back to folders</button>}
          {status === "cancelled" && <button type="button" className="btn p" onClick={run.retry}>Resume</button>}
          <button type="button" className="btn" onClick={run.openFolder}>Open folder</button>
        </div>
        {run.openFolderError && <p className="err">{run.openFolderError}</p>}
        {isRunning && (
          <p className="quiet" style={{ fontSize: 14 }}>Files copied so far stay. Resume picks up where it stopped.</p>
        )}
      </section>

      <details>
        <summary className="lbl">Show details</summary>
        <div className="mono quiet" style={{ marginTop: 12, fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
          {run.log.map((l, i) => (
            <div key={i}>{l.text}</div>
          ))}
        </div>
      </details>

      {settings.minimize_to_tray && (
        <p className="quiet" style={{ fontSize: 14, lineHeight: 1.6 }}>
          You can close this window. Trawl keeps copying from the menu bar and lets you know when it's done.
        </p>
      )}
    </main>
  );
}
