import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { IJsonSchemaUnit } from "@typia/interface";
import type { ClaudeModel } from "./types.js";
import type {
  CommonSendArguments,
  PromptInput,
  Session,
  SessionWithResult,
} from "./session.js";

export type NodeStatus = "pending" | "running" | "ok" | "error";

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
export type NodeKind = keyof NodeKindSchemas;

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
}

/**
 * GraphNode is a discriminated union on `kind`. In a `switch(node.kind) {
 * case "parallelFork": ... }` TypeScript narrows the variant so
 * `node.callbacks.apply` has the exact function type and `node.input.inputs`
 * is `readonly unknown[]` — no casts needed.
 */
export type GraphNode = {
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
  private nodes = new Map<string, GraphNode>();
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
    const root: GraphNode = {
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
    for (const n of snap.nodes) this.nodes.set(n.id, n as GraphNode);
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
  create<K extends NodeKind>(args: CreateArgs<K>): Extract<GraphNode, { kind: K }> {
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
    } as unknown as Extract<GraphNode, { kind: K }>;
    this.nodes.set(node.id, node);
    if (parentId) {
      const parent = this.nodes.get(parentId);
      if (parent) parent.children.push(node.id);
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

  get(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  allNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Return the linear chain from root to `tipId` following parent pointers.
   * This is the description-path the engine executes sequentially.
   */
  pathToRoot(tipId: string): GraphNode[] {
    const out: GraphNode[] = [];
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
      const { ...rest } = n as GraphNode & { callbacks?: unknown };
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
