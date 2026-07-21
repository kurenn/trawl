import { useTrawl } from "../store";
import type { RunLogKind } from "../types";

function logColor(kind: RunLogKind): string {
  switch (kind) {
    case "info":    return "#8a8f9a";
    case "success": return "var(--accent)";
    case "error":   return "var(--status-red-soft-2)";
    case "notice":  return "var(--status-amber)";
    case "meta":    return "var(--text-muted)";
  }
}

export default function Run() {
  const t = useTrawl();
  const r = t.run;
  if (!r) return null;

  return (
    <div
      style={{
        maxWidth: 760,
        margin: "0 auto",
        width: "100%",
        padding: "30px 32px",
      }}
    >
      {/* Back link */}
      <button
        onClick={r.back}
        style={{
          fontFamily: "inherit",
          fontSize: 12.5,
          color: "var(--text-muted)",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: 0,
          marginBottom: 16,
          display: "block",
        }}
        onMouseEnter={(e) =>
          ((e.currentTarget as HTMLButtonElement).style.color =
            "var(--accent)")
        }
        onMouseLeave={(e) =>
          ((e.currentTarget as HTMLButtonElement).style.color =
            "var(--text-muted)")
        }
      >
        ← Mappings
      </button>

      {/* Panel */}
      <div
        style={{
          background: "var(--bg-card)",
          border: "1px solid var(--border-card)",
          borderRadius: 11,
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border-card)",
          }}
        >
          {/* Left: name + run id */}
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 16,
                fontWeight: 600,
                color: "var(--text-primary)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {r.name}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--text-muted)",
                marginTop: 2,
                fontFamily: "var(--font-mono)",
              }}
            >
              run #{r.runId}
            </div>
          </div>

          {/* Right: status pill */}
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11.5,
              fontWeight: 500,
              whiteSpace: "nowrap",
              color: r.statusMeta.color,
              background: r.statusMeta.bg,
              padding: "4px 11px",
              borderRadius: 20,
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: "50%",
                background: r.statusMeta.color,
                flexShrink: 0,
              }}
            />
            {r.statusMeta.label}
          </span>
        </div>

        {/* Body */}
        <div style={{ padding: 20 }}>
          {/* Mono src / dst block */}
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              color: "var(--text-muted)",
              lineHeight: 1.9,
              marginBottom: 18,
              wordBreak: "break-all",
            }}
          >
            <div>
              <span style={{ color: "var(--text-faint)" }}>src</span>
              {"  "}
              {r.src}
            </div>
            <div>
              <span style={{ color: "var(--text-faint)" }}>dst</span>
              {"  "}
              {"→ "}
              {r.dest}
            </div>
          </div>

          {/* Progress bar */}
          <div
            style={{
              position: "relative",
              height: 10,
              borderRadius: 6,
              background: "var(--bg-sidebar)",
              overflow: "hidden",
            }}
          >
            {/* Fill */}
            <div
              style={{
                position: "absolute",
                inset: "0 auto 0 0",
                width: r.barWidth,
                background: r.barColor,
                borderRadius: 6,
                transition: "width .25s linear",
              }}
            />
            {/* Shine overlay */}
            <div
              style={{
                position: "absolute",
                inset: 0,
                width: r.barWidth,
                overflow: "hidden",
                opacity: r.shineOpacity,
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  width: "40%",
                  background:
                    "linear-gradient(90deg, transparent, rgba(255,255,255,.35), transparent)",
                  animation: "barShine 1.3s linear infinite",
                }}
              />
            </div>
          </div>

          {/* Readout */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 11,
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                color: "#8a8f9a",
              }}
            >
              {r.transferred} / {r.total} · {r.files}/{r.filesTotal} files · {r.speed}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                color: "#8a8f9a",
              }}
            >
              {r.pct}% · ETA {r.eta}
            </div>
          </div>

          {/* Log tail */}
          <div
            style={{
              marginTop: 18,
              background: "var(--bg-sidebar)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 8,
              padding: "11px 14px",
              height: 188,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-end",
            }}
          >
            {r.log.map((ln, i) => (
              <div
                key={i}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  lineHeight: 1.7,
                  color: logColor(ln.kind),
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {ln.text}
              </div>
            ))}
          </div>

          {/* Actions */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 18,
            }}
          >
            {r.isRunning && (
              <button
                onClick={r.cancel}
                style={{
                  fontFamily: "inherit",
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: "var(--status-red)",
                  background: "transparent",
                  border: "1px solid var(--red-40)",
                  borderRadius: 7,
                  padding: "9px 16px",
                  cursor: "pointer",
                }}
              >
                Cancel sync
              </button>
            )}

            {r.isDone && (
              <div style={{ display: "flex", gap: 10 }}>
                <button
                  onClick={r.retry}
                  style={{
                    fontFamily: "inherit",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--accent-ink)",
                    background: "var(--accent)",
                    border: "none",
                    borderRadius: 7,
                    padding: "9px 16px",
                    cursor: "pointer",
                  }}
                >
                  Run again
                </button>
                <button
                  onClick={r.back}
                  style={{
                    fontFamily: "inherit",
                    fontSize: 12.5,
                    color: "var(--text-secondary)",
                    background: "var(--bg-button-neutral)",
                    border: "1px solid var(--border-button)",
                    borderRadius: 7,
                    padding: "9px 16px",
                    cursor: "pointer",
                  }}
                >
                  Back to mappings
                </button>
              </div>
            )}

            {r.hasQueue && (
              <span style={{ fontSize: 11.5, color: "var(--status-amber)" }}>
                queue · {r.queueRemaining} remaining
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
