/**
 * The interchange's short-lived records (connect states, export-asset capabilities, add-on import
 * tokens, add-on exports): a map whose entries vanish at their expiry, read by the injected clock
 * so the 30-minute rules are tested with a virtual one.
 *
 * Kept in memory on purpose, like the embed bearer tokens (deck-api.ts): every one of them is
 * minutes long and restartable (a lost connect state means "connect again", a lost export address
 * means "export again"), and the connector runs as one process (SPEC.md 21.1).
 */
export type ExpiringTable<TValue> = Readonly<{
  put(options: Readonly<{ key: string; value: TValue; lifetimeMilliseconds: number }>): void;
  /** The live value, or null when absent or expired. */
  get(key: string): TValue | null;
  /** Reads and removes: a single-use record. */
  take(key: string): TValue | null;
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
      // Oldest first: past the capacity, the oldest record goes (a flood cannot grow memory).
      while (entries.size >= options.capacity) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      entries.set(key, { value, expiresAt: options.now() + lifetimeMilliseconds });
    },
    get: live,
    take: (key) => {
      const value = live(key);
      entries.delete(key);
      return value;
    },
  };
}
