/**
 * Wire-only types — the JSON shapes that cross HTTP between server and client.
 *
 * No classes, no functions, no callbacks. The server-side ComputationGraph
 * (in src/server/graph.ts) holds richer in-memory shapes; snapshot() strips
 * them down to the types defined here. Both src/server/ and src/client/
 * import from this directory and from nowhere else across the boundary.
 */

export type NodeStatus = "pending" | "running" | "ok" | "error";

/**
 * Discriminator tag for node kinds. Listed exhaustively here so the client
 * can narrow without reaching into server-only modules. Adding a kind
 * means adding it here AND to NodeKindSchemas in src/server/graph.ts.
 */
export type NodeKind =
  | "root"
  | "send"
  | "askFollowup"
  | "fork"
  | "compact"
  | "switchModel"
  | "switchCwd"
  | "newSession"
  | "prependToNextPrompt"
  | "appendToNextPrompt"
  | "materializeError"
  | "parallelChild"
  | "tryAttempt"
  | "tryFallback"
  | "combineBranch"
  | "pipe"
  | "combineWith"
  | "parallelFork"
  | "try"
  | "tryMultipleTimes"
  | "assert"
  | "executeShell";

export interface NodeError {
  message: string;
  stack?: string;
  data?: unknown;
}

/**
 * Predecessor edge: "this node fires when `nodeId` reaches `condition`."
 *
 * The default condition for any chained step is `"ok"` (continue on
 * success). `try` / `tryMultipleTimes` use `"error"` edges for the
 * fallback chain — that fallback only fires if the predecessor errored.
 * `"any"` fires on either ok or error (used by aggregator nodes that
 * sum up parallel branches regardless of individual outcomes).
 */
export interface PredecessorEdge {
  nodeId: string;
  /** What state the predecessor must reach for this edge to fire. */
  condition: "ok" | "error" | "any";
}

/**
 * Aggregation rule across multiple predecessor edges on the same node.
 *
 *   "all" (default) — every edge's condition must be satisfied before the
 *     node fires. Used by ordinary chain steps and parallelFork's
 *     post-aggregator (wait for ALL children).
 *   "any"           — node fires as soon as ANY edge's condition is met.
 *     Used by try/tryMultipleTimes success aggregator: "fire when any
 *     attempt succeeds OR the fallback succeeds."
 */
export type JoinMode = "all" | "any";

/**
 * Wire-level GraphNode. Mirrors the in-memory `GraphNodeBase` minus the
 * kind-discriminated `input` / `callbacks` slots — the client treats
 * `input` and `output` as `unknown` and narrows by switching on `kind`.
 *
 * Streaming convention for `output`: while a node is `running`, side-
 * effect handlers MAY write `output.partialText` (for `send` /
 * `askFollowup`), `output.stdoutSoFar` / `output.stderrSoFar` (for
 * `executeShell`), and `output.partialUsage` (for sends in mid-flight).
 * The graph's version counter increments per chunk, so the monitor's
 * 250 ms poll surfaces the streamed output before the node transitions.
 *
 * `predecessors` is the state-machine edge set: this node fires when
 * every edge's `nodeId` has reached its required `condition`. Empty
 * array = no dependencies (fire immediately). Optional for backward
 * compatibility with the legacy `runChain` interpreter, which uses
 * `parentId` for sequencing instead.
 */
export interface GraphNode {
  id: string;
  parentId: string | null;
  containerId: string | null;
  kind: NodeKind;
  label: string;
  status: NodeStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  model: string | null;
  sessionId: string | null;
  input: unknown;
  output: unknown;
  error: NodeError | null;
  children: string[];
  /** State-machine edges. Empty/undefined = legacy chain semantics. */
  predecessors?: PredecessorEdge[];
  /** How multiple predecessor edges combine. Default "all". */
  joinMode?: JoinMode;
  /**
   * Working-tree git diff captured by the engine after a file-mutating node
   * (send / executeShell) finishes. Absent on nodes that don't change files
   * or that ran outside a git worktree. See NodeDiff.
   */
  diff?: NodeDiff | null;
}

/**
 * Per-node working-tree diff. The engine snapshots the task's git worktree
 * after each file-mutating node and records both the cumulative change (vs the
 * worktree's starting commit) and the delta attributable to that single node.
 */
export interface NodeDiff {
  /** Unified `git diff` of everything changed since the task started (vs HEAD). */
  cumulative: string;
  /** Unified `git diff` of only what THIS node changed (vs the previous
   *  file-mutating node's snapshot). Equals `cumulative` for the first node. */
  delta: string;
  /** `--stat` summary line(s) for the cumulative diff. */
  stat: string;
  /** git write-tree SHA of this snapshot — base for the next node's delta. */
  tree: string;
  /** True if either diff body was clamped for size. */
  truncated: boolean;
}

/** What `GET /api/graph` returns and what view-graph.ts loads from disk. */
export interface GraphSnapshot {
  id: string;
  rootId: string;
  startedAt: number;
  finishedAt: number | null;
  version: number;
  nodes: GraphNode[];
}

// ── HTTP endpoints ─────────────────────────────────────────────────────────

export interface AskRequest {
  nodeId: string;
  prompt: string;
}

export interface AskReply {
  /** ID of the newly-created askFollowup node so the client can auto-select it. */
  newNodeId: string;
  text: string;
  sessionId: string | null;
  durationMs: number;
  costUsd: number | null;
  isError: boolean;
  errorMessage: string | null;
}

export interface RetryRequest {
  nodeId: string;
}

export interface RetryReply {
  nodeId: string;
  kind: string;
  status: "ok" | "error";
  message: string;
}

/**
 * Per-call token + USD accounting written onto every send's output by the
 * engine, surfaced in the monitor's per-node rollup.
 */
export interface TokenUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// ── Cross-half value types ─────────────────────────────────────────────────

/** `T` on success, `{error: string}` on failure. Produced by materializeError. */
export type Result<T> = T | { error: string };

/** Claude CLI model aliases passed to `claude --model`. */
export type ClaudeModel = "haiku" | "sonnet" | "opus" | "fable";

// ── Conversation transcript (Claude web-UI viewer) ─────────────────────────

/** One normalized content block on a transcript turn. */
export interface TranscriptBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image" | "document" | "unknown";
  /** text / thinking / fallback body */
  text?: string;
  /** tool_use */
  name?: string;
  input?: unknown;
  id?: string;
  /** tool_result linkage + body */
  toolUseId?: string;
  isError?: boolean;
  resultText?: string;
  /** image data URL (image blocks + image tool_results) */
  dataUrl?: string;
  raw?: unknown;
}

export interface TranscriptTurn {
  role: "user" | "assistant";
  uuid: string | null;
  timestamp: string | null;
  cwd: string | null;
  blocks: TranscriptBlock[];
}

/** GET /api/transcript?session=<id> reply. */
export interface TranscriptReply {
  sessionId: string;
  path: string | null;
  cwd: string | null;
  /** Which CLI produced the transcript we parsed — lets the client badge it.
   *  "claude" = ~/.claude/projects/*.jsonl; "codex" = ~/.codex/sessions
   *  rollout-*.jsonl. Null when no transcript was found for the session. */
  source: "claude" | "codex" | null;
  turns: TranscriptTurn[];
}

/** POST /api/session-send request body. */
export interface SessionSendRequest {
  sessionId: string;
  cwd?: string;
  message: string;
  images?: Array<{ media_type: string; data: string }>;
}

/**
 * Sugar namespace so user code can write `Claude.haiku` / `Claude.switchOpus`
 * matching the README spec. Lives in api/ because user code on the server
 * side imports it from `<library>/index.js`, but it's pure typed strings
 * (no runtime behavior beyond the lookup) so the client can also reference
 * it for display labels.
 */
export const Claude = {
  haiku: "haiku" as ClaudeModel,
  sonnet: "sonnet" as ClaudeModel,
  opus: "opus" as ClaudeModel,
  fable: "fable" as ClaudeModel,
  switchHaiku: "haiku" as ClaudeModel,
  switchSonnet: "sonnet" as ClaudeModel,
  switchOpus: "opus" as ClaudeModel,
  switchFable: "fable" as ClaudeModel,
} as const;
