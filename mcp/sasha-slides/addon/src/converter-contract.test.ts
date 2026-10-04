// The converter boundary, against the REAL `mcp/sasha-slides/converter/` types.
//
// This is the test the extension could not have: its converter-contract.ts was written before the
// converter existed, so `normalizeUnsupported` sniffed four spellings per field and nothing could
// say which was right. Here the fixtures below are typed as the converter's own
// `UnsupportedFeature`, so a rename in the converter breaks THIS FILE at compile time rather than
// silently degrading every anomaly to "unsupported" with a whole-slide box at runtime.

import assert from "node:assert/strict";
import test from "node:test";
import type { UnsupportedFeature as ConverterUnsupportedFeature } from "../../converter/index.ts";
import { normalizeUnsupported, pickerRegionOf } from "./converter-contract.ts";
import { WHOLE_SLIDE, isFractionalRegion, serializePick } from "./protocol.ts";

const gradient: ConverterUnsupportedFeature = {
  kind: "gradient-fill",
  fallback: "solid-approximation",
  gradientType: "linear",
  approximatedAs: "#336699",
  stopCount: 3,
  region: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 },
  elementType: "box",
  domIndex: 7,
};

const letterSpacing: ConverterUnsupportedFeature = {
  kind: "letter-spacing",
  fallback: "omitted",
  trackingPx: 2.5,
  // A collapsed element: zero height is legal for the converter and FATAL for PICK.
  region: { x: 0.4, y: 0.5, w: 0.2, h: 0 },
  elementType: "text",
  domIndex: null,
};

test("an unsupported entry keeps its kind, its sentence and its own region", () => {
  assert.deepEqual(normalizeUnsupported([gradient]), [
    {
      feature: "gradient-fill",
      note: "linear gradient (3 stops) flattened to #336699 — Slides shape fills are solid only",
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 },
    },
  ]);
});

test("a degenerate region widens to the whole slide so PICK stays writable", () => {
  const normalized = normalizeUnsupported([letterSpacing]);
  assert.deepEqual(normalized[0]?.region, WHOLE_SLIDE);
  assert.equal(normalized[0]?.feature, "letter-spacing");
  assert.match(normalized[0]?.note ?? "", /letter-spacing 2\.5px dropped/);

  // The point of that widening: a converter-seeded anomaly must never make the user's whole
  // decision unserializable.
  assert.equal(
    serializePick({
      protocolVersion: 1,
      proposalId: "p_1",
      picked: 1,
      decidedAt: "2026-10-03T12:00:21.000Z",
      insertedObjectIds: [],
      anomalies: normalized.map((feature) => ({ index: 1, note: feature.note, region: feature.region })),
    }).kind,
    "ok",
  );
});

test("pickerRegionOf passes a valid fractional box through untouched", () => {
  const region = { x: 0, y: 0, w: 1, h: 1 };
  assert.deepEqual(pickerRegionOf(region), region);
  assert.ok(isFractionalRegion(pickerRegionOf({ x: 0.9, y: 0, w: 0.5, h: 0.5 })), "overflowing box is widened");
  assert.ok(isFractionalRegion(pickerRegionOf({ x: -1, y: 0, w: 0.5, h: 0.5 })), "negative origin is widened");
});

test("normalizing is total: every entry in, every entry out, in order", () => {
  const normalized = normalizeUnsupported([gradient, letterSpacing, gradient]);
  assert.deepEqual(
    normalized.map((feature) => feature.feature),
    ["gradient-fill", "letter-spacing", "gradient-fill"],
  );
  assert.deepEqual(normalizeUnsupported([]), []);
});
