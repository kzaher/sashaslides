/**
 * EXPORT: an engine document to `presentations.batchUpdate` requests, ONE BATCH PER SLIDE in slide
 * order, addressed by the engine's own ids (SPEC.md 21.12's export table).
 *
 * PURE: the plan is computed from the snapshot and two functions (where an exported picture can be
 * fetched, and whether the target already holds a page with a slide's id); running it is
 * export-run.ts's (server) or Code.gs's (add-on). A batch is atomic in Google, so a failure leaves
 * whole slides: the ones before it written, the one that failed untouched.
 *
 * TWO PATHS PER ELEMENT. What Slides can say directly is built natively (`createShape` with the
 * preset, `updateShapeProperties`, text, images, lines, tables, groups). A box with per-side
 * borders, per-corner radii or a shadow goes through the converter (export-composition.ts).
 *
 * IDS: an element is created under its engine id (ids.ts makes every engine id a valid object id).
 * Element ids are unique per slide, not per deck, and Slides wants them unique per presentation,
 * so a repeated id gets the slide's position as a suffix; composition shapes start with a short
 * hash of the element id, unique and stable.
 *
 * RE-EXPORT replaces a slide whose page exists by deleting and recreating it under the same id.
 * Whether the id can be reused inside the SAME batch is measured, not assumed:
 * `OBJECT_ID_REUSE_AFTER_DELETE` records the answer, and the plan puts the delete in its own batch
 * when it cannot.
 */
import type { InterchangeLoss } from "../engine/src/contracts/deck-api.ts";
import { plainText } from "../engine/src/contracts/document.ts";
import type {
  AssetRecord,
  DocumentSnapshot,
  ElementSnapshot,
  GroupElement,
  ImageElement,
  LineElement,
  ShapeElement,
  ShapePreset,
  SlideSnapshot,
  TableElement,
  ThemeSnapshot,
} from "../engine/src/contracts/document.ts";
import { frameCentre, rotateFrameAbout, rotatePoint, type Frame, type Point } from "../engine/src/contracts/geometry.ts";
import type { AssetId, SlideId } from "../engine/src/contracts/ids.ts";
import type { ArrowHead, Border, DashStyle, Fill, Stroke } from "../engine/src/contracts/style.ts";
import { channelsOf, wireSolidFill } from "./export-colours.ts";
import { composedBoxRequests, cornerRadiiOf, needsComposition } from "./export-composition.ts";
import { textRequests, type TextExportContext } from "./export-text.ts";
import { pageScaleFor, transformForFrame, type PageScale } from "./interchange-geometry.ts";
import { createLossCollector, type InterchangeLossSink } from "./interchange-losses.ts";
import type { ExportRequest, WireElementProperties, WireSolidFill, WireTransform } from "./slides-requests.ts";

/**
 * MEASURED 2026-10-15 against the development account (e2e/google-slides-round-trip.ts
 * `--measure-reuse`, probe presentation 1HvK-x2chKid3h6zKpDzhNn5_n3wbx1qWiIS_HooEUWw): one
 * batchUpdate of `deleteObject` of a page, `createSlide` under the same `objectId` and a
 * `createShape` under an element id the deleted page held SUCCEEDS. So a re-exported slide is
 * replaced inside its own batch, atomically: a failure leaves that slide's previous version.
 */
export const OBJECT_ID_REUSE_AFTER_DELETE: Readonly<{ sameBatch: boolean; measuredOn: string }> = { sameBatch: true, measuredOn: "2026-10-15" };

export type ExportBatch = Readonly<{
  slideId: SlideId;
  /** 1-based, for the person: "slide 3 failed". */
  slideNumber: number;
  requests: readonly ExportRequest[];
  /** The slide's notes, written after the batch once the notes shape's id is known (null when empty). */
  speakerNotes: string | null;
}>;

export type ExportPlan = Readonly<{
  title: string;
  pageSize: Readonly<{ widthEnglishMetricUnits: number; heightEnglishMetricUnits: number }>;
  /** Batches that delete existing pages before their slide's batch, when ids cannot be reused in one batch. */
  deletionBatches: readonly Readonly<{ slideId: SlideId; requests: readonly ExportRequest[] }>[];
  batches: readonly ExportBatch[];
  /** Every asset an exported picture or background needs at its export address. */
  assetIds: readonly AssetId[];
  losses: readonly InterchangeLoss[];
}>;

export function planExport(
  options: Readonly<{
    snapshot: DocumentSnapshot;
    /** Where Google fetches an asset from (the 30-minute capability address). */
    assetAddress: (assetId: AssetId) => string;
    /** True when the target presentation already has a page with this id (re-export). */
    pageExists: (slideId: SlideId) => boolean;
    reuseInOneBatch: boolean;
  }>,
): ExportPlan {
  const { snapshot } = options;
  const collector = createLossCollector();
  const scale = pageScaleFor({ widthEnglishMetricUnits: 9_144_000, heightEnglishMetricUnits: Math.round(snapshot.pageSize.height * 7143.75) });
  const assets = new Set<AssetId>();
  const usedIds = new Set<string>();
  const exportedSlideIds = new Set(snapshot.slides.map((slide) => slide.id));
  const snapshotAssets = new Map(snapshot.assets.map((asset) => [asset.id, asset]));
  const deletionBatches: { slideId: SlideId; requests: ExportRequest[] }[] = [];
  const batches = snapshot.slides.map((slide, index): ExportBatch => {
    const losses = collector.sink.at({ slideId: slide.id, elementId: null });
    const requests: ExportRequest[] = [];
    if (options.pageExists(slide.id)) {
      const deletion: ExportRequest = { deleteObject: { objectId: slide.id } };
      if (options.reuseInOneBatch) requests.push(deletion);
      else deletionBatches.push({ slideId: slide.id, requests: [deletion] });
    }
    requests.push({ createSlide: { objectId: slide.id, insertionIndex: index, slideLayoutReference: { predefinedLayout: "BLANK" } } });
    requests.push(...backgroundRequests({ slide, theme: snapshot.theme, assetAddress: options.assetAddress, assets, losses }));
    if (slide.skipped) requests.push({ updateSlideProperties: { objectId: slide.id, slideProperties: { isSkipped: true }, fields: "isSkipped" } });
    if (slide.transition !== null) losses.add({ feature: "transition", detail: "Google Slides' programming interface cannot set transitions; this slide's transition was left out." });
    if (slide.animations.length > 0) losses.add({ feature: "animation", detail: animationLossDetail({ slideNumber: index + 1, stepCount: slide.animations.length }) });
    if (slide.layoutId !== null) collector.sink.addOncePerDeck({ feature: "layouts", detail: "Layouts and placeholders became plain positioned elements on BLANK slides." });
    const context: ExportContext = {
      slideId: slide.id,
      slideIndex: index,
      scale,
      theme: snapshot.theme,
      assetAddress: options.assetAddress,
      assets,
      snapshotAssets,
      usedIds,
      losses,
      text: { theme: snapshot.theme, pointsPerUnit: 1 / scale.unitsPerPoint, slideNumber: index + 1, exportedSlideIds, losses },
    };
    for (const element of slide.elements) requests.push(...exportElement({ element, context }).requests);
    const notes = notesText({ slide, slideNumber: index + 1 });
    return { slideId: slide.id, slideNumber: index + 1, requests, speakerNotes: notes.length === 0 ? null : notes };
  });
  return {
    title: snapshot.title,
    pageSize: { widthEnglishMetricUnits: scale.pageWidthEnglishMetricUnits, heightEnglishMetricUnits: scale.pageHeightEnglishMetricUnits },
    deletionBatches,
    batches,
    assetIds: [...assets],
    losses: collector.losses(),
  };
}

/**
 * One line per slide with builds, worded for the person reading the export notice: the Slides
 * programming interface has no request that creates an animation, so every step stays behind.
 */
function animationLossDetail(options: Readonly<{ slideNumber: number; stepCount: number }>): string {
  const what = options.stepCount === 1 ? "its animation is" : `its ${String(options.stepCount)} animations are`;
  return `Slide ${String(options.slideNumber)}: ${what} not exported; Google Slides' programming interface cannot create animations.`;
}

/** The Slides shape type for each preset (the inverse of the import table). */
export const SHAPE_TYPE_BY_PRESET: Readonly<Record<ShapePreset, string>> = {
  textBox: "TEXT_BOX",
  rectangle: "RECTANGLE",
  roundedRectangle: "ROUND_RECTANGLE",
  ellipse: "ELLIPSE",
  triangle: "TRIANGLE",
  rightTriangle: "RIGHT_TRIANGLE",
  diamond: "DIAMOND",
  parallelogram: "PARALLELOGRAM",
  trapezoid: "TRAPEZOID",
  pentagon: "PENTAGON",
  hexagon: "HEXAGON",
  octagon: "OCTAGON",
  fivePointStar: "STAR_5",
  plus: "PLUS",
  heart: "HEART",
  cloud: "CLOUD",
  speechBubble: "WEDGE_ROUND_RECTANGLE_CALLOUT",
  chevron: "CHEVRON",
  rightArrow: "RIGHT_ARROW",
  leftArrow: "LEFT_ARROW",
  upArrow: "UP_ARROW",
  downArrow: "DOWN_ARROW",
};

export const SLIDES_DASH_BY_DASH: Readonly<Record<DashStyle, string>> = {
  solid: "SOLID",
  dot: "DOT",
  dash: "DASH",
  dashDot: "DASH_DOT",
  longDash: "LONG_DASH",
  longDashDot: "LONG_DASH_DOT",
};

/** The Slides arrow style for each engine head; `bar` has no Slides equivalent and is drawn as a square. */
export const SLIDES_ARROW_BY_ARROW: Readonly<Record<ArrowHead, Readonly<{ style: string; exact: boolean }>>> = {
  none: { style: "NONE", exact: true },
  triangle: { style: "FILL_ARROW", exact: true },
  openArrow: { style: "OPEN_ARROW", exact: true },
  stealth: { style: "STEALTH_ARROW", exact: true },
  diamond: { style: "FILL_DIAMOND", exact: true },
  oval: { style: "FILL_CIRCLE", exact: true },
  bar: { style: "FILL_SQUARE", exact: false },
};

/** Google refuses pictures past these (converter/slide-image.ts, createImage reference). */
const MAXIMUM_IMAGE_BYTES = 50 * 1024 * 1024;
const MAXIMUM_IMAGE_PIXELS = 25_000_000;

type ExportContext = Readonly<{
  slideId: SlideId;
  slideIndex: number;
  scale: PageScale;
  theme: ThemeSnapshot;
  assetAddress: (assetId: AssetId) => string;
  assets: Set<AssetId>;
  /** The deck's asset records, for the size limits Google enforces. */
  snapshotAssets: ReadonlyMap<AssetId, AssetRecord>;
  usedIds: Set<string>;
  losses: InterchangeLossSink;
  text: TextExportContext;
}>;

type ElementExport = Readonly<{ requests: readonly ExportRequest[]; createdObjectIds: readonly string[] }>;

function exportElement(options: Readonly<{ element: ElementSnapshot; context: ExportContext }>): ElementExport {
  const { element } = options;
  const context = { ...options.context, losses: options.context.losses.at({ elementId: element.id }) };
  const objectId = uniqueObjectId({ candidate: element.id, context });
  switch (element.kind) {
    case "shape":
      return exportShape({ shape: element, objectId, context });
    case "image":
      return exportImage({ image: element, objectId, context });
    case "line":
      return exportLine({ line: element, objectId, context });
    case "table":
      return exportTable({ table: element, objectId, context });
    case "group":
      return exportGroup({ group: element, objectId, context });
    case "unsupported":
      context.losses.add({ feature: "unsupportedElement", detail: `An element made with a newer version (${element.storedKind}) was left out.` });
      return { requests: [], createdObjectIds: [] };
    default:
      return assertNever(element);
  }
}

function uniqueObjectId(options: Readonly<{ candidate: string; context: ExportContext }>): string {
  const { candidate, context } = options;
  let objectId = candidate;
  for (let attempt = 1; context.usedIds.has(objectId); attempt += 1) objectId = `${candidate.slice(0, 40)}_${context.slideIndex + 1}_${attempt}`;
  context.usedIds.add(objectId);
  return objectId;
}

function elementProperties(options: Readonly<{ frame: Frame; context: ExportContext }>): WireElementProperties {
  const placed = transformForFrame({ frame: options.frame, scale: options.context.scale });
  return {
    pageObjectId: options.context.slideId,
    size: {
      width: { magnitude: Math.max(1, Math.round(placed.widthEnglishMetricUnits)), unit: "EMU" },
      height: { magnitude: Math.max(1, Math.round(placed.heightEnglishMetricUnits)), unit: "EMU" },
    },
    transform: wireTransform(placed.transform),
  };
}

function wireTransform(transform: Omit<WireTransform, "unit">): WireTransform {
  const round = (value: number): number => Math.round(value * 1e6) / 1e6;
  return {
    scaleX: round(transform.scaleX),
    scaleY: round(transform.scaleY),
    shearX: round(transform.shearX),
    shearY: round(transform.shearY),
    translateX: Math.round(transform.translateX),
    translateY: Math.round(transform.translateY),
    unit: "EMU",
  };
}

function exportShape(options: Readonly<{ shape: ShapeElement; objectId: string; context: ExportContext }>): ElementExport {
  const { shape, objectId, context } = options;
  const role = shape.placeholder?.role ?? null;
  // The Slides programming interface creates presets only; a freeform cannot be drawn through it.
  if (shape.customOutline !== null) context.losses.add({ feature: "customShape", detail: "Slides cannot create a custom outline through its programming interface; the freeform was exported as its fallback preset." });
  if (needsComposition(shape.box)) {
    const composed = composedBoxRequests({
      box: shape.box,
      frame: shape.frame,
      pageObjectId: context.slideId,
      objectIdPrefix: compositionPrefix(objectId),
      theme: context.theme,
      scale: context.scale,
      losses: context.losses,
    });
    const text = textRequests({ objectId, body: shape.text, role, cellLocation: null, context: context.text });
    if (text.length === 0) return composed;
    // The text rides on a borderless text box over the composed box (export-composition.ts header).
    return {
      requests: [
        ...composed.requests,
        { createShape: { objectId, shapeType: "TEXT_BOX", elementProperties: elementProperties({ frame: shape.frame, context }) } },
        { updateShapeProperties: { objectId, shapeProperties: { contentAlignment: CONTENT_ALIGNMENT[shape.textBox.verticalAlignment] }, fields: "contentAlignment" } },
        ...text,
      ],
      createdObjectIds: [...composed.createdObjectIds, objectId],
    };
  }
  const requests: ExportRequest[] = [
    { createShape: { objectId, shapeType: SHAPE_TYPE_BY_PRESET[shape.preset], elementProperties: elementProperties({ frame: shape.frame, context }) } },
    {
      updateShapeProperties: {
        objectId,
        shapeProperties: {
          shapeBackgroundFill: nativeFill({ fill: shape.box.fill, context }),
          outline: nativeOutline({ border: shape.box.border, context }),
          contentAlignment: CONTENT_ALIGNMENT[shape.textBox.verticalAlignment],
        },
        fields: "shapeBackgroundFill,outline,contentAlignment",
      },
    },
    ...textRequests({ objectId, body: shape.text, role, cellLocation: null, context: context.text }),
  ];
  if (shape.box.opacity < 1) context.losses.add({ feature: "opacity", detail: "Slides has no element opacity; the shape was exported opaque." });
  if (shape.textBox.autofit !== "none") context.losses.addOncePerDeck({ feature: "autofit", detail: "Text autofit cannot be set through the programming interface; text boxes keep Slides' own default." });
  if (cornerRadiiOf(shape.box.cornerRadius)[0] > 0 && SHAPE_TYPE_BY_PRESET[shape.preset] !== "ROUND_RECTANGLE") {
    context.losses.add({ feature: "cornerRadius", detail: "Only the rounded rectangle preset has rounded corners in Slides; this shape's corners are square." });
  }
  return { requests, createdObjectIds: [objectId] };
}

const CONTENT_ALIGNMENT: Readonly<Record<ShapeElement["textBox"]["verticalAlignment"], "TOP" | "MIDDLE" | "BOTTOM">> = { top: "TOP", middle: "MIDDLE", bottom: "BOTTOM" };

function compositionPrefix(objectId: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < objectId.length; index += 1) hash = Math.imul(hash ^ objectId.charCodeAt(index), 0x01000193) >>> 0;
  return `cmp${hash.toString(36)}`;
}

function nativeFill(options: Readonly<{ fill: Fill; context: ExportContext }>): Readonly<{ solidFill: WireSolidFill }> | Readonly<{ propertyState: "NOT_RENDERED" }> {
  const { fill, context } = options;
  switch (fill.kind) {
    case "none":
      return { propertyState: "NOT_RENDERED" };
    case "solid":
      return { solidFill: wireSolidFill({ colour: fill.colour, theme: context.theme, losses: context.losses }) };
    case "linearGradient":
    case "radialGradient": {
      context.losses.add({ feature: fill.kind, detail: "Google Slides cannot fill a shape with a gradient; it shows the gradient's first colour." });
      const first = fill.stops[0];
      return first === undefined ? { propertyState: "NOT_RENDERED" } : { solidFill: wireSolidFill({ colour: first.colour, theme: context.theme, losses: context.losses }) };
    }
    case "image":
      context.losses.add({ feature: "pictureFill", detail: "The programming interface cannot fill a shape with a picture; the shape was exported without its fill." });
      return { propertyState: "NOT_RENDERED" };
    default:
      return assertNever(fill);
  }
}

function nativeOutline(
  options: Readonly<{ border: Border; context: ExportContext }>,
): Readonly<{ outlineFill: Readonly<{ solidFill: WireSolidFill }>; weight: Readonly<{ magnitude: number; unit: "EMU" }>; dashStyle: string }> | Readonly<{ propertyState: "NOT_RENDERED" }> {
  const { border, context } = options;
  switch (border.kind) {
    case "none":
      return { propertyState: "NOT_RENDERED" };
    case "uniform":
      return strokeOutline({ stroke: border.stroke, context });
    case "perSide":
      // Composition handles per-side borders; reaching here means needsComposition changed.
      throw new Error("a per-side border reached the native path");
    default:
      return assertNever(border);
  }
}

function strokeOutline(options: Readonly<{ stroke: Stroke; context: ExportContext }>) {
  const { stroke, context } = options;
  return {
    outlineFill: { solidFill: wireSolidFill({ colour: stroke.colour, theme: context.theme, losses: context.losses }) },
    weight: { magnitude: Math.max(1, Math.round(stroke.width / context.scale.unitsPerEnglishMetricUnit)), unit: "EMU" as const },
    dashStyle: SLIDES_DASH_BY_DASH[stroke.dash],
  };
}

function exportImage(options: Readonly<{ image: ImageElement; objectId: string; context: ExportContext }>): ElementExport {
  const { image, objectId, context } = options;
  if (image.crop.left !== 0 || image.crop.top !== 0 || image.crop.right !== 0 || image.crop.bottom !== 0) {
    context.losses.add({ feature: "crop", detail: "The programming interface cannot crop a picture; it was exported uncropped." });
  }
  const asset = context.snapshotAssets.get(image.assetId) ?? null;
  if (asset !== null && (asset.byteLength > MAXIMUM_IMAGE_BYTES || asset.pixelWidth * asset.pixelHeight > MAXIMUM_IMAGE_PIXELS)) {
    context.losses.add({ feature: "imageTooLarge", detail: "The picture is over Google's 50 megabyte or 25 megapixel limit and was left out." });
    return { requests: [], createdObjectIds: [] };
  }
  context.assets.add(image.assetId);
  const requests: ExportRequest[] = [{ createImage: { objectId, url: context.assetAddress(image.assetId), elementProperties: elementProperties({ frame: image.frame, context }) } }];
  switch (image.box.border.kind) {
    case "none":
      break;
    case "uniform": {
      const outline = strokeOutline({ stroke: image.box.border.stroke, context });
      requests.push({ updateImageProperties: { objectId, imageProperties: { outline }, fields: "outline" } });
      break;
    }
    case "perSide":
      context.losses.add({ feature: "perSideBorder", detail: "A picture's outline is one stroke in Slides; its per-side border was left out." });
      break;
    default:
      assertNever(image.box.border);
  }
  if (cornerRadiiOf(image.box.cornerRadius).some((radius) => radius > 0)) {
    context.losses.add({ feature: "imageCornerRadius", detail: "Slides cannot round a picture's corners through the programming interface." });
  }
  if (image.box.shadow !== null) context.losses.add({ feature: "shadow", detail: "The programming interface cannot give a picture a shadow." });
  return { requests, createdObjectIds: [objectId] };
}

function exportLine(options: Readonly<{ line: LineElement; objectId: string; context: ExportContext }>): ElementExport {
  const { line, objectId, context } = options;
  const arrow = (head: ArrowHead): string => {
    const mapped = SLIDES_ARROW_BY_ARROW[head];
    if (!mapped.exact) context.losses.add({ feature: "arrowHead", detail: `The ${head} arrowhead is drawn as ${mapped.style}.` });
    return mapped.style;
  };
  return {
    requests: [
      { createLine: { objectId, lineCategory: LINE_CATEGORY[line.routing], elementProperties: lineProperties({ start: line.start, end: line.end, context }) } },
      {
        updateLineProperties: {
          objectId,
          lineProperties: {
            lineFill: { solidFill: { ...wireSolidFill({ colour: line.stroke.colour, theme: context.theme, losses: context.losses }), alpha: Math.round(line.stroke.colour.alpha * line.opacity * 1000) / 1000 } },
            weight: { magnitude: Math.max(1, Math.round(line.stroke.width / context.scale.unitsPerEnglishMetricUnit)), unit: "EMU" },
            dashStyle: SLIDES_DASH_BY_DASH[line.stroke.dash],
            startArrow: arrow(line.startArrow),
            endArrow: arrow(line.endArrow),
          },
          fields: "lineFill,weight,dashStyle,startArrow,endArrow",
        },
      },
    ],
    createdObjectIds: [objectId],
  };
}

const LINE_CATEGORY: Readonly<Record<LineElement["routing"], "STRAIGHT" | "BENT" | "CURVED">> = { straight: "STRAIGHT", elbow: "BENT", curved: "CURVED" };

/**
 * A Slides line runs from its box's top-left to its bottom-right; the other diagonal and the
 * reversed directions are mirrors of the box (negative scales), as the converter's `placeLine` does.
 */
function lineProperties(options: Readonly<{ start: Point; end: Point; context: ExportContext }>): WireElementProperties {
  const { start, end, context } = options;
  const toEnglishMetricUnits = 1 / context.scale.unitsPerEnglishMetricUnit;
  const width = Math.abs(end.x - start.x) * toEnglishMetricUnits;
  const height = Math.abs(end.y - start.y) * toEnglishMetricUnits;
  const scaleX = end.x >= start.x ? 1 : -1;
  const scaleY = end.y >= start.y ? 1 : -1;
  return {
    pageObjectId: context.slideId,
    size: { width: { magnitude: Math.max(1, Math.round(width)), unit: "EMU" }, height: { magnitude: Math.max(1, Math.round(height)), unit: "EMU" } },
    transform: { scaleX, scaleY, shearX: 0, shearY: 0, translateX: Math.round(start.x * toEnglishMetricUnits), translateY: Math.round(start.y * toEnglishMetricUnits), unit: "EMU" },
  };
}

function exportTable(options: Readonly<{ table: TableElement; objectId: string; context: ExportContext }>): ElementExport {
  const { table, objectId, context } = options;
  if (table.frame.rotation !== 0) context.losses.add({ feature: "rotation", detail: "Slides tables cannot be rotated; the table was exported upright." });
  const upright: Frame = { ...table.frame, rotation: 0, flipHorizontal: false, flipVertical: false };
  const toEnglishMetricUnits = 1 / context.scale.unitsPerEnglishMetricUnit;
  const requests: ExportRequest[] = [
    { createTable: { objectId, rows: table.rows.length, columns: table.columns.length, elementProperties: elementProperties({ frame: upright, context }) } },
  ];
  table.columns.forEach((column, columnIndex) => {
    requests.push({ updateTableColumnProperties: { objectId, columnIndices: [columnIndex], tableColumnProperties: { columnWidth: { magnitude: Math.round(column.width * toEnglishMetricUnits), unit: "EMU" } }, fields: "columnWidth" } });
  });
  table.rows.forEach((row, rowIndex) => {
    requests.push({ updateTableRowProperties: { objectId, rowIndices: [rowIndex], tableRowProperties: { minRowHeight: { magnitude: Math.round(row.minimumHeight * toEnglishMetricUnits), unit: "EMU" } }, fields: "minRowHeight" } });
  });
  const rowIndexOf = new Map(table.rows.map((row, index) => [row.id, index]));
  const columnIndexOf = new Map(table.columns.map((column, index) => [column.id, index]));
  // Merges first, then each cell's fill and borders over its whole span. Measured on live exports
  // (2026-10-15): with the merged-away cells also written (below, `coveredCells`), their empty
  // default borders erased the merged cell's top and left lines.
  for (const cell of table.cells) {
    const rowIndex = rowIndexOf.get(cell.rowId);
    const columnIndex = columnIndexOf.get(cell.columnId);
    if (rowIndex === undefined || columnIndex === undefined || (cell.rowSpan === 1 && cell.columnSpan === 1)) continue;
    requests.push({ mergeTableCells: { objectId, tableRange: { location: { rowIndex, columnIndex }, rowSpan: cell.rowSpan, columnSpan: cell.columnSpan } } });
  }
  // The snapshot shows every row by column cell, a merged-away one as an empty default cell
  // (document.ts TableElement); writing its default borders would erase the merged cell's.
  const covered = coveredCells({ table, rowIndexOf, columnIndexOf });
  for (const cell of table.cells) {
    const rowIndex = rowIndexOf.get(cell.rowId);
    const columnIndex = columnIndexOf.get(cell.columnId);
    if (rowIndex === undefined || columnIndex === undefined || covered.has(`${rowIndex}:${columnIndex}`)) continue;
    const location = { rowIndex, columnIndex };
    const range = { location, rowSpan: cell.rowSpan, columnSpan: cell.columnSpan };
    requests.push(...textRequests({ objectId, body: cell.text, role: null, cellLocation: location, context: context.text }));
    requests.push({
      updateTableCellProperties: {
        objectId,
        tableRange: range,
        tableCellProperties: { tableCellBackgroundFill: nativeFill({ fill: cell.fill, context }), contentAlignment: CONTENT_ALIGNMENT[cell.textBox.verticalAlignment] },
        fields: "tableCellBackgroundFill,contentAlignment",
      },
    });
    for (const side of ["TOP", "BOTTOM", "LEFT", "RIGHT"] as const) {
      requests.push({
        updateTableBorderProperties: {
          objectId,
          tableRange: range,
          borderPosition: side,
          tableBorderProperties: tableBorderOf({ stroke: cell.borders[BORDER_SIDE[side]], context }),
          fields: "tableBorderFill,weight,dashStyle",
        },
      });
    }
  }
  if (table.opacity < 1) context.losses.add({ feature: "opacity", detail: "Slides has no table opacity; the table was exported opaque." });
  return { requests, createdObjectIds: [objectId] };
}

const BORDER_SIDE = { TOP: "top", BOTTOM: "bottom", LEFT: "left", RIGHT: "right" } as const;

/** "row:column" of every cell inside another cell's span (not the spanning cell itself). */
function coveredCells(
  options: Readonly<{ table: TableElement; rowIndexOf: ReadonlyMap<string, number>; columnIndexOf: ReadonlyMap<string, number> }>,
): ReadonlySet<string> {
  const covered = new Set<string>();
  for (const cell of options.table.cells) {
    const rowIndex = options.rowIndexOf.get(cell.rowId);
    const columnIndex = options.columnIndexOf.get(cell.columnId);
    if (rowIndex === undefined || columnIndex === undefined) continue;
    for (let row: number = rowIndex; row < rowIndex + cell.rowSpan; row += 1) {
      for (let column: number = columnIndex; column < columnIndex + cell.columnSpan; column += 1) {
        if (row !== rowIndex || column !== columnIndex) covered.add(`${row}:${column}`);
      }
    }
  }
  return covered;
}

/** A cell side's border; no border is Slides' default grid line made invisible rather than left showing. */
function tableBorderOf(options: Readonly<{ stroke: Stroke | null; context: ExportContext }>) {
  const { stroke, context } = options;
  if (stroke === null) {
    return { tableBorderFill: { solidFill: { color: { rgbColor: channelsOf("#000000") }, alpha: 0 } }, weight: { magnitude: 12_700, unit: "EMU" as const }, dashStyle: "SOLID" };
  }
  const outline = strokeOutline({ stroke, context });
  return { tableBorderFill: outline.outlineFill, weight: outline.weight, dashStyle: outline.dashStyle };
}

/**
 * Children first, then `groupObjects`, then the group's own rotation. The children are exported
 * UN-rotated about the group's centre and the group is then turned by its rotation, so Slides holds
 * the same group rotation the engine shows (a rotated group keeps rotated handles in both).
 */
function exportGroup(options: Readonly<{ group: GroupElement; objectId: string; context: ExportContext }>): ElementExport {
  const { group, objectId, context } = options;
  const rotation = group.frame.rotation;
  const pivot = frameCentre(group.frame);
  const children = rotation === 0 ? group.children : group.children.map((child) => unrotated({ element: child, pivot, degrees: -rotation }));
  const exported = children.map((child) => exportElement({ element: child, context }));
  const childIds = exported.flatMap((child) => child.createdObjectIds);
  const requests: ExportRequest[] = exported.flatMap((child) => [...child.requests]);
  if (childIds.length < 2) return { requests, createdObjectIds: childIds };
  requests.push({ groupObjects: { groupObjectId: objectId, childrenObjectIds: childIds } });
  if (rotation !== 0) requests.push({ updatePageElementTransform: { objectId, applyMode: "RELATIVE", transform: rotationAbout({ pivot, degrees: rotation, scale: context.scale }) } });
  return { requests, createdObjectIds: [objectId] };
}

function unrotated(options: Readonly<{ element: ElementSnapshot; pivot: Point; degrees: number }>): ElementSnapshot {
  const { element, pivot, degrees } = options;
  switch (element.kind) {
    case "line":
      return { ...element, start: rotatePoint({ point: element.start, centre: pivot, degrees }), end: rotatePoint({ point: element.end, centre: pivot, degrees }) };
    case "group":
      return { ...element, frame: rotateFrameAbout({ frame: element.frame, pivot, degrees }), children: element.children.map((child) => unrotated({ element: child, pivot, degrees })) };
    case "shape":
    case "image":
    case "table":
    case "unsupported":
      return { ...element, frame: rotateFrameAbout({ frame: element.frame, pivot, degrees }) };
    default:
      return assertNever(element);
  }
}

/** translate(pivot) * rotate(degrees) * translate(-pivot), in English metric units. */
function rotationAbout(options: Readonly<{ pivot: Point; degrees: number; scale: PageScale }>): WireTransform {
  const radians = (options.degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const pivotX = options.pivot.x / options.scale.unitsPerEnglishMetricUnit;
  const pivotY = options.pivot.y / options.scale.unitsPerEnglishMetricUnit;
  return wireTransform({
    scaleX: cosine,
    shearX: -sine,
    shearY: sine,
    scaleY: cosine,
    translateX: pivotX - cosine * pivotX + sine * pivotY,
    translateY: pivotY - sine * pivotX - cosine * pivotY,
  });
}

function backgroundRequests(
  options: Readonly<{ slide: SlideSnapshot; theme: ThemeSnapshot; assetAddress: (assetId: AssetId) => string; assets: Set<AssetId>; losses: InterchangeLossSink }>,
): readonly ExportRequest[] {
  const { slide, theme, losses } = options;
  const fill = slide.background ?? theme.background;
  const objectId = slide.id;
  switch (fill.kind) {
    case "none":
      return [{ updatePageProperties: { objectId, pageProperties: { pageBackgroundFill: { propertyState: "NOT_RENDERED" } }, fields: "pageBackgroundFill.propertyState" } }];
    case "solid":
      return [{ updatePageProperties: { objectId, pageProperties: { pageBackgroundFill: { solidFill: wireSolidFill({ colour: fill.colour, theme, losses }) } }, fields: "pageBackgroundFill.solidFill" } }];
    case "linearGradient":
    case "radialGradient": {
      losses.add({ feature: fill.kind, detail: "Google Slides cannot draw a gradient background; the slide shows the gradient's first colour." });
      const first = fill.stops[0];
      if (first === undefined) return [];
      return [{ updatePageProperties: { objectId, pageProperties: { pageBackgroundFill: { solidFill: wireSolidFill({ colour: first.colour, theme, losses }) } }, fields: "pageBackgroundFill.solidFill" } }];
    }
    case "image":
      options.assets.add(fill.assetId);
      if (fill.fit !== "stretch") losses.add({ feature: "backgroundFit", detail: `Slides stretches a background picture; the ${fill.fit} fit was not kept.` });
      return [
        {
          updatePageProperties: {
            objectId,
            pageProperties: { pageBackgroundFill: { stretchedPictureFill: { contentUrl: options.assetAddress(fill.assetId) } } },
            fields: "pageBackgroundFill.stretchedPictureFill.contentUrl",
          },
        },
      ];
    default:
      return assertNever(fill);
  }
}

function notesText(options: Readonly<{ slide: SlideSnapshot; slideNumber: number }>): string {
  return plainText({ body: options.slide.speakerNotes, slideNumber: options.slideNumber }).trim();
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
