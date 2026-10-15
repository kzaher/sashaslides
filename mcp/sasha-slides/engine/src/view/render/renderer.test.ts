// The renderer, asserted as static markup: each style feature produces exactly the inline styles
// SPEC.md section 8 names, in StaticSlide and in renderSlideMarkup alike (acceptance tests 1 and 2).
// Tests are parametric over the feature they claim, with a control row where it is absent.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DocumentSnapshot, ElementSnapshot, SlideSnapshot } from "../../contracts/document.ts";
import type { Frame } from "../../contracts/geometry.ts";
import { ASSET_ADDRESS_SCHEME, SLIDE_ROOT_CLASS } from "../../contracts/render.ts";
import { literalColour, themeColour, type DashStyle, type ImageFit, type ListGlyph, type RunStylePatch, type Stroke } from "../../contracts/style.ts";
import {
  IdMinter,
  documentSnapshot,
  fixtureAssetId,
  fixtureDeckId,
  groupElement,
  imageElement,
  paragraph,
  plainBody,
  run,
  shapeElement,
  slideSnapshot,
  textBody,
  unsupportedElement,
} from "../sample/snapshot-builders.ts";
import { renderSlideMarkup } from "./slide-markup.tsx";
import { StaticSlide } from "./static-slide.tsx";
import { BORDER_STYLE_FOR_DASH } from "./style-css.ts";
import { listMarkers, textStyleContextOf } from "./text-layout.ts";

const ids = new IdMinter("Renderer");
const ink = literalColour({ hexadecimal: "#1c2333", alpha: 1 });
const ASSET = fixtureAssetId("photograph");

describe("static markup per style feature", () => {
  it("per-side borders draw each side, and a missing side draws nothing", () => {
    const stroke = (hexadecimal: string, dash: DashStyle): Stroke => ({ width: 6, colour: literalColour({ hexadecimal, alpha: 1 }), dash });
    const markup = elementMarkup(shapeElement({ id: ids.next("element"), style: { border: { kind: "perSide", top: stroke("#b45309", "solid"), right: stroke("#4338ca", "dash"), bottom: stroke("#be185d", "dot"), left: null } } }));
    assert.match(markup, /border-top:6px solid #b45309/);
    assert.match(markup, /border-right:6px dashed #4338ca/);
    assert.match(markup, /border-bottom:6px dotted #be185d/);
    assert.match(markup, /border-left:0 none/);
  });

  const dashRows: readonly Readonly<{ dash: DashStyle; css: string }>[] = [
    { dash: "solid", css: "solid" },
    { dash: "dot", css: "dotted" },
    { dash: "dash", css: "dashed" },
    { dash: "longDash", css: "dashed" },
    { dash: "dashDot", css: "dashed" },
    { dash: "longDashDot", css: "dashed" },
  ];
  for (const row of dashRows) {
    it(`the ${row.dash} dash becomes a ${row.css} border on every side`, () => {
      assert.equal(BORDER_STYLE_FOR_DASH[row.dash], row.css);
      const markup = elementMarkup(shapeElement({ id: ids.next("element"), style: { border: { kind: "uniform", stroke: { width: 3, colour: ink, dash: row.dash } } } }));
      for (const side of ["top", "right", "bottom", "left"]) assert.match(markup, new RegExp(`border-${side}:3px ${row.css} #1c2333`));
    });
  }

  it("corner radius is uniform or per corner (top-left, top-right, bottom-right, bottom-left)", () => {
    const uniform = elementMarkup(shapeElement({ id: ids.next("element"), style: { cornerRadius: { kind: "uniform", radius: 18 } } }));
    const perCorner = elementMarkup(shapeElement({ id: ids.next("element"), style: { cornerRadius: { kind: "perCorner", topLeft: 48, topRight: 4, bottomRight: 30, bottomLeft: 0 } } }));
    const square = elementMarkup(shapeElement({ id: ids.next("element") }));
    assert.match(uniform, /border-radius:18px/);
    assert.match(perCorner, /border-radius:48px 4px 30px 0px/);
    assert.match(square, /border-radius:0px/);
  });

  it("linear and radial gradients become background images with their stops", () => {
    const stops = [{ colour: themeColour({ slot: "accent1", alpha: 1 }), offset: 0 }, { colour: literalColour({ hexadecimal: "#0e7490", alpha: 0.5 }), offset: 1 }];
    const linear = elementMarkup(shapeElement({ id: ids.next("element"), style: { fill: { kind: "linearGradient", angle: 90, stops } } }));
    const radial = elementMarkup(shapeElement({ id: ids.next("element"), style: { fill: { kind: "radialGradient", centreX: 0.35, centreY: 0.6, stops } } }));
    assert.match(linear, /background-image:linear-gradient\(90deg, #4338ca 0%, rgba\(14, 116, 144, 0.5\) 100%\)/);
    assert.match(radial, /background-image:radial-gradient\(ellipse farthest-corner at 35% 60%, #4338ca 0%, rgba\(14, 116, 144, 0.5\) 100%\)/);
  });

  const fitRows: readonly Readonly<{ fit: ImageFit; size: string; repeat: string }>[] = [
    { fit: "cover", size: "cover", repeat: "no-repeat" },
    { fit: "contain", size: "contain", repeat: "no-repeat" },
    { fit: "stretch", size: "100% 100%", repeat: "no-repeat" },
    { fit: "tile", size: "auto", repeat: "repeat" },
  ];
  for (const row of fitRows) {
    it(`an image fill set to ${row.fit} sizes its background ${row.size}`, () => {
      const markup = elementMarkup(shapeElement({ id: ids.next("element"), style: { fill: { kind: "image", assetId: ASSET, fit: row.fit, opacity: 1 } } }));
      assert.match(markup, new RegExp(`background-image:url\\(&quot;blob:test/${ASSET}&quot;\\)`));
      assert.match(markup, new RegExp(`background-size:${row.size.replace("%", "\\%")}`));
      assert.match(markup, new RegExp(`background-repeat:${row.repeat}`));
    });
  }

  it("an image fill with its own opacity becomes a layer of that opacity", () => {
    const markup = elementMarkup(shapeElement({ id: ids.next("element"), style: { fill: { kind: "image", assetId: ASSET, fit: "cover", opacity: 0.4 } } }));
    assert.match(markup, /position:absolute;inset:0;border-radius:inherit;opacity:0.4;background-image:url/);
  });

  it("a shadow is a box shadow on a box and a drop-shadow filter on a vector preset", () => {
    const shadow = { offsetX: 0, offsetY: 12, blur: 24, spread: 3, colour: literalColour({ hexadecimal: "#1c2333", alpha: 0.3 }) };
    const box = elementMarkup(shapeElement({ id: ids.next("element"), style: { shadow } }));
    const vector = elementMarkup(shapeElement({ id: ids.next("element"), preset: "ellipse", style: { shadow } }));
    const none = elementMarkup(shapeElement({ id: ids.next("element") }));
    assert.match(box, /box-shadow:0px 12px 24px 3px rgba\(28, 35, 51, 0.3\)/);
    assert.match(vector, /filter:drop-shadow\(0px 12px 12px rgba\(28, 35, 51, 0.3\)\)/);
    assert.doesNotMatch(none, /box-shadow|drop-shadow/);
  });

  const opacityRows: readonly Readonly<{ opacity: number; expected: RegExp | null }>[] = [
    { opacity: 0.85, expected: /opacity:0.85/ },
    { opacity: 1, expected: null },
  ];
  for (const row of opacityRows) {
    it(`opacity ${row.opacity} ${row.expected === null ? "writes no opacity" : "is written on the leaf"}`, () => {
      const markup = elementMarkup(shapeElement({ id: ids.next("element"), style: { opacity: row.opacity } }));
      if (row.expected === null) assert.doesNotMatch(markup, /opacity/);
      else assert.match(markup, row.expected);
    });
  }

  const transformRows: readonly Readonly<{ label: string; frame: Partial<Frame>; transform: string | null }>[] = [
    { label: "rotation and a horizontal flip", frame: { rotation: 30, flipHorizontal: true }, transform: "rotate(30deg) scale(-1, 1)" },
    { label: "a vertical flip alone", frame: { flipVertical: true }, transform: "scale(1, -1)" },
    { label: "rotation alone", frame: { rotation: 270 }, transform: "rotate(270deg)" },
    { label: "neither", frame: {}, transform: null },
  ];
  for (const row of transformRows) {
    it(`${row.label} ${row.transform === null ? "writes no transform" : `is one transform: ${row.transform}`}`, () => {
      const frame: Frame = { x: 10, y: 20, width: 300, height: 100, rotation: 0, flipHorizontal: false, flipVertical: false, ...row.frame };
      const markup = elementMarkup(shapeElement({ id: ids.next("element"), frame }));
      const leaf = /<div style="([^"]*)" data-sasha-element-id/.exec(markup)?.[1] ?? "";
      assert.match(leaf, /position:absolute;left:10px;top:20px;width:300px;height:100px/);
      if (row.transform === null) assert.doesNotMatch(leaf, /transform/);
      else assert.match(leaf, new RegExp(`transform:${row.transform.replace(/[()]/g, "\\$&")}`));
    });
  }

  const runRows: readonly Readonly<{ label: string; style: RunStylePatch; expected: RegExp }>[] = [
    { label: "bold", style: { fontWeight: 700 }, expected: /font-weight:700/ },
    { label: "italic", style: { fontStyle: "italic" }, expected: /font-style:italic/ },
    { label: "underline and strikethrough", style: { underline: true, strikethrough: true }, expected: /text-decoration:underline line-through/ },
    { label: "colour from the theme", style: { colour: themeColour({ slot: "accent3", alpha: 1 }) }, expected: /color:#be185d/ },
    { label: "highlight", style: { highlight: literalColour({ hexadecimal: "#fde68a", alpha: 1 }) }, expected: /background-color:#fde68a/ },
    { label: "superscript", style: { baselineOffset: "superscript", fontSize: 40 }, expected: /font-size:28px.*vertical-align:super/ },
    { label: "letter spacing", style: { letterSpacing: 2.5 }, expected: /letter-spacing:2.5px/ },
    { label: "small capitals", style: { textCase: "smallCaps" }, expected: /font-variant:small-caps/ },
    { label: "all capitals", style: { textCase: "allCaps" }, expected: /text-transform:uppercase/ },
    { label: "font family and size in slide units", style: { fontFamily: "Lora", fontSize: 42 }, expected: /font-family:&quot;Lora&quot;, sans-serif;font-size:42px/ },
  ];
  for (const row of runRows) {
    it(`a run with ${row.label} carries it inline`, () => {
      const styled = elementMarkup(shapeElement({ id: ids.next("element"), text: textBody([paragraph([run("styled", row.style)])]) }));
      const plain = elementMarkup(shapeElement({ id: ids.next("element"), text: textBody([paragraph([run("styled")])]) }));
      const styledRun = /<span style="([^"]*)" data-sasha-run-start="0">styled<\/span>/.exec(styled)?.[1] ?? "";
      const plainRun = /<span style="([^"]*)" data-sasha-run-start="0">styled<\/span>/.exec(plain)?.[1] ?? "";
      assert.match(styledRun, row.expected);
      assert.doesNotMatch(plainRun, row.expected);
    });
  }

  it("list markers are numbered per list id and level, across other paragraphs", () => {
    const first = ids.next("list");
    const second = ids.next("list");
    const item = (listId: typeof first, level: number, glyph: ListGlyph, text: string) => paragraph([run(text)], { list: { kind: "list", listId, glyph, level } });
    const body = textBody([
      item(first, 0, "decimal", "one"),
      item(second, 0, "upperAlphabetic", "other list"),
      item(first, 0, "decimal", "two"),
      item(first, 1, "lowerRoman", "two, nested"),
      item(first, 1, "lowerRoman", "two, nested again"),
      paragraph([run("not a list")]),
      item(first, 0, "decimal", "three"),
      item(first, 1, "lowerRoman", "three, nested restarts"),
      item(second, 0, "upperAlphabetic", "other list again"),
    ]);
    const element = shapeElement({ id: ids.next("element"), text: body });
    const document = singleSlideDocument([element]);
    assert.deepEqual(listMarkers(body, textStyleContextOf({ theme: document.theme, element })), ["1.", "A.", "2.", "i.", "ii.", null, "3.", "i.", "B."]);
    const markup = elementMarkup(element);
    assert.equal(markup.match(/data-sasha-list-marker=""/g)?.length, 8);
    assert.match(markup, /contenteditable="false" data-sasha-list-marker="" style="[^"]*">ii\.<\/span>/i);
  });

  const slideNumberRows = [3, 12];
  for (const slideNumber of slideNumberRows) {
    it(`the automatic slide number prints ${slideNumber} on slide ${slideNumber}`, () => {
      const element = shapeElement({ id: ids.next("element"), text: textBody([paragraph([run("Page "), { kind: "automaticText", field: "slideNumber", style: {} }])]) });
      const markup = staticMarkup({ elements: [element], slideNumber });
      assert.match(markup, new RegExp(`data-sasha-automatic-text="slideNumber">${slideNumber}</span>`));
    });
  }

  it("a link to a slide carries the slide id and its number, a web link opens safely", () => {
    const target = slideSnapshot({ ids, elements: [] });
    const element = shapeElement({
      id: ids.next("element"),
      text: textBody([paragraph([run("go", { link: { kind: "slide", slideId: target.id } }), run(" web", { link: { kind: "webAddress", address: "javascript:alert(1)" } })])]),
    });
    const source = slideSnapshot({ ids, elements: [element] });
    const document = documentSnapshot({ deckId: fixtureDeckId("deck_renderer"), title: "Links", slides: [source, slideSnapshot({ ids, elements: [] }), target] });
    const markup = renderToStaticMarkup(createElement(StaticSlide, { slide: source, document, slideNumber: 1, scale: 1, assetAddress: testAddress }));
    assert.match(markup, new RegExp(`<a href="#slide=3" style="[^"]*" data-sasha-link-slide-id="${target.id}">`));
    assert.match(markup, /href="https:\/\/alert\(1\)" target="_blank" rel="noopener noreferrer"/);
  });

  it("an unsupported element is a hatched placeholder that says why on hover", () => {
    const markup = elementMarkup(unsupportedElement({ id: ids.next("element"), box: { x: 5, y: 6, width: 70, height: 80 }, storedKind: "video" }));
    assert.match(markup, /title="Made with a newer version of Sasha[^"]*"/);
    assert.match(markup, /data-sasha-unsupported="video"/);
    assert.match(markup, /repeating-linear-gradient/);
  });

  it("an element holding a value from a newer version is drawn with the placeholder over it", () => {
    const flagged = elementMarkup(shapeElement({ id: ids.next("element"), unsupportedKeys: ["fill"] }));
    const control = elementMarkup(shapeElement({ id: ids.next("element") }));
    assert.match(flagged, /data-sasha-unsupported="fill"/);
    assert.doesNotMatch(control, /data-sasha-unsupported/);
  });

  it("the slide root carries the root class and resets inheritance before its own styles", () => {
    const markup = staticMarkup({ elements: [], slideNumber: 1 });
    assert.match(markup, new RegExp(`class="${SLIDE_ROOT_CLASS}" style="all:initial;display:block;position:relative;width:1280px;height:720px;overflow:hidden`));
  });
});

describe("groups and renderSlideMarkup", () => {
  const leftChild = shapeElement({ id: ids.next("element"), box: { x: 200, y: 220, width: 240, height: 200 } });
  const rotatedChild = shapeElement({ id: ids.next("element"), preset: "ellipse", frame: { x: 480, y: 240, width: 280, height: 200, rotation: 90, flipHorizontal: false, flipVertical: false }, text: plainBody("Bold", { fontWeight: 700 }) });
  const group = groupElement({ id: ids.next("element"), children: [leftChild, rotatedChild], rotation: 15 });
  const picture = imageElement({ id: ids.next("element"), assetId: ASSET, box: { x: 900, y: 100, width: 200, height: 150 } });
  const document = singleSlideDocument([group, picture]);
  const slide = document.slides[0];

  it("a group is a position absolute, inset 0 wrapper holding its children in slide coordinates", () => {
    const markup = elementMarkup(group);
    assert.match(markup, new RegExp(`^<div style="position:absolute;inset:0;pointer-events:none" data-sasha-element-id="${group.id}" data-sasha-element-kind="group"`));
    assert.match(markup, /left:200px;top:220px;width:240px;height:200px/);
    assert.match(markup, /left:480px;top:240px;width:280px;height:200px;box-sizing:border-box;transform:rotate\(90deg\)/);
    assert.doesNotMatch(markup, /rotate\(15deg\)/, "a group's own rotation never reaches the page");
  });

  it("renderSlideMarkup returns leaf records with unrotated frames, bounds and group paths", () => {
    assert.ok(slide !== undefined);
    const result = renderSlideMarkup({ slide, document, slideNumber: 1 });
    assert.deepEqual(result.elements.map((record) => [record.elementId, record.kind, record.groupPath]), [
      [leftChild.id, "shape", [group.id]],
      [rotatedChild.id, "shape", [group.id]],
      [picture.id, "image", []],
    ]);
    const rotated = result.elements[1];
    assert.deepEqual(rotated?.frame, rotatedChild.frame, "the unrotated frame, rotation kept separately");
    assert.ok(rotated !== undefined && Math.abs(rotated.bounds.width - 200) < 1e-9 && Math.abs(rotated.bounds.height - 280) < 1e-9, "bounds are rotated");
  });

  it("renderSlideMarkup refers to assets by token, never by address, and lists them", () => {
    assert.ok(slide !== undefined);
    const result = renderSlideMarkup({ slide, document, slideNumber: 1 });
    assert.match(result.markup, new RegExp(`url\\(&quot;${ASSET_ADDRESS_SCHEME}${ASSET}&quot;\\)`));
    assert.doesNotMatch(result.markup, /blob:/);
    assert.deepEqual(result.assetIds, [ASSET]);
  });

  it("renderSlideMarkup lists every font face its text draws with", () => {
    assert.ok(slide !== undefined);
    const result = renderSlideMarkup({ slide, document, slideNumber: 1 });
    const faces = result.fontFaces.map((face) => `${face.family} ${face.weight} ${face.style}`).sort();
    assert.deepEqual(faces, ["Manrope 400 normal", "Manrope 700 normal"]);
  });

  it("the markup is one unscaled root with every style inline", () => {
    assert.ok(slide !== undefined);
    const markup = renderSlideMarkup({ slide, document, slideNumber: 1 }).markup;
    assert.match(markup, new RegExp(`^<div class="${SLIDE_ROOT_CLASS}" style="all:initial`));
    assert.doesNotMatch(markup, /scale\(/);
  });
});

function testAddress(assetId: string): string {
  return `blob:test/${assetId}`;
}

function singleSlideDocument(elements: readonly ElementSnapshot[]): DocumentSnapshot {
  return documentSnapshot({ deckId: fixtureDeckId("deck_renderer"), title: "Renderer", slides: [slideSnapshot({ ids, elements })] });
}

/** One element's markup, inside StaticSlide (unscaled), with the slide root stripped. */
function elementMarkup(element: ElementSnapshot): string {
  const markup = staticMarkup({ elements: [element], slideNumber: 1 });
  const start = markup.indexOf("data-sasha-slide-id");
  const inner = markup.slice(markup.indexOf(">", start) + 1);
  return inner.slice(0, inner.length - "</div></div></div>".length);
}

function staticMarkup(options: Readonly<{ elements: readonly ElementSnapshot[]; slideNumber: number }>): string {
  const document = singleSlideDocument(options.elements);
  const slide: SlideSnapshot | undefined = document.slides[0];
  assert.ok(slide !== undefined);
  return renderToStaticMarkup(createElement(StaticSlide, { slide, document, slideNumber: options.slideNumber, scale: 1, assetAddress: testAddress }));
}
