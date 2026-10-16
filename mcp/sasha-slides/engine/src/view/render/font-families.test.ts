// FONT FAMILY LISTS, asserted as values: a family the browser may lack (Georgia, Calibri, Cambria)
// is followed by its metric-compatible Google Fonts stand-in and a generic family of its own kind,
// so a serif title stays serif where the family is not installed (the reverse round trip of the
// test deck drew Georgia titles in Liberation Sans before this).

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { applyFontMetricOverrides, fontFamilyValue, fontMetricOverridesFor, fontStandInOf, genericFontFamilyOf, withFontStandIns, type MetricOverridableFace } from "./font-families.ts";

describe("fontFamilyValue", () => {
  it("Georgia is followed by Gelasio and the serif generic", () => {
    assert.equal(fontFamilyValue("Georgia"), '"Georgia", "Gelasio", serif');
  });

  it("Calibri and Cambria get their metric twins", () => {
    assert.equal(fontFamilyValue("Calibri"), '"Calibri", "Carlito", sans-serif');
    assert.equal(fontFamilyValue("cambria"), '"cambria", "Caladea", serif');
  });

  it("control: Arial and Helvetica Neue keep the plain sans-serif list", () => {
    assert.equal(fontFamilyValue("Arial"), '"Arial", sans-serif');
    assert.equal(fontFamilyValue("Helvetica Neue"), '"Helvetica Neue", sans-serif');
  });

  it("quotes and backslashes cannot break out of the value", () => {
    assert.equal(fontFamilyValue('Bad"Name\\'), '"BadName", sans-serif');
  });
});

describe("genericFontFamilyOf", () => {
  const rows: readonly (readonly [string, string])[] = [
    ["Times New Roman", "serif"],
    ["Noto Serif", "serif"],
    ["Roboto Slab", "serif"],
    ["Courier New", "monospace"],
    ["Roboto Mono", "monospace"],
    ["Source Code Pro", "monospace"],
    ["PT Sans", "sans-serif"],
    ["Open Sans", "sans-serif"],
    ["Noto Sans Serif Fallback", "sans-serif"],
  ];
  for (const [family, generic] of rows) {
    it(`${family} is ${generic}`, () => {
      assert.equal(genericFontFamilyOf(family), generic);
    });
  }
});

describe("withFontStandIns", () => {
  it("each Georgia face brings the same Gelasio face, right after it", () => {
    assert.deepEqual(
      withFontStandIns([
        { family: "Georgia", weight: 700, style: "italic" },
        { family: "Arial", weight: 400, style: "normal" },
      ]),
      [
        { family: "Georgia", weight: 700, style: "italic" },
        { family: "Gelasio", weight: 700, style: "italic" },
        { family: "Arial", weight: 400, style: "normal" },
      ],
    );
  });

  it("a face named twice, directly and as a stand-in, is requested once", () => {
    assert.deepEqual(
      withFontStandIns([
        { family: "Gelasio", weight: 400, style: "normal" },
        { family: "Georgia", weight: 400, style: "normal" },
      ]).map((face) => face.family),
      ["Gelasio", "Georgia"],
    );
  });

  it("control: a family without a stand-in has none", () => {
    assert.equal(fontStandInOf("Lora"), null);
  });
});

describe("fontMetricOverridesFor", () => {
  it("Georgia's stand-in takes Georgia's ascent, descent and line gap", () => {
    assert.deepEqual(fontMetricOverridesFor(["Arial", "Georgia", "georgia"]), [{ family: "Gelasio", ascent: "91.699%", descent: "21.924%", lineGap: "0%" }]);
  });

  it("control: a slide that names Gelasio itself keeps Gelasio's own metrics", () => {
    assert.deepEqual(fontMetricOverridesFor(["Georgia", "Gelasio"]), []);
  });

  it("control: a stand-in not measured against Google has no override", () => {
    assert.deepEqual(fontMetricOverridesFor(["Calibri", "Cambria"]), []);
  });
});

describe("applyFontMetricOverrides", () => {
  it("sets the override on every face of the stand-in, quoted family names included, and on no other", () => {
    const face = (family: string): MetricOverridableFace => ({ family, ascentOverride: "normal", descentOverride: "normal", lineGapOverride: "normal" });
    const faces = [face("Gelasio"), face('"Gelasio"'), face("Arial")];
    applyFontMetricOverrides({ forEach: (visit) => faces.forEach((each) => visit(each)) }, fontMetricOverridesFor(["Georgia"]));
    assert.deepEqual(
      faces.map((each) => [each.family, each.ascentOverride, each.descentOverride, each.lineGapOverride]),
      [
        ["Gelasio", "91.699%", "21.924%", "0%"],
        ['"Gelasio"', "91.699%", "21.924%", "0%"],
        ["Arial", "normal", "normal", "normal"],
      ],
    );
  });
});
