/**
 * A Google Slides `Presentation` (the `presentations.get` answer) as typed, normalised values,
 * and the one parser that produces it from untrusted JSON.
 *
 * WHERE THE JSON COMES FROM decides why this is a parser and not a cast: the brokered path reads
 * it from Google, but the add-on path receives it in a request body Code.gs posted
 * (`AddonImportRequest.presentation: unknown`), which anyone holding an import token can shape.
 * So every field is read through a narrowing reader with a default, the same approach as the
 * converter's extraction.ts, and the importer only ever sees these types.
 *
 * NORMALISED ON THE WAY IN, so the mapping code has one representation per idea:
 *   * every length is a number of English metric units (`Dimension` arrives in EMU or PT, and a
 *     dimension without `magnitude` is 0, as Google omits zeros);
 *   * a colour is `{ kind: "literal", hexadecimal }` or `{ kind: "theme", type }` (an empty `rgbColor`
 *     is black, since Google omits zero channels: the master's DARK1 is `"color": {}`);
 *   * text is paragraphs of runs, split at each "\n" of the `textElements` stream;
 *   * a property with `propertyState` is `rendered`, `notRendered` or `inherit`.
 * Anything the importer does not map (a property it does not read, an element kind it does not
 * know) is dropped here or kept as an `unknown` element that becomes a loss.
 */

export const ENGLISH_METRIC_UNITS_PER_POINT = 12_700;

export type SlidesPresentation = Readonly<{
  presentationId: string;
  title: string;
  revisionId: string | null;
  pageSize: Readonly<{ widthEnglishMetricUnits: number; heightEnglishMetricUnits: number }>;
  slides: readonly SlidesPage[];
  layouts: readonly SlidesPage[];
  masters: readonly SlidesPage[];
}>;

export type SlidesPage = Readonly<{
  objectId: string;
  elements: readonly SlidesPageElement[];
  background: SlidesPageBackground;
  /** Slides only. */
  layoutObjectId: string | null;
  isSkipped: boolean;
  speakerNotes: SlidesText | null;
  /** Layouts: `layoutProperties.displayName`; masters: `masterProperties.displayName`. */
  displayName: string;
  /** Masters only: the colour of each `ThemeColorType` this page defines. */
  colourScheme: ReadonlyMap<string, string>;
}>;

export type SlidesColour = Readonly<{ kind: "literal"; hexadecimal: string }> | Readonly<{ kind: "theme"; type: string }>;

export type SlidesSolidFill = Readonly<{ colour: SlidesColour; alpha: number }>;

export type PropertyState = "rendered" | "notRendered" | "inherit";

export type SlidesPageBackground =
  | Readonly<{ kind: "inherit" }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "solid"; fill: SlidesSolidFill }>
  | Readonly<{ kind: "picture"; contentUrl: string }>;

export type SlidesFill = Readonly<{ state: PropertyState; solid: SlidesSolidFill | null }>;

export type SlidesOutline = Readonly<{
  state: PropertyState;
  solid: SlidesSolidFill | null;
  weightEnglishMetricUnits: number | null;
  dashStyle: string | null;
}>;

export type SlidesShadow = Readonly<{
  state: PropertyState;
  blurEnglishMetricUnits: number;
  offsetXEnglishMetricUnits: number;
  offsetYEnglishMetricUnits: number;
  alignment: string;
  solid: SlidesSolidFill | null;
}>;

/** Maps element-local coordinates (EMU) to the parent's: x' = scaleX x + shearX y + translateX. */
export type SlidesTransform = Readonly<{
  scaleX: number;
  scaleY: number;
  shearX: number;
  shearY: number;
  translateX: number;
  translateY: number;
}>;

export const IDENTITY_TRANSFORM: SlidesTransform = { scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, translateX: 0, translateY: 0 };

export type SlidesPlaceholder = Readonly<{ type: string; index: number; parentObjectId: string | null }>;

export type SlidesPageElement = Readonly<{
  objectId: string;
  title: string;
  description: string;
  widthEnglishMetricUnits: number;
  heightEnglishMetricUnits: number;
  /** Relative to the parent group, if any (the Slides convention). */
  transform: SlidesTransform;
  content: SlidesElementContent;
}>;

/**
 * The shape type of a shape Google answers WITHOUT one: an outline that is no preset, such as a pptx
 * custom geometry (measured: the html2slides complex fixtures' funnel trapezoids). It is the Slides
 * `ShapeType` enum's own name for a custom shape. Reading it as a text box (the old default) drew it
 * as one, silently, and let it grow with its text.
 */
export const CUSTOM_SHAPE_TYPE = "CUSTOM";

export type SlidesShape = Readonly<{
  kind: "shape";
  shapeType: string;
  placeholder: SlidesPlaceholder | null;
  text: SlidesText | null;
  fill: SlidesFill;
  outline: SlidesOutline;
  shadow: SlidesShadow | null;
  contentAlignment: string | null;
  autofitType: string | null;
}>;

export type SlidesTableCell = Readonly<{
  rowIndex: number;
  columnIndex: number;
  rowSpan: number;
  columnSpan: number;
  text: SlidesText | null;
  fill: SlidesFill;
  contentAlignment: string | null;
  /**
   * The cell's text margins. `presentations.get` does NOT return them (TableCellProperties holds
   * only the fill and the alignment), so the parser always leaves this null; only a reader of the
   * presentation's pptx export (its `<a:tcPr marL/marR/marT/marB>`, which Google writes from the
   * stored values) can fill it in. The importer infers margins when it is null.
   */
  marginsEnglishMetricUnits: SlidesCellMargins | null;
}>;

export type SlidesCellMargins = Readonly<{ top: number; right: number; bottom: number; left: number }>;

export type SlidesTableBorder = Readonly<{ solid: SlidesSolidFill | null; weightEnglishMetricUnits: number; dashStyle: string }>;

export type SlidesElementContent =
  | SlidesShape
  | Readonly<{
      kind: "image";
      contentUrl: string | null;
      placeholder: SlidesPlaceholder | null;
      crop: Readonly<{ left: number; right: number; top: number; bottom: number }>;
      transparency: number;
      /** Brightness, contrast or recolour: what the engine cannot hold. */
      adjusted: boolean;
      outline: SlidesOutline;
    }>
  | Readonly<{
      kind: "line";
      lineCategory: string;
      weightEnglishMetricUnits: number;
      dashStyle: string;
      solid: SlidesSolidFill | null;
      startArrow: string;
      endArrow: string;
      connected: boolean;
    }>
  | Readonly<{
      kind: "table";
      rowHeightsEnglishMetricUnits: readonly number[];
      columnWidthsEnglishMetricUnits: readonly number[];
      cells: readonly SlidesTableCell[];
      /**
       * `horizontalBorderRows`, by "row:column": the line ABOVE row `row` (rows + 1 lines) at
       * column `column`. SPARSE, as Google sends it: a line inside a merged region is absent.
       */
      horizontalBorders: ReadonlyMap<string, SlidesTableBorder>;
      /** `verticalBorderRows`, by "row:column": the line LEFT of column `column` (columns + 1) in row `row`. */
      verticalBorders: ReadonlyMap<string, SlidesTableBorder>;
    }>
  | Readonly<{ kind: "group"; children: readonly SlidesPageElement[] }>
  | Readonly<{ kind: "sheetsChart"; contentUrl: string | null }>
  | Readonly<{ kind: "video"; address: string }>
  | Readonly<{ kind: "wordArt"; renderedText: string }>
  | Readonly<{ kind: "speakerSpotlight" }>
  | Readonly<{ kind: "unknown"; description: string }>;

export type SlidesText = Readonly<{ paragraphs: readonly SlidesParagraph[] }>;

export type SlidesParagraph = Readonly<{
  style: SlidesParagraphStyle;
  /** null: not a list paragraph. `style` is the bullet's own `bulletStyle` (its colour and size). */
  bullet: Readonly<{ listId: string; nestingLevel: number; glyph: string; style: SlidesTextStyle }> | null;
  /** Nesting level for style inheritance: the bullet's, else 0. */
  nestingLevel: number;
  runs: readonly SlidesRun[];
  /** The style of the paragraph's closing "\n": what a child placeholder inherits at this level. */
  markStyle: SlidesTextStyle;
}>;

export type SlidesRun =
  | Readonly<{ kind: "text"; content: string; style: SlidesTextStyle }>
  | Readonly<{ kind: "autoText"; autoTextType: string; content: string; style: SlidesTextStyle }>;

export type SlidesLink =
  | Readonly<{ kind: "url"; url: string }>
  | Readonly<{ kind: "page"; pageObjectId: string }>
  | Readonly<{ kind: "slideIndex"; slideIndex: number }>
  | Readonly<{ kind: "relative"; relativeLink: string }>;

/** Only the fields the run sets; an absent field inherits (the Slides programming interface convention). */
export type SlidesTextStyle = Readonly<{
  fontFamily?: string;
  weight?: number;
  fontSizePoints?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  smallCaps?: boolean;
  baselineOffset?: string;
  /** null: set to "no colour" (an empty OptionalColor). */
  foreground?: SlidesColour | null;
  background?: SlidesColour | null;
  link?: SlidesLink;
}>;

export type SlidesParagraphStyle = Readonly<{
  alignment?: string;
  lineSpacingPercent?: number;
  spaceAbovePoints?: number;
  spaceBelowPoints?: number;
  indentStartPoints?: number;
  indentFirstLinePoints?: number;
  direction?: string;
  /** NEVER_COLLAPSE marks a paragraph uploaded from a .pptx (import-uploaded-leading.ts). */
  spacingMode?: string;
}>;

export type ParsedPresentation =
  | Readonly<{ kind: "ok"; presentation: SlidesPresentation }>
  | Readonly<{ kind: "invalid"; message: string }>;

export function parsePresentation(raw: unknown): ParsedPresentation {
  const root = record(raw);
  if (root === null) return { kind: "invalid", message: "The presentation is not an object." };
  const presentationId = stringOr(root["presentationId"], "");
  if (presentationId.length === 0) return { kind: "invalid", message: "The presentation has no presentationId." };
  const pageSize = record(root["pageSize"]) ?? {};
  return {
    kind: "ok",
    presentation: {
      presentationId,
      title: stringOr(root["title"], "Untitled presentation"),
      revisionId: typeof root["revisionId"] === "string" ? root["revisionId"] : null,
      pageSize: {
        widthEnglishMetricUnits: dimension(pageSize["width"]) || DEFAULT_PAGE_WIDTH,
        heightEnglishMetricUnits: dimension(pageSize["height"]) || DEFAULT_PAGE_HEIGHT,
      },
      slides: list(root["slides"]).map(parsePage),
      layouts: list(root["layouts"]).map(parsePage),
      masters: list(root["masters"]).map(parsePage),
    },
  };
}

const DEFAULT_PAGE_WIDTH = 9_144_000;
const DEFAULT_PAGE_HEIGHT = 5_143_500;

function parsePage(raw: unknown): SlidesPage {
  const page = record(raw) ?? {};
  const slideProperties = record(page["slideProperties"]) ?? {};
  const pageProperties = record(page["pageProperties"]) ?? {};
  const layoutProperties = record(page["layoutProperties"]) ?? {};
  const masterProperties = record(page["masterProperties"]) ?? {};
  return {
    objectId: stringOr(page["objectId"], ""),
    elements: list(page["pageElements"]).map(parseElement),
    background: parseBackground(pageProperties["pageBackgroundFill"]),
    layoutObjectId: typeof slideProperties["layoutObjectId"] === "string" ? slideProperties["layoutObjectId"] : null,
    isSkipped: slideProperties["isSkipped"] === true,
    speakerNotes: parseSpeakerNotes(slideProperties["notesPage"]),
    displayName: stringOr(layoutProperties["displayName"], stringOr(masterProperties["displayName"], "")),
    colourScheme: parseColourScheme(pageProperties["colorScheme"]),
  };
}

function parseBackground(raw: unknown): SlidesPageBackground {
  const fill = record(raw);
  if (fill === null) return { kind: "inherit" };
  const state = propertyState(fill["propertyState"]);
  switch (state) {
    case "inherit":
      return { kind: "inherit" };
    case "notRendered":
      return { kind: "none" };
    case "rendered":
      break;
    default:
      return assertNever(state);
  }
  const picture = record(fill["stretchedPictureFill"]);
  if (picture !== null && typeof picture["contentUrl"] === "string") return { kind: "picture", contentUrl: picture["contentUrl"] };
  const solid = parseSolidFill(fill["solidFill"]);
  return solid === null ? { kind: "inherit" } : { kind: "solid", fill: solid };
}

/** The notes page's body: the shape named by `notesProperties.speakerNotesObjectId`. */
function parseSpeakerNotes(raw: unknown): SlidesText | null {
  const notesPage = record(raw);
  if (notesPage === null) return null;
  const notesProperties = record(notesPage["notesProperties"]) ?? {};
  const bodyId = notesProperties["speakerNotesObjectId"];
  for (const candidate of list(notesPage["pageElements"])) {
    const element = record(candidate);
    if (element === null || element["objectId"] !== bodyId) continue;
    const shape = record(element["shape"]);
    return shape === null ? null : parseText(shape["text"]);
  }
  return null;
}

function parseColourScheme(raw: unknown): ReadonlyMap<string, string> {
  const scheme = new Map<string, string>();
  for (const candidate of list(record(raw)?.["colors"])) {
    const entry = record(candidate);
    if (entry === null || typeof entry["type"] !== "string") continue;
    scheme.set(entry["type"], hexadecimalOf(entry["color"]));
  }
  return scheme;
}

function parseElement(raw: unknown): SlidesPageElement {
  const element = record(raw) ?? {};
  const size = record(element["size"]) ?? {};
  return {
    objectId: stringOr(element["objectId"], ""),
    title: stringOr(element["title"], ""),
    description: stringOr(element["description"], ""),
    widthEnglishMetricUnits: dimension(size["width"]),
    heightEnglishMetricUnits: dimension(size["height"]),
    transform: parseTransform(element["transform"]),
    content: parseContent(element),
  };
}

function parseTransform(raw: unknown): SlidesTransform {
  const transform = record(raw);
  if (transform === null) return IDENTITY_TRANSFORM;
  const unitScale = transform["unit"] === "PT" ? ENGLISH_METRIC_UNITS_PER_POINT : 1;
  return {
    scaleX: numberOr(transform["scaleX"], 0),
    scaleY: numberOr(transform["scaleY"], 0),
    shearX: numberOr(transform["shearX"], 0),
    shearY: numberOr(transform["shearY"], 0),
    translateX: numberOr(transform["translateX"], 0) * unitScale,
    translateY: numberOr(transform["translateY"], 0) * unitScale,
  };
}

function parseContent(element: Readonly<Record<string, unknown>>): SlidesElementContent {
  const shape = record(element["shape"]);
  if (shape !== null) return parseShape(shape);
  const image = record(element["image"]);
  if (image !== null) return parseImage(image);
  const line = record(element["line"]);
  if (line !== null) return parseLine(line);
  const table = record(element["table"]);
  if (table !== null) return parseTable(table);
  const group = record(element["elementGroup"]);
  if (group !== null) return { kind: "group", children: list(group["children"]).map(parseElement) };
  const chart = record(element["sheetsChart"]);
  if (chart !== null) return { kind: "sheetsChart", contentUrl: typeof chart["contentUrl"] === "string" ? chart["contentUrl"] : null };
  const video = record(element["video"]);
  if (video !== null) return { kind: "video", address: videoAddressOf(video) };
  const wordArt = record(element["wordArt"]);
  if (wordArt !== null) return { kind: "wordArt", renderedText: stringOr(wordArt["renderedText"], "") };
  if (record(element["speakerSpotlight"]) !== null) return { kind: "speakerSpotlight" };
  const keys = Object.keys(element).filter((key) => !["objectId", "size", "transform", "title", "description"].includes(key));
  return { kind: "unknown", description: keys.join(", ") || "an element with no content" };
}

function videoAddressOf(video: Readonly<Record<string, unknown>>): string {
  if (typeof video["url"] === "string") return video["url"];
  const id = stringOr(video["id"], "");
  return video["source"] === "YOUTUBE" ? `https://www.youtube.com/watch?v=${id}` : `https://drive.google.com/file/d/${id}/view`;
}

function parseShape(shape: Readonly<Record<string, unknown>>): SlidesShape {
  const properties = record(shape["shapeProperties"]) ?? {};
  const autofit = record(properties["autofit"]);
  return {
    kind: "shape",
    shapeType: stringOr(shape["shapeType"], CUSTOM_SHAPE_TYPE),
    placeholder: parsePlaceholder(shape["placeholder"]),
    text: shape["text"] === undefined ? null : parseText(shape["text"]),
    fill: parseFill(properties["shapeBackgroundFill"]),
    outline: parseOutline(properties["outline"]),
    shadow: parseShadow(properties["shadow"]),
    contentAlignment: typeof properties["contentAlignment"] === "string" ? properties["contentAlignment"] : null,
    autofitType: typeof autofit?.["autofitType"] === "string" ? autofit["autofitType"] : null,
  };
}

function parsePlaceholder(raw: unknown): SlidesPlaceholder | null {
  const placeholder = record(raw);
  if (placeholder === null) return null;
  return {
    type: stringOr(placeholder["type"], "NONE"),
    index: numberOr(placeholder["index"], 0),
    parentObjectId: typeof placeholder["parentObjectId"] === "string" ? placeholder["parentObjectId"] : null,
  };
}

function parseImage(image: Readonly<Record<string, unknown>>): SlidesElementContent {
  const properties = record(image["imageProperties"]) ?? {};
  const crop = record(properties["cropProperties"]) ?? {};
  const recolour = record(properties["recolor"]);
  return {
    kind: "image",
    contentUrl: typeof image["contentUrl"] === "string" ? image["contentUrl"] : null,
    placeholder: parsePlaceholder(image["placeholder"]),
    crop: {
      left: numberOr(crop["leftOffset"], 0),
      right: numberOr(crop["rightOffset"], 0),
      top: numberOr(crop["topOffset"], 0),
      bottom: numberOr(crop["bottomOffset"], 0),
    },
    transparency: numberOr(properties["transparency"], 0),
    adjusted: numberOr(properties["brightness"], 0) !== 0 || numberOr(properties["contrast"], 0) !== 0 || (recolour !== null && Object.keys(recolour).length > 0),
    outline: parseOutline(properties["outline"]),
  };
}

function parseLine(line: Readonly<Record<string, unknown>>): SlidesElementContent {
  const properties = record(line["lineProperties"]) ?? {};
  const lineFill = record(properties["lineFill"]) ?? {};
  return {
    kind: "line",
    lineCategory: stringOr(line["lineCategory"], "STRAIGHT"),
    weightEnglishMetricUnits: dimension(properties["weight"]) || 9525,
    dashStyle: stringOr(properties["dashStyle"], "SOLID"),
    solid: parseSolidFill(lineFill["solidFill"]),
    startArrow: stringOr(properties["startArrow"], "NONE"),
    endArrow: stringOr(properties["endArrow"], "NONE"),
    connected: record(properties["startConnection"]) !== null || record(properties["endConnection"]) !== null,
  };
}

function parseTable(table: Readonly<Record<string, unknown>>): SlidesElementContent {
  const cells: SlidesTableCell[] = [];
  const rowHeights: number[] = [];
  for (const rawRow of list(table["tableRows"])) {
    const row = record(rawRow) ?? {};
    rowHeights.push(dimension(row["rowHeight"]));
    for (const rawCell of list(row["tableCells"])) {
      const cell = record(rawCell) ?? {};
      const location = record(cell["location"]) ?? {};
      const properties = record(cell["tableCellProperties"]) ?? {};
      cells.push({
        rowIndex: numberOr(location["rowIndex"], 0),
        columnIndex: numberOr(location["columnIndex"], 0),
        rowSpan: Math.max(1, numberOr(cell["rowSpan"], 1)),
        columnSpan: Math.max(1, numberOr(cell["columnSpan"], 1)),
        text: cell["text"] === undefined ? null : parseText(cell["text"]),
        fill: parseFill(properties["tableCellBackgroundFill"]),
        contentAlignment: typeof properties["contentAlignment"] === "string" ? properties["contentAlignment"] : null,
        marginsEnglishMetricUnits: null,
      });
    }
  }
  return {
    kind: "table",
    rowHeightsEnglishMetricUnits: rowHeights,
    columnWidthsEnglishMetricUnits: list(table["tableColumns"]).map((column) => dimension(record(column)?.["columnWidth"])),
    cells,
    horizontalBorders: parseBorderRows(table["horizontalBorderRows"]),
    verticalBorders: parseBorderRows(table["verticalBorderRows"]),
  };
}

/** Border cells by their own `location` (measured: the lists skip lines inside merged regions). */
function parseBorderRows(raw: unknown): ReadonlyMap<string, SlidesTableBorder> {
  const borders = new Map<string, SlidesTableBorder>();
  for (const rawRow of list(raw)) {
    for (const rawCell of list(record(rawRow)?.["tableBorderCells"])) {
      const cell = record(rawCell) ?? {};
      const location = record(cell["location"]) ?? {};
      const properties = record(cell["tableBorderProperties"]);
      if (properties === null) continue;
      const fill = record(properties["tableBorderFill"]) ?? {};
      borders.set(`${numberOr(location["rowIndex"], 0)}:${numberOr(location["columnIndex"], 0)}`, {
        solid: parseSolidFill(fill["solidFill"]),
        weightEnglishMetricUnits: dimension(properties["weight"]),
        dashStyle: stringOr(properties["dashStyle"], "SOLID"),
      });
    }
  }
  return borders;
}

function parseFill(raw: unknown): SlidesFill {
  const fill = record(raw);
  if (fill === null) return { state: "inherit", solid: null };
  return { state: propertyState(fill["propertyState"]), solid: parseSolidFill(fill["solidFill"]) };
}

function parseOutline(raw: unknown): SlidesOutline {
  const outline = record(raw);
  if (outline === null) return { state: "inherit", solid: null, weightEnglishMetricUnits: null, dashStyle: null };
  const outlineFill = record(outline["outlineFill"]) ?? {};
  return {
    state: propertyState(outline["propertyState"]),
    solid: parseSolidFill(outlineFill["solidFill"]),
    weightEnglishMetricUnits: outline["weight"] === undefined ? null : dimension(outline["weight"]),
    dashStyle: typeof outline["dashStyle"] === "string" ? outline["dashStyle"] : null,
  };
}

function parseShadow(raw: unknown): SlidesShadow | null {
  const shadow = record(raw);
  if (shadow === null) return null;
  const transform = parseTransform(shadow["transform"]);
  const colour = shadow["color"];
  return {
    state: propertyState(shadow["propertyState"]),
    blurEnglishMetricUnits: dimension(shadow["blurRadius"]),
    offsetXEnglishMetricUnits: transform.translateX,
    offsetYEnglishMetricUnits: transform.translateY,
    alignment: stringOr(shadow["alignment"], "BOTTOM_LEFT"),
    solid: colour === undefined ? null : { colour: parseOpaqueColour(colour), alpha: numberOr(shadow["alpha"], 1) },
  };
}

function parseSolidFill(raw: unknown): SlidesSolidFill | null {
  const solid = record(raw);
  if (solid === null) return null;
  return { colour: parseOpaqueColour(solid["color"]), alpha: numberOr(solid["alpha"], 1) };
}

/** An `OpaqueColor`: `{ rgbColor }` or `{ themeColor }`; an empty `rgbColor` is black. */
function parseOpaqueColour(raw: unknown): SlidesColour {
  const colour = record(raw) ?? {};
  if (typeof colour["themeColor"] === "string") return { kind: "theme", type: colour["themeColor"] };
  return { kind: "literal", hexadecimal: hexadecimalOf(colour["rgbColor"]) };
}

/** An `OptionalColor`: `{ opaqueColor }`, or `{}` meaning transparent (null). */
function parseOptionalColour(raw: unknown): SlidesColour | null {
  const optional = record(raw);
  if (optional === null) return null;
  const opaque = optional["opaqueColor"];
  return opaque === undefined ? null : parseOpaqueColour(opaque);
}

export function hexadecimalOf(raw: unknown): string {
  const rgb = record(raw) ?? {};
  const channel = (value: unknown): string =>
    Math.round(Math.min(1, Math.max(0, numberOr(value, 0))) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb["red"])}${channel(rgb["green"])}${channel(rgb["blue"])}`;
}

/**
 * The `textElements` stream as paragraphs. A paragraph marker opens a paragraph; runs append to it;
 * every "\n" inside a run's content closes it, and the "\n" run's style is the paragraph's mark
 * style (what a child placeholder inherits at this nesting level).
 */
export function parseText(raw: unknown): SlidesText {
  const text = record(raw) ?? {};
  const paragraphs: SlidesParagraph[] = [];
  let open: { style: SlidesParagraphStyle; bullet: SlidesParagraph["bullet"]; runs: SlidesRun[] } | null = null;
  const close = (markStyle: SlidesTextStyle): void => {
    const current = open ?? { style: {}, bullet: null, runs: [] };
    paragraphs.push({ style: current.style, bullet: current.bullet, nestingLevel: current.bullet?.nestingLevel ?? 0, runs: current.runs, markStyle });
    open = null;
  };
  for (const rawElement of list(text["textElements"])) {
    const element = record(rawElement) ?? {};
    const marker = record(element["paragraphMarker"]);
    if (marker !== null) {
      open = { style: parseParagraphStyle(marker["style"]), bullet: parseBullet(marker["bullet"]), runs: [] };
      continue;
    }
    const autoText = record(element["autoText"]);
    if (autoText !== null) {
      open ??= { style: {}, bullet: null, runs: [] };
      open.runs.push({ kind: "autoText", autoTextType: stringOr(autoText["type"], "SLIDE_NUMBER"), content: stringOr(autoText["content"], ""), style: parseTextStyle(autoText["style"]) });
      continue;
    }
    const run = record(element["textRun"]);
    if (run === null) continue;
    const style = parseTextStyle(run["style"]);
    const pieces = stringOr(run["content"], "").split("\n");
    pieces.forEach((piece, index) => {
      // Only text opens a paragraph here: the empty piece after a closing "\n" must not leave an
      // empty trailing paragraph behind (measured: it pushed bottom-aligned titles up a line).
      if (piece.length > 0) {
        open ??= { style: {}, bullet: null, runs: [] };
        open.runs.push({ kind: "text", content: piece, style });
      }
      if (index < pieces.length - 1) close(style);
    });
  }
  // A body whose last run lacks the closing "\n" (not seen from Google, possible from a hand-made body).
  if (open !== null) close({});
  return { paragraphs };
}

function parseBullet(raw: unknown): SlidesParagraph["bullet"] {
  const bullet = record(raw);
  if (bullet === null) return null;
  return {
    listId: stringOr(bullet["listId"], ""),
    nestingLevel: numberOr(bullet["nestingLevel"], 0),
    glyph: stringOr(bullet["glyph"], ""),
    style: parseTextStyle(bullet["bulletStyle"]),
  };
}

function parseTextStyle(raw: unknown): SlidesTextStyle {
  const style = record(raw) ?? {};
  const weighted = record(style["weightedFontFamily"]);
  const result: { -readonly [Key in keyof SlidesTextStyle]: SlidesTextStyle[Key] } = {};
  const family = typeof weighted?.["fontFamily"] === "string" ? weighted["fontFamily"] : style["fontFamily"];
  if (typeof family === "string") result.fontFamily = family;
  if (typeof weighted?.["weight"] === "number") result.weight = weighted["weight"];
  if (style["fontSize"] !== undefined) result.fontSizePoints = dimension(style["fontSize"]) / ENGLISH_METRIC_UNITS_PER_POINT;
  for (const key of ["bold", "italic", "underline", "strikethrough", "smallCaps"] as const) {
    const value = style[key];
    if (typeof value === "boolean") result[key] = value;
  }
  if (typeof style["baselineOffset"] === "string") result.baselineOffset = style["baselineOffset"];
  if (style["foregroundColor"] !== undefined) result.foreground = parseOptionalColour(style["foregroundColor"]);
  if (style["backgroundColor"] !== undefined) result.background = parseOptionalColour(style["backgroundColor"]);
  const link = parseLink(style["link"]);
  if (link !== null) result.link = link;
  return result;
}

function parseLink(raw: unknown): SlidesLink | null {
  const link = record(raw);
  if (link === null) return null;
  if (typeof link["url"] === "string") return { kind: "url", url: link["url"] };
  if (typeof link["pageObjectId"] === "string") return { kind: "page", pageObjectId: link["pageObjectId"] };
  if (typeof link["slideIndex"] === "number") return { kind: "slideIndex", slideIndex: link["slideIndex"] };
  if (typeof link["relativeLink"] === "string") return { kind: "relative", relativeLink: link["relativeLink"] };
  return null;
}

function parseParagraphStyle(raw: unknown): SlidesParagraphStyle {
  const style = record(raw) ?? {};
  const result: { -readonly [Key in keyof SlidesParagraphStyle]: SlidesParagraphStyle[Key] } = {};
  if (typeof style["alignment"] === "string") result.alignment = style["alignment"];
  if (typeof style["lineSpacing"] === "number") result.lineSpacingPercent = style["lineSpacing"];
  const points = (key: string): number | undefined => (style[key] === undefined ? undefined : dimension(style[key]) / ENGLISH_METRIC_UNITS_PER_POINT);
  const spaceAbove = points("spaceAbove");
  if (spaceAbove !== undefined) result.spaceAbovePoints = spaceAbove;
  const spaceBelow = points("spaceBelow");
  if (spaceBelow !== undefined) result.spaceBelowPoints = spaceBelow;
  const indentStart = points("indentStart");
  if (indentStart !== undefined) result.indentStartPoints = indentStart;
  const indentFirstLine = points("indentFirstLine");
  if (indentFirstLine !== undefined) result.indentFirstLinePoints = indentFirstLine;
  if (typeof style["direction"] === "string") result.direction = style["direction"];
  if (typeof style["spacingMode"] === "string") result.spacingMode = style["spacingMode"];
  return result;
}

function propertyState(raw: unknown): PropertyState {
  if (raw === "NOT_RENDERED") return "notRendered";
  if (raw === "INHERIT") return "inherit";
  return "rendered";
}

/** A `Dimension` in EMU; Google omits a zero magnitude. */
function dimension(raw: unknown): number {
  const value = record(raw);
  if (value === null) return 0;
  const magnitude = numberOr(value["magnitude"], 0);
  return value["unit"] === "PT" ? magnitude * ENGLISH_METRIC_UNITS_PER_POINT : magnitude;
}

function record(raw: unknown): Readonly<Record<string, unknown>> | null {
  // A non-null, non-array object: its keys are read one at a time below, each narrowed again.
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Readonly<Record<string, unknown>>) : null;
}

function list(raw: unknown): readonly unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function stringOr(raw: unknown, fallback: string): string {
  return typeof raw === "string" ? raw : fallback;
}

function numberOr(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
