// Yjs update arithmetic the connector needs without importing Yjs itself (SPEC.md 21.1: one copy of
// Yjs, the engine's): the deck registry batches a room's updates into one log record per flush.

import * as Y from "yjs";

/** One update equivalent to applying all of `updates` (Yjs updates commute and are idempotent). */
export function mergeDocumentUpdates(updates: readonly Uint8Array[]): Uint8Array {
  const [only] = updates;
  if (updates.length === 1 && only !== undefined) return only;
  return Y.mergeUpdates([...updates]);
}
