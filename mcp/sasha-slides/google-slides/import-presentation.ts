/**
 * IMPORT: a parsed `presentations.get` answer to the engine's theme, layouts and slides, following
 * every row of SPEC.md 21.12's import table, plus the losses the person is told about.
 *
 * PURE ON PURPOSE. Image bytes are the only input that needs the network, so the caller fetches
 * them first (`imageAddressesIn` names every address, `import-assets.ts` fetches and stores them)
 * and hands the outcome in as `images`; this function then decides everything from values. The
 * mapping tests run it on the recorded fixture with a table of fake image outcomes.
 *
 * IDS ARE KEPT WHEN THEY CAN BE (ids.ts: every engine id is a valid Slides object id, so an id
 * that is already one keeps the element's identity across both). A Slides id that does not match
 * `OBJECT_ID_PATTERN` (the short page ids `p`, `p2`, ...) or that was already used is MINTED from
 * `idSeed` (`mintId`), which is deterministic, so a re-import of the same presentation mints the
 * same ids.
 *
 * WHAT SLIDES DRAWS THAT THE ENGINE HOLDS DIFFERENTLY:
 *   * a master's and a layout's own decorations (non-placeholder elements) draw behind every slide
 *     that uses them; the engine has no live master, so they are copied to the back of each such
 *     slide (and kept on the layout too);
 *   * a slide whose background is inherited takes its layout's background when the layout has one
 *     (an engine slide with `background: null` shows the THEME background, not the layout's).
 */
import type { InterchangeLoss } from "../engine/src/contracts/deck-api.ts";
import type {
  AssetRecord,
  CellBorders,
  CustomOutline,
  ElementSnapshot,
  GroupElement,
  LayoutSnapshot,
  PlaceholderReference,
  PlaceholderRole,
  PlaceholderStyle,
  ShapeElement,
  ShapePreset,
  SlideSnapshot,
  TableCell,
  TableElement,
  TextBody,
  ThemeSnapshot,
} from "../engine/src/contracts/document.ts";
import type { Frame } from "../engine/src/contracts/geometry.ts";
import type { ElementId, IdSeed, LayoutId, ListId, MintedIdByKind, SlideId, TableColumnId, TableRowId } from "../engine/src/contracts/ids.ts";
import { isObjectId, mintId } from "../engine/src/contracts/ids.ts";
import type { ArrowHead, Border, Colour, DashStyle, Fill, LineRouting, Shadow, Stroke, TextAutofit, TextBoxStyle, VerticalAlignment } from "../engine/src/contracts/style.ts";
import { colourOf, FALLBACK_SLOT_COLOURS, THEME_SLOT_BY_SLIDES_TYPE, type ColourContext } from "./import-colours.ts";
import type { PptxElementSupplement, PptxGradient, PptxSupplement } from "./import-pptx-supplement.ts";
import { roundedShapeOf, type ShapeAdjustments, type ShapeAdjustmentsByObjectId } from "./import-shape-geometry.ts";
import { insetsForUploadedText, uploadedTrailingSpacingPoints } from "./import-uploaded-leading.ts";
import { EMPTY_BODY, importTextBody, resolvedPlaceholderStyle, roundUnits, type TextContext } from "./import-text.ts";
import { composeTransforms, frameForTransform, pageScaleFor, rotationOf, transformPoint, type PageScale } from "./interchange-geometry.ts";
import { createLossCollector, type InterchangeLossSink } from "./interchange-losses.ts";
import {
  CUSTOM_SHAPE_TYPE,
  IDENTITY_TRANSFORM,
  type SlidesElementContent,
  type SlidesFill,
  type SlidesOutline,
  type SlidesPage,
  type SlidesPageBackground,
  type SlidesPageElement,
  type SlidesPresentation,
  type SlidesShape,
  type SlidesSolidFill,
  type SlidesCellMargins,
  type SlidesTableBorder,
  type SlidesTableCell,
  type SlidesTransform,
} from "./slides-presentation.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

/** What fetching and storing one image address came to (import-assets.ts). */
export type ImportedImage = Readonly<{ kind: "stored"; asset: AssetRecord }> | Readonly<{ kind: "failed"; message: string }>;

export type ImportPlan = Readonly<{
  title: string;
  /** The page height in engine units; the engine page is always 1280 wide. */
  pageHeight: number;
  theme: ThemeSnapshot;
  layouts: readonly LayoutSnapshot[];
  slides: readonly SlideSnapshot[];
  /** Every asset an element or background of the plan references, once each. */
  assets: readonly AssetRecord[];
  losses: readonly InterchangeLoss[];
  /** Page elements read from the slides (groups count with their children). */
  elementCount: number;
}>;

/**
 * One shape's text insets in English Metric Units, as Google's own pptx export of the presentation
 * states them (`<a:bodyPr lIns tIns rIns bIns>`). `presentations.get` reports no inset at all, so
 * this is the only place the true value can come from. An edge left out was not stated for that
 * element (a placeholder's bare `<a:bodyPr/>`): it inherits from the placeholder parent.
 */
export type TextInsetsEnglishMetricUnits = Readonly<{ left?: number; top?: number; right?: number; bottom?: number }>;

export function planImport(
  options: Readonly<{
    presentation: SlidesPresentation;
    images: ReadonlyMap<string, ImportedImage>;
    idSeed: IdSeed;
    /** What the presentation's .pptx export adds (import-pptx-supplement.ts); null when it could not be read. */
    pptxSupplement: PptxSupplement | null;
    /**
     * Text insets by Slides object id (masters' and layouts' placeholders included). Absent: taken
     * from `pptxSupplement`; an edge no element of the chain states falls back to
     * TEXT_INSET_ENGLISH_METRIC_UNITS.
     */
    textInsets?: ReadonlyMap<string, TextInsetsEnglishMetricUnits>;
    /**
     * Rounded-corner adjustments by Slides object id (`presetGeometryOf`); presentations.get never
     * reports them. Absent: taken from `pptxSupplement`, and the preset defaults without one.
     */
    shapeAdjustments?: ShapeAdjustmentsByObjectId;
  }>,
): ImportPlan {
  const { presentation } = options;
  const collector = createLossCollector();
  const scale = pageScaleFor({ widthEnglishMetricUnits: presentation.pageSize.widthEnglishMetricUnits, heightEnglishMetricUnits: presentation.pageSize.heightEnglishMetricUnits });
  const master = presentation.masters[0];
  const colours: ColourContext = { scheme: master?.colourScheme ?? new Map() };
  const ids = createIdMinter({ seed: options.idSeed, presentation });
  const usedAssets = new Map<string, AssetRecord>();
  const slideIds = new Map<string, SlideId>(presentation.slides.map((slide) => [slide.objectId, ids.slide(slide.objectId)]));
  const slideOrder = presentation.slides.map((slide) => slideIds.get(slide.objectId)).filter((slideId): slideId is SlideId => slideId !== undefined);
  const listIds = new Map<string, ListId>();
  const placeholderParents = new Map<string, SlidesShape>();
  for (const page of [...presentation.masters, ...presentation.layouts]) {
    for (const element of page.elements) {
      const shape = shapeOf(element.content);
      if (shape !== null) placeholderParents.set(element.objectId, shape);
    }
  }
  const textContextFor = (currentSlideIndex: number | null, losses: InterchangeLossSink): TextContext => ({
    colours,
    unitsPerPoint: scale.unitsPerPoint,
    placeholderParents,
    slideIds,
    slideOrder,
    currentSlideIndex,
    listIdFor: (slidesListId) => {
      const known = listIds.get(slidesListId);
      if (known !== undefined) return known;
      const minted = ids.list();
      listIds.set(slidesListId, minted);
      return minted;
    },
    losses,
  });
  const textInsets = options.textInsets ?? supplementMap(options.pptxSupplement, (element) => element.textInsets);
  const shapeAdjustments = options.shapeAdjustments ?? supplementMap(options.pptxSupplement, (element) => element.shapeAdjustments);
  const customOutlines = supplementMap(options.pptxSupplement, (element) => element.customOutline);
  const elementContext = (pageIndex: number | null, losses: InterchangeLossSink, onLayout: boolean): ElementContext => ({
    scale,
    colours,
    ids,
    images: options.images,
    usedAssets,
    text: textContextFor(pageIndex, losses),
    placeholderParents,
    onLayout,
    pptxSupplement: options.pptxSupplement,
    textInsets,
    shapeAdjustments,
    customOutlines,
  });

  if (scale.pageHeight !== 720) {
    collector.sink.addOncePerDeck({
      feature: "pageSize",
      detail: `The presentation's page is ${Math.round(scale.pageHeight)} units tall for 1280 wide; the deck keeps 1280 by 720 until a page size command exists.`,
    });
  }
  if (presentation.masters.length > 1) {
    collector.sink.addOncePerDeck({ feature: "masters", detail: `Only the first of ${presentation.masters.length} masters became the theme; slides on the others keep their own look.` });
  }
  collector.sink.addOncePerDeck({ feature: "transition", detail: "Google Slides does not expose transitions or animations, so none were imported." });

  const theme = importTheme({ master, presentation, colours, scale, images: options.images, usedAssets, text: textContextFor(null, collector.sink), losses: collector.sink });
  const layoutIds = new Map<string, LayoutId>(presentation.layouts.map((layout) => [layout.objectId, ids.layout(layout.objectId)]));
  const layouts = presentation.layouts.map((layout): LayoutSnapshot => {
    const losses = collector.sink.at({ slideId: null });
    const context = elementContext(null, losses, true);
    return {
      // The map above holds every layout's id.
      id: layoutIds.get(layout.objectId) ?? ids.layout(""),
      name: layout.displayName || "Layout",
      background: backgroundFill({ background: layout.background, context }),
      elements: importElements({ elements: layout.elements, parentTransform: IDENTITY_TRANSFORM, groupId: null, context, losses }),
    };
  });
  const layoutsByObjectId = new Map(presentation.layouts.map((layout) => [layout.objectId, layout]));
  const mastersByObjectId = new Map(presentation.masters.map((page) => [page.objectId, page]));
  let elementCount = 0;
  const slides = presentation.slides.map((slide, index): SlideSnapshot => {
    // The map above holds every slide's id.
    const slideId = slideIds.get(slide.objectId) ?? ids.slide("");
    const losses = collector.sink.at({ slideId, elementId: null });
    const context = elementContext(index, losses, false);
    const layout = slide.layoutObjectId === null ? undefined : layoutsByObjectId.get(slide.layoutObjectId);
    const slideMaster = layout === undefined ? master : (mastersByObjectId.get(masterIdOfLayout({ layout, presentation })) ?? master);
    const decorations = [...(slideMaster?.elements ?? []), ...(layout?.elements ?? [])].filter(isDecoration);
    elementCount += countElements(slide.elements);
    return {
      id: slideId,
      layoutId: layout === undefined ? null : (layoutIds.get(layout.objectId) ?? null),
      background: slideBackground({ slide, layout, context }),
      skipped: slide.isSkipped,
      speakerNotes: importTextBody({ text: slide.speakerNotes, placeholderParentId: null, context: context.text }),
      transition: null,
      // The Slides programming interface exposes no animations; the deck-wide "transition" loss says so.
      animations: [],
      elements: [
        ...importElements({ elements: decorations, parentTransform: IDENTITY_TRANSFORM, groupId: null, context: { ...context, copying: true }, losses }),
        ...importElements({ elements: slide.elements, parentTransform: IDENTITY_TRANSFORM, groupId: null, context, losses }),
      ],
    };
  });
  return {
    title: presentation.title,
    pageHeight: scale.pageHeight,
    theme,
    layouts,
    slides,
    assets: [...usedAssets.values()],
    losses: collector.losses(),
    elementCount,
  };
}

/** Every image address the import will fetch: pictures, charts and picture backgrounds. */
export function imageAddressesIn(presentation: SlidesPresentation): readonly string[] {
  const addresses = new Set<string>();
  const visit = (elements: readonly SlidesPageElement[]): void => {
    for (const element of elements) {
      const content = element.content;
      switch (content.kind) {
        case "image":
        case "sheetsChart":
          if (content.contentUrl !== null) addresses.add(content.contentUrl);
          break;
        case "group":
          visit(content.children);
          break;
        case "shape":
        case "line":
        case "table":
        case "video":
        case "wordArt":
        case "speakerSpotlight":
        case "unknown":
          break;
        default:
          assertNever(content);
      }
    }
  };
  for (const page of [...presentation.masters, ...presentation.layouts, ...presentation.slides]) {
    const picture = backgroundPictureOf(page.background);
    if (picture !== null) addresses.add(picture);
    visit(page.elements);
  }
  return [...addresses];
}

/** The content's shape, or null for any other kind. */
export function shapeOf(content: SlidesElementContent): SlidesShape | null {
  switch (content.kind) {
    case "shape":
      return content;
    case "image":
    case "line":
    case "table":
    case "group":
    case "sheetsChart":
    case "video":
    case "wordArt":
    case "speakerSpotlight":
    case "unknown":
      return null;
    default:
      return assertNever(content);
  }
}


/** The engine preset for each Slides shape type the import table lists. */
export const PRESET_BY_SHAPE_TYPE: ReadonlyMap<string, ShapePreset> = new Map<string, ShapePreset>([
  ["TEXT_BOX", "textBox"],
  ["RECTANGLE", "rectangle"],
  ["ROUND_RECTANGLE", "roundedRectangle"],
  // The one- and two-corner presets are rounded rectangles with per-corner radii (import-shape-geometry.ts).
  ["ROUND_1_RECTANGLE", "roundedRectangle"],
  ["ROUND_2_SAME_RECTANGLE", "roundedRectangle"],
  ["ROUND_2_DIAGONAL_RECTANGLE", "roundedRectangle"],
  ["ELLIPSE", "ellipse"],
  ["TRIANGLE", "triangle"],
  ["RIGHT_TRIANGLE", "rightTriangle"],
  ["DIAMOND", "diamond"],
  ["PARALLELOGRAM", "parallelogram"],
  ["TRAPEZOID", "trapezoid"],
  ["PENTAGON", "pentagon"],
  ["HEXAGON", "hexagon"],
  ["OCTAGON", "octagon"],
  ["STAR_5", "fivePointStar"],
  ["PLUS", "plus"],
  ["HEART", "heart"],
  ["CLOUD", "cloud"],
  ["WEDGE_RECTANGLE_CALLOUT", "speechBubble"],
  ["WEDGE_ROUND_RECTANGLE_CALLOUT", "speechBubble"],
  ["CHEVRON", "chevron"],
  ["RIGHT_ARROW", "rightArrow"],
  ["LEFT_ARROW", "leftArrow"],
  ["UP_ARROW", "upArrow"],
  ["DOWN_ARROW", "downArrow"],
]);

export const PLACEHOLDER_ROLE_BY_TYPE: ReadonlyMap<string, PlaceholderRole> = new Map<string, PlaceholderRole>([
  ["TITLE", "title"],
  ["CENTERED_TITLE", "centredTitle"],
  ["SUBTITLE", "subtitle"],
  ["BODY", "body"],
  ["SLIDE_NUMBER", "slideNumber"],
  ["FOOTER", "footer"],
  ["DATE_AND_TIME", "date"],
  ["PICTURE", "picture"],
]);

/** Slides arrow styles to the nearest of the engine's seven heads, and whether the match is exact. */
export const ARROW_BY_SLIDES_STYLE: ReadonlyMap<string, Readonly<{ arrow: ArrowHead; exact: boolean }>> = new Map([
  ["NONE", { arrow: "none", exact: true }],
  ["FILL_ARROW", { arrow: "triangle", exact: true }],
  ["OPEN_ARROW", { arrow: "openArrow", exact: true }],
  ["STEALTH_ARROW", { arrow: "stealth", exact: true }],
  ["FILL_DIAMOND", { arrow: "diamond", exact: true }],
  ["FILL_CIRCLE", { arrow: "oval", exact: true }],
  ["FILL_SQUARE", { arrow: "bar", exact: false }],
  ["OPEN_DIAMOND", { arrow: "diamond", exact: false }],
  ["OPEN_CIRCLE", { arrow: "oval", exact: false }],
  ["OPEN_SQUARE", { arrow: "bar", exact: false }],
]);

export const DASH_BY_SLIDES_STYLE: ReadonlyMap<string, DashStyle> = new Map<string, DashStyle>([
  ["SOLID", "solid"],
  ["DOT", "dot"],
  ["DASH", "dash"],
  ["DASH_DOT", "dashDot"],
  ["LONG_DASH", "longDash"],
  ["LONG_DASH_DOT", "longDashDot"],
]);

const ROUTING_BY_CATEGORY: ReadonlyMap<string, LineRouting> = new Map<string, LineRouting>([
  ["STRAIGHT", "straight"],
  ["BENT", "elbow"],
  ["CURVED", "curved"],
]);

/**
 * Slides' default text inset, 9 pixels of a 1280 page on every side (converter/geometry.ts, measured
 * on boxes the Slides API created). Only the FALLBACK: the inset a shape actually has comes from the
 * pptx export when the caller passes it (`textInsets`; see textInsetsOf).
 */
const TEXT_INSET_ENGLISH_METRIC_UNITS = 85_725;
/**
 * The inset Google's pptx export states for that same default: 0.1 inch (91440) on the 25 EMU grid
 * Google stores insets on (an uploaded 21431 / 34290 / 91440 comes back as 21425 / 34275 / 91425).
 * Every box the Slides API creates exports it, and Slides draws its LEFT and RIGHT edges 85725 from
 * the frame, not 91425: read literally it narrowed each such column by 1.6 units of a 1280 page,
 * and text the forward converter fitted to its box (box = text + 2 x 85725) wrapped in Sasha and
 * not in Google ("Q3 revenue, bold light" on the test deck's slide 9). Measured on the test deck's
 * ink, Sasha minus Google, three boxes: left edge +0.57 / +0.85 / +0.66 units with 91425, -0.23 /
 * +0.05 / -0.14 with 85725. TOP and BOTTOM keep the stated value: the engine's vertical line model
 * (text-vertical-metrics.ts) was measured against Google's thumbnails of boxes imported with it,
 * and 85725 there lifted the same three boxes' ink from -0.21 / -0.53 / -0.42 to -1.81 / -1.33 / -1.22.
 */
const EXPORTED_DEFAULT_TEXT_INSET_ENGLISH_METRIC_UNITS = 91_425;
/** A shape is never thinner than this (geometry.ts MINIMUM_FRAME_SIZE); a line may be. */
const MINIMUM_FRAME_SIZE = 1;

function backgroundPictureOf(background: SlidesPageBackground): string | null {
  switch (background.kind) {
    case "picture":
      return background.contentUrl;
    case "inherit":
    case "none":
    case "solid":
      return null;
    default:
      return assertNever(background);
  }
}

type IdMinter = Readonly<{
  slide: (candidate: string) => SlideId;
  layout: (candidate: string) => LayoutId;
  element: (candidate: string) => ElementId;
  row: () => TableRowId;
  column: () => TableColumnId;
  list: () => ListId;
}>;

type ElementContext = Readonly<{
  scale: PageScale;
  colours: ColourContext;
  ids: IdMinter;
  images: ReadonlyMap<string, ImportedImage>;
  usedAssets: Map<string, AssetRecord>;
  text: TextContext;
  placeholderParents: ReadonlyMap<string, SlidesShape>;
  /** Layout elements keep their placeholder text empty (it is the layout's prompt, not content). */
  onLayout: boolean;
  /** Copies of master and layout decorations onto a slide: every id is minted fresh. */
  copying?: boolean;
  /** Values only the .pptx export carries (gradient stops), by Slides object id; null without an export. */
  pptxSupplement: PptxSupplement | null;
  /** Text insets the pptx export states, by Slides object id (planImport's `textInsets`). */
  textInsets: ReadonlyMap<string, TextInsetsEnglishMetricUnits>;
  /** Rounded-corner adjustments by Slides object id (planImport's `shapeAdjustments`). */
  shapeAdjustments: ShapeAdjustmentsByObjectId;
  /** Custom shapes' outlines the pptx export carries, by Slides object id; empty without an export. */
  customOutlines: ReadonlyMap<string, CustomOutline>;
}>;

/** One field of every element the pptx export supplements, by Slides object id; empty without an export. */
function supplementMap<Value>(
  supplement: PptxSupplement | null,
  pick: (element: PptxElementSupplement) => Value | null,
): ReadonlyMap<string, Value> {
  const values = new Map<string, Value>();
  if (supplement === null) return values;
  for (const [objectId, element] of supplement.elements) {
    const value = pick(element);
    if (value !== null) values.set(objectId, value);
  }
  return values;
}

/**
 * Keeps a Slides id when it is a valid, unused object id and mints one otherwise (see the header).
 * The minter is the one stateful thing in the import; it lives for one `planImport` call.
 */
function createIdMinter(options: Readonly<{ seed: IdSeed; presentation: SlidesPresentation }>): IdMinter {
  let seed = options.seed;
  const used = new Set<string>();
  const mint = <TKind extends "slide" | "layout" | "element" | "tableRow" | "tableColumn" | "list">(kind: TKind): MintedIdByKind[TKind] => {
    const minted = mintId({ seed, kind });
    seed = minted.seed;
    used.add(minted.id);
    return minted.id;
  };
  const keepOrMint = <TKind extends "slide" | "layout" | "element">(candidate: string, kind: TKind): MintedIdByKind[TKind] => {
    if (isObjectId(candidate) && !used.has(candidate)) {
      used.add(candidate);
      // `isObjectId` just held: the brand records the OBJECT_ID_PATTERN check (ids.ts).
      return candidate as MintedIdByKind[TKind];
    }
    return mint(kind);
  };
  return {
    slide: (candidate) => keepOrMint(candidate, "slide"),
    layout: (candidate) => keepOrMint(candidate, "layout"),
    element: (candidate) => keepOrMint(candidate, "element"),
    row: () => mint("tableRow"),
    column: () => mint("tableColumn"),
    list: () => mint("list"),
  };
}

function importTheme(
  options: Readonly<{
    master: SlidesPage | undefined;
    presentation: SlidesPresentation;
    colours: ColourContext;
    scale: PageScale;
    images: ReadonlyMap<string, ImportedImage>;
    usedAssets: Map<string, AssetRecord>;
    text: TextContext;
    losses: InterchangeLossSink;
  }>,
): ThemeSnapshot {
  const { master, presentation, colours } = options;
  const slotColours = { ...FALLBACK_SLOT_COLOURS };
  for (const [type, slot] of THEME_SLOT_BY_SLIDES_TYPE) {
    const hexadecimal = colours.scheme.get(type);
    if (hexadecimal !== undefined) slotColours[slot] = hexadecimal;
  }
  const placeholderOf = (type: string): SlidesShape | null => {
    for (const page of [...(master === undefined ? [] : [master]), ...presentation.layouts]) {
      for (const element of page.elements) {
        const shape = shapeOf(element.content);
        if (shape !== null && shape.placeholder?.type === type) return shape;
      }
    }
    return null;
  };
  const styleOf = (type: string): PlaceholderStyle => {
    const shape = placeholderOf(type);
    if (shape === null) return { run: {}, paragraph: {}, textBox: {} };
    const resolved = resolvedPlaceholderStyle({ shape, context: options.text });
    const textBox: Partial<TextBoxStyle> = {
      verticalAlignment: verticalAlignmentOf(shape.contentAlignment ?? "TOP"),
      autofit: autofitOf({ autofitType: shape.autofitType, shapeType: shape.shapeType }),
    };
    return { run: resolved.run, paragraph: { ...resolved.paragraph, list: { kind: "none" } }, textBox };
  };
  const headingFamily = styleOf("TITLE").run.fontFamily ?? "Arial";
  const bodyFamily = styleOf("BODY").run.fontFamily ?? "Arial";
  const backgroundContext: ElementContext = {
    scale: options.scale,
    colours,
    ids: createIdMinter({ seed: { sessionPrefix: "theme000", counter: 0 }, presentation }),
    images: options.images,
    usedAssets: options.usedAssets,
    text: options.text,
    placeholderParents: new Map(),
    onLayout: true,
    // A page background never reads the export: only shape fills arrive as an undescribed `{}`.
    pptxSupplement: null,
    textInsets: new Map(),
    shapeAdjustments: new Map(),
    customOutlines: new Map(),
  };
  const background = master === undefined ? null : backgroundFill({ background: master.background, context: backgroundContext });
  return {
    name: master?.displayName || "Imported theme",
    colours: slotColours,
    headingFontFamily: headingFamily,
    bodyFontFamily: bodyFamily,
    background: background ?? { kind: "solid", colour: { kind: "theme", slot: "light1", alpha: 1 } },
    placeholderStyles: {
      title: styleOf("TITLE"),
      centredTitle: styleOf("CENTERED_TITLE"),
      subtitle: styleOf("SUBTITLE"),
      body: styleOf("BODY"),
      slideNumber: styleOf("SLIDE_NUMBER"),
      footer: styleOf("FOOTER"),
      date: styleOf("DATE_AND_TIME"),
      picture: styleOf("PICTURE"),
    },
    // What a Slides text box shows with nothing set: Arial 14 point in the theme's dark ink.
    defaultRunStyle: {
      fontFamily: "Arial",
      fontSize: roundUnits(14 * options.scale.unitsPerPoint),
      fontWeight: 400,
      fontStyle: "normal",
      underline: false,
      strikethrough: false,
      colour: { kind: "theme", slot: "dark1", alpha: 1 },
      highlight: { kind: "none" },
      link: { kind: "none" },
      baselineOffset: "none",
      letterSpacing: 0,
      textCase: "none",
    },
  };
}

function masterIdOfLayout(options: Readonly<{ layout: SlidesPage; presentation: SlidesPresentation }>): string {
  // A layout's master is not in the parsed page (layoutProperties.masterObjectId is not needed
  // elsewhere); its placeholders name their master parents, which is the same answer.
  for (const element of options.layout.elements) {
    const parentId = shapeOf(element.content)?.placeholder?.parentObjectId;
    if (parentId === undefined || parentId === null) continue;
    const master = options.presentation.masters.find((page) => page.elements.some((candidate) => candidate.objectId === parentId));
    if (master !== undefined) return master.objectId;
  }
  return options.presentation.masters[0]?.objectId ?? "";
}

function isDecoration(element: SlidesPageElement): boolean {
  switch (element.content.kind) {
    case "shape":
      return element.content.placeholder === null;
    case "image":
      return element.content.placeholder === null;
    case "line":
    case "table":
    case "group":
    case "sheetsChart":
    case "video":
    case "wordArt":
      return true;
    case "speakerSpotlight":
    case "unknown":
      return false;
    default:
      return assertNever(element.content);
  }
}

function countElements(elements: readonly SlidesPageElement[]): number {
  return elements.reduce((total, element) => total + 1 + countElements(childrenOf(element.content)), 0);
}

function childrenOf(content: SlidesElementContent): readonly SlidesPageElement[] {
  switch (content.kind) {
    case "group":
      return content.children;
    case "shape":
    case "image":
    case "line":
    case "table":
    case "sheetsChart":
    case "video":
    case "wordArt":
    case "speakerSpotlight":
    case "unknown":
      return [];
    default:
      return assertNever(content);
  }
}

function slideBackground(options: Readonly<{ slide: SlidesPage; layout: SlidesPage | undefined; context: ElementContext }>): Fill | null {
  const own = backgroundFill({ background: options.slide.background, context: options.context });
  if (own !== null) return own;
  return options.layout === undefined ? null : backgroundFill({ background: options.layout.background, context: options.context });
}

/** A page background as an engine fill; null when it inherits. */
function backgroundFill(options: Readonly<{ background: SlidesPageBackground; context: ElementContext }>): Fill | null {
  const { background, context } = options;
  switch (background.kind) {
    case "inherit":
      return null;
    case "none":
      return { kind: "none" };
    case "solid":
      return { kind: "solid", colour: colourOfFill({ fill: background.fill, context }) };
    case "picture": {
      const image = context.images.get(background.contentUrl);
      if (image?.kind !== "stored") {
        context.text.losses.add({ feature: "image", detail: "The background picture could not be fetched; the slide shows the theme background." });
        return null;
      }
      context.usedAssets.set(image.asset.id, image.asset);
      return { kind: "image", assetId: image.asset.id, fit: "stretch", opacity: 1 };
    }
    default:
      return assertNever(background);
  }
}

function importElements(
  options: Readonly<{
    elements: readonly SlidesPageElement[];
    parentTransform: SlidesTransform;
    groupId: ElementId | null;
    context: ElementContext;
    losses: InterchangeLossSink;
  }>,
): readonly ElementSnapshot[] {
  const imported: ElementSnapshot[] = [];
  for (const element of options.elements) {
    const converted = importElement({ ...options, element });
    imported.push(...converted);
  }
  return imported;
}

/** One Slides element: usually one engine element, none for an omitted kind, several for a flattened group. */
function importElement(
  options: Readonly<{ element: SlidesPageElement; parentTransform: SlidesTransform; groupId: ElementId | null; context: ElementContext; losses: InterchangeLossSink }>,
): readonly ElementSnapshot[] {
  const { element, context } = options;
  const id = context.copying === true ? context.ids.element("") : context.ids.element(element.objectId);
  const losses = options.losses.at({ elementId: id });
  const transform = composeTransforms({ parent: options.parentTransform, child: element.transform });
  const frame = frameForTransform({
    transform,
    widthEnglishMetricUnits: element.widthEnglishMetricUnits,
    heightEnglishMetricUnits: element.heightEnglishMetricUnits,
    scale: context.scale,
    minimumSize: MINIMUM_FRAME_SIZE,
  });
  const common = {
    id,
    name: element.title,
    description: element.description,
    frame,
    groupId: options.groupId,
    morphKey: id,
    placeholder: null,
    unsupportedKeys: [],
  } as const;
  const content: SlidesElementContent = element.content;
  switch (content.kind) {
    case "shape":
      return [importShape({ shape: content, objectId: element.objectId, common, context, losses })];
    case "image": {
      const placeholder = placeholderReferenceOf({ placeholder: content.placeholder, losses });
      return [
        importPicture({
          contentUrl: content.contentUrl,
          common: { ...common, placeholder },
          context,
          losses,
          crop: content.crop,
          opacity: 1 - content.transparency,
          border: borderOf({ outline: content.outline, context }),
          missingDetail: "The image could not be fetched from Google; a placeholder stands in its place.",
        }),
      ];
    }
    case "sheetsChart":
      losses.add({ feature: "linkedChart", detail: "The linked Sheets chart was imported as a picture of it; it no longer updates from the spreadsheet." });
      return [
        importPicture({
          contentUrl: content.contentUrl,
          common,
          context,
          losses,
          crop: { left: 0, right: 0, top: 0, bottom: 0 },
          opacity: 1,
          border: { kind: "none" },
          missingDetail: "The chart's picture could not be fetched from Google; a placeholder stands in its place.",
        }),
      ];
    case "line":
      return [importLine({ line: content, element, transform, common, context, losses })];
    case "table":
      return [importTable({ table: content, objectId: element.objectId, common, context, losses })];
    case "group":
      return importGroup({ group: content, transform, common, context, losses });
    case "video":
      losses.add({ feature: "video", detail: `The video ${content.address} became a rectangle named after it; video is not supported yet.` });
      return [stubShape({ common: { ...common, name: `Video: ${content.address}` }, text: EMPTY_BODY, fill: { kind: "solid", colour: { kind: "theme", slot: "dark1", alpha: 1 } } })];
    case "wordArt":
      losses.add({ feature: "wordArt", detail: "The word art became a text box holding its text." });
      return [
        {
          ...stubShape({ common, text: { paragraphs: [{ style: {}, runs: [{ kind: "text", text: content.renderedText, style: {} }] }] }, fill: { kind: "none" } }),
          preset: "textBox",
        },
      ];
    case "speakerSpotlight":
      losses.add({ feature: "speakerSpotlight", detail: "The speaker spotlight was left out." });
      return [];
    case "unknown":
      losses.add({ feature: "element", detail: `An element the importer does not know (${content.description}) was left out.` });
      return [];
    default:
      return assertNever(content);
  }
}

type Common = Readonly<{
  id: ElementId;
  name: string;
  description: string;
  frame: Frame;
  groupId: ElementId | null;
  morphKey: string;
  placeholder: PlaceholderReference | null;
  unsupportedKeys: readonly string[];
}>;

function importShape(options: Readonly<{ shape: SlidesShape; objectId: string; common: Common; context: ElementContext; losses: InterchangeLossSink }>): ShapeElement {
  const { shape, common, context, losses } = options;
  const adjustments: ShapeAdjustments | null = context.shapeAdjustments.get(options.objectId) ?? null;
  const rounded = roundedShapeOf({ shapeType: shape.shapeType, width: common.frame.width, height: common.frame.height, adjustments });
  // A custom shape is drawn by its export outline; its preset stays the rectangle older clients and the Slides export fall back to.
  const customOutline = shape.shapeType === CUSTOM_SHAPE_TYPE ? (context.customOutlines.get(options.objectId) ?? null) : null;
  const preset = rounded?.preset ?? (customOutline === null ? presetOf({ shapeType: shape.shapeType, losses }) : "rectangle");
  const chain = shapeChain({ shape, context });
  const fill = shapeFillOf({ chain, objectIds: shapeChainObjectIds({ shape, objectId: options.objectId, length: chain.length, context }), context, losses });
  const border = borderOf({ outline: firstDecidedOutline(chain.map((link) => link.outline)), context });
  const shadow = shadowOf({ shape: chain.find((link) => link.shadow !== null && link.shadow.state !== "inherit") ?? shape, context, losses });
  const contentAlignment = chain.map((link) => link.contentAlignment).find((value) => value !== null) ?? "TOP";
  const autofitType = chain.map((link) => link.autofitType).find((value) => value !== null) ?? null;
  const placeholder = placeholderReferenceOf({ placeholder: shape.placeholder, losses });
  const verticalAlignment = verticalAlignmentOf(contentAlignment);
  const inset = textInsetsOf({ objectId: options.objectId, shape, context });
  const vertical = insetsForUploadedText({ verticalAlignment, top: inset.top, bottom: inset.bottom, trailingSpacing: uploadedTrailingSpacingPoints(shape.text) * context.scale.unitsPerPoint });
  const text: TextBody =
    context.onLayout && shape.placeholder !== null
      ? EMPTY_BODY
      : importTextBody({ text: shape.text, placeholderParentId: shape.placeholder?.parentObjectId ?? null, context: { ...context.text, losses } });
  return {
    ...common,
    placeholder,
    kind: "shape",
    preset,
    customOutline,
    box: {
      fill,
      border,
      cornerRadius: rounded?.cornerRadius ?? { kind: "uniform", radius: 0 },
      shadow,
      opacity: 1,
    },
    textBox: {
      verticalAlignment,
      paddingTop: vertical.top,
      paddingRight: inset.right,
      paddingBottom: vertical.bottom,
      paddingLeft: inset.left,
      autofit: autofitOf({ autofitType, shapeType: shape.shapeType }),
      wrap: true,
    },
    text,
  };
}

/** The engine preset of a Slides shape type; a rectangle and a reported loss when the engine has none. */
function presetOf(options: Readonly<{ shapeType: string; losses: InterchangeLossSink }>): ShapePreset {
  const known = PRESET_BY_SHAPE_TYPE.get(options.shapeType);
  if (known !== undefined) return known;
  if (options.shapeType === CUSTOM_SHAPE_TYPE) {
    options.losses.add({ feature: "customShape", detail: "The custom outline (a freeform, or a PowerPoint custom shape) became a rectangle: the .pptx export that carries its path was not read, or the path uses values this importer cannot read." });
  } else {
    options.losses.add({ feature: "shapePreset", detail: `The ${options.shapeType} shape became a rectangle; the engine has no such preset yet.` });
  }
  return "rectangle";
}

type TextInsetUnits = Readonly<{ left: number; top: number; right: number; bottom: number }>;

/**
 * A shape's four text insets in engine units. Each edge is the first one the pptx export states
 * along the placeholder chain (the shape, its layout placeholder, the master's), exactly how
 * PowerPoint and Slides resolve a bare `<a:bodyPr/>`; an edge nobody states is Slides' measured
 * default. Why not the default everywhere: a box uploaded from a pptx keeps that file's insets (the
 * html2slides converter writes 0 on 1051 of its 1052 text shapes), and the 9-unit default inset of
 * a 1280 page then pushed text right and down and wrapped narrow boxes mid-word ("41%" -> "41/%").
 * A left or right edge stating Google's exported default is drawn where Slides actually draws it.
 */
function textInsetsOf(options: Readonly<{ objectId: string; shape: SlidesShape; context: ElementContext }>): TextInsetUnits {
  const { context } = options;
  const chain: TextInsetsEnglishMetricUnits[] = [];
  const own = context.textInsets.get(options.objectId);
  if (own !== undefined) chain.push(own);
  const visited = new Set<string>();
  let parentId = options.shape.placeholder?.parentObjectId ?? null;
  while (parentId !== null && !visited.has(parentId)) {
    visited.add(parentId);
    const stated = context.textInsets.get(parentId);
    if (stated !== undefined) chain.push(stated);
    parentId = context.placeholderParents.get(parentId)?.placeholder?.parentObjectId ?? null;
  }
  const edge = (options: Readonly<{ pick: (insets: TextInsetsEnglishMetricUnits) => number | undefined; horizontal: boolean }>): number => {
    const stated = chain.map(options.pick).find((value) => value !== undefined && Number.isFinite(value) && value >= 0);
    const exportedDefault = options.horizontal && stated === EXPORTED_DEFAULT_TEXT_INSET_ENGLISH_METRIC_UNITS;
    const drawn = stated === undefined || exportedDefault ? TEXT_INSET_ENGLISH_METRIC_UNITS : stated;
    return roundUnits(drawn * context.scale.unitsPerEnglishMetricUnit);
  };
  return {
    left: edge({ pick: (insets) => insets.left, horizontal: true }),
    top: edge({ pick: (insets) => insets.top, horizontal: false }),
    right: edge({ pick: (insets) => insets.right, horizontal: true }),
    bottom: edge({ pick: (insets) => insets.bottom, horizontal: false }),
  };
}

/** The shape, then its layout placeholder, then the master's: where an INHERIT property comes from. */
function shapeChain(options: Readonly<{ shape: SlidesShape; context: ElementContext }>): readonly SlidesShape[] {
  const chain: SlidesShape[] = [options.shape];
  const visited = new Set<string>();
  let parentId = options.shape.placeholder?.parentObjectId ?? null;
  while (parentId !== null && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = options.context.placeholderParents.get(parentId);
    if (parent === undefined) break;
    chain.push(parent);
    parentId = parent.placeholder?.parentObjectId ?? null;
  }
  return chain;
}

/** The Slides object id of each link of `shapeChain`'s chain, in the same order (the same walk). */
function shapeChainObjectIds(options: Readonly<{ shape: SlidesShape; objectId: string; length: number; context: ElementContext }>): readonly string[] {
  const objectIds: string[] = [options.objectId];
  let parentId = options.shape.placeholder?.parentObjectId ?? null;
  while (parentId !== null && objectIds.length < options.length) {
    objectIds.push(parentId);
    parentId = options.context.placeholderParents.get(parentId)?.placeholder?.parentObjectId ?? null;
  }
  return objectIds;
}

/**
 * A shape's fill from the first link of its chain that decides it. A RENDERED fill with no solid
 * colour is one the Slides interface does not describe (a gradient arrives as `{}`): its stops come
 * from the .pptx export when that link was matched there, and otherwise the shape is drawn without
 * a fill and the loss is reported, never silently.
 */
function shapeFillOf(
  options: Readonly<{ chain: readonly SlidesShape[]; objectIds: readonly string[]; context: ElementContext; losses: InterchangeLossSink }>,
): Fill {
  const { context } = options;
  const decidingIndex = options.chain.findIndex((link) => link.fill.state !== "inherit");
  const deciding = options.chain[decidingIndex];
  if (deciding === undefined) return { kind: "none" };
  if (deciding.fill.state !== "rendered" || deciding.fill.solid !== null) return fillOf({ fill: deciding.fill, context });
  const objectId = options.objectIds[decidingIndex];
  const gradient = objectId === undefined ? null : (context.pptxSupplement?.elements.get(objectId)?.gradient ?? null);
  if (gradient !== null) return gradientFillOf({ gradient, context });
  options.losses.add({ feature: "gradientFill", detail: unreadableGradientDetail({ supplement: context.pptxSupplement, objectId }) });
  return { kind: "none" };
}

function unreadableGradientDetail(options: Readonly<{ supplement: PptxSupplement | null; objectId: string | undefined }>): string {
  const lead = "The shape's fill is a gradient, which the Slides interface does not describe";
  if (options.supplement === null) return `${lead}, and the presentation's .pptx export could not be read; the shape was imported with no fill.`;
  if (options.objectId !== undefined && options.supplement.elements.has(options.objectId)) {
    return `${lead}, and its .pptx export describes that fill in a form this importer does not read; the shape was imported with no fill.`;
  }
  return `${lead}, and the shape could not be matched to the presentation's .pptx export; it was imported with no fill.`;
}

/** Office's gradient angle (0 runs left to right, clockwise) is the stylesheet's (0 runs upwards) minus 90. */
const STYLESHEET_ANGLE_OFFSET_DEGREES = 90;

function gradientFillOf(options: Readonly<{ gradient: PptxGradient; context: ElementContext }>): Fill {
  const { gradient, context } = options;
  const stops = gradient.stops.map((stop) => ({ offset: stop.offset, colour: colourOfFill({ fill: stop.fill, context }) }));
  switch (gradient.kind) {
    case "linear":
      return { kind: "linearGradient", angle: roundUnits((((gradient.angleDegrees + STYLESHEET_ANGLE_OFFSET_DEGREES) % 360) + 360) % 360), stops };
    case "radial":
      return { kind: "radialGradient", centreX: gradient.centreX, centreY: gradient.centreY, stops };
    default:
      return assertNever(gradient);
  }
}

function firstDecidedOutline(outlines: readonly SlidesOutline[]): SlidesOutline {
  return outlines.find((outline) => outline.state !== "inherit") ?? { state: "notRendered", solid: null, weightEnglishMetricUnits: null, dashStyle: null };
}

function fillOf(options: Readonly<{ fill: SlidesFill; context: ElementContext }>): Fill {
  const { fill } = options;
  if (fill.state !== "rendered" || fill.solid === null) return { kind: "none" };
  return { kind: "solid", colour: colourOfFill({ fill: fill.solid, context: options.context }) };
}

function borderOf(options: Readonly<{ outline: SlidesOutline; context: ElementContext }>): Border {
  const { outline, context } = options;
  if (outline.state === "notRendered") return { kind: "none" };
  const weight = outline.weightEnglishMetricUnits ?? 9525;
  if (outline.state === "inherit" && outline.solid === null) return { kind: "none" };
  return {
    kind: "uniform",
    stroke: {
      width: roundUnits(weight * context.scale.unitsPerEnglishMetricUnit),
      colour: outline.solid === null ? { kind: "theme", slot: "dark2", alpha: 1 } : colourOfFill({ fill: outline.solid, context }),
      dash: DASH_BY_SLIDES_STYLE.get(outline.dashStyle ?? "SOLID") ?? "solid",
    },
  };
}

/**
 * A rendered Slides shadow as an engine drop shadow. Slides anchors the shadow's own transform at
 * `alignment`; only the bottom-right family is the same "offset from the shape" the engine models
 * exactly, so any other anchor is approximated and reported (SPEC.md 21.12).
 */
function shadowOf(options: Readonly<{ shape: SlidesShape; context: ElementContext; losses: InterchangeLossSink }>): Shadow | null {
  const shadow = options.shape.shadow;
  if (shadow === null || shadow.state !== "rendered" || shadow.solid === null) return null;
  const scale = options.context.scale.unitsPerEnglishMetricUnit;
  if (!BOTTOM_RIGHT_LIKE_ALIGNMENTS.has(shadow.alignment)) {
    options.losses.add({ feature: "shadow", detail: `The shadow anchored at ${shadow.alignment} is drawn as a plain offset shadow.` });
  }
  return {
    offsetX: roundUnits(shadow.offsetXEnglishMetricUnits * scale),
    offsetY: roundUnits(shadow.offsetYEnglishMetricUnits * scale),
    blur: roundUnits(shadow.blurEnglishMetricUnits * scale),
    spread: 0,
    colour: colourOfFill({ fill: shadow.solid, context: options.context }),
  };
}

const BOTTOM_RIGHT_LIKE_ALIGNMENTS: ReadonlySet<string> = new Set(["BOTTOM_RIGHT", "BOTTOM_CENTER", "RIGHT_CENTER", "CENTER"]);

function colourOfFill(options: Readonly<{ fill: SlidesSolidFill; context: ElementContext }>): Colour {
  return colourOf({ colour: options.fill.colour, alpha: options.fill.alpha, context: options.context.colours });
}

function verticalAlignmentOf(contentAlignment: string): VerticalAlignment {
  if (contentAlignment === "MIDDLE") return "middle";
  if (contentAlignment === "BOTTOM") return "bottom";
  return "top";
}

/** SPEC.md section 15: a text box keeps growing with its text, as it does in Slides. */
function autofitOf(options: Readonly<{ autofitType: string | null; shapeType: string }>): TextAutofit {
  switch (options.autofitType) {
    case "SHAPE_AUTOFIT":
      return "resizeShape";
    case "TEXT_AUTOFIT":
      return "shrinkText";
    case "NONE":
      return "none";
    default:
      return options.shapeType === "TEXT_BOX" ? "resizeShape" : "none";
  }
}

function placeholderReferenceOf(options: Readonly<{ placeholder: SlidesShape["placeholder"]; losses: InterchangeLossSink }>): PlaceholderReference | null {
  const { placeholder } = options;
  if (placeholder === null) return null;
  const role = PLACEHOLDER_ROLE_BY_TYPE.get(placeholder.type);
  if (role === undefined) options.losses.add({ feature: "placeholderType", detail: `The ${placeholder.type} placeholder became a body placeholder.` });
  return { role: role ?? "body", index: placeholder.index };
}

function importPicture(
  options: Readonly<{
    contentUrl: string | null;
    common: Common;
    context: ElementContext;
    losses: InterchangeLossSink;
    crop: Readonly<{ left: number; right: number; top: number; bottom: number }>;
    opacity: number;
    border: Border;
    missingDetail: string;
  }>,
): ElementSnapshot {
  const { context, losses } = options;
  const image = options.contentUrl === null ? undefined : context.images.get(options.contentUrl);
  if (image?.kind !== "stored") {
    losses.add({ feature: "image", detail: options.missingDetail });
    return stubShape({
      common: { ...options.common, name: "Image could not be imported" },
      text: EMPTY_BODY,
      fill: { kind: "solid", colour: { kind: "theme", slot: "light2", alpha: 1 } },
      border: { kind: "uniform", stroke: { width: 2, colour: { kind: "theme", slot: "dark2", alpha: 1 }, dash: "dash" } },
    });
  }
  context.usedAssets.set(image.asset.id, image.asset);
  return {
    ...options.common,
    kind: "image",
    assetId: image.asset.id,
    crop: {
      left: clampFraction(options.crop.left),
      top: clampFraction(options.crop.top),
      right: clampFraction(options.crop.right),
      bottom: clampFraction(options.crop.bottom),
    },
    box: { fill: { kind: "none" }, border: options.border, cornerRadius: { kind: "uniform", radius: 0 }, shadow: null, opacity: clampFraction(options.opacity) },
  };
}

function stubShape(options: Readonly<{ common: Common; text: TextBody; fill: Fill; border?: Border }>): ShapeElement {
  return {
    ...options.common,
    kind: "shape",
    preset: "rectangle",
    customOutline: null,
    box: { fill: options.fill, border: options.border ?? { kind: "none" }, cornerRadius: { kind: "uniform", radius: 0 }, shadow: null, opacity: 1 },
    textBox: { verticalAlignment: "top", paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, autofit: "none", wrap: true },
    text: options.text,
  };
}

function importLine(
  options: Readonly<{
    line: Extract<SlidesElementContent, { kind: "line" }>;
    element: SlidesPageElement;
    transform: SlidesTransform;
    common: Common;
    context: ElementContext;
    losses: InterchangeLossSink;
  }>,
): ElementSnapshot {
  const { line, element, transform, context, losses } = options;
  // A Slides line runs from its box's top-left to its bottom-right; flips and rotation are in the
  // transform, so mapping the two corners gives the end points on the page.
  const start = transformPoint({ transform, point: { x: 0, y: 0 }, scale: context.scale });
  const end = transformPoint({ transform, point: { x: element.widthEnglishMetricUnits, y: element.heightEnglishMetricUnits }, scale: context.scale });
  if (line.connected) losses.add({ feature: "connection", detail: "The connector no longer follows the shapes it was attached to." });
  const arrowOf = (style: string): ArrowHead => {
    const mapped = ARROW_BY_SLIDES_STYLE.get(style) ?? { arrow: "triangle", exact: false };
    if (!mapped.exact) losses.add({ feature: "arrowHead", detail: `The ${style} arrowhead is drawn as the nearest one, ${mapped.arrow}.` });
    return mapped.arrow;
  };
  const stroke: Stroke = {
    width: roundUnits(line.weightEnglishMetricUnits * context.scale.unitsPerEnglishMetricUnit),
    colour: line.solid === null ? { kind: "theme", slot: "dark1", alpha: 1 } : colourOf({ colour: line.solid.colour, alpha: 1, context: context.colours }),
    dash: DASH_BY_SLIDES_STYLE.get(line.dashStyle) ?? "solid",
  };
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return {
    ...options.common,
    frame: { x: left, y: top, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y), rotation: 0, flipHorizontal: false, flipVertical: false },
    kind: "line",
    start: { x: roundUnits(start.x), y: roundUnits(start.y) },
    end: { x: roundUnits(end.x), y: roundUnits(end.y) },
    routing: ROUTING_BY_CATEGORY.get(line.lineCategory) ?? "straight",
    stroke,
    startArrow: arrowOf(line.startArrow),
    endArrow: arrowOf(line.endArrow),
    opacity: line.solid?.alpha ?? 1,
  };
}

/**
 * CELL MARGINS. `presentations.get` does not return a cell's margins, and a wrong guess is not
 * cosmetic: the engine's row is the text plus the margins, so a margin larger than Google's grows
 * every row past the height Google stored and pushes the whole table, and everything laid out
 * against its rows, downwards (measured on the reverse round trip: a fixed 12 unit margin grew a
 * 9 row table from 268 to 344 pixels; Google's real margins there were 6 by 20).
 *
 * So the margins come from, in order: the cell's own `marginsEnglishMetricUnits` when a reader of
 * the pptx export supplied them (exact); otherwise the left and right margins are the pptx default
 * (ECMA-376 `marL`/`marR`, 0.1 inch), and the top and bottom ones are INFERRED from the rows.
 * Google stores a row that fits its text as the text plus both margins, so each row bounds the
 * margin from above: (stored height - the text's line boxes) / 2. The text's height counted here
 * is one line per paragraph, a lower bound (a wrapped paragraph is taller), so every row's bound
 * is at least the real margin, and the table's SMALLEST bound is the closest. It is capped at the
 * ECMA-376 `marT`/`marB` default: a row someone dragged taller says nothing about its margins.
 */
const DEFAULT_HORIZONTAL_CELL_MARGIN_ENGLISH_METRIC_UNITS = 91_440;
const DEFAULT_VERTICAL_CELL_MARGIN_ENGLISH_METRIC_UNITS = 45_720;
/** The engine draws a line at font size x line spacing x 1.2 (render/inline-styles.ts); Google's line box is 1.197 (measured). */
const LINE_BOX_PER_LINE_SPACING = 1.2;

/** One cell's text height counting one line per paragraph, or null when a paragraph has no known font size. */
function minimumTextHeightOf(body: TextBody): number | null {
  let height = 0;
  for (const paragraph of body.paragraphs) {
    let fontSize = 0;
    for (const run of paragraph.runs) fontSize = Math.max(fontSize, run.style.fontSize ?? 0);
    if (fontSize <= 0) return null;
    const style = paragraph.style;
    height += (style.spaceAbove ?? 0) + (style.spaceBelow ?? 0) + fontSize * (style.lineSpacing ?? 1) * LINE_BOX_PER_LINE_SPACING;
  }
  return height;
}

/** The table's top and bottom margin in engine units, inferred from its stored row heights (see above). */
function inferredVerticalCellMargin(
  options: Readonly<{ rowHeights: readonly number[]; cells: readonly Readonly<{ source: SlidesTableCell; text: TextBody }>[]; unitsPerEnglishMetricUnit: number }>,
): number {
  const ceiling = DEFAULT_VERTICAL_CELL_MARGIN_ENGLISH_METRIC_UNITS * options.unitsPerEnglishMetricUnit;
  let margin = ceiling;
  for (const cell of options.cells) {
    if (cell.source.rowSpan !== 1) continue;
    const rowHeight = options.rowHeights[cell.source.rowIndex];
    const textHeight = minimumTextHeightOf(cell.text);
    if (rowHeight === undefined || textHeight === null) continue;
    margin = Math.min(margin, (rowHeight - textHeight) / 2);
  }
  return roundUnits(Math.max(0, margin));
}

function cellPaddingOf(
  options: Readonly<{ margins: SlidesCellMargins | null; inferredVertical: number; unitsPerEnglishMetricUnit: number }>,
): Pick<TextBoxStyle, "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft"> {
  const units = (englishMetricUnits: number): number => roundUnits(Math.max(0, englishMetricUnits) * options.unitsPerEnglishMetricUnit);
  if (options.margins !== null) {
    return { paddingTop: units(options.margins.top), paddingRight: units(options.margins.right), paddingBottom: units(options.margins.bottom), paddingLeft: units(options.margins.left) };
  }
  const horizontal = units(DEFAULT_HORIZONTAL_CELL_MARGIN_ENGLISH_METRIC_UNITS);
  return { paddingTop: options.inferredVertical, paddingRight: horizontal, paddingBottom: options.inferredVertical, paddingLeft: horizontal };
}

function importTable(
  options: Readonly<{ table: Extract<SlidesElementContent, { kind: "table" }>; objectId: string; common: Common; context: ElementContext; losses: InterchangeLossSink }>,
): TableElement {
  const { table, context, losses } = options;
  const unitsPerEnglishMetricUnit = context.scale.unitsPerEnglishMetricUnit;
  // The export lists one `<a:tc>` per grid position, merged ones included, so row-major order matches
  // the API's (rowIndex, columnIndex); a count that disagrees means the two do not describe one grid.
  const exportedMargins = context.pptxSupplement?.elements.get(options.objectId)?.cellMargins ?? [];
  const columnCount = table.columnWidthsEnglishMetricUnits.length;
  const exportMatchesGrid = exportedMargins.length === columnCount * table.rowHeightsEnglishMetricUnits.length;
  const marginsOf = (cell: SlidesTableCell): SlidesCellMargins | null =>
    cell.marginsEnglishMetricUnits ?? (exportMatchesGrid ? (exportedMargins[cell.rowIndex * columnCount + cell.columnIndex] ?? null) : null);
  const rows = table.rowHeightsEnglishMetricUnits.map((height) => ({ id: context.ids.row(), minimumHeight: Math.max(1, roundUnits(height * unitsPerEnglishMetricUnit)) }));
  const columns = table.columnWidthsEnglishMetricUnits.map((width) => ({ id: context.ids.column(), width: Math.max(1, roundUnits(width * unitsPerEnglishMetricUnit)) }));
  const covered = new Set<string>();
  for (const cell of table.cells) {
    for (let row = cell.rowIndex; row < cell.rowIndex + cell.rowSpan; row += 1) {
      for (let column = cell.columnIndex; column < cell.columnIndex + cell.columnSpan; column += 1) {
        if (row !== cell.rowIndex || column !== cell.columnIndex) covered.add(`${row}:${column}`);
      }
    }
  }
  // A border Google stores fully transparent draws nothing there, so the engine holds no line: a
  // transparent CSS border on a collapsed table still opens a gap between the cells' fills, which
  // shows whatever is behind the table as a faint grid (measured on the reverse round trip).
  const strokeOf = (border: SlidesTableBorder | null | undefined): Stroke | null => {
    if (border === null || border === undefined || border.solid === null || border.solid.alpha <= 0 || border.weightEnglishMetricUnits <= 0) return null;
    return {
      width: roundUnits(border.weightEnglishMetricUnits * unitsPerEnglishMetricUnit),
      colour: colourOfFill({ fill: border.solid, context }),
      dash: DASH_BY_SLIDES_STYLE.get(border.dashStyle) ?? "solid",
    };
  };
  const texts = table.cells
    .filter((cell) => !covered.has(`${cell.rowIndex}:${cell.columnIndex}`) && rows[cell.rowIndex] !== undefined && columns[cell.columnIndex] !== undefined)
    .map((cell) => ({ source: cell, text: importTextBody({ text: cell.text, placeholderParentId: null, context: { ...context.text, losses } }) }));
  const inferredVertical = inferredVerticalCellMargin({
    rowHeights: table.rowHeightsEnglishMetricUnits.map((height) => height * unitsPerEnglishMetricUnit),
    cells: texts,
    unitsPerEnglishMetricUnit,
  });
  const cells: TableCell[] = [];
  for (const { source: cell, text } of texts) {
    const row = rows[cell.rowIndex];
    const column = columns[cell.columnIndex];
    if (row === undefined || column === undefined) continue;
    // A merged cell's side is the line along its first row or column (Google keeps those).
    const borders: CellBorders = {
      top: strokeOf(table.horizontalBorders.get(`${cell.rowIndex}:${cell.columnIndex}`)),
      bottom: strokeOf(table.horizontalBorders.get(`${cell.rowIndex + cell.rowSpan}:${cell.columnIndex}`)),
      left: strokeOf(table.verticalBorders.get(`${cell.rowIndex}:${cell.columnIndex}`)),
      right: strokeOf(table.verticalBorders.get(`${cell.rowIndex}:${cell.columnIndex + cell.columnSpan}`)),
    };
    cells.push({
      rowId: row.id,
      columnId: column.id,
      rowSpan: cell.rowSpan,
      columnSpan: cell.columnSpan,
      fill: fillOf({ fill: cell.fill, context }),
      borders,
      textBox: {
        verticalAlignment: verticalAlignmentOf(cell.contentAlignment ?? "TOP"),
        ...cellPaddingOf({ margins: marginsOf(cell), inferredVertical, unitsPerEnglishMetricUnit }),
        autofit: "none",
        wrap: true,
      },
      text,
    });
  }
  // Google stores every table at a 3000000 x 3000000 placeholder size, in the API and the pptx export
  // alike, and draws the grid; the engine keeps a table's frame equal to its columns by its rows (a
  // column or row drag rewrites it to their sum), so the frame takes the grid's size. Its top left
  // corner stays where the placeholder put it: Slides tables are never rotated or scaled.
  const frame = { ...options.common.frame, width: sumOf(columns.map((column) => column.width)), height: sumOf(rows.map((row) => row.minimumHeight)) };
  return { ...options.common, frame, kind: "table", columns, rows, cells, opacity: 1 };
}

function sumOf(values: readonly number[]): number {
  return roundUnits(values.reduce((total, value) => total + value, 0));
}

/**
 * A group keeps its own rotation and holds its children at their ABSOLUTE frames (document.ts).
 * A group the engine could not hold (fewer than two children survived) is flattened.
 */
function importGroup(
  options: Readonly<{
    group: Extract<SlidesElementContent, { kind: "group" }>;
    transform: SlidesTransform;
    common: Common;
    context: ElementContext;
    losses: InterchangeLossSink;
  }>,
): readonly ElementSnapshot[] {
  const { common, context } = options;
  const children = importElements({ elements: options.group.children, parentTransform: options.transform, groupId: common.id, context, losses: options.losses });
  if (children.length < 2) return children.map((child) => ({ ...child, groupId: common.groupId }));
  const group: GroupElement = {
    ...common,
    frame: { ...common.frame, rotation: rotationOf(options.transform).rotation, flipHorizontal: false, flipVertical: false },
    kind: "group",
    children,
  };
  return [group];
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}


