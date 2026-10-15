// Yjs update arithmetic the connector needs without importing Yjs itself (SPEC.md 21.1: one copy of
// Yjs, the engine's): the deck registry batches a room's updates into one log record per flush.

import * as Y from "yjs";

/**
 * Whether `update` decodes as a Yjs update. The deck storage checks a SNAPSHOT with it before
 * loading: a snapshot that does not decode refuses the deck instead of loading the log alone,
 * because the next compaction would overwrite the snapshot with that partial deck.
 */
export function isDocumentUpdate(update: Uint8Array): boolean {
  try {
    Y.decodeUpdate(update);
    return true;
  } catch {
    return false;
  }
}

/** One update equivalent to applying all of `updates` (Yjs updates commute and are idempotent). */
export function mergeDocumentUpdates(updates: readonly Uint8Array[]): Uint8Array {
  const [only] = updates;
  if (updates.length === 1 && only !== undefined) return only;
  return Y.mergeUpdates([...updates]);
}
