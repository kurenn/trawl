import { useTrawl } from "../store";

export default function Connect() {
  const t = useTrawl();

  const isConnecting = t.connection.phase === "connecting";
  const isError = t.connection.phase === "error";

  return (
    <div
      style={{
        maxWidth: "560px",
        margin: "90px auto 0",
        padding: "0 24px",
        textAlign: "center",
      }}
    >
      {/* Icon tile */}
      <div
        style={{
          width: "54px",
          height: "54px",
          borderRadius: "14px",
          background: "var(--bg-card)",
          border: "1px solid var(--border-card)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          margin: "0 auto 22px",
        }}
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 15 15"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M1.3 4.2C1.3 3.3 2 2.6 2.9 2.6H5.2L6.6 4.1H12.1C13 4.1 13.7 4.8 13.7 5.7V11C13.7 11.9 13 12.6 12.1 12.6H2.9C2 12.6 1.3 11.9 1.3 11V4.2Z"
            stroke="var(--accent)"
            strokeWidth="1.1"
          />
        </svg>
      </div>

      {/* Heading */}
      <div
        style={{
          fontSize: "20px",
          fontWeight: 600,
          color: "var(--text-primary)",
        }}
      >
        Connect Google Drive
      </div>

      {/* Description */}
      <p
        style={{
          fontSize: "13.5px",
          lineHeight: 1.7,
          color: "var(--text-muted)",
          margin: "12px 0 26px",
        }}
      >
        Trawl uses rclone to copy Google Drive folders to your local library —
        additive only, it never deletes at the destination. A one-time Google
        sign-in is required to approve access; your default browser will open to
        complete the flow.
      </p>

      {/* Connect button */}
      <button
        onClick={t.connect}
        disabled={isConnecting}
        style={{
          fontFamily: "inherit",
          fontSize: "13.5px",
          fontWeight: 600,
          color: "var(--accent-ink)",
          background: "var(--accent)",
          border: "none",
          borderRadius: "8px",
          padding: "11px 20px",
          cursor: isConnecting ? "default" : "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          opacity: isConnecting ? 0.85 : 1,
        }}
      >
        {isConnecting ? (
          <>
            <span
              style={{
                width: "13px",
                height: "13px",
                borderRadius: "50%",
                border: "2px solid var(--border-card)",
                borderTopColor: "var(--accent)",
                animation: "spin .7s linear infinite",
                flexShrink: 0,
              }}
            />
            Connecting…
          </>
        ) : (
          "Connect"
        )}
      </button>

      {/* Error message */}
      {isError && t.connection.error && (
        <div
          style={{
            marginTop: "14px",
            fontSize: "12px",
            color: "var(--status-red-soft)",
          }}
        >
          {t.connection.error}
        </div>
      )}
    </div>
  );
}
