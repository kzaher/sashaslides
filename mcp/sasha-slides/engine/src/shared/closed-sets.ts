// THE CLOSED SETS OF THE DOCUMENT CONTRACTS, as lists. A union type cannot be iterated, but a parser
// must ask "is this string a member?" -- the stored-value checks (model/stored-values.ts), and the
// agent tool schemas (deck-tools/) build the same enumerations. Each list is declared ONCE here, as
// a table keyed by its union (`membersOf<Union>({...})`), so a member added to the union, or a typo,
// is a compile error here instead of a value every parser quietly refuses as "unsupported".
//
// Member order is the order the lists had before they moved here; a schema built from a list
// publishes that order.
//
// Sets the contracts already list beside their unions (`THEME_COLOUR_SLOTS`, `PLACEHOLDER_ROLES`,
// `ANIMATION_EDGES`, `ANIMATION_TRIGGERS`) are not repeated here, and image formats have their own
// file (media-types.ts). DOM-free and Node-free, so the server and the agent tools can import it.

import type { ShapePreset, SlideDirection, TransitionEasing } from "../contracts/document.ts";
import type { ArrowHead, DashStyle, ImageFit, LineRouting, ListGlyph, TextAutofit, VerticalAlignment } from "../contracts/style.ts";

/** The presets this client draws (document.ts `ShapePreset`). */
export const SHAPE_PRESETS = membersOf<ShapePreset>({
  textBox: true,
  rectangle: true,
  roundedRectangle: true,
  ellipse: true,
  triangle: true,
  rightTriangle: true,
  diamond: true,
  parallelogram: true,
  trapezoid: true,
  pentagon: true,
  hexagon: true,
  octagon: true,
  fivePointStar: true,
  plus: true,
  heart: true,
  cloud: true,
  speechBubble: true,
  chevron: true,
  rightArrow: true,
  leftArrow: true,
  upArrow: true,
  downArrow: true,
});

export const IMAGE_FITS = membersOf<ImageFit>({ cover: true, contain: true, stretch: true, tile: true });
export const DASH_STYLES = membersOf<DashStyle>({ solid: true, dot: true, dash: true, dashDot: true, longDash: true, longDashDot: true });
export const VERTICAL_ALIGNMENTS = membersOf<VerticalAlignment>({ top: true, middle: true, bottom: true });
export const TEXT_AUTOFITS = membersOf<TextAutofit>({ none: true, shrinkText: true, resizeShape: true });
export const ARROW_HEADS = membersOf<ArrowHead>({ none: true, triangle: true, openArrow: true, stealth: true, diamond: true, oval: true, bar: true });
export const LINE_ROUTINGS = membersOf<LineRouting>({ straight: true, elbow: true, curved: true });
export const LIST_GLYPHS = membersOf<ListGlyph>({
  disc: true,
  circle: true,
  square: true,
  arrow: true,
  star: true,
  checkbox: true,
  decimal: true,
  decimalZeroPadded: true,
  upperAlphabetic: true,
  lowerAlphabetic: true,
  upperRoman: true,
  lowerRoman: true,
});
export const TRANSITION_EASINGS = membersOf<TransitionEasing>({ linear: true, easeIn: true, easeOut: true, easeInOut: true });
export const SLIDE_DIRECTIONS = membersOf<SlideDirection>({ fromLeft: true, fromRight: true, fromTop: true, fromBottom: true });

/**
 * The keys of a table that has exactly the members of `TMember`. Always called with the union
 * spelled out: the `Record` then requires every member and refuses any other key.
 */
function membersOf<TMember extends string>(table: Readonly<Record<TMember, true>>): readonly TMember[] {
  // `Object.keys` widens to string[]; the table's keys are exactly the TMember members (see above).
  return Object.keys(table) as TMember[];
}
