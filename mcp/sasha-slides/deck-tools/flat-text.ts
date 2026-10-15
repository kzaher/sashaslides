/**
 * A TEXT BODY AS THE Y.Text INDEX SPACE SEES IT: one item per index (a UTF-16 code unit, an
 * automatic field, or a paragraph mark). `deck_edit` computes `editText` operations against the
 * deck's snapshot, and when one call edits the same body twice (set a title, then bold a word of
 * it) the second edit's indices must be computed against the body as the first one LEAVES it. So
 * the expansion keeps each body it touches in this form and applies its own operations to it
 * with the same semantics the model gives them (engine/src/model/text-body.ts):
 *
 *  - an insert's characters carry exactly the given run style, and each "\n" in it splits the
 *    paragraph it lands in, the new mark copying that paragraph's style;
 *  - run formatting skips paragraph marks, paragraph formatting touches only marks.
 *
 * The model remains the authority: it validates and writes the operations; this only has to agree
 * with it about where things are.
 */
import type { TextOperation } from "../engine/src/contracts/commands.ts";
import type { AutomaticTextField, Paragraph, TextBody, TextRun } from "../engine/src/contracts/document.ts";
import type { ParagraphStylePatch, RunStylePatch } from "../engine/src/contracts/style.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

export type FlatItem =
  | Readonly<{ kind: "character"; character: string; style: RunStylePatch }>
  | Readonly<{ kind: "automaticText"; field: AutomaticTextField; style: RunStylePatch }>
  | Readonly<{ kind: "paragraphMark"; style: ParagraphStylePatch }>;

export type FlatText = readonly FlatItem[];

/** What a search sees at an automatic field: one character no find string can contain. */
export const AUTOMATIC_TEXT_SEARCH_CHARACTER = "￼";

export function flattenTextBody(body: TextBody): FlatText {
  const items: FlatItem[] = [];
  for (const paragraph of body.paragraphs) {
    for (const run of paragraph.runs) items.push(...flattenRun(run));
    items.push({ kind: "paragraphMark", style: paragraph.style });
  }
  return items;
}

/** Back to paragraphs of runs, adjacent characters of equal style joined into one run. */
export function textBodyOfFlat(flat: FlatText): TextBody {
  const paragraphs: Paragraph[] = [];
  let runs: TextRun[] = [];
  for (const item of flat) {
    switch (item.kind) {
      case "character": {
        const previous = runs.at(-1);
        const previousText = previous === undefined ? null : textOfRun(previous);
        if (previous !== undefined && previousText !== null && sameStyle(previous.style, item.style)) {
          runs[runs.length - 1] = { kind: "text", text: previousText + item.character, style: previous.style };
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
  if (runs.length > 0 || paragraphs.length === 0) paragraphs.push({ style: {}, runs });
  return { paragraphs };
}

/** The searchable text: characters as themselves, marks as "\n", fields as one placeholder character. */
export function searchableText(flat: FlatText): string {
  return flat.map(searchableCharacter).join("");
}

/** Applies operations in order, each against the previous one's result (commands.ts `TextOperation`). */
export function applyTextOperations(options: Readonly<{ flat: FlatText; operations: readonly TextOperation[] }>): FlatText {
  return options.operations.reduce<FlatText>((flat, operation) => applyTextOperation({ flat, operation }), options.flat);
}

/** The paragraph style that governs index `index`: that of the first mark at or after it. */
export function paragraphStyleAt(options: Readonly<{ flat: FlatText; index: number }>): ParagraphStylePatch {
  for (let position = Math.max(0, options.index); position < options.flat.length; position += 1) {
    const item = options.flat[position];
    if (item === undefined) continue;
    const style = paragraphStyleOfItem(item);
    if (style !== null) return style;
  }
  return {};
}

/** The run style of the item at `index` (a mark has none: `{}`). */
export function runStyleAt(options: Readonly<{ flat: FlatText; index: number }>): RunStylePatch {
  const item = options.flat[options.index];
  if (item === undefined) return {};
  switch (item.kind) {
    case "character":
    case "automaticText":
      return item.style;
    case "paragraphMark":
      return {};
    default:
      return assertNever(item);
  }
}

function flattenRun(run: TextRun): readonly FlatItem[] {
  switch (run.kind) {
    case "text":
      return Array.from({ length: run.text.length }, (_, index): FlatItem => ({ kind: "character", character: run.text.charAt(index), style: run.style }));
    case "automaticText":
      return [{ kind: "automaticText", field: run.field, style: run.style }];
    default:
      return assertNever(run);
  }
}

function sameStyle(first: RunStylePatch, second: RunStylePatch): boolean {
  return canonicalText(first) === canonicalText(second);
}

/** A key-order-independent text form of a plain value, for equality of style patches. */
function canonicalText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalText(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
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

function applyTextOperation(options: Readonly<{ flat: FlatText; operation: TextOperation }>): FlatText {
  const { flat, operation } = options;
  switch (operation.kind) {
    case "insert": {
      const splitStyle = paragraphStyleAt({ flat, index: operation.index });
      const inserted = Array.from({ length: operation.text.length }, (_, index): FlatItem => {
        const character = operation.text.charAt(index);
        if (character === "\n") return { kind: "paragraphMark", style: splitStyle };
        return { kind: "character", character, style: operation.style };
      });
      return [...flat.slice(0, operation.index), ...inserted, ...flat.slice(operation.index)];
    }
    case "insertAutomaticText":
      return [...flat.slice(0, operation.index), { kind: "automaticText", field: operation.field, style: operation.style }, ...flat.slice(operation.index)];
    case "delete":
      return [...flat.slice(0, operation.index), ...flat.slice(operation.index + operation.length)];
    case "formatRuns":
      return flat.map((item, index) =>
        index >= operation.index && index < operation.index + operation.length ? formatRun({ item, patch: operation.patch, clear: operation.clear }) : item,
      );
    case "formatParagraphs": {
      const marks = paragraphMarkIndexesOverlapping({ flat, index: operation.index, length: operation.length });
      return flat.map((item, index) => {
        const style = marks.has(index) ? paragraphStyleOfItem(item) : null;
        return style === null ? item : { kind: "paragraphMark", style: patched({ style, patch: operation.patch, clear: operation.clear }) };
      });
    }
    default:
      return assertNever(operation);
  }
}

function formatRun(options: Readonly<{ item: FlatItem; patch: RunStylePatch; clear: readonly string[] }>): FlatItem {
  const { item } = options;
  switch (item.kind) {
    case "character":
      return { kind: "character", character: item.character, style: patched({ style: item.style, patch: options.patch, clear: options.clear }) };
    case "automaticText":
      return { kind: "automaticText", field: item.field, style: patched({ style: item.style, patch: options.patch, clear: options.clear }) };
    case "paragraphMark":
      return item;
    default:
      return assertNever(item);
  }
}

function patched<TStyle extends Readonly<Record<string, unknown>>>(options: Readonly<{ style: TStyle; patch: TStyle; clear: readonly string[] }>): TStyle {
  const merged: Record<string, unknown> = { ...options.style, ...options.patch };
  for (const name of options.clear) delete merged[name];
  // Built from a TStyle spread with a TStyle patch, minus keys of TStyle: still a TStyle.
  return merged as TStyle;
}

/** Marks of every paragraph overlapping [index, index + length), or containing `index` when empty. */
function paragraphMarkIndexesOverlapping(options: Readonly<{ flat: FlatText; index: number; length: number }>): ReadonlySet<number> {
  const marks = new Set<number>();
  const last = options.index + Math.max(options.length, 1) - 1;
  let paragraphStart = 0;
  for (const [position, item] of options.flat.entries()) {
    if (paragraphStyleOfItem(item) === null) continue;
    if (position >= options.index && paragraphStart <= last) marks.add(position);
    paragraphStart = position + 1;
  }
  return marks;
}

/** A mark's paragraph style; null for a character or a field. */
function paragraphStyleOfItem(item: FlatItem): ParagraphStylePatch | null {
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
