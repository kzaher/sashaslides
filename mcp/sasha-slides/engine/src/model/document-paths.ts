// FINDING THINGS IN THE Y.Doc: the six root maps, a slide, an element, a text body, and the way
// back from any Yjs type to the document path it sits at. Every other model file goes through
// these, so the layout of yjs-schema.ts is spelled out in exactly one place for reads.
//
// The way back (`typePath`) is what makes per-transaction change reports cheap: Yjs says WHICH
// types changed, and walking each one's parent chain names the slide, the element and the text
// body involved without diffing anything.

import * as Y from "yjs";
import type { DocumentRootName, ElementId, SlideId, TableColumnId, TableRowId, TextTarget } from "../contracts/index.ts";
import { assertNever, DOCUMENT_ROOT, ELEMENT_KEY, SLIDE_KEY, TABLE_CELL_KEY, tableCellKey } from "../contracts/index.ts";

/** The root maps of a document Y.Doc (yjs-schema.ts). */
export type DocumentRoots = Readonly<Record<DocumentRootName, Y.Map<unknown>>>;

/** Any Yjs type, as far as finding its place in the tree needs (Yjs types differ in their event type). */
export type TypeInTree = Readonly<{ _item: Y.Item | null }>;

/** Where a Yjs type sits: its root and the map keys from that root down to it. */
export type DocumentPath = Readonly<{ root: DocumentRootName; keys: readonly string[] }>;

export function documentRoots(sharedDocument: Y.Doc): DocumentRoots {
  return {
    meta: sharedDocument.getMap<unknown>(DOCUMENT_ROOT.meta),
    theme: sharedDocument.getMap<unknown>(DOCUMENT_ROOT.theme),
    layouts: sharedDocument.getMap<unknown>(DOCUMENT_ROOT.layouts),
    slides: sharedDocument.getMap<unknown>(DOCUMENT_ROOT.slides),
    assets: sharedDocument.getMap<unknown>(DOCUMENT_ROOT.assets),
    transitionScripts: sharedDocument.getMap<unknown>(DOCUMENT_ROOT.transitionScripts),
  };
}

export function childMap(map: Y.Map<unknown>, key: string): Y.Map<unknown> | null {
  const value = map.get(key);
  // Every Y.Map in this document is created as Y.Map<unknown> (document-writer.ts); the element
  // type parameter is erased at runtime, so the instanceof check is the whole proof.
  return value instanceof Y.Map ? (value as Y.Map<unknown>) : null;
}

export function childText(map: Y.Map<unknown>, key: string): Y.Text | null {
  const value = map.get(key);
  return value instanceof Y.Text ? value : null;
}

export function childArray(map: Y.Map<unknown>, key: string): Y.Array<unknown> | null {
  const value = map.get(key);
  // As in `childMap`: arrays are created as Y.Array<unknown>, and only the instanceof check matters.
  return value instanceof Y.Array ? (value as Y.Array<unknown>) : null;
}

export function slideMapOf(roots: DocumentRoots, slideId: SlideId): Y.Map<unknown> | null {
  return childMap(roots.slides, slideId);
}

export function elementsMapOf(roots: DocumentRoots, slideId: SlideId): Y.Map<unknown> | null {
  const slide = slideMapOf(roots, slideId);
  return slide === null ? null : childMap(slide, SLIDE_KEY.elements);
}

export function elementMapOf(roots: DocumentRoots, slideId: SlideId, elementId: ElementId): Y.Map<unknown> | null {
  const elements = elementsMapOf(roots, slideId);
  return elements === null ? null : childMap(elements, elementId);
}

export function cellMapOf(
  options: Readonly<{ roots: DocumentRoots; slideId: SlideId; elementId: ElementId; rowId: TableRowId; columnId: TableColumnId }>,
): Y.Map<unknown> | null {
  const element = elementMapOf(options.roots, options.slideId, options.elementId);
  const cells = element === null ? null : childMap(element, ELEMENT_KEY.cells);
  return cells === null ? null : childMap(cells, tableCellKey({ rowId: options.rowId, columnId: options.columnId }));
}

/** The Y.Text of a text target; null when the target (or, for a table cell, the cell map) does not exist. */
export function textOf(roots: DocumentRoots, target: TextTarget): Y.Text | null {
  switch (target.kind) {
    case "element": {
      const element = elementMapOf(roots, target.slideId, target.elementId);
      return element === null ? null : childText(element, ELEMENT_KEY.text);
    }
    case "tableCell": {
      const cell = cellMapOf({ roots, slideId: target.slideId, elementId: target.elementId, rowId: target.cell.rowId, columnId: target.cell.columnId });
      return cell === null ? null : childText(cell, TABLE_CELL_KEY.text);
    }
    case "speakerNotes": {
      const slide = slideMapOf(roots, target.slideId);
      return slide === null ? null : childText(slide, SLIDE_KEY.speakerNotes);
    }
    default:
      return assertNever(target);
  }
}

/** The path of a Yjs type inside this document, or null for a type that is not under a root map. */
export function typePath(roots: DocumentRoots, type: TypeInTree): DocumentPath | null {
  const keys: string[] = [];
  let current: TypeInTree = type;
  for (;;) {
    const item = current._item;
    if (item === null) {
      const root = rootNameOf(roots, current);
      return root === null ? null : { root, keys: keys.reverse() };
    }
    if (item.parentSub === null) return null;
    keys.push(item.parentSub);
    const parent = item.parent;
    if (!(parent instanceof Y.AbstractType)) return null;
    current = parent;
  }
}

/** The text target a Y.Text at `path` is, or null for text that is not a target (a layout's). */
export function textTargetAt(path: DocumentPath): TextTarget | null {
  if (path.root !== "slides") return null;
  const [slideKey, second, elementKey, fourth, cellKey, sixth] = path.keys;
  if (slideKey === undefined) return null;
  // Keys under the slides root are slide ids by construction (document-writer.ts).
  const slideId = slideKey as SlideId;
  if (path.keys.length === 2 && second === SLIDE_KEY.speakerNotes) return { kind: "speakerNotes", slideId };
  if (second !== SLIDE_KEY.elements || elementKey === undefined) return null;
  // Keys under a slide's elements map are element ids by construction.
  const elementId = elementKey as ElementId;
  if (path.keys.length === 4 && fourth === ELEMENT_KEY.text) return { kind: "element", slideId, elementId };
  if (path.keys.length === 6 && fourth === ELEMENT_KEY.cells && sixth === TABLE_CELL_KEY.text && cellKey !== undefined) {
    const separator = cellKey.indexOf("|");
    if (separator < 0) return null;
    // Cell keys are "rowId|columnId" (yjs-schema.ts `tableCellKey`); ids never contain "|".
    const rowId = cellKey.slice(0, separator) as TableRowId;
    const columnId = cellKey.slice(separator + 1) as TableColumnId;
    return { kind: "tableCell", slideId, elementId, cell: { rowId, columnId } };
  }
  return null;
}

function rootNameOf(roots: DocumentRoots, type: TypeInTree): DocumentRootName | null {
  for (const name of ROOT_NAMES) {
    if (roots[name] === type) return name;
  }
  return null;
}

const ROOT_NAMES: readonly DocumentRootName[] = ["meta", "theme", "layouts", "slides", "assets", "transitionScripts"];
