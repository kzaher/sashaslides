/**
 * Gradient fills through the .pptx export (import-pptx-supplement.ts), on a RECORDED
 * `presentations.get` answer: fixtures/gradient-presentation.json is basic fixture
 * slide_05_gradient_bg as Google holds it after the forward upload, where each of the three
 * gradient boxes arrives as `shapeBackgroundFill: {}`. Before the supplement the importer drew those
 * boxes with no fill and reported nothing, so the white labels on them vanished.
 *
 * The export archives are built here in Drive's own form (`Google Shape;<n>;p<k>` names, page-local
 * numbers that are NOT the API object ids), so matching has to go by structure, as it does on a
 * real export. Rows are parametric over the cause they claim: no export, an export whose page does
 * not line up, a flipped and moved twin, and names that do line up when the structure does not.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import JSZip from "jszip";
import type { ShapeElement } from "../engine/src/contracts/document.ts";
import type { Fill } from "../engine/src/contracts/style.ts";
import { readPptxSupplement, type PptxSupplement } from "./import-pptx-supplement.ts";
import { planImport, type ImportPlan } from "./import-presentation.ts";
import { parsePresentation, type SlidesPresentation } from "./slides-presentation.ts";

const RECORDED: unknown = JSON.parse(readFileSync(new URL("./fixtures/gradient-presentation.json", import.meta.url), "utf-8"));
const SEED = { sessionPrefix: "Gradient", counter: 0 } as const;

/** The slide's six elements in z order: each gradient box, then the white label over it. */
const GRADIENT_BOXES = [
  { objectId: "p5_i2", officeAngle: 2_700_000, stylesheetAngle: 135, from: "#1e88e5", to: "#8e24aa" },
  { objectId: "p5_i4", officeAngle: 0, stylesheetAngle: 90, from: "#43a047", to: "#00897b" },
  { objectId: "p5_i6", officeAngle: 5_400_000, stylesheetAngle: 180, from: "#fb8c00", to: "#e53935" },
] as const;
const LABEL_IDS = ["p5_i3", "p5_i5", "p5_i7"] as const;

describe("gradient fills from the .pptx export", () => {
  test("readPptxSupplement reads each box's stops and angle, matched by structure to the API ids", async () => {
    const supplement = await supplementOf(await driveExport({ slideXml: slideXml({ elements: exportedElements() }) }));
    assert.deepEqual(supplement.unmatchedSlides, []);
    for (const box of GRADIENT_BOXES) {
      const gradient = supplement.elements.get(box.objectId)?.gradient;
      assert.deepEqual(gradient, {
        kind: "linear",
        angleDegrees: box.officeAngle / 60_000,
        stops: [
          { offset: 0, fill: { colour: { kind: "literal", hexadecimal: box.from }, alpha: 1 } },
          { offset: 1, fill: { colour: { kind: "literal", hexadecimal: box.to }, alpha: 1 } },
        ],
      }, box.objectId);
    }
    for (const label of LABEL_IDS) assert.equal(supplement.elements.get(label)?.gradient, null, label);
  });

  test("an empty API fill with a matched export -> the engine gradient, stylesheet angle, and no loss", async () => {
    const plan = planOf({ supplement: await supplementOf(await driveExport({ slideXml: slideXml({ elements: exportedElements() }) })) });
    for (const box of GRADIENT_BOXES) {
      const expected: Fill = {
        kind: "linearGradient",
        angle: box.stylesheetAngle,
        stops: [
          { offset: 0, colour: { kind: "literal", hexadecimal: box.from, alpha: 1 } },
          { offset: 1, colour: { kind: "literal", hexadecimal: box.to, alpha: 1 } },
        ],
      };
      assert.deepEqual(shapeOf({ plan, elementId: box.objectId }).box.fill, expected, box.objectId);
    }
    assert.deepEqual(plan.losses.filter((loss) => loss.feature === "gradientFill"), []);
  });

  test("no gradient to take -> no fill AND a gradientFill loss per box, naming why", async () => {
    const extraElement = shapeXml({ number: 99, offsetX: 0, offsetY: 0, gradient: null });
    const rows: readonly Readonly<{ label: string; supplement: PptxSupplement | null; reason: string }>[] = [
      { label: "no export", supplement: null, reason: "could not be read" },
      { label: "export page with one more element", supplement: await supplementOf(await driveExport({ slideXml: slideXml({ elements: [...exportedElements(), extraElement] }) })), reason: "could not be matched" },
      { label: "export box with a solid fill", supplement: await supplementOf(await driveExport({ slideXml: slideXml({ elements: exportedElements({ gradients: false }) }) })), reason: "does not read" },
    ];
    for (const row of rows) {
      const plan = planOf({ supplement: row.supplement });
      for (const box of GRADIENT_BOXES) {
        assert.deepEqual(shapeOf({ plan, elementId: box.objectId }).box.fill, { kind: "none" }, `${row.label}: ${box.objectId}`);
        const losses = plan.losses.filter((loss) => loss.feature === "gradientFill" && loss.elementId === box.objectId);
        assert.equal(losses.length, 1, `${row.label}: ${box.objectId} loss`);
        assert.match(losses[0]?.detail ?? "", new RegExp(row.reason), row.label);
      }
      for (const label of LABEL_IDS) assert.equal(plan.losses.some((loss) => loss.elementId === label && loss.feature === "gradientFill"), false, `${row.label}: ${label}`);
    }
  });

  test("a flipped twin at another offset still matches: identity is structure, not position", async () => {
    const elements = exportedElements({ firstBoxXfrm: '<a:xfrm flipV="1" rot="10800000"><a:off x="7000000" y="100"/><a:ext cx="2000250" cy="1285875"/></a:xfrm>' });
    const supplement = await supplementOf(await driveExport({ slideXml: slideXml({ elements }) }));
    assert.equal(supplement.elements.get("p5_i2")?.gradient?.kind, "linear");
  });

  test("names that carry the API ids match when the structure does not line up", async () => {
    const named = exportedElements({ nameOf: (index) => `Google Shape;${["p5_i2", "p5_i3", "p5_i4", "p5_i5", "p5_i6", "p5_i7"][index]};p5` });
    const extraElement = shapeXml({ number: 99, offsetX: 0, offsetY: 0, gradient: null });
    const supplement = await supplementOf(await driveExport({ slideXml: slideXml({ elements: [...named, extraElement] }) }));
    for (const box of GRADIENT_BOXES) assert.equal(supplement.elements.get(box.objectId)?.gradient?.kind, "linear", box.objectId);
  });

  test("a radial path gradient with alpha stops -> centre from fillToRect, stop alphas kept", async () => {
    const radial =
      '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="6366F1"><a:alpha val="14902"/></a:srgbClr></a:gs><a:gs pos="70000"><a:schemeClr val="accent2"><a:alpha val="0"/></a:schemeClr></a:gs></a:gsLst>' +
      '<a:path path="circle"><a:fillToRect b="50%" l="20%" r="80%" t="50%"/></a:path><a:tileRect/></a:gradFill>';
    const elements = exportedElements({ firstBoxGradient: radial });
    const supplement = await supplementOf(await driveExport({ slideXml: slideXml({ elements }) }));
    assert.deepEqual(supplement.elements.get("p5_i2")?.gradient, {
      kind: "radial",
      centreX: 0.2,
      centreY: 0.5,
      stops: [
        { offset: 0, fill: { colour: { kind: "literal", hexadecimal: "#6366f1" }, alpha: 0.14902 } },
        { offset: 0.7, fill: { colour: { kind: "theme", type: "ACCENT2" }, alpha: 0 } },
      ],
    });
  });

  test("stored and deflated archives read the same; a broken archive is unreadable, not thrown", async () => {
    const xml = slideXml({ elements: exportedElements() });
    for (const compression of ["STORE", "DEFLATE"] as const) {
      const supplement = await supplementOf(await driveExport({ slideXml: xml, compression }));
      assert.equal(supplement.elements.get("p5_i4")?.gradient?.kind, "linear", compression);
    }
    const broken = (await driveExport({ slideXml: xml })).slice(0, 200);
    assert.equal(readPptxSupplement({ archive: broken, presentation: presentationOf() }).kind, "unreadable");
  });
});

function presentationOf(): SlidesPresentation {
  const result = parsePresentation(RECORDED);
  if (result.kind !== "ok") throw new Error(result.message);
  return result.presentation;
}

function planOf(options: Readonly<{ supplement: PptxSupplement | null }>): ImportPlan {
  return planImport({ presentation: presentationOf(), images: new Map(), idSeed: SEED, pptxSupplement: options.supplement });
}

async function supplementOf(archive: Uint8Array): Promise<PptxSupplement> {
  const outcome = readPptxSupplement({ archive, presentation: presentationOf() });
  if (outcome.kind !== "read") throw new Error(outcome.message);
  return outcome.supplement;
}

function shapeOf(options: Readonly<{ plan: ImportPlan; elementId: string }>): ShapeElement {
  const element = options.plan.slides[0]?.elements.find((candidate) => candidate.id === options.elementId);
  if (element?.kind !== "shape") throw new Error(`no shape ${options.elementId}`);
  return element;
}

/** The slide's six elements as Drive writes them; options change one thing each. */
function exportedElements(
  options: Readonly<{ gradients?: boolean; firstBoxXfrm?: string; firstBoxGradient?: string; nameOf?: (index: number) => string }> = {},
): readonly string[] {
  return [0, 1, 2].flatMap((box) => {
    const definition = GRADIENT_BOXES[box];
    if (definition === undefined) throw new Error(`box ${box}`);
    const offsetX = 1_143_000 + box * 2_428_875;
    const gradient =
      options.gradients === false
        ? null
        : box === 0 && options.firstBoxGradient !== undefined
          ? options.firstBoxGradient
          : `<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="${definition.from.slice(1).toUpperCase()}"/></a:gs><a:gs pos="100000"><a:srgbClr val="${definition.to.slice(1).toUpperCase()}"/></a:gs></a:gsLst><a:lin ang="${definition.officeAngle}" scaled="0"/></a:gradFill>`;
    const name = (index: number): string => options.nameOf?.(index) ?? `Google Shape;${70 + index};p7`;
    return [
      shapeXml({ number: 70 + box * 2, name: name(box * 2), offsetX, offsetY: 1_928_813, gradient, xfrm: box === 0 ? options.firstBoxXfrm : undefined }),
      shapeXml({ number: 71 + box * 2, name: name(box * 2 + 1), offsetX, offsetY: 1_928_813, gradient: null }),
    ];
  });
}

function shapeXml(options: Readonly<{ number: number; name?: string | undefined; offsetX: number; offsetY: number; gradient: string | null; xfrm?: string | undefined }>): string {
  const xfrm = options.xfrm ?? `<a:xfrm><a:off x="${options.offsetX}" y="${options.offsetY}"/><a:ext cx="2000250" cy="1285875"/></a:xfrm>`;
  const fill = options.gradient ?? '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill>';
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${options.number}" name="${options.name ?? `Google Shape;${options.number};p7`}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr>${xfrm}<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 4444"/></a:avLst></a:prstGeom>${fill}<a:ln><a:noFill/></a:ln></p:spPr>` +
    '<p:txBody><a:bodyPr anchor="ctr" bIns="0" lIns="0" rIns="0" tIns="0" wrap="square"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:t>label &amp; text</a:t></a:r></a:p></p:txBody></p:sp>'
  );
}

function slideXml(options: Readonly<{ elements: readonly string[] }>): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="69" name="Shape 69"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    options.elements.join("") +
    "</p:spTree></p:cSld></p:sld>"
  );
}

/** A .pptx holding only what the supplement reads: presentation.xml, its relationships and the slide. */
async function driveExport(options: Readonly<{ slideXml: string; compression?: "STORE" | "DEFLATE" }>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "ppt/presentation.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId9"/></p:sldIdLst></p:presentation>',
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide7.xml"/></Relationships>',
  );
  zip.file("ppt/slides/slide7.xml", options.slideXml);
  return zip.generateAsync({ type: "uint8array", compression: options.compression ?? "DEFLATE" });
}
