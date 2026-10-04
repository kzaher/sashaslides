/**
 * extraction.ts — the layout model this converter consumes, and the boundary
 * parser that produces it.
 *
 * REUSE NOTE. The DOM walk itself is NOT reimplemented here. The extractor is
 * `renderer/html2slides/extract-dom.ts` — 3477 lines of measured, hard-won
 * geometry that already runs in a browser (it has zero `import`s and is a bare
 * IIFE returning a JSON string, see extract-dom.ts:448 and :3465). It is
 * injected verbatim and its JSON output is what this file parses.
 *
 * Two things are deliberately NOT borrowed from the renderer:
 *
 *  1. `extract-dom.ts`'s own types are file-local (no `export`, see
 *     extract-dom.ts:121-445), so they are unimportable by construction.
 *  2. The importable copies in `convert-pptx-lib.ts:854-1210` come attached to
 *     194 KB of pptxgenjs-coupled code that does not compile under
 *     `exactOptionalPropertyTypes` — a type-only import of `Extraction` from it
 *     reports errors inside that file and fails this module's gate.
 *
 * So the shape is re-declared, and the re-declaration is turned into an asset
 * rather than drift: `extract-dom.ts:343` is deliberately ONE permissive
 * interface with ~60 optional fields ("consumers narrow via the `type`
 * discriminator"), whereas the emitter wants an exhaustive sum type. The
 * parser below does that narrowing once, at the eval boundary, so the emitter
 * can `switch` with `assertNever` and every missing field is already resolved
 * to an explicit `null` instead of `undefined`.
 *
 * Absence is modelled as `| null` throughout rather than `?:`. Under
 * `exactOptionalPropertyTypes` an optional property and a nullable one are
 * different types, and a model built by a parser has no use for the
 * distinction — every field is always present, sometimes empty.
 *
 * Hand-written narrowing rather than typia: typia needs its `ts-patch`
 * transform registered in a tsconfig, and this module is checked with
 * `--ignoreConfig` and bundled for a content script, so the transform would
 * never run and the call would degrade to a bare cast.
 */

/** CSS px in the extractor's 1280x720 viewport. */
export type BoundsPx = Readonly<{ x: number; y: number; w: number; h: number }>;

export type SizePx = Readonly<{ w: number; h: number }>;

/** `#rrggbb` plus a separate 0–1 alpha, matching `fill` + `fillAlpha`. */
export type Paint = Readonly<{ hex: string; alpha: number }>;

export type GradientStop = Readonly<{ hex: string; position: number; alpha: number }>;

export type Gradient = Readonly<{
  type: "linear" | "radial";
  angleDeg: number;
  stops: readonly GradientStop[];
}>;

export type BorderSideName = "top" | "right" | "bottom" | "left";

export type BorderSide = Readonly<{
  widthPx: number;
  hex: string | null;
  style: string;
}>;

export type Border = Readonly<{
  widthPx: number;
  hex: string | null;
  style: string;
  /** False when the four sides differ in width or colour. */
  uniform: boolean;
  sides: Readonly<Record<BorderSideName, BorderSide>>;
}>;

/** Clockwise from top-left, in CSS px. */
export type CornerRadiiPx = readonly [number, number, number, number];

export type ShadowInfo = Readonly<{
  offsetXPx: number;
  offsetYPx: number;
  blurPx: number;
  spreadPx: number;
  /** Spread-only halo layers the pptx path materialised as extra rects. */
  ringCount: number;
}>;

export type PaddingPx = Readonly<{
  top: number;
  right: number;
  bottom: number;
  left: number;
}>;

export type TextDecoration = Readonly<{ underline: boolean; strikethrough: boolean }>;

/** Everything the emitter needs to build one `TextStyle` + `ParagraphStyle`. */
export type TypeStyle = Readonly<{
  fontFamily: string;
  fontSizePx: number;
  bold: boolean;
  italic: boolean;
  hex: string | null;
  decoration: TextDecoration;
  /** Computed `line-height` in px (extract-dom.ts:716 resolves it to px). */
  lineHeightPx: number;
  letterSpacingPx: number;
  textAlign: string;
  writingMode: string | null;
  highlightHex: string | null;
  baseline: "baseline" | "sub" | "super";
}>;

/** A styled span inside a text element; `style` is null for an unstyled run. */
export type TextRun = Readonly<{ text: string; style: TypeStyle | null }>;

type ElementCommon = Readonly<{
  bounds: BoundsPx;
  /** `_domIdx` when the extractor stamped one, for cross-linking to the HTML. */
  domIndex: number | null;
  rotateDeg: number;
  /** Pre-transform layout box; needed to place a rotated element correctly. */
  naturalSizePx: SizePx | null;
  opacity: number;
  /** CSS paint order index — Slides stacks page elements by creation order. */
  paintIndex: number;
}>;

/** Fill/border/shadow fields that `extract-dom.ts` shares between rect and text. */
export type BoxDecoration = Readonly<{
  fill: Paint | null;
  gradient: Gradient | null;
  border: Border | null;
  cornerRadiiPx: CornerRadiiPx;
  shadow: ShadowInfo | null;
  backgroundImage: string | null;
  clipPath: string | null;
}>;

export type RectElement = ElementCommon &
  Readonly<{ kind: "rect"; decoration: BoxDecoration }>;

export type TextElement = ElementCommon &
  Readonly<{
    kind: "text";
    text: string;
    runs: readonly TextRun[];
    style: TypeStyle;
    decoration: BoxDecoration;
    verticallyCentered: boolean;
    singleLine: boolean;
    paddingPx: PaddingPx;
  }>;

export type ListItemModel = Readonly<{
  text: string;
  runs: readonly TextRun[];
  /** 0-based nesting depth; becomes leading tabs in `insertText`. */
  level: number;
  style: TypeStyle;
  bulletHex: string | null;
  /** True for a CSS-drawn dot marker rather than a literal glyph. */
  bulletIsDot: boolean;
}>;

export type ListElement = ElementCommon &
  Readonly<{
    kind: "list";
    items: readonly ListItemModel[];
    ordered: boolean;
    listStyleType: string;
    /** A `::before` glyph standing in for a real marker, if any. */
    pseudoBulletChar: string | null;
    /** The list's own card background, when it has one. */
    container: BoxDecoration | null;
    containerPaddingPx: PaddingPx;
  }>;

export type TableCellModel = Readonly<{
  text: string;
  runs: readonly TextRun[];
  isHeader: boolean;
  colspan: number;
  rowspan: number;
  bounds: BoundsPx | null;
  paddingPx: PaddingPx;
  fill: Paint | null;
  style: TypeStyle;
  border: Border | null;
}>;

export type TableElement = ElementCommon &
  Readonly<{
    kind: "table";
    rows: readonly (readonly TableCellModel[])[];
    fill: Paint | null;
    borderCollapse: string;
  }>;

export type ImageElement = ElementCommon &
  Readonly<{ kind: "image"; src: string; tag: string; cornerRadiusPx: number }>;

/** `<svg>`, `<canvas>`, conic gradients, clip-path hosts — bitmap-only content. */
export type VisualElement = ElementCommon & Readonly<{ kind: "visual"; tag: string }>;

export type LineElement = ElementCommon &
  Readonly<{
    kind: "line";
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    hex: string | null;
    strokeWidthPx: number;
    dashType: string;
  }>;

export type TriangleElement = ElementCommon &
  Readonly<{ kind: "triangle"; decoration: BoxDecoration }>;

export type PolyElement = ElementCommon &
  Readonly<{ kind: "poly"; points: readonly Readonly<{ x: number; y: number }>[] }>;

/**
 * Carried through rather than dropped so the emitter decides whether silence is
 * right: `br`/`skip` are the extractor's own sentinels and are expected, while
 * `unknown` means the extractor grew a variant this converter has not mapped
 * and must surface as an anomaly.
 */
export type IgnoredElement = ElementCommon &
  Readonly<{ kind: "ignored"; reason: "br" | "skip" | "unknown"; originalType: string }>;

export type SlideElement =
  | RectElement
  | TextElement
  | ListElement
  | TableElement
  | ImageElement
  | VisualElement
  | LineElement
  | TriangleElement
  | PolyElement
  | IgnoredElement;

export type ParsedExtraction = Readonly<{
  viewportPx: SizePx;
  elements: readonly SlideElement[];
  /** Entries rejected outright (no usable `bounds`); a non-zero count is a bug signal. */
  malformedCount: number;
}>;

/**
 * Narrow the extractor's JSON into the model above.
 *
 * `raw` is whatever came back from evaluating the extractor blob inside the
 * staging iframe — untrusted by type, so this is the one place that inspects
 * `unknown`. Everything downstream works on `ParsedExtraction`.
 */
export function parseExtraction(raw: unknown): ParsedExtraction {
  if (!isRecord(raw)) throw new Error("extraction is not an object");
  const viewport = isRecord(raw["viewport"]) ? raw["viewport"] : {};
  const viewportPx: SizePx = {
    w: numberOr(viewport["w"], DEFAULT_VIEWPORT.w),
    h: numberOr(viewport["h"], DEFAULT_VIEWPORT.h),
  };
  const rawElements = raw["elements"];
  if (!Array.isArray(rawElements)) throw new Error("extraction.elements is not an array");

  const elements: SlideElement[] = [];
  let malformedCount = 0;
  for (const candidate of rawElements) {
    const element = parseElement(candidate, elements.length);
    if (element === null) {
      malformedCount++;
      continue;
    }
    elements.push(element);
  }
  return { viewportPx, elements, malformedCount };
}

/** The extractor's own fallback when `document.body` reports no size. */
const DEFAULT_VIEWPORT: SizePx = { w: 1280, h: 720 };

const ZERO_PADDING: PaddingPx = { top: 0, right: 0, bottom: 0, left: 0 };

const NO_RADII: CornerRadiiPx = [0, 0, 0, 0];

function parseElement(candidate: unknown, paintIndex: number): SlideElement | null {
  if (!isRecord(candidate)) return null;
  const bounds = parseBounds(candidate["bounds"]);
  if (bounds === null) return null;

  const style = isRecord(candidate["style"]) ? candidate["style"] : {};
  const common: ElementCommon = {
    bounds,
    domIndex: optionalNumber(candidate["_domIdx"]),
    rotateDeg: numberOr(candidate["rotate"], numberOr(style["rotate"], 0)),
    naturalSizePx: parseNaturalSize(candidate, style),
    opacity: clamp01(numberOr(style["opacity"], 1)),
    paintIndex,
  };

  switch (stringOr(candidate["type"], "")) {
    case "rect":
      return { ...common, kind: "rect", decoration: parseDecoration(candidate, style) };
    case "triangle":
      return { ...common, kind: "triangle", decoration: parseDecoration(candidate, style) };
    case "text":
      return parseTextElement(candidate, style, common);
    case "list":
      return parseListElement(candidate, style, common);
    case "table":
      return parseTableElement(candidate, style, common);
    case "image":
      return {
        ...common,
        kind: "image",
        src: stringOr(candidate["src"], ""),
        tag: stringOr(candidate["tag"], "img"),
        cornerRadiusPx: numberOr(candidate["cornerRadius"], 0),
      };
    case "visual":
      return { ...common, kind: "visual", tag: stringOr(candidate["tag"], "unknown") };
    case "line":
      return parseLineElement(candidate, bounds, common);
    case "poly":
      return { ...common, kind: "poly", points: parsePoints(candidate["points"]) };
    case "br":
      return { ...common, kind: "ignored", reason: "br", originalType: "br" };
    case "_skip":
      return { ...common, kind: "ignored", reason: "skip", originalType: "_skip" };
    default:
      return {
        ...common,
        kind: "ignored",
        reason: "unknown",
        originalType: stringOr(candidate["type"], "<missing>"),
      };
  }
}

function parseTextElement(
  candidate: Readonly<Record<string, unknown>>,
  style: Readonly<Record<string, unknown>>,
  common: ElementCommon,
): TextElement {
  const baseStyle = parseTypeStyle(style, FALLBACK_TYPE_STYLE);
  return {
    ...common,
    kind: "text",
    text: stringOr(candidate["text"], ""),
    runs: parseRuns(candidate["runs"], baseStyle),
    style: baseStyle,
    decoration: parseDecoration(candidate, style),
    verticallyCentered: candidate["verticallyCentered"] === true,
    singleLine: candidate["singleLine"] === true,
    paddingPx: parsePadding(candidate["padding"]),
  };
}

function parseListElement(
  candidate: Readonly<Record<string, unknown>>,
  style: Readonly<Record<string, unknown>>,
  common: ElementCommon,
): ListElement {
  const baseStyle = parseTypeStyle(style, FALLBACK_TYPE_STYLE);
  const rawItems = Array.isArray(candidate["items"]) ? candidate["items"] : [];
  const items: ListItemModel[] = [];
  for (const rawItem of rawItems) {
    if (!isRecord(rawItem)) continue;
    items.push({
      text: stringOr(rawItem["text"], ""),
      runs: parseRuns(rawItem["runs"], parseTypeStyle(rawItem, baseStyle)),
      level: Math.max(0, Math.round(numberOr(rawItem["level"], 0))),
      style: parseTypeStyle(rawItem, baseStyle),
      bulletHex: parseHex(rawItem["bulletColor"]),
      bulletIsDot: rawItem["bulletIsDot"] === true,
    });
  }
  const rawContainer = candidate["containerStyle"];
  const container = isRecord(rawContainer)
    ? parseDecoration({ ...rawContainer, fill: rawContainer["bgColor"] }, rawContainer)
    : null;
  return {
    ...common,
    kind: "list",
    items,
    ordered: candidate["ordered"] === true,
    listStyleType: stringOr(candidate["listStyleType"], ""),
    pseudoBulletChar:
      candidate["hasPseudoBullet"] === true
        ? stringOr(candidate["pseudoBulletChar"], "•")
        : null,
    container,
    containerPaddingPx: isRecord(rawContainer)
      ? parsePadding(rawContainer["padding"])
      : ZERO_PADDING,
  };
}

function parseTableElement(
  candidate: Readonly<Record<string, unknown>>,
  style: Readonly<Record<string, unknown>>,
  common: ElementCommon,
): TableElement {
  const baseStyle = parseTypeStyle(style, FALLBACK_TYPE_STYLE);
  const rawRows = Array.isArray(candidate["rows"]) ? candidate["rows"] : [];
  const rows: (readonly TableCellModel[])[] = [];
  for (const rawRow of rawRows) {
    if (!Array.isArray(rawRow)) continue;
    const cells: TableCellModel[] = [];
    for (const rawCell of rawRow) {
      if (!isRecord(rawCell)) continue;
      const cellStyle = isRecord(rawCell["style"]) ? rawCell["style"] : {};
      const resolved = parseTypeStyle(cellStyle, baseStyle);
      cells.push({
        text: stringOr(rawCell["text"], ""),
        runs: parseRuns(rawCell["runs"], resolved),
        isHeader: rawCell["isHeader"] === true,
        colspan: Math.max(1, Math.round(numberOr(rawCell["colspan"], 1))),
        rowspan: Math.max(1, Math.round(numberOr(rawCell["rowspan"], 1))),
        bounds: parseBounds(rawCell["bounds"]),
        paddingPx: parsePadding(rawCell["padding"]),
        fill: parsePaint(rawCell["bgColor"] ?? cellStyle["bgColor"], cellStyle["bgAlpha"]),
        style: resolved,
        border: parseBorder(cellStyle, cellStyle),
      });
    }
    rows.push(cells);
  }
  return {
    ...common,
    kind: "table",
    rows,
    fill: parsePaint(candidate["bgColor"], style["bgAlpha"]),
    borderCollapse: stringOr(candidate["borderCollapse"], "separate"),
  };
}

function parseLineElement(
  candidate: Readonly<Record<string, unknown>>,
  bounds: BoundsPx,
  common: ElementCommon,
): LineElement {
  return {
    ...common,
    kind: "line",
    x1: numberOr(candidate["x1"], bounds.x),
    y1: numberOr(candidate["y1"], bounds.y),
    x2: numberOr(candidate["x2"], bounds.x + bounds.w),
    y2: numberOr(candidate["y2"], bounds.y + bounds.h),
    hex: parseHex(candidate["color"]),
    strokeWidthPx: numberOr(candidate["strokeWidth"], 1),
    dashType: stringOr(candidate["dashType"], "solid"),
  };
}

/**
 * Used when the extractor emitted no style object at all. Arial 16/normal is
 * the UA default the fixtures all reset to, so it is the least surprising
 * stand-in and never silently invents a size the HTML did not ask for.
 */
const FALLBACK_TYPE_STYLE: TypeStyle = {
  fontFamily: "Arial",
  fontSizePx: 16,
  bold: false,
  italic: false,
  hex: "#000000",
  decoration: { underline: false, strikethrough: false },
  lineHeightPx: 16 * 1.2,
  letterSpacingPx: 0,
  textAlign: "start",
  writingMode: null,
  highlightHex: null,
  baseline: "baseline",
};

/**
 * Reads the font/colour fields out of any object that carries them —
 * `ElementStyle`, a `TextRun.style`, a `ListItem`, or a `TableCell.style` all
 * use the same key names, so one reader covers every site. Anything the source
 * omits falls back to `inherited`.
 */
function parseTypeStyle(
  source: Readonly<Record<string, unknown>>,
  inherited: TypeStyle,
): TypeStyle {
  const decorationText = source["textDecoration"];
  const decoration =
    typeof decorationText === "string"
      ? {
          underline: decorationText.includes("underline"),
          strikethrough: decorationText.includes("line-through"),
        }
      : inherited.decoration;
  const fontSizePx = numberOr(source["fontSize"], inherited.fontSizePx);
  const baselineRaw = stringOr(source["verticalAlign"], "baseline");
  return {
    fontFamily: stringOr(source["fontFamily"], inherited.fontFamily),
    fontSizePx,
    bold: parseBold(source["fontWeight"], inherited.bold),
    italic: source["fontStyle"] === "italic" ? true : source["fontStyle"] === "normal" ? false : inherited.italic,
    hex: "color" in source ? parseHex(source["color"]) : inherited.hex,
    decoration,
    // A missing line-height means "whatever the font gives"; mirror
    // extract-dom.ts:716's own 1.2 fallback rather than inheriting a pitch
    // that belonged to a different font size.
    lineHeightPx: numberOr(source["lineHeight"], fontSizePx * 1.2),
    letterSpacingPx: numberOr(source["letterSpacing"], inherited.letterSpacingPx),
    textAlign: stringOr(source["textAlign"], inherited.textAlign),
    writingMode: parseOptionalString(source["writingMode"], inherited.writingMode),
    highlightHex: "bgColor" in source ? parseHex(source["bgColor"]) : inherited.highlightHex,
    baseline: baselineRaw === "sub" ? "sub" : baselineRaw === "super" ? "super" : "baseline",
  };
}

function parseRuns(raw: unknown, inherited: TypeStyle): readonly TextRun[] {
  if (!Array.isArray(raw)) return [];
  const runs: TextRun[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const text = stringOr(candidate["text"], "");
    const rawStyle = candidate["style"];
    runs.push({
      text,
      style: isRecord(rawStyle) ? parseTypeStyle(rawStyle, inherited) : null,
    });
  }
  return runs;
}

function parseDecoration(
  candidate: Readonly<Record<string, unknown>>,
  style: Readonly<Record<string, unknown>>,
): BoxDecoration {
  return {
    fill: parsePaint(candidate["fill"] ?? style["bgColor"], candidate["fillAlpha"] ?? style["bgAlpha"]),
    gradient: parseGradient(candidate["gradient"]),
    border: parseBorder(candidate, style),
    cornerRadiiPx: parseCornerRadii(candidate, style),
    shadow: parseShadow(candidate["boxShadow"] ?? style["boxShadow"], style["shadowRings"]),
    backgroundImage: parseOptionalString(style["backgroundImage"], null),
    clipPath: parseOptionalString(style["clipPath"], null),
  };
}

function parseBorder(
  candidate: Readonly<Record<string, unknown>>,
  style: Readonly<Record<string, unknown>>,
): Border | null {
  const rawSides = candidate["borderSides"] ?? style["borderSides"];
  const sides = parseBorderSides(rawSides);
  const widthPx = numberOr(candidate["borderWidth"], numberOr(style["borderWidth"], 0));
  const hex = parseHex(candidate["borderColor"] ?? style["borderColor"]);
  const anySide =
    sides !== null &&
    (sides.top.widthPx > 0 || sides.right.widthPx > 0 || sides.bottom.widthPx > 0 || sides.left.widthPx > 0);
  if (widthPx <= 0 && !anySide) return null;

  const resolvedSides: Readonly<Record<BorderSideName, BorderSide>> =
    sides ?? uniformSides({ widthPx, hex, style: stringOr(candidate["borderStyle"], "solid") });
  const uniformFlag = candidate["borderUniform"] ?? style["borderUniform"];
  return {
    widthPx,
    hex,
    style: stringOr(candidate["borderStyle"], stringOr(style["borderStyle"], "solid")),
    uniform: typeof uniformFlag === "boolean" ? uniformFlag : sidesAreUniform(resolvedSides),
    sides: resolvedSides,
  };
}

function parseBorderSides(raw: unknown): Readonly<Record<BorderSideName, BorderSide>> | null {
  if (!isRecord(raw)) return null;
  const read = (name: BorderSideName): BorderSide => {
    const side = isRecord(raw[name]) ? raw[name] : {};
    return {
      widthPx: numberOr(side["width"], 0),
      hex: parseHex(side["color"]),
      style: stringOr(side["style"], "solid"),
    };
  };
  return { top: read("top"), right: read("right"), bottom: read("bottom"), left: read("left") };
}

function uniformSides(side: BorderSide): Readonly<Record<BorderSideName, BorderSide>> {
  return { top: side, right: side, bottom: side, left: side };
}

function sidesAreUniform(sides: Readonly<Record<BorderSideName, BorderSide>>): boolean {
  const names: readonly BorderSideName[] = ["top", "right", "bottom", "left"];
  const first = sides.top;
  return names.every(
    (name) => sides[name].widthPx === first.widthPx && sides[name].hex === first.hex,
  );
}

function parseCornerRadii(
  candidate: Readonly<Record<string, unknown>>,
  style: Readonly<Record<string, unknown>>,
): CornerRadiiPx {
  const raw = candidate["cornerRadii"] ?? style["cornerRadii"];
  if (isRecord(raw)) {
    return [
      numberOr(raw["tl"], 0),
      numberOr(raw["tr"], 0),
      numberOr(raw["br"], 0),
      numberOr(raw["bl"], 0),
    ];
  }
  const scalar = numberOr(candidate["borderRadius"], numberOr(style["borderRadius"], 0));
  return scalar > 0 ? [scalar, scalar, scalar, scalar] : NO_RADII;
}

function parseShadow(raw: unknown, rawRings: unknown): ShadowInfo | null {
  const ringCount = Array.isArray(rawRings) ? rawRings.length : 0;
  if (!isRecord(raw)) {
    if (ringCount === 0) return null;
    return { offsetXPx: 0, offsetYPx: 0, blurPx: 0, spreadPx: 0, ringCount };
  }
  return {
    offsetXPx: numberOr(raw["offsetX"], 0),
    offsetYPx: numberOr(raw["offsetY"], 0),
    blurPx: numberOr(raw["blur"], 0),
    spreadPx: numberOr(raw["spread"], 0),
    ringCount,
  };
}

function parseGradient(raw: unknown): Gradient | null {
  if (!isRecord(raw)) return null;
  const rawStops = Array.isArray(raw["stops"]) ? raw["stops"] : [];
  const stops: GradientStop[] = [];
  for (const candidate of rawStops) {
    if (!isRecord(candidate)) continue;
    const hex = parseHex(candidate["color"]);
    if (hex === null) continue;
    stops.push({
      hex,
      position: clamp01(numberOr(candidate["position"], 0)),
      alpha: clamp01(numberOr(candidate["alpha"], 1)),
    });
  }
  if (stops.length === 0) return null;
  return {
    type: raw["type"] === "radial" ? "radial" : "linear",
    angleDeg: numberOr(raw["angle"], 180),
    stops,
  };
}

function parsePaint(rawHex: unknown, rawAlpha: unknown): Paint | null {
  const hex = parseHex(rawHex);
  if (hex === null) return null;
  return { hex, alpha: clamp01(numberOr(rawAlpha, 1)) };
}

/**
 * The extractor already blends `rgba()` onto whatever is behind it
 * (`rgbaToBlendedHex`, extract-dom.ts:562), so every colour that reaches here
 * is expected to be `#rgb` or `#rrggbb`. Anything else — a leftover keyword,
 * `transparent`, `none` — is treated as "no colour" rather than guessed at.
 */
function parseHex(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  if (/^#[0-9a-f]{3}$/.test(text)) {
    // SAFETY: the regex above guarantees indices 1..3 exist.
    return `#${text[1]!}${text[1]!}${text[2]!}${text[2]!}${text[3]!}${text[3]!}`;
  }
  return null;
}

function parseBounds(raw: unknown): BoundsPx | null {
  if (!isRecord(raw)) return null;
  const x = raw["x"];
  const y = raw["y"];
  const w = raw["w"];
  const h = raw["h"];
  if (!isFinite2(x) || !isFinite2(y) || !isFinite2(w) || !isFinite2(h)) return null;
  return { x, y, w, h };
}

function parseNaturalSize(
  candidate: Readonly<Record<string, unknown>>,
  style: Readonly<Record<string, unknown>>,
): SizePx | null {
  const w = candidate["naturalWidth"] ?? style["naturalWidth"];
  const h = candidate["naturalHeight"] ?? style["naturalHeight"];
  if (!isFinite2(w) || !isFinite2(h) || w <= 0 || h <= 0) return null;
  return { w, h };
}

function parsePadding(raw: unknown): PaddingPx {
  if (!isRecord(raw)) return ZERO_PADDING;
  return {
    top: numberOr(raw["top"], 0),
    right: numberOr(raw["right"], 0),
    bottom: numberOr(raw["bottom"], 0),
    left: numberOr(raw["left"], 0),
  };
}

function parsePoints(raw: unknown): readonly Readonly<{ x: number; y: number }>[] {
  if (!Array.isArray(raw)) return [];
  const points: Readonly<{ x: number; y: number }>[] = [];
  for (const candidate of raw) {
    if (!isRecord(candidate)) continue;
    const x = candidate["x"];
    const y = candidate["y"];
    if (!isFinite2(x) || !isFinite2(y)) continue;
    points.push({ x, y });
  }
  return points;
}

/**
 * `extract-dom.ts` normalises weight to the literals `"bold"` / `"normal"`
 * (resolveRenderedWeight, extract-dom.ts:519), but a numeric weight can still
 * arrive from a raw computed-style object, so both spellings are accepted.
 */
function parseBold(raw: unknown, inherited: boolean): boolean {
  if (raw === "bold") return true;
  if (raw === "normal") return false;
  if (typeof raw === "number") return raw >= 600;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw) >= 600;
  return inherited;
}

function parseOptionalString(raw: unknown, inherited: string | null): string | null {
  if (typeof raw === "string") return raw.length > 0 ? raw : null;
  if (raw === null) return null;
  return inherited;
}

function stringOr(raw: unknown, fallback: string): string {
  return typeof raw === "string" ? raw : fallback;
}

function numberOr(raw: unknown, fallback: number): number {
  return isFinite2(raw) ? raw : fallback;
}

function optionalNumber(raw: unknown): number | null {
  return isFinite2(raw) ? raw : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isFinite2(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isFinite(raw);
}

function isRecord(raw: unknown): raw is Readonly<Record<string, unknown>> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}
