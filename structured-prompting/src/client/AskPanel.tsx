/**
 * Free-form follow-up prompt against a node's claude session.
 *
 * Walks the parentId chain from the clicked node to find the nearest
 * ancestor carrying a sessionId — that's the resume anchor. POSTs
 * `/api/ask {nodeId, prompt}`; the server creates a real askFollowup
 * graph node nested under the CLICKED node and runs `claude --resume
 * <anchor.sessionId> --fork-session -p <prompt>`. On success the new
 * node is auto-selected so its reply renders in the standard detail
 * panel.
 *
 * Disabled until the first send in this branch returns a sessionId.
 */
import { useState, useMemo } from "preact/hooks";
import type { GraphNode, GraphSnapshot } from "../api/wire.js";

export function AskPanel(props: { node: GraphNode; graph: GraphSnapshot; onSelect: (id: string) => void }) {
  const { node, graph, onSelect } = props;
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Anchor = nearest ancestor (via parentId chain) carrying a sessionId.
  // This is the node we'll fork from. The clicked node parents the new
  // followup in the tree regardless — anchor only controls --resume.
  const anchor = useMemo(() => {
    let cur: GraphNode | undefined = node;
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    while (cur && !cur.sessionId && cur.parentId) {
      cur = byId.get(cur.parentId);
    }
    return cur && cur.sessionId ? cur : null;
  }, [graph.version, node.id]);

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: node.id, prompt }),
      });
      const json = await r.json();
      if (!r.ok || json.error) {
        setErr(json.error || ("HTTP " + r.status));
      } else if (json.isError) {
        // The askFollowup node was created and finalized as error; jump
        // to it so the reviewer sees the failure inline with the rest of
        // the tree.
        if (json.newNodeId && onSelect) onSelect(json.newNodeId);
        setErr(json.errorMessage || "model returned isError");
      } else {
        // Success: clear the textarea and select the new node so its
        // reply renders in the standard detail panel (same shape as a
        // send).
        setPrompt("");
        if (json.newNodeId && onSelect) onSelect(json.newNodeId);
      }
    } catch (e) {
      setErr(e && (e as Error).message ? (e as Error).message : String(e));
    } finally { setBusy(false); }
  };

  // Right-click "Rerun this prompt" prefills with the original composed prompt.
  const composedRaw = (node.output as { composedPrompt?: unknown } | null)?.composedPrompt;
  const composed = typeof composedRaw === "string" ? composedRaw : null;

  // Header copy: explains what's happening — the new followup nests
  // under the clicked node, but resumes from the nearest ancestor that
  // has a claude session. When no ancestor has a session yet (very
  // early in the run), the panel renders disabled with a hint.
  const headerText = anchor
    ? (anchor.id === node.id
        ? "ask follow-up (forks session " + anchor.sessionId!.slice(0, 8) + " from this node)"
        : "ask follow-up (forks session " + anchor.sessionId!.slice(0, 8) + " from ancestor " + anchor.kind + ")")
    : "ask follow-up — disabled until first send completes";
  const canSend = !!anchor;

  return (
    <div class="sect">
      <h2>{headerText}</h2>
      <textarea
        class="ask-input"
        placeholder={canSend
          ? "type a question — the model has the same conversation context as the anchor send. enter to send, shift+enter for newline."
          : "no completed send in this branch yet — once one finishes, this textarea becomes active"}
        rows={3}
        value={prompt}
        onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          // Plain Enter sends; Shift+Enter inserts a newline (standard
          // chat UX). Ctrl/⌘+Enter kept as an alias for muscle memory.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSend) void submit();
          }
        }}
        disabled={!canSend}
        style={"width:100%;background:var(--pending);color:var(--fg);border:1px solid #30363d;border-radius:3px;padding:6px 8px;font:inherit;resize:vertical;opacity:" + (canSend ? "1" : "0.55")}
      />
      <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
        <button onClick={() => void submit()} disabled={!canSend || busy || !prompt.trim()}>
          {busy ? "asking…" : "send (enter)"}
        </button>
        {composed && (
          <button
            onClick={() => setPrompt(composed)}
            title="Prefill the textarea with the prompt this node originally sent — useful for retrying with the same input."
          >↺ rerun this prompt</button>
        )}
        {busy && <span style="color:var(--muted);font-size:11px">creating askFollowup node… reply lands as a new tree child</span>}
      </div>
      {err && <pre style="color:var(--err);margin-top:6px;white-space:pre-wrap">{"error: " + err}</pre>}
    </div>
  );
}
