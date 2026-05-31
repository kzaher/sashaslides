import type { ClaudeCallOptions, ClaudeCallResult } from "./claude-cli.js";

/**
 * model-driver.ts — the ONE engine-specific seam.
 *
 * The engine (graph walk, monitor, interpreter, session/fork/compact
 * bookkeeping) is provider-agnostic. The only thing that differs between
 * Claude and Codex is HOW a prompt is sent to the model CLI and how the
 * reply is parsed. That difference is captured by `ModelDriver` and
 * COMPOSED into the engine (injected as a collaborator), so `ClaudeEngine`
 * and `CodexEngine` reuse 100% of the engine logic without inheritance.
 *
 * The call option/result shapes are already provider-neutral (prompt,
 * resume id, fork, cwd, timeout, attachments, json-schema, streaming hooks,
 * token usage), so we reuse `claude-cli`'s shapes directly rather than
 * re-declaring them — `model` there is widened to `string` so any provider's
 * model id flows through.
 */
export type ModelCallOptions = ClaudeCallOptions;
export type ModelCallResult = ClaudeCallResult;

/** Result of a schema-constrained call: the base result plus the parsed
 *  structured value (or a parse error when the model didn't comply). */
export type FormattedResult<R> = ModelCallResult & {
  parsed: R | null;
  parseError: string | null;
};

/**
 * A provider backend. Implementations: `claudeDriver` (claude-cli.ts),
 * `codexDriver` (codex-cli.ts). Pure data-in/data-out — no engine state.
 */
export interface ModelDriver {
  /** Short id for logs / error messages, e.g. "claude" or "codex". */
  readonly name: string;
  /** Unstructured send. */
  call(opts: ModelCallOptions): Promise<ModelCallResult>;
  /** Send constrained to a JSON Schema; `parsed` carries the model's object. */
  callFormatted<R>(opts: ModelCallOptions & { jsonSchema: object }): Promise<FormattedResult<R>>;
  /**
   * Compact the resumable conversation (Claude: send "/compact"; Codex:
   * provider-specific or a no-op). The returned result's `sessionId` is the
   * conversation to resume from afterwards.
   */
  compact(opts: ModelCallOptions): Promise<ModelCallResult>;
  /**
   * Shell command that LOADS this session in the provider CLI for inspection
   * (e.g. `codex resume <id>` / `claude --resume <id>`). `cwd` is the dir the
   * session ran in — codex filters its session picker by cwd, so the command
   * cd's there first. Returns null when there is no session id to resume.
   */
  resumeCommand(sessionId: string | null, cwd?: string): string | null;
}
