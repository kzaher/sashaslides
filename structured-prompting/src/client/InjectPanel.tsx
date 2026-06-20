/**
 * Restart a node with a new message — UNDER THE SAME SESSION (no fork).
 *
 * The no-fork counterpart of AskPanel. Where AskPanel spawns a side-branch
 * askFollowup node with `--fork-session` (leaving the original branch
 * clean), this panel POSTs `/api/inject {nodeId, message}`: the server
 * resumes THIS node's existing session WITHOUT --fork-session, appending
 * the message to the live conversation, and ERASES the completed state of
 * this node + every transitive successor (resetSubtree) so the node
 * re-runs and the graph continues downstream from the new value.
 *
 * Visually distinct (red/restart accent) from the fork "ask" box below it
 * so the destructive same-session semantics are obvious. Disabled until
 * the first send in this branch returns a sessionId.
 */
import { useState, useMemo } from "preact/hooks";
import type { GraphNode, GraphSnapshot } from "../api/wire.js";

export function InjectPanel(props: { node: GraphNode; graph: GraphSnapshot; onSelect: (id: string) => void }) {
  const { node, graph, onSelect } = props;
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Anchor = nearest ancestor (via parentId chain) carrying a sessionId —
  // the session the message resumes into. Same resolution as the server.
  const anchor = useMemo(() => {
    let cur: GraphNode | undefined = node;
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    while (cur && !cur.sessionId && cur.parentId) {
      cur = byId.get(cur.parentId);
    }
    return cur && cur.sessionId ? cur : null;
  }, [graph.version, node.id]);

  const submit = async () => {
    if (!message.trim() || busy) return;
    setBusy(true); setErr(null); setInfo(null);
    try {
      const r = await fetch("/api/inject", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: node.id, message }),
      });
      const json = await r.json();
      if (!r.ok || json.error) {
        setErr(json.error || ("HTTP " + r.status));
      } else if (json.isError) {
        setErr(json.errorMessage || "model returned isError");
      } else {
        setMessage("");
        const n = Array.isArray(json.resetNodeIds) ? json.resetNodeIds.length : 0;
        setInfo("restarted — erased " + n + " node" + (n === 1 ? "" : "s") + " (this + successors)");
        // Re-select this node so its refreshed reply renders in the panel.
        if (onSelect) onSelect(node.id);
      }
    } catch (e) {
      setErr(e && (e as Error).message ? (e as Error).message : String(e));
    } finally { setBusy(false); }
  };

  const canSend = !!anchor;
  const headerText = anchor
    ? "restart with message (SAME session " + anchor.sessionId!.slice(0, 8) + ", NO fork — erases this node + successors)"
    : "restart with message — disabled until first send completes";

  return (
    <div class="sect" style="border:1px solid #f8514955;border-radius:4px;padding:8px 10px;background:#f851490d">
      <h2 style="color:var(--err)">{headerText}</h2>
      <textarea
        class="inject-input"
        placeholder={canSend
          ? "type a message — it is appended to THIS node's live session (no fork). this node + every downstream node reset to pending and recompute. enter to restart, shift+enter for newline."
          : "no completed send in this branch yet — once one finishes, this becomes active"}
        rows={3}
        value={message}
        onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSend) void submit();
          }
        }}
        disabled={!canSend}
        style={"width:100%;background:var(--pending);color:var(--fg);border:1px solid #f8514955;border-radius:3px;padding:6px 8px;font:inherit;resize:vertical;opacity:" + (canSend ? "1" : "0.55")}
      />
      <div style="display:flex;gap:8px;margin-top:6px;align-items:center">
        <button
          onClick={() => void submit()}
          disabled={!canSend || busy || !message.trim()}
          title="Resume this node's session with the message (no --fork-session). Erases this node + all transitive successors so the graph recomputes downstream."
          style="border-color:#f8514955"
        >{busy ? "restarting…" : "↻ restart with message"}</button>
        {info && <span style="color:var(--ok);font-size:11px">{"✓ " + info}</span>}
      </div>
      {err && <pre style="color:var(--err);margin-top:6px;white-space:pre-wrap">{"error: " + err}</pre>}
    </div>
  );
}
