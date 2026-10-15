// TEXT CHANGES AS DELTAS, and the one rule for moving an index through them. Every text index the
// editor holds -- the caret, a selected range, the start of an input-method composition, the
// indices inside a queued `editText` -- must follow other people's typing, or a collaborator typing
// before my caret makes my next keystroke land on the wrong letter. The model reports each
// transaction's text changes per body (`DocumentChange.textChanges`, document-store.ts) as these
// deltas, and the reducer moves every index it holds with `transformIndex`. No private delta log
// in the store, no "stale text" retries.
//
// TIE-BREAK AT THE SAME INDEX, stated once:
//
//  * A REMOTE insert exactly at my caret goes AFTER my caret (`bias: "before"` keeps the index
//    where it was). Two people typing at the same spot then each keep typing into their own run,
//    instead of interleaving letters.
//  * MY OWN queued inserts apply in order, each after the previous one (`bias: "after"` when the
//    reducer moves its caret past its own pending insert), so fast typing "ab" is always "ab".
//
// Only lengths matter for index transformation, so a delta carries no text or attributes.

import { assertNever } from "./assert-never.ts";
import type { TextTarget } from "./selection.ts";

export type TextDeltaOperation =
  | Readonly<{ kind: "retain"; length: number }>
  | Readonly<{ kind: "insert"; length: number }>
  | Readonly<{ kind: "delete"; length: number }>;

/** One transaction's change to one text body, in the body's old index space. */
export type TextDelta = readonly TextDeltaOperation[];

/** Where an index exactly at an insertion point ends up (see the header). */
export type IndexBias = "before" | "after";

declare const textTargetKeyBrand: unique symbol;
/** A text target as a map key (`textTargetKey`). */
export type TextTargetKey = string & { readonly [textTargetKeyBrand]: "TextTargetKey" };

/** The index `index` of the old text has in the new text. Inside a deleted span it collapses to the span's start. */
export function transformIndex(options: Readonly<{ delta: TextDelta; index: number; bias: IndexBias }>): number {
  let oldPosition = 0;
  let newPosition = 0;
  for (const operation of options.delta) {
    switch (operation.kind) {
      case "retain":
        if (options.index < oldPosition + operation.length) return newPosition + (options.index - oldPosition);
        oldPosition += operation.length;
        newPosition += operation.length;
        break;
      case "insert":
        if (options.index === oldPosition && STAYS_BEFORE_INSERT[options.bias]) return newPosition;
        newPosition += operation.length;
        break;
      case "delete":
        if (options.index < oldPosition + operation.length) return newPosition;
        oldPosition += operation.length;
        break;
      default:
        return assertNever(operation);
    }
  }
  return newPosition + (options.index - oldPosition);
}

/** The stable key of a text body, for `DocumentChange.textChanges` and per-body editor state. */
export function textTargetKey(target: TextTarget): TextTargetKey {
  const text = textTargetKeyText(target);
  // The text is built only from this function's own fixed formats, which is what the brand records.
  return text as TextTargetKey;
}

/** Total over IndexBias, so a new bias is a compile error here rather than a silent `else`. */
const STAYS_BEFORE_INSERT: Readonly<Record<IndexBias, boolean>> = { before: true, after: false };

function textTargetKeyText(target: TextTarget): string {
  switch (target.kind) {
    case "element":
      return `element/${target.slideId}/${target.elementId}`;
    case "tableCell":
      return `tableCell/${target.slideId}/${target.elementId}/${target.cell.rowId}/${target.cell.columnId}`;
    case "speakerNotes":
      return `speakerNotes/${target.slideId}`;
    default:
      return assertNever(target);
  }
}
