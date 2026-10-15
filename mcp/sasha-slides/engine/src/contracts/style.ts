// STYLE VALUES: colours, fills, borders, corners, shadows and text styles, as stored in the
// document and as every editor control edits them.
//
// Key decisions:
//
//  * THEME COLOURS ARE REFERENCES. A colour is either a literal or a slot of the deck theme
//    (`accent1`, `dark1`, ...), the same twelve slots Google Slides' `ThemeColorType` has. Changing
//    the theme recolours every element that references a slot, and import and export keep the link.
//
//  * EVERYTHING SLIDES CANNOT EXPRESS IS STILL MODELLED HONESTLY. Per-side borders, per-corner
//    radii, radial gradients and blur/spread shadows are real stylesheet features the user asked
//    for; Slides has no field for them. The model stores what the user chose, the renderer draws it
//    exactly, and only EXPORT approximates -- through the converter's existing shape-composition
//    tricks (renderer/html2slides/extract-dom.ts header: border-strip shapes, ROUND_1 corners).
//
//  * STYLE GROUPS ARE WHOLE VALUES. A `Fill`, a `Border` or a `Shadow` is replaced as a unit (last
//    writer wins per group in the shared document, see yjs-schema.ts). Two people changing the
//    border width and the border colour at the same instant get one of the two borders, never a
//    border whose dash came from one and colour from the other. The frame is one value too.
//
//  * TEXT STYLES ARE PARTIAL, AND "NONE" IS A VALUE, NEVER `null`. A run stores only the attributes
//    the user set (`RunStylePatch`); an ABSENT attribute inherits from the placeholder role, then
//    the theme. Yjs removes a format attribute when it is set to `null`, so `null` cannot mean
//    "explicitly none, overriding the placeholder": that is why `highlight` and `link` have an
//    explicit `{ kind: "none" }` variant and `RunStyle` contains no `null` anywhere. Removing an
//    attribute (back to inherited) is the `clear` list of a format operation (commands.ts).
//
// All values are flat or shallowly nested plain data, because they are stored as Y.Map values and
// Y.Text format attributes, and Yjs compares format attributes with a FLAT equality (yjs-schema.ts).

import type { AssetId, ListId, SlideId } from "./ids.ts";

/** The twelve theme colour slots, in Google Slides' `ThemeColorType` order. */
export type ThemeColourSlot =
  | "dark1"
  | "light1"
  | "dark2"
  | "light2"
  | "accent1"
  | "accent2"
  | "accent3"
  | "accent4"
  | "accent5"
  | "accent6"
  | "hyperlink"
  | "followedHyperlink";

export const THEME_COLOUR_SLOTS: readonly ThemeColourSlot[] = [
  "dark1",
  "light1",
  "dark2",
  "light2",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "hyperlink",
  "followedHyperlink",
];

/** `#rrggbb`, lowercase. Alpha is a separate field so a hexadecimal colour is always six digits. */
export type HexadecimalColour = string;

export type Colour =
  | Readonly<{ kind: "literal"; hexadecimal: HexadecimalColour; alpha: number }>
  | Readonly<{ kind: "theme"; slot: ThemeColourSlot; alpha: number }>;

/** "Explicitly no colour", stored as a value so it can override a placeholder's colour. */
export type NoColour = Readonly<{ kind: "none" }>;

/** A gradient stop; `offset` is 0..1 along the gradient line. */
export type GradientStop = Readonly<{ colour: Colour; offset: number }>;

export type ImageFit = "cover" | "contain" | "stretch" | "tile";

export type Fill =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "solid"; colour: Colour }>
  /** `angle` in degrees, stylesheet convention: 0 points up, 90 points right. */
  | Readonly<{ kind: "linearGradient"; angle: number; stops: readonly GradientStop[] }>
  /** Centre as fractions of the element box. Not expressible in Slides: export uses the first stop. */
  | Readonly<{ kind: "radialGradient"; centreX: number; centreY: number; stops: readonly GradientStop[] }>
  | Readonly<{ kind: "image"; assetId: AssetId; fit: ImageFit; opacity: number }>;

/** The dash patterns Google Slides offers (`DashStyle`), named in full. */
export type DashStyle = "solid" | "dot" | "dash" | "dashDot" | "longDash" | "longDashDot";

export type Stroke = Readonly<{ width: number; colour: Colour; dash: DashStyle }>;

/**
 * An element's outline. `perSide` is only offered for the rectangle family (rectangle, rounded
 * rectangle, text box, image, table cell); other presets are vector paths with one outline.
 * A side of `null` draws nothing on that side (a stored plain value, not a text attribute, so `null`
 * is safe here).
 */
export type Border =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "uniform"; stroke: Stroke }>
  | Readonly<{
      kind: "perSide";
      top: Stroke | null;
      right: Stroke | null;
      bottom: Stroke | null;
      left: Stroke | null;
    }>;

/** Corner radius in slide units; per-corner only for the rectangle family. */
export type CornerRadius =
  | Readonly<{ kind: "uniform"; radius: number }>
  | Readonly<{ kind: "perCorner"; topLeft: number; topRight: number; bottomRight: number; bottomLeft: number }>;

/** One outer drop shadow, as Slides has; `spread` is stylesheet-only and dropped on export. */
export type Shadow = Readonly<{
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  colour: Colour;
}>;

/** The style every box-like element carries. `shadow: null` is no shadow. */
export type BoxStyle = Readonly<{
  fill: Fill;
  border: Border;
  cornerRadius: CornerRadius;
  shadow: Shadow | null;
  /** 0..1, applied to the whole element including its text. */
  opacity: number;
}>;

export type FontStyleName = "normal" | "italic";
export type BaselineOffset = "none" | "superscript" | "subscript";
export type TextCase = "none" | "smallCaps" | "allCaps";

/** Where a run links to: a web address, or another slide of this deck (Slides' "link to slide"). */
export type RunLink =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "webAddress"; address: string }>
  | Readonly<{ kind: "slide"; slideId: SlideId }>;

/** A character run's style, fully resolved (what the renderer draws). No `null` (see the header). */
export type RunStyle = Readonly<{
  fontFamily: string;
  /**
   * In slide units (the 1280-wide canvas), NOT points: 1 unit = 0.5625 point, so 18 point is 32
   * units. The properties panel shows and accepts points (geometry.ts `pointsFromSlideUnits`).
   */
  fontSize: number;
  /** 100..900, as the stylesheet and Slides `weightedFontFamily`. */
  fontWeight: number;
  fontStyle: FontStyleName;
  underline: boolean;
  strikethrough: boolean;
  colour: Colour;
  /** Text highlight (Slides `backgroundColor`). */
  highlight: Colour | NoColour;
  link: RunLink;
  baselineOffset: BaselineOffset;
  /** Extra space between letters, slide units. */
  letterSpacing: number;
  textCase: TextCase;
}>;

/** What a run actually stores: only what the user set; an absent key inherits. */
export type RunStylePatch = Partial<RunStyle>;

export type TextAlignment = "start" | "centre" | "end" | "justify";
export type TextDirection = "leftToRight" | "rightToLeft";

/** Bullet and number glyph families, the presets Slides' `createParagraphBullets` offers. */
export type ListGlyph =
  | "disc"
  | "circle"
  | "square"
  | "arrow"
  | "star"
  | "checkbox"
  | "decimal"
  | "decimalZeroPadded"
  | "upperAlphabetic"
  | "lowerAlphabetic"
  | "upperRoman"
  | "lowerRoman";

/**
 * A paragraph's list membership. Paragraphs sharing a `listId` number together; `level` is the
 * nesting depth 0..8 (Tab / Shift+Tab). Flat on purpose (see the header on Yjs equality).
 */
export type ListMembership = Readonly<{ kind: "list"; listId: ListId; glyph: ListGlyph; level: number }>;

/** Not a list paragraph, stored as a value so it can override a placeholder's list style. */
export type NoList = Readonly<{ kind: "none" }>;

export type ParagraphStyle = Readonly<{
  alignment: TextAlignment;
  /** A multiple of the font's line height: 1, 1.15, 1.5, 2 ... */
  lineSpacing: number;
  /** Slide units. */
  spaceAbove: number;
  spaceBelow: number;
  indentStart: number;
  indentFirstLine: number;
  direction: TextDirection;
  list: ListMembership | NoList;
}>;

export type ParagraphStylePatch = Partial<ParagraphStyle>;

export type VerticalAlignment = "top" | "middle" | "bottom";

/**
 * How text that does not fit behaves. All three are milestone 1: `shrinkText` scales the text
 * layer (computed by the view); `resizeShape` grows the box to its text, written back by the
 * editor that is typing (SPEC.md "Measured layout").
 */
export type TextAutofit = "none" | "shrinkText" | "resizeShape";

/** The box properties of any element that holds text. */
export type TextBoxStyle = Readonly<{
  verticalAlignment: VerticalAlignment;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  autofit: TextAutofit;
  wrap: boolean;
}>;

export type ArrowHead = "none" | "triangle" | "openArrow" | "stealth" | "diamond" | "oval" | "bar";

/** The line routings; milestone 1 edits `straight`, renders all three. */
export type LineRouting = "straight" | "elbow" | "curved";

export function literalColour(options: Readonly<{ hexadecimal: HexadecimalColour; alpha: number }>): Colour {
  return { kind: "literal", hexadecimal: options.hexadecimal, alpha: options.alpha };
}

export function themeColour(options: Readonly<{ slot: ThemeColourSlot; alpha: number }>): Colour {
  return { kind: "theme", slot: options.slot, alpha: options.alpha };
}

/** The look a fresh rectangle gets: no fill, no border, square corners, no shadow, opaque. */
export const PLAIN_BOX_STYLE: BoxStyle = {
  fill: { kind: "none" },
  border: { kind: "none" },
  cornerRadius: { kind: "uniform", radius: 0 },
  shadow: null,
  opacity: 1,
};

/** The text box style of a new shape: text stays inside the box as drawn. */
export const DEFAULT_TEXT_BOX_STYLE: TextBoxStyle = {
  verticalAlignment: "top",
  paddingTop: 12,
  paddingRight: 12,
  paddingBottom: 12,
  paddingLeft: 12,
  autofit: "none",
  wrap: true,
};

/** A new TEXT BOX (preset `textBox`) grows with its text, as in Slides. */
export const NEW_TEXT_BOX_STYLE: TextBoxStyle = { ...DEFAULT_TEXT_BOX_STYLE, autofit: "resizeShape" };

export const DEFAULT_PARAGRAPH_STYLE: ParagraphStyle = {
  alignment: "start",
  lineSpacing: 1.15,
  spaceAbove: 0,
  spaceBelow: 0,
  indentStart: 0,
  indentFirstLine: 0,
  direction: "leftToRight",
  list: { kind: "none" },
};
