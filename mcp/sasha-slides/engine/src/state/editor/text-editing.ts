// TEXT EDITING AND INPUT METHOD COMPOSITION (SPEC.md section 7, "Text editing"). The view's inline
// editor prevents the browser from writing the page and reports every `beforeinput` as a `TextInput`;
// this file turns each one into `editText` operations against the body as it WILL be once the queue
// applies (editor-queue.ts `optimisticText`), and moves the caret when the edit is queued, not when it
// settles. With the mailbox's feedback-first order that is what keeps fast typing in order: the
// second keystroke is always computed from the caret the first one left.
//
// Composition cannot be prevented, so it is frozen instead: `compositionStarted` records the start
// and freezes the body the view renders, remote changes only move `startIndex` (document-changes.ts),
// and `compositionEnded` inserts the composed text at the moved index and bumps `renderGeneration`
// so React remounts the paragraphs the browser wrote into.

import {
  assertNever,
  type EditorState,
  type ElementId,
  type ElementSnapshot,
  type FontStyleName,
  type ListGlyph,
  type ListId,
  type ListMembership,
  type NoList,
  type ParagraphAttributeName,
  type ParagraphStylePatch,
  type PastedText,
  type RunAttributeName,
  type RunStyle,
  type RunStylePatch,
  type Selection,
  type SlideId,
  type SlideSnapshot,
  type TextInput,
  type TextOperation,
  type TextTarget,
} from "../../contracts/index.ts";
import { findElementPath, findPlaceholderRole, findSlide, leavesOf, tableOf, textShapeOf } from "./document-lookup.ts";
import { createIdMinter } from "./id-minter.ts";
import { optimisticText, queueEnvelope, queueHistory } from "./editor-queue.ts";
import { selectedElements, textSelectionOf, type TextSelection } from "./editor-selection.ts";
import {
  characterLengthAt,
  characterLengthBefore,
  LINE_BREAK_CHARACTER,
  nextWordBoundary,
  paragraphEndAt,
  paragraphMarkIndices,
  paragraphStartAt,
  paragraphStylesOverlapping,
  patchRunStyle,
  previousWordBoundary,
  runStyleAt,
  bodyFromFlat,
  type FlatText,
} from "./text-model.ts";

/** List levels run 0..8 (nine levels, as Slides). */
export const MAXIMUM_LIST_LEVEL = 8;

export function reduceTextInput(state: EditorState, input: TextInput): EditorState {
  const selection = textSelectionOf(state.selection);
  if (selection === null) {
    switch (input.kind) {
      case "history":
        return queueHistory(state, input.direction);
      default:
        return state;
    }
  }
  const items = optimisticText(state, selection.target);
  if (items === null) return state;
  const range = rangeOf(selection);
  switch (input.kind) {
    case "insertText":
      return typeText({ state, selection, items, text: input.text, merge: true });
    case "replaceRange": {
      const start = clamp(Math.min(input.anchor, input.focus), items);
      const end = clamp(Math.max(input.anchor, input.focus), items);
      return replaceText({ state, target: selection.target, items, start, end, text: input.text, merge: false });
    }
    case "insertParagraph":
      return typeText({ state, selection, items, text: "\n", merge: true });
    case "insertLineBreak":
      return typeText({ state, selection, items, text: LINE_BREAK_CHARACTER, merge: true });
    case "insertTab":
      return insertTab({ state, selection, items, outdent: input.outdent });
    case "deleteBackward":
      return deleteBackward({ state, selection, items, unit: input.unit });
    case "deleteForward":
      return deleteForward({ state, selection, items, unit: input.unit });
    case "deleteByCut":
      return range.end > range.start ? deleteRange({ state, target: selection.target, start: range.start, end: range.end }) : state;
    case "insertFromPaste":
      return pasteText({ state, target: selection.target, items, start: range.start, end: range.end, content: input.content });
    case "insertFromDrop": {
      const index = clamp(input.index, items);
      return pasteText({ state, target: selection.target, items, start: index, end: index, content: input.content });
    }
    case "history":
      return queueHistory(state, input.direction);
    case "toggleFormat":
      return toggleFormat({ state, selection, items, format: input.format });
    default:
      return assertNever(input);
  }
}

/** Enter text mode on an element of the current slide (double click, Enter, a new text box). */
/**
 * Put the caret into a text body. Only a body on the CURRENT slide can be entered (the canvas and
 * the notes panel both show the current slide); an element's own text needs a text-bearing shape,
 * a table cell needs its table, and entering either one enters the group that holds it.
 */
export function startTextEditing(state: EditorState, target: TextTarget, at: "end" | "selectAll" | Readonly<{ index: number }>): EditorState {
  if (state.currentSlideId === null || target.slideId !== state.currentSlideId) return state;
  const slide = findSlide(state.document, target.slideId);
  if (slide === null) return state;
  const entered = enteredGroupFor({ state, slide, target });
  if (entered === null) return state;
  const items = optimisticText(state, target);
  if (items === null) return state;
  const caret = caretFor(at, items.length - 1);
  return {
    ...state,
    selection: { kind: "text", target, anchor: caret.anchor, focus: caret.focus },
    enteredGroupId: entered.groupId,
    tool: { kind: "select" },
    textEditing: { ...state.textEditing, typingStyle: {} },
  };
}

/** The group entering `target` leaves the editor in, or null when the target cannot take a caret. */
function enteredGroupFor(options: Readonly<{ state: EditorState; slide: SlideSnapshot; target: TextTarget }>): Readonly<{ groupId: ElementId | null }> | null {
  const { state, slide, target } = options;
  switch (target.kind) {
    case "speakerNotes":
      return { groupId: state.enteredGroupId };
    case "element": {
      const path = findElementPath(slide, target.elementId);
      const element = path?.at(-1);
      if (path === null || element === undefined || textShapeOf(element) === null) return null;
      return { groupId: path.at(-2)?.id ?? state.enteredGroupId };
    }
    case "tableCell": {
      const path = findElementPath(slide, target.elementId);
      const element = path?.at(-1);
      const table = element === undefined ? null : tableOf(element);
      if (path === null || table === null) return null;
      const hasCell = table.rows.some((row) => row.id === target.cell.rowId) && table.columns.some((column) => column.id === target.cell.columnId);
      return hasCell ? { groupId: path.at(-2)?.id ?? state.enteredGroupId } : null;
    }
    default:
      return assertNever(target);
  }
}

export function changeTextSelection(state: EditorState, anchor: number, focus: number): EditorState {
  const selection = textSelectionOf(state.selection);
  if (selection === null) return state;
  const items = optimisticText(state, selection.target);
  if (items === null) return state;
  const clampedAnchor = clamp(anchor, items);
  const clampedFocus = clamp(focus, items);
  if (clampedAnchor === selection.anchor && clampedFocus === selection.focus) return state;
  return {
    ...state,
    selection: { ...selection, anchor: clampedAnchor, focus: clampedFocus },
    textEditing: { ...state.textEditing, typingStyle: {} },
  };
}

/** Leave text mode: the element stays selected (speaker notes leave nothing selected). */
export function endTextEditing(state: EditorState): EditorState {
  const selection = textSelectionOf(state.selection);
  if (selection === null) return state;
  return {
    ...state,
    selection: selectionAfterTextMode(selection.target),
    textEditing: { ...state.textEditing, composition: null, typingStyle: {} },
  };
}

export function selectionAfterTextMode(target: TextTarget): Selection {
  switch (target.kind) {
    case "element":
    case "tableCell":
      return { kind: "elements", slideId: target.slideId, elementIds: [target.elementId] };
    case "speakerNotes":
      return { kind: "none" };
    default:
      return assertNever(target);
  }
}

export function startComposition(state: EditorState, anchor: number, focus: number): EditorState {
  const selection = textSelectionOf(state.selection);
  if (selection === null || state.textEditing.composition !== null) return state;
  const before = optimisticText(state, selection.target);
  if (before === null) return state;
  const start = clamp(Math.min(anchor, focus), before);
  const end = clamp(Math.max(anchor, focus), before);
  const deleted = end > start ? deleteRange({ state, target: selection.target, start, end }) : { ...state, selection: { ...selection, anchor: start, focus: start } };
  const frozen = optimisticText(deleted, selection.target);
  if (frozen === null) return state;
  return {
    ...deleted,
    textEditing: { ...deleted.textEditing, composition: { target: selection.target, startIndex: start, frozenBody: bodyFromFlat(frozen) } },
  };
}

export function endComposition(state: EditorState, text: string): EditorState {
  const composition = state.textEditing.composition;
  if (composition === null) {
    const selection = textSelectionOf(state.selection);
    const items = selection === null ? null : optimisticText(state, selection.target);
    if (selection === null || items === null || text.length === 0) return state;
    return typeText({ state, selection, items, text, merge: true });
  }
  const unfrozen: EditorState = {
    ...state,
    textEditing: { ...state.textEditing, composition: null, renderGeneration: state.textEditing.renderGeneration + 1 },
  };
  const items = optimisticText(unfrozen, composition.target);
  if (items === null) return { ...unfrozen, selection: { kind: "none" } };
  const index = clamp(composition.startIndex, items);
  if (text.length === 0) {
    return { ...unfrozen, selection: { kind: "text", target: composition.target, anchor: index, focus: index } };
  }
  return replaceText({ state: unfrozen, target: composition.target, items, start: index, end: index, text, merge: true });
}

/** Run style for a text range, the caret's typing style, or whole bodies of selected elements. */
export function applyRunStyle(state: EditorState, patch: RunStylePatch, clear: readonly RunAttributeName[]): EditorState {
  const selection = textSelectionOf(state.selection);
  if (selection !== null) {
    const range = rangeOf(selection);
    if (range.end === range.start) {
      return { ...state, textEditing: { ...state.textEditing, typingStyle: patchRunStyle(state.textEditing.typingStyle, patch, clear) } };
    }
    return queueTextOperations({
      state,
      target: selection.target,
      operations: [{ kind: "formatRuns", index: range.start, length: range.end - range.start, patch, clear }],
      caret: { anchor: selection.anchor, focus: selection.focus },
      merge: false,
    });
  }
  return formatWholeBodies(state, (length) => [{ kind: "formatRuns", index: 0, length, patch, clear }]);
}

/**
 * Paragraph style for every paragraph overlapping the selection, or whole bodies of selected
 * elements. A LIST value picks a glyph (the list style picker, SPEC.md 21.9): `chooseListGlyph`
 * keeps each paragraph's own list and level, so its `listId` and `level` are not read here.
 */
export function applyParagraphStyle(state: EditorState, patch: ParagraphStylePatch, clear: readonly ParagraphAttributeName[]): EditorState {
  const list = patch.list === undefined ? null : listMembershipOf(patch.list);
  if (list !== null) return chooseListGlyph(state, list.glyph);
  const selection = textSelectionOf(state.selection);
  if (selection !== null) {
    const range = rangeOf(selection);
    return queueTextOperations({
      state,
      target: selection.target,
      operations: [{ kind: "formatParagraphs", index: range.start, length: range.end - range.start, patch, clear }],
      caret: { anchor: selection.anchor, focus: selection.focus },
      merge: false,
    });
  }
  return formatWholeBodies(state, (length) => [{ kind: "formatParagraphs", index: 0, length, patch, clear }]);
}

/** Bulleted or numbered: on when any overlapping paragraph is not already that kind of list. */
export function toggleList(state: EditorState, list: "bulleted" | "numbered"): EditorState {
  const minter = createIdMinter(state.idSeed);
  const glyph = LIST_GLYPH[list];
  const selection = textSelectionOf(state.selection);
  if (selection !== null) {
    const items = optimisticText(state, selection.target);
    if (items === null) return state;
    const range = rangeOf(selection);
    const styles = paragraphStylesOverlapping({ items, index: range.start, length: range.end - range.start });
    const memberships = styles.map((style) => listMembershipOf(style.list));
    const allAlready = memberships.every((membership) => membership !== null && LIST_FAMILY[membership.glyph] === list);
    const existing = memberships.find((membership) => membership !== null) ?? null;
    const value: ListMembership | NoList = allAlready
      ? { kind: "none" }
      : { kind: "list", listId: existing?.listId ?? minter.next("list"), glyph, level: existing?.level ?? 0 };
    return queueTextOperations({
      state: { ...state, idSeed: minter.seed() },
      target: selection.target,
      operations: [{ kind: "formatParagraphs", index: range.start, length: range.end - range.start, patch: { list: value }, clear: [] }],
      caret: { anchor: selection.anchor, focus: selection.focus },
      merge: false,
    });
  }
  const listId = minter.next("list");
  return formatWholeBodies({ ...state, idSeed: minter.seed() }, (length) => [
    { kind: "formatParagraphs", index: 0, length, patch: { list: { kind: "list", listId, glyph, level: 0 } }, clear: [] },
  ]);
}

/**
 * The list style picker: every paragraph overlapping the selection (or every paragraph of the
 * selected elements' bodies) gets `glyph`, one `formatParagraphs` per paragraph. A paragraph already
 * in a list keeps its list and level; one that is not joins the first list among them, or a new one.
 */
export function chooseListGlyph(state: EditorState, glyph: ListGlyph): EditorState {
  const minter = createIdMinter(state.idSeed);
  let newListId: ListId | null = null;
  const listIdFor = (memberships: readonly (ListMembership | null)[]): ListId => {
    const existing = memberships.find((membership) => membership !== null)?.listId;
    if (existing !== undefined) return existing;
    newListId = newListId ?? minter.next("list");
    return newListId;
  };
  const operationsFor = (items: FlatText, index: number, length: number): readonly TextOperation[] => {
    const marks = [...paragraphMarkIndices({ items, index, length })];
    const memberships = marks.map((mark) => listMembershipOf(paragraphStylesOverlapping({ items, index: mark, length: 0 })[0]?.list));
    const joined = memberships.some((membership) => membership === null) ? listIdFor(memberships) : null;
    return marks.map((mark, position): TextOperation => {
      const membership = memberships[position] ?? null;
      const list: ListMembership = membership === null ? { kind: "list", listId: joined ?? listIdFor(memberships), glyph, level: 0 } : { ...membership, glyph };
      return { kind: "formatParagraphs", index: mark, length: 1, patch: { list }, clear: [] };
    });
  };
  const selection = textSelectionOf(state.selection);
  if (selection !== null) {
    const items = optimisticText(state, selection.target);
    if (items === null) return state;
    const range = rangeOf(selection);
    const operations = operationsFor(items, range.start, range.end - range.start);
    return queueTextOperations({ state: { ...state, idSeed: minter.seed() }, target: selection.target, operations, caret: { anchor: selection.anchor, focus: selection.focus }, merge: false });
  }
  const selected = selectedElements(state);
  if (selected === null) return state;
  const commands = selected.elements
    .flatMap((element) => leavesOf(element))
    .flatMap((element) => textTargetsOf(selected.slide.id, element))
    .flatMap((target) => {
      const items = optimisticText(state, target);
      if (items === null) return [];
      return [{ kind: "editText" as const, target, basedOnRevision: state.document.revision, operations: operationsFor(items, 0, items.length) }];
    });
  return queueEnvelope({ ...state, idSeed: minter.seed() }, { commands, selectionAfter: state.selection, mergeWithPrevious: false });
}

/** Tab and Shift+Tab in a list: every overlapping list paragraph one level in or out. */
export function changeListLevel(state: EditorState, delta: 1 | -1): EditorState {
  const selection = textSelectionOf(state.selection);
  if (selection === null) return state;
  const items = optimisticText(state, selection.target);
  if (items === null) return state;
  const range = rangeOf(selection);
  const operations: TextOperation[] = [];
  for (const markIndex of paragraphMarkIndices({ items, index: range.start, length: range.end - range.start })) {
    const style = paragraphStylesOverlapping({ items, index: markIndex, length: 0 })[0];
    const membership = listMembershipOf(style?.list);
    if (membership === null) continue;
    const level = Math.max(0, Math.min(MAXIMUM_LIST_LEVEL, membership.level + delta));
    if (level === membership.level) continue;
    operations.push({ kind: "formatParagraphs", index: markIndex, length: 1, patch: { list: { ...membership, level } }, clear: [] });
  }
  return queueTextOperations({ state, target: selection.target, operations, caret: { anchor: selection.anchor, focus: selection.focus }, merge: false });
}

/** Whether Tab at this text selection changes a list level (true) or types a tab character. */
export function selectionIsInList(state: EditorState): boolean {
  const selection = textSelectionOf(state.selection);
  if (selection === null) return false;
  const items = optimisticText(state, selection.target);
  if (items === null) return false;
  const range = rangeOf(selection);
  return paragraphStylesOverlapping({ items, index: range.start, length: range.end - range.start }).some((style) => listMembershipOf(style.list) !== null);
}

export function insertAutomaticTextAtCaret(state: EditorState): EditorState {
  const selection = textSelectionOf(state.selection);
  if (selection === null) return state;
  const items = optimisticText(state, selection.target);
  if (items === null) return state;
  const range = rangeOf(selection);
  const style = { ...runStyleAt(items, range.start), ...state.textEditing.typingStyle };
  const operations: TextOperation[] = [];
  if (range.end > range.start) operations.push({ kind: "delete", index: range.start, length: range.end - range.start });
  operations.push({ kind: "insertAutomaticText", index: range.start, field: "slideNumber", style });
  return queueTextOperations({ state, target: selection.target, operations, caret: { anchor: range.start + 1, focus: range.start + 1 }, merge: false });
}

/** The run style a character resolves to: its own, then its placeholder role's, then the theme's. */
export function resolvedRunStyle(state: EditorState, target: TextTarget, patch: RunStylePatch): RunStyle {
  const theme = state.document.theme;
  const role = findPlaceholderRole(state.document, target);
  const placeholder = role === null ? {} : theme.placeholderStyles[role].run;
  return { ...theme.defaultRunStyle, ...placeholder, ...patch };
}

export function rangeOf(selection: TextSelection): Readonly<{ start: number; end: number }> {
  return { start: Math.min(selection.anchor, selection.focus), end: Math.max(selection.anchor, selection.focus) };
}

/** One `editText` envelope; the caret moves to `caret` now (editor-state.ts header). */
export function queueTextOperations(
  options: Readonly<{
    state: EditorState;
    target: TextTarget;
    operations: readonly TextOperation[];
    caret: Readonly<{ anchor: number; focus: number }>;
    merge: boolean;
  }>,
): EditorState {
  if (options.operations.length === 0) return options.state;
  const queued = queueEnvelope(options.state, {
    commands: [{ kind: "editText", target: options.target, basedOnRevision: options.state.document.revision, operations: options.operations }],
    selectionAfter: { kind: "text", target: options.target, anchor: options.caret.anchor, focus: options.caret.focus },
    mergeWithPrevious: options.merge,
  });
  return { ...queued, textEditing: { ...queued.textEditing, typingStyle: {} } };
}

export function listMembershipOf(list: ListMembership | NoList | undefined): ListMembership | null {
  if (list === undefined) return null;
  switch (list.kind) {
    case "list":
      return list;
    case "none":
      return null;
    default:
      return assertNever(list);
  }
}

const LIST_GLYPH: Readonly<Record<"bulleted" | "numbered", ListGlyph>> = { bulleted: "disc", numbered: "decimal" };

const TOGGLED_FONT_STYLE: Readonly<Record<FontStyleName, FontStyleName>> = { normal: "italic", italic: "normal" };

const LIST_FAMILY: Readonly<Record<ListGlyph, "bulleted" | "numbered">> = {
  disc: "bulleted",
  circle: "bulleted",
  square: "bulleted",
  arrow: "bulleted",
  star: "bulleted",
  checkbox: "bulleted",
  decimal: "numbered",
  decimalZeroPadded: "numbered",
  upperAlphabetic: "numbered",
  lowerAlphabetic: "numbered",
  upperRoman: "numbered",
  lowerRoman: "numbered",
};

export function toggledPatch(current: RunStyle, format: "bold" | "italic" | "underline" | "strikethrough"): RunStylePatch {
  switch (format) {
    case "bold":
      return { fontWeight: current.fontWeight >= 600 ? 400 : 700 };
    case "italic":
      return { fontStyle: TOGGLED_FONT_STYLE[current.fontStyle] };
    case "underline":
      return { underline: !current.underline };
    case "strikethrough":
      return { strikethrough: !current.strikethrough };
    default:
      return assertNever(format);
  }
}

function typeText(options: Readonly<{ state: EditorState; selection: TextSelection; items: FlatText; text: string; merge: boolean }>): EditorState {
  const range = rangeOf(options.selection);
  return replaceText({ state: options.state, target: options.selection.target, items: options.items, start: range.start, end: range.end, text: options.text, merge: options.merge });
}

/** Replace [start, end) with `text` in the style text typed there continues; the caret lands after it. */
function replaceText(
  options: Readonly<{ state: EditorState; target: TextTarget; items: FlatText; start: number; end: number; text: string; merge: boolean }>,
): EditorState {
  const style = { ...styleForReplacing(options.items, options.start, options.end), ...options.state.textEditing.typingStyle };
  const operations: TextOperation[] = [];
  if (options.end > options.start) operations.push({ kind: "delete", index: options.start, length: options.end - options.start });
  if (options.text.length > 0) operations.push({ kind: "insert", index: options.start, text: options.text, style });
  const caret = options.start + options.text.length;
  return queueTextOperations({ state: options.state, target: options.target, operations, caret: { anchor: caret, focus: caret }, merge: options.merge });
}

function styleForReplacing(items: FlatText, start: number, end: number): RunStylePatch {
  if (end > start) return runStyleAt(items, start + 1);
  return runStyleAt(items, start);
}

function deleteRange(options: Readonly<{ state: EditorState; target: TextTarget; start: number; end: number }>): EditorState {
  return queueTextOperations({
    state: options.state,
    target: options.target,
    operations: [{ kind: "delete", index: options.start, length: options.end - options.start }],
    caret: { anchor: options.start, focus: options.start },
    merge: true,
  });
}

function deleteBackward(options: Readonly<{ state: EditorState; selection: TextSelection; items: FlatText; unit: "character" | "word" | "line" }>): EditorState {
  const range = rangeOf(options.selection);
  if (range.end > range.start) return deleteRange({ state: options.state, target: options.selection.target, start: range.start, end: range.end });
  const caret = range.start;
  if (caret === 0) return options.state;
  const start = backwardStart(options.items, caret, options.unit);
  return deleteRange({ state: options.state, target: options.selection.target, start, end: caret });
}

function backwardStart(items: FlatText, caret: number, unit: "character" | "word" | "line"): number {
  switch (unit) {
    case "character":
      return caret - characterLengthBefore(items, caret);
    case "word":
      return previousWordBoundary(items, caret);
    case "line": {
      const start = paragraphStartAt(items, caret);
      return start === caret ? caret - 1 : start;
    }
    default:
      return assertNever(unit);
  }
}

function deleteForward(options: Readonly<{ state: EditorState; selection: TextSelection; items: FlatText; unit: "character" | "word" | "line" }>): EditorState {
  const range = rangeOf(options.selection);
  if (range.end > range.start) return deleteRange({ state: options.state, target: options.selection.target, start: range.start, end: range.end });
  const caret = range.start;
  // The final paragraph mark is never deleted.
  if (caret >= options.items.length - 1) return options.state;
  const end = forwardEnd(options.items, caret, options.unit);
  return deleteRange({ state: options.state, target: options.selection.target, start: caret, end: Math.min(end, options.items.length - 1) });
}

function forwardEnd(items: FlatText, caret: number, unit: "character" | "word" | "line"): number {
  switch (unit) {
    case "character":
      return caret + characterLengthAt(items, caret);
    case "word":
      return nextWordBoundary(items, caret);
    case "line": {
      const end = paragraphEndAt(items, caret);
      return end === caret ? caret + 1 : end;
    }
    default:
      return assertNever(unit);
  }
}

function insertTab(options: Readonly<{ state: EditorState; selection: TextSelection; items: FlatText; outdent: boolean }>): EditorState {
  if (selectionIsInList(options.state)) return changeListLevel(options.state, options.outdent ? -1 : 1);
  if (options.outdent) return options.state;
  return typeText({ state: options.state, selection: options.selection, items: options.items, text: "\t", merge: true });
}

function pasteText(
  options: Readonly<{ state: EditorState; target: TextTarget; items: FlatText; start: number; end: number; content: PastedText }>,
): EditorState {
  switch (options.content.kind) {
    case "plain":
      return replaceText({ ...options, text: options.content.text.replace(/\r\n?/gu, "\n"), merge: false });
    case "rich": {
      const operations: TextOperation[] = [];
      if (options.end > options.start) operations.push({ kind: "delete", index: options.start, length: options.end - options.start });
      let cursor = options.start;
      const paragraphs = options.content.paragraphs;
      paragraphs.forEach((paragraph, paragraphIndex) => {
        const paragraphStart = cursor;
        for (const run of paragraph.runs) {
          switch (run.kind) {
            case "text":
              if (run.text.length === 0) break;
              operations.push({ kind: "insert", index: cursor, text: run.text, style: run.style });
              cursor += run.text.length;
              break;
            case "automaticText":
              operations.push({ kind: "insertAutomaticText", index: cursor, field: run.field, style: run.style });
              cursor += 1;
              break;
            default:
              assertNever(run);
          }
        }
        if (paragraphIndex === paragraphs.length - 1) return;
        operations.push({ kind: "insert", index: cursor, text: "\n", style: {} });
        cursor += 1;
        if (Object.keys(paragraph.style).length > 0) {
          operations.push({ kind: "formatParagraphs", index: paragraphStart, length: cursor - paragraphStart, patch: paragraph.style, clear: [] });
        }
      });
      return queueTextOperations({ state: options.state, target: options.target, operations, caret: { anchor: cursor, focus: cursor }, merge: false });
    }
    default:
      return assertNever(options.content);
  }
}

function toggleFormat(
  options: Readonly<{ state: EditorState; selection: TextSelection; items: FlatText; format: "bold" | "italic" | "underline" | "strikethrough" }>,
): EditorState {
  const range = rangeOf(options.selection);
  const current = resolvedRunStyle(options.state, options.selection.target, {
    ...(range.end > range.start ? runStyleAt(options.items, range.start + 1) : runStyleAt(options.items, range.start)),
    ...options.state.textEditing.typingStyle,
  });
  const patch = toggledPatch(current, options.format);
  return applyRunStyle(options.state, patch, []);
}

/** One envelope formatting every text body of the selected elements (shapes, and table cells). */
function formatWholeBodies(state: EditorState, operationsFor: (length: number) => readonly TextOperation[]): EditorState {
  const selected = selectedElements(state);
  if (selected === null) return state;
  const commands = selected.elements
    .flatMap((element) => leavesOf(element))
    .flatMap((element) => textTargetsOf(selected.slide.id, element))
    .flatMap((target) => {
      const items = optimisticText(state, target);
      if (items === null) return [];
      return [{ kind: "editText" as const, target, basedOnRevision: state.document.revision, operations: operationsFor(items.length) }];
    });
  return queueEnvelope(state, { commands, selectionAfter: state.selection, mergeWithPrevious: false });
}

function textTargetsOf(slideId: SlideId, element: ElementSnapshot): readonly TextTarget[] {
  switch (element.kind) {
    case "shape":
      return [{ kind: "element", slideId, elementId: element.id }];
    case "table":
      return element.cells.map((cell) => ({ kind: "tableCell", slideId, elementId: element.id, cell: { rowId: cell.rowId, columnId: cell.columnId } }));
    case "group":
    case "image":
    case "line":
    case "unsupported":
      return [];
    default:
      return assertNever(element);
  }
}

function caretFor(at: "end" | "selectAll" | Readonly<{ index: number }>, end: number): Readonly<{ anchor: number; focus: number }> {
  if (typeof at === "string") {
    switch (at) {
      case "end":
        return { anchor: end, focus: end };
      case "selectAll":
        return { anchor: 0, focus: end };
      default:
        return assertNever(at);
    }
  }
  const index = Math.max(0, Math.min(end, at.index));
  return { anchor: index, focus: index };
}

function clamp(index: number, items: FlatText): number {
  return Math.max(0, Math.min(items.length - 1, index));
}
