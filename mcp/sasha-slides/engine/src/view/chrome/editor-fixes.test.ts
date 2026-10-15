// The milestone 1 review fixes as the person meets them (SPEC.md 21.9): the list style picker
// (acceptance 2), the gradient editor (3), the Recent colours row (4), Scripted with no scripts
// (5), arrow keys in pill groups (6), and the words a disabled control gives, which must be the
// reducer's own words. Each table's rows run the same steps and differ only in the input under
// test, with control rows where the cause is absent.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CLOSED_MESSAGE, NEWER_SCHEMA_MESSAGE, ROLE_EDIT_REFUSAL, VIEWER_COMMENT_REFUSAL, commentingRefusal, editingRefusal } from "../../state/editor/access.ts";
import { reduceEditor } from "../../state/editor/reduce-editor.ts";
import { editorStateFor, shape, slide, slideId, testDocument } from "../../state/testing/document-fixtures.ts";
import { LOCAL_COLLABORATION_STATUS, type ClosedReason, type CollaborationStatus } from "../../contracts/collaboration.ts";
import { DECK_ROLES } from "../../contracts/deck-access.ts";
import type { DocumentCommand, EditorEvent, EditorState, Fill, ListGlyph, TextOperation } from "../../contracts/index.ts";
import type { Colour } from "../../contracts/style.ts";
import { EditorGestureContext, EditorServicesContext } from "../application/editor-services.tsx";
import { handleShellKey, type ShellKeyEvent } from "../application/editor-shell.tsx";
import { documentSnapshot, fixtureDeckId, IdMinter, plainBody, sampleTheme, shapeElement, slideSnapshot } from "../sample/snapshot-builders.ts";
import { createRecordingSystem, fixtureEditorState, fixtureServices, recordingCapabilities } from "../testing/editor-fixtures.ts";
import { CLOSED_EXPLANATION, NEWER_SCHEMA_EXPLANATION, ROLE_EDIT_EXPLANATION, VIEWER_COMMENT_EXPLANATION, commentingDisabledReason, editingDisabledReason } from "./access.ts";
import { ColourPalette } from "./fields.tsx";
import { MAXIMUM_GRADIENT_STOPS, withAddedStop, withRadialCentre, withStopOffset, withoutStop, type GradientFill } from "./gradient-stops.ts";
import { LIST_GLYPH_PRESETS } from "./list-glyphs.ts";
import { pillGroupKeyTarget } from "./pill-group.ts";
import { ListGlyphPicker, NO_SCRIPTS_EXPLANATION, TransitionTab, listGlyphEvent } from "./properties-panel.tsx";

const ALL_GLYPHS: readonly ListGlyph[] = ["disc", "circle", "square", "arrow", "star", "checkbox", "decimal", "decimalZeroPadded", "upperAlphabetic", "lowerAlphabetic", "upperRoman", "lowerRoman"];

describe("the list style picker (acceptance 2)", () => {
  it("renders exactly the 12 ListGlyph presets, once each", () => {
    const markup = renderToStaticMarkup(createElement(ListGlyphPicker, { chosen: { kind: "value", value: "disc" }, explanation: null, onChoose: () => undefined }));
    const shown = [...markup.matchAll(/data-list-glyph="([a-zA-Z]+)"/g)].map((match) => match[1]);
    assert.deepEqual([...shown].sort(), [...ALL_GLYPHS].sort());
    assert.equal(LIST_GLYPH_PRESETS.length, 12);
    assert.match(markup, /role="radio"[^>]*aria-checked="true"[^>]*aria-label="Round bullets"/);
  });

  // "One\n" holds 0..3, "Two\n" 4..7, "Three\n" 8..13: a selection from 5 to 9 overlaps the second and third.
  const textBox = shape({ id: "shape_text", x: 0, y: 0, width: 400, height: 200, text: { paragraphs: ["One", "Two", "Three"].map((text) => ({ style: {}, runs: [{ kind: "text" as const, text, style: {} }] })) } });
  const document = testDocument({ slides: [slide({ id: "slide_one", elements: [textBox] })] });
  const rows: readonly Readonly<{ name: string; anchor: number; focus: number; marks: readonly number[] }>[] = [
    { name: "choosing a glyph formats the two overlapped paragraphs, and only those", anchor: 5, focus: 9, marks: [7, 13] },
    { name: "control: a caret in the first paragraph formats only the first", anchor: 2, focus: 2, marks: [3] },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const state: EditorState = { ...editorStateFor(document), selection: { kind: "text", target: { kind: "element", slideId: slideId("slide_one"), elementId: textBox.id }, anchor: row.anchor, focus: row.focus } };
      const next = reduceEditor(state, listGlyphEvent({ glyph: "upperRoman", listId: null, state }));
      const operations: readonly TextOperation[] = next.pendingEdits.flatMap((edit) => (edit.kind === "apply" ? edit.envelope.commands : [])).flatMap((command) => (command.kind === "editText" ? command.operations : []));
      assert.deepEqual(operations.map((operation) => (operation.kind === "formatParagraphs" ? `${operation.index}:${operation.patch.list?.kind === "list" ? operation.patch.list.glyph : "?"}` : operation.kind)), row.marks.map((mark) => `${mark}:upperRoman`));
    });
  }
});

describe("the gradient editor (acceptance 3)", () => {
  const red: Colour = { kind: "literal", hexadecimal: "#ff0000", alpha: 1 };
  const green: Colour = { kind: "literal", hexadecimal: "#00ff00", alpha: 1 };
  const blue: Colour = { kind: "literal", hexadecimal: "#0000ff", alpha: 1 };
  const linear: GradientFill = { kind: "linearGradient", angle: 90, stops: [{ colour: red, offset: 0 }, { colour: green, offset: 0.5 }, { colour: blue, offset: 1 }] };
  const radial: Extract<Fill, { kind: "radialGradient" }> = { kind: "radialGradient", centreX: 0.5, centreY: 0.5, stops: [{ colour: red, offset: 0 }, { colour: blue, offset: 1 }] };
  const tenStops: GradientFill = { ...linear, stops: Array.from({ length: MAXIMUM_GRADIENT_STOPS }, (_, index) => ({ colour: red, offset: index / (MAXIMUM_GRADIENT_STOPS - 1) })) };

  const rows: readonly Readonly<{ name: string; edited: Fill | null; expected: Fill | null }>[] = [
    { name: "stop 2's position to 40 percent", edited: withStopOffset(linear, { index: 1, offset: 0.4 }), expected: { ...linear, stops: [{ colour: red, offset: 0 }, { colour: green, offset: 0.4 }, { colour: blue, offset: 1 }] } },
    { name: "a stop added in the widest gap with the colour before it", edited: withAddedStop(radial), expected: { ...radial, stops: [{ colour: red, offset: 0 }, { colour: red, offset: 0.5 }, { colour: blue, offset: 1 }] } },
    { name: "control: an eleventh stop is refused", edited: withAddedStop(tenStops), expected: null },
    { name: "the middle stop removed", edited: withoutStop(linear, 1), expected: { ...linear, stops: [{ colour: red, offset: 0 }, { colour: blue, offset: 1 }] } },
    { name: "control: removing below two stops is refused", edited: withoutStop(radial, 0), expected: null },
    { name: "the radial centre to 25 and 75 percent", edited: withRadialCentre(withRadialCentre(radial, { x: 0.25 }), { y: 0.75 }), expected: { ...radial, centreX: 0.25, centreY: 0.75 } },
  ];
  const box = shape({ id: "shape_filled", x: 0, y: 0, width: 200, height: 100 });
  const document = testDocument({ slides: [slide({ id: "slide_one", elements: [box] })] });
  for (const row of rows) {
    it(row.name, () => {
      assert.deepEqual(row.edited, row.expected);
      if (row.edited === null) return;
      const state: EditorState = { ...editorStateFor(document), selection: { kind: "elements", slideId: slideId("slide_one"), elementIds: [box.id] } };
      const next = reduceEditor(state, { kind: "elementPatchRequested", patch: { fill: row.edited } });
      const commands: readonly DocumentCommand[] = next.pendingEdits.flatMap((edit) => (edit.kind === "apply" ? edit.envelope.commands : []));
      assert.deepEqual(commands, [{ kind: "updateElements", slideId: slideId("slide_one"), elementIds: [box.id], patch: { fill: row.expected } }]);
    });
  }
});

describe("the Recent colours row (acceptance 4)", () => {
  const theme = sampleTheme();
  const recentRows: readonly Readonly<{ name: string; recent: readonly Colour[]; labels: readonly string[] }>[] = [
    {
      name: "the picker shows the Recent row from chrome.recentColours, most recent first",
      recent: [{ kind: "literal", hexadecimal: "#e11d48", alpha: 1 }, { kind: "theme", slot: "accent1", alpha: 0.5 }],
      labels: ["Recent: #e11d48", "Recent: Accent 1 at 50 percent"],
    },
    { name: "control: no recent colours, no Recent row", recent: [], labels: [] },
  ];
  for (const row of recentRows) {
    it(row.name, () => {
      const state = fixtureEditorState({ document: documentSnapshot({ deckId: fixtureDeckId("deck_recent"), title: "Recent", slides: [] }) });
      const withRecent: EditorState = { ...state, chrome: { ...state.chrome, recentColours: row.recent } };
      const markup = renderToStaticMarkup(createElement(ColourPalette, { theme, value: { kind: "none" }, recent: withRecent.chrome.recentColours, onChoose: () => undefined }));
      assert.deepEqual([...markup.matchAll(/aria-label="(Recent: [^"]+)"/g)].map((match) => match[1]), row.labels);
      assert.equal(markup.includes(">Recent<"), row.labels.length > 0);
    });
  }
});

describe("Scripted with no scripts explains itself (acceptance 5)", () => {
  const ids = new IdMinter("Scripts1");
  const scriptId = ids.next("transitionScript");
  const scriptedSlide = slideSnapshot({ ids, elements: [shapeElement({ id: ids.next("element"), text: plainBody("Hello") })], transition: { kind: "scripted", scriptId, durationMilliseconds: 800, parameters: {} } });
  const rows: readonly Readonly<{ name: string; scripts: EditorState["document"]["transitionScripts"]; explains: boolean }>[] = [
    { name: "a deck without scripts: the explanation and Write a script", scripts: [], explains: true },
    {
      name: "control: a deck with a script: no explanation",
      scripts: [{ id: scriptId, name: "Ink wipe", description: "", purpose: "transition", author: { kind: "agent", name: "Claude", agentSessionId: "agent_session" }, script: "", stylesheet: "", markup: "", defaultParameters: {}, approval: { kind: "unapproved" }, updatedAt: 1 }],
      explains: false,
    },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const document = { ...documentSnapshot({ deckId: fixtureDeckId("deck_scripts"), title: "Scripts", slides: [scriptedSlide] }), transitionScripts: row.scripts };
      const state = { ...fixtureEditorState({ document }), currentSlideId: scriptedSlide.id };
      const markup = withServices(state, createElement(TransitionTab, { state, dispatch: () => undefined }));
      assert.equal(markup.includes(NO_SCRIPTS_EXPLANATION), row.explains);
      assert.equal(/<button[^>]*>Write a script<\/button>/.test(markup), row.explains);
    });
  }
});

describe("arrow keys in pill groups (acceptance 6)", () => {
  const rows: readonly Readonly<{ key: string; current: number; disabled: readonly boolean[]; target: number | null }>[] = [
    { key: "ArrowRight", current: 0, disabled: [false, false, false], target: 1 },
    { key: "ArrowRight", current: 2, disabled: [false, false, false], target: 0 },
    { key: "ArrowLeft", current: 0, disabled: [false, false, false], target: 2 },
    { key: "ArrowRight", current: 0, disabled: [false, true, false], target: 2 },
    { key: "Home", current: 2, disabled: [false, false, false], target: 0 },
    { key: "End", current: 0, disabled: [false, false, false], target: 2 },
    { key: "Enter", current: 0, disabled: [false, false, false], target: null },
  ];
  for (const row of rows) {
    it(`${row.key} from pill ${row.current} goes to ${row.target === null ? "no pill" : `pill ${row.target}`}`, () => {
      assert.equal(pillGroupKeyTarget({ key: row.key, current: row.current, disabled: row.disabled }), row.target);
    });
  }

  const keyRows: readonly Readonly<{ name: string; key: string; insidePills: boolean; dispatched: boolean }>[] = [
    ...["ArrowRight", "ArrowLeft", "Home", "End"].map((key) => ({ name: `${key} on a focused tab dispatches no keyPressed`, key, insidePills: true, dispatched: false })),
    { name: "control: ArrowRight on the canvas is a key press (a nudge)", key: "ArrowRight", insidePills: false, dispatched: true },
  ];
  for (const row of keyRows) {
    it(row.name, () => {
      const system = createRecordingSystem({ initial: fixtureEditorState({ document: documentSnapshot({ deckId: fixtureDeckId("deck_keys"), title: "Keys", slides: [] }) }) });
      const target = { closest: (selector: string) => (row.insidePills && selector.includes("tablist") ? {} : null) };
      // handleShellKey only calls `closest` on its target (editor-shell.tsx `closestMatches`); the stand-in has exactly that.
      const event: ShellKeyEvent = { key: row.key, code: row.key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, target: target as unknown as EventTarget, defaultPrevented: false, preventDefault: () => undefined };
      handleShellKey({ event, gesture: { system, browser: recordingCapabilities([]), clipboardContentFor: () => null, presentationHost: () => null, speakerWindow: { current: null } }, primaryModifier: "control" });
      assert.equal(system.dispatched.some((dispatched: EditorEvent) => dispatched.kind === "keyPressed"), row.dispatched);
    });
  }
});

describe("a disabled control gives the reducer's own reason", () => {
  const document = testDocument({ slides: [slide({ id: "slide_one", elements: [] })] });
  const statuses: readonly Readonly<{ label: string; status: CollaborationStatus }>[] = [
    ...DECK_ROLES.map((role) => ({ label: `role ${role}`, status: { ...LOCAL_COLLABORATION_STATUS, role } })),
    // Object.keys widens to string[]; CLOSED_MESSAGE is a total record over ClosedReason.
    ...(Object.keys(CLOSED_MESSAGE) as ClosedReason[]).map((reason) => ({ label: `closed ${reason}`, status: { ...LOCAL_COLLABORATION_STATUS, connection: { kind: "closed" as const, reason } } })),
  ];
  for (const row of statuses) {
    it(`${row.label}: the view and the reducer say the same`, () => {
      const state: EditorState = { ...editorStateFor(document), collaboration: row.status };
      assert.equal(editingDisabledReason(state), editingRefusal(state));
      assert.equal(commentingDisabledReason(state), commentingRefusal(state));
    });
  }

  it("the word tables are equal", () => {
    assert.deepEqual(CLOSED_EXPLANATION, CLOSED_MESSAGE);
    assert.deepEqual(ROLE_EDIT_EXPLANATION, ROLE_EDIT_REFUSAL);
    assert.equal(NEWER_SCHEMA_EXPLANATION, NEWER_SCHEMA_MESSAGE);
    assert.equal(VIEWER_COMMENT_EXPLANATION, VIEWER_COMMENT_REFUSAL);
  });
});

function withServices(state: EditorState, child: ReactElement): string {
  const system = createRecordingSystem({ initial: state });
  const services = fixtureServices({ system });
  const gesture = { system, browser: recordingCapabilities([]), clipboardContentFor: services.clipboardContentFor, presentationHost: () => null, speakerWindow: { current: null } };
  return renderToStaticMarkup(createElement(EditorServicesContext.Provider, { value: services }, createElement(EditorGestureContext.Provider, { value: gesture }, child)));
}
