// PASTED MARKUP'S STYLES (browser-services.ts `pastedRunStyleOf`): what one element of a paste
// contributes to its runs, read from its tag and its inline style as the browser reports it. Node
// has no DOM, so each element here is the part of one the reader looks at.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { literalColour } from "../../contracts/style.ts";
import { pastedRunStyleOf, type PastedElement } from "./browser-services.ts";

function element(style: Partial<PastedElement["style"]>, tagName = "SPAN"): PastedElement {
  return { tagName, getAttribute: () => null, style: { fontWeight: "", fontStyle: "", textDecoration: "", fontSize: "", color: "", ...style } };
}

describe("a pasted element's text colour", () => {
  it("rgb() is kept, opaque", () => {
    assert.deepEqual(pastedRunStyleOf(element({ color: "rgb(255, 0, 0)" })).colour, literalColour({ hexadecimal: "#ff0000", alpha: 1 }));
  });

  it("rgba() is kept with its alpha: browsers report a translucent colour, and #rrggbbaa, this way", () => {
    assert.deepEqual(pastedRunStyleOf(element({ color: "rgba(28, 35, 51, 0.5)" })).colour, literalColour({ hexadecimal: "#1c2333", alpha: 0.5 }));
  });

  it("control: a colour the browser reports by keyword is not taken", () => {
    assert.equal(pastedRunStyleOf(element({ color: "currentcolor" })).colour, undefined);
  });
});

describe("a pasted element's other run styles", () => {
  it("bold by tag or by weight, italic, underline and a point size in slide units", () => {
    assert.equal(pastedRunStyleOf(element({}, "STRONG")).fontWeight, 700);
    const styled = pastedRunStyleOf(element({ fontWeight: "600", fontStyle: "italic", textDecoration: "underline", fontSize: "18pt" }));
    assert.deepEqual([styled.fontWeight, styled.fontStyle, styled.underline, styled.fontSize], [700, "italic", true, 32]);
  });
});
