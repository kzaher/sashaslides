#!/usr/bin/env npx tsx
/**
 * emit-requests.test.ts — unit tests for the pure emission stage.
 *
 * Run: npx tsx mcp/sasha-slides/converter/test/emit-requests.test.ts
 *
 * No browser: every case feeds a raw object shaped exactly like one
 * `extract-dom.ts` element through `parseExtraction` and then
 * `emitSlideRequests`, so the boundary parser is exercised on the same path as
 * the emitter. Geometry is asserted in EMU against the 7143.75 EMU/px that a
 * 1280x720 document maps onto Google's 10in x 5.625in page at.
 */
import {
  afterNextFrame,
  DEFAULT_PAGE_SIZE_EMU,
  DEFAULT_TEXT_INSET_EMU,
  EMU_PER_POINT,
  emitSlideRequests,
  parseExtraction,
  pageScaleFor,
  predictGoogleRowHeightPx,
  pxToPoints,
  specForColumnWidthPx,
  describeUnsupportedFeature,
} from "../index.js";
import {
  SLIDES_MAX_IMAGE_BYTES,
  STAGED_IMAGE_FIELD,
  STAGED_IMAGE_URL,
  slideImageSourceFor,
  stagedImageOf,
  stagedImageUrl,
} from "../index.js";
import type { SlidesApiRequest, UnsupportedFeature } from "../index.js";
import { kindOf, requestsOfKind, startTestRun } from "./assert.js";

const test = startTestRun("emit-requests");

/** 9144000 EMU / 1280 px. */
const EMU_PER_PX = 7143.75;

type RawElement = Readonly<Record<string, unknown>>;

function convert(elements: readonly RawElement[]): Readonly<{
  requests: readonly SlidesApiRequest[];
  unsupported: readonly UnsupportedFeature[];
}> {
  const extraction = parseExtraction({
    viewport: { w: 1280, h: 720 },
    elementCount: elements.length,
    elements,
  });
  return emitSlideRequests({
    extraction,
    pageObjectId: "p1",
    objectIdPrefix: "p_1733219000000_a1b2c3",
  });
}

function asRecords(requests: readonly SlidesApiRequest[]): readonly Readonly<Record<string, unknown>>[] {
  // SAFETY: SlidesApiRequest is a union of single-key plain object literals, so
  // every value is already a string-keyed record; this widens, never converts.
  return requests as readonly Readonly<Record<string, unknown>>[];
}

function kinds(requests: readonly SlidesApiRequest[]): readonly string[] {
  return asRecords(requests).map(kindOf);
}

function reportedKinds(unsupported: readonly UnsupportedFeature[]): readonly string[] {
  return unsupported.map((feature) => feature.kind);
}

/* ------------------------------------------------- 1. rectangles and fills */

{
  const { requests, unsupported } = convert([
    { type: "rect", bounds: { x: 100, y: 50, w: 200, h: 100 }, fill: "#1e88e5", fillAlpha: 1 },
  ]);
  test.equal("solid rect emits createShape + updateShapeProperties", kinds(requests), [
    "createShape",
    "updateShapeProperties",
  ]);

  const [shape] = requestsOfKind(asRecords(requests), "createShape");
  test.equal("solid rect is a RECTANGLE", shape?.["shapeType"], "RECTANGLE");

  const elementProperties = shape?.["elementProperties"] as
    | Readonly<{ size: { width: { magnitude: number }; height: { magnitude: number } }; transform: { translateX: number; translateY: number }; pageObjectId: string }>
    | undefined;
  test.equal("rect lands on the requested page", elementProperties?.pageObjectId, "p1");
  test.near("rect x -> EMU", elementProperties?.transform.translateX ?? -1, 100 * EMU_PER_PX, 1);
  test.near("rect y -> EMU", elementProperties?.transform.translateY ?? -1, 50 * EMU_PER_PX, 1);
  test.near("rect w -> EMU", elementProperties?.size.width.magnitude ?? -1, 200 * EMU_PER_PX, 1);
  test.near("rect h -> EMU", elementProperties?.size.height.magnitude ?? -1, 100 * EMU_PER_PX, 1);

  const [properties] = requestsOfKind(asRecords(requests), "updateShapeProperties");
  const fill = properties?.["shapeProperties"] as
    | Readonly<{ shapeBackgroundFill: { solidFill: { color: { rgbColor: { red: number; green: number; blue: number } } } }; outline: { propertyState?: string } }>
    | undefined;
  test.near("fill red channel", fill?.shapeBackgroundFill.solidFill.color.rgbColor.red ?? -1, 0x1e / 255, 0.002);
  test.near("fill green channel", fill?.shapeBackgroundFill.solidFill.color.rgbColor.green ?? -1, 0x88 / 255, 0.002);
  test.near("fill blue channel", fill?.shapeBackgroundFill.solidFill.color.rgbColor.blue ?? -1, 0xe5 / 255, 0.002);
  test.equal("borderless fill suppresses the theme outline", fill?.outline.propertyState, "NOT_RENDERED");
  test.equal("solid rect reports nothing unsupported", reportedKinds(unsupported), []);
}

{
  // An invisible box must not become a selectable shape on the slide.
  const { requests } = convert([{ type: "rect", bounds: { x: 0, y: 0, w: 100, h: 100 } }]);
  test.equal("rect with no fill and no border emits nothing", kinds(requests), []);
}

{
  const { requests, unsupported } = convert([
    {
      type: "rect",
      bounds: { x: 10, y: 10, w: 200, h: 100 },
      fill: "#ffffff",
      cornerRadii: { tl: 12, tr: 12, br: 12, bl: 12 },
    },
  ]);
  const [shape] = requestsOfKind(asRecords(requests), "createShape");
  test.equal("rounded rect is a ROUND_RECTANGLE", shape?.["shapeType"], "ROUND_RECTANGLE");
  test.equal("rounded rect reports the radius loss", reportedKinds(unsupported), [
    "corner-radius-approximated",
  ]);
}

{
  // A circle IS reproducible, so it must not generate a false anomaly.
  const { requests, unsupported } = convert([
    {
      type: "rect",
      bounds: { x: 0, y: 0, w: 120, h: 120 },
      fill: "#43a047",
      cornerRadii: { tl: 60, tr: 60, br: 60, bl: 60 },
    },
  ]);
  const [shape] = requestsOfKind(asRecords(requests), "createShape");
  test.equal("50% radius on a square becomes an ELLIPSE", shape?.["shapeType"], "ELLIPSE");
  test.equal("an ellipse reports no radius anomaly", reportedKinds(unsupported), []);
}

{
  const { requests, unsupported } = convert([
    {
      type: "rect",
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      gradient: {
        type: "linear",
        angle: 180,
        stops: [
          { color: "#000000", position: 0 },
          { color: "#ffffff", position: 1 },
        ],
      },
    },
  ]);
  const [properties] = requestsOfKind(asRecords(requests), "updateShapeProperties");
  const fill = properties?.["shapeProperties"] as
    | Readonly<{ shapeBackgroundFill: { solidFill: { color: { rgbColor: { red: number } } } } }>
    | undefined;
  test.near("two-stop gradient flattens to the midpoint", fill?.shapeBackgroundFill.solidFill.color.rgbColor.red ?? -1, 0.5, 0.01);
  test.equal("gradient is reported", reportedKinds(unsupported), ["gradient-fill"]);
  const [report] = unsupported;
  test.check(
    "gradient report names the flattened colour",
    report !== undefined && report.kind === "gradient-fill" && report.approximatedAs.startsWith("#"),
    JSON.stringify(report),
  );
}

{
  // A gradient that sits at one colour for most of its run must flatten to
  // that colour, not to the midpoint of its endpoints.
  const { unsupported } = convert([
    {
      type: "rect",
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      gradient: {
        type: "linear",
        angle: 90,
        stops: [
          { color: "#000000", position: 0 },
          { color: "#000000", position: 0.9 },
          { color: "#ffffff", position: 1 },
        ],
      },
    },
  ]);
  const [report] = unsupported;
  test.check(
    "span-weighted flattening favours the dominant stop",
    report !== undefined && report.kind === "gradient-fill" && report.approximatedAs < "#404040",
    report !== undefined && report.kind === "gradient-fill" ? report.approximatedAs : "<missing>",
  );
}

{
  const { unsupported } = convert([
    {
      type: "rect",
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      fill: "#ffffff",
      boxShadow: { offsetX: 0, offsetY: 4, blur: 12, spread: 0, color: "#000000", alpha: 0.2 },
      style: { shadowRings: [{ spread: 4, blur: 0, color: "#eeeeee", alpha: 1 }] },
    },
  ]);
  test.equal("box-shadow is reported", reportedKinds(unsupported), ["box-shadow"]);
  const [report] = unsupported;
  test.check(
    "shadow report counts the halo rings",
    report !== undefined && report.kind === "box-shadow" && report.ringCount === 1,
    JSON.stringify(report),
  );
}

/* --------------------------------------------------- 2. per-side borders */

{
  const { requests, unsupported } = convert([
    {
      type: "rect",
      bounds: { x: 0, y: 0, w: 200, h: 100 },
      fill: "#ffffff",
      borderWidth: 3,
      borderColor: "#e53935",
      borderUniform: false,
      borderSides: {
        top: { width: 3, color: "#e53935", style: "solid" },
        right: { width: 0, color: null, style: "none" },
        bottom: { width: 1, color: "#1e88e5", style: "dashed" },
        left: { width: 0, color: null, style: "none" },
      },
    },
  ]);
  test.equal("non-uniform border becomes shape + two edge lines", kinds(requests), [
    "createShape",
    "updateShapeProperties",
    "createLine",
    "updateLineProperties",
    "createLine",
    "updateLineProperties",
  ]);
  const [properties] = requestsOfKind(asRecords(requests), "updateShapeProperties");
  const shapeProperties = properties?.["shapeProperties"] as
    | Readonly<{ outline?: { weight?: unknown; propertyState?: string } }>
    | undefined;
  test.check(
    "the shape itself carries no uniform outline",
    shapeProperties?.outline?.weight === undefined,
    JSON.stringify(shapeProperties?.outline),
  );
  test.equal("non-uniform border is reported", reportedKinds(unsupported), ["non-uniform-border"]);
  const [report] = unsupported;
  test.equal(
    "report names only the painted sides",
    report !== undefined && report.kind === "non-uniform-border" ? report.sides : [],
    ["top", "bottom"],
  );

  const lines = requestsOfKind(asRecords(requests), "updateLineProperties");
  const dashStyles = lines.map((line) => (line["lineProperties"] as Readonly<{ dashStyle: string }>).dashStyle);
  test.equal("CSS dashed maps to DASH", dashStyles, ["SOLID", "DASH"]);
}

{
  const { requests, unsupported } = convert([
    {
      type: "rect",
      bounds: { x: 0, y: 0, w: 200, h: 100 },
      fill: "#ffffff",
      borderWidth: 2,
      borderColor: "#1e88e5",
      borderStyle: "solid",
      borderUniform: true,
    },
  ]);
  test.equal("uniform border stays a single outline", kinds(requests), [
    "createShape",
    "updateShapeProperties",
  ]);
  const [properties] = requestsOfKind(asRecords(requests), "updateShapeProperties");
  const outline = (properties?.["shapeProperties"] as Readonly<{ outline: { weight: { magnitude: number } } }>).outline;
  test.near("2px border -> 19050 EMU", outline.weight.magnitude, 2 * 9525, 1);
  test.equal("uniform border reports nothing", reportedKinds(unsupported), []);
}

/* ------------------------------------------------------------- 3. text */

{
  const { requests, unsupported } = convert([
    {
      type: "text",
      bounds: { x: 120, y: 80, w: 400, h: 60 },
      text: "Bold 48px",
      style: {
        fontFamily: "Arial, sans-serif",
        fontSize: 48,
        fontWeight: "bold",
        color: "#333333",
        textAlign: "left",
        lineHeight: 57.6,
      },
    },
  ]);
  test.equal("text emits box, properties, insert, then styling", kinds(requests), [
    "createShape",
    "updateShapeProperties",
    "insertText",
    "updateTextStyle",
    "updateParagraphStyle",
  ]);

  const [shape] = requestsOfKind(asRecords(requests), "createShape");
  test.equal("text uses a TEXT_BOX", shape?.["shapeType"], "TEXT_BOX");
  const transform = (shape?.["elementProperties"] as Readonly<{ transform: { translateX: number; translateY: number } }>).transform;
  // The box is outset by the uncontrollable Slides text insets so the GLYPHS
  // land on the HTML box. Asserted against the constant rather than a literal:
  // the numbers came from a live calibration run (calibration/
  // measure-text-inset.ts) and re-measuring may move them again, which must not
  // need an edit here.
  test.near(
    "text box is outset by the left inset",
    transform.translateX,
    120 * EMU_PER_PX - DEFAULT_TEXT_INSET_EMU.left,
    2,
  );
  test.near(
    "text box is outset by the top inset",
    transform.translateY,
    80 * EMU_PER_PX - DEFAULT_TEXT_INSET_EMU.top,
    2,
  );

  const [properties] = requestsOfKind(asRecords(requests), "updateShapeProperties");
  const shapeProperties = properties?.["shapeProperties"] as
    | Readonly<{ autofit: { autofitType: string }; contentAlignment: string }>
    | undefined;
  test.equal("autofit is disabled so font sizes survive", shapeProperties?.autofit.autofitType, "NONE");
  test.equal("non-centred text aligns to the top", shapeProperties?.contentAlignment, "TOP");

  const [insert] = requestsOfKind(asRecords(requests), "insertText");
  test.equal("text content is inserted at 0", insert?.["text"], "Bold 48px");
  test.equal("insertion index is 0", insert?.["insertionIndex"], 0);

  const [textStyle] = requestsOfKind(asRecords(requests), "updateTextStyle");
  const style = textStyle?.["style"] as
    | Readonly<{ fontFamily: string; fontSize: { magnitude: number; unit: string }; bold: boolean }>
    | undefined;
  test.equal("sans-serif resolves to Arial", style?.fontFamily, "Arial");
  // 48 CSS px on a 1280px document that maps onto a 10in page is 48 x 0.5625 = 27pt.
  test.near("48px -> 27pt", style?.fontSize.magnitude ?? -1, 27, 0.01);
  test.equal("font size is in points", style?.fontSize.unit, "PT");
  test.equal("bold survives", style?.bold, true);
  test.equal("whole-range style uses ALL", (textStyle?.["textRange"] as Readonly<{ type: string }>).type, "ALL");

  const [paragraph] = requestsOfKind(asRecords(requests), "updateParagraphStyle");
  const paragraphStyle = paragraph?.["style"] as Readonly<{ alignment: string; lineSpacing: number }> | undefined;
  test.equal("left aligns to START", paragraphStyle?.alignment, "START");
  // 57.6px pitch on a 48px font is 1.2x CSS, and Slides' own normal line box
  // is the measured 1.197x — so very nearly 100%.
  test.near("CSS 1.2 line-height -> ~100% lineSpacing", paragraphStyle?.lineSpacing ?? -1, 100.3, 0.4);
  test.equal("plain text reports nothing", reportedKinds(unsupported), []);
}

{
  const { requests } = convert([
    {
      type: "text",
      bounds: { x: 0, y: 0, w: 400, h: 40 },
      text: "Red and blue",
      runs: [
        { text: "Red ", style: { color: "#e53935", fontSize: 24, fontFamily: "Arial", fontWeight: "normal", fontStyle: "normal", textDecoration: null } },
        { text: "and ", style: null },
        { text: "blue", style: { color: "#1e88e5", fontSize: 24, fontFamily: "Arial", fontWeight: "bold", fontStyle: "normal", textDecoration: null } },
      ],
      style: { fontFamily: "Arial", fontSize: 24, color: "#000000", textAlign: "left" },
    },
  ]);
  const [insert] = requestsOfKind(asRecords(requests), "insertText");
  test.equal("runs are concatenated for the insert", insert?.["text"], "Red and blue");

  const styles = requestsOfKind(asRecords(requests), "updateTextStyle");
  test.equal("one ALL range plus one range per styled run", styles.length, 3);
  const ranges = styles.map((entry) => entry["textRange"] as Readonly<{ type: string; startIndex?: number; endIndex?: number }>);
  test.equal("first range is the base", ranges[0]?.type, "ALL");
  test.equal("styled run 1 range", { start: ranges[1]?.startIndex, end: ranges[1]?.endIndex }, { start: 0, end: 4 });
  test.equal("styled run 2 range skips the unstyled middle", { start: ranges[2]?.startIndex, end: ranges[2]?.endIndex }, { start: 8, end: 12 });
}

{
  const { requests } = convert([
    {
      type: "text",
      bounds: { x: 0, y: 0, w: 300, h: 200 },
      text: "Centered",
      verticallyCentered: true,
      style: { fontFamily: "Arial", fontSize: 20, textAlign: "center" },
    },
  ]);
  const [properties] = requestsOfKind(asRecords(requests), "updateShapeProperties");
  test.equal(
    "verticallyCentered -> MIDDLE",
    (properties?.["shapeProperties"] as Readonly<{ contentAlignment: string }>).contentAlignment,
    "MIDDLE",
  );
  const [paragraph] = requestsOfKind(asRecords(requests), "updateParagraphStyle");
  test.equal(
    "text-align center -> CENTER",
    (paragraph?.["style"] as Readonly<{ alignment: string }>).alignment,
    "CENTER",
  );
}

{
  // A text element that also carries a fill needs TWO objects, because the fill
  // belongs on the measured box and the text on the inset-compensated one.
  const { requests } = convert([
    {
      type: "text",
      bounds: { x: 100, y: 100, w: 200, h: 50 },
      text: "Label",
      fill: "#1e88e5",
      style: { fontFamily: "Arial", fontSize: 18, color: "#ffffff" },
    },
  ]);
  test.equal("decorated text splits into background + text box", kinds(requests), [
    "createShape",
    "updateShapeProperties",
    "createShape",
    "updateShapeProperties",
    "insertText",
    "updateTextStyle",
    "updateParagraphStyle",
  ]);
  const shapes = requestsOfKind(asRecords(requests), "createShape");
  test.equal("background is a RECTANGLE", shapes[0]?.["shapeType"], "RECTANGLE");
  test.equal("foreground is a TEXT_BOX", shapes[1]?.["shapeType"], "TEXT_BOX");
  const backgroundTransform = (shapes[0]?.["elementProperties"] as Readonly<{ transform: { translateX: number } }>).transform;
  test.near("background sits on the measured box", backgroundTransform.translateX, 100 * EMU_PER_PX, 2);
}

{
  const { unsupported } = convert([
    {
      type: "text",
      bounds: { x: 0, y: 0, w: 400, h: 40 },
      text: "Tracked",
      style: { fontFamily: "Pangolin Display", fontSize: 20, letterSpacing: 2.5, writingMode: "vertical-rl" },
    },
  ]);
  test.equal("text losses are all reported", [...reportedKinds(unsupported)].sort(), [
    "font-unavailable",
    "letter-spacing",
    "vertical-writing-mode",
  ]);
  const font = unsupported.find((feature) => feature.kind === "font-unavailable");
  test.check(
    "font report names requested and substituted",
    font !== undefined && font.kind === "font-unavailable" && font.requested === "pangolin display" && font.substituted === "Arial",
    JSON.stringify(font),
  );
}

{
  // A stack whose later entry resolves is NOT an anomaly: Chrome walked the
  // same stack and rendered the same face, so nothing was lost in translation.
  const { unsupported } = convert([
    {
      type: "text",
      bounds: { x: 0, y: 0, w: 400, h: 40 },
      text: "Fallback",
      style: { fontFamily: "Pangolin Display, Georgia, serif", fontSize: 20 },
    },
  ]);
  test.equal("a resolvable fallback in the stack reports nothing", reportedKinds(unsupported), []);
  const { requests } = convert([
    {
      type: "text",
      bounds: { x: 0, y: 0, w: 400, h: 40 },
      text: "Fallback",
      style: { fontFamily: "Pangolin Display, Georgia, serif", fontSize: 20 },
    },
  ]);
  const [textStyle] = requestsOfKind(asRecords(requests), "updateTextStyle");
  test.equal(
    "the stack resolves to its first available entry",
    (textStyle?.["style"] as Readonly<{ fontFamily: string }>).fontFamily,
    "Georgia",
  );
}

{
  // One missing font across many runs must report once, not once per run.
  const runs = Array.from({ length: 6 }, () => ({
    text: "x",
    style: { fontFamily: "Nonexistent Face", fontSize: 12, fontWeight: "normal", fontStyle: "normal", textDecoration: null },
  }));
  const { unsupported } = convert([
    { type: "text", bounds: { x: 0, y: 0, w: 100, h: 20 }, text: "xxxxxx", runs, style: { fontFamily: "Arial", fontSize: 12 } },
  ]);
  test.equal("font substitution is deduplicated", reportedKinds(unsupported), ["font-unavailable"]);
}

/* ------------------------------------------------------------ 4. images */

{
  const { requests, unsupported } = convert([
    {
      type: "image",
      bounds: { x: 40, y: 40, w: 320, h: 180 },
      tag: "img",
      src: "https://example.com/photo.png",
    },
  ]);
  test.equal("http image emits createImage", kinds(requests), ["createImage"]);
  const [image] = requestsOfKind(asRecords(requests), "createImage");
  test.equal("the URL is passed through", image?.["url"], "https://example.com/photo.png");
  test.equal("fetchable image reports nothing", reportedKinds(unsupported), []);
}

{
  // MEASURED: `createImage` does accept a `data:` URI and copies the bytes, as
  // long as the whole url stays within 2 KB. A small icon therefore reaches the
  // deck without anything touching Drive at all.
  const { requests, unsupported } = convert([
    {
      type: "image",
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      tag: "img",
      src: "data:image/png;base64,iVBORw0KGgo=",
    },
  ]);
  test.equal("a small data-uri image emits createImage", kinds(requests), ["createImage"]);
  const [image] = requestsOfKind(asRecords(requests), "createImage");
  test.equal("the data uri is the url", image?.["url"], "data:image/png;base64,iVBORw0KGgo=");
  test.equal("nothing is staged for it", asRecords(requests).map(stagedImageOf), [null]);
  test.equal("an inline image reports nothing", reportedKinds(unsupported), []);
}

{
  // Past the 2 KB url cap: the bytes have to be somewhere Google can fetch, so
  // the request carries the staging instruction the host executes.
  const { requests, unsupported } = convert([
    {
      type: "image",
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      tag: "img",
      src: `data:image/jpeg;base64,${"QUJD".repeat(800)}`,
    },
  ]);
  test.equal("a large data-uri image still emits createImage", kinds(requests), ["createImage"]);
  const [image] = asRecords(requests);
  const staged = image === undefined ? null : stagedImageOf(image);
  test.equal("the url is the staging placeholder", (image?.["createImage"] as Readonly<Record<string, unknown>>)?.["url"], STAGED_IMAGE_URL);
  test.equal("the staged mime type is carried", staged?.mimeType, "image/jpeg");
  test.equal("the staged payload is the data uri body", staged?.base64, "QUJD".repeat(800));
  test.check(
    "the staged file is named after the element",
    staged !== null && staged.fileName.endsWith(".jpg") && staged.fileName.startsWith("p_1733219000000_a1b2c3_img"),
    JSON.stringify(staged?.fileName),
  );
  test.equal("a staged image reports nothing", reportedKinds(unsupported), []);
}

{
  // THE ANONYMISER'S CONTRACT. `placeholder-image.ts` replaces every image with
  // a percent-encoded SVG and relies on the converter still reporting the same
  // loss -- and Slides really does refuse SVG in every form ("The URL is
  // invalid"), so staging one would only move the failure. A defect report
  // therefore never carries image bytes.
  const { requests, unsupported } = convert([
    {
      type: "image",
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      tag: "img",
      src: "data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20width%3D%27320%27%20height%3D%27240%27%3E%3C%2Fsvg%3E",
    },
  ]);
  test.equal("an svg placeholder emits nothing", kinds(requests), []);
  test.equal("an svg placeholder is reported", reportedKinds(unsupported), ["image-source-not-fetchable"]);
  const [report] = unsupported;
  test.check(
    "report names the scheme",
    report !== undefined && report.kind === "image-source-not-fetchable" && report.scheme === "data",
    JSON.stringify(report),
  );
}

{
  // `blob:` has no bytes in the document, so there is still nothing to stage.
  const { requests, unsupported } = convert([
    { type: "image", bounds: { x: 0, y: 0, w: 100, h: 100 }, tag: "img", src: "blob:https://x/y" },
  ]);
  test.equal("a blob image emits nothing", kinds(requests), []);
  test.equal("a blob image is reported", reportedKinds(unsupported), ["image-source-not-fetchable"]);
  const [report] = unsupported;
  test.check(
    "report names the blob scheme",
    report !== undefined && report.kind === "image-source-not-fetchable" && report.scheme === "blob",
    JSON.stringify(report),
  );
}

{
  // Past `createImage`'s own 50MB ceiling: refused here, with a sentence, rather
  // than carried across `google.script.run` to be refused by Google.
  const { requests, unsupported } = convert([
    {
      type: "image",
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      tag: "img",
      src: `data:image/png;base64,${"QUJD".repeat(SLIDES_MAX_IMAGE_BYTES / 3 + 1)}`,
    },
  ]);
  test.equal("an oversized image emits nothing", kinds(requests), []);
  test.equal("an oversized image is reported", reportedKinds(unsupported), ["image-too-large"]);
}

{
  // The pure decision, exercised directly -- including the two things the host
  // depends on: the url shape it must build, and the sidecar key it reads.
  test.equal(
    "an http source needs no staging",
    slideImageSourceFor({ src: "https://e.com/a.png", objectId: "img1" }).kind,
    "fetchable",
  );
  test.equal(
    "an empty source is unusable",
    slideImageSourceFor({ src: "  ", objectId: "img1" }),
    { kind: "unusable", scheme: "empty" },
  );
  test.equal(
    "a relative source is unusable",
    slideImageSourceFor({ src: "pictures/a.png", objectId: "img1" }).kind,
    "unusable",
  );
  test.equal(
    "a non-base64 raster data uri is unusable",
    slideImageSourceFor({ src: "data:image/png,%89PNG", objectId: "img1" }).kind,
    "unusable",
  );
  const wrapped = slideImageSourceFor({
    src: `data:image/gif;base64,${"QUJD\n  ".repeat(900)}`,
    objectId: "img1",
  });
  test.equal("a wrapped payload still stages", wrapped.kind, "staged");
  test.check(
    "the staged payload has no whitespace in it",
    wrapped.kind === "staged" && !/\s/.test(wrapped.upload.base64),
    JSON.stringify(wrapped.kind),
  );
  // The host builds this exact string in Code.gs; the two must not drift.
  test.equal("the staged url is the Drive uc form", stagedImageUrl("FILE123"), "https://drive.google.com/uc?id=FILE123");
  test.equal("the sidecar key is the one Code.gs reads", STAGED_IMAGE_FIELD, "sashaStageImage");
}

{
  const { unsupported } = convert([
    {
      type: "image",
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      tag: "img",
      src: "https://example.com/a.png",
      cornerRadius: 50,
    },
  ]);
  test.equal("rounded image is reported", reportedKinds(unsupported), ["image-corner-radius"]);
}

/* ------------------------------------------------------------- 5. lines */

{
  const { requests } = convert([
    { type: "line", bounds: { x: 100, y: 300, w: 400, h: 0 }, x1: 100, y1: 300, x2: 500, y2: 300, color: "#999999", strokeWidth: 2, dashType: "solid" },
  ]);
  test.equal("line emits createLine + updateLineProperties", kinds(requests), ["createLine", "updateLineProperties"]);
  const [line] = requestsOfKind(asRecords(requests), "createLine");
  const properties = line?.["elementProperties"] as
    | Readonly<{ size: { height: { magnitude: number } }; transform: { scaleX: number; translateX: number } }>
    | undefined;
  test.equal("a left-to-right line is not flipped", properties?.transform.scaleX, 1);
  test.near("line origin x", properties?.transform.translateX ?? -1, 100 * EMU_PER_PX, 2);
  test.check("a horizontal line keeps a positive extent", (properties?.size.height.magnitude ?? 0) >= 1);
}

{
  // The anti-diagonal is a horizontal flip, not swapped endpoints.
  const { requests } = convert([
    { type: "line", bounds: { x: 0, y: 0, w: 100, h: 100 }, x1: 0, y1: 100, x2: 100, y2: 0, color: "#000000", strokeWidth: 1 },
  ]);
  const [line] = requestsOfKind(asRecords(requests), "createLine");
  const transform = (line?.["elementProperties"] as Readonly<{ transform: { scaleX: number; translateX: number } }>).transform;
  test.equal("an ascending line flips horizontally", transform.scaleX, -1);
  test.near("the flipped line translates to its right edge", transform.translateX, 100 * EMU_PER_PX, 2);
}

/* -------------------------------------------------------------- 6. lists */

{
  const { requests, unsupported } = convert([
    {
      type: "list",
      bounds: { x: 100, y: 100, w: 500, h: 200 },
      ordered: false,
      listStyleType: "disc",
      items: [
        { text: "First", level: 0, fontSize: 20, fontFamily: "Arial", color: "#000000" },
        { text: "Nested", level: 1, fontSize: 18, fontFamily: "Arial", color: "#000000" },
        { text: "Second", level: 0, fontSize: 20, fontFamily: "Arial", color: "#000000" },
      ],
    },
  ]);
  const [insert] = requestsOfKind(asRecords(requests), "insertText");
  test.equal("nesting is carried by leading tabs", insert?.["text"], "First\n\tNested\nSecond");

  const requestKinds = kinds(requests);
  /*
   * BULLETS COME AFTER THE TEXT STYLING AND BEFORE THE INDENTS.
   *
   * This used to assert they were LAST, which encoded the bug: `createParagraphBullets` rewrites
   * a paragraph's indents to Slides' own bullet defaults, so anything the emitter said about
   * indentation beforehand was discarded and the list rendered ~38px right of the browser. The
   * tab-shifting text styling must still precede them; the indents must now follow them.
   */
  test.equal(
    "bullets come after the tab-shifting text styling",
    requestKinds.indexOf("createParagraphBullets") > requestKinds.lastIndexOf("updateTextStyle"),
    true,
  );
  test.equal(
    "and the indents come after the bullets, which would otherwise overwrite them",
    requestKinds.lastIndexOf("updateParagraphStyle") > requestKinds.indexOf("createParagraphBullets"),
    true,
  );
  const [bullets] = requestsOfKind(asRecords(requests), "createParagraphBullets");
  test.equal("an unordered list gets the disc preset", bullets?.["bulletPreset"], "BULLET_DISC_CIRCLE_SQUARE");

  // Ranges must be computed over the tab-prefixed paragraphs.
  const paragraphRanges = requestsOfKind(asRecords(requests), "updateParagraphStyle").map(
    (entry) => entry["textRange"] as Readonly<{ type: string; startIndex: number; endIndex: number }>,
  );
  test.equal("item 1 range", paragraphRanges[0], { type: "FIXED_RANGE", startIndex: 0, endIndex: 5 });
  test.equal("item 2 range includes its tab", paragraphRanges[1], { type: "FIXED_RANGE", startIndex: 6, endIndex: 13 });
  test.equal("item 3 range", paragraphRanges[2], { type: "FIXED_RANGE", startIndex: 14, endIndex: 20 });
  test.equal("a plain disc list reports nothing", reportedKinds(unsupported), []);
}

{
  const { requests, unsupported } = convert([
    {
      type: "list",
      bounds: { x: 0, y: 0, w: 400, h: 100 },
      ordered: true,
      listStyleType: "decimal",
      hasPseudoBullet: true,
      pseudoBulletChar: "➔",
      items: [{ text: "Step", level: 0, fontSize: 16, fontFamily: "Arial" }],
    },
  ]);
  const [bullets] = requestsOfKind(asRecords(requests), "createParagraphBullets");
  test.equal("an ordered list gets the numbered preset", bullets?.["bulletPreset"], "NUMBERED_DIGIT_ALPHA_ROMAN");
  test.equal("a pseudo-element marker is reported", reportedKinds(unsupported), ["list-marker-approximated"]);
}

{
  const { requests } = convert([
    {
      type: "list",
      bounds: { x: 0, y: 0, w: 400, h: 100 },
      ordered: false,
      items: [{ text: "Card row", level: 0, fontSize: 16, fontFamily: "Arial" }],
      containerStyle: {
        bgColor: "#f5f5f5",
        fillAlpha: 1,
        borderWidth: 1,
        borderColor: "#dddddd",
        borderStyle: "solid",
        borderRadius: 8,
        cornerRadii: { tl: 8, tr: 8, br: 8, bl: 8 },
        padding: { top: 16, right: 16, bottom: 16, left: 16 },
      },
    },
  ]);
  const shapes = requestsOfKind(asRecords(requests), "createShape");
  test.equal("a list card emits a background rect before the text box", shapes.length, 2);
  test.equal("the card is a rectangle", shapes[0]?.["shapeType"], "RECTANGLE");
  const textTransform = (shapes[1]?.["elementProperties"] as Readonly<{ transform: { translateX: number } }>).transform;
  // 16px container padding, minus the measured left text inset.
  test.near(
    "list text honours the container padding",
    textTransform.translateX,
    16 * EMU_PER_PX - DEFAULT_TEXT_INSET_EMU.left,
    2,
  );
}

/* ------------------------------------------------------------- 7. tables */

{
  const cell = (
    text: string,
    bounds: Readonly<{ x: number; y: number; w: number; h: number }>,
    isHeader: boolean,
  ): RawElement => ({
    text,
    isHeader,
    bounds,
    padding: { top: 8, right: 12, bottom: 8, left: 12 },
    bgColor: isHeader ? "#1e88e5" : null,
    style: { fontFamily: "Arial", fontSize: 14, color: isHeader ? "#ffffff" : "#333333", lineHeight: 16.8, borderWidth: 1, borderColor: "#dddddd", borderStyle: "solid", borderUniform: true },
  });

  const { requests, unsupported } = convert([
    {
      type: "table",
      bounds: { x: 100, y: 100, w: 600, h: 120 },
      borderCollapse: "collapse",
      rows: [
        [cell("Name", { x: 100, y: 100, w: 300, h: 40 }, true), cell("Value", { x: 400, y: 100, w: 300, h: 40 }, true)],
        [cell("Alpha", { x: 100, y: 140, w: 300, h: 40 }, false), cell("1", { x: 400, y: 140, w: 300, h: 40 }, false)],
        [cell("Beta", { x: 100, y: 180, w: 300, h: 40 }, false), cell("2", { x: 400, y: 180, w: 300, h: 40 }, false)],
      ],
    },
  ]);

  const [table] = requestsOfKind(asRecords(requests), "createTable");
  test.equal("table row count", table?.["rows"], 3);
  test.equal("table column count", table?.["columns"], 2);

  const columns = requestsOfKind(asRecords(requests), "updateTableColumnProperties");
  test.equal("one width request per column", columns.length, 2);
  const firstWidth = (columns[0]?.["tableColumnProperties"] as Readonly<{ columnWidth: { magnitude: number } }>).columnWidth;
  // The inverse of the measured law: spec = (300 + 0.10) / 1.003.
  test.near("column width uses the inverted column law", firstWidth.magnitude, specForColumnWidthPx(300) * EMU_PER_PX, 2);
  test.check("the column law shrinks the spec below the target", specForColumnWidthPx(300) < 300);

  const rows = requestsOfKind(asRecords(requests), "updateTableRowProperties");
  test.equal("one height request per row", rows.length, 3);
  const firstHeight = (rows[0]?.["tableRowProperties"] as Readonly<{ minRowHeight: { magnitude: number } }>).minRowHeight;
  // The inverse of the measured law: spec = target − 0.72.
  test.near("row height uses the inverted row law", firstHeight.magnitude, (40 - 0.72) * EMU_PER_PX, 2);

  const inserts = requestsOfKind(asRecords(requests), "insertText");
  test.equal("every cell's text is inserted", inserts.length, 6);
  test.equal("cell text carries a cellLocation", inserts[0]?.["cellLocation"], { rowIndex: 0, columnIndex: 0 });

  const cellProperties = requestsOfKind(asRecords(requests), "updateTableCellProperties");
  test.equal("only the two header cells need cell properties", cellProperties.length, 2);

  const borders = requestsOfKind(asRecords(requests), "updateTableBorderProperties");
  test.equal("a uniform cell border collapses to one ALL request", borders.length, 1);
  test.equal("the uniform border covers the whole grid", borders[0]?.["borderPosition"], "ALL");

  // 14px font, 8px padding: the floor is well under the measured 40px rows.
  test.equal("a roomy table reports no row-height anomaly", reportedKinds(unsupported), []);
}

{
  // A 40px font in a 30px row cannot render: the law's floor is ~48px.
  const { unsupported } = convert([
    {
      type: "table",
      bounds: { x: 0, y: 0, w: 400, h: 30 },
      rows: [
        [
          {
            text: "Huge",
            bounds: { x: 0, y: 0, w: 400, h: 30 },
            padding: { top: 0, right: 0, bottom: 0, left: 0 },
            style: { fontFamily: "Arial", fontSize: 40, lineHeight: 48 },
          },
        ],
      ],
    },
  ]);
  test.equal("an under-height row is reported", reportedKinds(unsupported), ["table-row-height-floor"]);
  const [report] = unsupported;
  test.check(
    "the report predicts the floor the law gives",
    report !== undefined && report.kind === "table-row-height-floor" && Math.abs(report.predictedPx - (1.197 * 40 + 0.51)) < 0.1,
    JSON.stringify(report),
  );
  test.check(
    "the anomaly sentence quantifies the overflow",
    report !== undefined && describeUnsupportedFeature(report).includes("taller"),
    report === undefined ? "<missing>" : describeUnsupportedFeature(report),
  );
}

{
  // colspan / rowspan ARE expressible, via mergeTableCells.
  const { requests } = convert([
    {
      type: "table",
      bounds: { x: 0, y: 0, w: 600, h: 120 },
      rows: [
        [{ text: "Spans two", colspan: 2, bounds: { x: 0, y: 0, w: 600, h: 40 }, style: { fontSize: 14, fontFamily: "Arial" } }],
        [
          { text: "A", bounds: { x: 0, y: 40, w: 300, h: 40 }, style: { fontSize: 14, fontFamily: "Arial" } },
          { text: "B", bounds: { x: 300, y: 40, w: 300, h: 40 }, style: { fontSize: 14, fontFamily: "Arial" } },
        ],
      ],
    },
  ]);
  const [table] = requestsOfKind(asRecords(requests), "createTable");
  test.equal("a colspan grows the column count", table?.["columns"], 2);
  const merges = requestsOfKind(asRecords(requests), "mergeTableCells");
  test.equal("the spanning cell is merged", merges.length, 1);
  test.equal("merge range matches the span", merges[0]?.["tableRange"], {
    location: { rowIndex: 0, columnIndex: 0 },
    rowSpan: 1,
    columnSpan: 2,
  });

  // Merges must precede every cell write.
  const requestKinds = kinds(requests);
  test.check(
    "merges come before any insertText",
    requestKinds.indexOf("mergeTableCells") < requestKinds.indexOf("insertText"),
    requestKinds.join(","),
  );
}

{
  // A rowspan hides a cell from the next DOM row; the grid must still line up.
  const { requests } = convert([
    {
      type: "table",
      bounds: { x: 0, y: 0, w: 600, h: 120 },
      rows: [
        [
          { text: "tall", rowspan: 2, bounds: { x: 0, y: 0, w: 200, h: 80 }, style: { fontSize: 14, fontFamily: "Arial" } },
          { text: "r0c1", bounds: { x: 200, y: 0, w: 400, h: 40 }, style: { fontSize: 14, fontFamily: "Arial" } },
        ],
        [{ text: "r1c1", bounds: { x: 200, y: 40, w: 400, h: 40 }, style: { fontSize: 14, fontFamily: "Arial" } }],
      ],
    },
  ]);
  const locations = requestsOfKind(asRecords(requests), "insertText").map((entry) => entry["cellLocation"]);
  test.equal("the rowspan pushes the second row's cell to column 1", locations, [
    { rowIndex: 0, columnIndex: 0 },
    { rowIndex: 0, columnIndex: 1 },
    { rowIndex: 1, columnIndex: 1 },
  ]);
}

/* ------------------------------------------------ 8. remaining element kinds */

{
  const { requests, unsupported } = convert([
    { type: "visual", bounds: { x: 0, y: 0, w: 100, h: 100 }, tag: "svg" },
    { type: "poly", bounds: { x: 0, y: 0, w: 100, h: 100 }, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }] },
    { type: "br", bounds: { x: 0, y: 0, w: 0, h: 0 } },
    { type: "_skip", bounds: { x: 0, y: 0, w: 0, h: 0 } },
    { type: "something-new", bounds: { x: 10, y: 20, w: 30, h: 40 } },
  ]);
  test.equal("none of these emit requests", kinds(requests), []);
  test.equal("br and _skip stay silent; the rest report", reportedKinds(unsupported), [
    "rasterised-visual",
    "clip-path-polygon",
    "unmapped-element",
  ]);
  const unmapped = unsupported.find((feature) => feature.kind === "unmapped-element");
  test.equal("an unknown element names its original type", unmapped?.elementType, "something-new");
}

{
  const { requests } = convert([
    {
      type: "triangle",
      bounds: { x: 0, y: 0, w: 60, h: 40 },
      fill: "#e53935",
    },
  ]);
  const [shape] = requestsOfKind(asRecords(requests), "createShape");
  test.equal("a border triangle becomes a TRIANGLE preset", shape?.["shapeType"], "TRIANGLE");
}

/* ------------------------------------------------- 9. regions and object ids */

{
  const { unsupported } = convert([
    { type: "visual", bounds: { x: 320, y: 180, w: 640, h: 360 }, tag: "canvas" },
  ]);
  const [report] = unsupported;
  test.equal("the anomaly region is fractional over 1280x720", report?.region, {
    x: 0.25,
    y: 0.25,
    w: 0.5,
    h: 0.5,
  });
}

{
  const { requests } = convert([
    { type: "rect", bounds: { x: 0, y: 0, w: 10, h: 10 }, fill: "#000000" },
    { type: "text", bounds: { x: 0, y: 0, w: 10, h: 10 }, text: "hi", style: { fontFamily: "Arial", fontSize: 10 } },
    { type: "image", bounds: { x: 0, y: 0, w: 10, h: 10 }, src: "https://e.com/a.png", tag: "img" },
  ]);
  const objectIds = asRecords(requests)
    .map((request) => {
      const payload = Object.values(request)[0] as Readonly<{ objectId?: string }> | undefined;
      return payload?.objectId;
    })
    .filter((id): id is string => id !== undefined);

  test.check("every request carries an object id", objectIds.length === requests.length, `${objectIds.length}/${requests.length}`);
  const created = new Set(objectIds);
  test.check(
    "ids are 5-50 chars of [a-zA-Z0-9_-]",
    [...created].every((id) => /^[a-zA-Z0-9_-]{5,50}$/.test(id)),
    [...created].join(","),
  );
  // The prefix carries the proposal id, so two conversions onto one deck cannot collide.
  test.check("ids carry the conversion prefix", [...created].every((id) => id.startsWith("p_1733219000000_a1b2c3_")), [...created][0] ?? "");
}

{
  // Paint order is z-order: Slides stacks page elements by creation order.
  const { requests } = convert([
    { type: "rect", bounds: { x: 0, y: 0, w: 1280, h: 720 }, fill: "#ffffff" },
    { type: "rect", bounds: { x: 100, y: 100, w: 100, h: 100 }, fill: "#ff0000" },
  ]);
  const shapes = requestsOfKind(asRecords(requests), "createShape");
  const firstWidth = (shapes[0]?.["elementProperties"] as Readonly<{ size: { width: { magnitude: number } } }>).size.width.magnitude;
  test.near("the background is created first", firstWidth, 1280 * EMU_PER_PX, 2);
}

/* ---------------------------------------------------- 10. the measured laws */

{
  // Forward direction, straight from CLAUDE.md's statement of the law.
  const roomy = predictGoogleRowHeightPx({ specPx: 50, fontPx: 14, lines: 1, padYPx: 8 });
  test.near("a roomy row renders at spec + 0.72", roomy.renderedPx, 50.72, 0.01);
  test.equal("a roomy row is not floor-bound", roomy.floorWins, false);

  const tight = predictGoogleRowHeightPx({ specPx: 10, fontPx: 40, lines: 1, padYPx: 0 });
  test.near("a tight row renders at the font floor", tight.renderedPx, 1.197 * 40 + 0.51, 0.01);
  test.equal("a tight row is floor-bound", tight.floorWins, true);

  const twoLines = predictGoogleRowHeightPx({ specPx: 10, fontPx: 20, lines: 2, padYPx: 6 });
  test.near("the floor scales with line count and padding", twoLines.renderedPx, 1.197 * 20 * 2 + 0.98 * 12 + 0.51, 0.01);

  // Tiny fonts hit an absolute minimum the linear floor under-predicts.
  const tiny = predictGoogleRowHeightPx({ specPx: 1, fontPx: 8, lines: 1, padYPx: 0 });
  test.near("fonts <= 10px hit the ~13px absolute minimum", tiny.renderedPx, 13, 0.01);
}

/* ------------------------------------- 14. the font scale is the PAGE's scale
 *
 * THE BUG THIS PINS DOWN. `pxToPoints` used the CSS ABSOLUTE conversion, 0.75 pt/px at 96 dpi --
 * which is right for a 13.333in PowerPoint page and wrong for Google's 10in one. Every font was
 * emitted 0.75 / 0.5625 = 4/3 too large, so Slides re-wrapped text that Chrome had laid out, every
 * box overflowed, and consecutive elements printed on top of each other. It was visible on all
 * four picker candidates at once (`calibration/sxs-candidates.ts`), which is what "the previews
 * are completely broken" was.
 *
 * It is asserted as an INVARIANT and not as a constant: the font scale and the geometry scale are
 * the same mapping seen twice, so text as wide as the document must be text as wide as the page.
 * A future change to either one that forgets the other fails here.
 */
{
  const slideWidthPx = 1280;
  const scale = pageScaleFor({ viewportPx: { w: slideWidthPx, h: 720 }, pageSizeEmu: DEFAULT_PAGE_SIZE_EMU });
  const widthFromFontScale = pxToPoints(slideWidthPx, scale) * EMU_PER_POINT;
  test.near(
    "a run as wide as the document is as wide as the page",
    widthFromFontScale,
    DEFAULT_PAGE_SIZE_EMU.widthEmu,
    1,
  );
  // Rounded to 2dp, which is the quantum a font size is emitted at.
  test.near("so one CSS px is 0.5625 pt, not the 0.75 pt of a 13.33in page", pxToPoints(1, scale), 0.5625, 0.005);
  test.near("a 58px heading is 32.63pt", pxToPoints(58, scale), 32.63, 0.01);

  // AND IT FOLLOWS A NON-DEFAULT PAGE, which is why it takes the scale rather than a constant:
  // calibration/measure-text-inset.ts converts against a page of its own.
  const wide = pageScaleFor({
    viewportPx: { w: slideWidthPx, h: 720 },
    pageSizeEmu: { widthEmu: DEFAULT_PAGE_SIZE_EMU.widthEmu * 2, heightEmu: DEFAULT_PAGE_SIZE_EMU.heightEmu * 2 },
  });
  test.near("a page twice as wide doubles the type", pxToPoints(48, wide), 54, 0.01);
}

/* ------------------------------- 15. a frame that never paints is not a hang
 *
 * THE BUG THIS PINS DOWN. `nextFrame` awaited `requestAnimationFrame` with nothing racing it.
 * A browser does not service rAF for a frame it is not rendering -- a backgrounded tab, a
 * throttled or occluded frame, or the nested sandbox Apps Script's `showModelessDialog` puts the
 * picker in -- and the promise then never settled. No throw, no rejection: every candidate sat on
 * "converting..." forever, and because a conversion in flight blocks the next (dialog.tsx `pump`)
 * one stuck slide stopped all of them.
 *
 * `await` is the assertion. If the budget is not honoured this test does not fail, it HANGS --
 * which is exactly the production symptom, and the runner's own timeout reports it.
 */

/* ------------------ 16. bullets are created BEFORE the indents that correct them
 *
 * THE BUG THIS PINS DOWN. `createParagraphBullets` REWRITES a paragraph's indents to Slides' own
 * bullet defaults -- half an inch of `indentStart`. The emitter sent each item's paragraph style
 * first and created the bullets afterwards, so every indent it asked for was silently discarded
 * and Slides' default won. A numbered list therefore sat ~38px right of where Chrome drew it,
 * and no amount of changing the indent VALUE could move it, because the request was being
 * thrown away rather than ignored. Measured after the reorder: x=111/109/108 against Chrome's
 * 106/105/105 (calibration/sxs-candidates.ts).
 *
 * The ORDER is the contract, so the order is what is asserted.
 */
{
  const { requests } = convert([
    {
      type: "list",
      bounds: { x: 100, y: 100, w: 400, h: 120 },
      ordered: true,
      items: [
        { text: "First", level: 0, fontSize: 20, fontFamily: "Arial", color: "#000000" },
        { text: "Second", level: 0, fontSize: 20, fontFamily: "Arial", color: "#000000" },
      ],
      style: { fontFamily: "Arial", fontSize: 20 },
    },
  ]);
  const kinds = asRecords(requests).map((request) => kindOf(request as never));
  const bulletsAt = kinds.indexOf("createParagraphBullets");
  const indentAt = asRecords(requests).findIndex((request) => {
    const update = request["updateParagraphStyle"];
    if (typeof update !== "object" || update === null) return false;
    return typeof (update as Readonly<{ fields?: string }>).fields === "string"
      && (update as Readonly<{ fields: string }>).fields.includes("indentStart");
  });
  test.check("the list creates its bullets", bulletsAt >= 0, kinds.join(","));
  test.check("and states its indents", indentAt >= 0, kinds.join(","));
  test.check(
    "the indents are applied AFTER the bullets, or createParagraphBullets overwrites them",
    bulletsAt >= 0 && indentAt > bulletsAt,
    `bullets at ${String(bulletsAt)}, indent at ${String(indentAt)}`,
  );
}

async function checkFramePacing(): Promise<void> {
  const startedNever = Date.now();
  await afterNextFrame({ view: { requestAnimationFrame: () => undefined }, budgetMs: 30 });
  const waitedNever = Date.now() - startedNever;
  test.check(
    "a view whose rAF never fires resolves at the budget instead of hanging",
    waitedNever >= 25 && waitedNever < 2000,
    `waited ${waitedNever}ms`,
  );

  // AND IT STILL TAKES THE FRAME when there is one: the timeout is a floor on failure, never a
  // delay on the normal path, because every conversion pays this wait.
  const startedPaints = Date.now();
  await afterNextFrame({
    view: { requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0) },
    budgetMs: 5000,
  });
  const waitedPaints = Date.now() - startedPaints;
  test.check(
    "a view that does paint resolves on the frame, not on the budget",
    waitedPaints < 1000,
    `waited ${waitedPaints}ms`,
  );
}

// Top-level await is not available (the runner transforms to CJS), so the one async check runs
// in a function and `finish` is chained after it.
void checkFramePacing().then(() => test.finish());
