// THE EDITOR'S LOOK: "Tidepool", the product's style, as the ONE set of design tokens every engine
// surface uses -- top bar, toolbar, filmstrip, properties panel, menus, dialogs, comment rail,
// notices, presenter controls, speaker view. The user asked for "the entire editor in this same
// style"; the values are lifted from the three places the look already lives:
//
//   mcp/sasha-slides/addon/src/tidepool-styles.ts       sidebar: lively morphing shapes, liquid glass
//   mcp/sasha-slides/addon/src/tidepool-calm-styles.ts  slides window: calm wash, glass cells, ink pills
//   renderer/html2slides/addon-server/public/site.css   website, including the dark variant
//
// Rules the tokens encode (SPEC.md "Visual style"):
//
//  * PEARL GROUND with a CALM wash behind the canvas whose colours turn slowly (hue-rotate 0 to 70
//    degrees and saturate 1 to 1.15 over 40 seconds, in 120 steps, paused during gestures); nothing
//    moves behind a slide being edited. The LIVELY drifting shapes are only for empty and home
//    screens.
//  * CHROME IS LIQUID GLASS (milestone 2, SPEC.md 21.11): panels are white at 0.26 to 0.45
//    (`panelGlass`), with a bright 1 pixel top edge, a soft lift shadow, and a backdrop blur plus
//    saturation (`panelBackdrop`) -- but ONLY while no gesture is active on the engine root
//    (`:not([data-gesture="active"])`). Re-blurring the animated wash behind three full-height
//    panels on every frame of a drag is what milestone 1 measured as too slow; a drag drops the
//    blur and the wash is paused anyway, so nothing behind the glass moves while it is sharp.
//    The more translucent glass lets more of the wash through, so the text colours are chosen to
//    pass 4.5:1 over the most saturated wash the backdrop filter can produce (the theme test).
//  * CHROME THAT CAN OVERLAP THE SLIDE (menus, the context menu, the inline text toolbar, popovers)
//    is `glassOverCanvas`, nearly opaque: over an arbitrary slide -- black, white, a photo -- the
//    translucent glass fails text contrast (measured: 3.31:1 over black). Dialogs sit on `scrim`, a
//    dimming without blur, so the canvas is never blurred.
//  * BUTTONS ARE INK PILLS, TABS ARE PILLS. Text #1c2333, muted #3d4659, accent #4338ca, Manrope.
//  * THE SLIDE CONTENT IS NEVER RESTYLED. Nothing here applies inside a slide root.
//  * TEXT CONTRAST AT LEAST 4.5:1, checked by tidepool-theme.test.ts against every surface a text
//    colour is drawn on, including the wash at every 10 degrees of its hue swing and chrome over a
//    black and a white slide, in both schemes.
//  * MOTION OFF UNDER prefers-reduced-motion; glass and colours stay.
//
// Every token, colour or not, is emitted as a `--sasha-*` custom property
// (`tidepoolCustomProperties`), and the shared stylesheet (tidepool-stylesheet.ts) and every
// component read only those properties.

export type TidepoolScheme = Readonly<{
  /** The page behind everything. */
  ground: string;
  /** The calm wash's three radial colours (behind the canvas area), at their peaks. */
  washColours: readonly [string, string, string];
  /** The lively shapes' gradient pairs (home and empty screens only). */
  livelyShapeGradients: readonly (readonly [string, string])[];
  livelyShapeOpacity: number;
  /** Fixed chrome panels on the editing screen; alpha 0.26 to 0.45, blurred while no gesture runs. */
  panelGlass: string;
  /** Cards and grouped controls inside a panel. */
  cardGlass: string;
  /** Glass over the lively shapes (home screens), drawn WITH the backdrop blur. */
  livelyGlass: string;
  /** Anything that can overlap the slide: menus, popovers, the inline text toolbar. */
  glassOverCanvas: string;
  glassEdge: string;
  glassTopHighlight: string;
  glassBottomShade: string;
  liftShadow: string;
  /** Behind dialogs, without blur. */
  scrim: string;
  /** Text and icons. */
  text: string;
  textMuted: string;
  /** Inactive pill tabs, placeholders, captions. */
  textSubtle: string;
  accent: string;
  accentSoft: string;
  /** Selection outline and handles on the canvas; the halo keeps them visible on any slide colour. */
  selection: string;
  selectionHalo: string;
  handleFill: string;
  inkButton: string;
  inkButtonHover: string;
  inkButtonText: string;
  secondaryButton: string;
  secondaryButtonHover: string;
  dangerButton: string;
  dangerButtonHover: string;
  dangerButtonText: string;
  tabOn: string;
  tabOnShadow: string;
  hairline: string;
  success: string;
  warning: string;
  danger: string;
  focusRing: string;
  /** Presence cursors, selection outlines and comment avatars; 3:1 against ground and panels. */
  peerColours: readonly string[];
  /** Text on a peer-coloured name label; 4.5:1 against every peer colour. */
  peerLabelText: string;
}>;

export type TidepoolTokens = Readonly<{
  light: TidepoolScheme;
  dark: TidepoolScheme;
  typography: Readonly<{
    fontFamily: string;
    /** The transition script editor. */
    codeFontFamily: string;
    fontStylesheetAddress: string;
    /** Pixels. */
    sizes: Readonly<{ caption: number; small: number; body: number; title: number; heading: number }>;
    weights: Readonly<{ regular: number; medium: number; semibold: number; bold: number }>;
    lineHeight: number;
  }>;
  /** Pixels. */
  spacing: Readonly<{ extraSmall: number; small: number; medium: number; large: number; extraLarge: number }>;
  /** Pixels. */
  radius: Readonly<{ panel: number; card: number; control: number; pill: number }>;
  /** Pixels. */
  control: Readonly<{ height: number; iconSize: number; focusRingWidth: number; handleSize: number; selectionWidth: number }>;
  disabledOpacity: number;
  /** Stacking order of the editor's layers (z-index). */
  layers: Readonly<{ wash: number; canvas: number; canvasOverlay: number; chrome: number; popover: number; scrim: number; dialog: number; notice: number; presenter: number }>;
  /** Only on the lively home screens (see the header). */
  livelyBackdropFilter: string;
  /** The chrome panels' backdrop, applied only while no gesture is active (see the header). */
  panelBackdrop: Readonly<{ blurPixels: number; saturation: number }>;
  motion: Readonly<{
    calmHueSeconds: number;
    calmHueMaximumDegrees: number;
    calmSaturateMaximum: number;
    /** The wash changes in this many discrete steps per swing: a couple of repaints per second, not sixty. */
    calmHueSteps: number;
    /** The lively shapes' drift periods, seconds. */
    livelyDriftSeconds: readonly number[];
    /** Chrome transitions (menus opening, tabs switching). */
    chromeTransitionMilliseconds: number;
  }>;
}>;

export const TIDEPOOL_TOKENS: TidepoolTokens = {
  light: {
    ground: "#eef1f6",
    washColours: ["#c7f0fb", "#f6d4ec", "#d4f5e2"],
    livelyShapeGradients: [
      ["#67e8f9", "#a5b4fc"],
      ["#f9a8d4", "#c4b5fd"],
      ["#86efac", "#7dd3fc"],
      ["#fde68a", "#fdba74"],
      ["#a5b4fc", "#67e8f9"],
    ],
    livelyShapeOpacity: 0.85,
    panelGlass: "rgba(255, 255, 255, 0.38)",
    cardGlass: "rgba(255, 255, 255, 0.45)",
    livelyGlass: "rgba(255, 255, 255, 0.26)",
    glassOverCanvas: "rgba(255, 255, 255, 0.92)",
    glassEdge: "rgba(255, 255, 255, 0.85)",
    glassTopHighlight: "rgba(255, 255, 255, 0.95)",
    glassBottomShade: "rgba(120, 130, 170, 0.18)",
    liftShadow: "0 12px 32px rgba(80, 90, 140, 0.14)",
    scrim: "rgba(28, 35, 51, 0.32)",
    text: "#1c2333",
    textMuted: "#3d4659",
    textSubtle: "#4b5468",
    accent: "#4338ca",
    accentSoft: "rgba(67, 56, 202, 0.08)",
    selection: "#6366f1",
    selectionHalo: "#ffffff",
    handleFill: "#ffffff",
    inkButton: "#1c2333",
    inkButtonHover: "#2d3650",
    inkButtonText: "#ffffff",
    secondaryButton: "rgba(28, 35, 51, 0.07)",
    secondaryButtonHover: "rgba(28, 35, 51, 0.12)",
    dangerButton: "#b91c1c",
    dangerButtonHover: "#991b1b",
    dangerButtonText: "#ffffff",
    tabOn: "rgba(255, 255, 255, 0.95)",
    tabOnShadow: "0 2px 6px rgba(28, 35, 51, 0.12)",
    hairline: "rgba(28, 35, 51, 0.10)",
    success: "#065f46",
    warning: "#92400e",
    danger: "#b91c1c",
    focusRing: "#4338ca",
    peerColours: ["#4338ca", "#0e7490", "#be185d", "#047857", "#b45309", "#7c3aed"],
    peerLabelText: "#ffffff",
  },
  dark: {
    ground: "#0e1220",
    // As painted: site.css draws these hues at 45 % over the ground, so the token is the blend.
    washColours: ["#0e3e52", "#4e1434", "#0a4039"],
    livelyShapeGradients: [
      ["#0e7490", "#4338ca"],
      ["#9d174d", "#5b21b6"],
      ["#047857", "#0369a1"],
      ["#92400e", "#9d174d"],
      ["#4338ca", "#0e7490"],
    ],
    livelyShapeOpacity: 0.45,
    panelGlass: "rgba(24, 30, 48, 0.45)",
    cardGlass: "rgba(36, 46, 72, 0.55)",
    livelyGlass: "rgba(30, 38, 60, 0.45)",
    glassOverCanvas: "rgba(24, 30, 48, 0.94)",
    glassEdge: "rgba(255, 255, 255, 0.16)",
    glassTopHighlight: "rgba(255, 255, 255, 0.22)",
    glassBottomShade: "rgba(0, 0, 0, 0.25)",
    liftShadow: "0 12px 32px rgba(0, 0, 0, 0.35)",
    scrim: "rgba(0, 0, 0, 0.5)",
    text: "#eef1f8",
    // Lightened from #aeb6c9 for the 0.45 glass: the dark teal wash, saturated by the backdrop
    // filter, left subtle text on a hovered secondary pill at 4.29:1.
    textMuted: "#bcc3d4",
    textSubtle: "#bcc3d4",
    accent: "#a5b4fc",
    accentSoft: "rgba(165, 180, 252, 0.14)",
    selection: "#818cf8",
    selectionHalo: "#0e1220",
    handleFill: "#0e1220",
    inkButton: "#eef1f8",
    inkButtonHover: "#d7dcea",
    inkButtonText: "#1c2333",
    secondaryButton: "rgba(255, 255, 255, 0.08)",
    secondaryButtonHover: "rgba(255, 255, 255, 0.14)",
    dangerButton: "#fca5a5",
    dangerButtonHover: "#fecaca",
    dangerButtonText: "#1c2333",
    tabOn: "rgba(255, 255, 255, 0.16)",
    tabOnShadow: "0 2px 6px rgba(0, 0, 0, 0.3)",
    hairline: "rgba(255, 255, 255, 0.10)",
    success: "#34d399",
    warning: "#fbbf24",
    danger: "#fca5a5",
    focusRing: "#a5b4fc",
    peerColours: ["#a5b4fc", "#67e8f9", "#f9a8d4", "#6ee7b7", "#fcd34d", "#c4b5fd"],
    peerLabelText: "#0e1220",
  },
  typography: {
    fontFamily: "Manrope, Roboto, Arial, sans-serif",
    codeFontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontStylesheetAddress: "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700&display=swap",
    sizes: { caption: 11.5, small: 12.5, body: 14, title: 16, heading: 20 },
    weights: { regular: 400, medium: 500, semibold: 600, bold: 700 },
    lineHeight: 1.45,
  },
  spacing: { extraSmall: 4, small: 8, medium: 12, large: 16, extraLarge: 24 },
  radius: { panel: 22, card: 18, control: 12, pill: 999 },
  control: { height: 32, iconSize: 18, focusRingWidth: 2, handleSize: 9, selectionWidth: 1.5 },
  disabledOpacity: 0.45,
  layers: { wash: -1, canvas: 1, canvasOverlay: 2, chrome: 10, popover: 20, scrim: 30, dialog: 31, notice: 40, presenter: 50 },
  livelyBackdropFilter: "blur(12px) saturate(170%)",
  panelBackdrop: { blurPixels: 18, saturation: 1.5 },
  motion: {
    calmHueSeconds: 40,
    calmHueMaximumDegrees: 70,
    calmSaturateMaximum: 1.15,
    calmHueSteps: 120,
    livelyDriftSeconds: [14, 17, 20, 19, 16],
    chromeTransitionMilliseconds: 160,
  },
};

export type SchemeName = "light" | "dark";

/** One custom property: its name without the `--sasha-` prefix, and its value. */
export type CustomProperty = Readonly<{ name: string; value: string }>;

/**
 * Every token of one scheme, plus every scheme-independent token, as custom properties
 * (`--sasha-ground: #eef1f6;` ...). Names are the token paths in kebab case.
 */
export function tidepoolCustomProperties(options: Readonly<{ tokens: TidepoolTokens; scheme: SchemeName }>): readonly CustomProperty[] {
  return [...schemeProperties(options.tokens[options.scheme]), ...sharedProperties(options.tokens)];
}

/** The properties as declarations for a rule body. */
export function customPropertyDeclarations(properties: readonly CustomProperty[]): string {
  return properties.map((property) => `--sasha-${property.name}: ${property.value};`).join(" ");
}

function schemeProperties(scheme: TidepoolScheme): readonly CustomProperty[] {
  const properties: CustomProperty[] = [];
  for (const [key, value] of Object.entries(scheme)) {
    if (typeof value === "string") {
      properties.push({ name: kebabCase(key), value });
      continue;
    }
    if (typeof value === "number") {
      properties.push({ name: kebabCase(key), value: String(value) });
      continue;
    }
    appendListProperties({ properties, key, value });
  }
  return properties;
}

function appendListProperties(options: Readonly<{ properties: CustomProperty[]; key: string; value: unknown }>): void {
  if (!Array.isArray(options.value)) return;
  options.value.forEach((entry: unknown, index: number) => {
    const name = `${kebabCase(options.key)}-${index + 1}`;
    if (typeof entry === "string") {
      options.properties.push({ name, value: entry });
      return;
    }
    if (!Array.isArray(entry)) return;
    entry.forEach((stop: unknown, stopIndex: number) => {
      if (typeof stop === "string") options.properties.push({ name: `${name}-${stopIndex + 1}`, value: stop });
    });
  });
}

function sharedProperties(tokens: TidepoolTokens): readonly CustomProperty[] {
  const typography = tokens.typography;
  return [
    { name: "font-family", value: typography.fontFamily },
    { name: "code-font-family", value: typography.codeFontFamily },
    ...Object.entries(typography.sizes).map(([key, value]) => ({ name: `font-size-${kebabCase(key)}`, value: `${value}px` })),
    ...Object.entries(typography.weights).map(([key, value]) => ({ name: `font-weight-${kebabCase(key)}`, value: String(value) })),
    { name: "line-height", value: String(typography.lineHeight) },
    ...Object.entries(tokens.spacing).map(([key, value]) => ({ name: `space-${kebabCase(key)}`, value: `${value}px` })),
    ...Object.entries(tokens.radius).map(([key, value]) => ({ name: `radius-${kebabCase(key)}`, value: `${value}px` })),
    ...Object.entries(tokens.control).map(([key, value]) => ({ name: `control-${kebabCase(key)}`, value: `${value}px` })),
    { name: "disabled-opacity", value: String(tokens.disabledOpacity) },
    ...Object.entries(tokens.layers).map(([key, value]) => ({ name: `layer-${kebabCase(key)}`, value: String(value) })),
    { name: "lively-backdrop-filter", value: tokens.livelyBackdropFilter },
    { name: "panel-backdrop-filter", value: `blur(${tokens.panelBackdrop.blurPixels}px) saturate(${Math.round(tokens.panelBackdrop.saturation * 100)}%)` },
    { name: "calm-hue-duration", value: `${tokens.motion.calmHueSeconds}s` },
    { name: "chrome-transition-duration", value: `${tokens.motion.chromeTransitionMilliseconds}ms` },
  ];
}

function kebabCase(camel: string): string {
  return camel.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
