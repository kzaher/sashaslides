// WHAT A NEW ELEMENT STARTS AS: the sizes a click (no drag) with an insert tool creates, in slide
// units (SPEC.md section 7, "create"), which shape presets start as a growing, unfilled text box,
// and the stroke and shadow a border, a line or a shadow starts from when the element had none.
// The editor's element factory and properties panel, the model's fallback for a damaged line
// stroke, and the connector's deck tools (deck-tools/style-merge.ts) all build from these, so an
// element a person draws and one the assistant creates start alike.

import type { ShapePreset } from "../contracts/document.ts";
import { literalColour, themeColour, type Shadow, type Stroke } from "../contracts/style.ts";

export const DEFAULT_TEXT_BOX_SIZE = { width: 400, height: 80 } as const;
export const DEFAULT_SHAPE_SIZE = { width: 240, height: 240 } as const;
export const DEFAULT_LINE_LENGTH = 240;
export const DEFAULT_TABLE_COLUMN_WIDTH = 160;
export const DEFAULT_TABLE_ROW_HEIGHT = 48;

/** A new line's stroke, and what a border starts from when the element had none. */
export const DEFAULT_STROKE: Stroke = { width: 2, colour: themeColour({ slot: "dark1", alpha: 1 }), dash: "solid" };

/** What turning a shadow on applies: the properties panel's "Shadow: On" and an assistant's partial shadow. */
export const DEFAULT_SHADOW: Shadow = { offsetX: 0, offsetY: 8, blur: 16, spread: 0, colour: literalColour({ hexadecimal: "#1c2333", alpha: 0.25 }) };

export function isTextBoxPreset(preset: ShapePreset): boolean {
  return TEXT_BOX_PRESET[preset];
}

/** Total over ShapePreset: which presets start as a growing, unfilled text box. */
const TEXT_BOX_PRESET: Readonly<Record<ShapePreset, boolean>> = {
  textBox: true,
  rectangle: false,
  roundedRectangle: false,
  ellipse: false,
  triangle: false,
  rightTriangle: false,
  diamond: false,
  parallelogram: false,
  trapezoid: false,
  pentagon: false,
  hexagon: false,
  octagon: false,
  fivePointStar: false,
  plus: false,
  heart: false,
  cloud: false,
  speechBubble: false,
  chevron: false,
  rightArrow: false,
  leftArrow: false,
  upArrow: false,
  downArrow: false,
};
