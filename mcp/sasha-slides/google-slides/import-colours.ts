/**
 * Slides colours to engine colours, keeping theme references (style.ts "theme colours are
 * references"): a run or fill that names `ACCENT2` stays a link to the deck's `accent2` slot.
 *
 * Slides has sixteen `ThemeColorType`s and the engine twelve. The four aliases (`TEXT1`,
 * `BACKGROUND1`, `TEXT2`, `BACKGROUND2`) are not fixed to slots: in the recorded "Simple Light"
 * master TEXT2 holds LIGHT2's colour and BACKGROUND2 holds DARK2's. So an alias resolves to the
 * slot whose colour the master gives it, and to a literal colour when no slot has it.
 */
import type { Colour, ThemeColourSlot } from "../engine/src/contracts/style.ts";
import type { SlidesColour } from "./slides-presentation.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

export type ColourContext = Readonly<{
  /** The first master's colour scheme: `ThemeColorType` to `#rrggbb`. */
  scheme: ReadonlyMap<string, string>;
}>;

/** The twelve engine slots by their Slides name, in `ThemeColorType` order. */
export const THEME_SLOT_BY_SLIDES_TYPE: ReadonlyMap<string, ThemeColourSlot> = new Map<string, ThemeColourSlot>([
  ["DARK1", "dark1"],
  ["LIGHT1", "light1"],
  ["DARK2", "dark2"],
  ["LIGHT2", "light2"],
  ["ACCENT1", "accent1"],
  ["ACCENT2", "accent2"],
  ["ACCENT3", "accent3"],
  ["ACCENT4", "accent4"],
  ["ACCENT5", "accent5"],
  ["ACCENT6", "accent6"],
  ["HYPERLINK", "hyperlink"],
  ["FOLLOWED_HYPERLINK", "followedHyperlink"],
]);

/** The colour the engine's default theme would have used when a master names no colour for a slot. */
export const FALLBACK_SLOT_COLOURS: Readonly<Record<ThemeColourSlot, string>> = {
  dark1: "#000000",
  light1: "#ffffff",
  dark2: "#595959",
  light2: "#eeeeee",
  accent1: "#4285f4",
  accent2: "#212121",
  accent3: "#78909c",
  accent4: "#ffab40",
  accent5: "#0097a7",
  accent6: "#eeff41",
  hyperlink: "#0097a7",
  followedHyperlink: "#0097a7",
};

export function colourOf(options: Readonly<{ colour: SlidesColour; alpha: number; context: ColourContext }>): Colour {
  const { colour, alpha, context } = options;
  switch (colour.kind) {
    case "literal":
      return { kind: "literal", hexadecimal: colour.hexadecimal, alpha };
    case "theme": {
      const slot = THEME_SLOT_BY_SLIDES_TYPE.get(colour.type) ?? aliasSlot({ type: colour.type, context });
      if (slot !== null) return { kind: "theme", slot, alpha };
      return { kind: "literal", hexadecimal: context.scheme.get(colour.type) ?? "#000000", alpha };
    }
    default:
      return assertNever(colour);
  }
}

const ALIAS_PREFERENCE: readonly string[] = ["DARK1", "LIGHT1", "DARK2", "LIGHT2"];

function aliasSlot(options: Readonly<{ type: string; context: ColourContext }>): ThemeColourSlot | null {
  const hexadecimal = options.context.scheme.get(options.type);
  if (hexadecimal === undefined) return null;
  const candidates = [...ALIAS_PREFERENCE, ...THEME_SLOT_BY_SLIDES_TYPE.keys()];
  for (const candidate of candidates) {
    if (options.context.scheme.get(candidate) !== hexadecimal) continue;
    const slot = THEME_SLOT_BY_SLIDES_TYPE.get(candidate);
    if (slot !== undefined) return slot;
  }
  return null;
}
