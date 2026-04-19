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
