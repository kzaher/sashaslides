// Acceptance tests 2, 3, 4 and 12: fast typing in order, carets and queued edits following a
// collaborator's change, input method composition, and text box growth.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mintId,
  textTargetKey,
  type DocumentSnapshot,
  type EditorEvent,
  type EditorState,
  type TextDelta,
  type TextOperation,
  type TextTarget,
} from "../../contracts/index.ts";
import { editorStateFor, elementId, shape, slide, slideId, table, testDocument, textBody } from "../testing/document-fixtures.ts";
import { createEditorHarness } from "../testing/editor-harness.ts";
import { reduceEditor } from "./reduce-editor.ts";

const TEXT_BOX = "shape_text";
const TARGET: TextTarget = { kind: "element", slideId: slideId("slide_one"), elementId: elementId(TEXT_BOX) };

function documentWithText(text: string, revision = 1): DocumentSnapshot {
  return testDocument({
    revision,
    slides: [slide({ id: "slide_one", elements: [shape({ id: TEXT_BOX, x: 100, y: 100, width: 400, height: 80, preset: "textBox", text: textBody(text) })] })],
  });
}

function reduceAll(state: EditorState, events: readonly EditorEvent[]): EditorState {
  return events.reduce(reduceEditor, state);
}

function queuedOperations(state: EditorState): readonly (readonly TextOperation[])[] {
  return state.pendingEdits.flatMap((edit) => {
    switch (edit.kind) {
      case "apply":
        return edit.envelope.commands.flatMap((command) => (command.kind === "editText" ? [command.operations] : []));
      case "undo":
      case "redo":
        return [];
      default:
        return edit satisfies never;
    }
  });
}

function queuedRevisions(state: EditorState): readonly number[] {
  return state.pendingEdits.flatMap((edit) => {
    switch (edit.kind) {
      case "apply":
        return edit.envelope.commands.flatMap((command) => (command.kind === "editText" ? [command.basedOnRevision] : []));
      case "undo":
      case "redo":
        return [];
      default:
        return edit satisfies never;
    }
  });
}

function caretOf(state: EditorState): Readonly<{ anchor: number; focus: number }> | null {
  return state.selection.kind === "text" ? { anchor: state.selection.anchor, focus: state.selection.focus } : null;
}

/** A collaborator's change to the text box, as the model would report it. */
function remoteChange(options: Readonly<{ document: DocumentSnapshot; delta: TextDelta }>): EditorEvent {
  return {
    kind: "documentChanged",
    change: {
      snapshot: options.document,
      origin: { kind: "remote" },
      changedSlideIds: [slideId("slide_one")],
      deckLevelChanged: false,
      textChanges: new Map([[textTargetKey(TARGET), options.delta]]),
      history: { canUndo: false, canRedo: false },
    },
  };
}

describe("fast typing (acceptance 2)", () => {
  it("types 'ab' with the caret at 2 against a synchronous store", () => {
    using harness = createEditorHarness({ document: documentWithText("") });
    harness.dispatch({ kind: "textEditingRequested", target: { kind: "element", slideId: slideId("slide_one"), elementId: elementId(TEXT_BOX) }, at: "end" });
    harness.dispatch({ kind: "textInput", input: { kind: "insertText", text: "a" } });
    harness.dispatch({ kind: "textInput", input: { kind: "insertText", text: "b" } });
    assert.equal(harness.documentStore.plainTextOf(TARGET), "ab");
    assert.deepEqual(caretOf(harness.state()), { anchor: 2, focus: 2 });
    assert.deepEqual(harness.state().pendingEdits, []);
  });

  it("computes the second insert from the queued first when the store settles later", () => {
    using harness = createEditorHarness({ document: documentWithText(""), settle: { delayMilliseconds: 10 } });
    harness.dispatch({ kind: "textEditingRequested", target: { kind: "element", slideId: slideId("slide_one"), elementId: elementId(TEXT_BOX) }, at: "end" });
    harness.dispatch({ kind: "textInput", input: { kind: "insertText", text: "a" } });
    harness.dispatch({ kind: "textInput", input: { kind: "insertText", text: "b" } });
    // Nothing has come back yet: the caret already sits after both, and 'b' is queued at index 1.
    assert.deepEqual(caretOf(harness.state()), { anchor: 2, focus: 2 });
    assert.deepEqual(queuedOperations(harness.state()).map((operations) => operations.map((operation) => operation.kind === "insert" ? operation.index : -1)), [[0], [1]]);
    harness.scheduler.advanceBy(100);
    assert.equal(harness.documentStore.plainTextOf(TARGET), "ab");
    assert.deepEqual(caretOf(harness.state()), { anchor: 2, focus: 2 });
    assert.deepEqual(harness.state().pendingEdits, []);
    assert.deepEqual(harness.state().inFlightCommandIds, []);
    assert.deepEqual(harness.reportedErrors(), []);
  });
});

describe("a collaborator's change moves my indices (acceptance 3)", () => {
  const typing = (caret: number): EditorState =>
    reduceAll(editorStateFor(documentWithText("hello world")), [{ kind: "textEditingRequested", target: { kind: "element", slideId: slideId("slide_one"), elementId: elementId(TEXT_BOX) }, at: { index: caret } }]);

  const rows = [
    { name: "insert of 3 before the caret", delta: [{ kind: "retain", length: 2 }, { kind: "insert", length: 3 }], expectedCaret: 8 },
    { name: "insert exactly at the caret", delta: [{ kind: "retain", length: 5 }, { kind: "insert", length: 3 }], expectedCaret: 5 },
    { name: "insert after the caret", delta: [{ kind: "retain", length: 7 }, { kind: "insert", length: 3 }], expectedCaret: 5 },
  ] as const;
  for (const row of rows) {
    it(`caret after an ${row.name}`, () => {
      const changed = reduceEditor(typing(5), remoteChange({ document: documentWithText("helXYZlo world", 2), delta: row.delta }));
      assert.deepEqual(caretOf(changed), { anchor: row.expectedCaret, focus: row.expectedCaret });
    });
  }

  it("moves the composition start and every queued edit, and rebases them on the new revision", () => {
    const queued = reduceAll(typing(5), [
      { kind: "textInput", input: { kind: "insertText", text: "X" } },
      { kind: "compositionStarted", anchor: 6, focus: 6 },
    ]);
    assert.equal(queued.textEditing.composition?.startIndex, 6);
    assert.deepEqual(queuedRevisions(queued), [1]);
    const changed = reduceEditor(queued, remoteChange({ document: documentWithText("abchello world", 7), delta: [{ kind: "insert", length: 3 }] }));
    assert.deepEqual(queuedOperations(changed), [[{ kind: "insert", index: 8, text: "X", style: {} }]]);
    assert.equal(changed.textEditing.composition?.startIndex, 9);
    assert.deepEqual(caretOf(changed), { anchor: 9, focus: 9 });
    assert.deepEqual(queuedRevisions(changed), [7]);
  });
});

describe("input method composition (acceptance 4)", () => {
  it("freezes the body, follows remote changes with the start only, and inserts at the moved index", () => {
    const start = reduceAll(editorStateFor(documentWithText("hello")), [
      { kind: "textEditingRequested", target: { kind: "element", slideId: slideId("slide_one"), elementId: elementId(TEXT_BOX) }, at: { index: 5 } },
      { kind: "compositionStarted", anchor: 5, focus: 5 },
    ]);
    const composition = start.textEditing.composition;
    assert.ok(composition !== null);
    assert.deepEqual(composition.frozenBody, textBody("hello"));
    assert.equal(composition.startIndex, 5);

    const remote = reduceEditor(start, remoteChange({ document: documentWithText(">> hello", 2), delta: [{ kind: "insert", length: 3 }] }));
    assert.equal(remote.textEditing.composition?.frozenBody, composition.frozenBody);
    assert.equal(remote.textEditing.composition?.startIndex, 8);

    const ended = reduceEditor(remote, { kind: "compositionEnded", text: "日本" });
    assert.equal(ended.textEditing.composition, null);
    assert.equal(ended.textEditing.renderGeneration, start.textEditing.renderGeneration + 1);
    assert.deepEqual(queuedOperations(ended), [[{ kind: "insert", index: 8, text: "日本", style: {} }]]);
    assert.deepEqual(caretOf(ended), { anchor: 10, focus: 10 });
  });

  it("replaces a selected range: the range is deleted first and the frozen body is the body without it", () => {
    const started = reduceAll(editorStateFor(documentWithText("hello")), [
      { kind: "textEditingRequested", target: { kind: "element", slideId: slideId("slide_one"), elementId: elementId(TEXT_BOX) }, at: { index: 0 } },
      { kind: "compositionStarted", anchor: 1, focus: 4 },
    ]);
    assert.deepEqual(started.textEditing.composition?.frozenBody, textBody("ho"));
    assert.deepEqual(queuedOperations(started), [[{ kind: "delete", index: 1, length: 3 }]]);
  });
});

describe("text box growth (acceptance 12)", () => {
  const measured = (contentHeight: number): EditorEvent => ({
    kind: "layoutMeasured",
    slideId: slideId("slide_one"),
    elementId: elementId(TEXT_BOX),
    measurement: { kind: "text", contentHeight },
  });

  const rows = [
    { name: "typing in it, 40 units taller", typing: true, contentHeight: 120, expectedHeight: 120 },
    { name: "typing in it, within half a unit", typing: true, contentHeight: 80.4, expectedHeight: null },
    { name: "selected but not typing in it", typing: false, contentHeight: 120, expectedHeight: null },
  ] as const;
  for (const row of rows) {
    it(row.name, () => {
      const base = editorStateFor(documentWithText("grow"));
      const selected: EditorState = row.typing
        ? reduceEditor(base, { kind: "textEditingRequested", target: { kind: "element", slideId: slideId("slide_one"), elementId: elementId(TEXT_BOX) }, at: "end" })
        : { ...base, selection: { kind: "elements", slideId: slideId("slide_one"), elementIds: [elementId(TEXT_BOX)] } };
      const after = reduceEditor(selected, measured(row.contentHeight));
      assert.ok(after.measuredLayouts.has(elementId(TEXT_BOX)));
      const queued = after.pendingEdits.flatMap((edit) => (edit.kind === "apply" ? [edit.envelope] : []));
      if (row.expectedHeight === null) {
        assert.deepEqual(queued, []);
        return;
      }
      assert.equal(queued.length, 1);
      const envelope = queued[0];
      assert.equal(envelope?.mergeWithPrevious, true);
      assert.deepEqual(envelope?.commands, [
        { kind: "setFrames", slideId: slideId("slide_one"), frames: [{ kind: "box", elementId: elementId(TEXT_BOX), frame: { x: 100, y: 100, width: 400, height: row.expectedHeight, rotation: 0, flipHorizontal: false, flipVertical: false } }] },
      ]);
    });
  }
});

// Every kind of text body can take the caret through `textEditingRequested`; the control rows name
// a body that is not on the current slide, a cell the table does not have, and an element without
// a text body, and leave the selection alone.
describe("entering text by target", () => {
  const grid = table({ id: "table_grid", x: 600, y: 100, columnWidths: [100, 100], rowHeights: [40, 40] });
  const firstRow = grid.rows[0];
  const secondColumn = grid.columns[1];
  const document = testDocument({
    slides: [
      slide({ id: "slide_one", elements: [shape({ id: TEXT_BOX, x: 100, y: 100, width: 400, height: 80, preset: "textBox", text: textBody("hello") }), grid] }),
      slide({ id: "slide_two", elements: [] }),
    ],
  });
  const slideOne = slideId("slide_one");
  if (firstRow === undefined || secondColumn === undefined) throw new Error("the table fixture has two rows and two columns");
  const rows: readonly Readonly<{ name: string; target: TextTarget; enters: boolean }>[] = [
    { name: "a shape's text", target: TARGET, enters: true },
    { name: "a table cell", target: { kind: "tableCell", slideId: slideOne, elementId: grid.id, cell: { rowId: firstRow.id, columnId: secondColumn.id } }, enters: true },
    { name: "the current slide's speaker notes", target: { kind: "speakerNotes", slideId: slideOne }, enters: true },
    { name: "control: another slide's speaker notes", target: { kind: "speakerNotes", slideId: slideId("slide_two") }, enters: false },
    { name: "control: a cell the table does not have", target: { kind: "tableCell", slideId: slideOne, elementId: grid.id, cell: { rowId: firstRow.id, columnId: mintId({ seed: { sessionPrefix: "Missing0", counter: 0 }, kind: "tableColumn" }).id } }, enters: false },
    { name: "control: a table's own id as an element body", target: { kind: "element", slideId: slideOne, elementId: grid.id }, enters: false },
  ];
  for (const row of rows) {
    it(`${row.enters ? "enters" : "does not enter"} ${row.name}`, () => {
      const state = editorStateFor(document);
      const entered = reduceEditor(state, { kind: "textEditingRequested", target: row.target, at: "end" });
      if (!row.enters) {
        assert.equal(entered.selection, state.selection);
        return;
      }
      assert.equal(entered.selection.kind, "text");
      assert.deepEqual(entered.selection.kind === "text" ? textTargetKey(entered.selection.target) : null, textTargetKey(row.target));
    });
  }
});
