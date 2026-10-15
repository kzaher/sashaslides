// The reducer's small chrome intents that turn into document commands. Renaming the deck queues one
// `setTitle` envelope, and the rows vary only the typed title -- a new one, the same one, and a
// blank one -- so the envelope is shown to come from the title changing, not from the dialog. A
// table cell patch reaches the cells the selection means (table-cells.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CellAddress, DocumentCommand, EditorState, Selection, TableCellPatch } from "../../contracts/index.ts";
import { editorStateFor, shape, slide, slideId, table, testDocument } from "../testing/document-fixtures.ts";
import { reduceEditor } from "./reduce-editor.ts";

describe("renaming the deck", () => {
  const renaming: EditorState = (() => {
    const state = editorStateFor(testDocument({ slides: [slide({ id: "slide_one", elements: [] })] }));
    return { ...state, chrome: { ...state.chrome, dialog: { kind: "renameDeck" } } };
  })();
  for (const row of [
    { name: "a new title queues setTitle, trimmed", typed: "  Quarterly review ", expected: [{ kind: "setTitle", title: "Quarterly review" }] },
    { name: "control: the current title changes nothing", typed: renaming.document.title, expected: [] },
    { name: "control: a blank title changes nothing", typed: "   ", expected: [] },
  ] as const) {
    it(row.name, () => {
      const renamed = reduceEditor(renaming, { kind: "deckRenamed", title: row.typed });
      const commands: readonly DocumentCommand[] = renamed.pendingEdits.flatMap((edit) => (edit.kind === "apply" ? edit.envelope.commands : []));
      assert.deepEqual(commands, row.expected);
      assert.equal(renamed.chrome.dialog.kind, "none", "the dialog closes either way");
    });
  }
});

// Which cells a cell patch reaches is decided from the selection; every row applies the same patch
// and differs only in the selection. The control row selects a shape: no cells, no envelope.
describe("patching table cells", () => {
  const grid = table({ id: "table_grid", x: 100, y: 100, columnWidths: [100, 100, 100], rowHeights: [40, 40, 40] });
  const box = shape({ id: "shape_box", x: 500, y: 100, width: 100, height: 100 });
  const document = testDocument({ slides: [slide({ id: "slide_one", elements: [grid, box] })] });
  const slideOne = slideId("slide_one");
  const cellAt = (row: number, column: number): CellAddress => {
    const rowId = grid.rows[row]?.id;
    const columnId = grid.columns[column]?.id;
    if (rowId === undefined || columnId === undefined) throw new Error(`the fixture has no cell ${row}, ${column}`);
    return { rowId, columnId };
  };
  const patch: TableCellPatch = { fill: { kind: "solid", colour: { kind: "literal", hexadecimal: "#ffeeaa", alpha: 1 } } };
  const rows: readonly Readonly<{ name: string; selection: Selection; expectedCells: readonly CellAddress[] }>[] = [
    {
      name: "a rectangle dragged up and to the left covers the same cells as down and to the right",
      selection: { kind: "tableCells", slideId: slideOne, elementId: grid.id, anchor: cellAt(2, 2), focus: cellAt(1, 1) },
      expectedCells: [cellAt(1, 1), cellAt(1, 2), cellAt(2, 1), cellAt(2, 2)],
    },
    {
      name: "the caret in a cell reaches that cell",
      selection: { kind: "text", target: { kind: "tableCell", slideId: slideOne, elementId: grid.id, cell: cellAt(0, 1) }, anchor: 0, focus: 0 },
      expectedCells: [cellAt(0, 1)],
    },
    {
      name: "the table selected reaches every cell",
      selection: { kind: "elements", slideId: slideOne, elementIds: [grid.id] },
      expectedCells: [0, 1, 2].flatMap((row) => [0, 1, 2].map((column) => cellAt(row, column))),
    },
    { name: "control: a shape selected reaches no cell", selection: { kind: "elements", slideId: slideOne, elementIds: [box.id] }, expectedCells: [] },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const patched = reduceEditor({ ...editorStateFor(document), selection: row.selection }, { kind: "tableCellPatchRequested", patch });
      const commands = patched.pendingEdits.flatMap((edit) => (edit.kind === "apply" ? edit.envelope.commands : []));
      const expected: readonly DocumentCommand[] = row.expectedCells.length === 0 ? [] : [{ kind: "updateTableCells", slideId: slideOne, elementId: grid.id, cells: row.expectedCells, patch }];
      assert.deepEqual(commands, expected);
      assert.deepEqual(patched.selection, row.selection, "the selection stays");
    });
  }
});
