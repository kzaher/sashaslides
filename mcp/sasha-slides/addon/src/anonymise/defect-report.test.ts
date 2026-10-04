import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { anonymiseSlideHtml, ANONYMISER_VERSION } from "./anonymise-slide-html.ts";
import {
  defectReportFrom,
  findForbiddenStrings,
  previewDefectReport,
  redactIdentifiers,
  serializeDefectReport,
  type ConversionSummary,
  type ConvertForReport,
} from "./defect-report.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../e2e/fixtures");
const PRESENTATION_ID = "1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY";
const VERSIONS = { converter: "converter/3", addon: "addon/0.1.0", protocol: "sasha-slides/1" };

const anonymised = anonymiseSlideHtml({
  html: readFileSync(join(FIXTURES, "04-gradient-shadow.html"), "utf-8"),
  seed: "report-test-seed",
  identifiers: "preserve",
});

/** A conversion shaped exactly like the real converter's, ids and all. */
function conversionOf(prefix: string): ConversionSummary {
  const elementProperties = {
    pageObjectId: `${prefix}_page`,
    size: { width: { magnitude: 100, unit: "EMU" }, height: { magnitude: 50, unit: "EMU" } },
    transform: { scaleX: 1, scaleY: 1, translateX: 10, translateY: 20, unit: "EMU" },
  } as const;
  return {
    requests: [
      { createShape: { objectId: `${prefix}_shape_1`, shapeType: "TEXT_BOX", elementProperties } },
      { insertText: { objectId: `${prefix}_shape_1`, text: "substituted text", insertionIndex: 0 } },
      { createImage: { objectId: `${prefix}_image_1`, url: `https://drive.google.com/uc?id=${PRESENTATION_ID}`, elementProperties } },
    ],
    unsupported: [
      {
        kind: "gradient-fill",
        fallback: "solid-approximation",
        gradientType: "linear",
        approximatedAs: "#4facfe",
        stopCount: 4,
        region: { x: 0, y: 0, w: 1, h: 1 },
        elementType: "box",
        domIndex: 3,
      },
    ],
  };
}

const convert: ConvertForReport = async ({ html }) => {
  seenHtml.push(html);
  return conversionOf(`anon_${html.length}`);
};
const seenHtml: string[] = [];

test("the report is exactly six fields, and not one of them can say whose slide it was", async () => {
  const preview = await previewDefectReport({
    anonymised,
    identifierPolicy: "preserve",
    convert,
    note: "the gradient card loses its border on the right",
    versions: VERSIONS,
    mustNotContain: [PRESENTATION_ID],
  });
  const report = defectReportFrom(preview);
  assert.deepEqual(Object.keys(report).sort(), ["anonymisation", "conversion", "note", "reportVersion", "slideHtml", "versions"]);
  // No key ANYWHERE in the payload may name an identity. This is the guard that fails loudly when
  // somebody adds `fileId` or `userEmail` to a nested type.
  const forbiddenKey = /presentation|\bfile\b|fileid|account|user|email|owner|session|drive|folder|proposal|device|\bip\b/i;
  assert.deepEqual(keysOf(report).filter((key) => forbiddenKey.test(key)), []);
});

test("the payload is a pure projection of the preview: every string in it was on screen", async () => {
  const preview = await previewDefectReport({
    anonymised,
    identifierPolicy: "preserve",
    convert,
    note: "a note",
    versions: VERSIONS,
    mustNotContain: [],
  });
  const shown = JSON.stringify(preview);
  for (const value of stringsOf(defectReportFrom(preview))) {
    // The module's own version string is the ONE thing the projection adds, and it is a constant.
    if (value === ANONYMISER_VERSION) continue;
    assert.ok(shown.includes(JSON.stringify(value).slice(1, -1)), `the report carries a string the preview never showed: ${value}`);
  }
});

test("the conversion can only ever be the ANONYMISED slide's, because the builder does the converting", async () => {
  seenHtml.length = 0;
  await previewDefectReport({
    anonymised,
    identifierPolicy: "preserve",
    convert,
    note: "",
    versions: VERSIONS,
    mustNotContain: [],
  });
  assert.deepEqual(seenHtml, [anonymised.html]);
});

test("a forbidden string anywhere in the payload throws rather than returning a report", async () => {
  const leaky: ConvertForReport = async () => ({
    requests: [],
    unsupported: [
      {
        kind: "css-background-image",
        fallback: "omitted",
        cssValue: `url(https://example.invalid/${PRESENTATION_ID}/bg.png)`,
        region: { x: 0, y: 0, w: 1, h: 1 },
        elementType: "box",
        domIndex: 1,
      },
    ],
  });
  await assert.rejects(
    previewDefectReport({
      anonymised,
      identifierPolicy: "preserve",
      convert: leaky,
      note: "",
      versions: VERSIONS,
      mustNotContain: [PRESENTATION_ID],
    }),
    /forbidden string/,
  );
});

test("findForbiddenStrings is case-insensitive and ignores the empty needle", () => {
  assert.deepEqual(findForbiddenStrings({ payload: { a: "AbCdEf" }, forbidden: ["abcdef", ""] }), ["abcdef"]);
  assert.deepEqual(findForbiddenStrings({ payload: { a: "x" }, forbidden: ["y"] }), []);
});

test("every *Id in the converter's output is rewritten, consistently, and Google URLs are blanked", () => {
  const redacted = redactIdentifiers(conversionOf("staged_1AbCdEf"));
  const body = JSON.stringify(redacted.conversion);
  assert.doesNotMatch(body, /staged_1AbCdEf/);
  assert.doesNotMatch(body, /drive\.google\.com/);
  assert.equal(redacted.urlCount, 1);
  assert.equal(redacted.identifierCount, 3);
  // createShape's objectId and insertText's objectId were the same id, so they still are.
  const [createShape, insertText] = redacted.conversion.requests;
  const shapeId = (createShape as { createShape: { objectId: string } }).createShape.objectId;
  const textId = (insertText as { insertText: { objectId: string } }).insertText.objectId;
  assert.equal(shapeId, textId);
  assert.match(shapeId, /^anon-\d+$/);
  // Everything that is not an identifier is left alone.
  assert.match(body, /"text":"substituted text"/);
  assert.match(body, /"approximatedAs":"#4facfe"/);
});

test("the anonymiser's version is stamped by this module; a caller cannot set it", async () => {
  const preview = await previewDefectReport({
    anonymised,
    identifierPolicy: "rename",
    convert,
    note: "",
    versions: VERSIONS,
    mustNotContain: [],
  });
  const report = defectReportFrom(preview);
  assert.equal(report.versions.anonymiser, ANONYMISER_VERSION);
  assert.equal(report.versions.converter, "converter/3");
  assert.equal(report.anonymisation.identifierPolicy, "rename");
});

test("the serialized payload is JSON, and the HTML in it is the preview's HTML byte for byte", async () => {
  const preview = await previewDefectReport({
    anonymised,
    identifierPolicy: "preserve",
    convert,
    note: "needs \"quotes\" and a £ sign",
    versions: VERSIONS,
    mustNotContain: [],
  });
  const body = serializeDefectReport(defectReportFrom(preview));
  const parsed: unknown = JSON.parse(body);
  assert.equal((parsed as { slideHtml: string }).slideHtml, anonymised.html);
  assert.equal((parsed as { note: string }).note, 'needs "quotes" and a £ sign');
  assert.equal((parsed as { reportVersion: number }).reportVersion, 1);
});

test("the residual risks travel with the payload, so the recipient knows what it is NOT", async () => {
  const preview = await previewDefectReport({
    anonymised,
    identifierPolicy: "preserve",
    convert,
    note: "",
    versions: VERSIONS,
    mustNotContain: [],
  });
  const report = defectReportFrom(preview);
  assert.deepEqual(report.anonymisation.residualRisks, anonymised.residualRisks);
  assert.deepEqual(report.anonymisation.retainedIdentifiers, anonymised.retainedIdentifiers);
  assert.ok(report.anonymisation.carriers.length > 0);
});

function keysOf(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
}

function stringsOf(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(stringsOf);
}
