// ONE CONNECTION'S RATE LIMIT: a token bucket over every inbound frame (awareness included), as a
// pure step function over an immutable state, so a test drives it with a virtual clock and the
// room only stores the value (COLLABORATION_LIMITS, SPEC.md 21.10).
//
// Key decisions:
//
//  * BURST, THEN THE STEADY RATE. The bucket starts full (`messageBurst`) and refills at
//    `messagesPerSecond`; a frame that finds less than one token is DROPPED, not queued, because a
//    queue would only move the overload into the server's memory.
//  * TELL ONCE PER EPISODE. The first dropped frame of an overload answers `rateLimited` with the
//    time until the next token; later drops in the same episode stay silent, or a flooding client
//    would be answered with a flood.
//  * "CONTINUOUSLY OVER" MEANS NO SECOND WITHOUT A DROP. An episode lasts while drops keep coming
//    less than a second apart (`OVERLOAD_GAP_MILLISECONDS`), accepted frames in between included:
//    a client sending a steady 30 per second has frames accepted every second and is still over the
//    rate. An episode longer than `rateLimitCloseAfterMilliseconds` closes the connection.

import { COLLABORATION_LIMITS } from "../contracts/collaboration.ts";

export type RateLimitState = Readonly<{
  tokens: number;
  updatedAt: number;
  /** When the current overload episode began; null while not over the rate. */
  overloadedSince: number | null;
  lastDropAt: number | null;
}>;

export type RateLimitVerdict =
  | Readonly<{ kind: "accept" }>
  /** Drop the frame; `notify` is true for the first drop of an episode. */
  | Readonly<{ kind: "drop"; notify: boolean; retryAfterMilliseconds: number }>
  /** Over the rate for too long: close the connection `rateLimited`. */
  | Readonly<{ kind: "close" }>;

export type RateLimitPolicy = Readonly<{ messagesPerSecond: number; messageBurst: number; closeAfterMilliseconds: number }>;

export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  messagesPerSecond: COLLABORATION_LIMITS.messagesPerSecond,
  messageBurst: COLLABORATION_LIMITS.messageBurst,
  closeAfterMilliseconds: COLLABORATION_LIMITS.rateLimitCloseAfterMilliseconds,
};

/** Drops further apart than this end an overload episode. */
export const OVERLOAD_GAP_MILLISECONDS = 1_000;

export function initialRateLimitState(options: Readonly<{ policy: RateLimitPolicy; now: number }>): RateLimitState {
  return { tokens: options.policy.messageBurst, updatedAt: options.now, overloadedSince: null, lastDropAt: null };
}

/** One inbound frame at `now`: the verdict and the state to keep. */
export function takeToken(
  options: Readonly<{ state: RateLimitState; policy: RateLimitPolicy; now: number }>,
): Readonly<{ verdict: RateLimitVerdict; state: RateLimitState }> {
  const { state, policy, now } = options;
  const elapsed = Math.max(0, now - state.updatedAt);
  const tokens = Math.min(policy.messageBurst, state.tokens + (elapsed * policy.messagesPerSecond) / 1000);
  if (tokens >= 1) {
    return { verdict: { kind: "accept" }, state: { ...state, tokens: tokens - 1, updatedAt: now } };
  }
  const episodeContinues = state.overloadedSince !== null && state.lastDropAt !== null && now - state.lastDropAt < OVERLOAD_GAP_MILLISECONDS;
  const overloadedSince = episodeContinues && state.overloadedSince !== null ? state.overloadedSince : now;
  const next: RateLimitState = { tokens, updatedAt: now, overloadedSince, lastDropAt: now };
  if (now - overloadedSince >= policy.closeAfterMilliseconds) return { verdict: { kind: "close" }, state: next };
  const retryAfterMilliseconds = Math.ceil(((1 - tokens) * 1000) / policy.messagesPerSecond);
  return { verdict: { kind: "drop", notify: !episodeContinues, retryAfterMilliseconds }, state: next };
}
