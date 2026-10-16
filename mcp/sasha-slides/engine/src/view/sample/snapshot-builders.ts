// SNAPSHOT BUILDERS: complete document values from a few named fields, for the view's tests, the
// chrome harness and the demo's sample deck. The contracts make every element carry every field
// (frames, style groups, morph keys, unsupported keys ...), which is right for the model and
// tedious for a test that is about one border; these builders fill the rest with the documented
// defaults (contracts/style.ts) so a test names only the feature it is about.
//
// Ids come from `IdMinter`, a deterministic wrapper over `mintId` (ids.ts), so builders never
// brand a string by hand.

import type { AnimationEffect, AnimationStep, AnimationTrigger } from "../../contracts/animations.ts";
import type {
  CustomOutline,
  DocumentSnapshot,
  ElementSnapshot,
  GroupElement,
  ImageElement,
  LayoutSnapshot,
  LineElement,
  Paragraph,
  PlaceholderReference,
  PlaceholderRole,
  PlaceholderStyle,
  ShapeElement,
  ShapePreset,
  SlideSnapshot,
  TableCell,
  TableElement,
  TextBody,
  TextRun,
  ThemeSnapshot,
  UnsupportedElement,
} from "../../contracts/document.ts";
import { DOCUMENT_SCHEMA_VERSION, EMPTY_TEXT_BODY } from "../../contracts/document.ts";
import { identityFrame, lineFrame, type Box, type Frame, type Point } from "../../contracts/geometry.ts";
import { mintId, type AssetId, type DeckId, type ElementId, type IdSeed, type MintedIdByKind, type ObjectIdKind, type SlideId } from "../../contracts/ids.ts";
import {
  DEFAULT_TEXT_BOX_STYLE,
  PLAIN_BOX_STYLE,
  literalColour,
  themeColour,
  type BoxStyle,
  type Colour,
  type ParagraphStylePatch,
  type RunStyle,
  type RunStylePatch,
  type Stroke,
  type TextBoxStyle,
} from "../../contracts/style.ts";

/** Mints ids in order from a fixed seed, so a fixture's ids are the same on every run. */
export class IdMinter {
  private seed: IdSeed;

  constructor(sessionPrefix: string) {
    this.seed = { sessionPrefix, counter: 0 };
  }

  next<TKind extends ObjectIdKind>(kind: TKind): MintedIdByKind[TKind] {
    const minted = mintId({ seed: this.seed, kind });
    this.seed = minted.seed;
    return minted.id;
  }
}

/** A deck id for fixtures and the demo. */
export function fixtureDeckId(text: string): DeckId {
  // Deck ids are minted by the deck server (milestone 2); fixtures use object-id-shaped literals,
  // which is the only runtime property a deck id has.
  return text as DeckId;
}

/** A content address for fixtures: 64 hexadecimal digits, the shape of a SHA-256 asset id. */
export function fixtureAssetId(seed: string): AssetId {
  const digits = Array.from(seed).map((character) => character.charCodeAt(0).toString(16)).join("");
  // An asset id is the hexadecimal SHA-256 of the bytes; any 64 hexadecimal digits have its shape.
  return digits.padEnd(64, "0").slice(0, 64) as AssetId;
}

export const SAMPLE_DEFAULT_RUN_STYLE: RunStyle = {
  fontFamily: "Manrope",
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

export function sampleTheme(): ThemeSnapshot {
  const placeholder = (run: RunStylePatch, paragraph: ParagraphStylePatch = {}): PlaceholderStyle => ({ run, paragraph, textBox: {} });
  const placeholderStyles: Record<PlaceholderRole, PlaceholderStyle> = {
    title: placeholder({ fontSize: 64, fontWeight: 700, fontFamily: "Manrope" }),
    centredTitle: placeholder({ fontSize: 80, fontWeight: 700, fontFamily: "Manrope" }, { alignment: "centre" }),
    subtitle: placeholder({ fontSize: 36, colour: themeColour({ slot: "dark2", alpha: 1 }) }, { alignment: "centre" }),
    body: placeholder({ fontSize: 32 }),
    slideNumber: placeholder({ fontSize: 20, colour: themeColour({ slot: "dark2", alpha: 1 }) }, { alignment: "end" }),
    footer: placeholder({ fontSize: 20 }),
    date: placeholder({ fontSize: 20 }),
    picture: placeholder({}),
  };
  return {
    name: "Tidepool sample",
    colours: {
      dark1: "#1c2333",
      light1: "#ffffff",
      dark2: "#3d4659",
      light2: "#eef1f6",
      accent1: "#4338ca",
      accent2: "#0e7490",
      accent3: "#be185d",
      accent4: "#047857",
      accent5: "#b45309",
      accent6: "#7c3aed",
      hyperlink: "#4338ca",
      followedHyperlink: "#7c3aed",
    },
    headingFontFamily: "Manrope",
    bodyFontFamily: "Manrope",
    background: { kind: "solid", colour: themeColour({ slot: "light1", alpha: 1 }) },
    placeholderStyles,
    defaultRunStyle: SAMPLE_DEFAULT_RUN_STYLE,
  };
}

/** A body from paragraphs, each a list of runs. */
export function textBody(paragraphs: readonly Paragraph[]): TextBody {
  return paragraphs.length === 0 ? EMPTY_TEXT_BODY : { paragraphs };
}

export function paragraph(runs: readonly TextRun[], style: ParagraphStylePatch = {}): Paragraph {
  return { style, runs };
}

export function run(text: string, style: RunStylePatch = {}): TextRun {
  return { kind: "text", text, style };
}

/** A body of plain paragraphs, one per line of `text`. */
export function plainBody(text: string, style: RunStylePatch = {}): TextBody {
  return textBody(text.split("\n").map((line) => paragraph(line.length === 0 ? [] : [run(line, style)])));
}

export type ShapeOptions = Readonly<{
  id: ElementId;
  preset?: ShapePreset;
  customOutline?: CustomOutline | null;
  box?: Box;
  frame?: Frame;
  style?: Partial<BoxStyle>;
  textBox?: Partial<TextBoxStyle>;
  text?: TextBody;
  placeholder?: PlaceholderReference | null;
  morphKey?: string;
  name?: string;
  unsupportedKeys?: readonly string[];
}>;

export function shapeElement(options: ShapeOptions): ShapeElement {
  return {
    kind: "shape",
    id: options.id,
    name: options.name ?? "",
    description: "",
    frame: options.frame ?? identityFrame(options.box ?? { x: 100, y: 100, width: 240, height: 160 }),
    groupId: null,
    morphKey: options.morphKey ?? options.id,
    placeholder: options.placeholder ?? null,
    unsupportedKeys: options.unsupportedKeys ?? [],
    preset: options.preset ?? "rectangle",
    customOutline: options.customOutline ?? null,
    box: { ...PLAIN_BOX_STYLE, ...options.style },
    textBox: { ...DEFAULT_TEXT_BOX_STYLE, ...options.textBox },
    text: options.text ?? EMPTY_TEXT_BODY,
  };
}

export function imageElement(options: Readonly<{ id: ElementId; assetId: AssetId; box: Box; style?: Partial<BoxStyle>; description?: string }>): ImageElement {
  return {
    kind: "image",
    id: options.id,
    name: "",
    description: options.description ?? "",
    frame: identityFrame(options.box),
    groupId: null,
    morphKey: options.id,
    placeholder: null,
    unsupportedKeys: [],
    assetId: options.assetId,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
    box: { ...PLAIN_BOX_STYLE, ...options.style },
  };
}

export function lineElement(options: Readonly<{ id: ElementId; start: Point; end: Point; stroke?: Stroke; startArrow?: LineElement["startArrow"]; endArrow?: LineElement["endArrow"] }>): LineElement {
  return {
    kind: "line",
    id: options.id,
    name: "",
    description: "",
    frame: lineFrame({ start: options.start, end: options.end }),
    groupId: null,
    morphKey: options.id,
    placeholder: null,
    unsupportedKeys: [],
    start: options.start,
    end: options.end,
    routing: "straight",
    stroke: options.stroke ?? { width: 4, colour: themeColour({ slot: "dark1", alpha: 1 }), dash: "solid" },
    startArrow: options.startArrow ?? "none",
    endArrow: options.endArrow ?? "triangle",
    opacity: 1,
  };
}

export function groupElement(options: Readonly<{ id: ElementId; children: readonly ElementSnapshot[]; rotation?: number }>): GroupElement {
  const boxes = options.children.map((child) => child.frame);
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return {
    kind: "group",
    id: options.id,
    name: "",
    description: "",
    frame: { ...identityFrame({ x: left, y: top, width: right - left, height: bottom - top }), rotation: options.rotation ?? 0 },
    groupId: null,
    morphKey: options.id,
    placeholder: null,
    unsupportedKeys: [],
    children: options.children.map((child) => ({ ...child, groupId: options.id })),
  };
}

export function unsupportedElement(options: Readonly<{ id: ElementId; box: Box; storedKind: string }>): UnsupportedElement {
  return {
    kind: "unsupported",
    id: options.id,
    name: "",
    description: "",
    frame: identityFrame(options.box),
    groupId: null,
    morphKey: options.id,
    placeholder: null,
    unsupportedKeys: [],
    storedKind: options.storedKind,
  };
}

/** A table whose cells hold the given texts, row by row. */
export function tableElement(options: Readonly<{ ids: IdMinter; id: ElementId; box: Box; texts: readonly (readonly string[])[]; headerFill?: Colour; textStyle?: RunStylePatch }>): TableElement {
  const columnCount = Math.max(1, ...options.texts.map((row) => row.length));
  const columns = Array.from({ length: columnCount }, () => ({ id: options.ids.next("tableColumn"), width: options.box.width / columnCount }));
  const rows = options.texts.map(() => ({ id: options.ids.next("tableRow"), minimumHeight: options.box.height / Math.max(1, options.texts.length) }));
  const hairline: Stroke = { width: 2, colour: literalColour({ hexadecimal: "#c9cfdc", alpha: 1 }), dash: "solid" };
  const cells: TableCell[] = [];
  rows.forEach((row, rowIndex) => {
    columns.forEach((column, columnIndex) => {
      const text = options.texts[rowIndex]?.[columnIndex] ?? "";
      const header = rowIndex === 0 && options.headerFill !== undefined;
      cells.push({
        rowId: row.id,
        columnId: column.id,
        rowSpan: 1,
        columnSpan: 1,
        fill: header && options.headerFill !== undefined ? { kind: "solid", colour: options.headerFill } : { kind: "none" },
        borders: { top: hairline, right: hairline, bottom: hairline, left: hairline },
        textBox: { ...DEFAULT_TEXT_BOX_STYLE, paddingTop: 8, paddingBottom: 8 },
        text: plainBody(text, { fontSize: 24, ...(header ? { fontWeight: 700, colour: themeColour({ slot: "light1", alpha: 1 }) } : {}), ...options.textStyle }),
      });
    });
  });
  return {
    kind: "table",
    id: options.id,
    name: "",
    description: "",
    frame: identityFrame(options.box),
    groupId: null,
    morphKey: options.id,
    placeholder: null,
    unsupportedKeys: [],
    columns,
    rows,
    cells,
    opacity: 1,
  };
}

export function slideSnapshot(options: Readonly<{ ids: IdMinter; id?: SlideId; elements: readonly ElementSnapshot[]; background?: SlideSnapshot["background"]; notes?: string; skipped?: boolean; transition?: SlideSnapshot["transition"]; animations?: readonly AnimationStep[] }>): SlideSnapshot {
  return {
    id: options.id ?? options.ids.next("slide"),
    layoutId: null,
    background: options.background ?? null,
    skipped: options.skipped ?? false,
    speakerNotes: options.notes === undefined ? EMPTY_TEXT_BODY : plainBody(options.notes, { fontSize: 24 }),
    transition: options.transition ?? null,
    animations: options.animations ?? [],
    elements: options.elements,
  };
}

/** A build step on `elementId` with the usual timing (500 milliseconds, no delay, ease out). */
export function animationStep(options: Readonly<{ ids: IdMinter; elementId: ElementId; effect: AnimationEffect; trigger: AnimationTrigger; durationMilliseconds?: number }>): AnimationStep {
  return {
    id: options.ids.next("animationStep"),
    elementId: options.elementId,
    effect: options.effect,
    trigger: options.trigger,
    durationMilliseconds: options.durationMilliseconds ?? 500,
    delayMilliseconds: 0,
    easing: "easeOut",
    unsupportedKeys: [],
  };
}

export function documentSnapshot(options: Readonly<{ deckId: DeckId; title: string; slides: readonly SlideSnapshot[]; layouts?: readonly LayoutSnapshot[]; theme?: ThemeSnapshot }>): DocumentSnapshot {
  return {
    deckId: options.deckId,
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    revision: 1,
    title: options.title,
    pageSize: { width: 1280, height: 720 },
    theme: options.theme ?? sampleTheme(),
    layouts: options.layouts ?? [],
    slides: options.slides,
    assets: [],
    transitionScripts: [],
  };
}
