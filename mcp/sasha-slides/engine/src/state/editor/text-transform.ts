// MOVING THE EDITOR'S TEXT INDICES THROUGH SOMEONE ELSE'S CHANGE (contracts/text-delta.ts). A change
// that did not come from this editor's own queue -- a collaborator's typing, an undo, a repair --
// arrives as a delta in the DOCUMENT's index space, but the caret and the queued edits live in the
// OPTIMISTIC space: the document plus every edit still queued. So the delta is carried through the
// queue the way operational transformation does it: each queued operation is moved through the
// delta, then the delta through that operation, and what is left of the delta moves the caret and
// the composition start, which sit after the whole queue.
//
// Ties follow text-delta.ts: a remote insert exactly at my caret or my queued insert goes after it
// (`bias: "before"`); a remote insert at the start of a range I am about to delete or format is
// outside that range.

import {
  textTargetKey,
  transformIndex,
  type QueuedEdit,
  type TextDelta,
  type TextDeltaOperation,
  type TextOperation,
  type TextTargetKey,
} from "../../contracts/index.ts";
import { assertNever } from "../../contracts/index.ts";
import { asEditText } from "./command-kinds.ts";

export type TransformedQueue = Readonly<{
  pendingEdits: readonly QueuedEdit[];
  /** The delta in the optimistic space, after every queued operation on its body. */
  deltaAfterQueue: TextDelta;
}>;

/** Move every queued text edit on `key`'s body through `delta`; return the delta left for the caret. */
export function transformQueueThroughDelta(options: Readonly<{ pendingEdits: readonly QueuedEdit[]; key: TextTargetKey; delta: TextDelta }>): TransformedQueue {
  let delta = options.delta;
  const pendingEdits = options.pendingEdits.map((edit): QueuedEdit => {
    switch (edit.kind) {
      case "undo":
      case "redo":
        return edit;
      case "apply": {
        const commands = edit.envelope.commands.map((command) => {
          const editText = asEditText(command);
          if (editText === null || textTargetKey(editText.target) !== options.key) return command;
          const operations = editText.operations.map((operation) => {
            const moved = transformOperation(operation, delta);
            delta = transformDelta({ first: operationDelta(operation), second: delta, firstWinsTies: true });
            return moved;
          });
          return { ...editText, operations };
        });
        return { kind: "apply", envelope: { ...edit.envelope, commands } };
      }
      default:
        return assertNever(edit);
    }
  });
  return { pendingEdits, deltaAfterQueue: delta };
}

/** Every queued `editText` now computed against `revision` (the change just reduced). */
export function rebaseQueueOnRevision(pendingEdits: readonly QueuedEdit[], revision: number): readonly QueuedEdit[] {
  return pendingEdits.map((edit): QueuedEdit => {
    switch (edit.kind) {
      case "undo":
      case "redo":
        return edit;
      case "apply": {
        const commands = edit.envelope.commands.map((command) => {
          const editText = asEditText(command);
          if (editText === null || editText.basedOnRevision === revision) return command;
          return { ...editText, basedOnRevision: revision };
        });
        return { kind: "apply", envelope: { ...edit.envelope, commands } };
      }
      default:
        return assertNever(edit);
    }
  });
}

/** One queued operation moved through a concurrent delta on the same body. */
export function transformOperation(operation: TextOperation, delta: TextDelta): TextOperation {
  switch (operation.kind) {
    case "insert":
    case "insertAutomaticText":
      return { ...operation, index: transformIndex({ delta, index: operation.index, bias: "before" }) };
    case "delete":
    case "formatRuns":
    case "formatParagraphs": {
      const start = transformIndex({ delta, index: operation.index, bias: "after" });
      const end = transformIndex({ delta, index: operation.index + operation.length, bias: "before" });
      return { ...operation, index: start, length: Math.max(0, end - start) };
    }
    default:
      return assertNever(operation);
  }
}

/** The delta a single text operation makes, in the space before it. */
export function operationDelta(operation: TextOperation): TextDelta {
  switch (operation.kind) {
    case "insert":
      return retainThen(operation.index, { kind: "insert", length: operation.text.length });
    case "insertAutomaticText":
      return retainThen(operation.index, { kind: "insert", length: 1 });
    case "delete":
      return retainThen(operation.index, { kind: "delete", length: operation.length });
    case "formatRuns":
    case "formatParagraphs":
      return [];
    default:
      return assertNever(operation);
  }
}

/**
 * `second` rewritten to apply AFTER `first`, both having been made against the same text. On an
 * insert-insert tie `firstWinsTies` puts `first`'s text first. Text `first` deleted takes `second`'s
 * operations on it along.
 */
export function transformDelta(options: Readonly<{ first: TextDelta; second: TextDelta; firstWinsTies: boolean }>): TextDelta {
  const first = createIterator(options.first);
  const second = createIterator(options.second);
  const result: TextDeltaOperation[] = [];
  for (;;) {
    const firstInserts = first.peekInserts();
    const secondInserts = second.peekInserts();
    if (firstInserts && (options.firstWinsTies || !secondInserts)) {
      pushOperation(result, { kind: "retain", length: first.take(Number.POSITIVE_INFINITY).length });
      continue;
    }
    if (secondInserts) {
      pushOperation(result, { kind: "insert", length: second.take(Number.POSITIVE_INFINITY).length });
      continue;
    }
    const length = Math.min(first.peekLength(), second.peekLength());
    if (length === Number.POSITIVE_INFINITY) break;
    const firstTaken = first.take(length);
    const secondTaken = second.take(length);
    if (DELETES[firstTaken.kind]) continue;
    pushOperation(result, DELETES[secondTaken.kind] ? { kind: "delete", length } : { kind: "retain", length });
  }
  while (result.length > 0 && RETAINS[result[result.length - 1]?.kind ?? "insert"]) result.pop();
  return result;
}

type DeltaIterator = Readonly<{
  peekInserts: () => boolean;
  /** Infinity once exhausted: the rest of the text is implicitly retained. */
  peekLength: () => number;
  take: (length: number) => TextDeltaOperation;
}>;

/** Total lookups over the delta operation kinds, so a new kind is a compile error here. */
const DELETES: Readonly<Record<TextDeltaOperation["kind"], boolean>> = { retain: false, insert: false, delete: true };
const RETAINS: Readonly<Record<TextDeltaOperation["kind"], boolean>> = { retain: true, insert: false, delete: false };
const INSERTS: Readonly<Record<TextDeltaOperation["kind"], boolean>> = { retain: false, insert: true, delete: false };

function createIterator(delta: TextDelta): DeltaIterator {
  let index = 0;
  let offset = 0;
  const current = (): TextDeltaOperation | undefined => {
    while (index < delta.length && (delta[index]?.length ?? 0) - offset <= 0) {
      index += 1;
      offset = 0;
    }
    return delta[index];
  };
  return {
    peekInserts: () => {
      const operation = current();
      return operation !== undefined && INSERTS[operation.kind];
    },
    peekLength: () => {
      const operation = current();
      return operation === undefined ? Number.POSITIVE_INFINITY : operation.length - offset;
    },
    take: (length: number) => {
      const operation = current();
      if (operation === undefined) return { kind: "retain", length };
      const available = operation.length - offset;
      const taken = Math.min(available, length);
      offset += taken;
      return { kind: operation.kind, length: taken };
    },
  };
}

function pushOperation(result: TextDeltaOperation[], operation: TextDeltaOperation): void {
  if (operation.length <= 0) return;
  const last = result[result.length - 1];
  if (last !== undefined && last.kind === operation.kind) {
    result[result.length - 1] = { kind: last.kind, length: last.length + operation.length };
    return;
  }
  result.push(operation);
}

function retainThen(index: number, operation: TextDeltaOperation): TextDelta {
  return index > 0 ? [{ kind: "retain", length: index }, operation] : [operation];
}
