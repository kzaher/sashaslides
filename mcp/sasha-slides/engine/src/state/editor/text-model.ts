// TEXT BODIES AS A FLAT SEQUENCE, the Y.Text index space (contracts/document.ts): one item per
// 16-bit code unit of the string, one per automatic field, and one paragraph mark ending every
// paragraph. The editor needs to know what a body WILL be once its queued edits apply -- to find the style at the
// caret, a word boundary for Ctrl+Backspace, the paragraphs a range overlaps, or the body an input
// method composition freezes -- and the document snapshot lags the queue by design (edits are
// applied by a feedback). So the reducer replays the queued `editText` operations over the
// snapshot's body here, with the same rules the model writes them by: an inserted "\n" splits the
// paragraph and copies its paragraph style, formats set or clear attributes, and the final
// paragraph mark can never be deleted.

import {
  assertNever,
  type AutomaticTextField,
  type Paragraph,
  type ParagraphAttributeName,
  type ParagraphStylePatch,
  type RunAttributeName,
  type RunStylePatch,
  type TextBody,
  type TextOperation,
  type TextRun,
} from "../../contracts/index.ts";

export type FlatTextItem =
  | Readonly<{ kind: "character"; character: string; style: RunStylePatch }>
  | Readonly<{ kind: "automaticText"; field: AutomaticTextField; style: RunStylePatch }>
  | Readonly<{ kind: "paragraphMark"; style: ParagraphStylePatch }>;

export type FlatText = readonly FlatTextItem[];

/** Line breaks inside a paragraph, as Slides stores them (Shift+Enter). */
export const LINE_BREAK_CHARACTER = "\u000B";

export function flattenBody(body: TextBody): FlatText {
  const items: FlatTextItem[] = [];
  for (const paragraph of body.paragraphs) {
    for (const run of paragraph.runs) pushRun(items, run);
    items.push({ kind: "paragraphMark", style: paragraph.style });
  }
  return items;
}

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
            return { ...item, style: patchRunStyle(item.style, operation.patch, operation.clear) };
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
            return { kind: "paragraphMark", style: patchParagraphStyle(item.style, operation.patch, operation.clear) };
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

export function plainTextOfFlat(items: FlatText, start: number, end: number): string {
  let text = "";
  for (let index = Math.max(0, start); index < Math.min(items.length, end); index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    switch (item.kind) {
      case "character":
        text += item.character;
        break;
      case "automaticText":
        text += "#";
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

export function patchRunStyle(style: RunStylePatch, patch: RunStylePatch, clear: readonly RunAttributeName[]): RunStylePatch {
  const merged: Record<string, unknown> = { ...style, ...patch };
  for (const name of clear) delete merged[name];
  // Built only from RunStylePatch spreads with RunAttributeName keys removed, so it is a RunStylePatch.
  return merged as RunStylePatch;
}

export function patchParagraphStyle(style: ParagraphStylePatch, patch: ParagraphStylePatch, clear: readonly ParagraphAttributeName[]): ParagraphStylePatch {
  const merged: Record<string, unknown> = { ...style, ...patch };
  for (const name of clear) delete merged[name];
  // Built only from ParagraphStylePatch spreads with ParagraphAttributeName keys removed.
  return merged as ParagraphStylePatch;
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

function pushRun(items: FlatTextItem[], run: TextRun): void {
  switch (run.kind) {
    case "text":
      for (const character of splitCodeUnits(run.text)) items.push({ kind: "character", character, style: run.style });
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
  for (const character of splitCodeUnits(options.text)) {
    if (character === "\n") inserted.push({ kind: "paragraphMark", style: splitStyle });
    else inserted.push({ kind: "character", character, style: options.style });
  }
  return spliceItems(options.items, at, 0, inserted);
}

function paragraphStyleAt(items: FlatText, index: number): ParagraphStylePatch {
  return paragraphStyleOfItem(items[paragraphEndAt(items, index)]) ?? {};
}

function spliceItems(items: FlatText, start: number, deleteCount: number, inserted: readonly FlatTextItem[]): FlatText {
  return [...items.slice(0, start), ...inserted, ...items.slice(start + deleteCount)];
}

function clampIndex(items: FlatText, index: number): number {
  return Math.max(0, Math.min(Math.max(0, items.length - 1), index));
}

function runStyleOfItem(item: FlatTextItem | undefined): RunStylePatch | null {
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

function splitCodeUnits(text: string): readonly string[] {
  const units: string[] = [];
  for (let index = 0; index < text.length; index += 1) units.push(text.charAt(index));
  return units;
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

function textOfRun(run: TextRun): string | null {
  switch (run.kind) {
    case "text":
      return run.text;
    case "automaticText":
      return null;
    default:
      return assertNever(run);
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
