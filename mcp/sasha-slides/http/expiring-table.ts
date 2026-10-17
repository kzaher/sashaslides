/**
 * Short-lived records held in memory: pending sign-ins and passkey challenges, email sign-ups and
 * links waiting for their mail, embed tickets and bearers, and the Slides interchange's connect
 * states, capabilities and import tokens. A map whose entries vanish at their expiry, read by
 * the injected clock so the lifetime rules are tested with a virtual one.
 *
 * Kept in memory on purpose: every record is minutes (at most a day) long and restartable (a lost
 * connect state means "connect again", a lost sign-in means "sign in again"), and the connector
 * runs as one process (SPEC.md 21.1). BOUNDED, so a flood of start requests cannot grow memory:
 * every `put` first drops the expired records, then the oldest while the table is full.
 */
export type ExpiringTable<TValue> = Readonly<{
  put(options: Readonly<{ key: string; value: TValue; lifetimeMilliseconds: number }>): void;
  /** The live value, or null when absent or expired. */
  get(key: string): TValue | null;
  /** Reads and removes: a single-use record. */
  take(key: string): TValue | null;
  delete(key: string): void;
  /** Removes every record whose value matches, live or not (an erased account's tickets). */
  deleteWhere(matches: (value: TValue) => boolean): void;
}>;

export function createExpiringTable<TValue>(options: Readonly<{ now: () => number; capacity: number }>): ExpiringTable<TValue> {
  const entries = new Map<string, Readonly<{ value: TValue; expiresAt: number }>>();
  const live = (key: string): TValue | null => {
    const entry = entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= options.now()) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  };
  return {
    put: ({ key, value, lifetimeMilliseconds }) => {
      const now = options.now();
      for (const [existing, entry] of entries) if (entry.expiresAt <= now) entries.delete(existing);
      // Oldest first: past the capacity, the oldest record goes.
      while (entries.size >= options.capacity) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      entries.set(key, { value, expiresAt: now + lifetimeMilliseconds });
    },
    get: live,
    take: (key) => {
      const value = live(key);
      entries.delete(key);
      return value;
    },
    delete: (key) => {
      entries.delete(key);
    },
    deleteWhere: (matches) => {
      for (const [key, entry] of entries) if (matches(entry.value)) entries.delete(key);
    },
  };
}
