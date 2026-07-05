/**
 * Graph-driven scheduler — the state-machine engine.
 *
 * Premise: the description is expanded into graph nodes. Each node has
 * `predecessors: PredecessorEdge[]` describing which upstream nodes must
 * reach which status before this node fires. The scheduler is a plain
 * loop:
 *
 *   while not done:
 *     ready  = nodes whose predecessors all match their required condition
 *     fire each ready node concurrently → kind handler → transition to ok/error
 *     repeat
 *
 * Differences from the legacy `runChain`/`runNode` interpreter:
 *   * No `Promise.all` aggregating a slice of children — every node is
 *     independent. One failure transitions ONE node; siblings continue.
 *   * No `RunCtx` threaded through the call stack. Effective context
 *     (model, sessionId, prepend, append) is derived from upstream
 *     nodes' outputs at fire-time.
 *
 * RESTART-FROM-ANY-NODE: because readiness is computed purely from node
 * `status` + predecessor edges, resetting a node + its successors to
 * `pending` (via `graph.resetSubtree`) makes them re-satisfy the "ready"
 * predicate on the next loop iteration — so the scheduler RE-FIRES that
 * node and everything downstream, with fresh output, while untouched
 * upstream/sibling nodes keep their existing `ok` state. `runScheduler`
 * polls until no node is pending/running, so a reset performed WHILE it's
 * running is picked up; a reset performed AFTER it returns is picked up by
 * calling `runScheduler` again on the same graph (same `values` map).
 *
 * Container kinds (`pipe`, `combineWith`, `parallelFork`,
 * `tryMultipleTimes`, `try`) expand their bodies lazily via the stored
 * callbacks (user code inside the callback may read files produced by
 * upstream nodes that don't exist at description-build time), then drive
 * the freshly-built sub-chain with a recursive scheduler pass over the
 * same graph. The whole new path is gated behind
 * `ClaudeEngine.useScheduler` so existing runs are unaffected.
 */
import type { GraphNode as WireGraphNode, PredecessorEdge, ClaudeModel } from "../api/wire.js";
import {
  ComputationGraph,
  type RichGraphNode,
  type SendNodeInput,
} from "./graph.js";
import { Session, SessionWithResult } from "./session.js";
import { realIO, type IO } from "./io.js";
import { FatalShellError, StructuredError, InterruptException, describeError } from "./errors.js";
import { claudeDriver } from "./claude-cli.js";
import type { ModelDriver } from "./model-driver.js";

/**
 * Per-kind handler. Receives the node, the graph (so it can mutate state
 * via start/finishOk/finishErr/patchOutput), and the derived scheduler
 * ctx (effective model/session/cwd/prepend + the upstream value + a
 * `driveSub` hook for container bodies).
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
 * Derived context the scheduler computes for each node at fire-time from
 * its predecessor chain.
 */
export interface SchedulerCtx {
  /** claude session_id to resume; null = fresh session. */
  claudeSessionId: string | null;
  /** Active model selector. */
  model: string | null;
  /** Working directory passed to claude / shell. */
  cwd: string;
  /** Opt-in overlay branch id (set by switchBranch); null = no branch. When
   *  set, send/executeShell run inside the branch's overlayfs mount. */
  branchId: string | null;
  /** Strings to prepend to the next send's prompt (FIFO). */
  prepend: readonly string[];
  /** Strings to append (FIFO). */
  append: readonly string[];
  /** Queued for next send: --fork-session flag. */
  pendingFork: boolean;
  /** Queued: /compact preamble. */
  pendingCompact: boolean;
  /**
   * The resolved value produced by this node's ok-predecessor (the
   * "upstream" value the legacy interpreter threaded on the call stack).
   * `send` evaluates its function-prompt against it; `executeShell` /
   * `assert` / container callbacks consume it.
   */
  upstream: unknown;
  /**
   * Record the value this node produced. The scheduler keeps a value map
   * so downstream nodes can read their upstream. Container handlers call
   * this too, after their sub-chain resolves.
   */
  setValue: (nodeId: string, value: unknown) => void;
  /**
   * Drive a freshly-built sub-chain (fromId..tip) to completion under the
   * scheduler, returning the tip's resolved value. Used by container
   * handlers (pipe/combineWith/parallelFork/tryMultipleTimes) which build
   * their body via the stored callback then need to run it. Throws if any
   * node in the sub-chain ends in `error` (so try/tryMultipleTimes can
   * catch and fall back).
   */
  driveSub: (params: {
    fromId: string;
    tipId: string;
    seedCtx: Partial<SchedulerCtx>;
    upstream: unknown;
  }) => Promise<unknown>;
}

/**
 * The mutable shared state for one scheduler run: the per-node resolved
 * value map and the IO module. Built-in handlers close over this so they
 * can read/write values and recurse.
 */
interface SchedulerState {
  io: IO;
  /**
   * The provider backend (claude vs codex). The `send` handler routes EVERY
   * model call (send / schema-send / compact) through this SAME injected
   * driver the engine uses — so a CodexEngine scheduler run spawns `codex`,
   * not `claude`. This mirrors the legacy interpreter, which calls
   * `this.driver.call`/`callFormatted`/`compact` rather than the bare
   * `callClaude*` functions.
   */
  driver: ModelDriver;
  /** nodeId → resolved value (the equivalent of the legacy `upstream`). */
  values: Map<string, unknown>;
  registry: Map<string, KindHandler>;
  tickMs: number;
}

const CTX_KEYS = [
  "claudeSessionId",
  "model",
  "cwd",
  "branchId",
  "prepend",
  "append",
  "pendingFork",
  "pendingCompact",
] as const;

/** Patch shape an upstream node emits on `output.ctxPatch` for its successor. */
interface CtxPatch {
  claudeSessionId?: string | null;
  model?: string | null;
  cwd?: string;
  branchId?: string | null;
  prependAdd?: string[];
  appendAdd?: string[];
  pendingFork?: boolean;
  pendingCompact?: boolean;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** Edge readiness check: the predecessor must have reached its required status. */
function edgeReady(edge: PredecessorEdge, node: WireGraphNode): boolean {
  if (edge.condition === "any") return node.status === "ok" || node.status === "error";
  return node.status === edge.condition;
}

function isReady(
  node: WireGraphNode,
  byId: Map<string, WireGraphNode>,
  assumeOk: ReadonlySet<string>,
): boolean {
  if (node.status !== "pending") return false;
  const preds = node.predecessors;
  if (!preds || preds.length === 0) return true;
  const mode = node.joinMode ?? "all";
  // `assumeOk` lets a container's body fire against its anchor without
  // globally flipping the anchor's status (which the top-level pass would
  // otherwise see and use to fire the container's OWN successors early).
  const ok = (e: PredecessorEdge): boolean => {
    if (assumeOk.has(e.nodeId)) return e.condition !== "error";
    const p = byId.get(e.nodeId);
    return !!p && edgeReady(e, p);
  };
  if (mode === "any") {
    for (const e of preds) if (ok(e)) return true;
    return false;
  }
  for (const e of preds) if (!ok(e)) return false;
  return true;
}

/**
 * Derive the effective scheduler ctx for a node from its predecessors'
 * `output.ctxPatch` (if any) plus the resolved upstream value.
 */
function deriveCtx(
  node: WireGraphNode,
  byId: Map<string, WireGraphNode>,
  state: SchedulerState,
  base: SchedulerCtx,
  assumeOk: ReadonlySet<string>,
): SchedulerCtx {
  let acc: SchedulerCtx = base;
  const preds = node.predecessors ?? [];
  // The "upstream value" is the value of the first ok-predecessor (linear
  // chains have exactly one). Default to base.upstream when there is none.
  let upstream: unknown = base.upstream;
  for (const e of preds) {
    if (e.condition !== "ok") continue;
    const p = byId.get(e.nodeId);
    const isOk = assumeOk.has(e.nodeId) || (p && p.status === "ok");
    if (!isOk) continue;
    if (state.values.has(e.nodeId)) upstream = state.values.get(e.nodeId);
    if (!p) continue;
    const out = p.output as { ctxPatch?: CtxPatch } | null;
    const patch = out?.ctxPatch;
    if (!patch) continue;
    acc = {
      ...acc,
      claudeSessionId: patch.claudeSessionId !== undefined ? patch.claudeSessionId : acc.claudeSessionId,
      model: patch.model !== undefined ? patch.model : acc.model,
      cwd: patch.cwd !== undefined ? patch.cwd : acc.cwd,
      branchId: patch.branchId !== undefined ? patch.branchId : acc.branchId,
      prepend: patch.prependAdd ? [...acc.prepend, ...patch.prependAdd] : acc.prepend,
      append: patch.appendAdd ? [...acc.append, ...patch.appendAdd] : acc.append,
      pendingFork: patch.pendingFork !== undefined ? patch.pendingFork : acc.pendingFork,
      pendingCompact: patch.pendingCompact !== undefined ? patch.pendingCompact : acc.pendingCompact,
    };
  }
  return { ...acc, upstream };
}

function baseCtx(state: SchedulerState, seed: Partial<SchedulerCtx>): SchedulerCtx {
  return {
    claudeSessionId: seed.claudeSessionId ?? null,
    model: seed.model ?? null,
    cwd: seed.cwd ?? process.cwd(),
    branchId: seed.branchId ?? null,
    prepend: seed.prepend ?? [],
    append: seed.append ?? [],
    pendingFork: seed.pendingFork ?? false,
    pendingCompact: seed.pendingCompact ?? false,
    upstream: seed.upstream,
    setValue: (id, v) => state.values.set(id, v),
    driveSub: () => { throw new Error("driveSub not bound"); },
  };
}

/**
 * Run a set of graph nodes to completion under the scheduler loop. Only
 * nodes in `scope` (a predicate) are considered for firing — `null` scope
 * means "all nodes". Used both for the top-level run (scope = all) and for
 * container sub-chains (scope = nodes reachable from a body root).
 *
 * Returns when no in-scope node is pending or in-flight. Errors do NOT
 * throw out of this function — they land on individual nodes as
 * `status: "error"`. (Container handlers that need throw-on-error semantics
 * wrap this via driveSub and inspect the body themselves.)
 */
async function schedulerPass(
  graph: ComputationGraph,
  state: SchedulerState,
  scope: ((n: WireGraphNode) => boolean) | null,
  seed: Partial<SchedulerCtx>,
  assumeOk: ReadonlySet<string> = EMPTY_SET,
): Promise<void> {
  const inFlight = new Set<string>();
  const driveSub: SchedulerCtx["driveSub"] = async (params) => {
    // Drive only the freshly-built sub-chain fromId..tip. The sub-chain
    // nodes were created with parentId-derived predecessor edges, so they
    // become "ready" once `fromId` is ok. We seed `fromId`'s value so the
    // first body node sees the right upstream, and treat `fromId` as
    // ok-satisfied for readiness WITHOUT flipping its global status (so the
    // top-level pass can't fire the container's own successors early).
    state.values.set(params.fromId, params.upstream);
    const subNodes = collectChain(graph, params.fromId, params.tipId);
    const subSet = new Set(subNodes.map(n => n.id));
    await schedulerPass(
      graph,
      state,
      (n) => subSet.has(n.id) && n.id !== params.fromId,
      params.seedCtx,
      new Set([params.fromId]),
    );
    // Propagate failure: if any body node errored, throw the first error so
    // try/tryMultipleTimes can fall back.
    for (const n of subNodes) {
      const live = graph.get(n.id);
      if (live && live.status === "error") {
        throw reconstructError(live);
      }
    }
    return state.values.get(params.tipId);
  };

  while (true) {
    const all = graph.allNodes();
    const byId = new Map<string, WireGraphNode>(all.map(n => [n.id, n as WireGraphNode]));

    const ready: RichGraphNode[] = [];
    for (const n of all) {
      if (inFlight.has(n.id)) continue;
      if (scope && !scope(n as WireGraphNode)) continue;
      if (isReady(n as WireGraphNode, byId, assumeOk)) ready.push(n);
    }

    if (ready.length === 0) {
      if (inFlight.size === 0) return;
      await sleep(state.tickMs);
      continue;
    }

    for (const node of ready) {
      inFlight.add(node.id);
      const handler = state.registry.get(node.kind);
      if (!handler) {
        graph.finishErr(node.id, new Error(`scheduler: no handler for kind "${node.kind}"`));
        inFlight.delete(node.id);
        continue;
      }
      const derived = deriveCtx(node as WireGraphNode, byId, state, baseCtx(state, seed), assumeOk);
      const ctx: SchedulerCtx = { ...derived, driveSub };
      void (async () => {
        try {
          await handler(node, graph, ctx);
          const final = graph.get(node.id);
          if (final && final.status === "running") {
            graph.finishErr(node.id, new Error(
              `scheduler: handler for kind "${node.kind}" returned without transitioning the node`,
            ));
          }
        } catch (err) {
          const cur = graph.get(node.id);
          if (cur && cur.status !== "ok" && cur.status !== "error") {
            graph.finishErr(node.id, err);
          }
        } finally {
          inFlight.delete(node.id);
        }
      })();
    }

    await sleep(state.tickMs);
  }
}

/**
 * Walk parentId from tip back to (and including) `fromId`, returning the
 * chain in execution order (root..tip). Used to scope a container body's
 * sub-pass to just the freshly-built nodes.
 */
function collectChain(graph: ComputationGraph, fromId: string, tipId: string): RichGraphNode[] {
  const path = graph.pathToRoot(tipId);
  const idx = path.findIndex(n => n.id === fromId);
  return idx >= 0 ? path.slice(idx) : path;
}

/** Rebuild a throwable from a node's stored error record. */
function reconstructError(node: RichGraphNode): Error {
  const e = node.error;
  const err = new Error(e?.message ?? "node failed");
  if (e?.stack) err.stack = e.stack;
  return err;
}

/**
 * Run a fully-built graph to completion via the scheduler. Public entry
 * for `ClaudeEngine.execute` when `useScheduler === true`, and re-callable
 * to resume after a `resetSubtree` (restart-from-node).
 *
 * Pass the SAME `values` map across calls so a restart re-fires reset nodes
 * with the correct upstream still available from un-reset predecessors.
 */
export async function runScheduler(
  graph: ComputationGraph,
  registry: Map<string, KindHandler>,
  opts: { tickIntervalMs?: number; io?: IO; seedCtx?: Partial<SchedulerCtx>; values?: Map<string, unknown>; driver?: ModelDriver } = {},
): Promise<void> {
  // NOTE: the top-level state's `driver` is only used by the local
  // `schedulerPass` bookkeeping — the actual send handlers close over the
  // driver passed to `defaultKindRegistry`. We keep it here so the field is
  // consistent; defaults to the claude driver.
  const state: SchedulerState = {
    io: opts.io ?? realIO,
    driver: opts.driver ?? claudeDriver,
    values: opts.values ?? new Map<string, unknown>(),
    registry,
    tickMs: opts.tickIntervalMs ?? 5,
  };
  await schedulerPass(graph, state, null, opts.seedCtx ?? {});
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Built-in passthrough handlers (state mutations, ~0ms) ─────────────────────

const passthroughHandlers: Array<[string, KindHandler]> = [
  ["root", async (node, graph, ctx) => {
    if (graph.get(node.id)?.status === "pending") graph.start(node.id);
    ctx.setValue(node.id, undefined);
    graph.finishOk(node.id, { ok: true });
  }],
  ["prependToNextPrompt", async (node, graph, ctx) => {
    graph.start(node.id);
    const input = node.input as { text: string };
    ctx.setValue(node.id, ctx.upstream);
    graph.finishOk(node.id, { pushed: input.text, ctxPatch: { prependAdd: [input.text] } });
  }],
  ["appendToNextPrompt", async (node, graph, ctx) => {
    graph.start(node.id);
    const input = node.input as { text: string };
    ctx.setValue(node.id, ctx.upstream);
    graph.finishOk(node.id, { pushed: input.text, ctxPatch: { appendAdd: [input.text] } });
  }],
  ["switchModel", async (node, graph, ctx) => {
    graph.start(node.id);
    const input = node.input as { model: string };
    ctx.setValue(node.id, ctx.upstream);
    graph.finishOk(node.id, { model: input.model, ctxPatch: { model: input.model } }, { model: input.model });
  }],
  ["switchCwd", async (node, graph, ctx) => {
    graph.start(node.id);
    const input = node.input as { cwd: string };
    ctx.setValue(node.id, ctx.upstream);
    graph.finishOk(node.id, { cwd: input.cwd, ctxPatch: { cwd: input.cwd } });
  }],
  ["switchBranch", async (node, graph, ctx) => {
    graph.start(node.id);
    const input = node.input as { branchId: string };
    ctx.setValue(node.id, ctx.upstream);
    graph.finishOk(node.id, { branchId: input.branchId, ctxPatch: { branchId: input.branchId } });
  }],
  ["newSession", async (node, graph, ctx) => {
    graph.start(node.id);
    const input = node.input as { model: string };
    ctx.setValue(node.id, ctx.upstream);
    graph.finishOk(node.id, {
      reset: true,
      model: input.model,
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
  ["fork", async (node, graph, ctx) => {
    graph.start(node.id);
    ctx.setValue(node.id, ctx.upstream);
    graph.finishOk(node.id, { pending: "--fork-session queued for next send", ctxPatch: { pendingFork: true } });
  }],
  ["compact", async (node, graph, ctx) => {
    graph.start(node.id);
    ctx.setValue(node.id, ctx.upstream);
    graph.finishOk(node.id, { pending: "/compact queued for next send", ctxPatch: { pendingCompact: true } });
  }],
  ["materializeError", async (node, graph, ctx) => {
    graph.start(node.id);
    const input = node.input as { error: string };
    const value = { error: input.error };
    ctx.setValue(node.id, value);
    graph.finishOk(node.id, { value });
  }],
  ["assert", async (node, graph, ctx) => {
    graph.start(node.id);
    const check = (node as RichGraphNode & { callbacks?: { check?: (r: unknown) => void } }).callbacks?.check;
    if (typeof check === "function") check(ctx.upstream);
    ctx.setValue(node.id, ctx.upstream);
    graph.finishOk(node.id, { ok: true });
  }],
];

// ── executeShell handler ──────────────────────────────────────────────────────
//
// The command string can come from two places: a description-builder that
// already wrote `node.input.cmd`, OR (the Session API path) a `buildCommand`
// callback that consumes the upstream value. We resolve the callback against
// `ctx.upstream` when present.
function makeExecuteShellHandler(state: SchedulerState): KindHandler {
  return async (node, graph, ctx) => {
    let cmd: string | undefined = (node.input as { cmd?: string } | null)?.cmd;
    const build = (node as RichGraphNode & { callbacks?: { buildCommand?: (r: unknown) => string } }).callbacks?.buildCommand;
    if (cmd == null && typeof build === "function") cmd = build(ctx.upstream);
    if (cmd == null) {
      graph.finishErr(node.id, new Error("executeShell: no command (neither node.input.cmd nor buildCommand callback)"));
      return;
    }
    const cwd = (node.input as { cwd?: string } | null)?.cwd ?? ctx.cwd;
    graph.setLabel(node.id, `executeShell: ${truncate(cmd, 60)}`);
    graph.start(node.id, { input: { cmd, cwd } });
    graph.patchOutput(node.id, { cmd, cwd, stdoutSoFar: "", stderrSoFar: "" });
    let stdoutSoFar = "";
    let stderrSoFar = "";
    const r = await state.io.spawnCapture({
      command: "bash",
      args: ["-c", cmd],
      cwd,
      nodeId: node.id,
      branchId: ctx.branchId ?? undefined,
      onStdout: (chunk) => { stdoutSoFar += chunk; graph.patchOutput(node.id, { stdoutSoFar }); },
      onStderr: (chunk) => { stderrSoFar += chunk; graph.patchOutput(node.id, { stderrSoFar }); },
    });
    if (r.spawnError) {
      graph.finishErr(node.id, new FatalShellError(`executeShell: bash spawn failed: ${r.spawnError}`, { nodeId: node.id }));
      return;
    }
    if (r.exitCode !== 0) {
      const stderrTail = r.stderr.slice(-800);
      graph.finishErr(node.id, new FatalShellError(
        `executeShell: command failed (code ${r.exitCode}): ${cmd}\n${stderrTail}`,
        { nodeId: node.id, data: { kind: "shellExit", exitCode: r.exitCode, cmd, stderrTail } },
      ));
      return;
    }
    ctx.setValue(node.id, r.stdout);
    graph.finishOk(node.id, { cmd, cwd, stdoutTail: r.stdout.slice(-400), exitCode: r.exitCode });
  };
}

// ── send handler ───────────────────────────────────────────────────────────────
//
// Composes the prompt by draining ctx.prepend + node.input.prompt (resolved
// against upstream if it's a function) + ctx.append, materializes a pending
// /compact, then fires callClaude / callClaudeFormatted depending on whether a
// schema is present. Streams partial text via patchOutput.
function makeSendHandler(state: SchedulerState): KindHandler {
  return async (node, graph, ctx) => {
    const input = (node.input ?? {}) as SendNodeInput;
    const rawPrompt = resolvePrompt(input.prompt, ctx.upstream);
    const composedPrompt = [...ctx.prepend, rawPrompt, ...ctx.append]
      .filter(s => typeof s === "string" && s.length > 0)
      .join("\n\n");

    const schemaUnit = input.schema;
    const hasSchema = !!(schemaUnit && typeof schemaUnit === "object" && "schema" in schemaUnit);
    const flatSchema = hasSchema ? flattenSchemaUnit(schemaUnit as unknown as SchemaUnit) : undefined;

    graph.start(node.id, { model: ctx.model, sessionId: ctx.claudeSessionId });
    graph.patchOutput(node.id, { composedPrompt, partialText: "" });

    // Materialize a queued /compact against the resumed session before the send.
    let resumeSid = ctx.claudeSessionId;
    if (ctx.pendingCompact && resumeSid) {
      // Route through the injected driver: claude sends "/compact"; codex's
      // compact is a no-op echoing the resume id (see codex-cli.ts). The
      // `prompt` field is ignored by codexDriver.compact.
      const compactResp = await state.driver.compact({
        prompt: "/compact",
        resume: resumeSid,
        fork: ctx.pendingFork,
        model: (ctx.model ?? undefined) as ClaudeModel | undefined,
        cwd: ctx.cwd,
        branchId: ctx.branchId ?? undefined,
        io: state.io,
      });
      if (compactResp.isError) {
        graph.finishErr(node.id, new StructuredError(compactResp.errorMessage ?? "/compact failed", {
          sessionId: resumeSid, nodeId: node.id, data: { raw: compactResp.raw, stderr: compactResp.stderr },
        }));
        return;
      }
      resumeSid = compactResp.sessionId ?? resumeSid;
    }
    const applyFork = ctx.pendingFork && !!resumeSid;

    try {
      // Route through the SAME injected driver the engine uses, so a
      // CodexEngine scheduler run spawns `codex` and a ClaudeEngine run spawns
      // `claude`. (Previously this called the bare callClaude* functions, which
      // hard-wired claude regardless of engine.)
      const r = hasSchema
        ? await state.driver.callFormatted({
            prompt: composedPrompt,
            jsonSchema: flatSchema!,
            resume: resumeSid,
            fork: applyFork,
            model: (ctx.model ?? undefined) as ClaudeModel | undefined,
            cwd: ctx.cwd,
            branchId: ctx.branchId ?? undefined,
            timeoutMs: input.timeout,
            attachments: input.base64_attachments,
            nodeId: node.id,
            io: state.io,
            onPartialText: (textSoFar) => graph.patchOutput(node.id, { partialText: textSoFar }),
          })
        : await state.driver.call({
            prompt: composedPrompt,
            resume: resumeSid,
            fork: applyFork,
            model: (ctx.model ?? undefined) as ClaudeModel | undefined,
            cwd: ctx.cwd,
            branchId: ctx.branchId ?? undefined,
            timeoutMs: input.timeout,
            attachments: input.base64_attachments,
            nodeId: node.id,
            io: state.io,
            onPartialText: (textSoFar) => graph.patchOutput(node.id, { partialText: textSoFar }),
          });

      if (r.isError) {
        graph.finishErr(node.id, new StructuredError(r.errorMessage ?? "send failed", {
          sessionId: r.sessionId, nodeId: node.id, data: { raw: r.raw, stderr: r.stderr },
        }));
        return;
      }

      const ctxPatch: CtxPatch = {
        claudeSessionId: r.sessionId,
        prependAdd: [],
        appendAdd: [],
        pendingFork: false,
        pendingCompact: false,
      };

      if (hasSchema) {
        const rr = r as typeof r & { parsed?: unknown; parseError?: string | null };
        if (rr.parseError || rr.parsed == null) {
          graph.finishErr(node.id, new StructuredError(rr.parseError ?? "send(schema) parse returned null", {
            sessionId: r.sessionId, nodeId: node.id, data: { text: r.text },
          }));
          return;
        }
        const parsed = rr.parsed;
        if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).InterruptException !== undefined) {
          graph.finishErr(node.id, new InterruptException(String((parsed as Record<string, unknown>).InterruptException) || "InterruptException"));
          return;
        }
        ctx.setValue(node.id, parsed);
        graph.finishOk(node.id, { parsed, text: r.text, composedPrompt, appliedForkFlag: applyFork, ctxPatch },
          { sessionId: r.sessionId ?? resumeSid, model: ctx.model });
        return;
      }

      ctx.setValue(node.id, r.text);
      graph.finishOk(node.id, {
        text: r.text, composedPrompt, durationMs: r.durationMs, usage: r.usage,
        appliedForkFlag: applyFork, ctxPatch,
      }, { sessionId: r.sessionId ?? resumeSid, model: ctx.model });
    } catch (err) {
      graph.finishErr(node.id, err);
    }
  };
}

// ── Container handlers (pipe / combineWith / parallelFork / try / tryMultipleTimes) ──

function makePipeHandler(_state: SchedulerState): KindHandler {
  return async (node, graph, ctx) => {
    graph.start(node.id);
    const fn = (node as RichGraphNode & { callbacks?: { fn?: (s: Session) => SessionWithResult<unknown> } }).callbacks?.fn;
    if (typeof fn !== "function") { graph.finishErr(node.id, new Error("pipe: missing fn callback")); return; }
    const sub = new Session({ model: (ctx.model ?? "fable") as ClaudeModel, cwd: ctx.cwd, graph, tipNodeId: node.id, containerId: node.id });
    const tip = fn(sub);
    const value = await ctx.driveSub({
      fromId: node.id, tipId: tip.tipNodeId, upstream: ctx.upstream,
      seedCtx: seedFromCtx(ctx),
    });
    ctx.setValue(node.id, value);
    graph.finishOk(node.id, { ok: true });
  };
}

function makeCombineWithHandler(state: SchedulerState): KindHandler {
  return async (node, graph, ctx) => {
    graph.start(node.id);
    const cbs = (node as RichGraphNode & { callbacks?: { execution?: (s: SessionWithResult<unknown>) => SessionWithResult<unknown>; combine?: (l: unknown, r: unknown) => unknown } }).callbacks;
    if (!cbs?.execution || !cbs?.combine) { graph.finishErr(node.id, new Error("combineWith: missing callbacks")); return; }
    const branch = graph.create({ parentId: node.id, kind: "combineBranch", label: "combineBranch" });
    const branchSession = new SessionWithResult<unknown>({ model: (ctx.model ?? "fable") as ClaudeModel, cwd: ctx.cwd, graph, tipNodeId: branch.id, containerId: branch.id });
    const tip = cbs.execution(branchSession);
    state.values.set(branch.id, ctx.upstream);
    const rightVal = await ctx.driveSub({
      fromId: branch.id, tipId: tip.tipNodeId, upstream: ctx.upstream, seedCtx: seedFromCtx(ctx),
    });
    graph.finishOk(branch.id, { ok: true });
    const joint = cbs.combine(ctx.upstream, rightVal);
    ctx.setValue(node.id, joint);
    graph.finishOk(node.id, { joint: safeValue(joint) });
  };
}

function makeParallelForkHandler(state: SchedulerState): KindHandler {
  return async (node, graph, ctx) => {
    graph.start(node.id);
    const apply = (node as RichGraphNode & { callbacks?: { apply?: (s: Session, input: unknown, i: number) => SessionWithResult<unknown> } }).callbacks?.apply;
    const input = node.input as { inputs: readonly unknown[] };
    if (typeof apply !== "function") { graph.finishErr(node.id, new Error("parallelFork: missing apply callback")); return; }
    const results = await Promise.all(input.inputs.map(async (childInput, i) => {
      const childNode = graph.create({ parentId: node.id, kind: "parallelChild", label: `child #${i}`, input: { index: i, input: childInput } });
      const childSession = new Session({ model: (ctx.model ?? "fable") as ClaudeModel, cwd: ctx.cwd, graph, tipNodeId: childNode.id, containerId: childNode.id });
      try {
        const tip = apply(childSession, childInput, i);
        const value = await ctx.driveSub({
          fromId: childNode.id, tipId: tip.tipNodeId, upstream: undefined,
          // Each child is an independent branch: fresh session, inherit model/cwd.
          seedCtx: { model: ctx.model, cwd: ctx.cwd },
        });
        state.values.set(childNode.id, value);
        graph.finishOk(childNode.id, safeValue(value));
        return value;
      } catch (e) {
        graph.finishErr(childNode.id, e);
        throw e;
      }
    }));
    ctx.setValue(node.id, results);
    graph.finishOk(node.id, { count: results.length });
  };
}

function makeTryMultipleTimesHandler(state: SchedulerState): KindHandler {
  return async (node, graph, ctx) => {
    graph.start(node.id);
    const cbs = (node as RichGraphNode & { callbacks?: { code?: (s: Session) => SessionWithResult<unknown>; fallback?: (s: Session, e: unknown) => SessionWithResult<unknown> } }).callbacks;
    const { max } = node.input as { max: number };
    if (!cbs?.code || !cbs?.fallback) { graph.finishErr(node.id, new Error("tryMultipleTimes: missing callbacks")); return; }
    let lastErr: unknown = null;
    let resumeSid: string | null = ctx.claudeSessionId;
    let extraPrepend: string[] = [];
    for (let i = 1; i <= max; i++) {
      const att = graph.create({ parentId: node.id, kind: "tryAttempt", label: `attempt ${i}/${max}` });
      const s = new Session({ model: (ctx.model ?? "fable") as ClaudeModel, cwd: ctx.cwd, graph, tipNodeId: att.id, containerId: att.id });
      try {
        const tip = cbs.code(s);
        const value = await ctx.driveSub({
          fromId: att.id, tipId: tip.tipNodeId, upstream: ctx.upstream,
          seedCtx: {
            model: ctx.model, cwd: ctx.cwd,
            claudeSessionId: resumeSid, prepend: extraPrepend,
            append: ['If you want to abandon this task, respond with a JSON object {"InterruptException": "<reason>"} and no other fields.'],
          },
        });
        state.values.set(att.id, value);
        graph.finishOk(att.id, safeValue(value));
        ctx.setValue(node.id, value);
        graph.finishOk(node.id, { attempts: i });
        return;
      } catch (err) {
        lastErr = err;
        graph.finishErr(att.id, err);
        if (err instanceof InterruptException) break;
        // Resume the attempt's first send next round (carry conversation forward).
        const resumeId = graph.allNodes()
          .filter(n => n.kind === "send" && n.containerId === att.id && n.sessionId)
          .sort((a, b) => a.createdAt - b.createdAt)[0]?.sessionId ?? null;
        resumeSid = resumeId ?? resumeSid;
        extraPrepend = resumeId
          ? [`Your previous attempt did not pass: ${describeError(err)}. You retain the FULL context of your earlier rounds. Diagnose what went wrong and try a DIFFERENT approach.`]
          : [...extraPrepend, `Previous attempt failed: ${describeError(err)}. Diagnose the cause before retrying.`];
      }
    }
    // Fallback chain.
    const fb = graph.create({ parentId: node.id, kind: "tryFallback", label: "fallback after retries", input: { error: describeError(lastErr) } });
    const s = new Session({ model: (ctx.model ?? "fable") as ClaudeModel, cwd: ctx.cwd, graph, tipNodeId: fb.id, containerId: fb.id });
    try {
      const tip = cbs.fallback(s, lastErr);
      const value = await ctx.driveSub({
        fromId: fb.id, tipId: tip.tipNodeId, upstream: ctx.upstream, seedCtx: { model: ctx.model, cwd: ctx.cwd },
      });
      state.values.set(fb.id, value);
      graph.finishOk(fb.id, safeValue(value));
      ctx.setValue(node.id, value);
      graph.finishOk(node.id, { recovered: true });
    } catch (err2) {
      graph.finishErr(fb.id, err2);
      graph.finishErr(node.id, err2);
    }
  };
}

function makeTryHandler(_state: SchedulerState): KindHandler {
  return async (node, graph, ctx) => {
    graph.start(node.id);
    const cbs = (node as RichGraphNode & { callbacks?: { code?: (s: Session) => SessionWithResult<unknown>; fallback?: (s: Session, e: unknown) => SessionWithResult<unknown> } }).callbacks;
    if (!cbs?.code || !cbs?.fallback) { graph.finishErr(node.id, new Error("try: missing callbacks")); return; }
    try {
      const s = new Session({ model: (ctx.model ?? "fable") as ClaudeModel, cwd: ctx.cwd, graph, tipNodeId: node.id, containerId: node.id });
      const tip = cbs.code(s);
      const value = await ctx.driveSub({ fromId: node.id, tipId: tip.tipNodeId, upstream: ctx.upstream, seedCtx: seedFromCtx(ctx) });
      ctx.setValue(node.id, value);
      graph.finishOk(node.id, { ok: true });
    } catch (err) {
      const fb = graph.create({ parentId: node.id, kind: "tryFallback", label: "fallback", input: { error: describeError(err) } });
      const s = new Session({ model: (ctx.model ?? "fable") as ClaudeModel, cwd: ctx.cwd, graph, tipNodeId: fb.id, containerId: fb.id });
      try {
        const tip = cbs.fallback(s, err);
        const value = await ctx.driveSub({ fromId: fb.id, tipId: tip.tipNodeId, upstream: ctx.upstream, seedCtx: { model: ctx.model, cwd: ctx.cwd } });
        ctx.setValue(node.id, value);
        graph.finishOk(fb.id, safeValue(value));
        graph.finishOk(node.id, { recovered: true });
      } catch (err2) {
        graph.finishErr(fb.id, err2);
        graph.finishErr(node.id, err2);
      }
    }
  };
}

/** Synthetic container wrappers are passthroughs finished by their parent handler. */
const containerPassthrough: Array<[string, KindHandler]> = [
  ["combineBranch", async (node, graph, ctx) => { graph.start(node.id); ctx.setValue(node.id, ctx.upstream); graph.finishOk(node.id, { ok: true }); }],
  ["parallelChild", async (node, graph, ctx) => { graph.start(node.id); ctx.setValue(node.id, ctx.upstream); graph.finishOk(node.id, { ok: true }); }],
  ["tryAttempt", async (node, graph, ctx) => { graph.start(node.id); ctx.setValue(node.id, ctx.upstream); graph.finishOk(node.id, { ok: true }); }],
  ["tryFallback", async (node, graph, ctx) => { graph.start(node.id); ctx.setValue(node.id, ctx.upstream); graph.finishOk(node.id, { ok: true }); }],
];

function seedFromCtx(ctx: SchedulerCtx): Partial<SchedulerCtx> {
  const seed: Partial<SchedulerCtx> = {};
  const src = ctx as unknown as Record<string, unknown>;
  const dst = seed as unknown as Record<string, unknown>;
  for (const k of CTX_KEYS) dst[k] = src[k];
  return seed;
}

/**
 * Build the kind-handler registry, closing over a shared SchedulerState so
 * handlers can read/write the value map and recurse via driveSub. Returns
 * both the registry and the shared `values` map; pass the same `values` map
 * to `runScheduler` so the top-level loop and the handlers agree on
 * resolved node values (and a restart re-fire sees un-reset upstream).
 */
export function defaultKindRegistry(
  io: IO = realIO,
  driver: ModelDriver = claudeDriver,
): { registry: Map<string, KindHandler>; values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  const state: SchedulerState = { io, driver, values, registry: new Map(), tickMs: 5 };
  const r = state.registry;
  for (const [k, h] of passthroughHandlers) r.set(k, h);
  for (const [k, h] of containerPassthrough) r.set(k, h);
  r.set("executeShell", makeExecuteShellHandler(state));
  r.set("send", makeSendHandler(state));
  r.set("pipe", makePipeHandler(state));
  r.set("combineWith", makeCombineWithHandler(state));
  r.set("parallelFork", makeParallelForkHandler(state));
  r.set("try", makeTryHandler(state));
  r.set("tryMultipleTimes", makeTryMultipleTimesHandler(state));
  return { registry: r, values };
}

// ── helpers (ported from engine.ts) ───────────────────────────────────────────

function resolvePrompt(p: unknown, upstream: unknown): string {
  if (typeof p === "function") {
    const v = (p as (u: unknown) => unknown)(upstream);
    return typeof v === "string" ? v : String(v);
  }
  return typeof p === "string" ? p : "";
}

type JsonSchemaObject = Record<string, unknown>;
interface SchemaUnit { schema: JsonSchemaObject; components?: JsonSchemaObject; }

function flattenSchemaUnit(unit: SchemaUnit): JsonSchemaObject {
  const root = unit.schema;
  if (!root || typeof root !== "object") return root ?? {};
  if (typeof root.$ref === "string" && unit.components) {
    const resolved = resolveRef(root.$ref, unit.components);
    if (resolved) return resolved;
  }
  return root;
}

function resolveRef(ref: string, components: JsonSchemaObject): JsonSchemaObject | null {
  const parts = ref.replace(/^#\//, "").split("/");
  let cur: unknown = { components };
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur != null && typeof cur === "object" ? (cur as JsonSchemaObject) : null;
}

function safeValue(v: unknown): unknown {
  try { JSON.stringify(v); return v; } catch { return String(v); }
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
