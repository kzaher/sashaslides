// A CEILING ON SERVER CALLS THAT NO STATE MACHINE CAN ARGUE WITH.
//
// WHY IT EXISTS. `sidebar.tsx` runs `pump` after every dispatch, and a `needs*` that answered
// "read it again" the moment a read ARRIVED turned that into an unbounded chain of Drive calls.
// It ran until Apps Script answered "Exception: Service invoked too many times for one day:
// urlfetch" and the add-on could not read a comment for the rest of the day (measured in the
// deployed add-on, 2026-10-04). The reducer bug is fixed and has its own tests -- but nothing
// between the reducer and Google was counting, so a reducer bug could spend a daily quota.
//
// This counts. It is deliberately far above any legitimate cadence: the surfaces poll a handful
// of times a minute, so an honest build never comes near it and a runaway stops at it.

/** Far above any legitimate cadence, far below a daily quota. */
export const CALLS_PER_MINUTE = 120;

const WINDOW_MS = 60_000;

export type CallRateLimit = Readonly<{
  /** True when the call may go out. False means the ceiling is reached; try again later. */
  allow: () => boolean;
}>;

/**
 * A rolling-window counter. `now` is injected so the tests do not wait a minute, and so the
 * window cannot be fooled by a clock the page does not control.
 */
export function createCallRateLimit(options: Readonly<{ now: () => number }>): CallRateLimit {
  const { now } = options;
  let windowStartedAt = now();
  let used = 0;
  return {
    allow(): boolean {
      const at = now();
      if (at - windowStartedAt >= WINDOW_MS) {
        windowStartedAt = at;
        used = 0;
      }
      if (used >= CALLS_PER_MINUTE) return false;
      used += 1;
      return true;
    },
  };
}
