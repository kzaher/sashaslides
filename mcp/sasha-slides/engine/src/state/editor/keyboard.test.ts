// Acceptance test 9: `chordToIntent` covers every row of the SPEC keyboard table (section 7), as a
// table, including 1 and 10 unit nudges and Tab inside and outside lists.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mintId, type EditorState, type KeyChord, type Modifiers } from "../../contracts/index.ts";
import { editorStateFor, elementId, shape, slide, slideId, testDocument } from "../testing/document-fixtures.ts";
import { chordToIntent, type KeyIntent } from "./keyboard.ts";

const listId = mintId({ seed: { sessionPrefix: "ListTest", counter: 0 }, kind: "list" }).id;
const document = testDocument({
  slides: [
    slide({
      id: "slide_one",
      elements: [
        shape({ id: "shape_plain", x: 0, y: 0, width: 100, height: 100, preset: "textBox", text: { paragraphs: [{ style: {}, runs: [{ kind: "text", text: "plain", style: {} }] }] } }),
        shape({
          id: "shape_listed",
          x: 200,
          y: 0,
          width: 100,
          height: 100,
          preset: "textBox",
          text: { paragraphs: [{ style: { list: { kind: "list", listId, glyph: "disc", level: 0 } }, runs: [{ kind: "text", text: "item", style: {} }] }] },
        }),
      ],
    }),
    slide({ id: "slide_two", elements: [] }),
  ],
});

const base = editorStateFor(document);
const STATES: Readonly<Record<"nothing" | "elements" | "slides" | "textOutsideList" | "textInList", EditorState>> = {
  nothing: base,
  elements: { ...base, selection: { kind: "elements", slideId: slideId("slide_one"), elementIds: [elementId("shape_plain")] } },
  slides: { ...base, selection: { kind: "slides", slideIds: [slideId("slide_one")] } },
  textOutsideList: { ...base, selection: { kind: "text", target: { kind: "element", slideId: slideId("slide_one"), elementId: elementId("shape_plain") }, anchor: 2, focus: 2 } },
  textInList: { ...base, selection: { kind: "text", target: { kind: "element", slideId: slideId("slide_one"), elementId: elementId("shape_listed") }, anchor: 2, focus: 2 } },
};

const NONE: Modifiers = { shift: false, alt: false, primary: false };

function chord(key: string, code: string, modifiers: Partial<Modifiers> = {}): KeyChord {
  return { key, code, modifiers: { ...NONE, ...modifiers } };
}

function letter(character: string, modifiers: Partial<Modifiers>): KeyChord {
  return chord(modifiers.shift === true ? character.toUpperCase() : character, `Key${character.toUpperCase()}`, modifiers);
}

const primary = { primary: true } as const;
const primaryShift = { primary: true, shift: true } as const;

type Row = Readonly<{ keys: string; chord: KeyChord; state: keyof typeof STATES; expected: KeyIntent | null }>;

const ROWS: readonly Row[] = [
  { keys: "primary+Z", chord: letter("z", primary), state: "elements", expected: { kind: "undo" } },
  { keys: "primary+Shift+Z", chord: letter("z", primaryShift), state: "elements", expected: { kind: "redo" } },
  { keys: "primary+Y", chord: letter("y", primary), state: "elements", expected: { kind: "redo" } },
  { keys: "primary+C", chord: letter("c", primary), state: "elements", expected: { kind: "copy" } },
  { keys: "primary+X", chord: letter("x", primary), state: "elements", expected: { kind: "cut" } },
  { keys: "primary+V", chord: letter("v", primary), state: "elements", expected: { kind: "paste" } },
  { keys: "primary+D", chord: letter("d", primary), state: "elements", expected: { kind: "duplicate" } },
  { keys: "Delete on elements", chord: chord("Delete", "Delete"), state: "elements", expected: { kind: "delete" } },
  { keys: "Backspace on slides", chord: chord("Backspace", "Backspace"), state: "slides", expected: { kind: "delete" } },
  { keys: "Backspace in text (the editor consumes it)", chord: chord("Backspace", "Backspace"), state: "textOutsideList", expected: null },
  { keys: "primary+A", chord: letter("a", primary), state: "elements", expected: { kind: "selectAll" } },
  { keys: "primary+A in the filmstrip", chord: letter("a", primary), state: "slides", expected: { kind: "selectAll" } },
  { keys: "ArrowLeft", chord: chord("ArrowLeft", "ArrowLeft"), state: "elements", expected: { kind: "nudge", deltaX: -1, deltaY: 0 } },
  { keys: "ArrowRight", chord: chord("ArrowRight", "ArrowRight"), state: "elements", expected: { kind: "nudge", deltaX: 1, deltaY: 0 } },
  { keys: "ArrowUp", chord: chord("ArrowUp", "ArrowUp"), state: "elements", expected: { kind: "nudge", deltaX: 0, deltaY: -1 } },
  { keys: "Shift+ArrowDown", chord: chord("ArrowDown", "ArrowDown", { shift: true }), state: "elements", expected: { kind: "nudge", deltaX: 0, deltaY: 10 } },
  { keys: "Shift+ArrowLeft", chord: chord("ArrowLeft", "ArrowLeft", { shift: true }), state: "elements", expected: { kind: "nudge", deltaX: -10, deltaY: 0 } },
  { keys: "ArrowLeft with nothing selected", chord: chord("ArrowLeft", "ArrowLeft"), state: "nothing", expected: null },
  { keys: "primary+G", chord: letter("g", primary), state: "elements", expected: { kind: "arrange", action: { kind: "group" } } },
  { keys: "primary+Shift+G", chord: letter("g", primaryShift), state: "elements", expected: { kind: "arrange", action: { kind: "ungroup" } } },
  { keys: "primary+Up", chord: chord("ArrowUp", "ArrowUp", primary), state: "elements", expected: { kind: "arrange", action: { kind: "reorder", placement: "forward" } } },
  { keys: "primary+Down", chord: chord("ArrowDown", "ArrowDown", primary), state: "elements", expected: { kind: "arrange", action: { kind: "reorder", placement: "backward" } } },
  { keys: "primary+Shift+Up", chord: chord("ArrowUp", "ArrowUp", primaryShift), state: "elements", expected: { kind: "arrange", action: { kind: "reorder", placement: "front" } } },
  { keys: "primary+Shift+Down", chord: chord("ArrowDown", "ArrowDown", primaryShift), state: "elements", expected: { kind: "arrange", action: { kind: "reorder", placement: "back" } } },
  { keys: "Enter", chord: chord("Enter", "Enter"), state: "elements", expected: { kind: "enter" } },
  { keys: "Escape", chord: chord("Escape", "Escape"), state: "textOutsideList", expected: { kind: "escape" } },
  { keys: "Tab on elements", chord: chord("Tab", "Tab"), state: "elements", expected: { kind: "selectSibling", direction: "next" } },
  { keys: "Shift+Tab on elements", chord: chord("Tab", "Tab", { shift: true }), state: "elements", expected: { kind: "selectSibling", direction: "previous" } },
  { keys: "Tab in a list", chord: chord("Tab", "Tab"), state: "textInList", expected: { kind: "listLevel", delta: 1 } },
  { keys: "Shift+Tab in a list", chord: chord("Tab", "Tab", { shift: true }), state: "textInList", expected: { kind: "listLevel", delta: -1 } },
  { keys: "Tab outside a list", chord: chord("Tab", "Tab"), state: "textOutsideList", expected: { kind: "insertTabCharacter" } },
  { keys: "Shift+Tab outside a list", chord: chord("Tab", "Tab", { shift: true }), state: "textOutsideList", expected: null },
  { keys: "primary+B", chord: letter("b", primary), state: "textOutsideList", expected: { kind: "toggleFormat", format: "bold" } },
  { keys: "primary+I", chord: letter("i", primary), state: "textOutsideList", expected: { kind: "toggleFormat", format: "italic" } },
  { keys: "primary+U", chord: letter("u", primary), state: "textOutsideList", expected: { kind: "toggleFormat", format: "underline" } },
  { keys: "primary+Shift+X", chord: letter("x", primaryShift), state: "textOutsideList", expected: { kind: "toggleFormat", format: "strikethrough" } },
  { keys: "primary+Shift+L", chord: letter("l", primaryShift), state: "textOutsideList", expected: { kind: "alignParagraphs", alignment: "start" } },
  { keys: "primary+Shift+E", chord: letter("e", primaryShift), state: "textOutsideList", expected: { kind: "alignParagraphs", alignment: "centre" } },
  { keys: "primary+Shift+R", chord: letter("r", primaryShift), state: "textOutsideList", expected: { kind: "alignParagraphs", alignment: "end" } },
  { keys: "primary+Shift+J", chord: letter("j", primaryShift), state: "textOutsideList", expected: { kind: "alignParagraphs", alignment: "justify" } },
  { keys: "primary+Shift+7", chord: chord("&", "Digit7", primaryShift), state: "textOutsideList", expected: { kind: "toggleList", list: "numbered" } },
  { keys: "primary+Shift+8", chord: chord("*", "Digit8", primaryShift), state: "textOutsideList", expected: { kind: "toggleList", list: "bulleted" } },
  { keys: "primary+K", chord: letter("k", primary), state: "textOutsideList", expected: { kind: "openLinkEditor" } },
  { keys: "primary+M", chord: letter("m", primary), state: "nothing", expected: { kind: "newSlide" } },
  { keys: "primary+Alt+M", chord: letter("m", { primary: true, alt: true }), state: "elements", expected: { kind: "comment" } },
  { keys: "primary+Enter", chord: chord("Enter", "Enter", primary), state: "nothing", expected: { kind: "present" } },
  { keys: "primary+/", chord: chord("/", "Slash", primary), state: "nothing", expected: { kind: "showKeyboardShortcuts" } },
  { keys: "Page Up", chord: chord("PageUp", "PageUp"), state: "nothing", expected: { kind: "goToSlide", step: -1 } },
  { keys: "Page Down", chord: chord("PageDown", "PageDown"), state: "nothing", expected: { kind: "goToSlide", step: 1 } },
  { keys: "a plain letter (typing, not a shortcut)", chord: letter("q", {}), state: "elements", expected: null },
];

describe("chordToIntent (acceptance 9)", () => {
  for (const row of ROWS) {
    it(`${row.keys} -> ${row.expected === null ? "nothing" : row.expected.kind}`, () => {
      assert.deepEqual(chordToIntent(row.chord, STATES[row.state]), row.expected);
    });
  }

  it("reads letters from the physical key, so a non-Latin layout keeps the shortcuts", () => {
    assert.deepEqual(chordToIntent(chord("я", "KeyZ", primary), STATES.elements), { kind: "undo" });
  });
});
