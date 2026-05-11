/**
 * Live-streaming output block. Surfaces three fields that side-effect
 * handlers write incrementally via `graph.patchOutput()` while a node is
 * still `running`:
 *
 *   send / askFollowup → `node.output.partialText` (model tokens as they
 *                         arrive from `claude --output-format stream-json`)
 *   executeShell       → `node.output.stdoutSoFar` + `node.output.stderrSoFar`
 *                         (each stdout/stderr chunk the spawned process
 *                         emits, before exit)
 *
 * Surfaced as a tall scrolling block at the TOP of the detail panel so
 * the reviewer doesn't have to expand the `output` JSON to watch
 * progress. Sticks around after the node finishes (so finished output
 * stays visible) — no special "running" gate.
 */
import type { GraphNode } from "../api/wire.js";

export function LiveOutput(props: { node: GraphNode }) {
  const { node } = props;
  const out = node.output as { partialText?: unknown; stdoutSoFar?: unknown; stderrSoFar?: unknown } | null;
  const partialText = typeof out?.partialText === "string" ? out.partialText : null;
  const stdoutSoFar = typeof out?.stdoutSoFar === "string" ? out.stdoutSoFar : null;
  const stderrSoFar = typeof out?.stderrSoFar === "string" ? out.stderrSoFar : null;
  if (partialText == null && stdoutSoFar == null && stderrSoFar == null) return null;
  const isRunning = node.status === "running";
  return (
    <div class="sect">
      <h2>
        live output {isRunning ? <span style="color:var(--run);font-size:11px;margin-left:6px">● streaming</span> : <span style="color:var(--muted);font-size:11px;margin-left:6px">(final)</span>}
      </h2>
      {partialText != null && (
        <pre style="background:#0b1220;border-left:2px solid #1f6feb;max-height:50vh">{partialText || <span style="color:var(--muted)">waiting for first token…</span>}</pre>
      )}
      {stdoutSoFar != null && (
        <div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px">stdout</div>
          <pre style="background:#0b1220;border-left:2px solid var(--ok);max-height:30vh">{stdoutSoFar || <span style="color:var(--muted)">(no stdout yet)</span>}</pre>
        </div>
      )}
      {stderrSoFar != null && stderrSoFar.length > 0 && (
        <div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px">stderr</div>
          <pre style="background:#1a0b0b;border-left:2px solid var(--err);max-height:30vh;color:#ffb3b3">{stderrSoFar}</pre>
        </div>
      )}
    </div>
  );
}
