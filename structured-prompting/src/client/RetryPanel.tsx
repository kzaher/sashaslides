/**
 * Re-run a node in place. POSTs `/api/retry {nodeId}`.
 *
 * Supported kinds:
 *   executeShell      — re-runs `cmd` in the saved `cwd`. Replaces output.
 *   send / askFollowup — re-calls claude with `composedPrompt` + same
 *                       resume sessionId, fork:true. Replaces output.
 *
 * Other kinds: panel renders an explanation that retry isn't available
 * (the engine's callbacks were stripped from the persisted graph
 * snapshot, so we can't re-invoke parallelFork / pipe / try / etc.).
 */
import { useState } from "preact/hooks";
import type { GraphNode } from "../api/wire.js";

export function RetryPanel(props: { node: GraphNode }) {
  const { node } = props;
  const retryable = node.kind === "executeShell" || node.kind === "send" || node.kind === "askFollowup";
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true); setResult(null); setErr(null);
    try {
      const r = await fetch("/api/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: node.id }),
      });
      const json = await r.json();
      if (!r.ok || json.error) setErr(json.error || ("HTTP " + r.status));
      else if (json.status === "error") setErr(json.message);
      else setResult(json.message);
    } catch (e) {
      setErr(e && (e as Error).message ? (e as Error).message : String(e));
    } finally { setBusy(false); }
  };

  if (!retryable) {
    return (
      <div class="sect">
        <h2>retry</h2>
        <div style="color:var(--muted);font-size:11px">
          {`kind "${node.kind}" is not retryable — only executeShell, send, and askFollowup nodes can be re-run from the UI (other kinds carry callbacks that were stripped from the persisted graph snapshot).`}
        </div>
      </div>
    );
  }

  return (
    <div class="sect">
      <h2>{"retry — " + node.kind}</h2>
      <div style="display:flex;gap:8px;align-items:center">
        <button
          onClick={() => void submit()}
          disabled={busy}
          title={node.kind === "executeShell"
            ? "Re-run the saved cmd in the saved cwd. Output replaces in place."
            : "Re-call claude with the same composedPrompt + same resume sessionId, fork:true. Output replaces in place."}
        >{busy ? "retrying…" : "↻ retry this node"}</button>
        {result && <span style="color:var(--ok);font-size:11px">{"✓ " + result}</span>}
      </div>
      {err && <pre style="color:var(--err);margin-top:6px;white-space:pre-wrap">{"error: " + err}</pre>}
    </div>
  );
}
