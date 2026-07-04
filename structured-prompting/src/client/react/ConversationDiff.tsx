/** @jsxImportSource react */
/**
 * React port of the inter-message file-diff block. Collapsible; labelled
 * "N files changed between messages"; mirrors Diff.tsx's line coloring.
 * Extraction logic is shared via ./file-changes.ts.
 */
import { useState } from "react";
import type { FileChange } from "./file-changes.js";

/** Same palette as Diff.tsx, as React style objects. */
function lineStyle(line: string): React.CSSProperties {
  if (line.startsWith("diff ") || line.startsWith("@@") || line.startsWith("--- ") || line.startsWith("+++ ")) {
    if (line.startsWith("@@")) return { color: "#58a6ff", background: "rgba(56,139,253,0.10)" };
    return { color: "#8b949e", fontWeight: 600 };
  }
  if (line.startsWith("+")) return { color: "#3fb950", background: "rgba(46,160,67,0.15)" };
  if (line.startsWith("-")) return { color: "#f85149", background: "rgba(248,81,73,0.15)" };
  return { color: "#c9d1d9" };
}

export function ConversationDiff({ changes }: { changes: FileChange[] }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  if (changes.length === 0) return null;
  const label = `${changes.length} file${changes.length === 1 ? "" : "s"} changed between messages`;
  return (
    <div style={{ margin: "6px auto", maxWidth: 760, width: "100%" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          background: "#161b22", border: "1px solid #30363d", borderRadius: 6,
          color: "#8b949e", font: "inherit", fontSize: 11, padding: "4px 10px",
          cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
        }}
      >
        <span style={{ color: "#58a6ff" }}>{open ? "▾" : "▸"}</span>
        <span>📝 {label}</span>
      </button>
      {open && (
        <div style={{ marginTop: 4 }}>
          {changes.map((c, ci) => (
            <div key={ci} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: "#8b949e", fontFamily: "ui-monospace,monospace", margin: "0 0 2px 2px" }}>{c.file}</div>
              <pre style={{
                margin: 0, overflow: "auto", fontSize: 12, lineHeight: 1.45,
                fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
                background: "#0d1117", border: "1px solid #30363d", borderRadius: 6,
                padding: 8, maxHeight: "40vh",
              }}>
                {c.lines.map((line, i) => (
                  <div key={i} style={{ ...lineStyle(line), whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "break-word", padding: "0 4px" }}>
                    {line || " "}
                  </div>
                ))}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
