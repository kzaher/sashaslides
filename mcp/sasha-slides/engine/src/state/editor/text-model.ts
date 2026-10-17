// THE EDITOR'S VIEW OF A TEXT BODY AS A FLAT SEQUENCE. The flat model itself (flattening, replaying
// `editText` operations, paragraph lookups) is shared with Claude's deck tools in
// shared/flat-text.ts; the editor needs to know what a body WILL be once its queued edits apply --
// to find the style at the caret, the paragraphs a range overlaps, or the body an input method
// composition freezes -- and the document snapshot lags the queue by design (edits are applied by a
// feedback). What only the editor needs stays here: the word boundaries Ctrl+Backspace and
// Ctrl+Delete stop at, and the surrogate pairs a character delete removes whole.

import { assertNever } from "../../contracts/assert-never.ts";
import type { FlatText, FlatTextItem } from "../../shared/flat-text.ts";

export {
  applyTextOperations,
  bodyFromFlat,
  flattenBody,
  paragraphStylesOverlapping,
  runStyleAt,
  sameValue,
  type FlatText,
} from "../../shared/flat-text.ts";

/** Line breaks inside a paragraph, as Slides stores them (Shift+Enter). */
export const LINE_BREAK_CHARACTER = "\u000B";

/** Where Ctrl+Backspace stops: the start of the word before `index` (spaces before it included). */
export function previousWordBoundary(items: FlatText, index: number): number {
  let position = index;
  while (position > 0 && isSpace(items[position - 1])) position -= 1;
  while (position > 0 && isWordItem(items[position - 1])) position -= 1;
  return position === index ? Math.max(0, index - 1) : position;
}

/** Where Ctrl+Delete stops: the end of the word after `index` (spaces after it included). */
export function nextWordBoundary(items: FlatText, index: number): number {
  const last = items.length - 1;
  let position = index;
  while (position < last && isWordItem(items[position])) position += 1;
  while (position < last && isSpace(items[position])) position += 1;
  return position === index ? Math.min(last, index + 1) : position;
}

/** Code units a character delete removes before `index`: two for a surrogate pair. */
export function characterLengthBefore(items: FlatText, index: number): number {
  const previous = characterOf(items[index - 1]);
  const beforeThat = characterOf(items[index - 2]);
  if (previous !== null && beforeThat !== null && isLowSurrogate(previous) && isHighSurrogate(beforeThat)) return 2;
  return 1;
}

export function characterLengthAt(items: FlatText, index: number): number {
  const current = characterOf(items[index]);
  const next = characterOf(items[index + 1]);
  if (current !== null && next !== null && isHighSurrogate(current) && isLowSurrogate(next)) return 2;
  return 1;
}

function isSpace(item: FlatTextItem | undefined): boolean {
  const character = characterOf(item);
  return character !== null && /\s/u.test(character);
}

function characterOf(item: FlatTextItem | undefined): string | null {
  if (item === undefined) return null;
  switch (item.kind) {
    case "character":
      return item.character;
    case "automaticText":
    case "paragraphMark":
      return null;
    default:
      return assertNever(item);
  }
}

function isWordItem(item: FlatTextItem | undefined): boolean {
  if (item === undefined) return false;
  switch (item.kind) {
    case "character":
      return !/\s/u.test(item.character);
    case "automaticText":
      return true;
    case "paragraphMark":
      return false;
    default:
      return assertNever(item);
  }
}

function isHighSurrogate(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}
