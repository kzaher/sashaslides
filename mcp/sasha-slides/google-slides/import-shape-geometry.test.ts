/**
 * ROUNDED CORNERS AND CUSTOM OUTLINES ON IMPORT (import-shape-geometry.ts), against the recorded
 * `presentations.get` answer in fixtures/presentation.json.
 *
 * The programming interface never reports a shape's adjustment, so the rows that need one pass it the
 * way the pptx export carries it (`<a:gd name="adj" fmla="val 7000"/>`), and the control rows pass
 * none. The two- and one-corner presets and the custom outline cannot be drawn through the programming
 * interface, so those rows are DERIVED from the recorded rounded rectangle by changing its shape type
 * alone (or deleting it, which is how Google answers for a pptx custom outline: measured on the
 * html2slides complex fixtures, whose four funnel trapezoids come back with no `shapeType`).
 *
 * The custom outlines are read from a RECORDED pair: fixtures/funnel-presentation.json is complex
 * fixture slide_13 (the funnel) as `presentations.get` answers it after the forward upload, and
 * fixtures/funnel-slide.xml is the same slide from Drive's .pptx export, verbatim. Before outlines
 * were read the four trapezoids were imported as rectangles, which is what the reverse round trip
 * showed (complex slide 13 at 1.044% reverse mismatch).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import JSZip from "jszip";
import type { CustomOutline, ShapeElement } from "../engine/src/contracts/document.ts";
import { planImport, type ImportPlan } from "./import-presentation.ts";
import { readPptxSupplement, type PptxSupplement } from "./import-pptx-supplement.ts";
import { customOutlineOf, presetGeometryOf, roundedShapeOf, type ShapeAdjustments } from "./import-shape-geometry.ts";
import { parseXml } from "./pptx-archive.ts";
import { parsePresentation, type SlidesPresentation } from "./slides-presentation.ts";

const RECORDED: unknown = JSON.parse(readFileSync(new URL("./fixtures/presentation.json", import.meta.url), "utf-8"));
const SEED = { sessionPrefix: "Ge0metry", counter: 0 } as const;
const SLIDE = "shapes_slide";
const ELEMENT = "shape_round_rectangle";
/** The recorded rounded rectangle is 0.254 x 0.1905 of 3000000 EMU: 106.667 by 80 units, so 80 is its shorter side. */
const SHORTER_SIDE = 80;

type Writable = Record<string, unknown>;

describe("rounded corners from the pptx adjustment (import-shape-geometry.ts)", () => {
  test("ROUND_RECTANGLE: the adjustment sizes the corner; without one, the preset's default sixth", () => {
    // Columns: label, adjustments passed (null = none), expected uniform radius in units.
    const rows: readonly Readonly<{ label: string; adjustments: ShapeAdjustments | null; radius: number }>[] = [
      { label: "no adjustment (control)", adjustments: null, radius: round((SHORTER_SIDE * 16_667) / 100_000) },
      { label: "adj 7000, a small card corner", adjustments: new Map([["adj", 7_000]]), radius: round((SHORTER_SIDE * 7_000) / 100_000) },
      { label: "adj 50000, a pill", adjustments: new Map([["adj", 50_000]]), radius: SHORTER_SIDE / 2 },
      { label: "adj 80000 is pinned to 50000", adjustments: new Map([["adj", 80_000]]), radius: SHORTER_SIDE / 2 },
      { label: "an unrelated guide leaves the default", adjustments: new Map([["adj2", 4_000]]), radius: round((SHORTER_SIDE * 16_667) / 100_000) },
    ];
    for (const row of rows) {
      const shape = importedShape({ adjustments: row.adjustments, change: null });
      assert.equal(shape.preset, "roundedRectangle", row.label);
      assert.deepEqual(shape.box.cornerRadius, { kind: "uniform", radius: row.radius }, row.label);
    }
  });

  test("ROUND_RECTANGLE with adj 0 is the square rectangle it looks like (the engine draws a zero-radius rounded rectangle at a sixth)", () => {
    const shape = importedShape({ adjustments: new Map([["adj", 0]]), change: null });
    assert.equal(shape.preset, "rectangle");
    assert.deepEqual(shape.box.cornerRadius, { kind: "uniform", radius: 0 });
  });

  test("the one- and two-corner presets become per-corner radii on a rounded rectangle, with no preset loss", () => {
    const top = round((SHORTER_SIDE * 10_714) / 100_000);
    const sixth = round((SHORTER_SIDE * 16_667) / 100_000);
    // Columns: shape type, adjustments, expected corners (top left, top right, bottom right, bottom left).
    const rows: readonly Readonly<{ shapeType: string; adjustments: ShapeAdjustments | null; corners: readonly [number, number, number, number] }>[] = [
      { shapeType: "ROUND_2_SAME_RECTANGLE", adjustments: new Map([["adj1", 10_714], ["adj2", 0]]), corners: [top, top, 0, 0] },
      { shapeType: "ROUND_2_SAME_RECTANGLE", adjustments: null, corners: [sixth, sixth, 0, 0] },
      { shapeType: "ROUND_2_SAME_RECTANGLE", adjustments: new Map([["adj1", 0], ["adj2", 10_714]]), corners: [0, 0, top, top] },
      { shapeType: "ROUND_1_RECTANGLE", adjustments: null, corners: [0, sixth, 0, 0] },
      { shapeType: "ROUND_2_DIAGONAL_RECTANGLE", adjustments: new Map([["adj1", 10_714], ["adj2", 0]]), corners: [top, 0, top, 0] },
    ];
    for (const row of rows) {
      const label = `${row.shapeType} ${JSON.stringify([...(row.adjustments ?? new Map()).entries()])}`;
      const plan = planWith({ adjustments: row.adjustments, change: (shape) => (shape["shapeType"] = row.shapeType) });
      const shape = shapeIn(plan);
      assert.equal(shape.preset, "roundedRectangle", label);
      const [topLeft, topRight, bottomRight, bottomLeft] = row.corners;
      assert.deepEqual(shape.box.cornerRadius, { kind: "perCorner", topLeft, topRight, bottomRight, bottomLeft }, label);
      assert.equal(plan.losses.some((loss) => loss.elementId === ELEMENT && loss.feature === "shapePreset"), false, `${label} loss`);
    }
  });

  test("a shape with no shapeType (a pptx custom outline) is a rectangle AND a reported loss, never a silent text box", () => {
    const plan = planWith({ adjustments: null, change: (shape) => delete shape["shapeType"] });
    const shape = shapeIn(plan);
    assert.equal(shape.preset, "rectangle");
    assert.equal(shape.textBox.autofit, "none", "a custom outline does not grow with its text the way a text box does");
    const loss = plan.losses.find((candidate) => candidate.elementId === ELEMENT && candidate.feature === "customShape");
    assert.ok(loss !== undefined, "the custom outline is reported");
    assert.match(loss.detail, /rectangle/);
  });

  test("roundedShapeOf ignores every other shape type", () => {
    assert.equal(roundedShapeOf({ shapeType: "RECTANGLE", width: 100, height: 50, adjustments: null }), null);
    assert.equal(roundedShapeOf({ shapeType: "ELLIPSE", width: 100, height: 50, adjustments: new Map([["adj", 7_000]]) }), null);
  });
});

describe("presetGeometryOf: the adjustments of one pptx <p:spPr>", () => {
  test("the Google pptx export's spellings (fmla before name, several guides, none, custom outline)", () => {
    // Copied from a Google Slides pptx export of the html2slides complex fixtures.
    const rows: readonly Readonly<{ label: string; xml: string; expected: Readonly<{ preset: string; adjustments: readonly (readonly [string, number])[] }> | null }>[] = [
      {
        label: "roundRect adj",
        xml: '<a:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></a:xfrm><a:prstGeom prst="roundRect"><a:avLst><a:gd fmla="val 7000" name="adj"/></a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>',
        expected: { preset: "roundRect", adjustments: [["adj", 7_000]] },
      },
      {
        label: "round2SameRect adj1 adj2",
        xml: '<a:prstGeom prst="round2SameRect"><a:avLst><a:gd fmla="val 10714" name="adj1"/><a:gd fmla="val 0" name="adj2"/></a:avLst></a:prstGeom>',
        expected: { preset: "round2SameRect", adjustments: [["adj1", 10_714], ["adj2", 0]] },
      },
      { label: "name before fmla", xml: '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 4000"/></a:avLst></a:prstGeom>', expected: { preset: "roundRect", adjustments: [["adj", 4_000]] } },
      { label: "empty avLst", xml: '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', expected: { preset: "rect", adjustments: [] } },
      { label: "a formula that is not a plain value", xml: '<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="*/ 1 2 3"/></a:avLst></a:prstGeom>', expected: { preset: "roundRect", adjustments: [] } },
      {
        label: "custom outline",
        xml: '<a:custGeom><a:rect b="b" l="l" r="r" t="t"/><a:pathLst><a:path extrusionOk="0" h="314325" w="6429375"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:close/></a:path></a:pathLst></a:custGeom>',
        expected: null,
      },
    ];
    for (const row of rows) {
      const geometry = presetGeometryOf(row.xml);
      assert.deepEqual(geometry === null ? null : { preset: geometry.preset, adjustments: [...geometry.adjustments.entries()] }, row.expected, row.label);
    }
  });
});

describe("custom outlines from the pptx export (customOutlineOf)", () => {
  test("the recorded funnel: each trapezoid is its exported path as fractions of its box, and no customShape loss", async () => {
    const supplement = await funnelSupplement();
    // Columns: object id, the exported path's w, then its four points in path units (copied from fixtures/funnel-slide.xml).
    const rows: readonly Readonly<{ objectId: string; width: number; points: readonly (readonly [number, number])[] }>[] = [
      { objectId: "p13_i12", width: 6_429_375, points: [[0, 0], [6_429_375, 0], [6_107_906, 314_325], [321_469, 314_325]] },
      { objectId: "p13_i20", width: 5_286_375, points: [[158_591, 0], [5_127_784, 0], [4_916_329, 314_325], [370_046, 314_325]] },
    ];
    const plan = planImport({ presentation: funnelPresentation(), images: new Map(), idSeed: SEED, pptxSupplement: supplement });
    for (const row of rows) {
      const [first, ...rest] = row.points.map(([x, y]) => ({ x: round6(x / row.width), y: round6(y / 314_325) }));
      if (first === undefined) throw new Error("no points");
      const expected: CustomOutline = {
        paths: [{ commands: [{ kind: "move", to: first }, ...rest.map((to) => ({ kind: "line" as const, to })), { kind: "close" }], filled: true, stroked: true }],
      };
      assert.deepEqual(supplement.elements.get(row.objectId)?.customOutline, expected, `${row.objectId} supplement`);
      const shape = funnelShape({ plan, objectId: row.objectId });
      assert.deepEqual(shape.customOutline, expected, `${row.objectId} imported`);
      assert.equal(shape.preset, "rectangle", `${row.objectId} keeps the rectangle as its fallback preset`);
    }
    for (const objectId of FUNNEL_TRAPEZOIDS) assert.notEqual(funnelShape({ plan, objectId }).customOutline, null, objectId);
    assert.deepEqual(plan.losses.filter((loss) => loss.feature === "customShape"), [], "every funnel outline was read");
  });

  test("without the export the trapezoids are rectangles and four customShape losses, never silent", () => {
    const plan = planImport({ presentation: funnelPresentation(), images: new Map(), idSeed: SEED, pptxSupplement: null });
    for (const objectId of FUNNEL_TRAPEZOIDS) assert.equal(funnelShape({ plan, objectId }).customOutline, null, objectId);
    assert.deepEqual(plan.losses.filter((loss) => loss.feature === "customShape").map((loss) => loss.elementId), [...FUNNEL_TRAPEZOIDS]);
  });

  test("every path command, the fill and stroke flags, a path with no size, and unreadable guides", () => {
    const extent = { width: 2_000, height: 1_000 };
    // A quarter of a circle of radius 1000 from (0, 1000), clockwise from 180 degrees: it ends at (1000, 0).
    const handle = (4 / 3) * Math.tan(Math.PI / 8);
    const rows: readonly Readonly<{ label: string; xml: string; expected: CustomOutline | null }>[] = [
      {
        label: "quadratic and cubic in a sized path; fill none, stroke 0",
        xml: `<a:custGeom><a:pathLst><a:path w="100" h="50" fill="none" stroke="0"><a:moveTo><a:pt x="0" y="50"/></a:moveTo><a:quadBezTo><a:pt x="50" y="0"/><a:pt x="100" y="50"/></a:quadBezTo><a:cubicBezTo><a:pt x="75" y="50"/><a:pt x="25" y="25"/><a:pt x="0" y="50"/></a:cubicBezTo></a:path></a:pathLst></a:custGeom>`,
        expected: {
          paths: [
            {
              commands: [
                { kind: "move", to: { x: 0, y: 1 } },
                { kind: "quadratic", control: { x: 0.5, y: 0 }, to: { x: 1, y: 1 } },
                { kind: "cubic", firstControl: { x: 0.75, y: 1 }, secondControl: { x: 0.25, y: 0.5 }, to: { x: 0, y: 1 } },
              ],
              filled: false,
              stroked: false,
            },
          ],
        },
      },
      {
        label: "a path with no w and h is in the shape's extent; arcTo becomes one cubic per quarter turn",
        xml: `<a:custGeom><a:pathLst><a:path><a:moveTo><a:pt x="0" y="1000"/></a:moveTo><a:arcTo wR="1000" hR="1000" stAng="10800000" swAng="5400000"/><a:close/></a:path></a:pathLst></a:custGeom>`,
        expected: {
          paths: [
            {
              commands: [
                { kind: "move", to: { x: 0, y: 1 } },
                { kind: "cubic", firstControl: { x: 0, y: round6(1 - handle) }, secondControl: { x: round6((1 - handle) / 2), y: 0 }, to: { x: 0.5, y: 0 } },
                { kind: "close" },
              ],
              filled: true,
              stroked: true,
            },
          ],
        },
      },
      { label: "a point given by a guide name", xml: `<a:custGeom><a:pathLst><a:path w="10" h="10"><a:moveTo><a:pt x="l" y="0"/></a:moveTo></a:path></a:pathLst></a:custGeom>`, expected: null },
      { label: "no path at all", xml: "<a:custGeom><a:pathLst/></a:custGeom>", expected: null },
    ];
    for (const row of rows) {
      assert.deepEqual(customOutlineOf({ geometry: parseXml(row.xml), extent }), row.expected, row.label);
    }
  });
});

/** The funnel's four trapezoids, top to bottom. */
const FUNNEL_TRAPEZOIDS = ["p13_i12", "p13_i20", "p13_i28", "p13_i36"] as const;

function funnelPresentation(): SlidesPresentation {
  const parsed = parsePresentation(JSON.parse(readFileSync(new URL("./fixtures/funnel-presentation.json", import.meta.url), "utf-8")));
  if (parsed.kind !== "ok") throw new Error(parsed.message);
  return parsed.presentation;
}

/** The recorded export slide in a one-slide archive: presentation.xml, its relationships and the slide. */
async function funnelSupplement(): Promise<PptxSupplement> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="268" r:id="rId4"/></p:sldIdLst></p:presentation>',
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide13.xml"/></Relationships>',
  );
  zip.file("ppt/slides/slide13.xml", readFileSync(new URL("./fixtures/funnel-slide.xml", import.meta.url), "utf-8"));
  const outcome = readPptxSupplement({ archive: await zip.generateAsync({ type: "uint8array" }), presentation: funnelPresentation() });
  if (outcome.kind !== "read") throw new Error(outcome.message);
  assert.deepEqual(outcome.supplement.unmatchedSlides, [], "the recorded export lines up with the recorded answer");
  return outcome.supplement;
}

function funnelShape(options: Readonly<{ plan: ImportPlan; objectId: string }>): ShapeElement {
  const element = options.plan.slides[0]?.elements.find((candidate) => candidate.id === options.objectId);
  if (element?.kind !== "shape") throw new Error(`no shape ${options.objectId}`);
  return element;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function planWith(options: Readonly<{ adjustments: ShapeAdjustments | null; change: ((shape: Writable) => void) | null }>): ImportPlan {
  const copy = JSON.parse(JSON.stringify(RECORDED)) as Writable;
  const slide = (copy["slides"] as Writable[]).find((candidate) => candidate["objectId"] === SLIDE);
  const element = (slide?.["pageElements"] as Writable[] | undefined)?.find((candidate) => candidate["objectId"] === ELEMENT);
  if (element === undefined) throw new Error(`no ${ELEMENT}`);
  options.change?.(element["shape"] as Writable);
  const parsed = parsePresentation(copy);
  if (parsed.kind !== "ok") throw new Error(parsed.message);
  const shapeAdjustments = new Map<string, ShapeAdjustments>(options.adjustments === null ? [] : [[ELEMENT, options.adjustments]]);
  return planImport({ presentation: parsed.presentation, images: new Map(), idSeed: SEED, pptxSupplement: null, shapeAdjustments });
}

function importedShape(options: Readonly<{ adjustments: ShapeAdjustments | null; change: ((shape: Writable) => void) | null }>): ShapeElement {
  return shapeIn(planWith(options));
}

function shapeIn(plan: ImportPlan): ShapeElement {
  const element = plan.slides.find((slide) => slide.id === SLIDE)?.elements.find((candidate) => candidate.id === ELEMENT);
  if (element?.kind !== "shape") throw new Error(`${ELEMENT} is not a shape`);
  return element;
}

/** The importer's rounding (import-text.ts roundUnits): three decimals. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
