/**
 * Engine colours to Slides wire colours on export.
 *
 * An exported presentation gets Google's default master, not the deck's theme, so a theme
 * reference cannot stay a reference: it is written as the colour the deck's theme gives it, and the
 * report says once that the link to the theme was not kept (`themeColourLink`, SPEC.md 21.12).
 */
import type { ThemeSnapshot } from "../engine/src/contracts/document.ts";
import type { Colour } from "../engine/src/contracts/style.ts";
import type { InterchangeLossSink } from "./interchange-losses.ts";
import type { WireChannels, WireSolidFill } from "./slides-requests.ts";

export function wireSolidFill(options: Readonly<{ colour: Colour; theme: ThemeSnapshot; losses: InterchangeLossSink }>): WireSolidFill {
  return { color: { rgbColor: channelsOf(hexadecimalOfColour(options)) }, alpha: roundAlpha(options.colour.alpha) };
}

export function hexadecimalOfColour(options: Readonly<{ colour: Colour; theme: ThemeSnapshot; losses: InterchangeLossSink }>): string {
  const { colour } = options;
  switch (colour.kind) {
    case "literal":
      return colour.hexadecimal;
    case "theme":
      options.losses.addOncePerDeck({ feature: "themeColourLink", detail: "Theme colours were written as plain colours; changing the Slides theme will not recolour them." });
      return options.theme.colours[colour.slot];
    default:
      return assertNever(colour);
  }
}

/** `#rrggbb` to Slides' 0..1 channels, all three written (an omitted channel means 0). */
export function channelsOf(hexadecimal: string): WireChannels {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hexadecimal.slice(offset, offset + 2), 16);
    return Number.isFinite(value) ? Math.round((value / 255) * 10_000) / 10_000 : 0;
  };
  return { red: channel(1), green: channel(3), blue: channel(5) };
}

function roundAlpha(alpha: number): number {
  return Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
