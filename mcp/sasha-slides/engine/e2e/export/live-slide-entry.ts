// THE EDITOR'S OWN DRAWING OF ONE SLIDE, for the export comparison: the comparison deck's slide
// `?slide=<index>` mounted with `StaticSlide` at scale 1 -- the component the presenter, the
// filmstrip and (through `SlideRoot`) the editing canvas draw with, layout effects and all -- with
// the deck's fonts loaded the way the editor loads them (browser-services.ts `loadDeckFonts`).
//
// It mounts only after the fonts have arrived, so text that shrinks to fit is measured with the
// real faces (the export's layout pass waits for them too), and marks the root
// `data-sasha-live-ready` two frames after mounting, when the layout effects have settled.

import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { deckFontFamilies, loadDeckFonts } from "../../src/view/application/browser-services.ts";
import { StaticSlide } from "../../src/view/render/static-slide.tsx";
import { comparisonAssetAddress, comparisonDeck } from "./comparison-deck.ts";

const deck = comparisonDeck();
const slideIndex = Number(new URLSearchParams(window.location.search).get("slide") ?? "0");
const slide = deck.slides[slideIndex];
const container = document.getElementById("slide");
if (slide === undefined || container === null) throw new Error(`No slide ${slideIndex} or no container.`);

loadDeckFonts({ page: document, document: deck, loaded: new Set() });
const faceLoads = [...deckFontFamilies(deck)].flatMap((family) => ["400", "700", "italic 400"].map((face) => document.fonts.load(`${face} 16px "${family}"`).catch(() => [])));
const deadline = new Promise((resolve) => setTimeout(resolve, 4000));
await Promise.race([Promise.all(faceLoads).then(() => document.fonts.ready), deadline]);
createRoot(container).render(createElement(StaticSlide, { slide, document: deck, slideNumber: slideIndex + 1, scale: 1, assetAddress: comparisonAssetAddress }));
requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.setAttribute("data-sasha-live-ready", "true")));
