import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { IJsonSchemaUnit } from "@typia/interface";
import type { ClaudeModel, NodeStatus, GraphSnapshot, GraphNode as WireGraphNode, NodeDiff } from "../api/wire.js";
import type {
  CommonSendArguments,
  PromptInput,
  Session,
  SessionWithResult,
} from "./session.js";

// NodeStatus is re-exported as a convenience for server-side imports
// (engine, session) that already pulled it from this module — the wire
// definition in api/wire.ts is the source of truth.
export type { NodeStatus };

// --- Per-kind payload types -------------------------------------------------
//
// A discriminated union on `kind` is the single source of truth for what each
// node carries. Input shapes are what the Session API captures at build time;
// callbacks are the user-supplied functions the engine invokes at execution
// time.  Adding a new node kind means adding one line here AND handling it in
// the engine's switch — TS makes both required.

/** `session.send(args)` captures this as its input. */
export interface SendNodeInput extends CommonSendArguments {
  prompt: PromptInput<unknown>;
  schema?: IJsonSchemaUnit;
}

export type PipeCallback = (s: Session) => SessionWithResult<unknown>;
export type CombineExecutionCallback = (
  s: SessionWithResult<unknown>,
) => SessionWithResult<unknown>;
export type CombineMergeCallback = (
  left: unknown,
  right: unknown,
) => unknown;
export type ParallelApplyCallback = (
  s: Session,
  input: unknown,
  index: number,
) => SessionWithResult<unknown>;
/** One branch of a `parallelCombine` node — builds a sub-chain from a fresh
 *  session (lazy, like parallelFork's apply) so its nodes are created at runtime
 *  under the branch wrapper. The branches run CONCURRENTLY (Promise.all). */
export type ParallelBranchCallback = (s: Session) => SessionWithResult<unknown>;
/** Joins the N branch results (positional) into the parallelCombine node's value. */
export type ParallelCombineCallback = (...vals: unknown[]) => unknown;
export type TryCodeCallback = (s: Session) => SessionWithResult<unknown>;
export type TryFallbackCallback = (
  s: Session,
  err: unknown,
) => SessionWithResult<unknown>;
export type AssertCheckCallback = (r: unknown) => void;
export type ShellBuildCallback = (r: unknown) => string;

/**
 * The schema: for each NodeKind, the exact `input` and `callbacks` shapes it
 * carries. Kinds without callbacks simply omit the `callbacks` field.
 */
export interface NodeKindSchemas {
  root: { input: null };
  send: { input: SendNodeInput };
  /** Ad-hoc follow-up Q against an existing send. Created post-hoc by
   *  POST /api/ask, NOT by the engine's main interpretation pass. The
   *  resume anchor is the nearest ancestor (via parentId) carrying a
   *  sessionId; the new node nests visually under the CLICKED node
   *  (which may be a parallelFork / pipe / root with no sessionId of
   *  its own). `anchorNodeId` records which ancestor was used. Always
   *  resumes with --fork-session so the original branch stays clean. */
  askFollowup: { input: { prompt: string; anchorNodeId?: string } };
  fork: { input: null };
  compact: { input: null };
  switchModel: { input: { model: ClaudeModel } };
  switchCwd: { input: { cwd: string } };
  /** Opt-in overlay-branch anchor: every command in this context's chain runs
   *  inside the named overlayfs branch (namespace-local COW mount over the
   *  working tree). See io.ts spawn injection. */
  switchBranch: { input: { branchId: string } };
  newSession: { input: { model: ClaudeModel } };
  prependToNextPrompt: { input: { text: string } };
  appendToNextPrompt: { input: { text: string } };
  materializeError: { input: { error: string } };
  parallelChild: { input: { index: number; input: unknown } };
  tryAttempt: { input: null };
  tryFallback: { input: { error: unknown } };
  combineBranch: { input: null };

  pipe: {
    input: null;
    callbacks: { fn: PipeCallback };
  };
  combineWith: {
    input: null;
    callbacks: {
      execution: CombineExecutionCallback;
      combine: CombineMergeCallback;
    };
  };
  parallelFork: {
    input: { count: number; inputs: readonly unknown[] };
    callbacks: { apply: ParallelApplyCallback };
  };
  /** N heterogeneous branches run CONCURRENTLY (Promise.all), then a combine
   *  lambda joins their (positional) results. Like parallelFork + a final
   *  reducer, but each branch is its own typed sub-chain rather than one apply
   *  over a homogeneous input list. Surfaced via Session.parallelCombineWith{1..5}. */
  parallelCombine: {
    input: { count: number };
    callbacks: { branches: ParallelBranchCallback[]; combine: ParallelCombineCallback };
  };
  try: {
    input: null;
    callbacks: { code: TryCodeCallback; fallback: TryFallbackCallback };
  };
  tryMultipleTimes: {
    input: { max: number };
    callbacks: { code: TryCodeCallback; fallback: TryFallbackCallback };
  };
  assert: {
    input: null;
    callbacks: { check: AssertCheckCallback };
  };
  executeShell: {
    input: null;
    callbacks: { buildCommand: ShellBuildCallback };
  };
}

/** Derived: every node kind known to the library. */
/**
 * Local alias derived from NodeKindSchemas. Should be structurally identical
 * to api's NodeKind union — if you add a kind, add it to api/wire.ts too.
 * Not re-exported because api's NodeKind is the public/wire-level source of
 * truth and server-internal code can rely on either.
 */
type NodeKind = keyof NodeKindSchemas;

interface GraphNodeBase {
  id: string;
  parentId: string | null;
  /**
   * Lexical container — the anchor node (root, parallelChild, tryAttempt,
   * combineBranch, tryFallback, pipe) that the user code building this node
   * is "inside". Every chain step inside the same lambda body shares the
   * same containerId. The UI tree groups siblings by containerId so a
   * linear chain `a().b().c()` renders as 3 siblings under one container,
   * not as a 3-deep diagonal cascade. Engine execution still uses parentId.
   */
  containerId: string | null;
  label: string;
  status: NodeStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  model: string | null;
  sessionId: string | null;
  /** Populated by the engine at execution time. */
  output: unknown;
  error: { message: string; stack?: string; data?: unknown } | null;
  children: string[];
  /** Working-tree git diff captured after file-mutating nodes. See NodeDiff. */
  diff?: NodeDiff | null;
}

/**
 * RichGraphNode is a discriminated union on `kind`. In a `switch(node.kind) {
 * case "parallelFork": ... }` TypeScript narrows the variant so
 * `node.callbacks.apply` has the exact function type and `node.input.inputs`
 * is `readonly unknown[]` — no casts needed.
 */
export type RichGraphNode = {
  [K in NodeKind]: GraphNodeBase & { kind: K } & NodeKindSchemas[K];
}[NodeKind];

/**
 * The create() arg object for a specific kind — mirrors its NodeKindSchemas
 * entry. `input` becomes optional when the kind's schema declares `input: null`
 * (fork/compact/tryAttempt/…), so callers can omit it. Callbacks stay
 * required for kinds that declare them.
 */
type InputField<K extends NodeKind> = NodeKindSchemas[K]["input"] extends null
  ? { input?: null }
  : { input: NodeKindSchemas[K]["input"] };

type CallbacksField<K extends NodeKind> = "callbacks" extends keyof NodeKindSchemas[K]
  ? { callbacks: (NodeKindSchemas[K] & { callbacks: unknown })["callbacks"] }
  : { callbacks?: undefined };

export type CreateArgs<K extends NodeKind> = {
  parentId: string | null;
  /** Lexical container; defaults to parentId when omitted. */
  containerId?: string | null;
  label: string;
  kind: K;
} & InputField<K> & CallbacksField<K>;

export class ComputationGraph {
  readonly id: string;
  private nodes = new Map<string, RichGraphNode>();
  readonly rootId: string;
  startedAt = Date.now();
  finishedAt: number | null = null;
  version = 0;
  /** When set, every mutation (`this.version++`) writes the snapshot here as
   *  JSON. Lets the monitor server outlive the engine process — restart and
   *  point a viewer at the file to keep asking ad-hoc follow-ups. Wiring is
   *  best-effort; a write failure logs to stderr but never throws. */
  private persistPath: string | null = null;

  constructor(label = "root") {
    this.id = randomUUID();
    const root: RichGraphNode = {
      id: randomUUID(),
      parentId: null,
      containerId: null,
      kind: "root",
      label,
      status: "pending",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      model: null,
      sessionId: null,
      input: null,
      output: null,
      error: null,
      children: [],
    };
    this.nodes.set(root.id, root);
    this.rootId = root.id;
  }

  /** Enable persistence-on-mutate. Writes immediately so the file exists even
   *  for never-touched graphs. No-op when `path` is null. */
  enablePersistence(path: string | null) {
    this.persistPath = path;
    if (path) this.persist();
  }

  private persist() {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.snapshot()));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[graph] persist failed:", (err as Error).message);
    }
  }

  /** Rebuild a graph from a snapshot. Used by view-graph.ts to boot a
   *  read-only monitor against a saved run. Callbacks are NOT preserved
   *  (snapshot strips them) — only post-hoc askFollowup mutations are
   *  expected on a restored graph. */
  static fromSnapshot(snap: ReturnType<ComputationGraph["snapshot"]>): ComputationGraph {
    const g = new ComputationGraph();
    g.hydrate(snap);
    return g;
  }

  /** Replace this graph's contents with a snapshot. Internal helper for
   *  fromSnapshot — keeps private-field access local instead of forcing
   *  fromSnapshot through unsafe casts. */
  private hydrate(snap: ReturnType<ComputationGraph["snapshot"]>) {
    (this as { id: string }).id = snap.id;
    this.nodes = new Map();
    for (const n of snap.nodes) this.nodes.set(n.id, n as RichGraphNode);
    (this as { rootId: string }).rootId = snap.rootId;
    this.startedAt = snap.startedAt;
    this.finishedAt = snap.finishedAt;
    this.version = snap.version;
    this.persistPath = null;
  }

  /**
   * Create a node of a specific kind. The compiler enforces that `input`
   * (and `callbacks`, where applicable) match the shape declared in
   * `NodeKindSchemas[K]`.
   */
  create<K extends NodeKind>(args: CreateArgs<K>): Extract<RichGraphNode, { kind: K }> {
    const { parentId, kind, label } = args;
    const containerId = (args as { containerId?: string | null }).containerId ?? parentId;
    // Runtime object. The field layout is identical for every variant — only
    // the types of `input` / `callbacks` vary per kind, and those are enforced
    // by the CreateArgs<K> constraint above.
    const node = {
      id: randomUUID(),
      parentId,
      containerId,
      kind,
      label,
      status: "pending" as NodeStatus,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      model: null,
      sessionId: null,
      input: ("input" in args ? (args as { input: unknown }).input : null) ?? null,
      output: null,
      error: null,
      children: [] as string[],
      ...(("callbacks" in args)
        ? { callbacks: (args as { callbacks: unknown }).callbacks }
        : {}),
    } as unknown as Extract<RichGraphNode, { kind: K }>;
    this.nodes.set(node.id, node);
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) parent.children.push(node.id);
      // Auto-wire a default predecessor edge from parentId. The scheduler
      // can run a parentId-built graph without the description-builder
      // having to call setPredecessors() everywhere. Override later (e.g.
      // parallelFork's aggregator) by calling setPredecessors() directly.
      (node as { predecessors?: import("../api/wire.js").PredecessorEdge[] }).predecessors = [
        { nodeId: parentId, condition: "ok" },
      ];
    }
    this.version++;
    this.persist();
    return node;
  }

  start(id: string, extra: Partial<Pick<GraphNodeBase, "model" | "sessionId"> & { input: unknown }> = {}) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.status = "running";
    n.startedAt = Date.now();
    if (extra.model !== undefined) n.model = extra.model;
    if (extra.sessionId !== undefined) n.sessionId = extra.sessionId;
    if (extra.input !== undefined) (n as { input: unknown }).input = extra.input;
    this.version++;
    this.persist();
  }

  finishOk(id: string, output: unknown, extra: Partial<Pick<GraphNodeBase, "sessionId" | "model">> = {}) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.status = "ok";
    n.finishedAt = Date.now();
    n.output = output;
    if (extra.sessionId !== undefined) n.sessionId = extra.sessionId;
    if (extra.model !== undefined) n.model = extra.model;
    this.version++;
    this.persist();
  }

  finishErr(id: string, err: unknown) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.status = "error";
    n.finishedAt = Date.now();
    const e = (err && typeof err === "object" ? err : {}) as {
      message?: unknown;
      stack?: unknown;
    };
    n.error = {
      message: typeof e.message === "string" ? e.message : String(err),
      stack: typeof e.stack === "string" ? e.stack : undefined,
      data: err && typeof err === "object" ? { ...(err as object) } : undefined,
    };
    this.version++;
    this.persist();
  }

  /** Attach an object to the node's input without transitioning state.
   *  Used to expose the composedPrompt on send nodes while they're still
   *  running, so the monitor can show "view entire prompt" before the CLI
   *  call returns. */
  setInput(id: string, input: unknown) {
    const n = this.nodes.get(id);
    if (!n) return;
    (n as { input: unknown }).input = input;
    this.version++;
    this.persist();
  }

  setLabel(id: string, label: string) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.label = label;
    this.version++;
    this.persist();
  }

  /** Wire a state-machine edge: this node fires when `predecessor.nodeId`
   *  reaches `predecessor.condition`. Used by the v2 scheduler. Replaces
   *  any prior predecessors. Callable repeatedly (e.g. during eager
   *  expansion of fallback chains) — last write wins. */
  setPredecessors(id: string, predecessors: import("../api/wire.js").PredecessorEdge[]): void {
    const n = this.nodes.get(id);
    if (!n) return;
    (n as { predecessors?: import("../api/wire.js").PredecessorEdge[] }).predecessors = predecessors;
    this.version++;
    this.persist();
  }

  /** Set how the node combines its predecessor edges. Default is "all".
   *  Aggregators (e.g. parallelFork post, try success-fan) flip to "any". */
  setJoinMode(id: string, joinMode: import("../api/wire.js").JoinMode): void {
    const n = this.nodes.get(id);
    if (!n) return;
    (n as { joinMode?: import("../api/wire.js").JoinMode }).joinMode = joinMode;
    this.version++;
    this.persist();
  }

  /**
   * Reset one node to `pending`. Clears output, error, and timestamps so
   * the scheduler will pick it up again on the next loop iteration. Used
   * by /api/retry to re-fire a node's handler after the user has fixed
   * whatever caused the original failure. The caller decides whether to
   * cascade: see `resetSubtree`.
   */
  resetNode(id: string): void {
    const n = this.nodes.get(id);
    if (!n) return;
    n.status = "pending";
    n.startedAt = null;
    n.finishedAt = null;
    n.output = null;
    n.error = null;
    this.version++;
    this.persist();
  }

  /**
   * Reset a node AND every transitive successor (any node with a
   * predecessor edge pointing back to this subtree). Used when retrying
   * a node whose `ok` output was already consumed by downstream nodes —
   * their stored outputs are derived from stale upstream and must be
   * recomputed.
   *
   * Returns the list of reset node ids so the caller (typically the
   * /api/retry handler) can report what changed. Idempotent: calling
   * with an already-pending node id is a no-op tree-walk.
   */
  resetSubtree(rootId: string): string[] {
    const reset: string[] = [];
    const queue: string[] = [rootId];
    const seen = new Set<string>();
    // Build a reverse index: predecessorId → ids that depend on it
    const reverse = new Map<string, string[]>();
    for (const n of this.nodes.values()) {
      const preds = (n as { predecessors?: import("../api/wire.js").PredecessorEdge[] }).predecessors;
      if (!preds) continue;
      for (const e of preds) {
        if (!reverse.has(e.nodeId)) reverse.set(e.nodeId, []);
        reverse.get(e.nodeId)!.push(n.id);
      }
    }
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      this.resetNode(id);
      reset.push(id);
      const successors = reverse.get(id);
      if (successors) for (const sid of successors) queue.push(sid);
    }
    return reset;
  }

  /** Streaming partial-output writer. Used by `send` (writes
   *  `partialText` / `partialUsage`) and `executeShell` (writes
   *  `stdoutSoFar` / `stderrSoFar`) while the node is still `running`,
   *  so the UI can render mid-flight progress on its 250 ms poll. The
   *  patch is shallow-merged into `node.output`; existing keys not
   *  mentioned in the patch are preserved. Does NOT transition the
   *  node — that's still finishOk/finishErr's job. */
  patchOutput(id: string, patch: Record<string, unknown>): void {
    const n = this.nodes.get(id);
    if (!n) return;
    const prev = (n.output && typeof n.output === "object")
      ? (n.output as Record<string, unknown>)
      : {};
    (n as { output: unknown }).output = { ...prev, ...patch };
    this.version++;
    this.persist();
  }

  /** Attach a captured working-tree diff to a node (file-mutating nodes only).
   *  Bumps version + persists so the UI's poll picks it up. */
  setDiff(id: string, diff: NodeDiff): void {
    const n = this.nodes.get(id);
    if (!n) return;
    (n as { diff?: NodeDiff | null }).diff = diff;
    this.version++;
    this.persist();
  }

  /** Walk `parentId` from `id` to the nearest ancestor that already carries a
   *  captured snapshot tree — that tree is the base for `id`'s per-node delta.
   *  Returns null when no ancestor has been snapshotted yet (first mutating
   *  node in the task), in which case the delta is taken vs HEAD. */
  prevSnapshotTree(id: string): string | null {
    let cur = this.nodes.get(id)?.parentId ?? null;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const n = this.nodes.get(cur);
      if (n?.diff?.tree) return n.diff.tree;
      cur = n?.parentId ?? null;
    }
    return null;
  }

  get(id: string): RichGraphNode | undefined {
    return this.nodes.get(id);
  }

  allNodes(): RichGraphNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Return the linear chain from root to `tipId` following parent pointers.
   * This is the description-path the engine executes sequentially.
   */
  pathToRoot(tipId: string): RichGraphNode[] {
    const out: RichGraphNode[] = [];
    let id: string | null = tipId;
    while (id) {
      const n = this.nodes.get(id);
      if (!n) break;
      out.push(n);
      id = n.parentId;
    }
    return out.reverse();
  }

  markRootDone(status: NodeStatus = "ok") {
    const root = this.nodes.get(this.rootId);
    if (!root) return;
    root.status = status;
    root.finishedAt = Date.now();
    this.finishedAt = Date.now();
    this.version++;
    this.persist();
  }

  snapshot() {
    // Strip non-serializable callbacks before emitting on the wire.
    const nodes = this.allNodes().map((n) => {
      const { ...rest } = n as RichGraphNode & { callbacks?: unknown };
      delete (rest as { callbacks?: unknown }).callbacks;
      return rest;
    });
    return {
      id: this.id,
      rootId: this.rootId,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      version: this.version,
      nodes,
    };
  }
}
