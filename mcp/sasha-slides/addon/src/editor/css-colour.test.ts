// `getComputedStyle` speaks `rgb(…)`, the record and the swatch speak hex. One parser, tested at
// the edges that matter: translucency, full transparency, and values this cannot read at all.

import assert from "node:assert/strict";
import test from "node:test";
import { hexOfCssColour, isOpaqueHex, swatchValueOf } from "./css-colour.ts";

test("a computed rgb colour becomes the hex the contract's example record uses", () => {
  assert.equal(hexOfCssColour("rgb(43, 58, 143)"), "#2b3a8f");
  assert.equal(hexOfCssColour("rgb(255 255 255)"), "#ffffff");
});

test("translucency is kept as an eighth and ninth hex digit, never silently dropped", () => {
  // A glass card at 14% white is a design decision; `#ffffff` would be a different slide.
  assert.equal(hexOfCssColour("rgba(255, 255, 255, 0.14)"), "#ffffff24");
  assert.equal(hexOfCssColour("rgba(0, 0, 0, 0)"), "transparent");
});

test("a value this cannot read comes back unchanged rather than guessed at", () => {
  assert.equal(hexOfCssColour("linear-gradient(92deg, #fff 0%, #000 100%)"), "linear-gradient(92deg, #fff 0%, #000 100%)");
  assert.equal(hexOfCssColour("currentColor"), "currentColor");
  assert.equal(hexOfCssColour("#a8321e"), "#a8321e");
});

test("the swatch gets a 6-digit seed or a neutral, and never a value it cannot show", () => {
  assert.equal(swatchValueOf({ colour: "rgb(168, 50, 30)", fallback: "#000000" }), "#a8321e");
  assert.equal(swatchValueOf({ colour: "rgba(255, 255, 255, 0.14)", fallback: "#000000" }), "#ffffff");
  assert.equal(swatchValueOf({ colour: "transparent", fallback: "#ffffff" }), "#ffffff");
  assert.equal(isOpaqueHex("#ffffff24"), false);
  assert.equal(isOpaqueHex("#a8321e"), true);
});
