// Acceptance 2 and 4, the state side (SPEC.md 21.9, review fixes 2 and 4).
//
// The list style picker: choosing a glyph queues one `formatParagraphs` per paragraph overlapping
// the text selection, and none for the others; the rows differ only in the selection. A paragraph
// already in a list keeps its list and level.
//
// Recent colours: `recentColourUsed` puts the colour first, moves an equal colour (same kind, value
// and alpha) to the front instead of duplicating it, and keeps at most RECENT_COLOUR_LIMIT.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RECENT_COLOUR_LIMIT,
  mintId,
  type Colour,
  type DocumentCommand,
  type EditorState,
  type ListGlyph,
  type TextBody,
  type TextOperation,
} from "../../contracts/index.ts";
import { editorStateFor, shape, slide, slideId, testDocument } from "../testing/document-fixtures.ts";
import { reduceEditor } from "./reduce-editor.ts";

const SLIDE = slideId("slide_one");
const FIXTURE_SEED = { sessionPrefix: "Glyphs00", counter: 0 };
const EXISTING_LIST = mintId({ seed: FIXTURE_SEED, kind: "list" }).id;
/** Whatever list id the picker sends is not read: the reducer keeps or mints list identity. */
const SENT_LIST = mintId({ seed: { ...FIXTURE_SEED, counter: 1 }, kind: "list" }).id;

// "One\n" holds indices 0..3 (its mark at 3), "Two\n" 4..7 (mark 7), "Three\n" 8..13 (mark 13).
const body: TextBody = {
  paragraphs: [
    { style: {}, runs: [{ kind: "text", text: "One", style: {} }] },
    { style: { list: { kind: "list", listId: EXISTING_LIST, glyph: "disc", level: 2 } }, runs: [{ kind: "text", text: "Two", style: {} }] },
    { style: {}, runs: [{ kind: "text", text: "Three", style: {} }] },
  ],
};
const textBox = shape({ id: "shape_text", x: 0, y: 0, width: 400, height: 200, text: body });
const document = testDocument({ slides: [slide({ id: "slide_one", elements: [textBox] })] });

function chooseGlyph(options: Readonly<{ anchor: number; focus: number; glyph: ListGlyph }>): readonly TextOperation[] {
  const state: EditorState = { ...editorStateFor(document), selection: { kind: "text", target: { kind: "element", slideId: SLIDE, elementId: textBox.id }, anchor: options.anchor, focus: options.focus } };
  const next = reduceEditor(state, { kind: "paragraphStyleRequested", patch: { list: { kind: "list", listId: SENT_LIST, glyph: options.glyph, level: 0 } }, clear: [] });
  const commands: readonly DocumentCommand[] = next.pendingEdits.flatMap((edit) => (edit.kind === "apply" ? edit.envelope.commands : []));
  return commands.flatMap((command) => (command.kind === "editText" ? command.operations : []));
}

describe("the list style picker", () => {
  const rows: readonly Readonly<{ name: string; anchor: number; focus: number; marks: readonly number[] }>[] = [
    { name: "a selection over the second and third paragraphs formats those two", anchor: 5, focus: 9, marks: [7, 13] },
    { name: "a selection dragged backwards formats the same two", anchor: 9, focus: 5, marks: [7, 13] },
    { name: "a caret in the first paragraph formats only that one", anchor: 1, focus: 1, marks: [3] },
    { name: "a selection over all three formats all three", anchor: 0, focus: 13, marks: [3, 7, 13] },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const operations = chooseGlyph({ anchor: row.anchor, focus: row.focus, glyph: "upperRoman" });
      assert.deepEqual(
        operations.map((operation) => (operation.kind === "formatParagraphs" ? operation.index : -1)),
        row.marks,
      );
      for (const operation of operations) {
        assert.equal(operation.kind, "formatParagraphs");
        if (operation.kind !== "formatParagraphs") continue;
        assert.equal(operation.length, 1);
        assert.equal(operation.patch.list?.kind === "list" ? operation.patch.list.glyph : null, "upperRoman");
      }
    });
  }

  it("a paragraph already in a list keeps its list and level; the others join that list at level 0", () => {
    const operations = chooseGlyph({ anchor: 0, focus: 13, glyph: "lowerAlphabetic" });
    const lists = operations.map((operation) => (operation.kind === "formatParagraphs" ? operation.patch.list : undefined));
    assert.deepEqual(lists, [
      { kind: "list", listId: EXISTING_LIST, glyph: "lowerAlphabetic", level: 0 },
      { kind: "list", listId: EXISTING_LIST, glyph: "lowerAlphabetic", level: 2 },
      { kind: "list", listId: EXISTING_LIST, glyph: "lowerAlphabetic", level: 0 },
    ]);
  });

  it("control: paragraphs in no list get a new list minted by the reducer, never the id the picker sent", () => {
    const operations = chooseGlyph({ anchor: 9, focus: 10, glyph: "star" });
    const list = operations[0]?.kind === "formatParagraphs" ? operations[0].patch.list : undefined;
    assert.ok(list !== undefined && list.kind === "list");
    assert.notEqual(list.listId, SENT_LIST);
    assert.notEqual(list.listId, EXISTING_LIST);
  });
});

describe("recent colours", () => {
  const red: Colour = { kind: "literal", hexadecimal: "#ff0000", alpha: 1 };
  const redHalf: Colour = { kind: "literal", hexadecimal: "#ff0000", alpha: 0.5 };
  const accent: Colour = { kind: "theme", slot: "accent1", alpha: 1 };
  const blue: Colour = { kind: "literal", hexadecimal: "#0000ff", alpha: 1 };
  const many: readonly Colour[] = Array.from({ length: RECENT_COLOUR_LIMIT }, (_, index): Colour => ({ kind: "literal", hexadecimal: `#0000${(index + 16).toString(16)}`, alpha: 1 }));

  const rows: readonly Readonly<{ name: string; before: readonly Colour[]; used: Colour; after: readonly Colour[] }>[] = [
    { name: "a new colour goes first", before: [blue, accent], used: red, after: [red, blue, accent] },
    { name: "an equal colour moves to the front instead of duplicating", before: [blue, red, accent], used: red, after: [red, blue, accent] },
    { name: "control: the same hue at another alpha is another colour", before: [blue, red], used: redHalf, after: [redHalf, blue, red] },
    { name: "control: a theme slot is not the literal it resolves to", before: [red], used: accent, after: [accent, red] },
    { name: "the row keeps at most RECENT_COLOUR_LIMIT, dropping the oldest", before: many, used: red, after: [red, ...many.slice(0, RECENT_COLOUR_LIMIT - 1)] },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const state = editorStateFor(document);
      const next = reduceEditor({ ...state, chrome: { ...state.chrome, recentColours: row.before } }, { kind: "recentColourUsed", colour: row.used });
      assert.deepEqual(next.chrome.recentColours, row.after);
    });
  }
});
