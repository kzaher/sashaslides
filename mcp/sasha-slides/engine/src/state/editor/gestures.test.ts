// Acceptance tests 6, 7, 8 and 10: pointer gestures with snapping and one commit each, scaling a mixed
// selection, flipping rotated elements and groups, and alignment and distribution over rotated and
// measured bounds.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  flipFrame,
  frameCentre,
  resizeFrame,
  rotatedBounds,
  rotateFrameAbout,
  scaleFrameBetweenBoxes,
  type ArrangeAction,
  type CommandEnvelope,
  type EditorEvent,
  type EditorState,
  type ElementSnapshot,
  type Frame,
  type FrameUpdate,
  type HitTarget,
  type Modifiers,
  type PointerSample,
  type ResizeHandle,
} from "../../contracts/index.ts";
import { editorStateFor, elementId, group, line, shape, slide, slideId, table, testDocument } from "../testing/document-fixtures.ts";
import { reduceEditor } from "./reduce-editor.ts";
import { selectionFrame } from "./frame-updates.ts";

const NONE: Modifiers = { shift: false, alt: false, primary: false };
const SHIFT: Modifiers = { shift: true, alt: false, primary: false };
const SLIDE = slideId("slide_one");

function sample(x: number, y: number, scale = 1): PointerSample {
  return { slidePoint: { x, y }, clientPoint: { x: x * scale, y: y * scale } };
}

function down(target: HitTarget, x: number, y: number, options: Readonly<{ scale?: number; modifiers?: Modifiers; clickCount?: number }> = {}): EditorEvent {
  return { kind: "canvasPointerDown", sample: sample(x, y, options.scale), target, modifiers: options.modifiers ?? NONE, button: "primary", clickCount: options.clickCount ?? 1 };
}

function move(x: number, y: number, options: Readonly<{ scale?: number; modifiers?: Modifiers }> = {}): EditorEvent {
  return { kind: "canvasPointerMove", sample: sample(x, y, options.scale), modifiers: options.modifiers ?? NONE };
}

function up(x: number, y: number, options: Readonly<{ scale?: number; modifiers?: Modifiers }> = {}): EditorEvent {
  return { kind: "canvasPointerUp", sample: sample(x, y, options.scale), modifiers: options.modifiers ?? NONE };
}

function onElement(...ids: readonly string[]): HitTarget {
  return { kind: "element", elementPath: ids.map(elementId) };
}

function handle(name: ResizeHandle): HitTarget {
  return { kind: "resizeHandle", handle: name };
}

function reduceAll(state: EditorState, events: readonly EditorEvent[]): EditorState {
  return events.reduce(reduceEditor, state);
}

function envelopes(state: EditorState): readonly CommandEnvelope[] {
  return state.pendingEdits.flatMap((edit) => (edit.kind === "apply" ? [edit.envelope] : []));
}

function previewOf(state: EditorState): readonly FrameUpdate[] {
  const gesture = state.gesture;
  switch (gesture.kind) {
    case "moving":
    case "resizing":
    case "rotating":
      return gesture.preview;
    default:
      return [];
  }
}

function boxFrame(updates: readonly FrameUpdate[], id: string): Frame {
  const update = updates.find((candidate) => candidate.elementId === elementId(id));
  if (update?.kind !== "box") throw new Error(`no box update for ${id}`);
  return update.frame;
}

function assertFrameClose(actual: Frame, expected: Frame, message?: string): void {
  for (const key of ["x", "y", "width", "height", "rotation"] as const) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-6, `${message ?? ""} ${key}: ${actual[key]} against ${expected[key]}`);
  }
  assert.equal(actual.flipHorizontal, expected.flipHorizontal, `${message ?? ""} flipHorizontal`);
  assert.equal(actual.flipVertical, expected.flipVertical, `${message ?? ""} flipVertical`);
}

function withSelection(state: EditorState, ids: readonly string[]): EditorState {
  return { ...state, selection: { kind: "elements", slideId: SLIDE, elementIds: ids.map(elementId) } };
}

const moveDocument = testDocument({
  slides: [slide({ id: "slide_one", elements: [shape({ id: "shape_moved", x: 100, y: 100, width: 200, height: 100 }), shape({ id: "shape_still", x: 500, y: 100, width: 100, height: 100 })] })],
});

describe("gestures (acceptance 6)", () => {
  const snapRows = [
    { name: "3 units from an edge at scale 1 snaps", scale: 1, dragBy: 197, expectedX: 300, guideAt: 500 },
    { name: "10 units away at scale 1 does not snap", scale: 1, dragBy: 190, expectedX: 290, guideAt: null },
    { name: "10 units away at scale 0.5 (5 client pixels) snaps", scale: 0.5, dragBy: 190, expectedX: 300, guideAt: 500 },
  ] as const;
  for (const row of snapRows) {
    it(`move: ${row.name}`, () => {
      const zoomed = reduceEditor(editorStateFor(moveDocument), { kind: "zoomRequested", zoom: { kind: "fixed", scale: row.scale } });
      const dragging = reduceAll(zoomed, [down(onElement("shape_moved"), 150, 150, { scale: row.scale }), move(150 + row.dragBy, 150, { scale: row.scale })]);
      assert.equal(dragging.gesture.kind, "moving");
      assert.equal(boxFrame(previewOf(dragging), "shape_moved").x, row.expectedX);
      const verticalGuides = dragging.gesture.kind === "moving" ? dragging.gesture.guides.filter((guide) => guide.axis === "vertical") : [];
      assert.deepEqual(verticalGuides.map((guide) => guide.position), row.guideAt === null ? [] : [row.guideAt]);
    });
  }

  it("move: Shift locks the dominant axis", () => {
    const dragging = reduceAll(editorStateFor(moveDocument), [down(onElement("shape_moved"), 150, 150), move(210, 170, { modifiers: SHIFT })]);
    const frame = boxFrame(previewOf(dragging), "shape_moved");
    assert.deepEqual({ x: frame.x, y: frame.y }, { x: 160, y: 100 });
  });

  it("move commits exactly one setFrames envelope on release", () => {
    const released = reduceAll(editorStateFor(moveDocument), [down(onElement("shape_moved"), 150, 150), move(210, 150), move(230, 150), up(230, 150)]);
    assert.equal(released.gesture.kind, "idle");
    const queued = envelopes(released);
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0]?.commands.map((command) => command.kind), ["setFrames"]);
    assert.deepEqual(queued[0]?.mergeWithPrevious, false);
  });

  const cancelRows = [
    { name: "Escape", cancel: { kind: "keyPressed", chord: { key: "Escape", code: "Escape", modifiers: NONE } } },
    { name: "pointer cancel", cancel: { kind: "canvasPointerCancelled" } },
  ] as const satisfies readonly Readonly<{ name: string; cancel: EditorEvent }>[];
  for (const row of cancelRows) {
    it(`${row.name} during a drag commits nothing`, () => {
      const cancelled = reduceAll(editorStateFor(moveDocument), [down(onElement("shape_moved"), 150, 150), move(230, 150), row.cancel, up(230, 150)]);
      assert.equal(cancelled.gesture.kind, "idle");
      assert.deepEqual(envelopes(cancelled), []);
    });
  }

  const resizeRows = [
    { name: "grows from the opposite corner", pointer: { x: 400, y: 260 }, flips: false },
    { name: "flips past the opposite edge", pointer: { x: 50, y: 260 }, flips: true },
  ] as const;
  for (const row of resizeRows) {
    it(`resize ${row.name}, exactly as resizeFrame`, () => {
      const selected = withSelection(editorStateFor(moveDocument), ["shape_moved"]);
      const resizing = reduceAll(selected, [down(handle("bottomRight"), 300, 200), move(row.pointer.x, row.pointer.y)]);
      const original = moveDocument.slides[0]?.elements[0];
      assert.ok(original !== undefined);
      const expected = resizeFrame({ frame: original.frame, handle: "bottomRight", pointer: row.pointer, keepAspectRatio: false, fromCentre: false });
      const actual = boxFrame(previewOf(resizing), "shape_moved");
      assertFrameClose(actual, expected);
      assert.equal(actual.flipHorizontal, row.flips);
      const released = reduceEditor(resizing, up(row.pointer.x, row.pointer.y));
      assert.equal(envelopes(released).length, 1);
    });
  }

  // The lock keeps proportions as Shift does; the control rows show neither alone is needed and that
  // without both the drag's own proportions win.
  for (const row of [
    { name: "unlocked, no Shift: the drag's proportions", locked: false, modifiers: NONE, keepAspectRatio: false },
    { name: "locked, no Shift: the lock keeps the proportions", locked: true, modifiers: NONE, keepAspectRatio: true },
    { name: "unlocked, Shift: Shift keeps the proportions", locked: false, modifiers: SHIFT, keepAspectRatio: true },
  ] as const) {
    it(`resize ${row.name}`, () => {
      const unlocked = withSelection(editorStateFor(moveDocument), ["shape_moved"]);
      const selected = row.locked ? reduceEditor(unlocked, { kind: "aspectRatioLockToggled" }) : unlocked;
      assert.equal(selected.chrome.aspectRatioLocked, row.locked);
      const pointer = { x: 500, y: 220 };
      const resizing = reduceAll(selected, [down(handle("bottomRight"), 300, 200), move(pointer.x, pointer.y, { modifiers: row.modifiers })]);
      const original = moveDocument.slides[0]?.elements[0];
      assert.ok(original !== undefined);
      const expected = resizeFrame({ frame: original.frame, handle: "bottomRight", pointer, keepAspectRatio: row.keepAspectRatio, fromCentre: false });
      assertFrameClose(boxFrame(previewOf(resizing), "shape_moved"), expected);
    });
  }

  for (const row of [
    { name: "unlocked: only the width changes", locked: false, expected: { width: 400, height: 100 } },
    { name: "locked: the height follows the width", locked: true, expected: { width: 400, height: 200 } },
  ] as const) {
    it(`typing a width, ${row.name}`, () => {
      const unlocked = withSelection(editorStateFor(moveDocument), ["shape_moved"]);
      const selected = row.locked ? reduceEditor(unlocked, { kind: "aspectRatioLockToggled" }) : unlocked;
      const edited = reduceEditor(selected, { kind: "frameFieldEdited", field: "width", value: 400 });
      const frames = envelopes(edited)[0]?.commands.flatMap((command) => (command.kind === "setFrames" ? command.frames : [])) ?? [];
      const frame = boxFrame(frames, "shape_moved");
      assert.deepEqual({ width: frame.width, height: frame.height }, row.expected);
    });
  }

  it("rotating a group previews its own rotation and every child's frame", () => {
    const children = [shape({ id: "shape_left", x: 100, y: 100, width: 100, height: 100 }), shape({ id: "shape_right", x: 300, y: 100, width: 100, height: 100 })];
    const grouped = group({ id: "group_pair", children });
    const document = testDocument({ slides: [slide({ id: "slide_one", elements: [grouped] })] });
    const clicked = reduceAll(editorStateFor(document), [down(onElement("group_pair", "shape_left"), 150, 150), up(150, 150)]);
    assert.deepEqual(clicked.selection, { kind: "elements", slideId: SLIDE, elementIds: [elementId("group_pair")] });
    const rotating = reduceAll(clicked, [down({ kind: "rotationHandle" }, 250, 50), move(350, 150)]);
    const preview = previewOf(rotating);
    const centre = frameCentre(grouped.frame);
    assert.deepEqual(preview.find((update) => update.kind === "groupRotation"), { kind: "groupRotation", elementId: elementId("group_pair"), rotation: 90 });
    for (const child of children) assertFrameClose(boxFrame(preview, child.id), rotateFrameAbout({ frame: child.frame, pivot: centre, degrees: 90 }), child.id);
    const released = reduceEditor(rotating, up(350, 150));
    const committed = envelopes(released);
    assert.equal(committed.length, 1);
    assert.deepEqual(committed[0]?.commands.map((command) => command.kind), ["setFrames"]);
  });
});

describe("scaling a mixed selection (acceptance 7)", () => {
  const rotated = shape({ id: "shape_rotated", x: 100, y: 100, width: 200, height: 100, rotation: 30 });
  const horizontal = line({ id: "line_flat", start: { x: 100, y: 400 }, end: { x: 500, y: 400 } });
  const document = testDocument({ slides: [slide({ id: "slide_one", elements: [rotated, horizontal] })] });

  it("uses scaleFrameBetweenBoxes for the shape and a line update for the line", () => {
    const state = withSelection(editorStateFor(document), ["shape_rotated", "line_flat"]);
    const elements: readonly ElementSnapshot[] = [rotated, horizontal];
    const from = selectionFrame(elements, new Map());
    assert.ok(from !== null);
    const pointer = { x: from.x + from.width + 100, y: from.y + from.height + 50 };
    const resizing = reduceAll(state, [down(handle("bottomRight"), from.x + from.width, from.y + from.height), move(pointer.x, pointer.y)]);
    const to = resizeFrame({ frame: from, handle: "bottomRight", pointer, keepAspectRatio: false, fromCentre: false });
    const preview = previewOf(resizing);
    assertFrameClose(boxFrame(preview, "shape_rotated"), scaleFrameBetweenBoxes({ frame: rotated.frame, from, to }));
    const lineUpdate = preview.find((update) => update.elementId === elementId("line_flat"));
    assert.equal(lineUpdate?.kind, "line");
    if (lineUpdate?.kind !== "line") return;
    assert.ok([lineUpdate.start.x, lineUpdate.start.y, lineUpdate.end.x, lineUpdate.end.y].every(Number.isFinite));
    assert.ok(Math.abs(lineUpdate.start.y - lineUpdate.end.y) < 1e-9, "the line stays horizontal");
  });

  it("a horizontal line alone (zero height) resizes with no division by zero", () => {
    const state = withSelection(editorStateFor(document), ["line_flat"]);
    const resizing = reduceAll(state, [down(handle("bottomRight"), 500, 400), move(700, 450)]);
    const update = previewOf(resizing)[0];
    assert.equal(update?.kind, "line");
    if (update?.kind !== "line") return;
    // The zero-height axis only translates (its top edge did not move); the width scales.
    assert.deepEqual({ start: update.start, end: update.end }, { start: { x: 100, y: 400 }, end: { x: 700, y: 400 } });
  });
});

describe("flipping (acceptance 8)", () => {
  const rotated = shape({ id: "shape_rotated", x: 100, y: 100, width: 200, height: 100, rotation: 30 });
  const children = [shape({ id: "shape_child_one", x: 500, y: 300, width: 100, height: 50, rotation: 10 }), shape({ id: "shape_child_two", x: 650, y: 300, width: 100, height: 50 })];
  const grouped = group({ id: "group_flip", children, rotation: 20 });
  const document = testDocument({ slides: [slide({ id: "slide_one", elements: [rotated, grouped] })] });

  const rows = [
    { axis: "horizontal", flips: (frame: Frame) => frame.flipHorizontal },
    { axis: "vertical", flips: (frame: Frame) => frame.flipVertical },
  ] as const;
  for (const row of rows) {
    it(`flips ${row.axis}ly about the selection's centre: rotations negated, flips toggled`, () => {
      const state = withSelection(editorStateFor(document), ["shape_rotated", "group_flip"]);
      const flipped = reduceEditor(state, { kind: "arrangeRequested", action: { kind: "flip", axis: row.axis } });
      const command = envelopes(flipped)[0]?.commands[0];
      assert.equal(command?.kind, "setFrames");
      if (command?.kind !== "setFrames") return;
      const centre = frameCentre(selectionFrame([rotated, grouped], new Map()) ?? rotated.frame);
      const about = row.axis === "horizontal" ? centre.x : centre.y;
      for (const element of [rotated, ...children]) {
        const expected = flipFrame({ frame: element.frame, axis: row.axis, about });
        const actual = boxFrame(command.frames, element.id);
        assertFrameClose(actual, expected, element.id);
        assert.equal(row.flips(actual), true);
      }
      assert.equal(boxFrame(command.frames, "shape_rotated").rotation, 330);
      assert.deepEqual(command.frames.find((update) => update.kind === "groupRotation"), { kind: "groupRotation", elementId: elementId("group_flip"), rotation: 340 });
    });
  }
});

describe("alignment and distribution (acceptance 10)", () => {
  const diamond = shape({ id: "shape_diamond", x: 300, y: 300, width: 100, height: 100, rotation: 45 });
  const grid = table({ id: "table_grid", x: 600, y: 200, columnWidths: [100, 100], rowHeights: [50, 50] });
  const document = testDocument({ slides: [slide({ id: "slide_one", elements: [diamond, grid] })] });
  const halfDiagonal = 50 * Math.SQRT2;

  function aligned(state: EditorState, action: ArrangeAction): readonly FrameUpdate[] {
    const command = envelopes(reduceEditor(state, { kind: "arrangeRequested", action }))[0]?.commands[0];
    return command?.kind === "setFrames" ? command.frames : [];
  }

  it("aligns left to the rotated bounds of the leftmost element", () => {
    const frames = aligned(withSelection(editorStateFor(document), ["shape_diamond", "table_grid"]), { kind: "align", edge: "left" });
    assert.ok(Math.abs(boxFrame(frames, "table_grid").x - (350 - halfDiagonal)) < 1e-9);
    assert.ok(Math.abs(rotatedBounds(boxFrame(frames, "shape_diamond")).x - (350 - halfDiagonal)) < 1e-9);
  });

  const measuredRows = [
    { name: "with the measured table height", measured: true, expectedTableY: 350 + halfDiagonal - 160 },
    { name: "without a measurement (control)", measured: false, expectedTableY: 350 + halfDiagonal - 100 },
  ] as const;
  for (const row of measuredRows) {
    it(`aligns bottoms ${row.name}`, () => {
      const base = withSelection(editorStateFor(document), ["shape_diamond", "table_grid"]);
      const rowIds = grid.rows.map((gridRow) => gridRow.id);
      const state = row.measured
        ? reduceEditor(base, {
            kind: "layoutMeasured",
            slideId: SLIDE,
            elementId: grid.id,
            measurement: { kind: "table", rowHeights: rowIds.map((rowId) => ({ rowId, height: 80 })) },
          })
        : base;
      const frames = aligned(state, { kind: "align", edge: "bottom" });
      assert.ok(Math.abs(boxFrame(frames, "table_grid").y - row.expectedTableY) < 1e-9, `${boxFrame(frames, "table_grid").y}`);
      assert.equal(boxFrame(frames, "table_grid").height, 100, "the stored height is never replaced by the measurement");
    });
  }

  it("one element aligns to the slide", () => {
    const frames = aligned(withSelection(editorStateFor(document), ["shape_diamond"]), { kind: "align", edge: "right" });
    const bounds = rotatedBounds(boxFrame(frames, "shape_diamond"));
    assert.ok(Math.abs(bounds.x + bounds.width - 1280) < 1e-9);
  });

  it("distribution keeps the outermost two fixed and equalises the gaps", () => {
    const spread = testDocument({
      slides: [
        slide({
          id: "slide_one",
          elements: [
            shape({ id: "shape_first", x: 0, y: 0, width: 100, height: 50 }),
            shape({ id: "shape_last", x: 1000, y: 0, width: 100, height: 50 }),
            shape({ id: "shape_middle", x: 300, y: 0, width: 50, height: 50 }),
          ],
        }),
      ],
    });
    const frames = aligned(withSelection(editorStateFor(spread), ["shape_first", "shape_last", "shape_middle"]), { kind: "distribute", axis: "horizontal" });
    assert.deepEqual(frames.map((update) => update.elementId), [elementId("shape_middle")]);
    assert.equal(boxFrame(frames, "shape_middle").x, 100 + (1000 - 100 - 50) / 2);
  });

  it("distribution needs three", () => {
    assert.deepEqual(aligned(withSelection(editorStateFor(document), ["shape_diamond", "table_grid"]), { kind: "distribute", axis: "horizontal" }), []);
  });
});
