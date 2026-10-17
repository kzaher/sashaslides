// THE PNG EXPORT REQUEST (export-request.ts): the presentation, the 1-based inclusive range and
// "leave out skipped slides", checked before anything is sent.

import assert from "node:assert/strict";
import test from "node:test";
import { EXPORT_PNG_LIMITS } from "../../../../mcp/sasha-slides/google-slides/insert-html-contract.ts";
import { buildExportRequest, exportFileName, type ExportForm } from "./export-request.ts";

const PRESENTATION_ID = "1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY";
const FORM: ExportForm = { presentationText: `https://docs.google.com/presentation/d/${PRESENTATION_ID}/edit`, fromText: "", toText: "", skipHidden: true };

test("blank bounds export every slide; the address becomes the id", () => {
  assert.deepEqual(buildExportRequest(FORM), { kind: "valid", value: { presentation: PRESENTATION_ID, from: null, to: null, skipHidden: true } });
});

test("a range is 1-based and inclusive; either bound may be left open", () => {
  assert.deepEqual(buildExportRequest({ ...FORM, fromText: "2", toText: "5", skipHidden: false }), { kind: "valid", value: { presentation: PRESENTATION_ID, from: 2, to: 5, skipHidden: false } });
  assert.deepEqual(buildExportRequest({ ...FORM, fromText: "7" }), { kind: "valid", value: { presentation: PRESENTATION_ID, from: 7, to: null, skipHidden: true } });
});

test("a reversed range, a bad bound, a missing presentation and an over-long range are refused", () => {
  assert.deepEqual(buildExportRequest({ ...FORM, fromText: "5", toText: "2" }), { kind: "invalid", message: "“From” must not be after “To”." });
  assert.deepEqual(buildExportRequest({ ...FORM, toText: "0" }), { kind: "invalid", message: "“To” must be a slide number from 1, or blank." });
  assert.deepEqual(buildExportRequest({ ...FORM, presentationText: "" }), { kind: "invalid", message: "Enter the presentation's address or id." });
  const last = EXPORT_PNG_LIMITS.maximumSlides + 1;
  assert.deepEqual(buildExportRequest({ ...FORM, fromText: "1", toText: String(last) }), {
    kind: "invalid",
    message: `At most ${EXPORT_PNG_LIMITS.maximumSlides} slides per export; this range has ${last}.`,
  });
});

test("the zip is named after the presentation and the range", () => {
  assert.equal(exportFileName({ presentation: PRESENTATION_ID, from: null, to: null, skipHidden: true }), "slides-1xegFC0RQiZd-all.zip");
  assert.equal(exportFileName({ presentation: PRESENTATION_ID, from: 3, to: null, skipHidden: true }), "slides-1xegFC0RQiZd-3-end.zip");
});
