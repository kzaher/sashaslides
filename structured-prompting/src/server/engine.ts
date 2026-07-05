import {
  Session,
  SessionWithResult,
  type RichGraphNode,
} from "./session.js";
import { ComputationGraph } from "./graph.js";
import { claudeDriver } from "./claude-cli.js";
import { codexDriver } from "./codex-cli.js";
import type { ModelDriver } from "./model-driver.js";
import { Claude, type ClaudeModel, type Result } from "./types.js";
import { InterruptException, StructuredError, describeError } from "./errors.js";
import { startMonitor, type MonitorServer } from "./server.js";
import { realIO, type IO } from "./io.js";
import { captureWorktreeDiff, indexFileForCwd } from "./git-diff.js";
import { runScheduler, defaultKindRegistry } from "./scheduler.js";

/**
 * Node kinds that can change files on disk and are therefore worth capturing a
 * working-tree diff for. "at least" send + executeShell — extend as new
 * file-touching kinds appear.
 */
const FILE_MUTATING_KINDS = new Set<string>(["send", "executeShell"]);

export interface EngineOptions {
  port?: number;
  host?: string;
  /** If true, keep the server alive after the calculation finishes (until SIGINT/SIGTERM). Default: true. */
  persist?: boolean;
  /** If true, install SIGINT/SIGTERM handlers that shut the server down cleanly. Default: true. */
  hookSignals?: boolean;
  /** Log banner URL when server boots. Default: true. */
  log?: boolean;
  /**
   * IO module routing every side-effecting call (spawn, fs, clock, log).
   * Default `realIO`. Tests pass a `MockIO` here to record effects and
   * inject failures.
   */
  io?: IO;
}

/**
 * Runtime execution context. One instance per logical session branch (root
 * gets one; each parallelFork child gets its own fresh clone). Mutated by
 * the engine as it walks the description.
 */
interface RunCtx {
  driverSessionId: string | null;
  model: ClaudeModel;
  cwd: string;
  /** Opt-in overlay branch id (set by switchBranch). When set, every command
   *  for this context runs inside the branch's overlayfs mount. */
  branchId?: string;
  /** Prepend strings queued by prependToNextPrompt description nodes; consumed by next send*. */
  prepend: string[];
  append: string[];
  pendingFork: boolean;
  pendingForkNodeId: string | null;
  pendingCompact: boolean;
  pendingCompactNodeId: string | null;
}

function cloneCtx(ctx: RunCtx): RunCtx {
  return {
    driverSessionId: ctx.driverSessionId,
    model: ctx.model,
    cwd: ctx.cwd,
    branchId: ctx.branchId,
    prepend: [...ctx.prepend],
    append: [...ctx.append],
    pendingFork: ctx.pendingFork,
    pendingForkNodeId: ctx.pendingForkNodeId,
    pendingCompact: ctx.pendingCompact,
    pendingCompactNodeId: ctx.pendingCompactNodeId,
  };
}

/**
 * Provider-agnostic execution engine. All the logic (graph walk, monitor,
 * description interpreter, session/fork/compact bookkeeping) lives here; the
 * ONLY engine-specific part — how a prompt reaches the model CLI — is the
 * injected `ModelDriver` (composition, not inheritance). `ClaudeEngine` and
 * `CodexEngine` below are thin wrappers that pre-bind a driver.
 */
export class Engine {
  private monitor: MonitorServer | null = null;
  private activeGraph: ComputationGraph | null = null;
  private opts: Required<EngineOptions>;
  private readonly driver: ModelDriver;
  readonly io: IO;
  /**
   * Opt-in: drive execution through the graph-driven state-machine
   * scheduler (`runScheduler`) instead of the legacy `runChain`/`runNode`
   * interpreter. Default false — the legacy path is unchanged. The
   * scheduler path enables RESTART-FROM-ANY-NODE: reset a node + successors
   * to pending and the scheduler re-fires them. See scheduler.ts.
   */
  useScheduler = false;

  constructor(driver: ModelDriver, opts: EngineOptions = {}) {
    this.driver = driver;
    this.opts = {
      port: opts.port ?? 4711,
      host: opts.host ?? "127.0.0.1",
      persist: opts.persist ?? true,
      hookSignals: opts.hookSignals ?? true,
      log: opts.log ?? true,
      io: opts.io ?? realIO,
    };
    this.io = this.opts.io;
  }

  get currentGraph(): ComputationGraph | null {
    return this.activeGraph;
  }

  get monitorUrl(): string | null {
    return this.monitor?.url ?? null;
  }

  /**
   * Execute a description. Important contract: `calculation` runs SYNCHRONOUSLY
   * (it only builds description nodes). This engine then interprets the
   * description.
   */
  async execute<R>(
    session: Session,
    calculation: (s: Session) => SessionWithResult<R>,
  ): Promise<R> {
    this.activeGraph = session.graph;

    // 1. Boot a fresh monitor server.
    if (this.monitor) {
      try { await this.monitor.stop(); } catch {}
      this.monitor = null;
    }
    const monitor = await startMonitor({
      graph: session.graph,
      port: this.opts.port,
      host: this.opts.host,
    });
    this.monitor = monitor;
    if (this.opts.log) {
      // eslint-disable-next-line no-console
      console.error(`\n┌── structured-prompting monitor\n│ ${monitor.url}\n└──\n`);
    }
    if (this.opts.hookSignals) installShutdownHooks(this);

    // 2. Build the description SYNCHRONOUSLY.
    session.graph.start(session.graph.rootId);
    let descriptionTip: SessionWithResult<R>;
    try {
      descriptionTip = calculation(session);
      if (!(descriptionTip instanceof SessionWithResult)) {
        throw new Error(
          "ClaudeEngine.execute: calculation must return a SessionWithResult<R> — got " +
            (descriptionTip === undefined ? "undefined" : typeof descriptionTip),
        );
      }
    } catch (err) {
      session.graph.finishErr(session.graph.rootId, err);
      session.graph.markRootDone("error");
      if (!this.opts.persist) await this.shutdown();
      throw err;
    }

    // 3a. Scheduler path (opt-in): drive the fully-built graph through the
    // state-machine loop. Enables restart-from-any-node. The legacy
    // runChain path below is untouched and remains the default.
    if (this.useScheduler) {
      // Thread the SAME injected driver into the scheduler's send handler, so
      // a CodexEngine scheduler run spawns codex (not claude). See scheduler.ts.
      const { registry, values } = defaultKindRegistry(this.io, this.driver);
      // Step 2 already `start()`ed the root (status=running). The scheduler
      // only fires `pending` nodes, so reset the root to pending and seed its
      // resolved value (undefined upstream) — the root handler then transitions
      // it to ok, unblocking the first chain step.
      session.graph.resetNode(session.graph.rootId);
      values.set(session.graph.rootId, undefined);
      try {
        await runScheduler(session.graph, registry, {
          io: this.io,
          values,
          seedCtx: { model: session.model, cwd: session.cwd, branchId: session.branchId ?? null },
        });
        const tip = session.graph.get(descriptionTip.tipNodeId);
        if (tip && tip.status === "error") {
          throw tip.error ? Object.assign(new Error(tip.error.message), tip.error) : new Error("scheduler: tip node errored");
        }
        session.graph.finishOk(session.graph.rootId, { ok: true });
        this.sweepStuckNodes(session.graph);
        session.graph.markRootDone("ok");
        if (!this.opts.persist) await this.shutdown();
        return (values.get(descriptionTip.tipNodeId) as R);
      } catch (err) {
        session.graph.finishErr(session.graph.rootId, err);
        this.sweepStuckNodes(session.graph);
        session.graph.markRootDone("error");
        if (!this.opts.persist) await this.shutdown();
        throw err;
      }
    }

    // 3. Walk from root to tip, executing nodes in order against a RunCtx.
    const initialCtx: RunCtx = {
      driverSessionId: null,
      model: session.model,
      cwd: session.cwd,
      branchId: session.branchId,
      prepend: [],
      append: [],
      pendingFork: false,
      pendingForkNodeId: null,
      pendingCompact: false,
      pendingCompactNodeId: null,
    };

    try {
      const { value } = await this.runChain(
        session.graph,
        session.graph.rootId,
        descriptionTip.tipNodeId,
        initialCtx,
        /*upstream*/ undefined,
      );
      session.graph.finishOk(session.graph.rootId, { ok: true });
      this.sweepStuckNodes(session.graph);
      session.graph.markRootDone("ok");
      if (!this.opts.persist) await this.shutdown();
      return value as R;
    } catch (err) {
      session.graph.finishErr(session.graph.rootId, err);
      this.sweepStuckNodes(session.graph);
      session.graph.markRootDone("error");
      if (this.opts.log) {
        // eslint-disable-next-line no-console
        console.error("structured-prompting execution failed:", (err as Error)?.message ?? err);
      }
      if (!this.opts.persist) await this.shutdown();
      throw err;
    }
  }

  /**
   * Close any orphan nodes still marked running at end-of-run. In the normal
   * flow fork/compact now finish immediately when visited, so this is a no-op
   * safety net for unexpected cases.
   */
  private sweepStuckNodes(graph: ComputationGraph) {
    for (const n of graph.allNodes()) {
      if (n.status === "running") {
        graph.finishOk(n.id, { swept: true });
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.monitor) {
      try { await this.monitor.stop(); } catch {}
      this.monitor = null;
    }
  }

  // ==========================================================================
  // Description → execution interpreter.
  // ==========================================================================

  /**
   * Execute the chain of nodes from `startId` (exclusive) up to and including
   * `tipId`. Returns the tip's value and the updated RunCtx. `upstream` is the
   * value produced by the parent of `startId` (used by nodes like combineWith
   * that need the upstream result).
   */
  private async runChain(
    graph: ComputationGraph,
    startId: string,
    tipId: string,
    ctx: RunCtx,
    upstream: unknown,
  ): Promise<{ value: unknown; ctx: RunCtx; error?: unknown }> {
    const path = graph.pathToRoot(tipId);
    // Drop nodes up to and including startId — we only execute what's after.
    const startIdx = path.findIndex((n) => n.id === startId);
    const toRun = startIdx >= 0 ? path.slice(startIdx + 1) : path;

    let current = upstream;
    let currentCtx = ctx;
    for (const node of toRun) {
      const out = await this.runNode(graph, node, currentCtx, current);
      current = out.value;
      currentCtx = out.ctx;
      // After a file-mutating node finishes, snapshot the worktree so the UI
      // can show what changed at (and up to) this step. Best-effort.
      if (FILE_MUTATING_KINDS.has(node.kind) && currentCtx.cwd) {
        await this.captureNodeDiff(graph, node.id, currentCtx.cwd);
      }
    }
    return { value: current, ctx: currentCtx };
  }

  /** Best-effort working-tree diff capture for a file-mutating node. Snapshots
   *  the worktree at `cwd` and attaches the cumulative + per-node delta. Never
   *  throws — a diff failure must not break the run. */
  private async captureNodeDiff(graph: ComputationGraph, nodeId: string, cwd: string): Promise<void> {
    try {
      const prevTree = graph.prevSnapshotTree(nodeId);
      const diff = await captureWorktreeDiff(this.io, cwd, prevTree, indexFileForCwd(cwd), nodeId);
      if (diff) graph.setDiff(nodeId, diff);
    } catch (err) {
      console.error(`[engine] diff capture failed for ${nodeId}: ${(err as Error).message}`);
    }
  }

  private async runNode(
    graph: ComputationGraph,
    node: RichGraphNode,
    ctx: RunCtx,
    upstream: unknown,
  ): Promise<{ value: unknown; ctx: RunCtx }> {
    graph.start(node.id, { model: ctx.model, sessionId: ctx.driverSessionId });
    try {
      switch (node.kind) {
        // --- trivial passthroughs (state mutations) --------------------------
        case "prependToNextPrompt": {
          const next = cloneCtx(ctx);
          next.prepend.push(node.input.text);
          graph.finishOk(node.id, { pushed: node.input.text });
          return { value: upstream, ctx: next };
        }
        case "appendToNextPrompt": {
          const next = cloneCtx(ctx);
          next.append.push(node.input.text);
          graph.finishOk(node.id, { pushed: node.input.text });
          return { value: upstream, ctx: next };
        }
        case "switchModel": {
          const next = cloneCtx(ctx);
          next.model = node.input.model;
          graph.finishOk(node.id, { model: next.model }, { model: next.model });
          return { value: upstream, ctx: next };
        }
        case "switchCwd": {
          const next = cloneCtx(ctx);
          next.cwd = node.input.cwd;
          graph.finishOk(node.id, { cwd: next.cwd });
          return { value: upstream, ctx: next };
        }
        case "switchBranch": {
          const next = cloneCtx(ctx);
          next.branchId = node.input.branchId;
          graph.finishOk(node.id, { branchId: next.branchId });
          return { value: upstream, ctx: next };
        }
        case "newSession": {
          const next = cloneCtx(ctx);
          next.driverSessionId = null;
          next.prepend = [];
          next.append = [];
          next.pendingFork = false;
          next.pendingForkNodeId = null;
          next.pendingCompact = false;
          next.pendingCompactNodeId = null;
          // The description node always records a model (defaulting to the
          // inherited one). Apply it to the fresh context.
          next.model = node.input.model;
          graph.finishOk(node.id, { reset: true, model: next.model }, { model: next.model });
          return { value: upstream, ctx: next };
        }
        case "fork": {
          // Description-level: queue --fork-session for the next send. The node
          // itself has no self-time (~0ms) — the real CLI work happens inside
          // the upcoming send and is reported there via appliedForkFlag.
          const next = cloneCtx(ctx);
          next.pendingFork = true;
          next.pendingForkNodeId = node.id;
          graph.finishOk(node.id, { pending: "--fork-session queued for next send" });
          return { value: upstream, ctx: next };
        }
        case "compact": {
          // Description-level: queue /compact for the next send. Self-time ~0ms;
          // the real /compact CLI round-trip is recorded on the triggering send.
          const next = cloneCtx(ctx);
          next.pendingCompact = true;
          next.pendingCompactNodeId = node.id;
          graph.finishOk(node.id, { pending: "/compact queued for next send" });
          return { value: upstream, ctx: next };
        }

        // --- CLI-touching node ---------------------------------------------
        // Single `send` case handles both raw-text and schema-constrained
        // replies. Dispatch is by presence of `schema` in the node's args.
        case "send": {
          // node.input is typed as SendNodeInput thanks to the discriminated
          // union — no cast needed.
          const args = node.input;
          const rawPrompt = resolvePrompt(args.prompt, upstream);
          const schemaUnit = args.schema;
          const hasSchema = !!(schemaUnit && typeof schemaUnit === "object" && "schema" in schemaUnit);
          // Flatten typia's {schema: {$ref: "#/components/.../Name"}, components}
          // into a standalone JSON Schema object — that's what the CLI expects
          // under `--json-schema`. The CLI itself hands the schema to the model
          // as a StructuredOutput tool and returns the parsed value in
          // result.structured_output, so we just forward and read.
          const flatSchema = hasSchema ? flattenSchemaUnit(schemaUnit as unknown as SchemaUnit) : undefined;
          const { ctx: nextCtx, response, usedResume, appliedForkFlag, composedPrompt } = await this.materializeAndCall(
            graph,
            node,
            ctx,
            async (resumeSid, forkFlag, composedPrompt) =>
              hasSchema
                ? this.driver.callFormatted({
                    prompt: composedPrompt,
                    jsonSchema: flatSchema!,
                    model: ctx.model,
                    resume: resumeSid,
                    fork: forkFlag,
                    cwd: ctx.cwd,
                    branchId: ctx.branchId,
                    timeoutMs: args.timeout,
                    attachments: args.base64_attachments,
                    io: this.io,
                  })
                : this.driver.call({
                    prompt: composedPrompt,
                    model: ctx.model,
                    resume: resumeSid,
                    fork: forkFlag,
                    cwd: ctx.cwd,
                    branchId: ctx.branchId,
                    timeoutMs: args.timeout,
                    attachments: args.base64_attachments,
                    io: this.io,
                  }),
            rawPrompt,
          );
          if (response.isError) {
            throw new StructuredError(response.errorMessage ?? "send failed", {
              sessionId: usedResume,
              nodeId: node.id,
              data: { raw: response.raw, stderr: response.stderr },
            });
          }
          // CLI command to load THIS send's session for inspection — surfaced
          // in the monitor so you can open the exact conversation (and verify
          // whether it actually carried prior history).
          const resumeCommand = this.driver.resumeCommand(response.sessionId ?? usedResume, ctx.cwd);
          if (hasSchema) {
            const r = response as typeof response & { parseError?: string | null; parsed?: unknown };
            if (r.parseError || r.parsed == null) {
              throw new StructuredError(r.parseError ?? "send(schema) parse returned null", {
                sessionId: response.sessionId,
                nodeId: node.id,
                data: { text: response.text },
              });
            }
            const parsed = r.parsed;
            if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).InterruptException !== "undefined") {
              throw new InterruptException(String((parsed as Record<string, unknown>).InterruptException) || "InterruptException");
            }
            graph.finishOk(
              node.id,
              { parsed, text: response.text, appliedForkFlag, composedPrompt, resumeCommand },
              // Propagate the REQUESTED model (ctx.model), NOT the served one:
              // `claude --model fable` uses haiku for a sub-task, so response.model
              // can come back as haiku; writing that into ctx downgraded every
              // later --resume send to haiku. ctx.model is sticky to what was
              // asked for (only switchModel changes it).
              { sessionId: response.sessionId ?? usedResume, model: ctx.model },
            );
            return { value: parsed, ctx: nextCtx };
          }
          graph.finishOk(
            node.id,
            { text: response.text, durationMs: response.durationMs, appliedForkFlag, composedPrompt, resumeCommand },
            { sessionId: response.sessionId ?? usedResume, model: ctx.model },
          );
          return { value: response.text, ctx: nextCtx };
        }

        // --- callback-expanding nodes --------------------------------------
        case "pipe": {
          const fn = node.callbacks.fn;
          const subSession = new Session({
            sessionId: randomId(),
            model: ctx.model,
            cwd: ctx.cwd,
            graph,
            tipNodeId: node.id,
            // Anchor the body's lexical container to THIS node so the UI
            // nests the pipe's children under it (containerId defaults to
            // rootId, which would flatten the whole subtree onto the root).
            containerId: node.id,
          });
          const subTip = fn(subSession);
          const sub = await this.runChain(graph, node.id, subTip.tipNodeId, ctx, upstream);
          graph.finishOk(node.id, { ok: true });
          return { value: sub.value, ctx: sub.ctx };
        }
        case "combineWith": {
          const exec = node.callbacks.execution;
          const combine = node.callbacks.combine;
          // Anchor the execution-callback's sub-description under a synthetic
          // `combineBranch` wrapper so the UI can visibly indent the sub-chain
          // while outer-chain followups (which also attach to this combineWith
          // node) stay at the parent's indent level.
          const branchNode = graph.create({ parentId: node.id, kind: "combineBranch", label: "combineBranch" });
          graph.start(branchNode.id);
          const branchSession = new SessionWithResult<unknown>({
            sessionId: randomId(),
            model: ctx.model,
            cwd: ctx.cwd,
            graph,
            tipNodeId: branchNode.id,
            // Anchor the sub-chain under the combineBranch wrapper (containerId
            // defaults to rootId) so the UI indents it instead of flattening.
            containerId: branchNode.id,
          });
          installResult(branchSession, upstream);
          const subTip = exec(branchSession);
          const sub = await this.runChain(graph, branchNode.id, subTip.tipNodeId, ctx, upstream);
          graph.finishOk(branchNode.id, safeValue(sub.value));
          const joint = combine(upstream, sub.value);
          graph.finishOk(node.id, { joint: safeValue(joint) });
          return { value: joint, ctx: sub.ctx };
        }
        case "parallelFork": {
          const apply = node.callbacks.apply;
          const { inputs } = node.input;
          // Promise.all semantics: any child that throws cancels siblings and
          // propagates. Users opt into per-child error-materialization by
          // calling .materializeError(msg) inside their apply (typically from a
          // try/tryMultipleTimes fallback).
          const results = await Promise.all(
            inputs.map(async (input, i) => {
              const childNode = graph.create({
                parentId: node.id,
                kind: "parallelChild",
                label: `child #${i}`,
                input: { index: i, input },
              });
              graph.start(childNode.id);
              const childCtx: RunCtx = {
                driverSessionId: null,
                model: ctx.model,
                cwd: ctx.cwd,
                // Inherit the parent's branch (like model/cwd). In bug_solving
                // the parent is unbranched and each child sets its own branch
                // via switchBranch inside its apply body.
                branchId: ctx.branchId,
                prepend: [],
                append: [],
                pendingFork: false,
                pendingForkNodeId: null,
                pendingCompact: false,
                pendingCompactNodeId: null,
              };
              const childSession = new Session({
                sessionId: randomId(),
                model: ctx.model,
                cwd: ctx.cwd,
                graph,
                tipNodeId: childNode.id,
                // Lexical container anchor = this child node so its subtree
                // nests under the parallelChild (not the root).
                containerId: childNode.id,
              });
              try {
                const subTip = apply(childSession, input, i);
                const sub = await this.runChain(graph, childNode.id, subTip.tipNodeId, childCtx, undefined);
                graph.finishOk(childNode.id, safeValue(sub.value));
                return sub.value;
              } catch (e) {
                graph.finishErr(childNode.id, e);
                throw e;
              }
            }),
          );
          graph.finishOk(node.id, { count: results.length });
          return { value: results, ctx };
        }
        case "try": {
          const code = node.callbacks.code;
          const fallback = node.callbacks.fallback;
          try {
            const s = new Session({ sessionId: randomId(), model: ctx.model, cwd: ctx.cwd, graph, tipNodeId: node.id, containerId: node.id });
            const subTip = code(s);
            const sub = await this.runChain(graph, node.id, subTip.tipNodeId, ctx, upstream);
            graph.finishOk(node.id, { ok: true });
            return { value: sub.value, ctx: sub.ctx };
          } catch (err) {
            const fbNode = graph.create({
              parentId: node.id,
              kind: "tryFallback",
              label: "fallback",
              input: { error: describeError(err) },
            });
            graph.start(fbNode.id);
            try {
              const s = new Session({ sessionId: randomId(), model: ctx.model, cwd: ctx.cwd, graph, tipNodeId: fbNode.id, containerId: fbNode.id });
              const subTip = fallback(s, err);
              const sub = await this.runChain(graph, fbNode.id, subTip.tipNodeId, ctx, upstream);
              graph.finishOk(fbNode.id, safeValue(sub.value));
              graph.finishOk(node.id, { recovered: true });
              return { value: sub.value, ctx: sub.ctx };
            } catch (err2) {
              graph.finishErr(fbNode.id, err2);
              graph.finishErr(node.id, err2);
              throw err2;
            }
          }
        }
        case "tryMultipleTimes": {
          const { max } = node.input;
          const code = node.callbacks.code;
          const fallback = node.callbacks.fallback;
          let lastErr: unknown = null;
          let attemptCtx = ctx;
          // auto-inject Interrupt contract on every attempt
          attemptCtx = { ...attemptCtx, append: [...attemptCtx.append] };
          for (let i = 1; i <= max; i++) {
            const attNode = graph.create({
              parentId: node.id,
              kind: "tryAttempt",
              label: `attempt ${i}/${max}`,
            });
            graph.start(attNode.id);
            try {
              const s = new Session({ sessionId: randomId(), model: attemptCtx.model, cwd: attemptCtx.cwd, graph, tipNodeId: attNode.id, containerId: attNode.id });
              const subTip = code(s);
              const interruptCtx: RunCtx = {
                ...attemptCtx,
                append: [
                  ...attemptCtx.append,
                  'If you want to abandon this task, respond with a JSON object {"InterruptException": "<reason>"} and no other fields.',
                ],
              };
              const sub = await this.runChain(graph, attNode.id, subTip.tipNodeId, interruptCtx, upstream);
              graph.finishOk(attNode.id, safeValue(sub.value));
              graph.finishOk(node.id, { attempts: i });
              return { value: sub.value, ctx: sub.ctx };
            } catch (err) {
              lastErr = err;
              graph.finishErr(attNode.id, err);
              if (err instanceof InterruptException) break;
              // Carry the worker's session FORWARD so the next attempt RESUMES
              // it (full conversation history across all rounds) rather than
              // starting cold with only an error string. We resume this
              // attempt's first top-level send — the analyze/fix turn — not the
              // verdict forks (which are independent judges with their own
              // sessions). Identify it by containerId === this attempt node.
              const resumeId = graph.allNodes()
                .filter((n) => n.kind === "send" && n.containerId === attNode.id && n.sessionId)
                .sort((a, b) => a.createdAt - b.createdAt)[0]?.sessionId ?? null;
              attemptCtx = {
                ...attemptCtx,
                // Resume the same conversation next round when we found it.
                driverSessionId: resumeId ?? attemptCtx.driverSessionId,
                prepend: resumeId
                  // The resumed session already holds every prior round, so we
                  // only add the NEW failure — no re-stating old errors.
                  ? [`Your previous attempt did not pass: ${describeError(err)}. You retain the FULL context of your earlier rounds in this same conversation. Diagnose what went wrong and try a DIFFERENT approach — do not repeat a fix the verdict already rejected.`]
                  // Fresh-session fallback: accumulate errors so context isn't lost.
                  : [
                      ...attemptCtx.prepend,
                      `Previous attempt failed: ${describeError(err)}. Diagnose the cause before retrying.`,
                    ],
              };
            }
          }
          const fbNode = graph.create({
            parentId: node.id,
            kind: "tryFallback",
            label: "fallback after retries",
            input: { error: describeError(lastErr) },
          });
          graph.start(fbNode.id);
          try {
            const s = new Session({ sessionId: randomId(), model: ctx.model, cwd: ctx.cwd, graph, tipNodeId: fbNode.id, containerId: fbNode.id });
            const subTip = fallback(s, lastErr);
            const sub = await this.runChain(graph, fbNode.id, subTip.tipNodeId, ctx, upstream);
            graph.finishOk(fbNode.id, safeValue(sub.value));
            graph.finishOk(node.id, { recovered: true });
            return { value: sub.value, ctx: sub.ctx };
          } catch (err2) {
            graph.finishErr(fbNode.id, err2);
            graph.finishErr(node.id, err2);
            throw err2;
          }
        }

        // --- result-consuming nodes (SessionWithResult API) ----------------
        case "executeShell": {
          const build = node.callbacks.buildCommand;
          const cmd = build(upstream);
          graph.setLabel(node.id, `executeShell: ${truncate(cmd, 60)}`);
          graph.start(node.id, { input: { cmd } });
          const stdout = await runShell({ cmd, cwd: ctx.cwd, io: this.io, branchId: ctx.branchId });
          graph.finishOk(node.id, { stdoutTail: stdout.slice(-400) });
          return { value: stdout, ctx };
        }
        case "assert": {
          const check = node.callbacks.check;
          check(upstream);
          graph.finishOk(node.id, { ok: true });
          return { value: upstream, ctx };
        }
        case "materializeError": {
          // Replaces the upstream value with { error: <arg> }. Does NOT catch
          // thrown errors — that's try/tryMultipleTimes' job. This node is a
          // constructor for error-typed results, used inside fallbacks.
          const { error } = node.input;
          const value: Result<unknown> = { error };
          graph.finishOk(node.id, { value });
          return { value, ctx };
        }
        case "root": {
          return { value: undefined, ctx };
        }
      }
    } catch (e) {
      graph.finishErr(node.id, e);
      throw attachNodeMeta(e, node.id, ctx.driverSessionId);
    }
    // Exhaustiveness fallthrough — should not happen.
    throw new Error(`unknown node kind: ${(node as { kind?: unknown }).kind}`);
  }

  /**
   * Compose prepend/append buffers + the node's prompt, materialize any
   * pending fork/compact against the CLI, then invoke the caller's CLI
   * function with (resumeSid, forkFlag, composedPrompt). Returns the response
   * plus an updated ctx.
   */
  private async materializeAndCall<Resp extends { sessionId: string | null; isError: boolean; errorMessage: string | null; raw: unknown; stderr: string }>(
    graph: ComputationGraph,
    node: RichGraphNode,
    ctx: RunCtx,
    invoke: (resumeSid: string | null, forkFlag: boolean, composedPrompt: string) => Promise<Resp>,
    rawPrompt: string,
  ): Promise<{ ctx: RunCtx; response: Resp; usedResume: string | null; appliedForkFlag: boolean; composedPrompt: string }> {
    let resumeSid = ctx.driverSessionId;
    let applyForkFlag = false;

    if (ctx.pendingCompact) {
      if (resumeSid) {
        const compactResp = await this.driver.compact({
          prompt: "/compact",
          model: ctx.model,
          resume: resumeSid,
          fork: ctx.pendingFork,
          cwd: ctx.cwd,
          branchId: ctx.branchId,
          io: this.io,
        });
        if (compactResp.isError) {
          throw new StructuredError(compactResp.errorMessage ?? "/compact failed", {
            sessionId: resumeSid,
            nodeId: ctx.pendingCompactNodeId,
            data: { raw: compactResp.raw, stderr: compactResp.stderr },
          });
        }
        resumeSid = compactResp.sessionId ?? resumeSid;
      }
      // else: no parent claude session — /compact skipped, node output already shows "queued".
    } else if (ctx.pendingFork) {
      if (resumeSid) applyForkFlag = true;
    }

    const prepend = ctx.prepend.length ? ctx.prepend.join("\n\n") + "\n\n" : "";
    const append = ctx.append.length ? "\n\n" + ctx.append.join("\n\n") : "";
    const composed = prepend + rawPrompt + append;

    // Expose the real composed prompt (prepend header + body + append) on the
    // running node's output BEFORE the CLI call, mirroring the scheduler
    // (scheduler.ts:534). Without this, a running send only showed the raw
    // `.send({prompt})` body — the monitor's "entire prompt sent to claude"
    // reveal was empty until finishOk. finishOk later replaces output (which
    // also carries composedPrompt), so display is consistent running→finished.
    graph.patchOutput(node.id, { composedPrompt: composed, partialText: "" });

    const response = await invoke(resumeSid, applyForkFlag, composed);

    const nextCtx: RunCtx = {
      driverSessionId: response.sessionId ?? resumeSid,
      model: ctx.model,
      cwd: ctx.cwd,
      branchId: ctx.branchId,
      prepend: [],
      append: [],
      pendingFork: false,
      pendingForkNodeId: null,
      pendingCompact: false,
      pendingCompactNodeId: null,
    };
    return {
      ctx: nextCtx,
      response,
      usedResume: resumeSid,
      appliedForkFlag: applyForkFlag,
      // Composed prompt = prepend blocks + caller's raw prompt + append
      // blocks. The monitor surfaces this via a "Show entire prompt"
      // reveal in the detail panel — useful for diagnosing why a model
      // saw context the caller's own `prompt` string never carried.
      composedPrompt: composed,
    };
  }
}

// ---- helpers ----------------------------------------------------------------

let _signalsInstalled = false;
function installShutdownHooks(engine: Engine) {
  if (_signalsInstalled) return;
  _signalsInstalled = true;
  const handler = async (sig: string) => {
    try { await engine.shutdown(); } catch {}
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", () => handler("SIGINT"));
  process.once("SIGTERM", () => handler("SIGTERM"));
}

function installResult<T>(swr: SessionWithResult<T>, value: unknown): void {
  Object.defineProperty(swr, "result", { value: () => value as T, configurable: true });
}

function attachNodeMeta(e: unknown, nodeId: string, sessionId: string | null): unknown {
  if (e && typeof e === "object") {
    const meta = e as { nodeId?: string; sessionId?: string | null };
    try { meta.nodeId ??= nodeId; meta.sessionId ??= sessionId; } catch {}
  }
  return e;
}

/**
 * Typia's `typia.json.schema<T>()` returns a unit with the shape:
 *   { version: "3.1", schema: { $ref: "#/components/schemas/Foo" }, components: {schemas: {...}} }
 * Claude CLI's `--json-schema` flag wants a single self-contained JSON Schema
 * object. This helper inlines a top-level `$ref` against the unit's components
 * so the resulting object is standalone.
 */
/** A JSON-Schema fragment is an untyped object tree keyed by string. */
type JsonSchemaObject = Record<string, unknown>;

/** typia's schema unit: a root schema plus the components it may $ref into. */
interface SchemaUnit {
  schema: JsonSchemaObject;
  components?: JsonSchemaObject;
}

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
  // "#/components/schemas/Foo" → components.schemas.Foo
  const parts = ref.replace(/^#\//, "").split("/");
  let cur: unknown = { components };
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur != null && typeof cur === "object" ? (cur as JsonSchemaObject) : null;
}

/**
 * A Session API PromptInput<T> is either a string or `(upstream: T) => string`.
 * Evaluate it against the real upstream value at execution time.
 */
function resolvePrompt(p: unknown, upstream: unknown): string {
  if (typeof p === "function") {
    try {
      const v = (p as (u: unknown) => unknown)(upstream);
      return typeof v === "string" ? v : String(v);
    } catch (e) {
      throw new StructuredError(
        `prompt function threw: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }
  return typeof p === "string" ? p : "";
}

function safeStringify(v: unknown): string {
  try { return JSON.stringify(v); } catch { return String(v); }
}
function safeValue(v: unknown): unknown {
  try { JSON.stringify(v); return v; } catch { return String(v); }
}
function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  return "sp_" + Math.random().toString(36).slice(2, 10);
}

export async function runShell(args: { cmd: string; cwd: string; io: IO; nodeId?: string; branchId?: string }): Promise<string> {
  const { cmd, cwd, io, nodeId, branchId } = args;
  const r = await io.spawnCapture({ command: "bash", args: ["-c", cmd], cwd, nodeId, branchId });
  if (r.spawnError) {
    throw new StructuredError(`shell spawn failed: ${r.spawnError}`);
  }
  if (r.exitCode !== 0) {
    throw new StructuredError(
      `shell command failed (code ${r.exitCode}): ${cmd}\n${r.stderr.slice(-800)}`,
    );
  }
  return r.stdout;
}

/**
 * Public engines = the shared `Engine` + a pre-bound `ModelDriver`, wired by
 * COMPOSITION (each HAS-A `Engine`), NOT inheritance. Both reuse 100% of the
 * engine logic; the only difference is which driver is injected. The public
 * surface (`execute`, `shutdown`, `currentGraph`, `monitorUrl`, `io`) is
 * delegated 1:1. (The handful of delegating lines are duplicated rather than
 * shared via a base class, to keep this strictly composition.)
 */
export class ClaudeEngine {
  private readonly engine: Engine;
  readonly io: IO;
  constructor(opts: EngineOptions = {}) {
    this.engine = new Engine(claudeDriver, opts);
    this.io = this.engine.io;
  }
  /** See Engine.useScheduler. Default false (legacy interpreter path). */
  get useScheduler(): boolean { return this.engine.useScheduler; }
  set useScheduler(v: boolean) { this.engine.useScheduler = v; }
  execute<R>(session: Session, calculation: (s: Session) => SessionWithResult<R>): Promise<R> {
    return this.engine.execute(session, calculation);
  }
  shutdown(): Promise<void> { return this.engine.shutdown(); }
  get currentGraph(): ComputationGraph | null { return this.engine.currentGraph; }
  get monitorUrl(): string | null { return this.engine.monitorUrl; }
}

export class CodexEngine {
  private readonly engine: Engine;
  readonly io: IO;
  constructor(opts: EngineOptions = {}) {
    this.engine = new Engine(codexDriver, opts);
    this.io = this.engine.io;
  }
  /** See Engine.useScheduler. Default false (legacy interpreter path). */
  get useScheduler(): boolean { return this.engine.useScheduler; }
  set useScheduler(v: boolean) { this.engine.useScheduler = v; }
  execute<R>(session: Session, calculation: (s: Session) => SessionWithResult<R>): Promise<R> {
    return this.engine.execute(session, calculation);
  }
  shutdown(): Promise<void> { return this.engine.shutdown(); }
  get currentGraph(): ComputationGraph | null { return this.engine.currentGraph; }
  get monitorUrl(): string | null { return this.engine.monitorUrl; }
}

export { Claude };
