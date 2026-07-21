import { useTrawl } from "../store";
import type { ConnectionPhase } from "../types";

/* ------------------------------------------------------------------ *
 * Dot status config                                                     *
 * ------------------------------------------------------------------ */
interface DotConfig {
  bg: string;
  boxShadow: string;
  animation: string;
  label: string;
}

function dotConfig(phase: ConnectionPhase): DotConfig {
  switch (phase) {
    case "connected":
      return {
        bg: "var(--accent)",
        boxShadow: "0 0 7px var(--accent)",
        animation: "pulseDot 2.4s infinite",
        label: `Google Drive · connected`,
      };
    case "connecting":
    case "checking":
      return {
        bg: "var(--status-amber)",
        boxShadow: "none",
        animation: "none",
        label: `Google Drive · connecting…`,
      };
    case "error":
      return {
        bg: "var(--status-red)",
        boxShadow: "none",
        animation: "none",
        label: `Google Drive · error`,
      };
    case "disconnected":
    default:
      return {
        bg: "#565b66",
        boxShadow: "none",
        animation: "none",
        label: `Google Drive · not connected`,
      };
  }
}

/* ------------------------------------------------------------------ *
 * Sidebar                                                               *
 * ------------------------------------------------------------------ */
export default function Sidebar() {
  const t = useTrawl();

  const dashActive = t.view === "dashboard" || t.view === "run";
  const newMappingActive = t.view === "newMapping";

  const navBtnBase: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "11px",
    padding: "9px 12px",
    borderRadius: "7px",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
    fontSize: "13.5px",
    fontWeight: 500,
  };

  const activeStyle: React.CSSProperties = {
    background: "#23262f",
    color: "var(--accent)",
  };

  const inactiveStyle: React.CSSProperties = {
    background: "transparent",
    color: "#888d99",
  };

  const dot = dotConfig(t.connection.phase);

  return (
    <aside
      style={{
        width: "230px",
        flex: "none",
        background: "var(--bg-sidebar)",
        borderRight: "1px solid var(--border-subtle)",
        display: "flex",
        flexDirection: "column",
        padding: "18px 0",
        position: "sticky",
        top: 0,
        height: "100vh",
      }}
    >
      {/* Brand */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "11px",
          padding: "2px 20px 22px",
        }}
      >
        <span
          style={{
            width: "26px",
            height: "26px",
            borderRadius: "7px",
            background: "var(--accent)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              width: "10px",
              height: "10px",
              borderRadius: "2px",
              background: "var(--accent-ink)",
            }}
          />
        </span>
        <span
          style={{
            fontSize: "16px",
            fontWeight: 700,
            color: "var(--text-primary)",
            letterSpacing: ".2px",
          }}
        >
          Trawl
        </span>
      </div>

      {/* Nav */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "2px",
          padding: "0 12px",
        }}
      >
        {/* Mappings */}
        <button
          onClick={t.goDashboard}
          style={{
            ...navBtnBase,
            ...(dashActive ? activeStyle : inactiveStyle),
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 15 15"
            fill="none"
            aria-hidden="true"
          >
            <rect x="1" y="1" width="5.5" height="5.5" rx="1.4" fill="currentColor" />
            <rect x="8.5" y="1" width="5.5" height="5.5" rx="1.4" fill="currentColor" opacity=".5" />
            <rect x="1" y="8.5" width="5.5" height="5.5" rx="1.4" fill="currentColor" opacity=".5" />
            <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1.4" fill="currentColor" />
          </svg>
          Mappings
          <span
            style={{
              marginLeft: "auto",
              fontSize: "11.5px",
              color: dashActive ? "var(--accent)" : "var(--text-faint)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {t.mappingCount}
          </span>
        </button>

        {/* New mapping */}
        <button
          onClick={t.goNewMapping}
          style={{
            ...navBtnBase,
            ...(newMappingActive ? activeStyle : inactiveStyle),
          }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 15 15"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M1.3 4.2C1.3 3.3 2 2.6 2.9 2.6H5.2L6.6 4.1H12.1C13 4.1 13.7 4.8 13.7 5.7V11C13.7 11.9 13 12.6 12.1 12.6H2.9C2 12.6 1.3 11.9 1.3 11V4.2Z"
              stroke="currentColor"
              strokeWidth="1.3"
            />
          </svg>
          New mapping
        </button>
      </div>

      {/* Footer */}
      <div
        style={{
          margin: "auto 18px 0",
          borderTop: "1px solid var(--border-subtle)",
          paddingTop: "14px",
        }}
      >
        {/* Daemon status row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "11.5px",
            color: "var(--text-muted)",
          }}
        >
          <span
            style={{
              width: "7px",
              height: "7px",
              borderRadius: "50%",
              background: dot.bg,
              boxShadow: dot.boxShadow,
              animation: dot.animation,
              flexShrink: 0,
            }}
          />
          {dot.label}
        </div>

        {/* Connect affordance — Drive is optional (pCloud needs no connection),
            so offer Connect here rather than blocking the whole app. */}
        {t.connection.phase !== "connected" &&
          t.connection.phase !== "connecting" && (
            <button
              onClick={t.goConnect}
              style={{
                marginTop: "8px",
                fontFamily: "inherit",
                fontSize: "11.5px",
                fontWeight: 500,
                color: "var(--accent)",
                background: "var(--accent-10)",
                border: "1px solid var(--accent-25)",
                borderRadius: "6px",
                padding: "5px 10px",
                cursor: "pointer",
                width: "100%",
                textAlign: "center",
              }}
            >
              Connect Google Drive
            </button>
          )}

        {/* Update affordance — checks GitHub Releases; installs in-app + relaunches. */}
        {t.update.phase === "available" ? (
          <button
            onClick={t.installUpdate}
            title={`Install Trawl ${t.update.version ?? ""} and restart`}
            style={{
              marginTop: "8px",
              fontFamily: "inherit",
              fontSize: "11.5px",
              fontWeight: 600,
              color: "var(--accent-ink)",
              background: "var(--accent)",
              border: "1px solid transparent",
              borderRadius: "6px",
              padding: "6px 10px",
              cursor: "pointer",
              width: "100%",
              textAlign: "center",
            }}
          >
            ↑ Update to v{t.update.version}
          </button>
        ) : t.update.phase === "downloading" ? (
          <div
            style={{
              marginTop: "8px",
              fontSize: "11.5px",
              color: "var(--accent)",
            }}
          >
            Downloading update…
          </div>
        ) : t.update.phase === "checking" ? (
          <div
            style={{
              marginTop: "8px",
              fontSize: "11.5px",
              color: "var(--text-faint)",
            }}
          >
            Checking for updates…
          </div>
        ) : (
          <button
            onClick={t.checkForUpdate}
            style={{
              marginTop: "8px",
              fontFamily: "inherit",
              fontSize: "11.5px",
              color: "var(--text-faint)",
              background: "transparent",
              border: "none",
              padding: "2px 0",
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            {t.update.phase === "error"
              ? "Update check failed — retry"
              : t.update.phase === "current"
                ? "✓ Trawl is up to date · re-check"
                : "Check for updates"}
          </button>
        )}

        {/* Each mapping has its own destination folder (shown on its card),
            so there's no single global root to display here. */}
      </div>
    </aside>
  );
}
