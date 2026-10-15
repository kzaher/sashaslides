/**
 * The IMPORT TABLE of SPEC.md 21.12, one test per row, against the RECORDED `presentations.get`
 * answer in fixtures/presentation.json (built and recorded from the development account by
 * e2e/google-slides-fixture.ts; slide numbers added in the Slides editor because the programming interface cannot
 * insert them). Each row states its expected engine values as explicit columns, and the rows are
 * parametric where the row claims a cause (rotation and flip; shape type; arrow style), with a
 * control row where the input is absent.
 *
 * Three inputs the programming interface cannot write are DERIVED from a recorded element by changing one field,
 * and say so: a rendered shadow, word art, and a speaker spotlight. The derivation keeps
 * everything else the recording had, so the row still exercises the real surrounding shape.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { InterchangeLoss } from "../engine/src/contracts/deck-api.ts";
import type { AssetRecord, ElementSnapshot, LineElement, Paragraph, ShapeElement, SlideSnapshot, TableElement } from "../engine/src/contracts/document.ts";
import { plainText } from "../engine/src/contracts/document.ts";
import type { AssetId } from "../engine/src/contracts/ids.ts";
import { importIntoDeck } from "./import-into-deck.ts";
import { imageAddressesIn, planImport, type ImportedImage, type ImportPlan } from "./import-presentation.ts";
import { frameForTransform, pageScaleFor, transformForFrame } from "./interchange-geometry.ts";
import { parsePresentation, type SlidesPresentation } from "./slides-presentation.ts";
import { createTestDeckService, testCaller } from "./testing-deck-service.ts";

const RECORDED: unknown = JSON.parse(readFileSync(new URL("./fixtures/presentation.json", import.meta.url), "utf-8"));
const UNITS_PER_POINT = 1280 / 720;
const SEED = { sessionPrefix: "Imp0rt00", counter: 0 } as const;
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452000000100000000808060000001f15c489", "hex");
const PNG_ASSET: AssetRecord = {
  // The SHA-256 of the bytes in hexadecimal: exactly ASSET_ID_PATTERN (ids.ts).
  id: createHash("sha256").update(PNG_BYTES).digest("hex") as AssetId,
  mediaType: "image/png",
  pixelWidth: 16,
  pixelHeight: 8,
  name: "Imported picture",
  byteLength: PNG_BYTES.byteLength,
};

describe("import mapping (SPEC.md 21.12 import table, recorded fixture)", () => {
  const plan = planOf({ raw: RECORDED, images: storedImages(parsed(RECORDED)) });

  test("pageSize -> meta.pageHeight: 16:9 is 720; a 4:3 control is 960 and reported", () => {
    const rows = [
      { label: "16:9 recorded", height: 5_143_500, pageHeight: 720, pageSizeLoss: false },
      { label: "4:3 control", height: 6_858_000, pageHeight: 960, pageSizeLoss: true },
    ];
    for (const row of rows) {
      const raw = withChange({ raw: RECORDED, change: (copy) => ((copy["pageSize"] as Writable)["height"] = { magnitude: row.height, unit: "EMU" }) });
      const rowPlan = planOf({ raw, images: new Map() });
      assert.equal(rowPlan.pageHeight, row.pageHeight, row.label);
      assert.equal(rowPlan.losses.some((loss) => loss.feature === "pageSize"), row.pageSizeLoss, row.label);
    }
  });

  test("transform + size -> one frame: rotation 0, 30, 210, flipped or not, centre preserved", () => {
    const presentation = parsed(RECORDED);
    const scale = pageScaleFor({ widthEnglishMetricUnits: 9_144_000, heightEnglishMetricUnits: 5_143_500 });
    // Columns: element, rotation (degrees, within Google's 4-decimal matrix rounding), mirrored, width and height in units.
    const rows = [
      { id: "rotation_0", rotation: 0, flipHorizontal: false, width: 120 * UNITS_PER_POINT, height: 50 * UNITS_PER_POINT },
      { id: "rotation_30", rotation: 30, flipHorizontal: false, width: 120 * UNITS_PER_POINT, height: 50 * UNITS_PER_POINT },
      { id: "rotation_210", rotation: 210, flipHorizontal: false, width: 120 * UNITS_PER_POINT, height: 50 * UNITS_PER_POINT },
      { id: "rotation_0_flipped", rotation: 0, flipHorizontal: true, width: 120 * UNITS_PER_POINT, height: 50 * UNITS_PER_POINT },
      { id: "rotation_30_flipped", rotation: 30, flipHorizontal: true, width: 120 * UNITS_PER_POINT, height: 50 * UNITS_PER_POINT },
      { id: "rotation_210_flipped", rotation: 210, flipHorizontal: true, width: 120 * UNITS_PER_POINT, height: 50 * UNITS_PER_POINT },
    ];
    for (const row of rows) {
      const frame = elementOf({ plan, slideId: "shapes_slide", elementId: row.id }).frame;
      const raw = presentation.slides.find((slide) => slide.objectId === "shapes_slide")?.elements.find((element) => element.objectId === row.id);
      assert.ok(raw !== undefined, row.id);
      // The centre Slides draws: the raw matrix applied to the box centre, computed here independently.
      const transform = raw.transform;
      const centreX = (transform.scaleX * raw.widthEnglishMetricUnits / 2 + transform.shearX * raw.heightEnglishMetricUnits / 2 + transform.translateX) / 7143.75;
      const centreY = (transform.shearY * raw.widthEnglishMetricUnits / 2 + transform.scaleY * raw.heightEnglishMetricUnits / 2 + transform.translateY) / 7143.75;
      assert.ok(Math.abs(frame.x + frame.width / 2 - centreX) < 0.01, `${row.id} centre x`);
      assert.ok(Math.abs(frame.y + frame.height / 2 - centreY) < 0.01, `${row.id} centre y`);
      assert.ok(Math.abs(frame.rotation - row.rotation) < 0.01, `${row.id} rotation ${frame.rotation}`);
      assert.equal(frame.flipHorizontal, row.flipHorizontal, `${row.id} flip`);
      assert.equal(frame.flipVertical, false, `${row.id} vertical flip`);
      assert.ok(Math.abs(frame.width - row.width) < 0.05 && Math.abs(frame.height - row.height) < 0.05, `${row.id} size ${frame.width} x ${frame.height}`);
    }
    // Exact matrices (no Google rounding): the frame and its inverse keep the centre to 0.01 units.
    for (const rotation of [0, 30, 210]) {
      for (const flipHorizontal of [false, true]) {
        const intended = { x: 300, y: 200, width: 213.3, height: 88.9, rotation, flipHorizontal, flipVertical: false };
        const placed = transformForFrame({ frame: intended, scale });
        const frame = frameForTransform({ transform: placed.transform, widthEnglishMetricUnits: placed.widthEnglishMetricUnits, heightEnglishMetricUnits: placed.heightEnglishMetricUnits, scale, minimumSize: 1 });
        assert.ok(Math.abs(frame.x - intended.x) < 0.01 && Math.abs(frame.y - intended.y) < 0.01, `exact ${rotation} ${flipHorizontal} centre`);
        assert.ok(Math.abs(frame.rotation - rotation) < 1e-6 && frame.flipHorizontal === flipHorizontal, `exact ${rotation} ${flipHorizontal} rotation`);
      }
    }
  });

  test("shape.shapeType -> the preset of the same name; an unknown type -> rectangle plus a loss naming it", () => {
    const rows: readonly Readonly<{ shapeType: string; preset: string; loss: boolean }>[] = [
      { shapeType: "TEXT_BOX", preset: "textBox", loss: false },
      { shapeType: "RECTANGLE", preset: "rectangle", loss: false },
      { shapeType: "ROUND_RECTANGLE", preset: "roundedRectangle", loss: false },
      { shapeType: "ELLIPSE", preset: "ellipse", loss: false },
      { shapeType: "TRIANGLE", preset: "triangle", loss: false },
      { shapeType: "RIGHT_TRIANGLE", preset: "rightTriangle", loss: false },
      { shapeType: "DIAMOND", preset: "diamond", loss: false },
      { shapeType: "PARALLELOGRAM", preset: "parallelogram", loss: false },
      { shapeType: "TRAPEZOID", preset: "trapezoid", loss: false },
      { shapeType: "PENTAGON", preset: "pentagon", loss: false },
      { shapeType: "HEXAGON", preset: "hexagon", loss: false },
      { shapeType: "OCTAGON", preset: "octagon", loss: false },
      { shapeType: "STAR_5", preset: "fivePointStar", loss: false },
      { shapeType: "PLUS", preset: "plus", loss: false },
      { shapeType: "HEART", preset: "heart", loss: false },
      { shapeType: "CLOUD", preset: "cloud", loss: false },
      { shapeType: "WEDGE_RECTANGLE_CALLOUT", preset: "speechBubble", loss: false },
      { shapeType: "WEDGE_ROUND_RECTANGLE_CALLOUT", preset: "speechBubble", loss: false },
      { shapeType: "CHEVRON", preset: "chevron", loss: false },
      { shapeType: "RIGHT_ARROW", preset: "rightArrow", loss: false },
      { shapeType: "LEFT_ARROW", preset: "leftArrow", loss: false },
      { shapeType: "UP_ARROW", preset: "upArrow", loss: false },
      { shapeType: "DOWN_ARROW", preset: "downArrow", loss: false },
      { shapeType: "MOON", preset: "rectangle", loss: true },
      { shapeType: "CAN", preset: "rectangle", loss: true },
    ];
    for (const row of rows) {
      const elementId = `shape_${row.shapeType.toLowerCase()}`;
      const shape = shapeOf({ plan, slideId: "shapes_slide", elementId });
      assert.equal(shape.preset, row.preset, row.shapeType);
      const loss = lossesFor({ plan, elementId }).find((candidate) => candidate.feature === "shapePreset");
      assert.equal(loss !== undefined, row.loss, `${row.shapeType} loss`);
      if (row.loss) assert.match(loss?.detail ?? "", new RegExp(row.shapeType));
    }
  });

  test("shapeBackgroundFill: solid (literal and theme), NOT_RENDERED, INHERIT through the placeholder chain", () => {
    const rows = [
      { elementId: "shape_rectangle", slideId: "shapes_slide", fill: { kind: "solid", colour: { kind: "literal", hexadecimal: "#3366cc", alpha: 0.5 } } },
      { elementId: "shape_ellipse", slideId: "shapes_slide", fill: { kind: "solid", colour: { kind: "theme", slot: "accent1", alpha: 1 } } },
      { elementId: "shape_triangle", slideId: "shapes_slide", fill: { kind: "none" } },
      // INHERIT on the slide's title -> the layout's INHERIT -> the master's NOT_RENDERED.
      { elementId: "agenda_title", slideId: "g1a2b3c4d5_0_1", fill: { kind: "none" } },
    ];
    for (const row of rows) assert.deepEqual(shapeOf({ plan, slideId: row.slideId, elementId: row.elementId }).box.fill, row.fill, row.elementId);
  });

  test("outline: weight, dash and colour -> a uniform border; NOT_RENDERED -> none", () => {
    // Columns: border kind, width in units, colour, dash (null where there is no border).
    const rows = [
      { elementId: "shape_rectangle", kind: "uniform", width: 3 * UNITS_PER_POINT, colour: { kind: "literal", hexadecimal: "#e51a1a", alpha: 1 }, dash: "dash" },
      { elementId: "shape_ellipse", kind: "none", width: null, colour: null, dash: null },
    ];
    for (const row of rows) {
      const border = shapeOf({ plan, slideId: "shapes_slide", elementId: row.elementId }).box.border;
      assert.equal(border.kind, row.kind, row.elementId);
      if (border.kind !== "uniform") continue;
      assert.ok(Math.abs(border.stroke.width - (row.width ?? 0)) < 0.001, `${row.elementId} width ${border.stroke.width}`);
      assert.deepEqual({ colour: border.stroke.colour, dash: border.stroke.dash }, { colour: row.colour, dash: row.dash }, row.elementId);
    }
  });

  test("shadow (derived: the API cannot write one): offset and blur kept; a non bottom-right anchor is reported", () => {
    const rows = [
      { label: "no shadow (recorded)", alignment: null, shadow: null, loss: false },
      { label: "bottom-right", alignment: "BOTTOM_RIGHT", shadow: { offsetX: 4 * UNITS_PER_POINT, offsetY: 3 * UNITS_PER_POINT, blur: 6 * UNITS_PER_POINT, spread: 0, colour: { kind: "literal", hexadecimal: "#000000", alpha: 0.4 } }, loss: false },
      { label: "top-left", alignment: "TOP_LEFT", shadow: { offsetX: 4 * UNITS_PER_POINT, offsetY: 3 * UNITS_PER_POINT, blur: 6 * UNITS_PER_POINT, spread: 0, colour: { kind: "literal", hexadecimal: "#000000", alpha: 0.4 } }, loss: true },
    ];
    for (const row of rows) {
      const raw =
        row.alignment === null
          ? RECORDED
          : withChange({
              raw: RECORDED,
              change: (copy) => {
                const properties = rawShape({ copy, slideId: "shapes_slide", elementId: "shape_diamond" })["shapeProperties"] as Writable;
                properties["shadow"] = {
                  type: "OUTER",
                  transform: { scaleX: 1, scaleY: 1, translateX: 4 * 12_700, translateY: 3 * 12_700, unit: "EMU" },
                  alignment: row.alignment,
                  blurRadius: { magnitude: 6, unit: "PT" },
                  color: { rgbColor: {} },
                  alpha: 0.4,
                  propertyState: "RENDERED",
                };
              },
            });
      const rowPlan = planOf({ raw, images: new Map() });
      const shadow = shapeOf({ plan: rowPlan, slideId: "shapes_slide", elementId: "shape_diamond" }).box.shadow;
      if (row.shadow === null) assert.equal(shadow, null, row.label);
      else {
        assert.ok(shadow !== null, row.label);
        assert.ok(Math.abs(shadow.offsetX - row.shadow.offsetX) < 0.001 && Math.abs(shadow.offsetY - row.shadow.offsetY) < 0.001 && Math.abs(shadow.blur - row.shadow.blur) < 0.001, row.label);
        assert.deepEqual(shadow.colour, row.shadow.colour, row.label);
      }
      assert.equal(lossesFor({ plan: rowPlan, elementId: "shape_diamond" }).some((loss) => loss.feature === "shadow"), row.loss, row.label);
    }
  });

  test("contentAlignment and autofit -> verticalAlignment and autofit, inherited through the chain", () => {
    const rows = [
      { slideId: "shapes_slide", elementId: "shape_rectangle", verticalAlignment: "middle", autofit: "none" },
      { slideId: "shapes_slide", elementId: "shape_ellipse", verticalAlignment: "bottom", autofit: "none" },
      // An programming interface-made text box records autofitType NONE, and NONE is kept.
      { slideId: "shapes_slide", elementId: "shape_text_box", verticalAlignment: "top", autofit: "none" },
      { slideId: "g1a2b3c4d5_0_1", elementId: "agenda_title", verticalAlignment: "top", autofit: "none" },
    ];
    for (const row of rows) {
      const textBox = shapeOf({ plan, slideId: row.slideId, elementId: row.elementId }).textBox;
      assert.deepEqual({ verticalAlignment: textBox.verticalAlignment, autofit: textBox.autofit }, { verticalAlignment: row.verticalAlignment, autofit: row.autofit }, row.elementId);
      assert.equal(textBox.paddingLeft, 12, `${row.elementId}: Slides' 9 pixel inset is 12 units`);
    }
    // The layout's title says nothing and inherits the master's TEXT_AUTOFIT through the chain.
    const layoutTitle = plan.layouts.find((layout) => layout.name === "Title and body")?.elements[0];
    assert.equal(layoutTitle?.kind === "shape" ? layoutTitle.textBox.autofit : null, "shrinkText");
    // Derived: a text box that does not say (an older presentation) grows with its text (SPEC.md 15).
    const unsaid = withChange({ raw: RECORDED, change: (copy) => delete (rawShape({ copy, slideId: "shapes_slide", elementId: "shape_text_box" })["shapeProperties"] as Writable)["autofit"] });
    assert.equal(shapeOf({ plan: planOf({ raw: unsaid, images: new Map() }), slideId: "shapes_slide", elementId: "shape_text_box" }).textBox.autofit, "resizeShape");
  });

  test("text runs: family, size, weight, italic, underline, colours, links, baseline, small capitals, resolved through the placeholder chain", () => {
    const body = shapeOf({ plan, slideId: "g1a2b3c4d5_0_1", elementId: "agenda_body" }).text;
    const runByText = (text: string) => body.paragraphs.flatMap((paragraph) => paragraph.runs).find((run) => run.kind === "text" && run.text === text);
    const titleSlideId = plan.slides[0]?.id;
    // Columns: the run's text -> the style fields it must carry (inherited ones resolved: Arial, dark2).
    const rows = [
      { text: "Plan the ", style: { fontFamily: "Arial", fontSize: 32, fontWeight: 400, fontStyle: "normal", colour: { kind: "theme", slot: "dark2", alpha: 1 } } },
      { text: "launch", style: { fontWeight: 700, underline: true, colour: { kind: "theme", slot: "hyperlink", alpha: 1 }, link: { kind: "webAddress", address: "https://sashaslides.com" } } },
      { text: "Budget", style: { fontStyle: "italic", fontSize: 24.889, colour: { kind: "theme", slot: "accent2", alpha: 1 } } },
      { text: "Timeline", style: { underline: true, highlight: { kind: "literal", hexadecimal: "#ffe533", alpha: 1 } } },
      { text: "Ship", style: { textCase: "smallCaps" } },
      { text: "it", style: { baselineOffset: "superscript" } },
      { text: "title slide", style: { link: { kind: "slide", slideId: titleSlideId } } },
    ];
    for (const row of rows) {
      const run = runByText(row.text);
      assert.ok(run !== undefined, row.text);
      for (const [key, value] of Object.entries(row.style)) assert.deepEqual(Object.getOwnPropertyDescriptor(run.style, key)?.value, value, `${row.text}.${key}`);
    }
    const numbered = shapeOf({ plan, slideId: "g1a2b3c4d5_0_1", elementId: "numbered_box" }).text;
    const first = numbered.paragraphs[0]?.runs[0];
    assert.deepEqual(first?.style.fontFamily, "Roboto");
    assert.deepEqual(first?.style.fontWeight, 300);
    assert.deepEqual(first?.style.fontSize, 35.556);
    const nextSlide = numbered.paragraphs[3]?.runs.find((run) => run.kind === "text" && run.text === "Next slide");
    assert.deepEqual(nextSlide?.style.link, { kind: "slide", slideId: "shapes_slide" }, "relative NEXT_SLIDE resolves to the following slide");
  });

  test("paragraph: alignment, line spacing, space above and below, indents, direction", () => {
    const numbered = shapeOf({ plan, slideId: "g1a2b3c4d5_0_1", elementId: "numbered_box" }).text.paragraphs[0]?.style;
    assert.deepEqual(numbered, {
      alignment: "centre",
      lineSpacing: 1.5,
      spaceAbove: 10.667,
      spaceBelow: 7.111,
      indentStart: 64,
      indentFirstLine: -32,
      direction: "leftToRight",
      list: numbered?.list,
    });
    const agenda = shapeOf({ plan, slideId: "g1a2b3c4d5_0_1", elementId: "agenda_body" }).text.paragraphs[0]?.style;
    assert.equal(agenda?.spaceBelow, 21.333, "12 point space below inherited from the master's body");
    assert.equal(agenda?.lineSpacing, 1.15, "115 percent inherited");
  });

  test("bullet -> list membership: same list id, level, nearest of the 12 glyphs; a blank title glyph is no list", () => {
    const agenda = shapeOf({ plan, slideId: "g1a2b3c4d5_0_1", elementId: "agenda_body" }).text.paragraphs;
    const lists = agenda.map(listOf);
    assert.deepEqual(lists.map((list) => list?.glyph ?? null), ["disc", "circle", "circle", "disc", "disc"]);
    assert.deepEqual(lists.map((list) => list?.level ?? null), [0, 1, 1, 0, 0]);
    assert.equal(new Set(lists.map((list) => list?.listId)).size, 1, "one list");
    const numbered = shapeOf({ plan, slideId: "g1a2b3c4d5_0_1", elementId: "numbered_box" }).text.paragraphs.map(listOf);
    assert.deepEqual(numbered.map((list) => list?.glyph ?? null), ["decimal", "decimal", "decimal", null]);
    const title = shapeOf({ plan, slideId: "g1a2b3c4d5_0_1", elementId: "agenda_title" }).text.paragraphs[0]?.style.list;
    assert.deepEqual(title, { kind: "none" });
  });

  test("autoText SLIDE_NUMBER -> automaticText slideNumber with its resolved style", () => {
    const number = shapeOf({ plan, slideId: "g1a2b3c4d5_0_1", elementId: "h168a82384be34580_3_1" });
    assert.deepEqual(number.placeholder, { role: "slideNumber", index: 0 });
    const run = number.text.paragraphs[0]?.runs[0];
    assert.equal(run?.kind, "automaticText");
    assert.equal(run?.kind === "automaticText" ? run.field : null, "slideNumber");
    assert.equal(run?.style.fontSize, 17.778, "10 point from the master");
  });

  test("image: fetched through a fake fetch, stored and registered; a failed fetch -> placeholder plus loss", async () => {
    const rows = [
      { label: "fetched", answer: () => new Response(PNG_BYTES, { status: 200 }), kind: "image", loss: false },
      { label: "fetch fails", answer: () => new Response("gone", { status: 403 }), kind: "shape", loss: true },
    ];
    for (const row of rows) {
      const service = await createTestDeckService();
      const caller = testCaller("importer");
      const created = await service.createDeck({ caller, title: "" });
      assert.equal(created.kind, "opened");
      if (created.kind !== "opened") continue;
      const fakeFetch: typeof fetch = async () => row.answer();
      const outcome = await importIntoDeck({ presentationAnswer: RECORDED, deck: created.deck, author: { kind: "person", personId: caller.person.id }, fetch: fakeFetch, accessToken: null, idSeed: SEED, now: () => 1 });
      assert.equal(outcome.kind, "imported", row.label);
      const snapshot = created.deck.snapshot();
      const logo = snapshot.slides.find((slide) => slide.id === "media_slide")?.elements.find((element) => element.id === "logo_image");
      assert.equal(logo?.kind, row.kind, row.label);
      if (logo?.kind === "image") {
        assert.equal(logo.assetId, PNG_ASSET.id);
        assert.deepEqual(snapshot.assets.find((asset) => asset.id === PNG_ASSET.id)?.pixelWidth, 16, "pixel size read from the PNG header");
        assert.equal(logo.box.border.kind, "uniform", "the picture's outline");
      }
      if (logo?.kind === "shape") assert.equal(logo.name, "Image could not be imported");
      const losses = outcome.kind === "imported" ? outcome.report.losses : [];
      assert.equal(losses.some((loss) => loss.elementId === "logo_image" && loss.feature === "image"), row.loss, row.label);
    }
  });

  test("line: category, end points from the box diagonal and flips, weight, dash, each arrow nearest of 7", () => {
    // Columns: routing, start and end arrows, dash, whether an arrow was approximated, and the end
    // points in points as the builder placed them (the flipped line runs top-right to bottom-left).
    const rows = [
      { id: "line_straight", routing: "straight", startArrow: "triangle", endArrow: "openArrow", dash: "solid", approximated: false, start: [40, 150], end: [100, 270] },
      { id: "line_bent", routing: "elbow", startArrow: "stealth", endArrow: "diamond", dash: "dash", approximated: false, start: [120, 150], end: [180, 270] },
      { id: "line_curved", routing: "curved", startArrow: "oval", endArrow: "bar", dash: "dot", approximated: true, start: [200, 150], end: [260, 270] },
      { id: "line_flipped", routing: "straight", startArrow: "oval", endArrow: "diamond", dash: "dashDot", approximated: true, start: [340, 150], end: [280, 270] },
      { id: "line_plain", routing: "straight", startArrow: "none", endArrow: "bar", dash: "longDash", approximated: true, start: [360, 150], end: [420, 270] },
    ];
    for (const row of rows) {
      const line = elementOf({ plan, slideId: "media_slide", elementId: row.id });
      assert.equal(line.kind, "line", row.id);
      if (line.kind !== "line") continue;
      assert.deepEqual({ routing: line.routing, startArrow: line.startArrow, endArrow: line.endArrow, dash: line.stroke.dash }, { routing: row.routing, startArrow: row.startArrow, endArrow: row.endArrow, dash: row.dash }, row.id);
      assertPoint({ actual: line.start, points: row.start, label: `${row.id} start` });
      assertPoint({ actual: line.end, points: row.end, label: `${row.id} end` });
      assert.equal(lossesFor({ plan, elementId: row.id }).some((loss) => loss.feature === "arrowHead"), row.approximated, row.id);
    }
  });

  test("table: rows and columns, a 2 by 2 span, cell fill and alignment, per-side borders", () => {
    const found = elementOf({ plan, slideId: "table_slide", elementId: "budget_table" });
    assert.equal(found.kind, "table");
    if (found.kind !== "table") return;
    const table: TableElement = found;
    assert.equal(table.rows.length, 3);
    assert.equal(table.columns.length, 3);
    assert.ok(Math.abs((table.columns[2]?.width ?? 0) - 100 * UNITS_PER_POINT) < 0.01, "column 3 is 100 points");
    const at = (row: number, column: number) => table.cells.find((cell) => cell.rowId === table.rows[row]?.id && cell.columnId === table.columns[column]?.id);
    const merged = at(0, 0);
    assert.deepEqual({ rowSpan: merged?.rowSpan, columnSpan: merged?.columnSpan }, { rowSpan: 2, columnSpan: 2 });
    assert.equal(at(0, 1), undefined, "a covered cell is absent");
    assert.equal(at(1, 1), undefined, "a covered cell is absent");
    // Columns: side -> colour and width (points) of the merged cell's border.
    const sides = [
      { side: "top", colour: "#e51a1a", points: 3, dash: "solid" },
      { side: "left", colour: "#1a33e5", points: 2, dash: "dash" },
      { side: "bottom", colour: "#1a9933", points: 1, dash: "solid" },
    ] as const;
    for (const row of sides) {
      const stroke = merged?.borders[row.side];
      assert.ok(stroke !== null && stroke !== undefined, row.side);
      assert.deepEqual(stroke.colour, { kind: "literal", hexadecimal: row.colour, alpha: 1 }, row.side);
      assert.ok(Math.abs(stroke.width - row.points * UNITS_PER_POINT) < 0.01, `${row.side} width`);
      assert.equal(stroke.dash, row.dash, row.side);
    }
    const total = at(2, 2);
    assert.deepEqual(total?.fill, { kind: "solid", colour: { kind: "literal", hexadecimal: "#fff2cc", alpha: 1 } });
    assert.equal(total?.textBox.verticalAlignment, "middle");
    assert.equal(plainOf(merged?.text.paragraphs ?? []), "Merged two by two");
  });

  test("elementGroup -> a group with its own rotation and its children at absolute frames", () => {
    const group = elementOf({ plan, slideId: "group_slide", elementId: "rotated_group" });
    assert.equal(group.kind, "group");
    if (group.kind !== "group") return;
    assert.ok(Math.abs(group.frame.rotation - 30) < 0.01, `group rotation ${group.frame.rotation}`);
    // Google keeps four decimals of the matrix, so the angles come back within a hundredth of a degree.
    const rotations = group.children.map((child) => Math.round(child.frame.rotation));
    assert.deepEqual(rotations, [30, 45], "the rectangle turned with the group; the 15 degree ellipse is now 45");
    assert.deepEqual(group.children.map((child) => child.groupId), [group.id, group.id]);
  });

  test("sheetsChart -> image plus linkedChart; video -> named rectangle plus video; wordArt (derived) -> text box plus wordArt; speakerSpotlight (derived) -> omitted", () => {
    const chart = elementOf({ plan, slideId: "media_slide", elementId: "revenue_chart" });
    assert.equal(chart.kind, "image");
    assert.ok(lossesFor({ plan, elementId: "revenue_chart" }).some((loss) => loss.feature === "linkedChart"));
    const video = shapeOf({ plan, slideId: "media_slide", elementId: "talk_video" });
    assert.match(video.name, /^Video: .*dQw4w9WgXcQ/);
    assert.ok(lossesFor({ plan, elementId: "talk_video" }).some((loss) => loss.feature === "video"));

    const derived = withChange({
      raw: RECORDED,
      change: (copy) => {
        const element = rawElement({ copy, slideId: "shapes_slide", elementId: "shape_heart" });
        delete element["shape"];
        element["wordArt"] = { renderedText: "Launch" };
        const spotlight = rawElement({ copy, slideId: "shapes_slide", elementId: "shape_plus" });
        delete spotlight["shape"];
        spotlight["speakerSpotlight"] = { shapeProperties: {} };
      },
    });
    const derivedPlan = planOf({ raw: derived, images: new Map() });
    const wordArt = shapeOf({ plan: derivedPlan, slideId: "shapes_slide", elementId: "shape_heart" });
    assert.equal(wordArt.preset, "textBox");
    assert.equal(plainOf(wordArt.text.paragraphs), "Launch");
    assert.ok(lossesFor({ plan: derivedPlan, elementId: "shape_heart" }).some((loss) => loss.feature === "wordArt"));
    assert.equal(derivedPlan.slides.find((slide) => slide.id === "shapes_slide")?.elements.some((element) => element.id === "shape_plus"), false);
    assert.ok(lossesFor({ plan: derivedPlan, elementId: "shape_plus" }).some((loss) => loss.feature === "speakerSpotlight"));
  });

  test("placeholders: the eight roles kept; another type (derived) -> body plus a loss", () => {
    assert.deepEqual(shapeOf({ plan, slideId: "g1a2b3c4d5_0_1", elementId: "agenda_title" }).placeholder, { role: "title", index: 0 });
    assert.deepEqual(shapeOf({ plan, slideId: "g1a2b3c4d5_0_1", elementId: "agenda_body" }).placeholder, { role: "body", index: 0 });
    assert.deepEqual(plan.slides[0]?.elements.map((element) => element.placeholder?.role ?? null), ["centredTitle", "subtitle", "slideNumber"]);
    const derived = withChange({ raw: RECORDED, change: (copy) => (((rawShape({ copy, slideId: "g1a2b3c4d5_0_1", elementId: "agenda_body" })["placeholder"]) as Writable)["type"] = "OBJECT") });
    const derivedPlan = planOf({ raw: derived, images: new Map() });
    assert.deepEqual(shapeOf({ plan: derivedPlan, slideId: "g1a2b3c4d5_0_1", elementId: "agenda_body" }).placeholder, { role: "body", index: 0 });
    assert.ok(lossesFor({ plan: derivedPlan, elementId: "agenda_body" }).some((loss) => loss.feature === "placeholderType"));
  });

  test("theme from the first master: 12 slots from its colorScheme, heading and body families, placeholder styles; a second master is reported", () => {
    assert.deepEqual(plan.theme.colours, {
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
    });
    assert.equal(plan.theme.headingFontFamily, "Arial");
    assert.equal(plan.theme.bodyFontFamily, "Arial");
    assert.equal(plan.theme.name, "Simple Light");
    assert.equal(plan.theme.placeholderStyles.title.run.fontSize, 49.778, "28 point title");
    assert.equal(plan.theme.placeholderStyles.body.run.fontSize, 32, "18 point body");
    assert.equal(plan.theme.placeholderStyles.centredTitle.run.fontSize, 92.444, "52 point centred title from the title layout");
    assert.deepEqual(plan.theme.background, { kind: "solid", colour: { kind: "theme", slot: "light1", alpha: 1 } });
    assert.equal(plan.losses.some((loss) => loss.feature === "masters"), false, "one master: no loss (control)");
    const twoMasters = withChange({ raw: RECORDED, change: (copy) => (copy["masters"] as unknown[]).push(JSON.parse(JSON.stringify((copy["masters"] as unknown[])[0]))) });
    assert.ok(planOf({ raw: twoMasters, images: new Map() }).losses.some((loss) => loss.feature === "masters"));
  });

  test("layouts: each with its display name and placeholders; slides keep their layout", () => {
    assert.equal(plan.layouts.length, 11);
    const titleAndBody = plan.layouts.find((layout) => layout.name === "Title and body");
    assert.ok(titleAndBody !== undefined);
    assert.deepEqual(titleAndBody.elements.map((element) => element.placeholder?.role ?? null), ["title", "body", "slideNumber"]);
    assert.ok(titleAndBody.id.startsWith("ly_"), "the short id p4 is minted");
    assert.equal(plan.slides[1]?.layoutId, titleAndBody.id);
  });

  test("page background: solid, stretched picture, inherited", () => {
    const backgroundOf = (slideId: string) => plan.slides.find((slide) => slide.id === slideId)?.background;
    assert.deepEqual(backgroundOf("skipped_slide"), { kind: "solid", colour: { kind: "literal", hexadecimal: "#1a664d", alpha: 1 } });
    assert.deepEqual(backgroundOf("picture_background"), { kind: "image", assetId: PNG_ASSET.id, fit: "stretch", opacity: 1 });
    assert.equal(backgroundOf("shapes_slide"), null, "inherited: the theme background");
  });

  test("notes page body -> speakerNotes", () => {
    assert.equal(plainOf(plan.slides[0]?.speakerNotes.paragraphs ?? []), "Welcome everyone.");
    assert.equal(plainOf(plan.slides[1]?.speakerNotes.paragraphs ?? []), "Say the budget first.\nThen the timeline.");
    assert.equal(plainOf(plan.slides[2]?.speakerNotes.paragraphs ?? []), "", "no notes (control)");
  });

  test("slideProperties.isSkipped -> skipped", () => {
    assert.deepEqual(plan.slides.map((slide) => slide.skipped), [false, false, false, false, false, false, true, false]);
  });

  test("object ids: kept when valid and unique, minted otherwise ('p' is minted, 'g1a2b3c4d5_0_1' kept)", () => {
    assert.match(plan.slides[0]?.id ?? "", /^sl_Imp0rt00/);
    assert.equal(plan.slides[1]?.id, "g1a2b3c4d5_0_1");
    assert.match(plan.slides[0]?.elements[0]?.id ?? "", /^el_Imp0rt00/, "'i0' is too short to be an object id");
    assert.equal(plan.slides[1]?.elements[0]?.id, "agenda_title");
    const again = planOf({ raw: RECORDED, images: storedImages(parsed(RECORDED)) });
    assert.equal(again.slides[0]?.id, plan.slides[0]?.id, "minting is deterministic");
  });

  test("transitions and animations: one transition loss per deck", () => {
    assert.equal(plan.losses.filter((loss) => loss.feature === "transition").length, 1);
  });

  test("the whole plan is ONE envelope the real model accepts", async () => {
    const service = await createTestDeckService();
    const caller = testCaller("importer");
    const created = await service.createDeck({ caller, title: "" });
    assert.equal(created.kind, "opened");
    if (created.kind !== "opened") return;
    const fakeFetch: typeof fetch = async () => new Response(PNG_BYTES, { status: 200 });
    const outcome = await importIntoDeck({ presentationAnswer: RECORDED, deck: created.deck, author: { kind: "person", personId: caller.person.id }, fetch: fakeFetch, accessToken: null, idSeed: SEED, now: () => 1 });
    assert.equal(outcome.kind, "imported");
    assert.equal(service.decks.get(created.deck.deckId)?.applied.length, 1, "one envelope");
    assert.equal(created.deck.snapshot().slides.length, 8);
    assert.equal(outcome.kind === "imported" ? outcome.report.slideCount : 0, 8);
    assert.equal(outcome.kind === "imported" ? outcome.link.importedRevisionId : null, parsed(RECORDED).revisionId);
  });
});

/**
 * A deep copy of the recorded JSON, edited in place by a derived row. The casts below read it at
 * paths the recording is known to have (the fixture is checked in; a missing path throws).
 */
type Writable = Record<string, unknown>;

function parsed(raw: unknown): SlidesPresentation {
  const result = parsePresentation(raw);
  if (result.kind !== "ok") throw new Error(result.message);
  return result.presentation;
}

function planOf(options: Readonly<{ raw: unknown; images: ReadonlyMap<string, ImportedImage> }>): ImportPlan {
  return planImport({ presentation: parsed(options.raw), images: options.images, idSeed: SEED });
}

function storedImages(presentation: SlidesPresentation): ReadonlyMap<string, ImportedImage> {
  return new Map(imageAddressesIn(presentation).map((address) => [address, { kind: "stored", asset: PNG_ASSET }]));
}

function withChange(options: Readonly<{ raw: unknown; change: (copy: Writable) => void }>): unknown {
  // The recorded presentation is a JSON object (parsePresentation accepted it).
  const copy = JSON.parse(JSON.stringify(options.raw)) as Writable;
  options.change(copy);
  return copy;
}

function rawElement(options: Readonly<{ copy: Writable; slideId: string; elementId: string }>): Writable {
  const slides = options.copy["slides"] as Writable[];
  const slide = slides.find((candidate) => candidate["objectId"] === options.slideId);
  const element = (slide?.["pageElements"] as Writable[] | undefined)?.find((candidate) => candidate["objectId"] === options.elementId);
  if (element === undefined) throw new Error(`no ${options.elementId}`);
  return element;
}

function rawShape(options: Readonly<{ copy: Writable; slideId: string; elementId: string }>): Writable {
  return rawElement(options)["shape"] as Writable;
}

function elementOf(options: Readonly<{ plan: ImportPlan; slideId: string; elementId: string }>): ElementSnapshot {
  const slide: SlideSnapshot | undefined = options.plan.slides.find((candidate) => candidate.id === options.slideId);
  const found = findElement({ elements: slide?.elements ?? [], elementId: options.elementId });
  if (found === null) throw new Error(`no ${options.elementId} on ${options.slideId}`);
  return found;
}

function findElement(options: Readonly<{ elements: readonly ElementSnapshot[]; elementId: string }>): ElementSnapshot | null {
  for (const element of options.elements) {
    if (element.id === options.elementId) return element;
    if (element.kind === "group") {
      const inside = findElement({ elements: element.children, elementId: options.elementId });
      if (inside !== null) return inside;
    }
  }
  return null;
}

function shapeOf(options: Readonly<{ plan: ImportPlan; slideId: string; elementId: string }>): ShapeElement {
  const element = elementOf(options);
  if (element.kind !== "shape") throw new Error(`${options.elementId} is a ${element.kind}`);
  return element;
}

function lossesFor(options: Readonly<{ plan: ImportPlan; elementId: string }>): readonly InterchangeLoss[] {
  return options.plan.losses.filter((loss) => loss.elementId === options.elementId);
}

function listOf(paragraph: Paragraph) {
  return paragraph.style.list?.kind === "list" ? paragraph.style.list : null;
}

function plainOf(paragraphs: readonly Paragraph[]): string {
  return plainText({ body: { paragraphs }, slideNumber: null });
}

function assertPoint(options: Readonly<{ actual: LineElement["start"]; points: readonly number[]; label: string }>): void {
  const [x, y] = options.points;
  assert.ok(Math.abs(options.actual.x - (x ?? 0) * UNITS_PER_POINT) < 0.05 && Math.abs(options.actual.y - (y ?? 0) * UNITS_PER_POINT) < 0.05, `${options.label}: ${JSON.stringify(options.actual)}`);
}

