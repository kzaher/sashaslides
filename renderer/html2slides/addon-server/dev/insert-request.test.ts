// THE INSERT REQUEST the page builds from its converted queue (insert-request.ts), against the
// connector's wire contract (google-slides/insert-html-contract.ts).

import assert from "node:assert/strict";
import test from "node:test";
import { STAGED_IMAGE_FIELD, type SlidesApiRequest } from "../../../../mcp/sasha-slides/converter/index.ts";
import { INSERT_HTML_LIMITS, type InsertHtmlRequestBody } from "../../../../mcp/sasha-slides/google-slides/insert-html-contract.ts";
import { buildInsertRequest, checkedPosition, checkedPresentationId, insertSlideOf, positiveIntegerOf, stagedImageCount, type Checked } from "./insert-request.ts";
import type { ConvertedSlide } from "./queue-state.ts";

const PRESENTATION_ID = "1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY";

/** Test-only widening: these tests check that the page passes requests through untouched, not their shape. */
function request(value: Readonly<Record<string, unknown>>): SlidesApiRequest {
  return value as unknown as SlidesApiRequest;
}


function slide(overrides: Partial<ConvertedSlide> = {}): ConvertedSlide {
  return {
    requests: [request({ createShape: { objectId: "dev1ab_shape1", shapeType: "RECTANGLE", elementProperties: { pageObjectId: "sasha_dev_page_slide" } } })],
    unsupported: [],
    elementCount: 1,
    malformedCount: 0,
    drawioDiagrams: [],
    elapsedMilliseconds: 5,
    ...overrides,
  };
}

function valueOf<TValue>(checked: Checked<TValue>): TValue {
  switch (checked.kind) {
    case "valid":
      return checked.value;
    case "invalid":
      throw new Error(`expected a valid value, got: ${checked.message}`);
  }
}

function messageOf<TValue>(checked: Checked<TValue>): string {
  switch (checked.kind) {
    case "valid":
      throw new Error("expected a refusal");
    case "invalid":
      return checked.message;
  }
}

test("a ready request carries the presentation id, the position and every slide with its requests and diagrams, in order", () => {
  const diagram = { objectId: "dev2cd_image1", diagramId: "d0123abcd", version: "1", xml: "<mxfile/>" };
  const ready = valueOf(
    buildInsertRequest({
      presentationText: `https://docs.google.com/presentation/d/${PRESENTATION_ID}/edit#slide=id.p`,
      position: { kind: "end" },
      slides: [slide(), slide({ drawioDiagrams: [diagram] })],
    }),
  );
  const parsed = JSON.parse(ready.bodyText) as InsertHtmlRequestBody;
  assert.deepEqual(parsed, ready.body, "the text is the body");
  assert.equal(ready.body.presentation, PRESENTATION_ID);
  assert.deepEqual(ready.body.position, { kind: "end" });
  assert.equal(ready.body.slides.length, 2);
  assert.deepEqual(ready.body.slides[1]?.diagrams, [{ objectId: "dev2cd_image1", diagramId: "d0123abcd", xml: "<mxfile/>" }], "the version stays on the page");
  assert.equal(ready.bodyBytes, new TextEncoder().encode(ready.bodyText).byteLength);
});

test("the staged-image sidecar travels with its createImage request untouched", () => {
  const staged = request({ createImage: { objectId: "dev1_image1", url: "https://staged.sasha-slides.invalid/image" }, [STAGED_IMAGE_FIELD]: { fileName: "dev1_image1.png", mimeType: "image/png", base64: "iVBORw0KGgo=" } });
  const ready = valueOf(buildInsertRequest({ presentationText: PRESENTATION_ID, position: { kind: "end" }, slides: [slide({ requests: [staged] })] }));
  assert.deepEqual(ready.body.slides[0]?.requests[0], staged);
  assert.equal(stagedImageCount(insertSlideOf(slide({ requests: [staged, staged] }))), 2);
});

test("'as slide N' inserts at index N - 1; anything but a whole number from 1 is refused", () => {
  assert.deepEqual(valueOf(checkedPosition({ kind: "atSlide", slideNumberText: " 3 " })), { kind: "index", index: 2 });
  assert.deepEqual(valueOf(checkedPosition({ kind: "atSlide", slideNumberText: "1" })), { kind: "index", index: 0 });
  for (const text of ["0", "-1", "1.5", "two", "", "1e3"]) assert.match(messageOf(checkedPosition({ kind: "atSlide", slideNumberText: text })), /whole number/, text);
  assert.equal(positiveIntegerOf("12"), 12);
  assert.equal(positiveIntegerOf("99999999999999999999"), null, "past a safe integer");
});

test("the presentation is an editor address, a Drive address or a bare id", () => {
  assert.equal(valueOf(checkedPresentationId(`https://docs.google.com/presentation/u/1/d/${PRESENTATION_ID}/edit`)), PRESENTATION_ID);
  assert.equal(valueOf(checkedPresentationId(`https://docs.google.com/open?id=${PRESENTATION_ID}`)), PRESENTATION_ID);
  assert.equal(valueOf(checkedPresentationId(`  ${PRESENTATION_ID}\n`)), PRESENTATION_ID);
  assert.match(messageOf(checkedPresentationId("")), /Enter the presentation/);
  assert.match(messageOf(checkedPresentationId("https://example.com/deck")), /not a Google Slides address/);
});

test("an empty queue, too many slides, too many requests or images, and an oversized body are refused before sending", () => {
  const base = { presentationText: PRESENTATION_ID, position: { kind: "end" } } as const;
  assert.match(messageOf(buildInsertRequest({ ...base, slides: [] })), /Nothing is converted/);
  const many = Array.from({ length: INSERT_HTML_LIMITS.maximumSlides + 1 }, () => slide());
  assert.match(messageOf(buildInsertRequest({ ...base, slides: many })), new RegExp(`At most ${INSERT_HTML_LIMITS.maximumSlides} slides`));
  const busy = slide({ requests: Array.from({ length: INSERT_HTML_LIMITS.maximumRequestsPerSlide + 1 }, () => request({ insertText: { objectId: "x", text: "a" } })) });
  assert.match(messageOf(buildInsertRequest({ ...base, slides: [slide(), busy] })), /Slide 2 has more than/);
  const image = request({ createImage: { objectId: "i" }, [STAGED_IMAGE_FIELD]: { fileName: "i.png", mimeType: "image/png", base64: "AA==" } });
  const pictures = slide({ requests: Array.from({ length: INSERT_HTML_LIMITS.maximumStagedImagesPerSlide + 1 }, () => image) });
  assert.match(messageOf(buildInsertRequest({ ...base, slides: [pictures] })), /embedded images/);
  const huge = request({ createImage: { objectId: "h" }, [STAGED_IMAGE_FIELD]: { fileName: "h.png", mimeType: "image/png", base64: "A".repeat(INSERT_HTML_LIMITS.maximumBodyBytes) } });
  assert.match(messageOf(buildInsertRequest({ ...base, slides: [slide({ requests: [huge] })] })), /over the 40\.0 MB limit/);
});

test("a bad address or position is reported before the queue is looked at", () => {
  assert.match(messageOf(buildInsertRequest({ presentationText: "nope", position: { kind: "end" }, slides: [] })), /not a Google Slides address/);
  assert.match(messageOf(buildInsertRequest({ presentationText: PRESENTATION_ID, position: { kind: "atSlide", slideNumberText: "x" }, slides: [] })), /whole number/);
});
