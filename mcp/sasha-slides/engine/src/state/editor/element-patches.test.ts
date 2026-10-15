// Acceptance 1 (SPEC.md 21.9, review fix 1): a panel edit on several selected elements changes the
// edited field on EACH element's own style group and leaves its other fields alone. Every row runs
// the same steps -- select the elements, dispatch the panel's patch (built, as the panel builds it,
// from the first element's group with one field replaced) -- and the rows differ only in the
// selection; the control rows select one element (the milestone 1 result, unchanged) and a selection
// whose other fields already agree (still one command).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Border, Colour, DocumentCommand, EditorState, ElementPatch, ElementSnapshot, LineElement, ShapeElement, Stroke } from "../../contracts/index.ts";
import { editorStateFor, line, shape, slide, slideId, testDocument } from "../testing/document-fixtures.ts";
import { reduceEditor } from "./reduce-editor.ts";

const RED: Colour = { kind: "literal", hexadecimal: "#ff0000", alpha: 1 };
const BLUE: Colour = { kind: "literal", hexadecimal: "#0000ff", alpha: 1 };

function paddedBox(options: Readonly<{ id: string; top: number; left: number }>): ShapeElement {
  const base = shape({ id: options.id, x: 0, y: 0, width: 200, height: 100, preset: "textBox" });
  return { ...base, textBox: { ...base.textBox, paddingTop: options.top, paddingLeft: options.left } };
}

function colouredLine(options: Readonly<{ id: string; colour: Colour }>): LineElement {
  const base = line({ id: options.id, start: { x: 0, y: 0 }, end: { x: 100, y: 100 } });
  return { ...base, stroke: { ...base.stroke, colour: options.colour } };
}

function borderedShape(options: Readonly<{ id: string; colour: Colour }>): ShapeElement {
  const base = shape({ id: options.id, x: 0, y: 0, width: 100, height: 100 });
  return { ...base, box: { ...base.box, border: { kind: "uniform", stroke: { width: 1, colour: options.colour, dash: "solid" } } } };
}

/** The commands queued after selecting `elements` and applying the panel's `patch`. */
function patched(elements: readonly ElementSnapshot[], patch: ElementPatch): readonly DocumentCommand[] {
  const document = testDocument({ slides: [slide({ id: "slide_one", elements })] });
  const state: EditorState = { ...editorStateFor(document), selection: { kind: "elements", slideId: slideId("slide_one"), elementIds: elements.map((element) => element.id) } };
  const next = reduceEditor(state, { kind: "elementPatchRequested", patch });
  return next.pendingEdits.flatMap((edit) => (edit.kind === "apply" ? edit.envelope.commands : []));
}

/** What each element ends up with: its id and the patch a command gives it. */
function patchByElement(commands: readonly DocumentCommand[]): ReadonlyMap<string, ElementPatch> {
  const result = new Map<string, ElementPatch>();
  for (const command of commands) {
    if (command.kind !== "updateElements") continue;
    for (const elementId of command.elementIds) result.set(elementId, command.patch);
  }
  return result;
}

describe("multi-selection edits merge per element", () => {
  const first = paddedBox({ id: "shape_first", top: 10, left: 20 });
  const second = paddedBox({ id: "shape_second", top: 30, left: 40 });
  const agreeing = paddedBox({ id: "shape_agreeing", top: 30, left: 20 });
  const topFive: ElementPatch = { textBox: { ...first.textBox, paddingTop: 5 } };

  const paddingRows: readonly Readonly<{ name: string; elements: readonly ShapeElement[]; expected: readonly Readonly<{ id: string; top: number; left: number }>[]; commandCount: number }>[] = [
    { name: "two text boxes, padding top to 5: each keeps its own left padding", elements: [first, second], expected: [{ id: first.id, top: 5, left: 20 }, { id: second.id, top: 5, left: 40 }], commandCount: 2 },
    { name: "control: one text box gets exactly the panel's patch", elements: [first], expected: [{ id: first.id, top: 5, left: 20 }], commandCount: 1 },
    { name: "control: boxes whose other fields agree share one command", elements: [first, agreeing], expected: [{ id: first.id, top: 5, left: 20 }, { id: agreeing.id, top: 5, left: 20 }], commandCount: 1 },
  ];
  for (const row of paddingRows) {
    it(row.name, () => {
      const commands = patched(row.elements, topFive);
      const byElement = patchByElement(commands);
      assert.equal(commands.length, row.commandCount);
      for (const expected of row.expected) {
        const textBox = byElement.get(expected.id)?.textBox;
        assert.equal(textBox?.paddingTop, expected.top, `${expected.id} top`);
        assert.equal(textBox?.paddingLeft, expected.left, `${expected.id} left`);
      }
    });
  }

  it("control: one element queues the same single command milestone 1 queued", () => {
    assert.deepEqual(patched([first], topFive), [{ kind: "updateElements", slideId: slideId("slide_one"), elementIds: [first.id], patch: topFive }]);
  });

  const red = colouredLine({ id: "line_red", colour: RED });
  const blue = colouredLine({ id: "line_blue", colour: BLUE });
  const widthSix: ElementPatch = { stroke: { ...red.stroke, width: 6 } };
  const strokeRows: readonly Readonly<{ name: string; elements: readonly LineElement[]; expected: readonly Readonly<{ id: string; stroke: Stroke }>[] }>[] = [
    { name: "a red and a blue line, width to 6: both 6 wide, each keeps its colour", elements: [red, blue], expected: [{ id: red.id, stroke: { ...red.stroke, width: 6 } }, { id: blue.id, stroke: { ...blue.stroke, width: 6 } }] },
    { name: "control: the red line alone", elements: [red], expected: [{ id: red.id, stroke: { ...red.stroke, width: 6 } }] },
  ];
  for (const row of strokeRows) {
    it(row.name, () => {
      const byElement = patchByElement(patched(row.elements, widthSix));
      for (const expected of row.expected) assert.deepEqual(byElement.get(expected.id)?.stroke, expected.stroke, expected.id);
    });
  }

  const redBorder = borderedShape({ id: "shape_red", colour: RED });
  const blueBorder = borderedShape({ id: "shape_blue", colour: BLUE });
  const borderOf = (element: ShapeElement): Border => element.box.border;
  const strokeOf = (border: Border): Stroke => {
    if (border.kind !== "uniform") throw new Error("the fixture borders are uniform");
    return border.stroke;
  };
  const widerBorder: ElementPatch = { border: { kind: "uniform", stroke: { ...strokeOf(borderOf(redBorder)), width: 4 } } };
  const borderRows: readonly Readonly<{ name: string; elements: readonly ShapeElement[]; expected: readonly Readonly<{ id: string; colour: Colour }>[] }>[] = [
    { name: "a red and a blue border, width to 4: each keeps its colour", elements: [redBorder, blueBorder], expected: [{ id: redBorder.id, colour: RED }, { id: blueBorder.id, colour: BLUE }] },
    { name: "control: the red border alone", elements: [redBorder], expected: [{ id: redBorder.id, colour: RED }] },
  ];
  for (const row of borderRows) {
    it(row.name, () => {
      const byElement = patchByElement(patched(row.elements, widerBorder));
      for (const expected of row.expected) {
        const border = byElement.get(expected.id)?.border;
        assert.ok(border !== undefined, expected.id);
        assert.deepEqual(strokeOf(border), { width: 4, colour: expected.colour, dash: "solid" }, expected.id);
      }
    });
  }

  it("a change of kind is whole: turning the borders off turns both off", () => {
    const byElement = patchByElement(patched([redBorder, blueBorder], { border: { kind: "none" } }));
    assert.deepEqual(byElement.get(redBorder.id)?.border, { kind: "none" });
    assert.deepEqual(byElement.get(blueBorder.id)?.border, { kind: "none" });
  });

  it("every merged command travels in one envelope: one undo step", () => {
    const document = testDocument({ slides: [slide({ id: "slide_one", elements: [first, second] })] });
    const state: EditorState = { ...editorStateFor(document), selection: { kind: "elements", slideId: slideId("slide_one"), elementIds: [first.id, second.id] } };
    const next = reduceEditor(state, { kind: "elementPatchRequested", patch: topFive });
    assert.equal(next.pendingEdits.length, 1);
  });
});
