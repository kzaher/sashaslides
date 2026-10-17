// RICH TEXT IN A Y.Text: reading a body into paragraphs of runs, writing one, and applying the
// editor's text operations -- with the three attribute rules of yjs-schema.ts, because Y.Text
// gives inserted characters whatever attributes it finds at the insertion point:
//
//  1. Every character insert passes the COMPLETE attribute set: the run's values, and `null` for
//     every other run key and for EVERY paragraph key (`runInsertAttributes`). Text typed at the
//     start of a paragraph therefore never inherits the previous paragraph mark's alignment or
//     list as character formatting.
//  2. A "\n" insert splits a paragraph: the new mark copies the split paragraph's paragraph
//     attributes and nulls every run key (`paragraphMarkAttributes`).
//  3. Projection keeps only run keys on characters and only paragraph keys on marks, and drops a
//     value that fails its check, so stray or damaged attributes never reach a snapshot.
//
// Run formatting skips paragraph marks, and paragraph formatting touches only marks, so the two
// namespaces stay apart on write as well as on read.

import * as Y from "yjs";
import type { TextOperation } from "../contracts/commands.ts";
import type { AutomaticTextField, Paragraph, TextBody, TextRun } from "../contracts/document.ts";
import type { ParagraphStylePatch, RunStylePatch } from "../contracts/style.ts";
import { assertNever } from "../contracts/assert-never.ts";
import { AUTOMATIC_TEXT_EMBED_KEY, PARAGRAPH_ATTRIBUTE_NAMES, RUN_ATTRIBUTE_NAMES } from "../contracts/yjs-schema.ts";
import { isRecord, PARAGRAPH_ATTRIBUTE_CHECKS, RUN_ATTRIBUTE_CHECKS, type Verdict } from "./stored-values.ts";

/** Attribute values as Yjs stores them; `null` removes an attribute (yjs-schema.ts). */
export type TextAttributes = Readonly<Record<string, unknown>>;

/** The character a body ends with and every paragraph is terminated by. */
export const PARAGRAPH_MARK = "\n";

/** Unknown embeds (a newer client's field) keep their one index as this character. */
export const UNKNOWN_EMBED_TEXT = "￼";

export function projectTextBody(text: Y.Text): TextBody {
  const paragraphs: Paragraph[] = [];
  let runs: TextRun[] = [];
  for (const operation of textDelta(text)) {
    const insert = operation.insert;
    if (typeof insert !== "string") {
      appendRun(runs, embedRun({ embed: insert, attributes: operation.attributes }));
      continue;
    }
    const pieces = insert.split(PARAGRAPH_MARK);
    pieces.forEach((piece, index) => {
      if (piece.length > 0) appendRun(runs, { kind: "text", text: piece, style: runStyleOf(operation.attributes) });
      if (index === pieces.length - 1) return;
      paragraphs.push({ style: paragraphStyleOf(operation.attributes), runs });
      runs = [];
    });
  }
  // A damaged body without its final mark still shows its last characters (validation reports it).
  if (runs.length > 0 || paragraphs.length === 0) paragraphs.push({ style: {}, runs });
  return { paragraphs };
}

/** Write `body` at the end of `text` (a freshly created Y.Text in practice). */
export function writeTextBody(text: Y.Text, body: TextBody): void {
  let index = text.length;
  for (const paragraph of body.paragraphs) {
    for (const run of paragraph.runs) {
      switch (run.kind) {
        case "text":
          if (run.text.length === 0) break;
          text.insert(index, run.text.split(PARAGRAPH_MARK).join(" "), runInsertAttributes(run.style));
          index += run.text.length;
          break;
        case "automaticText":
          text.insertEmbed(index, automaticTextEmbed(run.field), runInsertAttributes(run.style));
          index += 1;
          break;
        default:
          assertNever(run);
      }
    }
    text.insert(index, PARAGRAPH_MARK, paragraphMarkAttributes(paragraph.style));
    index += 1;
  }
}

/** Apply operations in order, each against the result of the previous one (commands.ts). */
export function applyTextOperations(text: Y.Text, operations: readonly TextOperation[]): void {
  for (const operation of operations) {
    switch (operation.kind) {
      case "insert":
        insertText({ text, index: operation.index, inserted: operation.text, style: operation.style });
        break;
      case "insertAutomaticText":
        text.insertEmbed(operation.index, automaticTextEmbed(operation.field), runInsertAttributes(operation.style));
        break;
      case "delete":
        if (operation.length > 0) text.delete(operation.index, operation.length);
        break;
      case "formatRuns":
        formatRuns({ text, index: operation.index, length: operation.length, attributes: formatAttributes({ patch: operation.patch, names: RUN_ATTRIBUTE_NAMES, clear: operation.clear }) });
        break;
      case "formatParagraphs":
        formatParagraphs({ text, index: operation.index, length: operation.length, attributes: formatAttributes({ patch: operation.patch, names: PARAGRAPH_ATTRIBUTE_NAMES, clear: operation.clear }) });
        break;
      default:
        assertNever(operation);
    }
  }
}

/** Rule 1: the run's own values, and null for every other run key and every paragraph key. */
export function runInsertAttributes(style: RunStylePatch): TextAttributes {
  return completeAttributes({ style, names: RUN_ATTRIBUTE_NAMES, nulled: PARAGRAPH_ATTRIBUTE_NAMES });
}

/** Rule 2: the paragraph's values, and null for every other paragraph key and every run key. */
export function paragraphMarkAttributes(style: ParagraphStylePatch): TextAttributes {
  return completeAttributes({ style, names: PARAGRAPH_ATTRIBUTE_NAMES, nulled: RUN_ATTRIBUTE_NAMES });
}

/** Where every paragraph mark sits, with the paragraph style it carries. */
export function paragraphMarks(text: Y.Text): readonly Readonly<{ index: number; style: ParagraphStylePatch }>[] {
  const marks: { index: number; style: ParagraphStylePatch }[] = [];
  let index = 0;
  for (const operation of textDelta(text)) {
    const insert = operation.insert;
    if (typeof insert !== "string") {
      index += 1;
      continue;
    }
    for (let offset = 0; offset < insert.length; offset += 1) {
      if (insert.charAt(offset) === PARAGRAPH_MARK) marks.push({ index: index + offset, style: paragraphStyleOf(operation.attributes) });
    }
    index += insert.length;
  }
  return marks;
}

/** True when the body's last item is a paragraph mark, as every body must (yjs-schema.ts). */
export function endsWithParagraphMark(text: Y.Text): boolean {
  const marks = paragraphMarks(text);
  const last = marks[marks.length - 1];
  return last !== undefined && last.index === text.length - 1;
}

/** Keep only run keys whose values pass their checks (rule 3). */
export function runStyleOf(attributes: TextAttributes | undefined): RunStylePatch {
  // Every key checkedAttributes copies is a RunAttributeName whose value passed that attribute's check.
  return checkedAttributes(attributes, RUN_ATTRIBUTE_CHECKS) as RunStylePatch;
}

/** Keep only paragraph keys whose values pass their checks (rule 3). */
export function paragraphStyleOf(attributes: TextAttributes | undefined): ParagraphStylePatch {
  // Every key checkedAttributes copies is a ParagraphAttributeName whose value passed that attribute's check.
  return checkedAttributes(attributes, PARAGRAPH_ATTRIBUTE_CHECKS) as ParagraphStylePatch;
}

/** The attributes named in `checks` that are set and pass their check. */
function checkedAttributes(attributes: TextAttributes | undefined, checks: Readonly<Record<string, (candidate: unknown) => Verdict>>): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  if (attributes === undefined) return style;
  for (const [name, check] of Object.entries(checks)) {
    const value = attributes[name];
    if (value === undefined || value === null) continue;
    if (check(value) === "valid") style[name] = value;
  }
  return style;
}

/** Rules 1 and 2: `style`'s value (or null) for each of `names`, and null for each of `nulled`. */
function completeAttributes(options: Readonly<{ style: Readonly<Record<string, unknown>>; names: readonly string[]; nulled: readonly string[] }>): TextAttributes {
  const attributes: Record<string, unknown> = {};
  for (const name of options.names) attributes[name] = options.style[name] ?? null;
  for (const name of options.nulled) attributes[name] = null;
  return attributes;
}

/** One delta operation as `Y.Text.toDelta` returns it. */
type DeltaInsert = Readonly<{ insert: unknown; attributes: TextAttributes | undefined }>;

function textDelta(text: Y.Text): readonly DeltaInsert[] {
  const delta: unknown = text.toDelta();
  if (!Array.isArray(delta)) return [];
  return delta.map((operation: unknown) => {
    if (!isRecord(operation)) return { insert: "", attributes: undefined };
    const attributes = operation["attributes"];
    return { insert: operation["insert"], attributes: isRecord(attributes) ? attributes : undefined };
  });
}

function embedRun(options: Readonly<{ embed: unknown; attributes: TextAttributes | undefined }>): TextRun {
  const style = runStyleOf(options.attributes);
  if (isRecord(options.embed) && options.embed[AUTOMATIC_TEXT_EMBED_KEY] === "slideNumber") return { kind: "automaticText", field: "slideNumber", style };
  return { kind: "text", text: UNKNOWN_EMBED_TEXT, style };
}

/** Append a run, merging it into the previous text run when their styles are equal. */
function appendRun(runs: TextRun[], run: TextRun): void {
  const previous = runs[runs.length - 1];
  if (previous !== undefined && previous.kind === "text" && run.kind === "text" && sameStyle(previous.style, run.style)) {
    runs[runs.length - 1] = { kind: "text", text: previous.text + run.text, style: previous.style };
    return;
  }
  runs.push(run);
}

function sameStyle(first: RunStylePatch, second: RunStylePatch): boolean {
  return RUN_ATTRIBUTE_NAMES.every((name) => JSON.stringify(first[name]) === JSON.stringify(second[name]));
}

function automaticTextEmbed(field: AutomaticTextField): Readonly<Record<string, string>> {
  return { [AUTOMATIC_TEXT_EMBED_KEY]: field };
}

/** Insert characters; each "\n" splits its paragraph, copying the paragraph's attributes (rule 2). */
function insertText(options: Readonly<{ text: Y.Text; index: number; inserted: string; style: RunStylePatch }>): void {
  const { text, style } = options;
  let index = options.index;
  const pieces = options.inserted.split(PARAGRAPH_MARK);
  pieces.forEach((piece, pieceIndex) => {
    if (piece.length > 0) {
      text.insert(index, piece, runInsertAttributes(style));
      index += piece.length;
    }
    if (pieceIndex === pieces.length - 1) return;
    const split = paragraphMarks(text).find((mark) => mark.index >= index);
    text.insert(index, PARAGRAPH_MARK, paragraphMarkAttributes(split?.style ?? {}));
    index += 1;
  });
}

/** A format's attributes: the patch's set values among `names`, and null for every cleared one. */
function formatAttributes(options: Readonly<{ patch: Readonly<Record<string, unknown>>; names: readonly string[]; clear: readonly string[] }>): TextAttributes {
  const attributes: Record<string, unknown> = {};
  for (const name of options.names) {
    const value = options.patch[name];
    if (value !== undefined) attributes[name] = value;
  }
  for (const name of options.clear) attributes[name] = null;
  return attributes;
}

/** Format the characters of [index, index + length), skipping paragraph marks. */
function formatRuns(options: Readonly<{ text: Y.Text; index: number; length: number; attributes: TextAttributes }>): void {
  const end = options.index + options.length;
  let start = options.index;
  for (const mark of paragraphMarks(options.text)) {
    if (mark.index < start) continue;
    if (mark.index >= end) break;
    if (mark.index > start) options.text.format(start, mark.index - start, { ...options.attributes });
    start = mark.index + 1;
  }
  if (end > start) options.text.format(start, end - start, { ...options.attributes });
}

/** Format the mark of every paragraph overlapping [index, index + length) (a caret: its paragraph). */
function formatParagraphs(options: Readonly<{ text: Y.Text; index: number; length: number; attributes: TextAttributes }>): void {
  const end = options.index + Math.max(options.length, 1);
  let paragraphStart = 0;
  for (const mark of paragraphMarks(options.text)) {
    const overlaps = paragraphStart < end && mark.index >= options.index;
    if (overlaps) options.text.format(mark.index, 1, { ...options.attributes });
    paragraphStart = mark.index + 1;
  }
}
