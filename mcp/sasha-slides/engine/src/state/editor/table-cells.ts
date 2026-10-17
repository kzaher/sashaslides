// TABLE CELL STYLE FROM THE PANEL: `tableCellPatchRequested` becomes one `updateTableCells` envelope
// over the cells the selection means. Which cells those are is the reducer's decision, not the
// view's (editor-events.ts "the view reports, the reducer decides"):
//
//  * a rectangle of cells (`tableCells`): every cell between the anchor and focus cells inclusive, in
//    the table's row and column order -- so dragging up-left and down-right mean the same cells;
//  * the caret in a cell: that cell;
//  * the table itself selected: every cell.
//
// Anything else -- no table in the selection, a row or column that no longer exists -- changes
// nothing, and the selection stays where it was.

import {
  assertNever,
  type CellAddress,
  type EditorState,
  type ElementId,
  type SlideId,
  type TableCellPatch,
  type TableElement,
} from "../../contracts/index.ts";
import { findElement, findSlide, tableOf } from "./document-lookup.ts";
import { queueCommands } from "./editor-queue.ts";

export function patchTableCells(state: EditorState, patch: TableCellPatch): EditorState {
  const cells = selectedTableCells(state);
  if (cells === null || cells.cells.length === 0) return state;
  return queueCommands(state, [{ kind: "updateTableCells", slideId: cells.slideId, elementId: cells.table.id, cells: cells.cells, patch }]);
}

/** The table and cells the selection means (see the header), or null. */
export function selectedTableCells(state: EditorState): Readonly<{ slideId: SlideId; table: TableElement; cells: readonly CellAddress[] }> | null {
  const selection = state.selection;
  switch (selection.kind) {
    case "tableCells": {
      const table = tableIn(state, selection.slideId, selection.elementId);
      return table === null ? null : { slideId: selection.slideId, table, cells: cellRectangle({ table, anchor: selection.anchor, focus: selection.focus }) };
    }
    case "text": {
      const target = selection.target;
      switch (target.kind) {
        case "tableCell": {
          const table = tableIn(state, target.slideId, target.elementId);
          return table === null ? null : { slideId: target.slideId, table, cells: cellRectangle({ table, anchor: target.cell, focus: target.cell }) };
        }
        case "element":
        case "speakerNotes":
          return null;
        default:
          return assertNever(target);
      }
    }
    case "elements": {
      const only = selection.elementIds.length === 1 ? selection.elementIds[0] : undefined;
      const table = only === undefined ? null : tableIn(state, selection.slideId, only);
      return table === null ? null : { slideId: selection.slideId, table, cells: table.rows.flatMap((row) => table.columns.map((column) => ({ rowId: row.id, columnId: column.id }))) };
    }
    case "none":
    case "slides":
      return null;
    default:
      return assertNever(selection);
  }
}

function tableIn(state: EditorState, slideId: SlideId, elementId: ElementId): TableElement | null {
  const slide = findSlide(state.document, slideId);
  const element = slide === null ? null : findElement(slide, elementId);
  return element === null ? null : tableOf(element);
}

/** Every cell between two corner cells, inclusive; empty when either corner's row or column is gone. */
function cellRectangle(options: Readonly<{ table: TableElement; anchor: CellAddress; focus: CellAddress }>): readonly CellAddress[] {
  const { table, anchor, focus } = options;
  const rowIndices = [table.rows.findIndex((row) => row.id === anchor.rowId), table.rows.findIndex((row) => row.id === focus.rowId)];
  const columnIndices = [table.columns.findIndex((column) => column.id === anchor.columnId), table.columns.findIndex((column) => column.id === focus.columnId)];
  if ([...rowIndices, ...columnIndices].some((index) => index < 0)) return [];
  const rows = table.rows.slice(Math.min(...rowIndices), Math.max(...rowIndices) + 1);
  const columns = table.columns.slice(Math.min(...columnIndices), Math.max(...columnIndices) + 1);
  return rows.flatMap((row) => columns.map((column) => ({ rowId: row.id, columnId: column.id })));
}
