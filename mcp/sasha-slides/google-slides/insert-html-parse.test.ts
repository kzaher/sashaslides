/**
 * The developer page's insert body, re-validated (insert-html-parse.ts): the product converter's
 * real output passes with every id rewritten, and everything a hostile page could add is refused.
 *
 * Run: node --test --import tsx mcp/sasha-slides/google-slides/insert-html-parse.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emitSlideRequests } from "../converter/emit-requests.ts";
import { parseExtraction } from "../converter/extraction.ts";
import { STAGED_IMAGE_URL } from "../converter/slide-image.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import type { SlidesApiRequest } from "../converter/slides-api.ts";
import { INSERT_HTML_LIMITS } from "./insert-html-contract.ts";
import { parseInsertHtmlBody, type InsertParse, type JsonObject, type ParsedInsert, type PlannedRequest } from "./insert-html-parse.ts";

const PRESENTATION_ID = "1Z7XcNtZXKwQLq6scGKZujaWFtWuCTVPLYjs3UcoJBnA";
const PREFIX = "htest_";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG_BASE64 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]).toString("base64");
const DRAWIO_XML = '<mxfile><diagram id="a" name="Page-1"><mxGraphModel><root><mxCell id="0"/></root></mxGraphModel></diagram></mxfile>';

describe("the product converter's own output", () => {
  test("passes, with every object id and page id rewritten consistently and the staged picture decoded", () => {
    const requests = converterRequests();
    const parsed = expectOk(parseInsertHtmlBody({ body: bodyWith({ slides: [{ requests, diagrams: [] }] }), idPrefix: PREFIX }));
    const slide = parsed.slides[0];
    assert.ok(slide !== undefined);
    assert.equal(slide.pageObjectId, "htest_p1");
    assert.equal(slide.requests.length, requests.length, "nothing dropped");
    const sent = slide.requests.map(requestOf);
    const text = JSON.stringify(sent);
    assert.ok(!text.includes("p_conv_"), "no converter id survives");
    assert.ok(!text.includes('"placeholder-page"'), "no placeholder page id survives");
    for (const objectId of objectIdsIn(sent)) assert.match(objectId, /^htest_s1e\d+$/);
    for (const pageId of pageIdsIn(sent)) assert.equal(pageId, "htest_p1");
    // Every reference resolves to an id a create on this slide got, in order.
    const created = new Set<string>();
    for (const request of sent) {
      const [kind, body] = Object.entries(request)[0] ?? ["", null];
      const objectId = fieldOf(body, "objectId");
      assert.equal(typeof objectId, "string", `${kind} names an object`);
      if (kind.startsWith("create") && kind !== "createParagraphBullets") created.add(String(objectId));
      else assert.ok(created.has(String(objectId)), `${kind} names an object created before it`);
    }
    const staged = slide.requests.filter((request) => request.kind === "stagedImage");
    assert.equal(staged.length, 1, "the large data picture is staged");
    const image = staged[0];
    assert.ok(image !== undefined && image.kind === "stagedImage");
    assert.equal(image.image.mediaType, "image/jpeg");
    assert.equal(image.image.fileName, "htest_p1-image1.jpg");
    assert.deepEqual(Buffer.from(image.image.bytes), Buffer.from(JPEG_BASE64, "base64"));
    assert.equal(image.createImage["url"], STAGED_IMAGE_URL);
    assert.ok(!JSON.stringify(image.createImage).includes("sashaStageImage"), "the sidecar is not part of the request");
  });
});

describe("request kinds", () => {
  test("every kind the converter does not emit is refused", () => {
    const rows: readonly Readonly<{ name: string; request: unknown }>[] = [
      { name: "deleteObject", request: { deleteObject: { objectId: "g123" } } },
      { name: "replaceAllText", request: { replaceAllText: { containsText: { text: "a" }, replaceText: "b" } } },
      { name: "duplicateObject", request: { duplicateObject: { objectId: "g123" } } },
      { name: "createSlide", request: { createSlide: { objectId: "mine" } } },
      { name: "replaceImage", request: { replaceImage: { imageObjectId: "g123", url: "https://example.com/a.png" } } },
      { name: "updateSlidesPosition", request: { updateSlidesPosition: { slideObjectIds: ["p"], insertionIndex: 0 } } },
      { name: "an unknown kind", request: { somethingNew: {} } },
      { name: "two kinds in one request", request: { createShape: shape("a"), insertText: { objectId: "a", text: "x" } } },
      { name: "no kind", request: {} },
      { name: "not an object", request: ["createShape"] },
      { name: "a sidecar on a shape", request: { createShape: shape("a"), sashaStageImage: { fileName: "a.png", mimeType: "image/png", base64: PNG.toString("base64") } } },
      { name: "an inherited name", request: { toString: {} } },
    ];
    for (const row of rows) expectInvalid({ result: parseSlideRequests([row.request]), name: row.name });
  });

  test("an unknown nested field is refused (a text link, a theme colour, a stray key)", () => {
    const rows: readonly Readonly<{ name: string; request: unknown }>[] = [
      { name: "text link", request: { updateTextStyle: { objectId: "a", style: { link: { url: "https://evil.example" } }, fields: "link" } } },
      { name: "theme colour", request: { updateTextStyle: { objectId: "a", style: { foregroundColor: { opaqueColor: { themeColor: "DARK1" } } }, fields: "foregroundColor" } } },
      { name: "stray key on createShape", request: { createShape: { ...shape("b"), extra: 1 } } },
      { name: "a shape type outside the converter's", request: { createShape: { ...shape("b"), shapeType: "CLOUD" } } },
      { name: "a field mask with spaces", request: { updateShapeProperties: { objectId: "a", shapeProperties: {}, fields: "outline; drop" } } },
      { name: "a missing required field", request: { createShape: { objectId: "b", elementProperties: elementProperties() } } },
      { name: "a number sent as text", request: { createShape: { ...shape("b"), elementProperties: { ...elementProperties(), transform: { ...transform(), translateX: "1e400" } } } } },
    ];
    for (const row of rows) expectInvalid({ result: parseSlideRequests([{ createShape: shape("a") }, row.request]), name: row.name });
  });
});

describe("object and page ids", () => {
  test("naming an object not created earlier on the same slide is refused", () => {
    expectInvalid({ result: parseSlideRequests([{ insertText: { objectId: "g_existing_shape", text: "x" } }]), name: "an existing object of the deck" });
    expectInvalid({ result: parseSlideRequests([{ insertText: { objectId: "a", text: "x" } }, { createShape: shape("a") }]), name: "before its create" });
    expectInvalid({ result: parseSlideRequests([{ createShape: shape("a") }, { createShape: shape("a") }]), name: "created twice" });
    expectInvalid({ result: parseSlideRequests([{ updatePageElementAltText: { objectId: "placeholder-page", description: "x" } }]), name: "the page itself" });
    const twoSlides = parseInsertHtmlBody({ body: bodyWith({ slides: [{ requests: [{ createShape: shape("a") }], diagrams: [] }, { requests: [{ insertText: { objectId: "a", text: "x" } }], diagrams: [] }] }), idPrefix: PREFIX });
    expectInvalid({ result: twoSlides, name: "created on another slide" });
  });

  test("every pageObjectId is forced to the server's slide; a second, different page is refused", () => {
    const parsed = expectOk(parseSlideRequests([{ createShape: shape("a") }, { createShape: { ...shape("b"), elementProperties: elementProperties() } }]));
    assert.deepEqual(pageIdsIn(parsed.slides[0]?.requests.map(requestOf) ?? []), ["htest_p1", "htest_p1"]);
    expectInvalid({ result: parseSlideRequests([{ createShape: shape("a") }, { createShape: { ...shape("b"), elementProperties: { ...elementProperties(), pageObjectId: "g_another_slide" } } }]), name: "another page" });
  });

  test("ids rewrite per slide under the prefix, and the prefix itself is checked", () => {
    const parsed = expectOk(parseInsertHtmlBody({ body: bodyWith({ slides: [{ requests: [{ createShape: shape("a") }], diagrams: [] }, { requests: [{ createShape: shape("a") }], diagrams: [] }] }), idPrefix: PREFIX }));
    assert.deepEqual(parsed.slides.map((slide) => slide.pageObjectId), ["htest_p1", "htest_p2"]);
    assert.deepEqual(parsed.slides.map((slide) => objectIdsIn(slide.requests.map(requestOf))), [["htest_s1e1"], ["htest_s2e1"]]);
    assert.throws(() => parseInsertHtmlBody({ body: bodyWith({}), idPrefix: "bad prefix" }));
  });
});

describe("pictures", () => {
  const image = (url: string, sidecar?: unknown): unknown => ({ createImage: { objectId: "img", url, elementProperties: elementProperties() }, ...(sidecar === undefined ? {} : { sashaStageImage: sidecar }) });
  const sidecar = (overrides: Readonly<Record<string, unknown>> = {}): unknown => ({ fileName: "whatever.png", mimeType: "image/png", base64: PNG.toString("base64"), ...overrides });

  test("allowed: a staged PNG/JPEG/GIF with matching bytes, a small data: PNG, an https address", () => {
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1").toString("base64");
    for (const request of [image(STAGED_IMAGE_URL, sidecar()), image(STAGED_IMAGE_URL, sidecar({ mimeType: "image/gif", base64: gif })), image(`data:image/png;base64,${PNG.toString("base64")}`), image("https://example.com/photo.png")]) {
      expectOk(parseSlideRequests([request]));
    }
  });

  test("refused: the wrong bytes, a missing or misplaced sidecar, http, oversized or non-image data:", () => {
    const rows: readonly Readonly<{ name: string; request: unknown }>[] = [
      { name: "placeholder without a sidecar", request: image(STAGED_IMAGE_URL) },
      { name: "sidecar on an https address", request: image("https://example.com/a.png", sidecar()) },
      { name: "PNG claimed, JPEG bytes", request: image(STAGED_IMAGE_URL, sidecar({ base64: JPEG_BASE64 })) },
      { name: "SVG media type", request: image(STAGED_IMAGE_URL, sidecar({ mimeType: "image/svg+xml" })) },
      { name: "not base64", request: image(STAGED_IMAGE_URL, sidecar({ base64: "%%%%" })) },
      { name: "a stray sidecar field", request: image(STAGED_IMAGE_URL, { ...(sidecar() as object), folderId: "x" }) },
      { name: "plain http", request: image("http://example.com/a.png") },
      { name: "credentials in the address", request: image("https://user:secret@example.com/a.png") },
      { name: "another scheme", request: image("file:///etc/passwd") },
      { name: "a data: SVG", request: image("data:image/svg+xml;base64,PHN2Zz4=") },
      { name: "a data: PNG with other bytes", request: image(`data:image/png;base64,${JPEG_BASE64.slice(0, 40)}`) },
      { name: "a data: address past 2 KB", request: image(`data:image/jpeg;base64,${JPEG_BASE64}`) },
    ];
    for (const row of rows) expectInvalid({ result: parseSlideRequests([row.request]), name: row.name });
  });

  test("at most maximumStagedImagesPerSlide staged pictures per slide", () => {
    const staged = (index: number): unknown => ({ createImage: { objectId: `img${index}`, url: STAGED_IMAGE_URL, elementProperties: elementProperties() }, sashaStageImage: sidecar() });
    const limit = INSERT_HTML_LIMITS.maximumStagedImagesPerSlide;
    expectOk(parseSlideRequests(Array.from({ length: limit }, (_, index) => staged(index))));
    expectInvalid({ result: parseSlideRequests(Array.from({ length: limit + 1 }, (_, index) => staged(index))), name: "one too many" });
  });

  test("a picture links only to a Drive file viewer address", () => {
    const link = (url: string): unknown => ({ updateImageProperties: { objectId: "img", imageProperties: { link: { url } }, fields: "link" } });
    expectOk(parseSlideRequests([image("https://example.com/a.png"), link("https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view")]));
    for (const url of ["https://evil.example/file/d/1AbCdEfGhIjKlMn/view", "https://drive.google.com/file/d/1AbCdEfGhIjKlMn/edit", "javascript:alert(1)"]) {
      expectInvalid({ result: parseSlideRequests([image("https://example.com/a.png"), link(url)]), name: url });
    }
  });
});

describe("diagrams", () => {
  const picture = { createImage: { objectId: "diagram-picture", url: "https://example.com/d.png", elementProperties: elementProperties() } };

  test("a diagram on a picture of the same slide is re-pointed at the rewritten id, its source normalised", () => {
    const parsed = expectOk(parseInsertHtmlBody({ body: bodyWith({ slides: [{ requests: [picture], diagrams: [{ objectId: "diagram-picture", diagramId: "dg0123abcd", xml: `  ${DRAWIO_XML}\n` }] }] }), idPrefix: PREFIX }));
    assert.deepEqual(parsed.slides[0]?.diagrams, [{ objectId: "htest_s1e1", diagramId: "dg0123abcd", xml: DRAWIO_XML }]);
  });

  test("refused: a bad diagram id, a shape instead of a picture, an unknown object, XML that is not draw.io, a second diagram on one picture", () => {
    const diagram = (overrides: Readonly<Record<string, unknown>>): unknown => ({ objectId: "diagram-picture", diagramId: "dg0123abcd", xml: DRAWIO_XML, ...overrides });
    const rows: readonly Readonly<{ name: string; diagrams: readonly unknown[] }>[] = [
      { name: "diagram id with a slash", diagrams: [diagram({ diagramId: "../escape" })] },
      { name: "a shape", diagrams: [diagram({ objectId: "box" })] },
      { name: "an unknown object", diagrams: [diagram({ objectId: "nowhere" })] },
      { name: "not draw.io", diagrams: [diagram({ xml: "<html></html>" })] },
      { name: "twice on one picture", diagrams: [diagram({}), diagram({ diagramId: "dg9999" })] },
      { name: "a stray field", diagrams: [diagram({ folderId: "x" })] },
    ];
    for (const row of rows) {
      const result = parseInsertHtmlBody({ body: bodyWith({ slides: [{ requests: [picture, { createShape: shape("box") }], diagrams: row.diagrams }] }), idPrefix: PREFIX });
      expectInvalid({ result, name: row.name });
    }
  });
});

describe("the envelope", () => {
  test("presentation: an id or an address; anything else is refused", () => {
    assert.equal(expectOk(parseInsertHtmlBody({ body: bodyWith({ presentation: `https://docs.google.com/presentation/d/${PRESENTATION_ID}/edit#slide=id.p` }), idPrefix: PREFIX })).presentationId, PRESENTATION_ID);
    for (const presentation of ["not an id", 42, null]) expectInvalid({ result: parseInsertHtmlBody({ body: bodyWith({ presentation }), idPrefix: PREFIX }), name: String(presentation) });
  });

  test("position: end, or a 0-based index", () => {
    assert.deepEqual(expectOk(parseInsertHtmlBody({ body: bodyWith({ position: { kind: "index", index: 3 } }), idPrefix: PREFIX })).position, { kind: "index", index: 3 });
    for (const position of [{ kind: "after", pageObjectId: "p" }, { kind: "index", index: -1 }, { kind: "index", index: 1.5 }, { kind: "end", index: 2 }, null]) {
      expectInvalid({ result: parseInsertHtmlBody({ body: bodyWith({ position }), idPrefix: PREFIX }), name: JSON.stringify(position) });
    }
  });

  test("limits: at least one slide, at most maximumSlides, at most maximumRequestsPerSlide requests", () => {
    const empty = { requests: [], diagrams: [] };
    expectInvalid({ result: parseInsertHtmlBody({ body: bodyWith({ slides: [] }), idPrefix: PREFIX }), name: "no slide" });
    expectOk(parseInsertHtmlBody({ body: bodyWith({ slides: Array.from({ length: INSERT_HTML_LIMITS.maximumSlides }, () => empty) }), idPrefix: PREFIX }));
    expectInvalid({ result: parseInsertHtmlBody({ body: bodyWith({ slides: Array.from({ length: INSERT_HTML_LIMITS.maximumSlides + 1 }, () => empty) }), idPrefix: PREFIX }), name: "too many slides" });
    const shapes = (count: number): unknown[] => Array.from({ length: count }, (_, index) => ({ createShape: shape(`s${index}`) }));
    expectOk(parseSlideRequests(shapes(INSERT_HTML_LIMITS.maximumRequestsPerSlide)));
    expectInvalid({ result: parseSlideRequests(shapes(INSERT_HTML_LIMITS.maximumRequestsPerSlide + 1)), name: "too many requests" });
  });

  test("unknown top-level or slide fields are refused", () => {
    expectInvalid({ result: parseInsertHtmlBody({ body: { ...bodyWith({}), accessToken: "x" }, idPrefix: PREFIX }), name: "top level" });
    expectInvalid({ result: parseInsertHtmlBody({ body: bodyWith({ slides: [{ requests: [], diagrams: [], notes: "x" }] }), idPrefix: PREFIX }), name: "slide" });
    expectInvalid({ result: parseInsertHtmlBody({ body: "not an object", idPrefix: PREFIX }), name: "a string" });
  });
});

/** Requests for one 1280x720 slide through the product converter's pure stage (no browser). */
function converterRequests(): readonly SlidesApiRequest[] {
  const cell = (text: string, x: number, y: number): Readonly<Record<string, unknown>> => ({
    text,
    isHeader: y === 300,
    bounds: { x, y, w: 200, h: 40 },
    padding: { top: 8, right: 12, bottom: 8, left: 12 },
    bgColor: y === 300 ? "#1e88e5" : null,
    style: { fontFamily: "Arial", fontSize: 14, color: "#333333", lineHeight: 16.8, borderWidth: 1, borderColor: "#dddddd", borderStyle: "solid", borderUniform: true },
  });
  const elements: readonly Readonly<Record<string, unknown>>[] = [
    { type: "rect", bounds: { x: 0, y: 0, w: 1280, h: 720 }, fill: "#f5f5f5", fillAlpha: 1 },
    { type: "rect", bounds: { x: 100, y: 50, w: 200, h: 100 }, fill: "#1e88e5", fillAlpha: 1, borderWidth: 2, borderColor: "#333333", borderUniform: true, borderStyle: "dashed", borderRadius: 12 },
    { type: "text", bounds: { x: 120, y: 80, w: 400, h: 60 }, text: "Bold 48px", style: { fontFamily: "Arial, sans-serif", fontSize: 48, fontWeight: "bold", color: "#333333", textAlign: "left", lineHeight: 57.6 } },
    { type: "line", bounds: { x: 100, y: 200, w: 400, h: 0 }, x1: 100, y1: 200, x2: 500, y2: 200, color: "#999999", strokeWidth: 2, dashType: "solid" },
    { type: "list", bounds: { x: 700, y: 100, w: 500, h: 200 }, ordered: false, listStyleType: "disc", items: [{ text: "First", level: 0, fontSize: 20, fontFamily: "Arial", color: "#000000" }, { text: "Nested", level: 1, fontSize: 18, fontFamily: "Arial", color: "#000000" }] },
    { type: "table", bounds: { x: 100, y: 300, w: 400, h: 80 }, borderCollapse: "collapse", rows: [[cell("Name", 100, 300), cell("Value", 300, 300)], [cell("Alpha", 100, 340), cell("1", 300, 340)]] },
    { type: "image", bounds: { x: 600, y: 400, w: 100, h: 100 }, tag: "img", src: "https://example.com/photo.png" },
    { type: "image", bounds: { x: 720, y: 400, w: 50, h: 50 }, tag: "img", src: `data:image/png;base64,${PNG.toString("base64")}` },
    { type: "image", bounds: { x: 800, y: 400, w: 100, h: 100 }, tag: "img", src: `data:image/jpeg;base64,${JPEG_BASE64}` },
  ];
  const extraction = parseExtraction({ viewport: { w: 1280, h: 720 }, elementCount: elements.length, elements });
  const result = emitSlideRequests({ extraction, pageObjectId: "placeholder-page", objectIdPrefix: "p_conv_" });
  const kinds = new Set(result.requests.map((request) => Object.keys(request).find((key) => key !== "sashaStageImage")));
  // The fixture is only worth something if it reaches the kinds the parser has rules for.
  for (const kind of ["createShape", "createLine", "createImage", "createTable", "insertText", "updateShapeProperties", "updateLineProperties", "updateTextStyle", "updateParagraphStyle", "createParagraphBullets", "updateTableColumnProperties", "updateTableRowProperties", "updateTableCellProperties"]) {
    assert.ok(kinds.has(kind), `the converter fixture emits ${kind} (got ${[...kinds].join(", ")})`);
  }
  return result.requests;
}

function bodyWith(overrides: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return { presentation: PRESENTATION_ID, position: { kind: "end" }, slides: [{ requests: [], diagrams: [] }], ...overrides };
}

function parseSlideRequests(requests: readonly unknown[]): InsertParse {
  return parseInsertHtmlBody({ body: bodyWith({ slides: [{ requests, diagrams: [] }] }), idPrefix: PREFIX });
}

function expectOk(result: InsertParse): ParsedInsert {
  if (result.kind === "invalid") assert.fail(`expected a valid insert, got: ${result.message}`);
  return result.insert;
}

function expectInvalid(options: Readonly<{ result: InsertParse; name: string }>): void {
  assert.equal(options.result.kind, "invalid", `${options.name} must be refused`);
}

function requestOf(planned: PlannedRequest): JsonObject {
  switch (planned.kind) {
    case "ready":
      return planned.request;
    case "stagedImage":
      return { createImage: planned.createImage };
    default:
      return assertNever(planned);
  }
}

function shape(objectId: string): Readonly<Record<string, unknown>> {
  return { objectId, shapeType: "RECTANGLE", elementProperties: elementProperties() };
}

function elementProperties(): Readonly<Record<string, unknown>> {
  return { pageObjectId: "placeholder-page", size: { width: { magnitude: 100, unit: "EMU" }, height: { magnitude: 100, unit: "EMU" } }, transform: transform() };
}

function transform(): Readonly<Record<string, unknown>> {
  return { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, unit: "EMU" };
}

/** Every `objectId` value anywhere in the requests (creates and references alike). */
function objectIdsIn(requests: readonly JsonObject[]): readonly string[] {
  const found: string[] = [];
  JSON.stringify(requests, (key, value: unknown) => {
    if (key === "objectId" && typeof value === "string") found.push(value);
    return value;
  });
  return found;
}

function pageIdsIn(requests: readonly JsonObject[]): readonly string[] {
  const found: string[] = [];
  JSON.stringify(requests, (key, value: unknown) => {
    if (key === "pageObjectId" && typeof value === "string") found.push(value);
    return value;
  });
  return found;
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
