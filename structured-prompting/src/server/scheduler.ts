/**
 * Graph-driven scheduler — Phase 1 of the state-machine engine refactor.
 *
 * Premise: the description is fully expanded into graph nodes BEFORE
 * execution starts. Each node has `predecessors: PredecessorEdge[]`
 * describing which upstream nodes must reach which status before this
 * node fires. The scheduler is a plain loop:
 *
 *   while not done:
 *     ready  = nodes whose predecessors all match their required condition
 *     fire each ready node concurrently → kind handler → transition to ok/error
 *     repeat
 *
 * Differences from the legacy `runChain`/`runNode` interpreter:
 *   * No `Promise.all` aggregating a slice of children — every node is
 *     independent. One failure transitions ONE node; siblings continue.
 *   * No callbacks invoked at runtime. The graph is the program; the
 *     handler for each kind looks at `node.input` only.
 *   * No `RunCtx` threaded through the call stack. Effective context
 *     (model, sessionId, prepend, append) is derived from upstream
 *     nodes' outputs at fire-time.
 *
 * Phase 1 scope: scheduler skeleton + handlers for passthrough kinds.
 * Side-effect kinds (`send`, `executeShell`) are stubbed; the legacy
 * interpreter continues to handle real workloads until Phases 2-3 port
 * them. The new path is gated behind `ClaudeEngine.useScheduler` so
 * existing runs are unaffected.
 */
import type { GraphNode as WireGraphNode, NodeStatus, PredecessorEdge, ClaudeModel } from "../api/wire.js";
import type { ComputationGraph, RichGraphNode, SendNodeInput } from "./graph.js";
import { realIO, type IO } from "./io.js";
import { FatalShellError, StructuredError, InterruptException } from "./errors.js";
import { callClaude } from "./claude-cli.js";

/**
 * Per-kind handler. Receives the node + a handle to the graph so it
 * can mutate state (start, finishOk, finishErr, patchOutput for live
 * partials). Returns void after the node has reached a terminal state.
 *
 * Handlers MUST call exactly one of `graph.finishOk(id, output)` or
 * `graph.finishErr(id, err)` before returning. The scheduler relies on
 * that transition to mark the node done and re-evaluate readiness.
 */
export type KindHandler = (
  node: RichGraphNode,
  graph: ComputationGraph,
  ctx: SchedulerCtx,
) => Promise<void>;

/**
 * Derived context the scheduler computes for each node at fire-time
 * from its predecessor chain. Passes the equivalent of the legacy
 * RunCtx through to side-effect handlers (`send`, `executeShell`)
 * without threading it on the JS call stack.
 *
 * Phase 1: passthrough kinds populate these by reading their immediate
 * predecessor's `output.ctxPatch`. Phase 2 will refine this when the
 * side-effect handlers come online.
 */
export interface SchedulerCtx {
  /** claude session_id to resume; null = fresh session. */
  claudeSessionId: string | null;
  /** Active model selector. */
  model: string | null;
  /** Working directory passed to claude / shell. */
  cwd: string;
  /** Strings to prepend to the next send's prompt (FIFO). */
  prepend: readonly string[];
  /** Strings to append (FIFO). */
  append: readonly string[];
  /** Queued for next send: --fork-session flag. */
  pendingFork: boolean;
  /** Queued: /compact preamble. */
  pendingCompact: boolean;
}

const EMPTY_CTX: SchedulerCtx = Object.freeze({
  claudeSessionId: null,
  model: null,
  cwd: process.cwd(),
  prepend: [],
  append: [],
  pendingFork: false,
  pendingCompact: false,
});

/**
 * Edge readiness check: every predecessor must have reached its
 * required status. Missing predecessors entry (legacy nodes) defers
 * to `parentId` semantics — treated as "always ready" by the
 * scheduler since the legacy interpreter is what's driving them.
 */
function edgeReady(edge: PredecessorEdge, node: WireGraphNode): boolean {
  if (edge.condition === "any") return node.status === "ok" || node.status === "error";
  return node.status === edge.condition;
}

function isReady(node: WireGraphNode, byId: Map<string, WireGraphNode>): boolean {
  if (node.status !== "pending") return false;
  const preds = node.predecessors;
  if (!preds || preds.length === 0) return true;
  const mode = node.joinMode ?? "all";
  if (mode === "any") {
    // ANY: ready as soon as one edge's condition is met.
    for (const e of preds) {
      const p = byId.get(e.nodeId);
      if (p && edgeReady(e, p)) return true;
    }
    return false;
  }
  // ALL (default): every edge must be ready.
  for (const e of preds) {
    const p = byId.get(e.nodeId);
    if (!p || !edgeReady(e, p)) return false;
  }
  return true;
}

/**
 * Derive the effective scheduler ctx for a node from its predecessors'
 * `output.ctxPatch` (if any). Patches stack: a `prependToNextPrompt`
 * upstream emits `{ ctxPatch: { prependAdd: ["..."] } }`, a
 * `switchModel` emits `{ ctxPatch: { model: "opus" } }`, etc.
 *
 * Phase 1: only handles the additive patches needed for the passthrough
 * kinds. Side-effect handlers in Phase 2 will read this and consume the
 * queued state (e.g. send drains `prepend` after composing the prompt).
 */
function deriveCtx(node: WireGraphNode, byId: Map<string, WireGraphNode>): SchedulerCtx {
  // Walk back through ok-predecessors collecting ctx patches. Order matters
  // for prepend/append (FIFO), so we traverse predecessors in declared
  // order and apply patches left-to-right.
  let acc: SchedulerCtx = EMPTY_CTX;
  const preds = node.predecessors ?? [];
  for (const e of preds) {
    if (e.condition !== "ok") continue;
    const p = byId.get(e.nodeId);
    if (!p || p.status !== "ok") continue;
    const out = p.output as { ctxPatch?: Partial<SchedulerCtx> & { prependAdd?: string[]; appendAdd?: string[] } } | null;
    const patch = out?.ctxPatch;
    if (!patch) continue;
    acc = {
      claudeSessionId: patch.claudeSessionId !== undefined ? patch.claudeSessionId : acc.claudeSessionId,
      model: patch.model !== undefined ? patch.model : acc.model,
      cwd: patch.cwd !== undefined ? patch.cwd : acc.cwd,
      prepend: patch.prependAdd ? [...acc.prepend, ...patch.prependAdd] : acc.prepend,
      append: patch.appendAdd ? [...acc.append, ...patch.appendAdd] : acc.append,
      pendingFork: patch.pendingFork !== undefined ? patch.pendingFork : acc.pendingFork,
      pendingCompact: patch.pendingCompact !== undefined ? patch.pendingCompact : acc.pendingCompact,
    };
  }
  return acc;
}

/**
 * Run a fully-expanded graph to completion. Returns when no more nodes
 * can fire (either everything reached a terminal state, or the graph
 * deadlocked — typically an unreachable node whose predecessors all
 * errored without a fallback edge).
 *
 * Errors don't throw out of `runScheduler` — they're reflected on
 * individual nodes as `status: "error"`. The caller inspects the graph
 * to learn outcomes. This is intentional: one branch's failure must
 * not unwind sibling branches.
 */
export async function runScheduler(
  graph: ComputationGraph,
  registry: Map<string, KindHandler>,
  opts: { tickIntervalMs?: number } = {},
): Promise<void> {
  const tick = opts.tickIntervalMs ?? 25;
  // Track which nodes are currently being awaited so we don't double-fire.
  const inFlight = new Set<string>();

  while (true) {
    const all = graph.allNodes();
    const byId = new Map<string, WireGraphNode>(all.map(n => [n.id, n as WireGraphNode]));

    // Find ready nodes (pending + predecessors satisfied + not already firing).
    const ready: RichGraphNode[] = [];
    for (const n of all) {
      if (inFlight.has(n.id)) continue;
      if (isReady(n as WireGraphNode, byId)) ready.push(n);
    }

    if (ready.length === 0) {
      // No ready nodes. If any are still in-flight, wait. If none, done.
      if (inFlight.size === 0) return;
      await sleep(tick);
      continue;
    }

    // Fire each ready node concurrently. Each handler's lifecycle is
    // independent — no Promise.all aggregation across siblings.
    for (const node of ready) {
      inFlight.add(node.id);
      const handler = registry.get(node.kind);
      if (!handler) {
        graph.finishErr(node.id, new Error(`scheduler: no handler for kind "${node.kind}"`));
        inFlight.delete(node.id);
        continue;
      }
      const derivedCtx = deriveCtx(node as WireGraphNode, byId);
      // Fire in the background; do NOT await here so siblings start
      // concurrently. Cleanup runs on the handler's own resolution.
      void (async () => {
        try {
          await handler(node, graph, derivedCtx);
          // Handler is expected to call finishOk/finishErr. If it
          // didn't, force-fail so the scheduler can make progress.
          const final = graph.get(node.id);
          if (final && final.status === "running") {
            graph.finishErr(node.id, new Error(
              `scheduler: handler for kind "${node.kind}" returned without transitioning the node`,
            ));
          }
        } catch (err) {
          // Handler threw before transitioning. Mark error — sibling
          // branches continue independently.
          const cur = graph.get(node.id);
          if (cur && cur.status !== "ok" && cur.status !== "error") {
            graph.finishErr(node.id, err);
          }
        } finally {
          inFlight.delete(node.id);
        }
      })();
    }

    // Yield so the just-fired handlers get a chance to actually run
    // before we re-evaluate readiness.
    await sleep(tick);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Built-in handlers for passthrough kinds (Phase 1) ─────────────────────
//
// These kinds carry no side effects — they just emit a `ctxPatch` that
// the next node consumes via deriveCtx. They run instantly so they're
// safe to expand eagerly: at description-build time, a `.prependToNextPrompt("X")`
// adds one node, runs in <1 ms, transitions to ok with
// `output.ctxPatch.prependAdd = ["X"]`. The next node's deriveCtx
// picks it up automatically.

const passthroughHandlers: Array<[string, KindHandler]> = [
  ["root", async (node, graph) => {
    graph.start(node.id);
    graph.finishOk(node.id, { ok: true });
  }],
  ["prependToNextPrompt", async (node, graph) => {
    graph.start(node.id);
    const input = node.input as { text: string };
    graph.finishOk(node.id, { ctxPatch: { prependAdd: [input.text] } });
  }],
  ["appendToNextPrompt", async (node, graph) => {
    graph.start(node.id);
    const input = node.input as { text: string };
    graph.finishOk(node.id, { ctxPatch: { appendAdd: [input.text] } });
  }],
  ["switchModel", async (node, graph) => {
    graph.start(node.id);
    const input = node.input as { model: string };
    graph.finishOk(node.id, { ctxPatch: { model: input.model } }, { model: input.model });
  }],
  ["newSession", async (node, graph) => {
    graph.start(node.id);
    const input = node.input as { model: string };
    graph.finishOk(node.id, {
      ctxPatch: {
        model: input.model,
        claudeSessionId: null,
        prependAdd: [],
        appendAdd: [],
        pendingFork: false,
        pendingCompact: false,
      },
    }, { model: input.model });
  }],
  ["fork", async (node, graph) => {
    graph.start(node.id);
    graph.finishOk(node.id, { ctxPatch: { pendingFork: true } });
  }],
  ["compact", async (node, graph) => {
    graph.start(node.id);
    graph.finishOk(node.id, { ctxPatch: { pendingCompact: true } });
  }],
  ["materializeError", async (node, graph) => {
    graph.start(node.id);
    const input = node.input as { error: string };
    // Materialize a Result<T> = { error: string } as the node's value.
    graph.finishOk(node.id, { value: { error: input.error } });
  }],
];

// ── Side-effect handler: executeShell (Phase 2) ───────────────────────────
//
// Reads the saved `{cmd, cwd}` from `node.input` (populated either by the
// description-builder or by the legacy engine's `executeShell` case
// when it set `graph.start(id, { input: { cmd, cwd } })`). Spawns the
// shell via `bash -c <cmd>`, streams stdout/stderr to the node's
// `output` in real time via `graph.patchOutput`, then transitions to ok
// (with `{stdout, stdoutTail, exitCode}`) or error (with FatalShellError).
//
// "Streaming" here means: each OS-level chunk delivered by the kernel's
// read() on the child's pipes triggers a `patchOutput` call that bumps
// the graph version. The monitor UI's 250 ms poll surfaces the growing
// `stdoutSoFar` / `stderrSoFar` strings before the child exits.
//
// FatalShellError matches the existing semantics: non-zero exit is NOT
// catchable by tryMultipleTimes (programmer-bug protection); the user
// retries via the monitor's RetryPanel after fixing the underlying
// cause.
function makeExecuteShellHandler(io: IO = realIO): KindHandler {
  return async (node, graph) => {
    const input = (node.input ?? {}) as { cmd?: string; cwd?: string; timeoutMs?: number };
    if (!input.cmd) {
      graph.finishErr(node.id, new Error("executeShell: node.input.cmd is missing"));
      return;
    }
    const cwd = input.cwd ?? process.cwd();
    graph.start(node.id);
    // Initialize the streaming fields so the UI's first poll after start
    // sees the empty strings (rather than `undefined`), giving the live-
    // output panel something to render even before any chunks arrive.
    graph.patchOutput(node.id, { cmd: input.cmd, cwd, stdoutSoFar: "", stderrSoFar: "" });
    let stdoutSoFar = "";
    let stderrSoFar = "";
    const r = await io.spawnCapture({
      command: "bash",
      args: ["-c", input.cmd],
      cwd,
      timeoutMs: input.timeoutMs,
      nodeId: node.id,
      onStdout: (chunk) => {
        stdoutSoFar += chunk;
        graph.patchOutput(node.id, { stdoutSoFar });
      },
      onStderr: (chunk) => {
        stderrSoFar += chunk;
        graph.patchOutput(node.id, { stderrSoFar });
      },
    });
    if (r.spawnError) {
      graph.finishErr(node.id, new Error(`executeShell: bash spawn failed: ${r.spawnError}`));
      return;
    }
    if (r.exitCode !== 0) {
      const stderrTail = r.stderr.slice(-800);
      const stdoutTail = r.stdout.slice(-800);
      graph.finishErr(node.id, new FatalShellError(
        `executeShell: command failed (code ${r.exitCode}): ${input.cmd}\n` +
        (stderrTail ? `--- stderr (last 800) ---\n${stderrTail}\n` : "") +
        (stdoutTail ? `--- stdout (last 800) ---\n${stdoutTail}` : ""),
        {
          nodeId: node.id,
          data: { kind: "shellExit", exitCode: r.exitCode, cmd: input.cmd, stderrTail, stdoutTail },
        },
      ));
      return;
    }
    // Success: finalize with the full captured output + tail (legacy
    // `runShell` returned `stdoutTail` on its ok output; preserve that
    // shape so downstream consumers that read it still work).
    graph.finishOk(node.id, {
      cmd: input.cmd,
      cwd,
      stdout: r.stdout,
      stdoutTail: r.stdout.slice(-400),
      stderr: r.stderr,
      stdoutSoFar: r.stdout,
      stderrSoFar: r.stderr,
      exitCode: r.exitCode,
    });
  };
}

// ── Side-effect handler: send (Phase 3) ───────────────────────────────────
//
// Composes the prompt by draining `ctx.prepend` + `node.input.prompt` +
// `ctx.append`, fires `callClaude` with `onPartialText` set so each
// assistant chunk streams into `node.output.partialText` via
// `graph.patchOutput`. On exit, transitions to ok with the canonical
// `{text, composedPrompt, durationMs, usage, sessionId}` shape (same as
// the legacy engine's `runNode` case "send"), or error on a StructuredError
// / InterruptException.
//
// Differences from the legacy interpreter:
//   * No `materializeAndCall` ctx-mutating dance — ctx flows in via
//     `deriveCtx` (already computed by the scheduler from upstream
//     predecessors' ctxPatch outputs), and the send's own ctxPatch (set
//     `claudeSessionId` to the response's session_id) is emitted on
//     output for downstream nodes to consume.
//   * No tryMultipleTimes integration here — the scheduler's retry-on-
//     error semantics live at the EDGE level (a `try` node has an
//     "error" predecessor edge to its fallback chain). The send handler
//     just runs once and reports.
function makeSendHandler(io: IO = realIO): KindHandler {
  return async (node, graph, ctx) => {
    const input = (node.input ?? {}) as SendNodeInput;
    if (input.prompt == null) {
      graph.finishErr(node.id, new Error("send: node.input.prompt is missing"));
      return;
    }
    const rawPrompt = typeof input.prompt === "string" ? input.prompt : "";
    if (rawPrompt === "" && typeof input.prompt !== "string") {
      // PromptInput<unknown> = string | ((upstream) => string). The
      // function form was the legacy interpreter's lazy-resolution path
      // that ran the callback against runtime `upstream`. In the
      // state-machine model that callback is invoked at description-
      // build time and its string result becomes node.input.prompt.
      // Anything that lands here as a function is a description-builder
      // bug.
      graph.finishErr(node.id, new Error(
        "send: node.input.prompt is a function — should have been resolved at description-build time",
      ));
      return;
    }
    // Compose: ctx.prepend + raw + ctx.append. Same shape as the legacy
    // `materializeAndCall` path so the model sees identical inputs.
    const composedPrompt = [
      ...ctx.prepend,
      rawPrompt,
      ...ctx.append,
    ].filter(s => s && s.length > 0).join("\n\n");
    graph.start(node.id, { model: ctx.model });
    // Initialize partialText so the UI sees an empty string immediately
    // (which it can render as "model thinking…" before any tokens land).
    graph.patchOutput(node.id, { composedPrompt, partialText: "" });
    try {
      const r = await callClaude({
        prompt: composedPrompt,
        resume: ctx.claudeSessionId ?? null,
        fork: ctx.pendingFork,
        model: ctx.model as ClaudeModel | undefined,
        cwd: ctx.cwd,
        timeoutMs: input.timeout,
        attachments: input.base64_attachments,
        nodeId: node.id,
        io,
        onPartialText: (textSoFar) => {
          graph.patchOutput(node.id, { partialText: textSoFar });
        },
        onPartialUsage: (usage) => {
          graph.patchOutput(node.id, { partialUsage: usage });
        },
      });
      if (r.isError) {
        graph.finishErr(node.id, new StructuredError(
          r.errorMessage ?? "send failed",
          { sessionId: r.sessionId, nodeId: node.id, data: { raw: r.raw, stderr: r.stderr } },
        ));
        return;
      }
      graph.finishOk(node.id, {
        text: r.text,
        composedPrompt,
        durationMs: r.durationMs,
        usage: r.usage,
        // ctxPatch: downstream sends inherit this send's session by
        // default (resume=sessionId, pendingFork=false). Equivalent to
        // the legacy engine's "session continuation" behavior.
        ctxPatch: {
          claudeSessionId: r.sessionId,
          prependAdd: [],
          appendAdd: [],
          pendingFork: false,
          pendingCompact: false,
        },
      }, { sessionId: r.sessionId, model: r.model ?? ctx.model });
    } catch (err) {
      graph.finishErr(node.id, err);
    }
  };
}

/**
 * Default kind-handler registry covering the passthrough kinds,
 * `executeShell` (Phase 2), and `send` (Phase 3). The optional `io`
 * parameter lets tests inject a MockIO; default is realIO.
 */
export function defaultKindRegistry(io: IO = realIO): Map<string, KindHandler> {
  const r = new Map<string, KindHandler>();
  for (const [k, h] of passthroughHandlers) r.set(k, h);
  r.set("executeShell", makeExecuteShellHandler(io));
  r.set("send", makeSendHandler(io));
  return r;
}
