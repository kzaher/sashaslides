/**
 * Diff.tsx — VS-Code-like unified diff view for a node's captured working-tree
 * diff. Two tabs: "This step" (the node's delta) and "Full diff" (cumulative
 * change since the task started). Hand-rolled line coloring — no diff-library
 * dependency, so it bundles cleanly into the Preact monitor.
 */
import { useState } from "preact/hooks";
import type { NodeDiff } from "../api/wire.js";

type Tab = "delta" | "cumulative";

/** Per-line color, modelled on a GitHub/VS-Code dark diff. File + hunk headers
 *  are matched BEFORE +/- so `+++`/`---` don't read as add/remove lines. */
function lineStyle(line: string): Record<string, string> {
  if (
    line.startsWith("diff --git") || line.startsWith("index ") ||
    line.startsWith("--- ") || line.startsWith("+++ ") ||
    line.startsWith("new file") || line.startsWith("deleted file") ||
    line.startsWith("rename ") || line.startsWith("similarity ") ||
    line.startsWith("old mode") || line.startsWith("new mode")
  ) {
    return { color: "#8b949e", fontWeight: "600" };
  }
  if (line.startsWith("@@")) return { color: "#58a6ff", background: "rgba(56,139,253,0.10)" };
  if (line.startsWith("+")) return { color: "#3fb950", background: "rgba(46,160,67,0.15)" };
  if (line.startsWith("-")) return { color: "#f85149", background: "rgba(248,81,73,0.15)" };
  return { color: "#c9d1d9" };
}

export function Diff(props: { diff: NodeDiff }) {
  const { diff } = props;
  const [tab, setTab] = useState<Tab>("delta");
  const body = tab === "delta" ? diff.delta : diff.cumulative;
  const lines = body.split("\n");

  const tabBtn = (id: Tab, label: string) => (
    <button
      onClick={() => setTab(id)}
      style={{
        padding: "2px 10px", marginRight: "6px", cursor: "pointer",
        border: "1px solid #30363d", borderRadius: "4px",
        background: tab === id ? "#1f6feb" : "transparent",
        color: tab === id ? "#fff" : "#c9d1d9", fontSize: "12px",
      }}
    >{label}</button>
  );

  return (
    <div class="sect">
      <h2>diff</h2>
      <div style={{ marginBottom: "6px", display: "flex", alignItems: "center", flexWrap: "wrap" }}>
        {tabBtn("delta", "This step")}
        {tabBtn("cumulative", "Full diff")}
        {diff.stat && (
          <span style={{ color: "#8b949e", fontSize: "12px", marginLeft: "8px" }}>{diff.stat}</span>
        )}
      </div>
      {diff.truncated && (
        <div style={{ color: "#d29922", fontSize: "12px", marginBottom: "4px" }}>
          diff truncated for size
        </div>
      )}
      <pre style={{
        margin: "0", overflow: "auto", fontSize: "12px", lineHeight: "1.45",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        background: "#0d1117", border: "1px solid #30363d", borderRadius: "6px",
        padding: "8px", maxHeight: "60vh",
      }}>
        {lines.map((line, i) => (
          <div key={i} style={{ ...lineStyle(line), whiteSpace: "pre", padding: "0 4px" }}>
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}
