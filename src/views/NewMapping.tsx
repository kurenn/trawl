/* ============================================================================
   Trawl — New Mapping view
   Two-pane screen: Drive source tree (left) + local dest tree (right),
   composer, and staged pairs list.
   ============================================================================ */

import { useTrawl } from "../store";
import type { TreeRow } from "../types";

/* --------------------------------------------------------------------------
   Shared SVGs
   -------------------------------------------------------------------------- */

function FolderGlyph({ stroke }: { stroke: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      style={{ flex: "none" }}
    >
      <path
        d="M1.3 4.2C1.3 3.3 2 2.6 2.9 2.6H5.2L6.6 4.1H12.1C13 4.1 13.7 4.8 13.7 5.7V11C13.7 11.9 13 12.6 12.1 12.6H2.9C2 12.6 1.3 11.9 1.3 11V4.2Z"
        stroke={stroke}
        strokeWidth="1.2"
      />
    </svg>
  );
}

function OutlineBoxGlyph({ stroke }: { stroke: string }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 15 15"
      fill="none"
      style={{ flex: "none" }}
    >
      <rect x="1.8" y="3.3" width="11.4" height="9" rx="1.4" stroke={stroke} strokeWidth="1.2" />
    </svg>
  );
}

/* --------------------------------------------------------------------------
   Badge (numbered circle)
   -------------------------------------------------------------------------- */

function Badge({ n }: { n: number }) {
  return (
    <span
      style={{
        width: 18,
        height: 18,
        borderRadius: "50%",
        background: "var(--accent-15)",
        color: "var(--accent)",
        fontSize: 11,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
      }}
    >
      {n}
    </span>
  );
}

/* --------------------------------------------------------------------------
   Spinner
   -------------------------------------------------------------------------- */

function Spinner() {
  return (
    <span
      style={{
        width: 13,
        height: 13,
        border: "2px solid var(--border-card)",
        borderTopColor: "var(--accent)",
        borderRadius: "50%",
        animation: "spin .7s linear infinite",
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

/* --------------------------------------------------------------------------
   Tree row renderer — shared for source and dest panes.
   loadingLabel: "listing…" for source, "reading…" for dest.
   emptyLabel:   "no subfolders" for source, "empty folder" for dest.
   -------------------------------------------------------------------------- */

function renderTreeRows(
  rows: TreeRow[],
  loadingLabel: string,
  emptyLabel: string,
) {
  return rows.map((r) => {
    if (r.kind === "row") {
      const selected = r.selected;
      return (
        <div
          key={r.key}
          className="hover-row"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            padding: "7px 8px",
            paddingLeft: r.pad,
            borderRadius: 6,
            background: selected ? "var(--accent-10)" : "transparent",
            cursor: "default",
          }}
        >
          {/* chevron */}
          <span
            onClick={r.hasChildren ? r.onToggle : undefined}
            style={{
              width: 15,
              height: 15,
              flex: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: r.hasChildren ? "pointer" : "default",
              color: "var(--text-muted)",
              fontSize: 9,
              transform: r.expanded ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform .15s",
            }}
          >
            {r.hasChildren ? "▶" : ""}
          </span>

          {/* folder glyph */}
          <span onClick={r.onSelect} style={{ cursor: "pointer", display: "flex" }}>
            <FolderGlyph stroke={selected ? "var(--accent)" : "var(--text-folder-glyph)"} />
          </span>

          {/* name */}
          <span
            onClick={r.onSelect}
            style={{
              fontSize: 13,
              color: selected ? "var(--accent)" : "var(--text-tree)",
              flex: 1,
              minWidth: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              cursor: "pointer",
            }}
          >
            {r.name}
          </span>

          {/* checkmark */}
          {selected && (
            <span style={{ flex: "none", color: "var(--accent)", fontSize: 12 }}>
              ✓
            </span>
          )}
        </div>
      );
    }

    if (r.kind === "loading") {
      return (
        <div
          key={r.key}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "7px 8px",
            paddingLeft: r.pad,
            color: "var(--text-faint)",
            fontSize: 12,
          }}
        >
          <Spinner />
          {loadingLabel}
        </div>
      );
    }

    // kind === "empty"
    return (
      <div
        key={r.key}
        style={{
          padding: "6px 8px",
          paddingLeft: r.pad,
          color: "var(--text-faint)",
          fontSize: 12,
          fontStyle: "italic",
        }}
      >
        {emptyLabel}
      </div>
    );
  });
}

/* --------------------------------------------------------------------------
   Main component
   -------------------------------------------------------------------------- */

export default function NewMapping() {
  const t = useTrawl();

  /* ----- root-row selected state ----- */
  const rootStroke = t.rootSelected ? "var(--accent)" : "var(--text-tree)";

  return (
    <div
      style={{
        maxWidth: 1080,
        margin: "0 auto",
        width: "100%",
        padding: "30px 32px",
      }}
    >
      {/* ----------------------------------------------------------------
          Title block
          ---------------------------------------------------------------- */}
      <div style={{ marginBottom: 18 }}>
        <div
          style={{
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: "-0.2px",
            color: "var(--text-primary)",
          }}
        >
          New sync mapping
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginTop: 3 }}>
          Pick a{" "}
          <span style={{ color: "var(--accent)" }}>Drive</span> or{" "}
          <span style={{ color: "var(--accent)" }}>pCloud</span> folder on the
          left, then choose the{" "}
          <span style={{ color: "var(--accent)" }}>local folder</span> it should
          sync into.
        </div>
      </div>

      {/* ----------------------------------------------------------------
          Mode tabs — "Folder ID / URL" and "Shared with me" only
          ---------------------------------------------------------------- */}
      <div
        style={{
          display: "flex",
          gap: 4,
          background: "var(--bg-sidebar)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 9,
          padding: 4,
          width: "max-content",
          marginBottom: 14,
        }}
      >
        {(
          [
            { label: "Folder ID / URL", value: "folder_id" as const },
            { label: "Shared with me", value: "shared_with_me" as const },
          ] as const
        ).map(({ label, value }) => {
          const active = t.mode === value;
          return (
            <button
              key={value}
              onClick={() => t.setMode(value)}
              style={{
                fontFamily: "inherit",
                fontSize: 12.5,
                fontWeight: 500,
                border: "none",
                borderRadius: 6,
                padding: "7px 14px",
                cursor: "pointer",
                background: active ? "var(--bg-button-neutral)" : "transparent",
                color: active ? "var(--text-primary)" : "#888d99",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* ----------------------------------------------------------------
          Folder ID / URL input row (mode === "folder_id" only)
          ---------------------------------------------------------------- */}
      {t.mode === "folder_id" && (
        <div style={{ display: "flex", gap: 9, marginBottom: 14 }}>
          <input
            value={t.folderIdInput}
            onInput={(e) =>
              t.setFolderIdInput((e.target as HTMLInputElement).value)
            }
            placeholder="Paste a Google Drive or pCloud folder link (or a bare ID)"
            style={{
              flex: 1,
              background: "var(--bg-sidebar)",
              border: "1px solid var(--border-card)",
              borderRadius: 7,
              padding: "10px 13px",
              color: "var(--text-primary)",
              fontSize: 13,
              outline: "none",
            }}
          />
          <button
            onClick={t.listSource}
            disabled={t.listing}
            style={{
              fontFamily: "inherit",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--accent-ink)",
              background: "var(--accent)",
              border: "none",
              borderRadius: 7,
              padding: "10px 18px",
              cursor: t.listing ? "default" : "pointer",
              opacity: t.listing ? 0.7 : 1,
            }}
          >
            {t.listing ? "Listing…" : "List"}
          </button>
        </div>
      )}

      {/* ----------------------------------------------------------------
          Two panes
          ---------------------------------------------------------------- */}
      <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
        {/* ---- LEFT: Drive source ---- */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--bg-sidebar)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 10,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "11px 14px",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <Badge n={1} />
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--text-secondary)",
              }}
            >
              Drive folder
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                color: "var(--text-faint)",
                marginLeft: "auto",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                maxWidth: 160,
              }}
            >
              {t.sourceFsLabel}
            </span>
          </div>

          {/* body */}
          <div
            style={{
              padding: 6,
              flex: 1,
              minHeight: 300,
              maxHeight: 430,
              overflowY: "auto",
            }}
          >
            {t.hasSourceRows ? (
              renderTreeRows(t.sourceRows, "listing…", "no subfolders")
            ) : (
              <div
                style={{
                  padding: "40px 20px",
                  textAlign: "center",
                  color: "var(--text-faint)",
                  fontSize: 12.5,
                }}
              >
                {t.sourceEmptyMsg}
              </div>
            )}
          </div>
        </div>

        {/* ---- center arrow ---- */}
        <div
          style={{
            flex: "none",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            color: "#3a3e49",
            fontSize: 20,
          }}
        >
          →
        </div>

        {/* ---- RIGHT: Local dest ---- */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--bg-sidebar)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 10,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          }}
        >
          {/* header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "11px 14px",
              borderBottom: "1px solid var(--border-subtle)",
            }}
          >
            <Badge n={2} />
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: "var(--text-secondary)",
              }}
            >
              Local folder
            </span>
            <button
              onClick={t.changeLibraryRoot}
              title="Pick the local folder this mapping syncs into"
              style={{
                marginLeft: "auto",
                fontFamily: "inherit",
                fontSize: 11.5,
                fontWeight: 500,
                color: "var(--accent)",
                background: "var(--accent-10)",
                border: "1px solid var(--accent-25)",
                borderRadius: 6,
                padding: "5px 10px",
                cursor: "pointer",
              }}
            >
              Choose folder…
            </button>
            <button
              onClick={t.toggleNewFolder}
              style={{
                fontFamily: "inherit",
                fontSize: 11.5,
                fontWeight: 500,
                color: "var(--accent)",
                background: "var(--accent-10)",
                border: "1px solid var(--accent-25)",
                borderRadius: 6,
                padding: "5px 10px",
                cursor: "pointer",
              }}
            >
              + New folder
            </button>
          </div>

          {/* body */}
          <div
            style={{
              padding: 6,
              flex: 1,
              minHeight: 300,
              maxHeight: 430,
              overflowY: "auto",
            }}
          >
            {/* inline new-folder row */}
            {t.showNewFolder && (
              <div
                style={{
                  display: "flex",
                  gap: 6,
                  padding: "4px 4px 10px",
                }}
              >
                <input
                  value={t.newFolderInput}
                  onInput={(e) =>
                    t.setNewFolderInput((e.target as HTMLInputElement).value)
                  }
                  placeholder="New folder name"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: "var(--bg-input-deep)",
                    border: "1px solid var(--border-card)",
                    borderRadius: 6,
                    padding: "8px 10px",
                    color: "var(--text-primary)",
                    fontSize: 12.5,
                    outline: "none",
                  }}
                />
                <button
                  onClick={t.createFolder}
                  style={{
                    fontFamily: "inherit",
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--accent-ink)",
                    background: "var(--accent)",
                    border: "none",
                    borderRadius: 6,
                    padding: "8px 12px",
                    cursor: "pointer",
                  }}
                >
                  Create
                </button>
              </div>
            )}

            {/* root row (always pinned) */}
            <div
              onClick={t.selectRoot}
              className="hover-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                padding: "7px 8px",
                borderRadius: 6,
                background: t.rootSelected ? "var(--accent-10)" : "transparent",
                cursor: "pointer",
              }}
            >
              {/* 15px spacer (replaces chevron) */}
              <span style={{ width: 15, flex: "none" }} />

              {/* outline-box SVG */}
              <OutlineBoxGlyph stroke={rootStroke} />

              {/* library root label (mono) */}
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12.5,
                  color: rootStroke,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {t.libraryRoot}
              </span>

              {/* checkmark */}
              {t.rootSelected && (
                <span style={{ flex: "none", color: "var(--accent)", fontSize: 12 }}>
                  ✓
                </span>
              )}
            </div>

            {/* dest tree rows */}
            {renderTreeRows(t.destRows, "reading…", "empty folder")}

            {/* empty hint (only when no dest rows and root not the only option) */}
            {t.destEmpty && t.destRows.length === 0 && (
              <div
                style={{
                  padding: "24px 18px",
                  textAlign: "center",
                  color: "var(--text-faint)",
                  fontSize: 12,
                  lineHeight: 1.6,
                }}
              >
                No folders here yet.
                <br />
                Sync into the root, or create one.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ----------------------------------------------------------------
          Composer
          ---------------------------------------------------------------- */}
      <div
        style={{
          marginTop: 14,
          background: "var(--bg-card)",
          border: `1px solid ${t.hasSource ? "var(--border-card)" : "var(--border-subtle)"}`,
          borderRadius: 10,
          padding: "15px 17px",
        }}
      >
        {t.hasSource ? (
          <>
            {/* source → dest row */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
              }}
            >
              {/* editable mapping name/label */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minWidth: 0,
                  flex: "0 1 220px",
                  background: "var(--bg-sidebar)",
                  border: "1px solid var(--border-card)",
                  borderRadius: 7,
                  padding: "0 12px",
                }}
              >
                <FolderGlyph stroke="var(--accent)" />
                <input
                  value={t.finalName}
                  onInput={(e) =>
                    t.setFinalName((e.target as HTMLInputElement).value)
                  }
                  placeholder={t.sourceName || "Name this sync"}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "var(--text-primary)",
                    fontSize: 13.5,
                    fontWeight: 600,
                    padding: "10px 0",
                  }}
                />
              </div>

              {/* arrow */}
              <span style={{ color: "var(--text-faint)", fontSize: 15 }}>→</span>

              {/* read-only destination path (contents merge here) */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flex: 1,
                  minWidth: 200,
                  background: "var(--bg-sidebar)",
                  border: "1px solid var(--border-card)",
                  borderRadius: 7,
                  overflow: "hidden",
                  padding: "10px 12px",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    color: "var(--text-secondary)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={t.destPrefixLabel}
                >
                  {t.destPrefixLabel}
                </span>
              </div>

              {/* Add mapping button */}
              <button
                onClick={t.addPair}
                style={{
                  fontFamily: "inherit",
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: "var(--accent-ink)",
                  background: "var(--accent)",
                  border: "none",
                  borderRadius: 7,
                  padding: "10px 16px",
                  cursor: "pointer",
                }}
              >
                Add mapping
              </button>
            </div>

            {/* exists / new-path badge row */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 11,
              }}
            >
              {t.exists ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    color: "var(--status-amber)",
                    background: "var(--amber-12)",
                    padding: "3px 9px",
                    borderRadius: 20,
                  }}
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: "var(--status-amber)",
                    }}
                  />
                  Already a target
                </span>
              ) : (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                    color: "var(--accent)",
                    background: "var(--accent-12)",
                    padding: "3px 9px",
                    borderRadius: 20,
                  }}
                >
                  <span
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: "50%",
                      background: "var(--accent)",
                    }}
                  />
                  Ready
                </span>
              )}
              <span style={{ fontSize: 11.5, color: "var(--text-faint-2)" }}>
                {t.exists
                  ? "another mapping already syncs into this folder"
                  : "the folder's contents sync into this folder — additive, never deletes"}
              </span>
            </div>
          </>
        ) : (
          /* no source selected hint */
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              color: "var(--text-muted)",
              fontSize: 12.5,
            }}
          >
            <Badge n={1} />
            Select a Drive folder above to pair it with a local destination.
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------------
          Staged pairs (only when there are entries)
          ---------------------------------------------------------------- */}
      {t.staged.length > 0 && (
        <div style={{ marginTop: 16 }}>
          {/* label */}
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--text-secondary)",
              marginBottom: 9,
            }}
          >
            Mappings to create ·{" "}
            <span
              style={{
                color: "var(--accent)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {t.staged.length}
            </span>
          </div>

          {/* staged rows */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {t.staged.map((g) => (
              <div
                key={g.key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "var(--bg-sidebar)",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 8,
                  padding: "11px 14px",
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 500,
                    color: "var(--text-primary)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {g.name}
                </span>
                <span style={{ color: "var(--text-faint)", flex: "none" }}>→</span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    color: "#8aa99a",
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {g.destPath}
                </span>
                <RemoveButton onRemove={g.remove} />
              </div>
            ))}
          </div>

          {/* footer buttons */}
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button
              onClick={t.saveStaged}
              style={{
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 600,
                color: "var(--accent-ink)",
                background: "var(--accent)",
                border: "none",
                borderRadius: 7,
                padding: "11px 20px",
                cursor: "pointer",
              }}
            >
              Save {t.staged.length} mapping{t.staged.length === 1 ? "" : "s"}
            </button>
            <button
              onClick={t.clearStaged}
              style={{
                fontFamily: "inherit",
                fontSize: 13,
                color: "var(--text-secondary)",
                background: "var(--bg-button-neutral)",
                border: "1px solid var(--border-button)",
                borderRadius: 7,
                padding: "11px 18px",
                cursor: "pointer",
              }}
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
   RemoveButton — isolated so the hover-color trick works without CSS modules
   -------------------------------------------------------------------------- */

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  return (
    <span
      onClick={onRemove}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLSpanElement).style.color = "var(--status-red)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLSpanElement).style.color = "var(--text-muted)";
      }}
      style={{
        flex: "none",
        color: "var(--text-muted)",
        cursor: "pointer",
        fontSize: 16,
        lineHeight: 1,
        padding: 2,
      }}
    >
      ×
    </span>
  );
}
