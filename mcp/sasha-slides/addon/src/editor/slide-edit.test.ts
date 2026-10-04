// The edit-record algebra: what a gesture becomes, what two gestures become, and what each
// override turns into as CSS. All of it is pure, so none of it needs a browser -- the DOM half is
// proven in harness/drive.e2e.ts, against real Chrome.

import assert from "node:assert/strict";
import test from "node:test";
import {
  SLIDE_HEIGHT_PX,
  SLIDE_WIDTH_PX,
  appendEdit,
  declarationsFor,
  describeEdit,
  fractionOfSlideX,
  fractionOfSlideY,
  overridesOf,
  removedTargetsOf,
  slidePxOfX,
  slidePxOfY,
  type ElementBaseline,
  type SlideEdit,
} from "./slide-edit.ts";

const NO_BASELINE: ElementBaseline = { transform: "none", inlineStyle: "" };

const moveTitle: SlideEdit = { kind: "moved", target: "h1.title", from: { x: 0.08, y: 0.1 }, to: { x: 0.08, y: 0.16 } };

test("a measurement becomes a fraction of the 1280x720 slide, and comes back as the same pixels", () => {
  assert.equal(fractionOfSlideX(SLIDE_WIDTH_PX / 2), 0.5);
  assert.equal(fractionOfSlideY(SLIDE_HEIGHT_PX / 4), 0.25);
  assert.equal(slidePxOfX(0.5), 640);
  assert.equal(slidePxOfY(0.25), 180);
  // A fraction is rounded to 1e-4 so the record stays readable, which is 0.128 slide px across
  // and 0.072 down: the round trip is lossy by less than an eighth of a pixel, by design. The
  // browser harness measures the end-to-end error at 0.00-0.10px, well inside this.
  assert.ok(Math.abs(slidePxOfX(fractionOfSlideX(417)) - 417) <= 0.13);
  assert.ok(Math.abs(slidePxOfY(fractionOfSlideY(389)) - 389) <= 0.08);
});

test("a gesture that ends where it began is not an edit", () => {
  const still: SlideEdit = { kind: "moved", target: "h1", from: { x: 0.1, y: 0.1 }, to: { x: 0.1, y: 0.1 } };
  assert.deepEqual(appendEdit({ edits: [], edit: still }), []);
  // The same rule is what the live editor leans on when a swatch is committed at the colour the
  // element already had -- and the reason the swatch must capture `from` BEFORE it previews, which
  // only harness/drive.e2e.ts can prove.
  const sameColour: SlideEdit = { kind: "recoloured", target: ".accent", property: "color", from: "#111111", to: "#111111" };
  assert.deepEqual(appendEdit({ edits: [], edit: sameColour }), []);
});

test("two drags of the same element are one record: the first `from`, the last `to`", () => {
  const second: SlideEdit = { kind: "moved", target: "h1.title", from: { x: 0.08, y: 0.16 }, to: { x: 0.2, y: 0.3 } };
  const edits = appendEdit({ edits: appendEdit({ edits: [], edit: moveTitle }), edit: second });
  assert.deepEqual(edits, [{ kind: "moved", target: "h1.title", from: { x: 0.08, y: 0.1 }, to: { x: 0.2, y: 0.3 } }]);
});

test("dragging away and back again leaves no record at all", () => {
  const back: SlideEdit = { kind: "moved", target: "h1.title", from: { x: 0.08, y: 0.16 }, to: { x: 0.08, y: 0.1 } };
  assert.deepEqual(appendEdit({ edits: appendEdit({ edits: [], edit: moveTitle }), edit: back }), []);
});

test("a gesture on a different element, or of a different kind, never merges into the one before", () => {
  const other: SlideEdit = { kind: "moved", target: "#chart", from: { x: 0.5, y: 0.5 }, to: { x: 0.6, y: 0.5 } };
  const resize: SlideEdit = { kind: "resized", target: "h1.title", from: { w: 0.4, h: 0.1 }, to: { w: 0.5, h: 0.1 } };
  assert.equal(appendEdit({ edits: [moveTitle], edit: other }).length, 2);
  assert.equal(appendEdit({ edits: [moveTitle], edit: resize }).length, 2);
});

test("recolours merge per property, so text colour and background stay two separate records", () => {
  const first: SlideEdit = { kind: "recoloured", target: ".accent", property: "color", from: "#2b3a8f", to: "#333333" };
  const darker: SlideEdit = { kind: "recoloured", target: ".accent", property: "color", from: "#333333", to: "#111111" };
  const back: SlideEdit = { kind: "recoloured", target: ".accent", property: "background", from: "#ffffff", to: "#eeeeee" };
  const edits = [first, darker, back].reduce((list, edit) => appendEdit({ edits: list, edit }), [] as readonly SlideEdit[]);
  assert.deepEqual(edits, [{ kind: "recoloured", target: ".accent", property: "color", from: "#2b3a8f", to: "#111111" }, back]);
});

test("overrides fold per target, in the order each target was first touched", () => {
  const edits: readonly SlideEdit[] = [
    moveTitle,
    { kind: "recoloured", target: "#chart", property: "background", from: "#ffffff", to: "#000000" },
    { kind: "retext", target: "h1.title", to: "Q3 infrastructure spend" },
    { kind: "removed", target: ".badge" },
  ];
  const overrides = overridesOf(edits);
  assert.deepEqual(
    overrides.map((override) => override.target),
    ["h1.title", "#chart", ".badge"],
  );
  assert.equal(overrides[0]?.text, "Q3 infrastructure spend");
  assert.deepEqual(overrides[0]?.position, { from: { x: 0.08, y: 0.1 }, to: { x: 0.08, y: 0.16 } });
  assert.deepEqual(removedTargetsOf(overrides), [".badge"]);
});

test("a move is a translate of the delta, composed in front of the element's own transform", () => {
  const override = overridesOf([moveTitle])[0];
  assert.notEqual(override, undefined);
  if (override === undefined) return;
  assert.deepEqual(declarationsFor({ override, baseline: NO_BASELINE }), [
    { property: "transform", value: "translate(0px, 43.2px)", important: true },
  ]);
  // Prepended, so the move happens in the PARENT's coordinate space: a rotated badge moves the way
  // the pointer moved, not along its own rotated axis.
  const rotated = declarationsFor({ override, baseline: { transform: "rotate(20deg)", inlineStyle: "" } });
  assert.deepEqual(rotated, [{ property: "transform", value: "translate(0px, 43.2px) rotate(20deg)", important: true }]);
});

test("a resize is a border-box width and height in slide pixels, and never a transform", () => {
  const resized: SlideEdit = { kind: "resized", target: "#chart", from: { w: 0.4, h: 0.3 }, to: { w: 0.52, h: 0.3 } };
  const override = overridesOf([resized])[0];
  assert.notEqual(override, undefined);
  if (override === undefined) return;
  assert.deepEqual(declarationsFor({ override, baseline: NO_BASELINE }), [
    { property: "box-sizing", value: "border-box", important: true },
    { property: "width", value: "665.6px", important: true },
    { property: "height", value: "216px", important: true },
  ]);
});

test("every override is written !important, because the candidate's own CSS may be too", () => {
  const edits: readonly SlideEdit[] = [
    { kind: "recoloured", target: ".accent", property: "color", from: "#2b3a8f", to: "#111111" },
    { kind: "recoloured", target: ".accent", property: "background", from: "#ffffff", to: "#eeeeee" },
  ];
  const override = overridesOf(edits)[0];
  assert.notEqual(override, undefined);
  if (override === undefined) return;
  const declarations = declarationsFor({ override, baseline: NO_BASELINE });
  assert.deepEqual(
    declarations.map((declaration) => `${declaration.property}:${declaration.value}`),
    ["color:#111111", "background:#eeeeee"],
  );
  assert.ok(declarations.every((declaration) => declaration.important));
});

test("a removal is not a declaration: `html()` deletes the element rather than hiding it", () => {
  const override = overridesOf([{ kind: "removed", target: ".badge" }])[0];
  assert.notEqual(override, undefined);
  if (override === undefined) return;
  assert.deepEqual(declarationsFor({ override, baseline: NO_BASELINE }), []);
  assert.equal(override.removed, true);
});

test("every kind describes itself in one line a human can read", () => {
  assert.equal(describeEdit(moveTitle), "moved h1.title to 8%,16%");
  assert.equal(describeEdit({ kind: "resized", target: "#chart", from: { w: 0.4, h: 0.3 }, to: { w: 0.52, h: 0.3 } }), "resized #chart to 52%x30%");
  assert.equal(
    describeEdit({ kind: "recoloured", target: ".accent", property: "color", from: "#2b3a8f", to: "#111111" }),
    "recoloured .accent color to #111111",
  );
  assert.equal(describeEdit({ kind: "retext", target: "h1.title", to: "Q3 spend" }), 'retext h1.title to "Q3 spend"');
  assert.equal(describeEdit({ kind: "removed", target: ".badge" }), "removed .badge");
});
