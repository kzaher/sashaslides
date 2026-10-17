/**
 * A TEXT BODY AS THE Y.Text INDEX SPACE SEES IT: one item per index (a UTF-16 code unit, an
 * automatic field, or a paragraph mark). `deck_edit` computes `editText` operations against the
 * deck's snapshot, and when one call edits the same body twice (set a title, then bold a word of
 * it) the second edit's indices must be computed against the body as the first one LEAVES it. So
 * the expansion keeps each body it touches in this form and applies its own operations to it with
 * the editor's flat text model (engine/src/shared/flat-text.ts), which follows the model's rules.
 *
 * The model remains the authority: it validates and writes the operations; this only has to agree
 * with it about where things are. What is the expansion's own is the searchable text.
 */
import type { TextOperation } from "../engine/src/contracts/commands.ts";
import type { RunStylePatch } from "../engine/src/contracts/style.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import { applyTextOperations as applyFlatTextOperations, runStyleOfItem, type FlatText, type FlatTextItem } from "../engine/src/shared/flat-text.ts";

export { bodyFromFlat as textBodyOfFlat, flattenBody as flattenTextBody, type FlatText } from "../engine/src/shared/flat-text.ts";

export type FlatItem = FlatTextItem;

/** What a search sees at an automatic field: one character no find string can contain. */
export const AUTOMATIC_TEXT_SEARCH_CHARACTER = "￼";

/** The searchable text: characters as themselves, marks as "\n", fields as one placeholder character. */
export function searchableText(flat: FlatText): string {
  return flat.map(searchableCharacter).join("");
}

/** Applies operations in order, each against the previous one's result (commands.ts `TextOperation`). */
export function applyTextOperations(options: Readonly<{ flat: FlatText; operations: readonly TextOperation[] }>): FlatText {
  return applyFlatTextOperations(options.flat, options.operations);
}

/** The run style of the item AT `index` (a mark has none: `{}`); the editor's `runStyleAt` reads the one before. */
export function runStyleAt(options: Readonly<{ flat: FlatText; index: number }>): RunStylePatch {
  return runStyleOfItem(options.flat[options.index]) ?? {};
}

function searchableCharacter(item: FlatItem): string {
  switch (item.kind) {
    case "character":
      return item.character;
    case "automaticText":
      return AUTOMATIC_TEXT_SEARCH_CHARACTER;
    case "paragraphMark":
      return "\n";
    default:
      return assertNever(item);
  }
}
