/**
 * Sliding-window rate limits, kept in this process's memory.
 *
 * Each rule allows `limit` events per `windowMs` for one key (a client address, a recipient,
 * an account). `admit` takes every check a request must pass and either records the event
 * in all of them or in none: a request refused by its per-address limit must not also spend
 * its client's budget, or one busy recipient would lock out an innocent client.
 *
 * The window is exact (a list of event times per key), not a fixed bucket, so a burst at the
 * end of one bucket and the start of the next cannot double the limit.
 *
 * Attacks and their defences:
 *
 *  - **Memory exhaustion by key churn** (an attacker cycling through addresses or IPv6
 *    addresses so every request creates a key). The map is capped at `maxKeys`: expired
 *    entries are swept first, then the oldest keys are dropped. Dropping a key forgets its
 *    history, so under a flood the limits loosen rather than the process dying; the global
 *    mail cap is a single key and so is never the one evicted while it is busy.
 *
 * A deployment with several instances needs a shared store (Redis, a database table) for
 * these counters; in memory, each instance would allow the full limit by itself.
 */

export type ThrottleRule = Readonly<{
  /** Names the rule in logs and in the refusal; never contains a key. */
  name: string;
  limit: number;
  windowMs: number;
}>;

export type ThrottleCheck = Readonly<{ rule: ThrottleRule; key: string }>;

export type ThrottleDecision =
  | Readonly<{ kind: "admitted" }>
  | Readonly<{ kind: "refused"; rule: string; retryAfterMs: number }>;

export type Throttle = Readonly<{
  /** Records the event under every check when all of them have room, and under none otherwise. */
  admit(options: Readonly<{ checks: readonly ThrottleCheck[] }>): ThrottleDecision;
  /** How many keys are held, for tests of the memory bound. */
  size(): number;
}>;

export function createThrottle(options: Readonly<{ now: () => Date; maxKeys: number }>): Throttle {
  const { now, maxKeys } = options;
  const events = new Map<string, number[]>();

  function liveEvents(target: Readonly<{ check: ThrottleCheck; nowMs: number }>): number[] {
    const { check, nowMs } = target;
    const slot = slotOf(check);
    const recorded = events.get(slot);
    if (recorded === undefined) return [];
    const live = recorded.filter((atMs) => atMs > nowMs - check.rule.windowMs);
    if (live.length === 0) events.delete(slot);
    else events.set(slot, live);
    return live;
  }

  function makeRoom(nowMs: number): void {
    if (events.size < maxKeys) return;
    // A key's events are kept no longer than its longest rule, so a day is a safe sweep horizon.
    for (const [slot, recorded] of events) {
      if ((recorded.at(-1) ?? 0) <= nowMs - SWEEP_HORIZON_MS) events.delete(slot);
    }
    while (events.size >= maxKeys) {
      const oldest = events.keys().next();
      if (oldest.done === true) break;
      events.delete(oldest.value);
    }
  }

  return {
    admit: ({ checks }) => {
      const nowMs = now().getTime();
      for (const check of checks) {
        const live = liveEvents({ check, nowMs });
        if (live.length < check.rule.limit) continue;
        const oldestCounted = live[live.length - check.rule.limit] ?? nowMs;
        return { kind: "refused", rule: check.rule.name, retryAfterMs: oldestCounted + check.rule.windowMs - nowMs };
      }
      for (const check of checks) {
        const slot = slotOf(check);
        const live = events.get(slot);
        if (live === undefined) {
          makeRoom(nowMs);
          events.set(slot, [nowMs]);
        } else {
          live.push(nowMs);
        }
      }
      return { kind: "admitted" };
    },
    size: () => events.size,
  };
}

const SWEEP_HORIZON_MS = 24 * 60 * 60 * 1000;

function slotOf(check: ThrottleCheck): string {
  return `${check.rule.name}\u0000${check.key}`;
}
