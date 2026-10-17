// The inline text editor's input handling (acceptance test 4): every `TextInput` variant has a row
// in the `beforeinput` mapping table, every handled input is prevented, composition reports its
// start range, the frozen body is what renders during a composition, and paragraph keys carry the
// render generation.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EditorEvent, TextInput } from "../../contracts/editor-events.ts";
import type { TextTarget } from "../../contracts/selection.ts";
import { EditorServicesContext } from "../application/editor-services.tsx";
import { textStyleContextOf } from "../render/text-layout.ts";
import { paragraphKey } from "../render/text-paragraphs.tsx";
import { createPrefixedIdMinter, documentSnapshot, fixtureDeckId, paragraph, plainBody, run, shapeElement, slideSnapshot, textBody } from "../../contracts/testing/snapshot-builders.ts";
import { createRecordingSystem, fixtureEditorState, fixtureServices } from "../testing/editor-fixtures.ts";
import { InlineTextEditor, bodyToRender } from "./inline-text-editor.tsx";
import { parseBeforeInput, type BeforeInputLike, type DataTransferLike, type StaticRangeLike } from "./input-parser.ts";
import { createTextEditorHandlers } from "./text-editor-handlers.ts";

/** Opaque page positions: the fake `positionOf` reads the index straight from them. */
type FakePosition = Readonly<{ index: number }>;

const positionOf = (container: unknown, offset: number): number | null => (isFakePosition(container) ? container.index + offset : null);
const richParagraphs = [paragraph([run("rich", { fontWeight: 700 })])];
const context = { positionOf, richTextFrom: (markup: string) => (markup.includes("<b>") ? richParagraphs : null) };

type MappingRow = Readonly<{ inputType: string; data?: string; transfer?: Readonly<Record<string, string>>; range?: Readonly<{ start: number; end: number }>; expected: TextInput }>;

const MAPPING_TABLE: readonly MappingRow[] = [
  { inputType: "insertText", data: "a", expected: { kind: "insertText", text: "a" } },
  { inputType: "insertReplacementText", data: "their", range: { start: 4, end: 9 }, expected: { kind: "replaceRange", anchor: 4, focus: 9, text: "their" } },
  { inputType: "insertReplacementText", transfer: { "text/plain": "colour" }, range: { start: 12, end: 17 }, expected: { kind: "replaceRange", anchor: 12, focus: 17, text: "colour" } },
  { inputType: "insertParagraph", expected: { kind: "insertParagraph" } },
  { inputType: "insertLineBreak", expected: { kind: "insertLineBreak" } },
  { inputType: "insertTab", expected: { kind: "insertTab", outdent: false } },
  { inputType: "deleteContentBackward", expected: { kind: "deleteBackward", unit: "character" } },
  { inputType: "deleteWordBackward", expected: { kind: "deleteBackward", unit: "word" } },
  { inputType: "deleteSoftLineBackward", expected: { kind: "deleteBackward", unit: "line" } },
  { inputType: "deleteHardLineBackward", expected: { kind: "deleteBackward", unit: "line" } },
  { inputType: "deleteContentForward", expected: { kind: "deleteForward", unit: "character" } },
  { inputType: "deleteWordForward", expected: { kind: "deleteForward", unit: "word" } },
  { inputType: "deleteSoftLineForward", expected: { kind: "deleteForward", unit: "line" } },
  { inputType: "deleteByCut", expected: { kind: "deleteByCut" } },
  { inputType: "deleteByDrag", range: { start: 2, end: 6 }, expected: { kind: "replaceRange", anchor: 2, focus: 6, text: "" } },
  { inputType: "insertFromPaste", transfer: { "text/plain": "plain\r\ntext" }, expected: { kind: "insertFromPaste", content: { kind: "plain", text: "plain\ntext" } } },
  { inputType: "insertFromPaste", transfer: { "text/html": "<b>rich</b>", "text/plain": "rich" }, expected: { kind: "insertFromPaste", content: { kind: "rich", paragraphs: richParagraphs } } },
  { inputType: "insertFromDrop", transfer: { "text/plain": "dropped" }, range: { start: 7, end: 7 }, expected: { kind: "insertFromDrop", index: 7, content: { kind: "plain", text: "dropped" } } },
  { inputType: "historyUndo", expected: { kind: "history", direction: "undo" } },
  { inputType: "historyRedo", expected: { kind: "history", direction: "redo" } },
  { inputType: "formatBold", expected: { kind: "toggleFormat", format: "bold" } },
  { inputType: "formatItalic", expected: { kind: "toggleFormat", format: "italic" } },
  { inputType: "formatUnderline", expected: { kind: "toggleFormat", format: "underline" } },
  { inputType: "formatStrikeThrough", expected: { kind: "toggleFormat", format: "strikethrough" } },
];

/** Total over TextInput["kind"]: a new variant without a row fails to compile here. */
const COVERED_KINDS: Readonly<Record<TextInput["kind"], true>> = {
  insertText: true,
  replaceRange: true,
  insertParagraph: true,
  insertLineBreak: true,
  insertTab: true,
  deleteBackward: true,
  deleteForward: true,
  deleteByCut: true,
  insertFromPaste: true,
  insertFromDrop: true,
  history: true,
  toggleFormat: true,
};

describe("the beforeinput mapping table", () => {
  it("has a row for every TextInput variant", () => {
    const kinds = new Set(MAPPING_TABLE.map((row) => row.expected.kind));
    assert.deepEqual([...kinds].sort(), Object.keys(COVERED_KINDS).sort());
  });

  for (const row of MAPPING_TABLE) {
    it(`${row.inputType}${row.data === undefined ? "" : ` "${row.data}"`} becomes ${row.expected.kind} and is prevented`, () => {
      const prevented: boolean[] = [];
      const dispatched: EditorEvent[] = [];
      const handlers = createTextEditorHandlers({ ...context, dispatch: (event) => dispatched.push(event), readSelection: () => null, plainTextOf: () => "", primaryModifier: "control" });
      handlers.beforeInput({ ...inputEvent(row), preventDefault: () => prevented.push(true) });
      assert.deepEqual(prevented, [true]);
      assert.deepEqual(dispatched, [{ kind: "textInput", input: row.expected }]);
    });
  }

  it("insertReplacementText takes its range from getTargetRanges, not the caret", () => {
    const atCaret = parseBeforeInput({ ...inputEvent({ inputType: "insertReplacementText", data: "x", range: { start: 3, end: 3 } }) }, context);
    const atWord = parseBeforeInput({ ...inputEvent({ inputType: "insertReplacementText", data: "x", range: { start: 10, end: 14 } }) }, context);
    assert.deepEqual(atCaret, { kind: "dispatch", event: { kind: "textInput", input: { kind: "replaceRange", anchor: 3, focus: 3, text: "x" } } });
    assert.deepEqual(atWord, { kind: "dispatch", event: { kind: "textInput", input: { kind: "replaceRange", anchor: 10, focus: 14, text: "x" } } });
  });

  const otherRows: readonly Readonly<{ inputType: string; data?: string; expected: EditorEvent | "ignored" | "composition" }>[] = [
    { inputType: "insertOrderedList", expected: { kind: "listToggled", list: "numbered" } },
    { inputType: "formatJustifyCenter", expected: { kind: "paragraphStyleRequested", patch: { alignment: "centre" }, clear: [] } },
    { inputType: "formatFontColor", data: "rgb(255, 0, 0)", expected: { kind: "runStyleRequested", patch: { colour: { kind: "literal", hexadecimal: "#ff0000", alpha: 1 } }, clear: [] } },
    { inputType: "insertLink", expected: "ignored" },
    { inputType: "insertCompositionText", data: "か", expected: "composition" },
  ];
  for (const row of otherRows) {
    it(`${row.inputType} is ${typeof row.expected === "string" ? row.expected : row.expected.kind}, prevented unless it is a composition`, () => {
      const prevented: boolean[] = [];
      const dispatched: EditorEvent[] = [];
      const handlers = createTextEditorHandlers({ ...context, dispatch: (event) => dispatched.push(event), readSelection: () => null, plainTextOf: () => "", primaryModifier: "control" });
      handlers.beforeInput({ ...inputEvent(row), preventDefault: () => prevented.push(true) });
      assert.equal(prevented.length, row.expected === "composition" ? 0 : 1);
      assert.deepEqual(dispatched, typeof row.expected === "string" ? [] : [row.expected]);
    });
  }
});

describe("composition", () => {
  const selections = [
    { anchor: 5, focus: 5 },
    { anchor: 2, focus: 9 },
  ];
  for (const selection of selections) {
    it(`compositionstart dispatches the range it began on (${selection.anchor}..${selection.focus}), compositionend the text`, () => {
      const dispatched: EditorEvent[] = [];
      const handlers = createTextEditorHandlers({ ...context, dispatch: (event) => dispatched.push(event), readSelection: () => selection, plainTextOf: () => "", primaryModifier: "control" });
      handlers.compositionStart();
      handlers.compositionEnd({ data: "日本" });
      assert.deepEqual(dispatched, [
        { kind: "compositionStarted", anchor: selection.anchor, focus: selection.focus },
        { kind: "compositionEnded", text: "日本" },
      ]);
    });
  }

  const ids = createPrefixedIdMinter("Composer");
  const element = shapeElement({ id: ids.next("element"), text: plainBody("remote edit arrived") });
  const slide = slideSnapshot({ ids, elements: [element] });
  const document = documentSnapshot({ deckId: fixtureDeckId("deck_composer"), title: "Composition", slides: [slide] });
  const target: TextTarget = { kind: "element", slideId: slide.id, elementId: element.id };
  const frozenBody = plainBody("frozen while composing");

  const renderRows = [
    { label: "during a composition in this body, the frozen body renders", composing: true, generation: 3, shows: "frozen while composing", hides: "remote edit arrived" },
    { label: "without a composition, the document's body renders", composing: false, generation: 4, shows: "remote edit arrived", hides: "frozen while composing" },
  ];
  for (const row of renderRows) {
    it(row.label, () => {
      const state = fixtureEditorState({ document });
      const editing = { ...state, textEditing: { typingStyle: {}, renderGeneration: row.generation, composition: row.composing ? { target, startIndex: 4, frozenBody } : null } };
      const services = fixtureServices({ system: createRecordingSystem({ initial: editing }) });
      assert.equal(bodyToRender({ composition: editing.textEditing.composition, target, documentBody: element.text }), row.composing ? frozenBody : element.text);
      const markup = renderToStaticMarkup(
        createElement(EditorServicesContext.Provider, { value: services }, createElement(InlineTextEditor, { target, body: element.text, styleContext: textStyleContextOf({ theme: document.theme, element }), slideNumber: 1, slideNumberOf: () => 1 })),
      );
      assert.match(markup, new RegExp(row.shows));
      assert.doesNotMatch(markup, new RegExp(row.hides));
      assert.match(markup, new RegExp(`data-sasha-render-generation="${row.generation}"`), "paragraphs carry the render generation");
      assert.match(markup, /contenteditable="true"/i);
    });
  }

  it("paragraph keys include the render generation, so a bumped generation remounts every paragraph", () => {
    assert.equal(paragraphKey({ renderGeneration: 3, index: 0 }), "3:0");
    assert.notEqual(paragraphKey({ renderGeneration: 3, index: 1 }), paragraphKey({ renderGeneration: 4, index: 1 }));
  });
});

describe("keys and clipboard inside text", () => {
  const keyRows: readonly Readonly<{ label: string; key: string; ctrl: boolean; shift: boolean; expected: EditorEvent | null; prevented: boolean }>[] = [
    { label: "Tab is a text input", key: "Tab", ctrl: false, shift: false, expected: { kind: "textInput", input: { kind: "insertTab", outdent: false } }, prevented: true },
    { label: "Shift+Tab outdents", key: "Tab", ctrl: false, shift: true, expected: { kind: "textInput", input: { kind: "insertTab", outdent: true } }, prevented: true },
    { label: "Escape leaves text editing", key: "Escape", ctrl: false, shift: false, expected: { kind: "textEditingEnded" }, prevented: true },
    { label: "Ctrl+B is a key chord for the key map", key: "b", ctrl: true, shift: false, expected: { kind: "keyPressed", chord: { key: "b", code: "KeyB", modifiers: { shift: false, alt: false, primary: true } } }, prevented: true },
    { label: "Ctrl+C stays with the browser's copy", key: "c", ctrl: true, shift: false, expected: null, prevented: false },
    { label: "a plain letter is typed by beforeinput, not here", key: "b", ctrl: false, shift: false, expected: null, prevented: false },
  ];
  for (const row of keyRows) {
    it(row.label, () => {
      const dispatched: EditorEvent[] = [];
      let prevented = false;
      const handlers = createTextEditorHandlers({ ...context, dispatch: (event) => dispatched.push(event), readSelection: () => null, plainTextOf: () => "", primaryModifier: "control" });
      handlers.keyDown({ key: row.key, code: row.key === "b" ? "KeyB" : row.key === "c" ? "KeyC" : row.key, shiftKey: row.shift, altKey: false, ctrlKey: row.ctrl, metaKey: false, isComposing: false, preventDefault: () => (prevented = true) });
      assert.deepEqual(dispatched, row.expected === null ? [] : [row.expected]);
      assert.equal(prevented, row.prevented);
    });
  }

  it("cut writes the selected text inside the event and reports deleteByCut", () => {
    const written = new Map<string, string>();
    const dispatched: EditorEvent[] = [];
    let prevented = false;
    const body = textBody([paragraph([run("Hello world")])]);
    const handlers = createTextEditorHandlers({
      ...context,
      dispatch: (event) => dispatched.push(event),
      readSelection: () => ({ anchor: 6, focus: 11 }),
      plainTextOf: (range) => body.paragraphs[0]?.runs.map((part) => (part.kind === "text" ? part.text : "")).join("").slice(range.anchor, range.focus) ?? "",
      primaryModifier: "control",
    });
    handlers.cut({ clipboardData: { setData: (format, data) => written.set(format, data) }, preventDefault: () => (prevented = true) });
    assert.equal(written.get("text/plain"), "world");
    assert.equal(prevented, true);
    assert.deepEqual(dispatched, [{ kind: "textInput", input: { kind: "deleteByCut" } }]);
  });
});

function inputEvent(row: Readonly<{ inputType: string; data?: string; transfer?: Readonly<Record<string, string>>; range?: Readonly<{ start: number; end: number }> }>): BeforeInputLike {
  const transfer: DataTransferLike | null = row.transfer === undefined ? null : { types: Object.keys(row.transfer), getData: (format) => row.transfer?.[format] ?? "" };
  const ranges: readonly StaticRangeLike[] =
    row.range === undefined ? [] : [{ startContainer: fakePosition(row.range.start), startOffset: 0, endContainer: fakePosition(row.range.end), endOffset: 0 }];
  return { inputType: row.inputType, data: row.data ?? null, dataTransfer: transfer, getTargetRanges: () => ranges };
}

function fakePosition(index: number): FakePosition {
  return { index };
}

function isFakePosition(candidate: unknown): candidate is FakePosition {
  return typeof candidate === "object" && candidate !== null && "index" in candidate && typeof candidate.index === "number";
}
