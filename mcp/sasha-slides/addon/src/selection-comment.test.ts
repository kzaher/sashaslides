import assert from "node:assert/strict";
import test from "node:test";
import {
  regionOnSlide,
  COMPOSER_GAP,
  COMPOSER_HEIGHT,
  COMPOSER_WIDTH,
  composerPlacementFor,
  describeSelected,
} from "./selection-comment.ts";

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

test("the composer sits under what you clicked, which is where a comment reads from", () => {
  const placed = composerPlacementFor(box(0.1, 0.1, 0.3, 0.2));
  assert.equal(placed.side, "below");
  assert.equal(placed.top, 0.1 + 0.2 + COMPOSER_GAP);
  assert.equal(placed.left, 0.1, "aligned with the selection's left edge");
  assert.equal(placed.width, COMPOSER_WIDTH);
});

test("A SELECTION NEAR THE BOTTOM FLIPS THE COMPOSER ABOVE IT rather than off the slide", () => {
  // 0.82 + 0.15 leaves 0.03 below -- far less than the composer needs, and plenty above.
  const placed = composerPlacementFor(box(0.1, 0.82, 0.3, 0.15));
  assert.equal(placed.side, "above");
  assert.ok(placed.top >= 0, `top ${String(placed.top)} is on the stage`);
  assert.ok(
    placed.top + COMPOSER_HEIGHT <= 0.82 + 1e-9,
    "and it clears the selection it is about",
  );
});

test("a selection at the right edge pulls the composer back onto the stage", () => {
  const placed = composerPlacementFor(box(0.9, 0.1, 0.08, 0.1));
  assert.ok(placed.left + placed.width <= 1 + 1e-9, "its right edge stays on the slide");
  assert.equal(placed.left, 1 - COMPOSER_WIDTH);
});

test("a selection that fills the slide still gets a composer that is ON the slide", () => {
  // Room nowhere. The composer must not be placed at a negative top or past the bottom: a
  // clipped composer takes its Comment button with it.
  const placed = composerPlacementFor(box(0, 0, 1, 1));
  assert.ok(placed.top >= 0, `top ${String(placed.top)}`);
  assert.ok(placed.top + COMPOSER_HEIGHT <= 1 + 1e-9, `bottom ${String(placed.top + COMPOSER_HEIGHT)}`);
  assert.ok(placed.left >= 0 && placed.left + placed.width <= 1 + 1e-9);
});

test("every placement lands inside the stage, for a sweep of selections", () => {
  for (let y = 0; y <= 1; y += 0.05) {
    for (let x = 0; x <= 1; x += 0.1) {
      const placed = composerPlacementFor(box(x, y, 0.2, 0.1));
      const where = `x=${x.toFixed(2)} y=${y.toFixed(2)} -> ${JSON.stringify(placed)}`;
      assert.ok(placed.top >= -1e-9, `top on stage: ${where}`);
      assert.ok(placed.top + COMPOSER_HEIGHT <= 1 + 1e-9, `bottom on stage: ${where}`);
      assert.ok(placed.left >= -1e-9, `left on stage: ${where}`);
      assert.ok(placed.left + placed.width <= 1 + 1e-9, `right on stage: ${where}`);
    }
  }
});

test("the composer's heading names the thing, not the whole selector chain", () => {
  assert.equal(describeSelected("div > section:nth-of-type(2) > h1"), "h1");
  assert.equal(describeSelected("h1"), "h1");
  assert.equal(describeSelected("td:nth-child(3)"), "td");
  // Never empty: a selector that is nothing but a positional step still has to say something.
  assert.equal(describeSelected(":nth-child(3)"), ":nth-child(3)");
});

test("AN ELEMENT THAT RUNS PAST THE SLIDE EDGE IS TRIMMED, not refused", () => {
  // The real one: a full-bleed wrapper measured y=0.03 h=1.0, so y+h = 1.03. The comment channel
  // refuses a box that is not 0-1, so the user pressed Comment and nothing happened.
  const trimmed = regionOnSlide({ x: 0, y: 0.03, w: 1, h: 1 });
  assert.equal(trimmed.y, 0.03);
  assert.ok(trimmed.y + trimmed.h <= 1 + 1e-9, `y+h is ${String(trimmed.y + trimmed.h)}`);
  assert.ok(trimmed.x + trimmed.w <= 1 + 1e-9);
});

test("a box already on the slide is left exactly as it is", () => {
  const same = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
  assert.deepEqual(regionOnSlide(same), same);
});

test("a negative origin and a NaN are both pulled back onto the slide", () => {
  const fixed = regionOnSlide({ x: -0.2, y: Number.NaN, w: 2, h: 0.5 });
  assert.equal(fixed.x, 0);
  assert.equal(fixed.y, 0);
  assert.ok(fixed.w <= 1 && fixed.w >= 0, `w is ${String(fixed.w)}`);
  assert.ok(fixed.x + fixed.w <= 1 + 1e-9);
});
