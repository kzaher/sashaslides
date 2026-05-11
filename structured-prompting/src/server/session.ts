import type { IJsonSchemaUnit } from "@typia/interface";
import type { ClaudeModel, Result } from "./types.js";
import {
  ComputationGraph,
  type AssertCheckCallback,
  type CombineExecutionCallback,
  type CombineMergeCallback,
  type RichGraphNode,
  type ParallelApplyCallback,
  type PipeCallback,
  type ShellBuildCallback,
  type TryCodeCallback,
  type TryFallbackCallback,
} from "./graph.js";

/** Common fields for any CLI call — shared by send. */
export interface CommonSendArguments {
  base64_attachments?: string[];
  /** Per-call CLI timeout in ms. */
  timeout?: number;
}

/** Prompt may be a literal string or a function of the upstream result value. */
export type PromptFn<T> = (upstream: T) => string;
export type PromptInput<T = unknown> = string | PromptFn<T>;

/**
 * Unified send options.
 *
 * When `schema` is a typia-generated JSON schema unit
 * (`typia.json.schema<T>()`) the engine:
 *   1. Serializes schema + components into a JSON-Schema blob.
 *   2. Appends it to the prompt tail so the model knows the target shape.
 *   3. Parses the reply as JSON and returns it typed as the original `T`.
 *
 * The generic `R` is carried by the schema's phantom `__type` property, so
 * users write their TypeScript type normally:
 *
 *   type Measured = { measuredValue: string };
 *   .send({ schema: typia.json.schema<Measured>(), prompt: "..." })
 *   // → SessionWithResult<Measured>
 *
 * When `schema` is omitted the reply is returned as raw `string`.
 */
export interface SendOptions<_R = string, T = unknown> extends CommonSendArguments {
  /** Prompt body — literal string or `(upstream) => string` evaluated at exec time. */
  prompt: PromptInput<T>;
  /**
   * Optional schema. Produced by `typia.json.schema<T>()`. Its phantom
   * `__type` parameter carries T so the `send` overloads can infer the
   * result type without any explicit generic on `send<...>`.
   */
  schema?: IJsonSchemaUnit;
}

/**
 * The Session API is a *synchronous, immutable* description-builder. Every
 * method appends one node to `graph` and returns a new Session handle whose
 * `tipNodeId` points at that node. No CLI calls, no async work, no model
 * calls happen until ClaudeEngine.execute() walks the description.
 *
 * Key invariants:
 *  - All Session/ForkedSession/CompactedSession/SessionWithResult methods are
 *    synchronous.
 *  - The only exception to immutability is the shared `graph`, which is
 *    mutated to append nodes — this is the "computation graph assigned to
 *    every session" from the README spec.
 *  - Callbacks passed to combineWith / parallelFork / try / tryMultipleTimes /
 *    pipe are stored on the node and invoked later by the engine — at which
 *    time they may themselves call Session methods, growing the graph under
 *    the node that invoked them.
 */

export interface SessionInit {
  sessionId?: string;
  model?: ClaudeModel;
  cwd?: string;
  graph?: ComputationGraph;
  tipNodeId?: string;
  /**
   * Lexical container — the anchor node (root, parallelChild, tryAttempt,
   * combineBranch, …) that this Session is "inside". Every chain step
   * built off this Session shares the same containerId, so the UI groups
   * `a().b().c()` as siblings under the anchor. Defaults to the graph's
   * rootId; the engine overrides it when constructing sub-sessions inside
   * a callback.
   */
  containerId?: string;
  // Phantom marker so SessionWithResult<T> can be reconstructed across clones.
  resultTypeMarker?: unknown;
}

// Types for the callbacks stored on description nodes. The engine invokes
// these during execution. At build time the user's code passes in functions
// of the same shape; at exec time, the engine calls them with real, resolved
// SessionWithResult<T> handles.
export type DescFn<S, R> = (s: S) => R;
export type CombineExecFn<T, R> = (s: SessionWithResult<T>) => SessionWithResult<R>;
export type CombineFn<T, R, J> = (left: T, right: R) => J;
export type ParallelApplyFn<T, R> = (s: Session, input: T, index: number) => SessionWithResult<R>;
export type TryFn<R> = (s: Session) => SessionWithResult<R>;
export type TryFallbackFn<R> = (s: Session, err: unknown) => SessionWithResult<R>;

export class Session {
  readonly sessionId: string;
  readonly model: ClaudeModel;
  readonly cwd: string;
  readonly graph: ComputationGraph;
  readonly tipNodeId: string;
  /** Lexical container anchor; see SessionInit.containerId. */
  readonly containerId: string;

  constructor(init: SessionInit = {}) {
    this.sessionId = init.sessionId ?? randomId();
    this.model = init.model ?? "opus";
    this.cwd = init.cwd ?? (typeof process !== "undefined" ? process.cwd() : "/");
    this.graph = init.graph ?? new ComputationGraph(this.sessionId);
    this.tipNodeId = init.tipNodeId ?? this.graph.rootId;
    this.containerId = init.containerId ?? this.graph.rootId;
  }

  // --- core chainable operations (all sync, build description nodes) ------

  prependToNextPrompt(prefix: string): Session {
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "prependToNextPrompt",
      label: `prepend: ${truncate(prefix, 48)}`,
      input: { text: prefix },
    });
    return this.at(node.id);
  }

  appendToNextPrompt(suffix: string): Session {
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "appendToNextPrompt",
      label: `append: ${truncate(suffix, 48)}`,
      input: { text: suffix },
    });
    return this.at(node.id);
  }

  switchModel(model: ClaudeModel): Session {
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "switchModel",
      label: `switchModel(${model})`,
      input: { model },
    });
    return this.withModel(model).at(node.id);
  }

  /**
   * Start a fresh claude conversation. If `model` is provided, the new
   * session uses it; otherwise it inherits the current session's model.
   * Equivalent to `.newSession().switchModel(m)` but without the extra graph
   * node.
   */
  newSession(model?: ClaudeModel): Session {
    const effective = model ?? this.model;
    const label = model ? `newSession(${model})` : "newSession";
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "newSession",
      label,
      input: { model: effective },
    });
    return new Session({
      sessionId: randomId(),
      model: effective,
      cwd: this.cwd,
      graph: this.graph,
      tipNodeId: node.id,
      containerId: this.containerId,
    });
  }

  /**
   * Overload 1 — explicit `schema: typia.json.schema<T>()`: R is inferred from
   * the schema's phantom `__type`. Use this when you want to skip the build-
   * time transformer.
   */
  send<U extends IJsonSchemaUnit>(
    args: CommonSendArguments & { prompt: PromptInput<unknown>; schema: U },
  ): SessionWithResult<NonNullable<U["__type"]>>;
  /**
   * Overload 2 — `.send<T>({prompt})`: the build step's AST transformer
   * (src/transformer.ts) rewrites this call to include
   * `schema: typia.json.schema<T>()` before typia's esbuild plugin inlines it.
   * R defaults to `string` when no type argument is given (plain text reply).
   */
  send<R = string>(
    args: CommonSendArguments & { prompt: PromptInput<unknown> },
  ): SessionWithResult<R>;
  // Implementation signature carries an unknown args bag; the public
  // overloads above narrow it for callers. Internally we only inspect a
  // handful of well-known fields (`schema`, `prompt`).
  send(args: CommonSendArguments & {
    prompt: PromptInput<unknown>;
    schema?: IJsonSchemaUnit;
  }): SessionWithResult<unknown> {
    const hasSchema = args && args.schema !== undefined;
    const tail = hasSchema ? " <schema>" : "";
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "send",
      label: `send${tail}: ${promptLabel(args.prompt, 48)}`,
      input: { ...args },
    });
    return this.withResultAt<unknown>(node.id);
  }

  fork(): ForkedSession {
    const node = this.graph.create({ parentId: this.tipNodeId, containerId: this.containerId, kind: "fork", label: "fork" });
    return new ForkedSession({
      sessionId: randomId(),
      model: this.model,
      cwd: this.cwd,
      graph: this.graph,
      tipNodeId: node.id,
      containerId: this.containerId,
    });
  }

  /**
   * Run a shell command at the orchestrator level, before any send in this
   * chain — the command string is constant, no upstream value is needed.
   * Returns a SessionWithResult<string> so later chain steps (send,
   * executeShell, combineWith, …) all work normally. This is the idiomatic
   * way to start a chain with a deterministic shell step rather than asking
   * the model to run a command via its Bash tool. The engine's existing
   * "executeShell" node kind is reused; buildCommand just ignores the
   * (undefined) upstream.
   */
  executeShell(buildCommand: () => string): SessionWithResult<string> {
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "executeShell",
      label: "executeShell",
      callbacks: { buildCommand: (buildCommand as unknown) as ShellBuildCallback },
    });
    return this.withResultAt<string>(node.id);
  }

  pipe<T>(fn: DescFn<Session, SessionWithResult<T>>): SessionWithResult<T> {
    // Lazy callback path: engine invokes fn at runtime (same reason as
    // parallelFork — user code inside fn may read files produced by
    // upstream nodes that don't exist at description-build time).
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "pipe",
      label: "pipe",
      callbacks: { fn: fn as PipeCallback },
    });
    return this.withResultAt<T>(node.id);
  }

  parallelFork<T, R>(
    inputs: readonly T[],
    apply: ParallelApplyFn<T, R>,
  ): SessionWithResult<R[]> {
    // Lazy callback path: the engine invokes apply per-input at
    // RUNTIME (after upstream nodes' outputs exist). Eager expansion
    // was attempted here in an earlier phase but reverted: user code
    // inside the apply callback frequently reads files produced by
    // upstream nodes (e.g. main.ts:342's `pixelDiffPng(baselinePath,
    // testPath, …)`), which don't exist at description-build time.
    // Predecessor wiring stays on the parallelFork node itself —
    // children created at runtime auto-default predecessors from
    // parentId via graph.create's auto-defaulter.
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "parallelFork",
      label: `parallelFork(n=${inputs.length})`,
      input: { count: inputs.length, inputs: [...inputs] },
      callbacks: { apply: apply as ParallelApplyCallback },
    });
    return this.withResultAt<R[]>(node.id);
  }

  try<R = string>(
    code: TryFn<R>,
    fallback: TryFallbackFn<R>
  ): SessionWithResult<R> {
    // Lazy callback path: engine invokes code/fallback at runtime.
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "try",
      label: "try",
      callbacks: {
        code: code as TryCodeCallback,
        fallback: fallback as TryFallbackCallback,
      },
    });
    return this.withResultAt<R>(node.id);
  }

  tryMultipleTimes<R = string>(
    max: number,
    code: TryFn<R>,
    fallback: TryFallbackFn<R> = (_s, e) => { throw e; },
  ): SessionWithResult<R> {
    // Lazy callback path: engine invokes code/fallback per attempt at runtime.
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "tryMultipleTimes",
      label: `tryMultipleTimes(max=${max})`,
      input: { max },
      callbacks: {
        code: code as TryCodeCallback,
        fallback: fallback as TryFallbackCallback,
      },
    });
    return this.withResultAt<R>(node.id);
  }

  /**
   * Construct an error-typed result in-place: `{ error: <arg> }`. Available on
   * Session (not just SessionWithResult) because try/tryMultipleTimes
   * fallbacks receive a bare Session and need to produce an error result
   * without an upstream value.
   *
   * Caller specifies the phantom T — typical usage is
   *   `s.materializeError<FinalResult>(safelyJsonStringify(e))`
   * which returns SessionWithResult<Result<FinalResult>>.
   */
  materializeError<T = unknown>(error: string): SessionWithResult<Result<T>> {
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "materializeError",
      label: `materializeError: ${truncate(error, 48)}`,
      input: { error },
    });
    return this.withResultAt<Result<T>>(node.id);
  }

  // ---- internal helpers -------------------------------------------------

  protected at(tipNodeId: string): Session {
    return new Session({
      sessionId: this.sessionId,
      model: this.model,
      cwd: this.cwd,
      graph: this.graph,
      tipNodeId,
      containerId: this.containerId,
    });
  }

  protected withModel(model: ClaudeModel): Session {
    return new Session({
      sessionId: this.sessionId,
      model,
      cwd: this.cwd,
      graph: this.graph,
      tipNodeId: this.tipNodeId,
      containerId: this.containerId,
    });
  }

  protected withResultAt<T>(tipNodeId: string): SessionWithResult<T> {
    return new SessionWithResult<T>({
      sessionId: this.sessionId,
      model: this.model,
      cwd: this.cwd,
      graph: this.graph,
      tipNodeId,
      containerId: this.containerId,
    });
  }
}

export class ForkedSession extends Session {
  /** Append a pending compact() node. Subsequent switchModel etc. chain under it. */
  compact(): CompactedSession {
    const node = this.graph.create({ parentId: this.tipNodeId, containerId: this.containerId, kind: "compact", label: "compact" });
    return new CompactedSession({
      sessionId: this.sessionId,
      model: this.model,
      cwd: this.cwd,
      graph: this.graph,
      tipNodeId: node.id,
      containerId: this.containerId,
    });
  }
}

// The CompactedSession only exists for the type-level README flow
// (fork → ForkedSession.compact → CompactedSession.switchModel). It inherits
// switchModel from Session and adds no new methods.
export class CompactedSession extends Session {}

/**
 * Phantom-typed handle pointing at a description node whose executed value
 * will be a T. At build time the T is never accessed; the engine fills it in
 * at execution time and passes it to `combine`, `assert`, `executeShell`,
 * etc. callbacks.
 */
export class SessionWithResult<T> extends Session {
  // Phantom property just to hold onto T for TS inference. Never read at
  // build time (no real value exists yet).
  declare readonly _phantomT?: T;

  /**
   * Declare a combined operation. The `execution` callback is invoked by the
   * engine at runtime with a SessionWithResult<T> whose .result() yields the
   * real upstream value, and must return a SessionWithResult<R> description.
   * `combine` is then called with the two real values to produce the joint.
   * If combine throws, the combineWith node fails.
   */
  combineWith<R, JointResult = T>(
    execution: CombineExecFn<T, R>,
    combine: CombineFn<T, R, JointResult> = ((left: T, _right: R) => left as unknown as JointResult),
  ): SessionWithResult<JointResult> {
    // Lazy callback path: engine invokes execution at runtime.
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "combineWith",
      label: "combineWith",
      callbacks: {
        execution: execution as CombineExecutionCallback,
        combine: combine as CombineMergeCallback,
      },
    });
    return this.withResultAt<JointResult>(node.id);
  }

  /**
   * Override `send` so the prompt function sees the typed upstream value T.
   * At runtime the engine evaluates the prompt function with the real
   * upstream before issuing the CLI call.
   */
  override send<U extends IJsonSchemaUnit>(
    args: CommonSendArguments & { prompt: PromptInput<T>; schema: U },
  ): SessionWithResult<NonNullable<U["__type"]>>;
  override send<R = string>(
    args: CommonSendArguments & { prompt: PromptInput<T> },
  ): SessionWithResult<R>;
  override send(args: CommonSendArguments & {
    prompt: PromptInput<T>;
    schema?: IJsonSchemaUnit;
  }): SessionWithResult<unknown> {
    return super.send(args);
  }

  /** Describe a shell command whose string form depends on the upstream result. */
  executeShell(buildCommand: (r: T) => string): SessionWithResult<string> {
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "executeShell",
      label: "executeShell",
      callbacks: { buildCommand: buildCommand as ShellBuildCallback },
    });
    return this.withResultAt<string>(node.id);
  }

  /** Run a user check at execution time; failure turns the upstream chain into an error. */
  assert(check: (r: T) => void): SessionWithResult<T> {
    const node = this.graph.create({
      parentId: this.tipNodeId,
      containerId: this.containerId,
      kind: "assert",
      label: "assert",
      callbacks: { check: check as AssertCheckCallback },
    });
    return this.withResultAt<T>(node.id);
  }

  /**
   * Phantom only — calling result() at build time before the engine has run
   * throws. The engine reads the resolved result from its internal execution
   * state keyed on node id.
   */
  result(): T {
    throw new Error(
      "SessionWithResult.result() was called at build time — results only exist during engine execution. " +
      "Access the value through the callbacks (combine, assert, executeShell) instead.",
    );
  }
}

// ---- utilities --------------------------------------------------------------

export function safelyJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    try { return String(v); } catch { return "<unstringifiable>"; }
  }
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

/** Label a PromptInput<T> for the graph row — show "<fn>" for function prompts. */
function promptLabel(p: unknown, n: number): string {
  if (typeof p === "function") return "<fn>";
  if (typeof p === "string") return truncate(p, n);
  return "";
}

function randomId(): string {
  const c = (typeof crypto !== "undefined" ? crypto : undefined) as
    | (Crypto & { randomUUID?: () => string })
    | undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // fallback — should never run under node 22+
  return "sp_" + Math.random().toString(36).slice(2, 10);
}

/**
 * Build a placeholder error object that the fallback callback receives at
 * description-build time. Every property access returns a substitution
 * token referencing the predecessor's error fields:
 *
 *   err.message → "{{<primaryTipId>.error.message}}"
 *   err.name    → "{{<primaryTipId>.error.name}}"
 *   String(err) → "{{<primaryTipId>.error}}"
 *
 * `describeError(err)` (in errors.ts) produces a JSON string with these
 * tokens baked in. At fire-time the scheduler / legacy engine resolves
 * tokens against the actual predecessor's `error` field.
 *
 * Uses a Proxy so unforeseen field accesses (e.g. `.data`, `.stack`)
 * produce tokens too, without us having to enumerate every field a user
 * might inspect.
 */
function makeErrPlaceholder(predecessorNodeId: string): unknown {
  const base = `{{${predecessorNodeId}.error`;
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive || prop === "toString") {
        return () => `${base}}}`;
      }
      if (prop === "toJSON") {
        return () => `${base}}}`;
      }
      if (typeof prop !== "string") return undefined;
      return `${base}.${prop}}}`;
    },
  });
}

/**
 * Walk backward from `tipId` along parentId until reaching the FIRST
 * descendant of `containerId` — i.e., the node at the root of a chain
 * that started directly off `containerId`. Used by try/tryMultipleTimes
 * to find the head of the fallback chain so its predecessor edge can
 * be re-targeted to fire on the primary's error instead of on the
 * `try` node itself (the default).
 */
function walkBackTo(graph: ComputationGraph, tipId: string, containerId: string): string | null {
  let cur: string | null = tipId;
  while (cur) {
    const n = graph.get(cur);
    if (!n) return null;
    if (n.parentId === containerId) return n.id;
    cur = n.parentId;
  }
  return null;
}

/**
 * Resolve `{{nodeId.error.field}}` substitution tokens against the
 * current graph state. Used by the legacy engine's `materializeAndCall`
 * (composing prepends into a final prompt) and by the v2 scheduler's
 * `send` handler (same composition step).
 *
 * Token grammar (intentionally minimal — only what try/tryMultipleTimes
 * actually emits):
 *   {{<uuid>.error}}           → predecessor.error itself as JSON string
 *   {{<uuid>.error.<field>}}   → predecessor.error[field] (commonly "message", "name")
 *
 * Unresolved tokens (predecessor doesn't exist, isn't errored, or the
 * field is missing) are replaced with "<unresolved:{token}>" so the
 * model still sees a parseable string — never silent corruption.
 */
export function resolveSubstitutions(text: string, graph: ComputationGraph): string {
  if (!text || !text.includes("{{")) return text;
  return text.replace(/\{\{([0-9a-f-]{8,})\.error(?:\.([a-zA-Z0-9_-]+))?\}\}/g, (full, nodeId: string, field?: string) => {
    const n = graph.get(nodeId);
    if (!n || !n.error) return `<unresolved:${full}>`;
    if (!field) {
      try { return JSON.stringify(n.error); } catch { return String(n.error.message); }
    }
    const v = (n.error as Record<string, unknown>)[field];
    if (v == null) return `<unresolved:${full}>`;
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

// Re-export ClaudeModel sugar from types for convenience.
export { Claude } from "./types.js";
export type { RichGraphNode };
