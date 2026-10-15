// The geometry rules three modules must agree on (geometry.ts header), pinned as tables: rotation
// normalisation, flipping a rotated element, resizing in local axes (including dragging past the
// opposite edge and the aspect lock), approximate non-uniform scaling of rotated frames, and the
// zero-size axis that used to divide by zero.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  flipFrame,
  frameCentre,
  identityFrame,
  lineFrame,
  mapPointBetweenBoxes,
  normaliseRotation,
  resizeFrame,
  rotatedBounds,
  rotateFrameAbout,
  scaleFrameBetweenBoxes,
  snapRotation,
  type Frame,
} from "./geometry.ts";

describe("normaliseRotation", () => {
  const table: readonly Readonly<{ input: number; expected: number }>[] = [
    { input: 0, expected: 0 },
    { input: -0, expected: 0 },
    { input: 360, expected: 0 },
    { input: -90, expected: 270 },
    { input: 725, expected: 5 },
    { input: -360, expected: 0 },
  ];
  for (const row of table) {
    it(`${row.input} -> ${row.expected}`, () => {
      const result = normaliseRotation(row.input);
      assert.equal(result, row.expected);
      assert.equal(Object.is(result, -0), false);
    });
  }

  it("snaps to the nearest step", () => {
    assert.equal(snapRotation({ degrees: 22, step: 15 }), 15);
    assert.equal(snapRotation({ degrees: 23, step: 15 }), 30);
    assert.equal(snapRotation({ degrees: -7, step: 15 }), 0);
  });
});

describe("flipFrame", () => {
  const rotated: Frame = { x: 100, y: 100, width: 200, height: 100, rotation: 30, flipHorizontal: false, flipVertical: false };

  it("mirrors the centre, negates the rotation and toggles the flip", () => {
    const flipped = flipFrame({ frame: rotated, axis: "horizontal", about: 640 });
    assertFrame(flipped, { x: 980, y: 100, width: 200, height: 100, rotation: 330, flipHorizontal: true, flipVertical: false });
  });

  it("vertical flip mirrors about a horizontal line", () => {
    const flipped = flipFrame({ frame: rotated, axis: "vertical", about: 360 });
    assertFrame(flipped, { x: 100, y: 520, width: 200, height: 100, rotation: 330, flipHorizontal: false, flipVertical: true });
  });

  it("flipping twice about the same line is the identity", () => {
    const twice = flipFrame({ frame: flipFrame({ frame: rotated, axis: "horizontal", about: 300 }), axis: "horizontal", about: 300 });
    assertFrame(twice, rotated);
  });

  it("the mirrored element's corners are the mirror images of the original corners", () => {
    const flipped = flipFrame({ frame: rotated, axis: "horizontal", about: 640 });
    const original = rotatedBounds(rotated);
    const mirrored = rotatedBounds(flipped);
    assertClose(mirrored.x, 2 * 640 - (original.x + original.width));
    assertClose(mirrored.width, original.width);
    assertClose(mirrored.y, original.y);
  });
});

describe("resizeFrame", () => {
  const plain = identityFrame({ x: 100, y: 100, width: 200, height: 100 });

  it("bottom-right corner follows the pointer, top-left stays", () => {
    const result = resizeFrame({ frame: plain, handle: "bottomRight", pointer: { x: 400, y: 250 }, keepAspectRatio: false, fromCentre: false });
    assertFrame(result, { ...plain, width: 300, height: 150 });
  });

  it("an edge handle changes one axis only", () => {
    const result = resizeFrame({ frame: plain, handle: "left", pointer: { x: 50, y: 999 }, keepAspectRatio: false, fromCentre: false });
    assertFrame(result, { ...plain, x: 50, width: 250 });
  });

  it("dragging past the opposite edge flips instead of producing a negative size", () => {
    const result = resizeFrame({ frame: plain, handle: "right", pointer: { x: 40, y: 150 }, keepAspectRatio: false, fromCentre: false });
    assertFrame(result, { ...plain, x: 40, width: 60, flipHorizontal: true });
  });

  it("never shrinks below the minimum size", () => {
    const result = resizeFrame({ frame: plain, handle: "right", pointer: { x: 100, y: 150 }, keepAspectRatio: false, fromCentre: false });
    assert.equal(result.width, 1);
  });

  it("the aspect lock scales by the larger factor on a corner", () => {
    const result = resizeFrame({ frame: plain, handle: "bottomRight", pointer: { x: 500, y: 210 }, keepAspectRatio: true, fromCentre: false });
    assertFrame(result, { ...plain, width: 400, height: 200 });
  });

  it("the aspect lock on an edge scales the other axis about its centre", () => {
    const result = resizeFrame({ frame: plain, handle: "right", pointer: { x: 500, y: 150 }, keepAspectRatio: true, fromCentre: false });
    assertFrame(result, { ...plain, y: 50, width: 400, height: 200 });
  });

  it("from the centre grows both sides", () => {
    const result = resizeFrame({ frame: plain, handle: "right", pointer: { x: 350, y: 150 }, keepAspectRatio: false, fromCentre: true });
    assertFrame(result, { ...plain, x: 50, width: 300 });
  });

  it("a rotated element resizes along its own axes, its opposite edge fixed in slide space", () => {
    const rotated: Frame = { ...plain, rotation: 90 };
    // Rotated 90 degrees clockwise, the element's right edge faces down. Its centre is (200, 150);
    // its local right edge is at slide y = 250. Dragging that handle to y = 350 adds 100 units.
    const result = resizeFrame({ frame: rotated, handle: "right", pointer: { x: 200, y: 350 }, keepAspectRatio: false, fromCentre: false });
    assertClose(result.width, 300);
    assertClose(result.height, 100);
    assert.equal(result.rotation, 90);
    const centre = frameCentre(result);
    assertClose(centre.x, 200);
    assertClose(centre.y, 200);
  });
});

describe("scaleFrameBetweenBoxes", () => {
  const from = { x: 0, y: 0, width: 100, height: 100 };
  const to = { x: 0, y: 0, width: 200, height: 100 };

  it("is exact for unrotated frames", () => {
    const result = scaleFrameBetweenBoxes({ frame: identityFrame({ x: 10, y: 10, width: 20, height: 20 }), from, to });
    assertFrame(result, identityFrame({ x: 20, y: 10, width: 40, height: 20 }));
  });

  it("a frame rotated 90 degrees stretches along its height", () => {
    const result = scaleFrameBetweenBoxes({ frame: { ...identityFrame({ x: 40, y: 40, width: 20, height: 10 }), rotation: 90 }, from, to });
    assertClose(result.width, 20);
    assertClose(result.height, 20);
    assertClose(result.rotation, 90);
    assertClose(frameCentre(result).x, 100);
  });
});

describe("zero-size axes and derived frames", () => {
  it("mapping a point from a zero-width box only translates on that axis", () => {
    const point = mapPointBetweenBoxes({ point: { x: 50, y: 30 }, from: { x: 50, y: 0, width: 0, height: 60 }, to: { x: 70, y: 0, width: 0, height: 120 } });
    assert.deepEqual(point, { x: 70, y: 60 });
  });

  it("a line's frame is its end points' bounds, unrotated", () => {
    assertFrame(lineFrame({ start: { x: 300, y: 10 }, end: { x: 100, y: 10 } }), identityFrame({ x: 100, y: 10, width: 200, height: 0 }));
  });

  it("rotating about a pivot moves the centre and adds the angle", () => {
    const result = rotateFrameAbout({ frame: identityFrame({ x: 90, y: -10, width: 20, height: 20 }), pivot: { x: 0, y: 0 }, degrees: 90 });
    assertClose(frameCentre(result).x, 0);
    assertClose(frameCentre(result).y, 100);
    assert.equal(result.rotation, 90);
  });
});

function assertFrame(actual: Frame, expected: Frame): void {
  for (const key of ["x", "y", "width", "height", "rotation"] as const) {
    assertClose(actual[key], expected[key], key);
  }
  assert.equal(actual.flipHorizontal, expected.flipHorizontal, "flipHorizontal");
  assert.equal(actual.flipVertical, expected.flipVertical, "flipVertical");
}

function assertClose(actual: number, expected: number, label = "value"): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
}
