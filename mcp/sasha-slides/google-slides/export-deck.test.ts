/**
 * The EXPORT TABLE of SPEC.md 21.12: engine fixtures -> the exact batchUpdate request lists.
 *
 * Each row's full request list is compared with fixtures/export-requests.snapshot.json (written
 * once with UPDATE_SNAPSHOTS=1 and read by a person; the live round trip in
 * e2e/google-slides-round-trip.ts is what proved Google accepts these shapes). Next to the
 * snapshot every row also asserts, explicitly, the fields its table row is about, so a snapshot
 * update cannot quietly change what the row claims.
 *
 * The composition rows assert THROUGH THE CONVERTER: the requests a per-side border or a
 * per-corner radius exports are compared with what `emitSlideRequests` itself emits for the same
 * extraction, so the export is shown to be the converter's composition and not a copy of it.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, test } from "node:test";
import { emitSlideRequests } from "../converter/emit-requests.ts";
import type { DocumentSnapshot, ElementSnapshot, ShapeElement, ShapePreset, SlideSnapshot, TextBody, ThemeSnapshot } from "../engine/src/contracts/document.ts";
import type { AssetId, DeckId, ElementId, ListId, SlideId, TableColumnId, TableRowId } from "../engine/src/contracts/ids.ts";
import type { BoxStyle } from "../engine/src/contracts/style.ts";
import { planExport, SHAPE_TYPE_BY_PRESET, type ExportPlan } from "./export-deck.ts";
import type { ExportRequest } from "./slides-requests.ts";

const SNAPSHOT_PATH = new URL("./fixtures/export-requests.snapshot.json", import.meta.url);
const UPDATE = process.env["UPDATE_SNAPSHOTS"] === "1";
const snapshots: Record<string, unknown> = existsSync(SNAPSHOT_PATH) ? (JSON.parse(readFileSync(SNAPSHOT_PATH, "utf-8")) as Record<string, unknown>) : {};

describe("export mapping (SPEC.md 21.12 export table)", () => {
  test("slide: createSlide under the engine id on BLANK, background, skip; layouts reported once", () => {
    const plan = planOf([slide({ id: "sl_first0001", background: { kind: "solid", colour: { kind: "literal", hexadecimal: "#336699", alpha: 1 } }, skipped: true, layoutId: "ly_layout0001" })]);
    const requests = onlyBatch(plan);
    matchesSnapshot({ name: "slide background and skip", value: requests });
    assert.deepEqual(kinds(requests), ["createSlide", "updatePageProperties", "updateSlideProperties"]);
    assert.deepEqual(field(requests[0], "createSlide"), { objectId: "sl_first0001", insertionIndex: 0, slideLayoutReference: { predefinedLayout: "BLANK" } });
    assert.equal(plan.losses.filter((loss) => loss.feature === "layouts").length, 1);
  });

  test("rectangle family with a uniform border, and every preset -> createShape with its shapeType + updateShapeProperties", () => {
    const presets = Object.keys(SHAPE_TYPE_BY_PRESET) as ShapePreset[];
    // Columns: preset -> the Slides shapeType it is created as.
    const expected: Readonly<Record<ShapePreset, string>> = {
      textBox: "TEXT_BOX", rectangle: "RECTANGLE", roundedRectangle: "ROUND_RECTANGLE", ellipse: "ELLIPSE", triangle: "TRIANGLE", rightTriangle: "RIGHT_TRIANGLE",
      diamond: "DIAMOND", parallelogram: "PARALLELOGRAM", trapezoid: "TRAPEZOID", pentagon: "PENTAGON", hexagon: "HEXAGON", octagon: "OCTAGON", fivePointStar: "STAR_5",
      plus: "PLUS", heart: "HEART", cloud: "CLOUD", speechBubble: "WEDGE_ROUND_RECTANGLE_CALLOUT", chevron: "CHEVRON", rightArrow: "RIGHT_ARROW", leftArrow: "LEFT_ARROW",
      upArrow: "UP_ARROW", downArrow: "DOWN_ARROW",
    };
    for (const preset of presets) {
      const requests = onlyBatch(planOf([slide({ id: "sl_shapes0001", elements: [shape({ id: "el_shape0001", preset })] })])).slice(2);
      assert.equal(field(requests[0], "createShape")?.["shapeType"], expected[preset], preset);
    }
    const bordered = onlyBatch(planOf([slide({ id: "sl_shapes0001", elements: [shape({ id: "el_shape0001", preset: "rectangle", box: { ...PLAIN, fill: { kind: "solid", colour: { kind: "theme", slot: "accent1", alpha: 0.5 } }, border: { kind: "uniform", stroke: { width: 4, colour: { kind: "literal", hexadecimal: "#ff0000", alpha: 1 }, dash: "dash" } } } })] })])).slice(2);
    matchesSnapshot({ name: "rectangle with uniform border", value: bordered });
    const properties = field(bordered[1], "updateShapeProperties");
    assert.deepEqual(properties?.["fields"], "shapeBackgroundFill,outline,contentAlignment");
    assert.deepEqual(properties?.["shapeProperties"], {
      shapeBackgroundFill: { solidFill: { color: { rgbColor: { red: 0.2627, green: 0.2196, blue: 0.7922 } }, alpha: 0.5 } },
      outline: { outlineFill: { solidFill: { color: { rgbColor: { red: 1, green: 0, blue: 0 } }, alpha: 1 } }, weight: { magnitude: 28_575, unit: "EMU" }, dashStyle: "DASH" },
      contentAlignment: "TOP",
    });
  });

  test("text: insertText, bullets per list run, paragraph styles, run styles; automaticText -> the number plus a loss", () => {
    const listId = "ls_list00001" as ListId;
    const body: TextBody = {
      paragraphs: [
        { style: { alignment: "centre" }, runs: [{ kind: "text", text: "Title ", style: { fontWeight: 700 } }, { kind: "automaticText", field: "slideNumber", style: {} }] },
        { style: { list: { kind: "list", listId, glyph: "disc", level: 0 } }, runs: [{ kind: "text", text: "One", style: { link: { kind: "webAddress", address: "https://example.com" } } }] },
        { style: { list: { kind: "list", listId, glyph: "disc", level: 1 } }, runs: [{ kind: "text", text: "Two", style: { fontStyle: "italic" } }] },
      ],
    };
    const plan = planOf([slide({ id: "sl_text00001", elements: [shape({ id: "el_text00001", preset: "textBox", text: body })] }), slide({ id: "sl_text00002" })]);
    const requests = onlyBatch(plan).slice(4);
    matchesSnapshot({ name: "text with list and automatic number", value: requests });
    assert.deepEqual(kinds(requests), ["insertText", "createParagraphBullets", "updateParagraphStyle", "updateTextStyle", "updateTextStyle", "updateParagraphStyle", "updateTextStyle", "updateParagraphStyle", "updateTextStyle"]);
    assert.deepEqual(field(requests[0], "insertText"), { objectId: "el_text00001", text: "Title 1\nOne\n\tTwo", insertionIndex: 0 });
    assert.deepEqual(field(requests[1], "createParagraphBullets")?.["textRange"], { type: "FIXED_RANGE", startIndex: 8, endIndex: 16 }, "the list paragraphs, tabs included");
    assert.deepEqual(field(requests[6], "updateTextStyle")?.["textRange"], { type: "FIXED_RANGE", startIndex: 8, endIndex: 11 }, "after the bullets, indices are tab-free");
    assert.ok(plan.losses.some((loss) => loss.feature === "automaticText"));
  });

  test("image: createImage from the export-asset address; crop -> loss; a uniform border -> outline", () => {
    const assetId = "a".repeat(64) as AssetId;
    const rows = [
      { label: "uncropped", crop: { left: 0, top: 0, right: 0, bottom: 0 }, cropLoss: false },
      { label: "cropped", crop: { left: 0.1, top: 0, right: 0, bottom: 0 }, cropLoss: true },
    ];
    for (const row of rows) {
      const image: ElementSnapshot = { ...common({ id: "el_image0001" }), kind: "image", assetId, crop: row.crop, box: { ...PLAIN, border: { kind: "uniform", stroke: { width: 2, colour: { kind: "literal", hexadecimal: "#000000", alpha: 1 }, dash: "solid" } } } };
      const plan = planOf([slide({ id: "sl_image0001", elements: [image] })]);
      const requests = onlyBatch(plan).slice(2);
      if (!row.cropLoss) matchesSnapshot({ name: "image", value: requests });
      assert.equal(field(requests[0], "createImage")?.["url"], `https://sashaslides.example/deck-api/export-assets/TOKEN/${assetId}`, row.label);
      assert.deepEqual(kinds(requests), ["createImage", "updateImageProperties"], row.label);
      assert.equal(plan.losses.some((loss) => loss.feature === "crop"), row.cropLoss, row.label);
      assert.deepEqual(plan.assetIds, [assetId]);
    }
  });

  test("line: createLine with its category, updateLineProperties with weight, dash, fill and arrows", () => {
    const line: ElementSnapshot = {
      ...common({ id: "el_line00001" }),
      kind: "line",
      start: { x: 400, y: 100 },
      end: { x: 200, y: 300 },
      routing: "elbow",
      stroke: { width: 4, colour: { kind: "literal", hexadecimal: "#112233", alpha: 1 }, dash: "dashDot" },
      startArrow: "stealth",
      endArrow: "bar",
      opacity: 1,
    };
    const plan = planOf([slide({ id: "sl_line00001", elements: [line] })]);
    const requests = onlyBatch(plan).slice(2);
    matchesSnapshot({ name: "line", value: requests });
    const created = field(requests[0], "createLine");
    assert.equal(created?.["lineCategory"], "BENT");
    assert.deepEqual((created?.["elementProperties"] as Readonly<Record<string, unknown>> | undefined)?.["transform"], { scaleX: -1, scaleY: 1, shearX: 0, shearY: 0, translateX: 2_857_500, translateY: 714_375, unit: "EMU" }, "the anti-diagonal is a mirrored box starting at the start point");
    const properties = field(requests[1], "updateLineProperties")?.["lineProperties"] as Readonly<Record<string, unknown>> | undefined;
    assert.deepEqual({ dash: properties?.["dashStyle"], start: properties?.["startArrow"], end: properties?.["endArrow"] }, { dash: "DASH_DOT", start: "STEALTH_ARROW", end: "FILL_SQUARE" });
    assert.ok(plan.losses.some((loss) => loss.feature === "arrowHead"), "bar has no Slides arrow");
  });

  test("table: createTable, column widths, row heights, mergeTableCells for spans, text, cell fill, borders per side", () => {
    const rows = [{ id: "rw_row000001" as TableRowId, minimumHeight: 40 }, { id: "rw_row000002" as TableRowId, minimumHeight: 40 }];
    const columns = [{ id: "cl_col000001" as TableColumnId, width: 100 }, { id: "cl_col000002" as TableColumnId, width: 120 }];
    const stroke = { width: 2, colour: { kind: "literal" as const, hexadecimal: "#ff0000", alpha: 1 }, dash: "solid" as const };
    const table: ElementSnapshot = {
      ...common({ id: "el_table0001" }),
      kind: "table",
      rows,
      columns,
      opacity: 1,
      cells: [
        { rowId: rows[0]?.id ?? ("" as TableRowId), columnId: columns[0]?.id ?? ("" as TableColumnId), rowSpan: 1, columnSpan: 2, fill: { kind: "solid", colour: { kind: "literal", hexadecimal: "#eeeeee", alpha: 1 } }, borders: { top: stroke, right: null, bottom: null, left: stroke }, textBox: TEXT_BOX, text: textOf("Head") },
        { rowId: rows[1]?.id ?? ("" as TableRowId), columnId: columns[0]?.id ?? ("" as TableColumnId), rowSpan: 1, columnSpan: 1, fill: { kind: "none" }, borders: { top: null, right: null, bottom: null, left: null }, textBox: TEXT_BOX, text: textOf("A") },
      ],
    };
    const requests = onlyBatch(planOf([slide({ id: "sl_table0001", elements: [table] })])).slice(2);
    matchesSnapshot({ name: "table", value: requests });
    assert.deepEqual(kinds(requests).slice(0, 6), ["createTable", "updateTableColumnProperties", "updateTableColumnProperties", "updateTableRowProperties", "updateTableRowProperties", "mergeTableCells"]);
    assert.deepEqual(field(requests[5], "mergeTableCells")?.["tableRange"], { location: { rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: 2 });
    const borders = requests.flatMap((request) => ("updateTableBorderProperties" in request ? [request.updateTableBorderProperties] : []));
    assert.equal(borders.length, 8, "four sides of each of the two cells");
    const headTop = borders.find((border) => border.borderPosition === "TOP" && border.tableRange.location.rowIndex === 0);
    assert.deepEqual(headTop?.tableBorderProperties.tableBorderFill?.solidFill.color.rgbColor, { red: 1, green: 0, blue: 0 });
    assert.deepEqual(headTop?.tableRange, { location: { rowIndex: 0, columnIndex: 0 }, rowSpan: 1, columnSpan: 2 }, "a merged cell's border covers its whole span");
  });

  test("group: children first, then groupObjects, then the group's rotation through updatePageElementTransform", () => {
    const children = [shape({ id: "el_child0001", preset: "rectangle", frame: { x: 100, y: 100, width: 100, height: 50, rotation: 30, flipHorizontal: false, flipVertical: false } }), shape({ id: "el_child0002", preset: "ellipse", frame: { x: 250, y: 100, width: 60, height: 60, rotation: 30, flipHorizontal: false, flipVertical: false } })];
    const group: ElementSnapshot = { ...common({ id: "el_group0001" }), frame: { x: 100, y: 80, width: 220, height: 100, rotation: 30, flipHorizontal: false, flipVertical: false }, kind: "group", children: children.map((child) => ({ ...child, groupId: "el_group0001" as ElementId })) };
    const requests = onlyBatch(planOf([slide({ id: "sl_group0001", elements: [group] })])).slice(2);
    matchesSnapshot({ name: "rotated group", value: requests });
    assert.deepEqual(kinds(requests), ["createShape", "updateShapeProperties", "createShape", "updateShapeProperties", "groupObjects", "updatePageElementTransform"]);
    assert.deepEqual(field(requests[4], "groupObjects"), { groupObjectId: "el_group0001", childrenObjectIds: ["el_child0001", "el_child0002"] });
    const childTransform = (field(requests[0], "createShape")?.["elementProperties"] as Readonly<{ transform: Readonly<Record<string, number>> }> | undefined)?.transform;
    assert.equal(childTransform?.["shearY"], 0, "children go in un-rotated; the group turn adds the 30 degrees back");
  });

  test("per-side border -> the converter's composition (edge lines), asserted through emitSlideRequests", () => {
    const box: BoxStyle = {
      ...PLAIN,
      fill: { kind: "solid", colour: { kind: "literal", hexadecimal: "#ffffff", alpha: 1 } },
      border: { kind: "perSide", top: { width: 4, colour: { kind: "literal", hexadecimal: "#ff0000", alpha: 1 }, dash: "solid" }, right: null, bottom: { width: 2, colour: { kind: "literal", hexadecimal: "#0000ff", alpha: 1 }, dash: "dash" }, left: null },
    };
    const plan = planOf([slide({ id: "sl_compose01", elements: [shape({ id: "el_compose01", preset: "rectangle", box, frame: FRAME })] })]);
    const requests = onlyBatch(plan).slice(2);
    matchesSnapshot({ name: "per-side border composition", value: requests });
    const direct = emitSlideRequests({ extraction: { viewportPx: { w: 1280, h: 720 }, elements: [converterRect({ box: "perSide" })], malformedCount: 0 }, pageObjectId: "sl_compose01", objectIdPrefix: compositionPrefixOf(requests) });
    assert.deepEqual(requests, direct.requests, "exactly the converter's own emission");
    assert.deepEqual(kinds(requests), ["createShape", "updateShapeProperties", "createLine", "updateLineProperties", "createLine", "updateLineProperties"]);
    assert.ok(plan.losses.some((loss) => loss.feature === "non-uniform-border"), "the converter's UnsupportedFeature became a loss");
  });

  test("per-corner radius -> the converter's composition (ROUND_2_SAME preset), asserted through emitSlideRequests", () => {
    const box: BoxStyle = { ...PLAIN, fill: { kind: "solid", colour: { kind: "literal", hexadecimal: "#ffffff", alpha: 1 } }, cornerRadius: { kind: "perCorner", topLeft: 16, topRight: 16, bottomRight: 0, bottomLeft: 0 } };
    const plan = planOf([slide({ id: "sl_compose02", elements: [shape({ id: "el_compose02", preset: "rectangle", box, frame: FRAME })] })]);
    const requests = onlyBatch(plan).slice(2);
    matchesSnapshot({ name: "per-corner radius composition", value: requests });
    const direct = emitSlideRequests({ extraction: { viewportPx: { w: 1280, h: 720 }, elements: [converterRect({ box: "perCorner" })], malformedCount: 0 }, pageObjectId: "sl_compose02", objectIdPrefix: compositionPrefixOf(requests) });
    assert.deepEqual(requests, direct.requests);
    assert.equal(field(requests[0], "createShape")?.["shapeType"], "ROUND_2_SAME_RECTANGLE");
    assert.ok(plan.losses.some((loss) => loss.feature === "corner-radius-approximated"));
  });

  test("radial and linear gradients export their first stop plus a loss; a solid fill (control) does not", () => {
    const stops = [{ colour: { kind: "literal" as const, hexadecimal: "#ff8800", alpha: 1 }, offset: 0 }, { colour: { kind: "literal" as const, hexadecimal: "#0000ff", alpha: 1 }, offset: 1 }];
    const rows = [
      { label: "radial", fill: { kind: "radialGradient" as const, centreX: 0.5, centreY: 0.5, stops }, loss: "radialGradient" },
      { label: "linear", fill: { kind: "linearGradient" as const, angle: 90, stops }, loss: "linearGradient" },
      { label: "solid control", fill: { kind: "solid" as const, colour: stops[0]?.colour ?? { kind: "literal", hexadecimal: "#ff8800", alpha: 1 } }, loss: null },
    ];
    for (const row of rows) {
      const plan = planOf([slide({ id: "sl_gradient1", elements: [shape({ id: "el_gradient1", preset: "rectangle", box: { ...PLAIN, fill: row.fill } })] })]);
      const properties = field(onlyBatch(plan)[3], "updateShapeProperties")?.["shapeProperties"] as Readonly<Record<string, unknown>> | undefined;
      assert.deepEqual(properties?.["shapeBackgroundFill"], { solidFill: { color: { rgbColor: { red: 1, green: 0.5333, blue: 0 } }, alpha: 1 } }, row.label);
      const gradientLosses = plan.losses.filter((loss) => loss.feature.endsWith("Gradient"));
      assert.deepEqual(gradientLosses.map((loss) => loss.feature), row.loss === null ? [] : [row.loss], row.label);
    }
  });

  test("slides with transitions report a transition loss each; one without does not", () => {
    const transition = { kind: "builtin" as const, effect: { effect: "fade" as const }, durationMilliseconds: 400, easing: "easeInOut" as const };
    const plan = planOf([slide({ id: "sl_trans0001", transition }), slide({ id: "sl_trans0002" }), slide({ id: "sl_trans0003", transition })]);
    assert.deepEqual(plan.losses.filter((loss) => loss.feature === "transition").map((loss) => loss.slideId), ["sl_trans0001", "sl_trans0003"]);
  });

  test("requests are grouped ONE BATCH PER SLIDE in slide order; a re-export deletes and recreates each page in its own batch", () => {
    const slides = [slide({ id: "sl_order0001" }), slide({ id: "sl_order0002" }), slide({ id: "sl_order0003" })];
    const plan = planOf(slides);
    assert.deepEqual(plan.batches.map((batch) => batch.slideId), ["sl_order0001", "sl_order0002", "sl_order0003"]);
    assert.deepEqual(plan.batches.map((batch) => batch.slideNumber), [1, 2, 3]);
    for (const batch of plan.batches) assert.equal(field(batch.requests[0], "createSlide")?.["objectId"], batch.slideId);
    const again = planExport({ snapshot: deckOf(slides), assetAddress, pageExists: (slideId) => slideId !== "sl_order0002", reuseInOneBatch: true });
    assert.deepEqual(again.batches.map((batch) => kinds(batch.requests)[0]), ["deleteObject", "createSlide", "deleteObject"], "only pages that exist are deleted first");
    const separate = planExport({ snapshot: deckOf(slides), assetAddress, pageExists: () => true, reuseInOneBatch: false });
    assert.deepEqual(separate.deletionBatches.map((batch) => batch.slideId), ["sl_order0001", "sl_order0002", "sl_order0003"], "were ids not reusable, deletions would go first");
  });
});

afterAllWrite();

const PLAIN: BoxStyle = { fill: { kind: "none" }, border: { kind: "none" }, cornerRadius: { kind: "uniform", radius: 0 }, shadow: null, opacity: 1 };
const TEXT_BOX = { verticalAlignment: "top" as const, paddingTop: 12, paddingRight: 12, paddingBottom: 12, paddingLeft: 12, autofit: "none" as const, wrap: true };
const FRAME = { x: 100, y: 120, width: 300, height: 160, rotation: 0, flipHorizontal: false, flipVertical: false };

const THEME: ThemeSnapshot = {
  name: "Test",
  colours: {
    dark1: "#000000", light1: "#ffffff", dark2: "#595959", light2: "#eeeeee", accent1: "#4338ca", accent2: "#0e7490",
    accent3: "#b45309", accent4: "#be185d", accent5: "#15803d", accent6: "#7c3aed", hyperlink: "#4338ca", followedHyperlink: "#6d28d9",
  },
  headingFontFamily: "Arial",
  bodyFontFamily: "Arial",
  background: { kind: "solid", colour: { kind: "theme", slot: "light1", alpha: 1 } },
  placeholderStyles: {
    title: { run: {}, paragraph: {}, textBox: {} }, centredTitle: { run: {}, paragraph: {}, textBox: {} }, subtitle: { run: {}, paragraph: {}, textBox: {} },
    body: { run: {}, paragraph: {}, textBox: {} }, slideNumber: { run: {}, paragraph: {}, textBox: {} }, footer: { run: {}, paragraph: {}, textBox: {} },
    date: { run: {}, paragraph: {}, textBox: {} }, picture: { run: {}, paragraph: {}, textBox: {} },
  },
  defaultRunStyle: {
    fontFamily: "Arial", fontSize: 24.889, fontWeight: 400, fontStyle: "normal", underline: false, strikethrough: false, colour: { kind: "theme", slot: "dark1", alpha: 1 },
    highlight: { kind: "none" }, link: { kind: "none" }, baselineOffset: "none", letterSpacing: 0, textCase: "none",
  },
};

const assetAddress = (assetId: AssetId): string => `https://sashaslides.example/deck-api/export-assets/TOKEN/${assetId}`;

function planOf(slides: readonly SlideSnapshot[]): ExportPlan {
  return planExport({ snapshot: deckOf(slides), assetAddress, pageExists: () => false, reuseInOneBatch: true });
}

function deckOf(slides: readonly SlideSnapshot[]): DocumentSnapshot {
  return {
    // A fixed test deck id of the `dk_` shape (ids.ts parseDeckId).
    deckId: "dk_exportTest0000000000" as DeckId,
    schemaVersion: 1,
    revision: 1,
    title: "Export test",
    pageSize: { width: 1280, height: 720 },
    theme: THEME,
    layouts: [],
    slides,
    assets: [{ id: "a".repeat(64) as AssetId, mediaType: "image/png", pixelWidth: 10, pixelHeight: 10, name: "a", byteLength: 100 }],
    transitionScripts: [],
  };
}

function slide(options: Readonly<{ id: string; background?: SlideSnapshot["background"]; skipped?: boolean; layoutId?: string; elements?: readonly ElementSnapshot[]; transition?: SlideSnapshot["transition"] }>): SlideSnapshot {
  return {
    // Test ids are written in the object-id shape (ids.ts); the brands record that.
    id: options.id as SlideId,
    layoutId: (options.layoutId ?? null) as SlideSnapshot["layoutId"],
    background: options.background ?? null,
    skipped: options.skipped ?? false,
    speakerNotes: { paragraphs: [{ style: {}, runs: [] }] },
    transition: options.transition ?? null,
    elements: options.elements ?? [],
  };
}

function common(options: Readonly<{ id: string }>) {
  return {
    // Test ids are written in the object-id shape (ids.ts); the brand records that.
    id: options.id as ElementId,
    name: "",
    description: "",
    frame: FRAME,
    groupId: null,
    morphKey: options.id,
    placeholder: null,
    unsupportedKeys: [],
  };
}

function shape(options: Readonly<{ id: string; preset: ShapePreset; box?: BoxStyle; text?: TextBody; frame?: ShapeElement["frame"] }>): ShapeElement {
  return { ...common(options), frame: options.frame ?? FRAME, kind: "shape", preset: options.preset, box: options.box ?? PLAIN, textBox: TEXT_BOX, text: options.text ?? { paragraphs: [{ style: {}, runs: [] }] } };
}

function textOf(text: string): TextBody {
  return { paragraphs: [{ style: {}, runs: [{ kind: "text", text, style: {} }] }] };
}

/** The converter's extraction of FRAME with the same decoration the engine box above carries. */
function converterRect(options: Readonly<{ box: "perSide" | "perCorner" }>) {
  const none = { widthPx: 0, hex: null, style: "none" };
  const border =
    options.box === "perSide"
      ? { widthPx: 4, hex: "#ff0000", style: "solid", uniform: false, sides: { top: { widthPx: 4, hex: "#ff0000", style: "solid" }, right: none, bottom: { widthPx: 2, hex: "#0000ff", style: "dashed" }, left: none } }
      : null;
  return {
    kind: "rect" as const,
    bounds: { x: FRAME.x, y: FRAME.y, w: FRAME.width, h: FRAME.height },
    domIndex: null,
    rotateDeg: 0,
    naturalSizePx: { w: FRAME.width, h: FRAME.height },
    opacity: 1,
    paintIndex: 0,
    stackZ: null,
    decoration: {
      fill: { hex: "#ffffff", alpha: 1 },
      gradient: null,
      border,
      cornerRadiiPx: (options.box === "perCorner" ? [16, 16, 0, 0] : [0, 0, 0, 0]) as readonly [number, number, number, number],
      shadow: null,
      backgroundImage: null,
      clipPath: null,
    },
  };
}

/** The per-element prefix the export chose, read back from the first created id ("<prefix>_rect1"). */
function compositionPrefixOf(requests: readonly ExportRequest[]): string {
  const objectId = field(requests[0], "createShape")?.["objectId"];
  return typeof objectId === "string" ? objectId.replace(/_rect1$/, "") : "";
}

function onlyBatch(plan: ExportPlan): readonly ExportRequest[] {
  return plan.batches[0]?.requests ?? [];
}

function kinds(requests: readonly ExportRequest[]): readonly string[] {
  return requests.map((request) => Object.keys(request)[0] ?? "");
}

function field(request: ExportRequest | undefined, key: string): Readonly<Record<string, unknown>> | undefined {
  if (request === undefined || !(key in request)) return undefined;
  const value: unknown = Object.getOwnPropertyDescriptor(request, key)?.value;
  // Every request is a single-key wrapper around a plain object (slides-requests.ts).
  return typeof value === "object" && value !== null ? (value as Readonly<Record<string, unknown>>) : undefined;
}

function matchesSnapshot(options: Readonly<{ name: string; value: unknown }>): void {
  const actual: unknown = JSON.parse(JSON.stringify(options.value));
  if (UPDATE || !(options.name in snapshots)) {
    snapshots[options.name] = actual;
    return;
  }
  assert.deepEqual(actual, snapshots[options.name], `snapshot "${options.name}" (UPDATE_SNAPSHOTS=1 rewrites it)`);
}

function afterAllWrite(): void {
  process.on("beforeExit", () => {
    if (!UPDATE && existsSync(SNAPSHOT_PATH)) return;
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(snapshots, null, 1)}\n`);
  });
}
