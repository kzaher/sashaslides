/**
 * The shared post-extraction fixes (post-extraction.ts) that the command line
 * and the browser product both apply before rasterising.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPostExtractionFixes, clampOversampling, rasterJobFor } from "./post-extraction.ts";
import type { ExtractedElement, Extraction } from "./convert-pptx-lib.ts";

test("clampOversampling keeps [1,8] and falls back to 2", () => {
  assert.equal(clampOversampling(undefined), 2);
  assert.equal(clampOversampling(Number.NaN), 2);
  assert.equal(clampOversampling(0), 1);
  assert.equal(clampOversampling(3), 3);
  assert.equal(clampOversampling(20), 8);
});

test("a centred emoji becomes a glyph-sized image the capture draws as emoji", () => {
  const icon: ExtractedElement = {
    type: "text", text: "⚡", bounds: { x: 100, y: 50, w: 80, h: 60 },
    style: { fontSize: 20, textAlign: "center" }, verticallyCentered: true,
  };
  const [fixed] = applyPostExtractionFixes(slide([icon]), { tablesFormat: "native" }).elements;
  assert.equal(fixed?.type, "image");
  assert.deepEqual(fixed?.bounds, { x: 126, y: 66, w: 28, h: 28 });
  assert.deepEqual(fixed && rasterJobFor(fixed), { kind: "emoji", text: "⚡" });
});

test("text-renderable symbols and ordinary text stay native text", () => {
  const check: ExtractedElement = { type: "text", text: "✓", bounds: { x: 0, y: 0, w: 20, h: 20 } };
  const words: ExtractedElement = { type: "text", text: "Revenue ⚡", bounds: { x: 0, y: 0, w: 200, h: 20 } };
  const fixed = applyPostExtractionFixes(slide([check, words]), { tablesFormat: "native" }).elements;
  assert.deepEqual(fixed, [check, words]);
  assert.equal(rasterJobFor(check), null);
});

test("tables stay native unless tablesFormat is baked", () => {
  const table: ExtractedElement = { type: "table", bounds: { x: 0, y: 0, w: 300, h: 100 }, rows: [] };
  assert.deepEqual(applyPostExtractionFixes(slide([table]), { tablesFormat: "native" }).elements, [table]);
  const [baked] = applyPostExtractionFixes(slide([table]), { tablesFormat: "baked" }).elements;
  assert.equal(baked?.type, "image");
  assert.deepEqual(baked && rasterJobFor(baked), { kind: "baked-table" });
});

test("rasterJobFor isolates a text glow and skips regions of 5 px or less", () => {
  const glow: ExtractedElement = { type: "visual", tag: "text-glow", glowId: 3, bounds: { x: 0, y: 0, w: 90, h: 40 } };
  const svg: ExtractedElement = { type: "visual", tag: "svg", bounds: { x: 0, y: 0, w: 90, h: 40 } };
  const sliver: ExtractedElement = { type: "image", bounds: { x: 0, y: 0, w: 5, h: 40 } };
  assert.deepEqual(rasterJobFor(glow), { kind: "text-glow", glowId: 3 });
  assert.deepEqual(rasterJobFor(svg), { kind: "element" });
  assert.equal(rasterJobFor(sliver), null);
});

function slide(elements: ExtractedElement[]): Extraction {
  return { viewport: { w: 1280, h: 720 }, elementCount: elements.length, elements };
}
