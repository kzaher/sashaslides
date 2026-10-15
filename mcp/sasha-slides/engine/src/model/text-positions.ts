// TEXT POSITIONS THAT FOLLOW THE TEXT. A plain index is only right until somebody types before it.
// Two things must outlive other people's typing for longer than one change: a selection kept in
// the undo history (restored when the step is undone, perhaps minutes later), and a comment
// anchored to a text range. Both are stored as Yjs relative positions -- references to the
// characters themselves -- and resolved back to indices when they are needed.
//
// Associations: a caret sticks to the character on its LEFT, so text a collaborator inserts exactly
// at the caret lands after it (the tie-break of text-delta.ts). A comment's range starts at its first
// character and ends after its last one, so typing at either edge stays outside the range.

import * as Y from "yjs";
import type { EncodedTextAnchor, ElementId, Selection, SlideId, TextRange, TextTarget } from "../contracts/index.ts";
import { assertNever, ELEMENT_KEY } from "../contracts/index.ts";
import { childArray, elementMapOf, slideMapOf, textOf, type DocumentRoots } from "./document-paths.ts";
import { tableLineIds } from "./element-tree.ts";

/** A selection as the undo history keeps it. */
export type StoredSelection =
  | Readonly<{ kind: "plain"; selection: Selection }>
  | Readonly<{ kind: "text"; target: TextTarget; anchor: Y.RelativePosition; focus: Y.RelativePosition }>;

export const NO_STORED_SELECTION: StoredSelection = { kind: "plain", selection: { kind: "none" } };

export function storeSelection(roots: DocumentRoots, selection: Selection): StoredSelection {
  switch (selection.kind) {
    case "none":
    case "slides":
    case "elements":
    case "tableCells":
      return { kind: "plain", selection };
    case "text": {
      const text = textOf(roots, selection.target);
      if (text === null) return { kind: "plain", selection };
      return {
        kind: "text",
        target: selection.target,
        anchor: Y.createRelativePositionFromTypeIndex(text, clamp(selection.anchor, text.length), CARET_ASSOCIATION),
        focus: Y.createRelativePositionFromTypeIndex(text, clamp(selection.focus, text.length), CARET_ASSOCIATION),
      };
    }
    default:
      return assertNever(selection);
  }
}

/** The selection now: text positions resolved; the element when the text is gone; nothing when that is gone too. */
export function restoreSelection(options: Readonly<{ roots: DocumentRoots; sharedDocument: Y.Doc; stored: StoredSelection }>): Selection {
  const { roots, stored } = options;
  switch (stored.kind) {
    case "plain":
      return surviving(roots, stored.selection);
    case "text": {
      const text = textOf(roots, stored.target);
      const anchor = text === null ? null : resolveIn({ sharedDocument: options.sharedDocument, text, position: stored.anchor });
      const focus = text === null ? null : resolveIn({ sharedDocument: options.sharedDocument, text, position: stored.focus });
      if (anchor !== null && focus !== null) return { kind: "text", target: stored.target, anchor, focus };
      return elementOf(roots, stored.target);
    }
    default:
      return assertNever(stored);
  }
}

/** Text range -> two encoded relative positions; null when the target or range does not exist. */
export function encodeTextAnchor(roots: DocumentRoots, range: TextRange): EncodedTextAnchor | null {
  const text = textOf(roots, range.target);
  if (text === null) return null;
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start || range.end > text.length) return null;
  return {
    target: range.target,
    start: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, range.start, ANCHOR_START_ASSOCIATION))),
    end: toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, range.end, ANCHOR_END_ASSOCIATION))),
  };
}

/** Encoded anchors -> current ranges; null where the text is gone (or the anchor cannot be read). */
export function resolveTextAnchors(options: Readonly<{ roots: DocumentRoots; sharedDocument: Y.Doc; anchors: readonly EncodedTextAnchor[] }>): readonly (TextRange | null)[] {
  return options.anchors.map((anchor) => {
    const text = textOf(options.roots, anchor.target);
    const startPosition = decode(anchor.start);
    const endPosition = decode(anchor.end);
    if (text === null || startPosition === null || endPosition === null) return null;
    const start = resolveIn({ sharedDocument: options.sharedDocument, text, position: startPosition });
    const end = resolveIn({ sharedDocument: options.sharedDocument, text, position: endPosition });
    if (start === null || end === null || end <= start) return null;
    return { target: anchor.target, start, end };
  });
}

const CARET_ASSOCIATION = -1;
const ANCHOR_START_ASSOCIATION = 0;
const ANCHOR_END_ASSOCIATION = -1;

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(length, Math.trunc(index)));
}

/** The index of `position` in `text`, or null when it resolves into another (or a deleted) body. */
function resolveIn(options: Readonly<{ sharedDocument: Y.Doc; text: Y.Text; position: Y.RelativePosition }>): number | null {
  const absolute = Y.createAbsolutePositionFromRelativePosition(options.position, options.sharedDocument);
  if (absolute === null || absolute.type !== options.text) return null;
  return clamp(absolute.index, options.text.length);
}

/** What to select when a selection's text is gone: the element (or table) holding it, if it exists. */
function elementOf(roots: DocumentRoots, target: TextTarget): Selection {
  switch (target.kind) {
    case "element":
    case "tableCell":
      return elementMapOf(roots, target.slideId, target.elementId) === null
        ? { kind: "none" }
        : { kind: "elements", slideId: target.slideId, elementIds: [target.elementId] };
    case "speakerNotes":
      return slideMapOf(roots, target.slideId) === null ? { kind: "none" } : { kind: "slides", slideIds: [target.slideId] };
    default:
      return assertNever(target);
  }
}

/** A plain selection with whatever vanished since taken out of it. */
function surviving(roots: DocumentRoots, selection: Selection): Selection {
  switch (selection.kind) {
    case "none":
      return selection;
    case "slides": {
      const slideIds = selection.slideIds.filter((slideId) => slideMapOf(roots, slideId) !== null);
      return slideIds.length === 0 ? { kind: "none" } : { kind: "slides", slideIds };
    }
    case "elements": {
      const elementIds = selection.elementIds.filter((elementId) => elementMapOf(roots, selection.slideId, elementId) !== null);
      return elementIds.length === 0 ? { kind: "none" } : { kind: "elements", slideId: selection.slideId, elementIds };
    }
    case "tableCells": {
      const table = elementMapOf(roots, selection.slideId, selection.elementId);
      if (table === null) return { kind: "none" };
      const rows = tableLineIds(childArray(table, ELEMENT_KEY.rows));
      const columns = tableLineIds(childArray(table, ELEMENT_KEY.columns));
      const present = [selection.anchor, selection.focus].every((cell) => rows.includes(cell.rowId) && columns.includes(cell.columnId));
      return present ? selection : tableElementSelection({ slideId: selection.slideId, elementId: selection.elementId });
    }
    case "text":
      return textOf(roots, selection.target) === null ? elementOf(roots, selection.target) : selection;
    default:
      return assertNever(selection);
  }
}

function tableElementSelection(options: Readonly<{ slideId: SlideId; elementId: ElementId }>): Selection {
  return { kind: "elements", slideId: options.slideId, elementIds: [options.elementId] };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decode(encoded: string): Y.RelativePosition | null {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return Y.decodeRelativePosition(bytes);
  } catch {
    // An anchor from a damaged or foreign log entry: treated as text that is gone.
    return null;
  }
}
