// THE SLIDE PAGE EXPORT, asserted as text: every slide of the sample deck becomes one complete
// 1280 x 720 page holding every element the slide has, each style feature the renderer draws shows
// up in it, fonts and images are wired, and the inline layout pass runs and marks the page ready.
// The pixel comparison with the editor's own drawing is e2e/export/export-comparison.ts.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { assertNever } from "../contracts/assert-never.ts";
import type { DocumentSnapshot, ElementSnapshot } from "../contracts/document.ts";
import type { AssetId } from "../contracts/ids.ts";
import { literalColour } from "../contracts/style.ts";
import { sampleDeck } from "../view/sample/sample-deck.ts";
import { IdMinter, documentSnapshot, fixtureAssetId, fixtureDeckId, groupElement, plainBody, shapeElement, slideSnapshot } from "../view/sample/snapshot-builders.ts";
import { EXPORT_PAGE_SIZE, EXPORT_READY_ATTRIBUTE, fontStylesheetAddresses, pagePlacement, renderDeckHtml, renderSlideHtml, shrinkTargetsOf } from "./slide-html.ts";

const PHOTO = fixtureAssetId("export-photo");
const PHOTO_ADDRESS = "data:image/png;base64,iVBORw0KGgo=";
const assetAddress = (assetId: AssetId): string => (assetId === PHOTO ? PHOTO_ADDRESS : `data:image/png;base64,missing-${assetId}`);
const deck = sampleDeck({ deckId: fixtureDeckId("export"), imageAssetId: PHOTO, extraSlideCount: 2 });

describe("every slide of the sample deck as a page", () => {
  const pages = renderDeckHtml({ snapshot: deck, assetAddress });

  it("one page per slide, in presentation order", () => {
    assert.deepEqual(pages.map((page) => page.slideId), deck.slides.map((slide) => slide.id));
  });

  deck.slides.forEach((slide, index) => {
    it(`slide ${index + 1} is a complete 1280 x 720 page holding every element it has`, () => {
      const page = pages[index]?.html ?? "";
      assert.match(page, /^<!doctype html>\n<html lang="en">/);
      assert.match(page, /<meta charset="utf-8">/);
      assert.match(page, /html,body\{margin:0;padding:0;width:1280px;height:720px;overflow:hidden/);
      assert.match(page, new RegExp(`data-sasha-slide-id="${slide.id}"`));
      assert.match(page, /width:1280px;height:720px/);
      for (const elementId of elementIdsOf(slide.elements)) assert.ok(page.includes(`data-sasha-element-id="${elementId}"`), `element ${elementId} is drawn`);
      assert.match(page, /<\/body>\n<\/html>\n$/);
    });
  });

  it("renderSlideHtml draws the same page renderDeckHtml does for that slide", () => {
    const slide = deck.slides[2];
    assert.ok(slide !== undefined);
    assert.equal(renderSlideHtml({ snapshot: deck, slideId: slide.id, assetAddress }), pages[2]?.html);
  });

  it("a slide the deck does not have is an error, not an empty page", () => {
    assert.throws(() => renderSlideHtml({ snapshot: deck, slideId: new IdMinter("Missing").next("slide"), assetAddress }), /has no slide/);
  });
});

describe("each style feature reaches the page", () => {
  const page = (slideIndex: number): string => {
    const slide = deck.slides[slideIndex];
    assert.ok(slide !== undefined);
    return renderSlideHtml({ snapshot: deck, slideId: slide.id, assetAddress });
  };
  const rows: readonly Readonly<{ label: string; slideIndex: number; pattern: RegExp }>[] = [
    { label: "text runs", slideIndex: 1, pattern: />Per-side borders</ },
    { label: "bold, italic and underline", slideIndex: 1, pattern: /font-weight:700.*font-style:italic.*text-decoration:underline/s },
    { label: "per-side borders", slideIndex: 1, pattern: /border-top:6px solid #b45309.*border-right:6px dashed #4338ca.*border-bottom:6px dotted #be185d.*border-left:0 none/s },
    { label: "a linear gradient", slideIndex: 1, pattern: /linear-gradient\(/ },
    { label: "a radial gradient", slideIndex: 1, pattern: /radial-gradient\(/ },
    { label: "per-corner radii", slideIndex: 1, pattern: /border-radius:48px 4px 48px 4px/ },
    { label: "a box shadow", slideIndex: 1, pattern: /box-shadow:0px 12px 24px 0px rgba\(28, 35, 51, 0.3\)/ },
    { label: "a vector shadow", slideIndex: 1, pattern: /filter:drop-shadow\(/ },
    { label: "a list marker", slideIndex: 1, pattern: /data-sasha-list-marker=""[^>]*>●</ },
    { label: "a line with arrowheads", slideIndex: 1, pattern: /<svg[^>]*>.*<marker[^>]*>.*<path d="M 680 420 L 1180 420"/s },
    { label: "an image through assetAddress", slideIndex: 1, pattern: new RegExp(`background-image:url\\(&quot;${PHOTO_ADDRESS.replace(/[+/.]/g, "\\$&")}&quot;\\)`) },
    { label: "the live slide number", slideIndex: 1, pattern: /data-sasha-automatic-text="slideNumber">2</ },
    { label: "a table", slideIndex: 2, pattern: /<table style="border-collapse:collapse;table-layout:fixed;width:1160px.*>Scripted transitions</s },
    { label: "a black background", slideIndex: 3, pattern: /class="sasha-slide-root" style="[^"]*background-color:#000000/ },
    { label: "a group wrapper", slideIndex: 4, pattern: /data-sasha-element-kind="group"/ },
    { label: "rotation and a flip", slideIndex: 4, pattern: /transform:rotate\(340deg\) scale\(1, -1\)/ },
  ];
  for (const row of rows) it(row.label, () => assert.match(page(row.slideIndex), row.pattern));

  it("control: a slide without a table has none", () => assert.doesNotMatch(page(0), /<table/));
});

describe("a rotated group", () => {
  const ids = new IdMinter("ExportGroup");
  const tilted = shapeElement({ id: ids.next("element"), frame: { x: 100, y: 100, width: 200, height: 100, rotation: 30, flipHorizontal: false, flipVertical: false }, style: { fill: { kind: "solid", colour: literalColour({ hexadecimal: "#ff0000", alpha: 1 }) } } });
  const plain = shapeElement({ id: ids.next("element"), box: { x: 400, y: 100, width: 200, height: 100 } });
  const slide = slideSnapshot({ ids, elements: [groupElement({ id: ids.next("element"), rotation: 45, children: [tilted, plain] })] });
  const snapshot = documentSnapshot({ deckId: fixtureDeckId("group"), title: "Group", slides: [slide] });
  const page = renderSlideHtml({ snapshot, slideId: slide.id, assetAddress });

  it("draws each child at its own rotation, inside the group wrapper", () => {
    assert.match(page, /data-sasha-element-kind="group".*transform:rotate\(30deg\).*background-color:#ff0000/s);
  });

  it("never rotates the wrapper itself (contracts/render.ts)", () => {
    assert.doesNotMatch(page, /rotate\(45deg\)/);
  });
});

describe("page size", () => {
  const rows: readonly Readonly<{ label: string; pageHeight: number; scale: number; offsetX: number; offsetY: number }>[] = [
    { label: "16:9 fills the page", pageHeight: 720, scale: 1, offsetX: 0, offsetY: 0 },
    { label: "4:3 fits the height and centres", pageHeight: 960, scale: 0.75, offsetX: 160, offsetY: 0 },
    { label: "a wide page fits the width and centres", pageHeight: 540, scale: 1, offsetX: 0, offsetY: 90 },
  ];
  for (const row of rows) {
    it(row.label, () => {
      assert.deepEqual(pagePlacement(row.pageHeight), { scale: row.scale, offsetX: row.offsetX, offsetY: row.offsetY });
    });
  }

  it("a 4:3 deck is still a 1280 x 720 page, the slide scaled inside", () => {
    const fourByThree: DocumentSnapshot = { ...deck, pageSize: { width: 1280, height: 960 } };
    const slide = deck.slides[0];
    assert.ok(slide !== undefined);
    const page = renderSlideHtml({ snapshot: fourByThree, slideId: slide.id, assetAddress });
    assert.equal(EXPORT_PAGE_SIZE.height, 720);
    assert.match(page, /left:160px;top:0px;width:1280px;height:960px;transform:scale\(0.75\)/);
  });

  it("control: a 16:9 deck has no wrapper", () => {
    assert.doesNotMatch(renderDeckHtml({ snapshot: deck, assetAddress })[0]?.html ?? "", /transform:scale\(/);
  });
});

describe("fonts", () => {
  it("a web family gets its regular face and each drawn face, one stylesheet each", () => {
    assert.deepEqual(fontStylesheetAddresses([{ family: "Open Sans", weight: 700, style: "italic" }]), [
      "https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400&display=block",
      "https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@1,700&display=block",
    ]);
  });

  it("a weight between steps is requested at the nearest one", () => {
    assert.deepEqual(fontStylesheetAddresses([{ family: "Inter", weight: 650, style: "normal" }]).at(-1), "https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,700&display=block");
  });

  it("control: a system family is never requested", () => {
    assert.deepEqual(fontStylesheetAddresses([{ family: "Arial", weight: 400, style: "normal" }]), []);
  });

  it("the sample deck's Manrope reaches the page as escaped links", () => {
    assert.match(renderDeckHtml({ snapshot: deck, assetAddress })[0]?.html ?? "", /<link rel="stylesheet" href="https:\/\/fonts.googleapis.com\/css2\?family=Manrope:ital,wght@0,700&amp;display=block">/);
  });

  it("a Georgia title draws Georgia, then Gelasio, then serif, and the page loads and waits for Gelasio", () => {
    const ids = new IdMinter("ExportGeorgia");
    const title = shapeElement({ id: ids.next("element"), preset: "textBox", text: plainBody("Part 2: Savings", { fontFamily: "Georgia", fontSize: 60 }) });
    const slide = slideSnapshot({ ids, elements: [title] });
    const page = renderSlideHtml({ snapshot: documentSnapshot({ deckId: fixtureDeckId("georgia"), title: "Georgia", slides: [slide] }), slideId: slide.id, assetAddress });
    assert.match(page, /font-family:&quot;Georgia&quot;, &quot;Gelasio&quot;, serif/);
    assert.match(page, /<link rel="stylesheet" href="https:\/\/fonts.googleapis.com\/css2\?family=Gelasio:ital,wght@0,400&amp;display=block">/);
    assert.match(page, /"fontQueries":\["normal 400 16px \\"Gelasio\\""\]/);
    assert.match(page, /"fontMetricOverrides":\[\{"family":"Gelasio","ascent":"91.699%","descent":"21.924%","lineGap":"0%"\}\]/);
    assert.doesNotMatch(page, /family=Georgia/);
  });
});

describe("the inline layout pass", () => {
  const ids = new IdMinter("ExportShrink");
  const shrinking = shapeElement({ id: ids.next("element"), preset: "textBox", textBox: { autofit: "shrinkText", paddingTop: 5, paddingBottom: 7 }, text: plainBody("Too much text") });
  const growing = shapeElement({ id: ids.next("element"), preset: "textBox", textBox: { autofit: "resizeShape" }, text: plainBody("Grows") });

  it("finds the boxes that shrink their text, inside groups too", () => {
    const grouped = groupElement({ id: ids.next("element"), children: [shrinking, growing] });
    assert.deepEqual(shrinkTargetsOf([grouped]), [{ elementId: shrinking.id, verticalPadding: 12 }]);
  });

  it("runs as an inline script without the module it came from, and marks the page ready", async () => {
    const slide = slideSnapshot({ ids, elements: [shrinking] });
    const page = renderSlideHtml({ snapshot: documentSnapshot({ deckId: fixtureDeckId("shrink"), title: "Shrink", slides: [slide] }), slideId: slide.id, assetAddress });
    const script = /<script>\n([\s\S]*)\n<\/script>/.exec(page)?.[1];
    assert.ok(script !== undefined, "the page has its layout script");
    assert.match(script, new RegExp(`"shrinkTargets":\\[\\{"elementId":"${shrinking.id}","verticalPadding":12\\}\\]`));
    const attributes = new Map<string, string>();
    const fakePage = {
      fonts: { load: () => Promise.resolve([]), ready: Promise.resolve() },
      // No element is found, so the pass skips the box; what is asserted is that the compiled source runs.
      querySelector: () => null,
      documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) },
    };
    const sandbox: Record<string, unknown> = { page: fakePage, setTimeout };
    // The browser's element class, which the pass narrows with; the name is the platform's, not ours.
    Reflect.set(sandbox, "HTMLElement", class {});
    const finished: unknown = runInNewContext(script.replace(/\(document, /, "(page, "), sandbox);
    // The pass is an async function from another realm: `Promise.resolve` adopts its promise.
    await Promise.resolve(finished);
    assert.equal(attributes.get(EXPORT_READY_ATTRIBUTE), "true");
  });

  it("a page title never carries markup from the deck title", () => {
    const slide = slideSnapshot({ ids, elements: [] });
    const page = renderSlideHtml({ snapshot: documentSnapshot({ deckId: fixtureDeckId("title"), title: "<b>Q3</b> & more", slides: [slide] }), slideId: slide.id, assetAddress });
    assert.match(page, /<title>&lt;b&gt;Q3&lt;\/b&gt; &amp; more - slide 1<\/title>/);
  });
});

/** Every element id in the slide, group children included. */
function elementIdsOf(elements: readonly ElementSnapshot[]): readonly string[] {
  return elements.flatMap((element): readonly string[] => {
    switch (element.kind) {
      case "group":
        return [element.id, ...elementIdsOf(element.children)];
      case "shape":
      case "image":
      case "line":
      case "table":
      case "unsupported":
        return [element.id];
      default:
        return assertNever(element);
    }
  });
}
