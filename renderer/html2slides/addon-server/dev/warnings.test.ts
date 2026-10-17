// THE CONVERTER'S WARNINGS as the page lists and draws them (warnings.ts).

import assert from "node:assert/strict";
import test from "node:test";
import { describeUnsupportedFeature, type UnsupportedFeature } from "../../../../mcp/sasha-slides/converter/index.ts";
import { warningMarks, warningSummary } from "./warnings.ts";

const RASTER: UnsupportedFeature = { kind: "rasterised-visual", fallback: "rasterised", tag: "svg", reason: null, region: { x: 0, y: 0, w: 1, h: 1 }, elementType: "visual", domIndex: 4 };
const SHADOW: UnsupportedFeature = { kind: "box-shadow", fallback: "omitted", ringCount: 0, region: { x: 0.25, y: 0.5, w: 0.1, h: 0.2 }, elementType: "shape", domIndex: null };

test("each warning becomes a numbered mark with the converter's own sentence and a percentage box", () => {
  const marks = warningMarks([RASTER, SHADOW]);
  assert.deepEqual(
    marks.map((mark) => ({ number: mark.number, kind: mark.kind, omitted: mark.omitted, box: mark.box })),
    [
      { number: 1, kind: "rasterised-visual", omitted: false, box: { left: "0.000%", top: "0.000%", width: "100.000%", height: "100.000%" } },
      { number: 2, kind: "box-shadow", omitted: true, box: { left: "25.000%", top: "50.000%", width: "10.000%", height: "20.000%" } },
    ],
  );
  assert.equal(marks[1]?.sentence, describeUnsupportedFeature(SHADOW));
});

test("a region that leaves the slide is cut to it", () => {
  const offCanvas: UnsupportedFeature = { ...SHADOW, region: { x: 0.75, y: -0.2, w: 0.5, h: 0.4 } };
  assert.deepEqual(warningMarks([offCanvas])[0]?.region, { x: 0.75, y: 0, w: 0.25, h: 0.2 });
});

test("the summary counts warnings by kind, most frequent first", () => {
  assert.equal(warningSummary([]), "No warnings: everything converted to native Slides objects.");
  assert.equal(warningSummary([SHADOW, RASTER, SHADOW]), "3 warnings: 2 box-shadow, 1 rasterised-visual.");
  assert.equal(warningSummary([RASTER]), "1 warning: 1 rasterised-visual.");
});
