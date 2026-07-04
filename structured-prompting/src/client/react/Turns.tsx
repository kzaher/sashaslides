/** @jsxImportSource react */
/**
 * React presentational components for a transcript turn: thinking (collapsible),
 * tool_use cards, tool_result boxes, inline images, and the turn wrapper
 * (user bubble vs assistant full-width). Styled like the Claude web UI, dark
 * theme matching the monitor.
 */
import { useState } from "react";
import type { TranscriptTurn, TranscriptBlock } from "../../api/wire.js";
import { Markdown } from "./Markdown.js";

export const MAX_W = 760;

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin: "6px 0" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ background: "transparent", border: "none", color: "#8b949e", font: "inherit", fontSize: 12, cursor: "pointer", padding: 0, display: "flex", alignItems: "center", gap: 4 }}
      >
        <span>{open ? "▾" : "▸"}</span><span style={{ fontStyle: "italic" }}>thinking</span>
      </button>
      {open && (
        <div style={{ marginTop: 4, padding: "8px 10px", background: "#0b1220", borderLeft: "2px solid #30363d", borderRadius: 4, color: "#8b949e", fontSize: 12, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
          {text}
        </div>
      )}
    </div>
  );
}

function ToolUseCard({ name, input }: { name: string; input: unknown }) {
  const [open, setOpen] = useState(false);
  let pretty = "";
  try { pretty = JSON.stringify(input, null, 2); } catch { pretty = String(input); }
  return (
    <div style={{ margin: "6px 0", border: "1px solid #30363d", borderRadius: 6, background: "#0d1117", overflow: "hidden" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{ width: "100%", textAlign: "left", background: "#161b22", border: "none", color: "#c9d1d9", font: "inherit", fontSize: 12, cursor: "pointer", padding: "5px 10px", display: "flex", alignItems: "center", gap: 6 }}
      >
        <span style={{ color: "#58a6ff" }}>{open ? "▾" : "▸"}</span>
        <span>🔧 <b style={{ fontWeight: 600 }}>{name}</b></span>
      </button>
      {open && (
        <pre style={{ margin: 0, padding: "8px 10px", fontSize: 11, lineHeight: 1.45, whiteSpace: "pre-wrap", overflow: "auto", maxHeight: "40vh", color: "#a5d6ff", fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" }}>{pretty}</pre>
      )}
    </div>
  );
}

function ToolResultBlock({ block }: { block: TranscriptBlock }) {
  const [open, setOpen] = useState(false);
  if (block.dataUrl) {
    return <img src={block.dataUrl} style={{ maxWidth: "100%", borderRadius: 6, margin: "6px 0", border: "1px solid #30363d" }} />;
  }
  const text = block.resultText ?? "";
  const truncated = text.length > 600;
  const preview = truncated && !open ? text.slice(0, 600) + "…" : text;
  return (
    <div style={{ margin: "6px 0", padding: "6px 10px", background: "#0b1220", borderLeft: `2px solid ${block.isError ? "#f85149" : "#30363d"}`, borderRadius: 4 }}>
      <div style={{ fontSize: 10, color: "#6e7681", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 2 }}>{block.isError ? "tool error" : "tool result"}</div>
      <pre style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word", overflowWrap: "anywhere", color: block.isError ? "#ffb3b3" : "#8b949e", fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace" }}>{preview || "(empty)"}</pre>
      {truncated && (
        <button onClick={() => setOpen(!open)} style={{ background: "transparent", border: "none", color: "#58a6ff", font: "inherit", fontSize: 11, cursor: "pointer", padding: "2px 0 0" }}>{open ? "show less" : "show more"}</button>
      )}
    </div>
  );
}

function BlockView({ block }: { block: TranscriptBlock }) {
  switch (block.type) {
    case "text":
      return <Markdown src={block.text ?? ""} />;
    case "thinking":
      return <ThinkingBlock text={block.text ?? ""} />;
    case "tool_use":
      return <ToolUseCard name={block.name ?? "tool"} input={block.input} />;
    case "tool_result":
      return <ToolResultBlock block={block} />;
    case "image":
      return block.dataUrl
        ? <img src={block.dataUrl} style={{ maxWidth: "100%", borderRadius: 6, margin: "6px 0", border: "1px solid #30363d" }} />
        : <div style={{ color: "#8b949e", fontStyle: "italic", fontSize: 12 }}>{block.text ?? "(image)"}</div>;
    case "document":
      return <div style={{ color: "#8b949e", fontStyle: "italic", fontSize: 12, margin: "6px 0" }}>📎 {block.text ?? "(document)"}</div>;
    default:
      return <div style={{ color: "#6e7681", fontSize: 11 }}>(unrenderable block)</div>;
  }
}

/**
 * One chat turn. User turns are a right-aligned bubble; assistant turns are
 * full-width with an avatar. When `marked`, the turn gets a highlight ring +
 * a "◆ this step" badge (click-to-mark-and-focus).
 */
export function TurnView(
  { turn, marked, innerRef, noRing }: {
    turn: TranscriptTurn;
    marked?: boolean;
    innerRef?: (el: HTMLDivElement | null) => void;
    /** When the enclosing section already draws the orange outline + mark (the
     *  sent-message block), suppress this turn's own ring so there aren't two
     *  nested orange borders. The scroll ref still attaches. */
    noRing?: boolean;
  },
) {
  const isUser = turn.role === "user";
  const onlyToolResults = isUser && turn.blocks.every((b) => b.type === "tool_result");

  const showMark = marked && !noRing;
  const ring: React.CSSProperties = showMark
    ? { boxShadow: "0 0 0 2px #d97757, 0 0 12px 2px rgba(217,119,87,0.35)", borderRadius: 12, background: "rgba(217,119,87,0.06)" }
    : {};

  const badge = showMark ? (
    <div style={{ maxWidth: MAX_W, margin: "0 auto", width: "100%", padding: "0 2px" }}>
      <span style={{ display: "inline-block", background: "#d97757", color: "#fff", fontSize: 10, fontWeight: 600, borderRadius: 4, padding: "1px 7px", letterSpacing: "0.04em" }}>◆ this step</span>
    </div>
  ) : null;

  if (isUser && !onlyToolResults) {
    return (
      <div ref={innerRef}>
        {badge}
        <div style={{ display: "flex", justifyContent: "flex-end", margin: "8px auto 14px", maxWidth: MAX_W, width: "100%", ...ring, padding: showMark ? "8px" : 0 }}>
          <div style={{ maxWidth: "85%", background: "#1f6feb22", border: "1px solid #1f6feb55", borderRadius: "12px 12px 4px 12px", padding: "8px 12px", color: "#e6edf3" }}>
            {turn.blocks.map((b, i) => <BlockView key={i} block={b} />)}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div ref={innerRef}>
      {badge}
      <div style={{ display: "flex", gap: 10, margin: "8px auto 14px", maxWidth: MAX_W, width: "100%", ...ring, padding: showMark ? "8px" : 0 }}>
        <div style={{ flexShrink: 0, width: 26, height: 26, borderRadius: 6, background: "#d97757", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#fff", fontWeight: 600 }} title={onlyToolResults ? "tool output" : "Claude"}>
          {onlyToolResults ? "⚙" : "✳"}
        </div>
        <div style={{ flex: 1, minWidth: 0, color: "#e6edf3" }}>
          {turn.blocks.map((b, i) => <BlockView key={i} block={b} />)}
        </div>
      </div>
    </div>
  );
}
