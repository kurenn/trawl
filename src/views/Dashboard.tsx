import { useTrawl } from "../store";
import type { MappingCard } from "../types";

export default function Dashboard() {
  const t = useTrawl();

  if (t.isEmpty) {
    return (
      <div
        style={{
          maxWidth: 560,
          margin: "90px auto 0",
          padding: "0 24px",
          textAlign: "center",
        }}
      >
        {/* Folder tile */}
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: 14,
            background: "var(--bg-card)",
            border: "1px solid var(--border-card)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            margin: "0 auto 22px",
          }}
        >
          <svg width="26" height="26" viewBox="0 0 15 15" fill="none">
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
            fontSize: 20,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          No sync mappings yet
        </div>

        {/* Description */}
        <p
          style={{
            fontSize: 13.5,
            lineHeight: 1.7,
            color: "var(--text-muted)",
            margin: "12px 0 26px",
          }}
        >
          Trawl mirrors shared Google&#8209;Drive folders onto your local
          library with{" "}
          <span style={{ color: "#a7abb5" }}>rclone copy</span> &mdash; additive
          only, it never deletes at the destination. Pair a Drive folder with a
          local folder under{" "}
          <span style={{ color: "var(--accent)" }}>{t.libraryRoot}</span>, and
          pull.
        </p>

        {/* CTA */}
        <button
          onClick={t.goNewMapping}
          style={{
            fontFamily: "inherit",
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--accent-ink)",
            background: "var(--accent)",
            border: "none",
            borderRadius: 8,
            padding: "11px 20px",
            cursor: "pointer",
          }}
        >
          Create a mapping
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        maxWidth: 1080,
        margin: "0 auto",
        width: "100%",
        padding: "30px 32px",
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 22,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 600,
              letterSpacing: "-0.2px",
              color: "var(--text-primary)",
            }}
          >
            Sync Mappings
          </div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--text-muted)",
              marginTop: 3,
            }}
          >
            {t.mappingCount} folders &middot; additive copy, never deletes
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {/* Global auto-sync interval selector */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontSize: 12.5,
              color: "var(--text-muted)",
              whiteSpace: "nowrap",
            }}
          >
            Auto-sync:
            <select
              value={String(t.autoIntervalMinutes)}
              onChange={(e) => t.setAutoIntervalMinutes(Number(e.target.value))}
              style={{
                fontFamily: "inherit",
                fontSize: 12.5,
                color: "var(--text-secondary)",
                background: "var(--bg-button-neutral)",
                border: "1px solid var(--border-button)",
                borderRadius: 7,
                padding: "8px 10px",
                cursor: "pointer",
                appearance: "none",
                WebkitAppearance: "none",
                outline: "none",
              }}
            >
              <option value="0">Off</option>
              <option value="5">5 min</option>
              <option value="15">15 min</option>
              <option value="30">30 min</option>
              <option value="60">1 hr</option>
              <option value="360">6 hr</option>
            </select>
          </label>

          <button
            onClick={t.syncAll}
            style={{
              fontFamily: "inherit",
              fontSize: 12.5,
              fontWeight: 500,
              color: "var(--text-secondary)",
              background: "var(--bg-button-neutral)",
              border: "1px solid var(--border-button)",
              borderRadius: 7,
              padding: "9px 15px",
              cursor: "pointer",
            }}
          >
            Sync all enabled
          </button>
          <button
            onClick={t.goNewMapping}
            style={{
              fontFamily: "inherit",
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--accent-ink)",
              background: "var(--accent)",
              border: "none",
              borderRadius: 7,
              padding: "9px 15px",
              cursor: "pointer",
            }}
          >
            + New mapping
          </button>
        </div>
      </div>

      {/* Card list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {t.cards.map((card: MappingCard) => (
          <div
            key={card.id}
            style={{
              background: "var(--bg-card)",
              border: `1px solid ${card.statusMeta.cardBd}`,
              borderRadius: 9,
              padding: "15px 17px",
            }}
          >
            {/* Top row */}
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: 14,
              }}
            >
              {/* Left: name + pill + mono path + meta */}
              <div style={{ minWidth: 0 }}>
                {/* Name + status pill */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    flexWrap: "wrap",
                  }}
                >
                  <span
                    style={{
                      fontSize: 14.5,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {card.source_name}
                  </span>
                  {/* Provider tag */}
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 500,
                      color: "var(--text-muted)",
                      background: "var(--bg-button-neutral)",
                      border: "1px solid var(--border-button)",
                      borderRadius: 5,
                      padding: "2px 7px",
                      whiteSpace: "nowrap",
                      flex: "none",
                    }}
                  >
                    {card.providerLabel}
                  </span>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      whiteSpace: "nowrap",
                      fontSize: 11,
                      fontWeight: 500,
                      color: card.statusMeta.color,
                      background: card.statusMeta.bg,
                      padding: "3px 9px",
                      borderRadius: 20,
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: "50%",
                        background: card.statusMeta.color,
                        flexShrink: 0,
                      }}
                    />
                    {card.statusMeta.label}
                  </span>
                </div>

                {/* Mono path line */}
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    color: "var(--text-muted)",
                    marginTop: 9,
                    wordBreak: "break-all",
                  }}
                >
                  {card.srcLabel}&nbsp;&nbsp;&rarr;&nbsp;&nbsp;{card.destDisplay}
                </div>

                {/* Progress (while syncing) or last-run meta line */}
                {card.running ? (
                  <div
                    onClick={card.openRun}
                    title="View live log"
                    style={{ cursor: "pointer" }}
                  >
                    <div
                      style={{
                        position: "relative",
                        height: 6,
                        borderRadius: 4,
                        background: "var(--bg-sidebar)",
                        overflow: "hidden",
                        marginTop: 9,
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          top: 0,
                          bottom: 0,
                          left: 0,
                          width: card.barWidth,
                          background: "var(--status-amber)",
                          borderRadius: 4,
                          transition: "width .25s linear",
                        }}
                      />
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--text-secondary)",
                        marginTop: 6,
                        wordBreak: "break-word",
                      }}
                    >
                      {card.progressLabel}
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: "var(--text-faint-2)",
                      marginTop: 7,
                    }}
                  >
                    {card.metaLine}
                  </div>
                )}

                {/* Auto-sync label */}
                <div
                  style={{
                    fontSize: 11.5,
                    color: "var(--text-muted)",
                    marginTop: 4,
                  }}
                >
                  {card.autoLabel.startsWith("Auto") ? (
                    <>
                      <span style={{ color: "var(--accent)" }}>Auto</span>
                      {card.autoLabel.slice(4)}
                    </>
                  ) : (
                    card.autoLabel
                  )}
                </div>
              </div>

              {/* Right: action cluster */}
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flex: "none",
                  alignItems: "center",
                }}
              >
                {/* Auto toggle */}
                <button
                  onClick={card.toggleAuto}
                  title="Toggle background auto-sync"
                  style={{
                    fontFamily: "inherit",
                    fontSize: 12,
                    fontWeight: 500,
                    color: card.auto_sync ? "var(--accent)" : "var(--status-grey)",
                    background: card.auto_sync
                      ? "var(--accent-10)"
                      : "var(--bg-button-neutral)",
                    border: card.auto_sync
                      ? "1px solid var(--accent-25)"
                      : "1px solid var(--border-button)",
                    borderRadius: 6,
                    padding: "6px 11px",
                    cursor: "pointer",
                  }}
                >
                  {card.auto_sync ? "· Auto" : "Auto"}
                </button>

                {/* Skip-shortcuts toggle (Drive only) — ignores Google Drive
                    shortcuts so a shortcut that loops back on itself can't make
                    the copy recurse forever. */}
                {card.source_provider === "gdrive" && (
                  <button
                    onClick={card.toggleSkipShortcuts}
                    title="Ignore Google Drive shortcuts (fixes shortcut folder loops)"
                    style={{
                      fontFamily: "inherit",
                      fontSize: 12,
                      fontWeight: 500,
                      color: card.skip_shortcuts
                        ? "var(--accent)"
                        : "var(--status-grey)",
                      background: card.skip_shortcuts
                        ? "var(--accent-10)"
                        : "var(--bg-button-neutral)",
                      border: card.skip_shortcuts
                        ? "1px solid var(--accent-25)"
                        : "1px solid var(--border-button)",
                      borderRadius: 6,
                      padding: "6px 11px",
                      cursor: "pointer",
                    }}
                  >
                    {card.skip_shortcuts ? "· Skip shortcuts" : "Skip shortcuts"}
                  </button>
                )}

                {/* Cancel (while syncing) or Sync now / Retry */}
                {card.running ? (
                  <button
                    onClick={card.cancelNow}
                    style={{
                      fontFamily: "inherit",
                      fontSize: 12,
                      fontWeight: 500,
                      color: "var(--status-red)",
                      background: "transparent",
                      border: "1px solid var(--red-40)",
                      borderRadius: 6,
                      padding: "6px 13px",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                ) : (
                  <button
                    onClick={card.syncNow}
                    style={{
                      fontFamily: "inherit",
                      fontSize: 12,
                      fontWeight: 500,
                      color: "var(--accent)",
                      background: "var(--accent-10)",
                      border: "1px solid var(--accent-25)",
                      borderRadius: 6,
                      padding: "6px 13px",
                      cursor: "pointer",
                    }}
                  >
                    {card.syncLabel}
                  </button>
                )}

                {/* Delete control */}
                {card.pendingDelete ? (
                  <div
                    style={{
                      display: "flex",
                      gap: 6,
                      alignItems: "center",
                      fontSize: 12,
                      color: "var(--status-red-soft)",
                    }}
                  >
                    remove?
                    <button
                      onClick={card.confirmDelete}
                      style={{
                        fontFamily: "inherit",
                        fontSize: 12,
                        color: "var(--status-red)",
                        background: "var(--red-10)",
                        border: "1px solid var(--red-30)",
                        borderRadius: 6,
                        padding: "6px 10px",
                        cursor: "pointer",
                      }}
                    >
                      Yes
                    </button>
                    <button
                      onClick={card.cancelDelete}
                      style={{
                        fontFamily: "inherit",
                        fontSize: 12,
                        color: "var(--status-grey)",
                        background: "var(--bg-button-neutral)",
                        border: "1px solid var(--border-button)",
                        borderRadius: 6,
                        padding: "6px 10px",
                        cursor: "pointer",
                      }}
                    >
                      No
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={card.askDelete}
                    style={{
                      fontFamily: "inherit",
                      fontSize: 12,
                      color: "var(--status-grey)",
                      background: "var(--bg-button-neutral)",
                      border: "1px solid var(--border-button)",
                      borderRadius: 6,
                      padding: "6px 11px",
                      cursor: "pointer",
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>

            {/* Error block — only for the most recent COMPLETED run that failed.
                While a run is in flight the error is cleared (see store), so this
                banner reflects the current state, not a stale failure. The
                timestamp makes "still failing vs. old error" unambiguous. */}
            {card.last_status === "failed" && card.last_error && (
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--status-red-soft)",
                  background: "var(--red-07)",
                  border: "1px solid var(--red-20)",
                  borderRadius: 6,
                  padding: "8px 11px",
                  marginTop: 11,
                }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    marginBottom: 3,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                  }}
                >
                  <span>Last sync failed</span>
                  {card.failedAgo && (
                    <span style={{ opacity: 0.7, fontWeight: 400 }}>
                      {card.failedAgo}
                    </span>
                  )}
                </div>
                {card.last_error}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
