// THE SAMPLE DECK: one deck that exercises every style feature the renderer draws -- per-side
// borders and dashes, per-corner radii, linear and radial gradients, shadows, opacity, rotation and
// flips, vector presets, lists, links, the automatic slide number, a table, a group, a line with
// arrowheads, a black slide, an element from a "newer version", a slide of builds (a fade in, a fly in,
// a spin and a fly out) and a pair of slides that morph. The demo inserts it into a fresh
// document, the chrome harness renders it for screenshots, and the tests read single slides from it,
// so what the screenshots show is what the tests pin.

import type { DocumentSnapshot, SlideSnapshot } from "../../contracts/document.ts";
import type { AssetId, DeckId } from "../../contracts/ids.ts";
import { literalColour, themeColour, type Stroke } from "../../contracts/style.ts";
import {
  IdMinter,
  animationStep,
  documentSnapshot,
  groupElement,
  imageElement,
  lineElement,
  paragraph,
  plainBody,
  run,
  shapeElement,
  slideSnapshot,
  tableElement,
  textBody,
  unsupportedElement,
} from "./snapshot-builders.ts";

export type SampleDeckOptions = Readonly<{
  deckId: DeckId;
  /** An image the deck shows; null leaves the image slot as a hatched "not here yet" placeholder. */
  imageAssetId: AssetId | null;
  /** Plain slides appended after the showcase, for the filmstrip (virtualised past 40). */
  extraSlideCount: number;
}>;

export function sampleDeck(options: SampleDeckOptions): DocumentSnapshot {
  return documentSnapshot({ deckId: options.deckId, title: "Tidepool tour", slides: sampleSlides(options) });
}

/** The showcase slides, then `extraSlideCount` numbered ones. */
export function sampleSlides(options: SampleDeckOptions): readonly SlideSnapshot[] {
  const ids = new IdMinter("Sample01");
  const ink = themeColour({ slot: "dark1", alpha: 1 });
  const accent = themeColour({ slot: "accent1", alpha: 1 });
  const thick = (hexadecimal: string, dash: Stroke["dash"]): Stroke => ({ width: 6, colour: literalColour({ hexadecimal, alpha: 1 }), dash });

  const title = slideSnapshot({
    ids,
    background: { kind: "linearGradient", angle: 135, stops: [{ colour: literalColour({ hexadecimal: "#eef1f6", alpha: 1 }), offset: 0 }, { colour: literalColour({ hexadecimal: "#c7f0fb", alpha: 1 }), offset: 1 }] },
    notes: "Welcome everyone. This deck is drawn by the Sasha engine.",
    elements: [
      shapeElement({ id: ids.next("element"), preset: "textBox", box: { x: 140, y: 230, width: 1000, height: 120 }, placeholder: { role: "centredTitle", index: 0 }, text: plainBody("Sasha engine") }),
      shapeElement({ id: ids.next("element"), preset: "textBox", box: { x: 240, y: 370, width: 800, height: 80 }, placeholder: { role: "subtitle", index: 0 }, text: plainBody("Slides, editing and transitions in one place") }),
    ],
  });

  const listId = ids.next("list");
  const tableSlideId = ids.next("slide");
  const styles = slideSnapshot({
    ids,
    notes: "Every box style: per-side borders, corners, gradients, shadows.",
    elements: [
      shapeElement({ id: ids.next("element"), preset: "textBox", box: { x: 60, y: 30, width: 900, height: 80 }, placeholder: { role: "title", index: 0 }, text: plainBody("Styles", { fontSize: 56 }) }),
      shapeElement({
        id: ids.next("element"),
        preset: "rectangle",
        box: { x: 60, y: 140, width: 260, height: 160 },
        style: { fill: { kind: "solid", colour: literalColour({ hexadecimal: "#fde68a", alpha: 1 }) }, border: { kind: "perSide", top: thick("#b45309", "solid"), right: thick("#4338ca", "dash"), bottom: thick("#be185d", "dot"), left: null } },
        text: plainBody("Per-side borders", { fontSize: 26 }),
        textBox: { verticalAlignment: "middle" },
      }),
      shapeElement({
        id: ids.next("element"),
        preset: "rectangle",
        box: { x: 360, y: 140, width: 260, height: 160 },
        style: {
          fill: { kind: "linearGradient", angle: 90, stops: [{ colour: accent, offset: 0 }, { colour: themeColour({ slot: "accent2", alpha: 1 }), offset: 1 }] },
          cornerRadius: { kind: "perCorner", topLeft: 48, topRight: 4, bottomRight: 48, bottomLeft: 4 },
          shadow: { offsetX: 0, offsetY: 12, blur: 24, spread: 0, colour: literalColour({ hexadecimal: "#1c2333", alpha: 0.3 }) },
        },
        text: plainBody("Gradient, corners, shadow", { fontSize: 26, colour: themeColour({ slot: "light1", alpha: 1 }), fontWeight: 700 }),
        textBox: { verticalAlignment: "middle" },
      }),
      shapeElement({
        id: ids.next("element"),
        preset: "ellipse",
        box: { x: 660, y: 130, width: 220, height: 180 },
        style: { fill: { kind: "radialGradient", centreX: 0.35, centreY: 0.35, stops: [{ colour: literalColour({ hexadecimal: "#f9a8d4", alpha: 1 }), offset: 0 }, { colour: literalColour({ hexadecimal: "#7c3aed", alpha: 1 }), offset: 1 }] }, border: { kind: "uniform", stroke: thick("#1c2333", "solid") } },
        text: plainBody("Radial", { fontSize: 28, colour: themeColour({ slot: "light1", alpha: 1 }) }),
        textBox: { verticalAlignment: "middle" },
      }),
      shapeElement({
        id: ids.next("element"),
        preset: "fivePointStar",
        frame: { x: 930, y: 120, width: 220, height: 210, rotation: 12, flipHorizontal: true, flipVertical: false },
        style: { fill: { kind: "solid", colour: literalColour({ hexadecimal: "#fbbf24", alpha: 1 }) }, opacity: 0.85, shadow: { offsetX: 6, offsetY: 8, blur: 12, spread: 0, colour: literalColour({ hexadecimal: "#000000", alpha: 0.35 }) } },
      }),
      shapeElement({
        id: ids.next("element"),
        preset: "textBox",
        box: { x: 60, y: 350, width: 560, height: 300 },
        textBox: { autofit: "resizeShape" },
        text: textBody([
          paragraph([run("A bulleted point with ", { fontSize: 28 }), run("bold", { fontSize: 28, fontWeight: 700 }), run(", ", { fontSize: 28 }), run("italic", { fontSize: 28, fontStyle: "italic" }), run(" and ", { fontSize: 28 }), run("underlined", { fontSize: 28, underline: true })], { list: { kind: "list", listId, glyph: "disc", level: 0 } }),
          paragraph([run("Nested, ", { fontSize: 28 }), run("highlighted", { fontSize: 28, highlight: literalColour({ hexadecimal: "#fde68a", alpha: 1 }) })], { list: { kind: "list", listId, glyph: "circle", level: 1 } }),
          paragraph([run("A link to the table slide", { fontSize: 28, colour: accent, underline: true, link: { kind: "slide", slideId: tableSlideId } })], { list: { kind: "list", listId, glyph: "disc", level: 0 } }),
          paragraph([run("Slide ", { fontSize: 28 }), { kind: "automaticText", field: "slideNumber", style: { fontSize: 28, fontWeight: 700 } }, run(" of the tour", { fontSize: 28 })]),
        ]),
      }),
      lineElement({ id: ids.next("element"), start: { x: 680, y: 420 }, end: { x: 1180, y: 420 }, stroke: { width: 6, colour: ink, dash: "dash" }, startArrow: "oval", endArrow: "triangle" }),
      options.imageAssetId === null
        ? unsupportedElement({ id: ids.next("element"), box: { x: 680, y: 470, width: 220, height: 180 }, storedKind: "video" })
        : imageElement({ id: ids.next("element"), assetId: options.imageAssetId, box: { x: 680, y: 470, width: 220, height: 180 }, style: { cornerRadius: { kind: "uniform", radius: 24 } }, description: "A sample photograph" }),
      shapeElement({ id: ids.next("element"), preset: "rightArrow", box: { x: 940, y: 500, width: 240, height: 120 }, style: { fill: { kind: "solid", colour: themeColour({ slot: "accent4", alpha: 1 }) } } }),
    ],
  });

  const table = slideSnapshot({
    ids,
    id: tableSlideId,
    notes: "The table grows its rows with the text.",
    elements: [
      shapeElement({ id: ids.next("element"), preset: "textBox", box: { x: 60, y: 30, width: 900, height: 80 }, placeholder: { role: "title", index: 0 }, text: plainBody("A table", { fontSize: 56 }) }),
      tableElement({
        ids,
        id: ids.next("element"),
        box: { x: 60, y: 140, width: 1160, height: 300 },
        headerFill: themeColour({ slot: "dark1", alpha: 1 }),
        texts: [
          ["Feature", "Status", "Notes"],
          ["Per-side borders", "Milestone 1", "Exported as composed shapes"],
          ["Scripted transitions", "Milestone 1", "Run in an isolated frame on the editor's own site, once a person approved them"],
        ],
      }),
    ],
  });

  const dark = slideSnapshot({
    ids,
    background: { kind: "solid", colour: literalColour({ hexadecimal: "#000000", alpha: 1 }) },
    notes: "Menus stay readable over a black slide.",
    elements: [
      shapeElement({ id: ids.next("element"), preset: "textBox", box: { x: 80, y: 280, width: 1120, height: 140 }, text: plainBody("A black slide", { fontSize: 88, fontWeight: 700, colour: themeColour({ slot: "light1", alpha: 1 }) }), textBox: { verticalAlignment: "middle" } }),
    ],
  });

  const grouped = slideSnapshot({
    ids,
    transition: { kind: "builtin", effect: { effect: "fade" }, durationMilliseconds: 400, easing: "easeInOut" },
    elements: [
      shapeElement({ id: ids.next("element"), preset: "textBox", box: { x: 60, y: 30, width: 900, height: 80 }, placeholder: { role: "title", index: 0 }, text: plainBody("Groups keep their own rotation", { fontSize: 48 }) }),
      groupElement({
        id: ids.next("element"),
        rotation: 0,
        children: [
          shapeElement({ id: ids.next("element"), preset: "hexagon", box: { x: 200, y: 220, width: 240, height: 200 }, style: { fill: { kind: "solid", colour: themeColour({ slot: "accent2", alpha: 1 }) } } }),
          shapeElement({ id: ids.next("element"), preset: "cloud", box: { x: 480, y: 240, width: 280, height: 200 }, style: { fill: { kind: "solid", colour: themeColour({ slot: "accent3", alpha: 0.8 }) } } }),
        ],
      }),
      shapeElement({ id: ids.next("element"), preset: "roundedRectangle", frame: { x: 860, y: 260, width: 280, height: 180, rotation: 340, flipHorizontal: false, flipVertical: true }, style: { fill: { kind: "solid", colour: themeColour({ slot: "accent6", alpha: 1 }) } }, text: plainBody("Rotated and flipped", { fontSize: 28, colour: themeColour({ slot: "light1", alpha: 1 }) }), textBox: { verticalAlignment: "middle" } }),
    ],
  });

  const buildsTitle = shapeElement({ id: ids.next("element"), preset: "textBox", box: { x: 60, y: 30, width: 1000, height: 80 }, placeholder: { role: "title", index: 0 }, text: plainBody("Builds, one click at a time", { fontSize: 48 }) });
  const flyer = shapeElement({ id: ids.next("element"), preset: "roundedRectangle", box: { x: 160, y: 240, width: 300, height: 220 }, style: { fill: { kind: "solid", colour: accent } }, text: plainBody("Flies in, then spins", { fontSize: 26, colour: themeColour({ slot: "light1", alpha: 1 }) }), textBox: { verticalAlignment: "middle" } });
  const leaver = shapeElement({ id: ids.next("element"), preset: "ellipse", box: { x: 760, y: 240, width: 320, height: 220 }, style: { fill: { kind: "solid", colour: themeColour({ slot: "accent2", alpha: 1 }) } }, text: plainBody("Flies out", { fontSize: 28, colour: themeColour({ slot: "light1", alpha: 1 }) }), textBox: { verticalAlignment: "middle" } });
  const builds = slideSnapshot({
    ids,
    notes: "Click through: the title fades in, the card flies in from the left and spins, the oval flies out.",
    elements: [buildsTitle, flyer, leaver],
    animations: [
      animationStep({ ids, elementId: buildsTitle.id, effect: { kind: "fadeIn" }, trigger: "onClick" }),
      animationStep({ ids, elementId: flyer.id, effect: { kind: "flyIn", from: "left" }, trigger: "onClick", durationMilliseconds: 700 }),
      animationStep({ ids, elementId: flyer.id, effect: { kind: "spin", degrees: 360 }, trigger: "afterPrevious", durationMilliseconds: 800 }),
      animationStep({ ids, elementId: leaver.id, effect: { kind: "flyOut", to: "right" }, trigger: "onClick", durationMilliseconds: 600 }),
    ],
  });

  // Two slides whose elements share morph keys: position, size, rotation, colour, corner radius and text all change.
  const morphCaption = (text: string, box: Readonly<{ x: number; y: number; width: number; height: number }>) =>
    shapeElement({ id: ids.next("element"), preset: "textBox", morphKey: "morph_caption", box, text: plainBody(text, { fontSize: 40, fontWeight: 700 }) });
  const morphBefore = slideSnapshot({
    ids,
    notes: "The next slide morphs from this one.",
    elements: [
      morphCaption("Before the morph", { x: 80, y: 60, width: 700, height: 80 }),
      shapeElement({ id: ids.next("element"), preset: "roundedRectangle", morphKey: "morph_card", box: { x: 120, y: 260, width: 260, height: 180 }, style: { fill: { kind: "solid", colour: accent }, cornerRadius: { kind: "uniform", radius: 8 } } }),
      shapeElement({ id: ids.next("element"), preset: "ellipse", morphKey: "morph_dot", box: { x: 900, y: 420, width: 120, height: 120 }, style: { fill: { kind: "solid", colour: themeColour({ slot: "accent3", alpha: 1 }) } } }),
    ],
  });
  const morphAfter = slideSnapshot({
    ids,
    transition: { kind: "builtin", effect: { effect: "morph" }, durationMilliseconds: 900, easing: "easeInOut" },
    elements: [
      morphCaption("After the morph", { x: 420, y: 600, width: 760, height: 80 }),
      shapeElement({
        id: ids.next("element"),
        preset: "roundedRectangle",
        morphKey: "morph_card",
        frame: { x: 640, y: 120, width: 480, height: 320, rotation: 15, flipHorizontal: false, flipVertical: false },
        style: { fill: { kind: "solid", colour: themeColour({ slot: "accent5", alpha: 1 }) }, cornerRadius: { kind: "uniform", radius: 72 } },
      }),
      shapeElement({ id: ids.next("element"), preset: "ellipse", morphKey: "morph_dot", box: { x: 140, y: 200, width: 260, height: 260 }, style: { fill: { kind: "solid", colour: themeColour({ slot: "accent6", alpha: 1 }) } } }),
    ],
  });

  const extra = Array.from({ length: options.extraSlideCount }, (_, index) =>
    slideSnapshot({
      ids,
      skipped: index % 7 === 3,
      elements: [shapeElement({ id: ids.next("element"), preset: "textBox", box: { x: 80, y: 300, width: 1120, height: 120 }, text: plainBody(`Slide ${index + 9}`, { fontSize: 72, fontWeight: 700 }), textBox: { verticalAlignment: "middle" } })],
    }),
  );
  return [title, styles, table, dark, grouped, builds, morphBefore, morphAfter, ...extra];
}
