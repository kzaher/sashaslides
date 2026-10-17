// TEXT BODIES AS A FLAT SEQUENCE, the Y.Text index space (contracts/document.ts): one item per
// 16-bit code unit of the string, one per automatic field, and one paragraph mark ending every
// paragraph. Two callers replay `editText` operations over a body before the model has written
// them, and must agree with the model (model/text-body.ts) about where everything is: the editor
// (state/editor/text-model.ts, editor-queue.ts `optimisticText`) replays its queued edits over the
// snapshot, and Claude's `deck_edit` (deck-tools/flat-text.ts) computes a second edit of one body
// against what the first one leaves. The rules are the model's: an inserted "\n" splits the
// paragraph and copies its paragraph style, run formatting skips marks and paragraph formatting
// touches only marks, and the final paragraph mark can never be deleted.
//
// Indices are clamped into the body, so an operation the model would refuse changes nothing here
// instead of throwing. DOM-free and Node-free: every import names a DOM-free contract file.

import { assertNever } from "../contracts/assert-never.ts";
import type { TextOperation } from "../contracts/commands.ts";
import type { AutomaticTextField, Paragraph, TextBody, TextRun } from "../contracts/document.ts";
import type { ParagraphStylePatch, RunStylePatch } from "../contracts/style.ts";

export type FlatTextItem =
  | Readonly<{ kind: "character"; character: string; style: RunStylePatch }>
  | Readonly<{ kind: "automaticText"; field: AutomaticTextField; style: RunStylePatch }>
  | Readonly<{ kind: "paragraphMark"; style: ParagraphStylePatch }>;

export type FlatText = readonly FlatTextItem[];

export function flattenBody(body: TextBody): FlatText {
  const items: FlatTextItem[] = [];
  for (const paragraph of body.paragraphs) {
    for (const run of paragraph.runs) pushRun(items, run);
    items.push({ kind: "paragraphMark", style: paragraph.style });
  }
  return items;
}

/** Back to paragraphs of runs, adjacent characters of equal style joined into one run. */
export function bodyFromFlat(items: FlatText): TextBody {
  const paragraphs: Paragraph[] = [];
  let runs: TextRun[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "character": {
        const last = runs.at(-1);
        const lastText = last === undefined ? null : textOfRun(last);
        if (last !== undefined && lastText !== null && sameValue(last.style, item.style)) {
          runs[runs.length - 1] = { kind: "text", text: lastText + item.character, style: last.style };
        } else {
          runs.push({ kind: "text", text: item.character, style: item.style });
        }
        break;
      }
      case "automaticText":
        runs.push({ kind: "automaticText", field: item.field, style: item.style });
        break;
      case "paragraphMark":
        paragraphs.push({ style: item.style, runs });
        runs = [];
        break;
      default:
        assertNever(item);
    }
  }
  // A body always ends with a paragraph mark; text after the last mark is kept in a final paragraph.
  if (runs.length > 0 || paragraphs.length === 0) paragraphs.push({ style: {}, runs });
  return { paragraphs };
}

/** The flat text after applying `operations` in order, each against the previous result. */
export function applyTextOperations(items: FlatText, operations: readonly TextOperation[]): FlatText {
  let current = items;
  for (const operation of operations) current = applyTextOperation(current, operation);
  return current;
}

export function applyTextOperation(items: FlatText, operation: TextOperation): FlatText {
  switch (operation.kind) {
    case "insert":
      return insertText({ items, index: operation.index, text: operation.text, style: operation.style });
    case "insertAutomaticText":
      return spliceItems(items, clampIndex(items, operation.index), 0, [{ kind: "automaticText", field: operation.field, style: operation.style }]);
    case "delete": {
      // The final paragraph mark is never deleted: a body always ends with one.
      const start = clampIndex(items, operation.index);
      const end = Math.min(items.length - 1, start + Math.max(0, operation.length));
      return end <= start ? items : spliceItems(items, start, end - start, []);
    }
    case "formatRuns": {
      const start = clampIndex(items, operation.index);
      const end = Math.min(items.length, start + Math.max(0, operation.length));
      return items.map((item, index) => {
        if (index < start || index >= end) return item;
        switch (item.kind) {
          case "character":
          case "automaticText":
            return { ...item, style: patchStyle(item.style, operation.patch, operation.clear) };
          case "paragraphMark":
            return item;
          default:
            return assertNever(item);
        }
      });
    }
    case "formatParagraphs": {
      const marks = paragraphMarkIndices({ items, index: operation.index, length: operation.length });
      return items.map((item, index) => {
        if (!marks.has(index)) return item;
        switch (item.kind) {
          case "paragraphMark":
            return { kind: "paragraphMark", style: patchStyle(item.style, operation.patch, operation.clear) };
          case "character":
          case "automaticText":
            return item;
          default:
            return assertNever(item);
        }
      });
    }
    default:
      return assertNever(operation);
  }
}

/** The run style text typed at `index` continues: the character before it, else the one at it. */
export function runStyleAt(items: FlatText, index: number): RunStylePatch {
  const before = runStyleOfItem(items[index - 1]);
  if (before !== null) return before;
  return runStyleOfItem(items[index]) ?? {};
}

/** The paragraph style that governs `index`: that of the mark ending its paragraph. */
export function paragraphStyleAt(items: FlatText, index: number): ParagraphStylePatch {
  return paragraphStyleOfItem(items[paragraphEndAt(items, index)]) ?? {};
}

/** The index of the paragraph mark ending the paragraph that holds `index`. */
export function paragraphEndAt(items: FlatText, index: number): number {
  for (let position = Math.max(0, index); position < items.length; position += 1) {
    if (isParagraphMark(items[position])) return position;
  }
  return Math.max(0, items.length - 1);
}

/** The index where the paragraph holding `index` starts. */
export function paragraphStartAt(items: FlatText, index: number): number {
  for (let position = Math.min(index, items.length) - 1; position >= 0; position -= 1) {
    if (isParagraphMark(items[position])) return position + 1;
  }
  return 0;
}

/** The marks of every paragraph overlapping [index, index + length); a caret overlaps its own paragraph. */
export function paragraphMarkIndices(options: Readonly<{ items: FlatText; index: number; length: number }>): ReadonlySet<number> {
  const marks = new Set<number>();
  const start = clampIndex(options.items, options.index);
  const lastIndex = Math.max(start, start + options.length - 1);
  let position = paragraphEndAt(options.items, start);
  marks.add(position);
  while (position < lastIndex && position < options.items.length - 1) {
    position = paragraphEndAt(options.items, position + 1);
    marks.add(position);
  }
  return marks;
}

export function paragraphStylesOverlapping(options: Readonly<{ items: FlatText; index: number; length: number }>): readonly ParagraphStylePatch[] {
  return [...paragraphMarkIndices(options)].map((index) => paragraphStyleOfItem(options.items[index]) ?? {});
}

/**
 * The items of [start, end) as plain text (copy, cut, a comment's quote): paragraph marks become
 * "\n", and an automatic slide number prints `slideNumber`, or "#" when the caller does not know it.
 */
export function plainTextOfRange(options: Readonly<{ items: FlatText; start: number; end: number; slideNumber: number | null }>): string {
  const start = Math.max(0, Math.min(options.start, options.end));
  const end = Math.min(options.items.length, Math.max(options.start, options.end));
  let text = "";
  for (const item of options.items.slice(start, end)) {
    switch (item.kind) {
      case "character":
        text += item.character;
        break;
      case "automaticText":
        text += options.slideNumber === null ? "#" : String(options.slideNumber);
        break;
      case "paragraphMark":
        text += "\n";
        break;
      default:
        assertNever(item);
    }
  }
  return text;
}

/** A run or paragraph style with `patch` set over it and the `clear` attributes removed. */
export function patchStyle<TStyle extends object>(style: TStyle, patch: TStyle, clear: readonly (keyof TStyle)[]): TStyle {
  const merged: TStyle = { ...style, ...patch };
  for (const name of clear) delete merged[name];
  return merged;
}

/** Structural equality of plain data (style patches, colours, measurements, presence). */
export function sameValue(first: unknown, second: unknown): boolean {
  if (first === second) return true;
  if (typeof first !== "object" || typeof second !== "object" || first === null || second === null) return false;
  if (Array.isArray(first) !== Array.isArray(second)) return false;
  const firstEntries = Object.entries(first).filter(([, value]) => value !== undefined);
  const secondEntries = Object.entries(second).filter(([, value]) => value !== undefined);
  if (firstEntries.length !== secondEntries.length) return false;
  const secondMap = new Map(secondEntries);
  return firstEntries.every(([key, value]) => secondMap.has(key) && sameValue(value, secondMap.get(key)));
}

/** A character's or field's own run style; null for a paragraph mark or past either end. */
export function runStyleOfItem(item: FlatTextItem | undefined): RunStylePatch | null {
  if (item === undefined) return null;
  switch (item.kind) {
    case "character":
    case "automaticText":
      return item.style;
    case "paragraphMark":
      return null;
    default:
      return assertNever(item);
  }
}

/** A run's characters; null for an automatic field, whose text is only known when drawn. */
export function textOfRun(run: TextRun): string | null {
  switch (run.kind) {
    case "text":
      return run.text;
    case "automaticText":
      return null;
    default:
      return assertNever(run);
  }
}

function pushRun(items: FlatTextItem[], run: TextRun): void {
  switch (run.kind) {
    case "text":
      for (let index = 0; index < run.text.length; index += 1) items.push({ kind: "character", character: run.text.charAt(index), style: run.style });
      return;
    case "automaticText":
      items.push({ kind: "automaticText", field: run.field, style: run.style });
      return;
    default:
      assertNever(run);
  }
}

function insertText(options: Readonly<{ items: FlatText; index: number; text: string; style: RunStylePatch }>): FlatText {
  const at = clampIndex(options.items, options.index);
  const inserted: FlatTextItem[] = [];
  // A "\n" ends a new paragraph that copies the split paragraph's style (yjs-schema.ts text rule).
  const splitStyle = paragraphStyleAt(options.items, at);
  for (let index = 0; index < options.text.length; index += 1) {
    const character = options.text.charAt(index);
    if (character === "\n") inserted.push({ kind: "paragraphMark", style: splitStyle });
    else inserted.push({ kind: "character", character, style: options.style });
  }
  return spliceItems(options.items, at, 0, inserted);
}

function spliceItems(items: FlatText, start: number, deleteCount: number, inserted: readonly FlatTextItem[]): FlatText {
  return [...items.slice(0, start), ...inserted, ...items.slice(start + deleteCount)];
}

function clampIndex(items: FlatText, index: number): number {
  return Math.max(0, Math.min(Math.max(0, items.length - 1), index));
}

function isParagraphMark(item: FlatTextItem | undefined): boolean {
  return item !== undefined && paragraphStyleOfItem(item) !== null;
}

function paragraphStyleOfItem(item: FlatTextItem | undefined): ParagraphStylePatch | null {
  if (item === undefined) return null;
  switch (item.kind) {
    case "paragraphMark":
      return item.style;
    case "character":
    case "automaticText":
      return null;
    default:
      return assertNever(item);
  }
}
