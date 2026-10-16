// THE DECK BOTH SIDES OF THE EXPORT COMPARISON DRAW: the sample deck (every element kind and style
// feature the renderer has) plus one slide for the behaviour only layout can show -- text that
// shrinks to fit, text that fits, and a table whose rows grow past their stored height. The node
// driver exports it with renderSlideHtml and the browser page mounts it with the editor's
// StaticSlide, so both must build the identical deck: this module is imported by each.

import type { DocumentSnapshot } from "../../src/contracts/document.ts";
import type { AssetId } from "../../src/contracts/ids.ts";
import { literalColour, themeColour } from "../../src/contracts/style.ts";
import { sampleSlides } from "../../src/view/sample/sample-deck.ts";
import { IdMinter, documentSnapshot, fixtureAssetId, fixtureDeckId, paragraph, plainBody, run, shapeElement, slideSnapshot, tableElement, textBody } from "../../src/view/sample/snapshot-builders.ts";

export const COMPARISON_PHOTO_ASSET: AssetId = fixtureAssetId("comparison-photo");

/** The sample photograph as a `data:` address, so neither page loads anything but fonts. */
export const COMPARISON_PHOTO_ADDRESS = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="360" viewBox="0 0 440 360"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#fde68a"/></linearGradient></defs><rect width="440" height="360" fill="url(#sky)"/><circle cx="330" cy="110" r="46" fill="#fb923c"/><path d="M0 260 L120 150 L230 250 L320 180 L440 270 L440 360 L0 360 Z" fill="#0e7490"/><path d="M0 300 L160 230 L300 300 L440 250 L440 360 L0 360 Z" fill="#047857"/></svg>`,
)}`;

/** Every asset of the deck resolves; anything else would be a bug in the deck. */
export function comparisonAssetAddress(assetId: AssetId): string {
  if (assetId !== COMPARISON_PHOTO_ASSET) throw new Error(`The comparison deck has no asset ${assetId}.`);
  return COMPARISON_PHOTO_ADDRESS;
}

export function comparisonDeck(): DocumentSnapshot {
  const ids = new IdMinter("Compare01");
  const ink = themeColour({ slot: "dark1", alpha: 1 });
  const listId = ids.next("list");
  const layout = slideSnapshot({
    ids,
    elements: [
      shapeElement({ id: ids.next("element"), preset: "textBox", box: { x: 60, y: 30, width: 1160, height: 80 }, placeholder: { role: "title", index: 0 }, text: plainBody("Shrinking text and growing rows", { fontSize: 48 }) }),
      shapeElement({
        id: ids.next("element"),
        preset: "rectangle",
        box: { x: 60, y: 130, width: 380, height: 160 },
        style: { fill: { kind: "solid", colour: literalColour({ hexadecimal: "#e0f2fe", alpha: 1 }) } },
        textBox: { autofit: "shrinkText", paddingTop: 8, paddingBottom: 8 },
        text: plainBody("This box holds far more text than fits at forty units, so the editor shrinks it in steps of two and a half percent until every line is inside the box.", { fontSize: 40 }),
      }),
      shapeElement({
        id: ids.next("element"),
        preset: "roundedRectangle",
        box: { x: 470, y: 130, width: 360, height: 160 },
        style: { fill: { kind: "solid", colour: literalColour({ hexadecimal: "#fde68a", alpha: 1 }) } },
        textBox: { autofit: "shrinkText", verticalAlignment: "middle" },
        text: textBody([
          paragraph([run("A shrinking list", { fontSize: 36, fontWeight: 700 })]),
          paragraph([run("first point", { fontSize: 32 })], { list: { kind: "list", listId, glyph: "decimal", level: 0 } }),
          paragraph([run("second point", { fontSize: 32 })], { list: { kind: "list", listId, glyph: "decimal", level: 0 } }),
          paragraph([run("nested point", { fontSize: 32, letterSpacing: 2 })], { list: { kind: "list", listId, glyph: "lowerAlphabetic", level: 1 }, spaceAbove: 6 }),
        ]),
      }),
      shapeElement({ id: ids.next("element"), preset: "textBox", box: { x: 860, y: 130, width: 360, height: 160 }, textBox: { autofit: "shrinkText" }, text: plainBody("Fits as it is", { fontSize: 32, colour: ink }) }),
      tableElement({
        ids,
        id: ids.next("element"),
        box: { x: 60, y: 330, width: 1160, height: 120 },
        headerFill: themeColour({ slot: "accent1", alpha: 1 }),
        texts: [
          ["Row", "Text"],
          ["Grows", "A cell with enough text to wrap onto several lines, which makes its row taller than the minimum the document stores for it, exactly as Slides does."],
        ],
      }),
    ],
  });
  const slides = [...sampleSlides({ deckId: fixtureDeckId("comparison"), imageAssetId: COMPARISON_PHOTO_ASSET, extraSlideCount: 0 }), layout];
  return documentSnapshot({ deckId: fixtureDeckId("comparison"), title: "Export comparison", slides });
}
