/**
 * Error classes and generic error-handling utilities that live alongside
 * `materializeError` / `try` / `tryMultipleTimes` in user-facing code.
 */

import type { SessionWithResult } from "./session.js";
import type { Result } from "./types.js";

/**
 * Marker thrown (or returned as a JSON field) to tell the engine that the
 * model is giving up on the current branch — tryMultipleTimes skips remaining
 * retries and jumps straight to the fallback.
 */
export class InterruptException extends Error {
  constructor(message = "InterruptException") {
    super(message);
    this.name = "InterruptException";
  }
}

/**
 * All errors thrown inside a session calculation carry the session snapshot
 * so UI / fallback code can inspect what the model saw at the failure point.
 */
export class StructuredError extends Error {
  readonly sessionId: string | null;
  readonly nodeId: string | null;
  readonly data: unknown;
  override readonly cause: unknown;
  constructor(
    message: string,
    opts: { sessionId?: string | null; nodeId?: string | null; data?: unknown; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "StructuredError";
    this.sessionId = opts.sessionId ?? null;
    this.nodeId = opts.nodeId ?? null;
    this.data = opts.data;
    this.cause = opts.cause;
  }
}

/**
 * The ONLY error type that try/tryMultipleTimes are allowed to catch.
 *
 * Why: a wave can spend a lot of money looping on retries. If a programmer
 * bug (TypeError, ReferenceError, JSON.parse on garbage, etc.) gets caught
 * by a retry handler, the wave will burn N attempts × M slides worth of
 * tokens trying to "recover" from a bug that isn't recoverable. We want
 * those bugs to PROPAGATE OUT and abort the wave immediately — no token
 * hemorrhage.
 *
 * What counts as "validation":
 *   * Verdict failures the orchestrator throws on purpose ("UNSOLVED",
 *     "VISUAL CHECK FAILED", "REGRESSIONS"). The retry exists FOR these.
 *   * Shell command non-zero exits — always wrapped as ValidationError by
 *     the engine's runShell so a flaky `record-rendering` script triggers a
 *     retry rather than aborting the whole wave.
 *
 * What does NOT count (must propagate):
 *   * TypeError / ReferenceError / SyntaxError / out-of-memory.
 *   * `JSON.parse` failures on malformed CLI output (likely a CLI bug).
 *   * Unknown CLI exit codes that don't map to user-actionable retry.
 *   * Node typia transform errors.
 *
 * Throw `new ValidationError(...)` from user-land to signal "this attempt
 * failed validation, try again". Use `isCatchable(e)` from the engine's
 * try/tryMultipleTimes branches before swallowing — the helper rethrows
 * non-validation errors so we never accidentally absorb bugs.
 */
export class ValidationError extends StructuredError {
  constructor(
    message: string,
    opts: { sessionId?: string | null; nodeId?: string | null; data?: unknown; cause?: unknown } = {},
  ) {
    super(message, opts);
    this.name = "ValidationError";
  }
}

/**
 * Type guard + enforcement: returns true iff `e` is one of the error
 * categories a retry/fallback may legitimately swallow:
 *
 *   * ValidationError       — orchestrator-thrown verdict failures
 *                             (UNSOLVED, REGRESSIONS, VISUAL CHECK FAILED).
 *   * InterruptException    — model-initiated abandon.
 *   * StructuredError       — every error the engine itself raises:
 *                              · CLI failure (network glitch, rate limit)
 *                              · model returned non-conforming JSON for a
 *                                send<T>(...) schema
 *                              · shell command non-zero exit
 *                              all of these are user-actionable on a retry
 *                              (try a slightly different prompt, fix the
 *                              code the script complained about, etc.).
 *
 * Plain Error, TypeError, ReferenceError, SyntaxError — programmer bugs.
 * Those propagate up and abort the wave. See the comment on
 * ValidationError for why this matters (token-burn protection).
 *
 * Call sites that want to swallow an error MUST gate on this; if it
 * returns false, they should rethrow so the engine bubbles up and aborts.
 */
export function isCatchable(e: unknown): boolean {
  if (e instanceof ValidationError) return true;
  if (e instanceof InterruptException) return true;
  if (e instanceof StructuredError) return true;
  return false;
}

/**
 * Widen `SessionWithResult<T>` to `SessionWithResult<Result<T>>`.
 *
 * `T` is a subtype of `Result<T>` (`Result<T> = T | {error: string}`), so the
 * cast is safe at runtime — but TypeScript's generic classes are invariant,
 * so we need this helper to cross the variance boundary. Typical use: the
 * inner `code` callback of a `tryMultipleTimes<Result<T>>` where the body
 * produces `SessionWithResult<T>` but the outer retry loop wants
 * `Result<T>` so a `materializeError` fallback can sit next to it.
 */
export function lift<T>(s: SessionWithResult<T>): SessionWithResult<Result<T>> {
  return s as unknown as SessionWithResult<Result<T>>;
}

/**
 * Normalize an unknown thrown value into a serializable shape suitable for
 * feeding back into a prompt (via `prependToNextPrompt(safelyJsonStringify(describeError(e)))`)
 * or into a `materializeError(describeError(e).message)` call.
 *
 * Unwraps `Error.name` / `.message` and forwards `.nodeId` / `.sessionId`
 * from StructuredError so the model sees where in the computation graph
 * the failure happened.
 */
export interface ErrorDescription {
  name?: string;
  message: string;
  nodeId?: string;
  sessionId?: string | null;
}

export function describeError(e: unknown): string {
  if (e == null) return "<no error>";
  if (e instanceof Error) {
    const anyE = e as unknown as { nodeId?: string; sessionId?: string | null };
    return JSON.stringify({
      name: e.name,
      message: e.message,
      nodeId: anyE.nodeId,
      sessionId: anyE.sessionId,
    });
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
