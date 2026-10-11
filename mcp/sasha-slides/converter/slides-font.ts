/**
 * slides-font.ts — resolving a CSS font stack to a family Slides can render.
 *
 * Slides resolves `TextStyle.fontFamily` server-side against its own font
 * catalogue. An unrecognised name does not error — it silently falls back to
 * Arial, which is the worst outcome for this pipeline because the slide then
 * looks wrong with nothing in `unsupported` to explain why. So the stack is
 * resolved here, locally, and a substitution is reported as an anomaly.
 */

export type FontResolution = Readonly<{
  family: string;
  /** The first stack entry, for the anomaly message; null when the stack was empty. */
  requested: string | null;
  /** True when nothing in the stack was recognised and a default was chosen. */
  substituted: boolean;
}>;

/**
 * Walk the CSS stack left to right and take the first family Slides is known to
 * carry. A generic keyword (`sans-serif`, `monospace`, …) resolves to the same
 * concrete family Chrome would have used, so the measured geometry the
 * extractor recorded still matches what Slides draws.
 *
 * A stack whose FIRST entry is unknown but whose later entry resolves is NOT a
 * substitution: Chrome walked the same stack with the same catalogue and
 * rendered the same face, so nothing was lost in translation and reporting it
 * would bury the real anomalies in noise. `substituted` is true only when the
 * whole stack failed and `FALLBACK_FAMILY` was imposed.
 */
export function resolveFontFamily(cssFontFamily: string): FontResolution {
  const entries = splitFontStack(cssFontFamily);
  const requested = entries.length > 0 ? (entries[0] ?? null) : null;

  for (const entry of entries) {
    const generic = GENERIC_FAMILIES.get(entry);
    if (generic !== undefined) return { family: generic, requested, substituted: false };
    const known = KNOWN_FAMILIES.get(entry);
    if (known !== undefined) return { family: known, requested, substituted: false };
  }
  return { family: FALLBACK_FAMILY, requested, substituted: requested !== null };
}

/** What an unrecognised stack becomes — also Slides' own silent default. */
export const FALLBACK_FAMILY = "Arial";

function splitFontStack(cssFontFamily: string): readonly string[] {
  return cssFontFamily
    .split(",")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, "").toLowerCase())
    .filter((entry) => entry.length > 0);
}

/**
 * CSS generic families mapped to the concrete family Chrome picks in this
 * devcontainer's headless profile, so extraction metrics and Slides agree.
 */
const GENERIC_FAMILIES: ReadonlyMap<string, string> = new Map([
  ["sans-serif", "Arial"],
  ["serif", "Times New Roman"],
  ["monospace", "Courier New"],
  ["cursive", "Comic Sans MS"],
  ["system-ui", "Arial"],
  ["ui-sans-serif", "Arial"],
  ["ui-serif", "Times New Roman"],
  ["ui-monospace", "Courier New"],
]);

/**
 * Families Slides resolves without a font upload: the web-safe set plus the
 * Google Fonts that are offered in the Slides font picker by default. "Caveat"
 * and "Patrick Hand" are on the list because CLAUDE.md records them as
 * rendering natively in Google Slides for the whiteboard templates.
 *
 * The value is the exact spelling to send; the key is the lower-cased lookup.
 */
const KNOWN_FAMILIES: ReadonlyMap<string, string> = new Map(
  (
    [
      // Web-safe / Microsoft core fonts.
      "Arial",
      "Arial Black",
      "Arial Narrow",
      "Comic Sans MS",
      "Courier New",
      "Georgia",
      "Impact",
      "Tahoma",
      "Times New Roman",
      "Trebuchet MS",
      "Verdana",
      // Metric-compatible aliases Chrome maps onto the above.
      "Helvetica",
      "Helvetica Neue",
      // Google Fonts in the default Slides picker.
      "Caveat",
      "Patrick Hand",
      "Roboto",
      "Roboto Condensed",
      "Roboto Mono",
      "Roboto Slab",
      "Open Sans",
      "Lato",
      "Montserrat",
      "Oswald",
      "Raleway",
      "Source Sans Pro",
      "Merriweather",
      "Playfair Display",
      "Nunito",
      "Poppins",
      "Inter",
      "Work Sans",
      "PT Sans",
      "PT Serif",
      "Noto Sans",
      "Noto Serif",
      "Rubik",
      "Quicksand",
      "Josefin Sans",
      "Libre Baskerville",
      "Crimson Text",
      "Lora",
      "Cormorant Garamond",
      "EB Garamond",
      "Fira Sans",
      "Karla",
      "Mulish",
      "Manrope",
      "DM Sans",
      "DM Serif Display",
      "Space Mono",
      "IBM Plex Sans",
      "IBM Plex Mono",
      "Barlow",
      "Cabin",
      "Dosis",
      "Exo",
      "Figtree",
      "Heebo",
      "Inconsolata",
      "Anton",
      "Bebas Neue",
      "Permanent Marker",
      "Shadows Into Light",
      "Indie Flower",
      "Dancing Script",
      "Pacifico",
      "Satisfy",
      "Architects Daughter",
      "Amatic SC",
    ] as const
  ).map((family) => [family.toLowerCase(), family] as const),
);
