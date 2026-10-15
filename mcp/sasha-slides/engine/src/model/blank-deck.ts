// A BLANK DECK: the default theme, the default layouts and the one title slide a new document is
// seeded with (`seed: { kind: "blankDeck" }`). The theme is also what a snapshot falls back to
// for any theme key it cannot read, so a joining replica that has not synchronised yet renders
// something sensible rather than nothing.
//
// Ids: the model never invents ids for commands (commands.ts), but seeding is not a command -- it
// runs once, on the replica that creates the deck. Its ids come from `mintId` with a session prefix
// drawn from the store's injected random source, so a seeded test is fully deterministic.

import type { LayoutSnapshot, PlaceholderReference, PlaceholderRole, PlaceholderStyle, ShapeElement, SlideSnapshot, ThemeSnapshot } from "../contracts/document.ts";
import type { DeckId, ElementId, IdSeed, LayoutId, RandomSource } from "../contracts/ids.ts";
import type { RunStyle, ThemeColourSlot } from "../contracts/style.ts";
import { EMPTY_TEXT_BODY } from "../contracts/document.ts";
import { identityFrame } from "../contracts/geometry.ts";
import { mintId, newSessionPrefix } from "../contracts/ids.ts";
import { DEFAULT_TEXT_BOX_STYLE, PLAIN_BOX_STYLE, themeColour } from "../contracts/style.ts";

/** What seeding writes, as plain values (document-writer.ts stores them). */
export type BlankDeck = Readonly<{
  deckId: DeckId;
  title: string;
  pageHeight: number;
  theme: ThemeSnapshot;
  layouts: readonly LayoutSnapshot[];
  slides: readonly SlideSnapshot[];
}>;

export const DEFAULT_DECK_TITLE = "Untitled presentation";
export const DEFAULT_HEADING_FONT_FAMILY = "Manrope";
export const DEFAULT_BODY_FONT_FAMILY = "Roboto";

export const DEFAULT_THEME_COLOURS: Readonly<Record<ThemeColourSlot, string>> = {
  dark1: "#1c2333",
  light1: "#ffffff",
  dark2: "#3d4659",
  light2: "#eef1f6",
  accent1: "#4338ca",
  accent2: "#0e7490",
  accent3: "#b45309",
  accent4: "#be185d",
  accent5: "#15803d",
  accent6: "#7c3aed",
  hyperlink: "#4338ca",
  followedHyperlink: "#6d28d9",
};

/** 18 point body text in the body family, theme ink; "none" written out as values (style.ts). */
export const DEFAULT_RUN_STYLE: RunStyle = {
  fontFamily: DEFAULT_BODY_FONT_FAMILY,
  fontSize: 32,
  fontWeight: 400,
  fontStyle: "normal",
  underline: false,
  strikethrough: false,
  colour: themeColour({ slot: "dark1", alpha: 1 }),
  highlight: { kind: "none" },
  link: { kind: "none" },
  baselineOffset: "none",
  letterSpacing: 0,
  textCase: "none",
};

/** Total over PlaceholderRole, so a new role is a compile error here. */
export const DEFAULT_PLACEHOLDER_STYLES: Readonly<Record<PlaceholderRole, PlaceholderStyle>> = {
  title: {
    run: { fontFamily: DEFAULT_HEADING_FONT_FAMILY, fontSize: 64, fontWeight: 700 },
    paragraph: { alignment: "start" },
    textBox: { verticalAlignment: "bottom" },
  },
  centredTitle: {
    run: { fontFamily: DEFAULT_HEADING_FONT_FAMILY, fontSize: 92, fontWeight: 700 },
    paragraph: { alignment: "centre" },
    textBox: { verticalAlignment: "bottom" },
  },
  subtitle: {
    run: { fontSize: 44, colour: themeColour({ slot: "dark2", alpha: 1 }) },
    paragraph: { alignment: "centre" },
    textBox: { verticalAlignment: "top" },
  },
  body: { run: { fontSize: 32 }, paragraph: { spaceBelow: 8 }, textBox: { verticalAlignment: "top" } },
  slideNumber: { run: { fontSize: 20, colour: themeColour({ slot: "dark2", alpha: 1 }) }, paragraph: { alignment: "end" }, textBox: {} },
  footer: { run: { fontSize: 20, colour: themeColour({ slot: "dark2", alpha: 1 }) }, paragraph: {}, textBox: {} },
  date: { run: { fontSize: 20, colour: themeColour({ slot: "dark2", alpha: 1 }) }, paragraph: {}, textBox: {} },
  picture: { run: {}, paragraph: {}, textBox: {} },
};

export const DEFAULT_THEME: ThemeSnapshot = {
  name: "Tidepool",
  colours: DEFAULT_THEME_COLOURS,
  headingFontFamily: DEFAULT_HEADING_FONT_FAMILY,
  bodyFontFamily: DEFAULT_BODY_FONT_FAMILY,
  background: { kind: "solid", colour: themeColour({ slot: "light1", alpha: 1 }) },
  placeholderStyles: DEFAULT_PLACEHOLDER_STYLES,
  defaultRunStyle: DEFAULT_RUN_STYLE,
};

export function blankDeck(options: Readonly<{ deckId: string; random: RandomSource }>): BlankDeck {
  let seed: IdSeed = { sessionPrefix: newSessionPrefix(options.random), counter: 0 };
  const nextElementId = (): ElementId => {
    const minted = mintId({ seed, kind: "element" });
    seed = minted.seed;
    return minted.id;
  };
  const nextLayoutId = (): LayoutId => {
    const minted = mintId({ seed, kind: "layout" });
    seed = minted.seed;
    return minted.id;
  };
  const layouts = LAYOUT_PLANS.map((plan): LayoutSnapshot => ({
    id: nextLayoutId(),
    name: plan.name,
    background: null,
    elements: plan.placeholders.map((placeholder) => placeholderShape({ id: nextElementId(), placeholder })),
  }));
  const titleLayout = layouts[0];
  const mintedSlide = mintId({ seed, kind: "slide" });
  seed = mintedSlide.seed;
  const slideId = mintedSlide.id;
  const titleSlide: SlideSnapshot = {
    id: slideId,
    layoutId: titleLayout?.id ?? null,
    background: null,
    skipped: false,
    speakerNotes: EMPTY_TEXT_BODY,
    transition: null,
    elements: (titleLayout?.elements ?? []).map((element) => {
      const id = nextElementId();
      return { ...element, id, morphKey: id };
    }),
  };
  return {
    // The deck id is the caller's (the server or the composition root chose it); the brand records that.
    deckId: options.deckId as DeckId,
    title: DEFAULT_DECK_TITLE,
    pageHeight: 720,
    theme: DEFAULT_THEME,
    layouts,
    slides: [titleSlide],
  };
}

type PlaceholderPlan = Readonly<{ role: PlaceholderRole; name: string; x: number; y: number; width: number; height: number }>;
type LayoutPlan = Readonly<{ name: string; placeholders: readonly PlaceholderPlan[] }>;

/** The first plan is the title slide's layout. */
const LAYOUT_PLANS: readonly LayoutPlan[] = [
  {
    name: "Title slide",
    placeholders: [
      { role: "centredTitle", name: "Title", x: 96, y: 180, width: 1088, height: 200 },
      { role: "subtitle", name: "Subtitle", x: 96, y: 400, width: 1088, height: 110 },
    ],
  },
  {
    name: "Title and body",
    placeholders: [
      { role: "title", name: "Title", x: 64, y: 40, width: 1152, height: 110 },
      { role: "body", name: "Body", x: 64, y: 170, width: 1152, height: 480 },
      { role: "slideNumber", name: "Slide number", x: 1096, y: 664, width: 120, height: 40 },
    ],
  },
  { name: "Section header", placeholders: [{ role: "title", name: "Title", x: 96, y: 260, width: 1088, height: 160 }] },
  { name: "Title only", placeholders: [{ role: "title", name: "Title", x: 64, y: 40, width: 1152, height: 110 }] },
  { name: "Blank", placeholders: [] },
];

function placeholderShape(options: Readonly<{ id: ElementId; placeholder: PlaceholderPlan }>): ShapeElement {
  const { placeholder } = options;
  const reference: PlaceholderReference = { role: placeholder.role, index: 0 };
  return {
    id: options.id,
    kind: "shape",
    name: placeholder.name,
    description: "",
    frame: identityFrame({ x: placeholder.x, y: placeholder.y, width: placeholder.width, height: placeholder.height }),
    groupId: null,
    morphKey: options.id,
    placeholder: reference,
    unsupportedKeys: [],
    preset: "textBox",
    box: PLAIN_BOX_STYLE,
    textBox: { ...DEFAULT_TEXT_BOX_STYLE, ...DEFAULT_PLACEHOLDER_STYLES[placeholder.role].textBox },
    text: EMPTY_TEXT_BODY,
  };
}
