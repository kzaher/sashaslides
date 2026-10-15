#!/usr/bin/env npx tsx
/**
 * Builds the IMPORT FIXTURE presentation in the development account and records its
 * `presentations.get` into google-slides/fixtures/, once. The import mapping tests then run
 * against what Google really answers, not against our reading of the reference.
 *
 * Everything the Slides programming interface can write is written here (every listed shape type and an unknown
 * one, rotations 0, 30 and 210 with and without a flip, runs, links, lists, a numbered text box,
 * images, lines with each arrow, a table with a 2 by 2 span and per-side borders, a rotated group,
 * a video, a linked Sheets chart, backgrounds, notes, a skipped slide). What the programming interface cannot write
 * (a slide number field, word art, a shadow) is added by hand in the Slides editor or derived in
 * the test from a recorded element, and the test says so where it does.
 *
 * Signed image addresses (`contentUrl`) are replaced by stable fake ones before the file is
 * written: the real ones expire after 30 minutes and carry an account-specific signature.
 *
 *   npx tsx mcp/sasha-slides/e2e/google-slides-fixture.ts build      # makes the presentation, prints its id
 *   npx tsx mcp/sasha-slides/e2e/google-slides-fixture.ts record <id> # writes fixtures/presentation.json
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSlidesClient } from "../google-slides/slides-client.ts";
import type { SlidesClient } from "../google-slides/slides-client.ts";
import { developmentGrant } from "./google-slides-development-grant.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "..", "google-slides", "fixtures", "presentation.json");
const PUBLIC_IMAGE = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";

/** Every shape type the import table lists, plus two it does not (MOON and CAN -> rectangle + loss). */
export const FIXTURE_SHAPE_TYPES: readonly string[] = [
  "TEXT_BOX", "RECTANGLE", "ROUND_RECTANGLE", "ELLIPSE", "TRIANGLE", "RIGHT_TRIANGLE", "DIAMOND",
  "PARALLELOGRAM", "TRAPEZOID", "PENTAGON", "HEXAGON", "OCTAGON", "STAR_5", "PLUS", "HEART", "CLOUD",
  "WEDGE_RECTANGLE_CALLOUT", "WEDGE_ROUND_RECTANGLE_CALLOUT", "CHEVRON", "RIGHT_ARROW", "LEFT_ARROW",
  "UP_ARROW", "DOWN_ARROW", "MOON", "CAN",
];

/** The six rotated boxes: rotation by flip. */
export const FIXTURE_ROTATIONS: readonly Readonly<{ objectId: string; rotation: number; flipped: boolean }>[] = [
  { objectId: "rotation_0", rotation: 0, flipped: false },
  { objectId: "rotation_30", rotation: 30, flipped: false },
  { objectId: "rotation_210", rotation: 210, flipped: false },
  { objectId: "rotation_0_flipped", rotation: 0, flipped: true },
  { objectId: "rotation_30_flipped", rotation: 30, flipped: true },
  { objectId: "rotation_210_flipped", rotation: 210, flipped: true },
];

/** The lines: category and arrows, covering all ten Slides arrow styles. */
export const FIXTURE_LINES: readonly Readonly<{ objectId: string; category: string; startArrow: string; endArrow: string; dash: string; antiDiagonal: boolean }>[] = [
  { objectId: "line_straight", category: "STRAIGHT", startArrow: "FILL_ARROW", endArrow: "OPEN_ARROW", dash: "SOLID", antiDiagonal: false },
  { objectId: "line_bent", category: "BENT", startArrow: "STEALTH_ARROW", endArrow: "FILL_DIAMOND", dash: "DASH", antiDiagonal: false },
  { objectId: "line_curved", category: "CURVED", startArrow: "FILL_CIRCLE", endArrow: "FILL_SQUARE", dash: "DOT", antiDiagonal: false },
  { objectId: "line_flipped", category: "STRAIGHT", startArrow: "OPEN_CIRCLE", endArrow: "OPEN_DIAMOND", dash: "DASH_DOT", antiDiagonal: true },
  { objectId: "line_plain", category: "STRAIGHT", startArrow: "NONE", endArrow: "OPEN_SQUARE", dash: "LONG_DASH", antiDiagonal: false },
];

async function main(): Promise<void> {
  const [command, presentationId] = process.argv.slice(2);
  const grant = await developmentGrant();
  const slides = createSlidesClient({ fetch, accessToken: grant.accessToken });
  if (command === "build") {
    const built = await buildFixture({ slides, accessToken: grant.accessToken });
    process.stdout.write(`built https://docs.google.com/presentation/d/${built}/edit\n`);
    return;
  }
  if (command === "record" && presentationId !== undefined) {
    const answer = await slides.getPresentation({ presentationId, fields: null });
    if (answer.kind !== "ok") throw new Error(`get failed: ${answer.status} ${answer.message}`);
    const text = stableContentAddresses(JSON.stringify(answer.body, null, 1));
    writeFileSync(FIXTURE_PATH, `${text}\n`);
    process.stdout.write(`recorded ${text.length.toLocaleString()} characters into ${FIXTURE_PATH}\n`);
    return;
  }
  throw new Error("usage: google-slides-fixture.ts build | record <presentationId>");
}

async function buildFixture(options: Readonly<{ slides: SlidesClient; accessToken: string }>): Promise<string> {
  const { slides } = options;
  const created = await slides.createPresentation({ title: "Sasha import fixture", widthEnglishMetricUnits: 9_144_000, heightEnglishMetricUnits: 5_143_500 });
  if (created.kind !== "ok") throw new Error(`create failed: ${created.message}`);
  const presentationId = readString(created.body, "presentationId");
  const first = await slides.getPresentation({ presentationId, fields: "slides(objectId,pageElements(objectId,shape(placeholder)))" });
  if (first.kind !== "ok") throw new Error(`get failed: ${first.message}`);
  const titleSlide = JSON.stringify(first.body);
  const titleId = /"objectId":"([^"]+)","shape":\{"placeholder":\{"type":"CENTERED_TITLE"/.exec(titleSlide)?.[1];
  const subtitleId = /"objectId":"([^"]+)","shape":\{"placeholder":\{"type":"SUBTITLE"/.exec(titleSlide)?.[1];
  if (titleId === undefined || subtitleId === undefined) throw new Error(`no title placeholders in ${titleSlide}`);

  const chart = await createSheetsChart({ accessToken: options.accessToken });
  const requests: unknown[] = [
    { insertText: { objectId: titleId, text: "Sasha import fixture" } },
    { insertText: { objectId: subtitleId, text: "Every row of the import table" } },
    ...agendaSlide(),
    ...shapesSlide(),
    ...mediaSlide({ chart }),
    ...tableSlide(),
    ...groupSlide(),
    { createSlide: { objectId: "skipped_slide", slideLayoutReference: { predefinedLayout: "BLANK" } } },
    { updateSlideProperties: { objectId: "skipped_slide", slideProperties: { isSkipped: true }, fields: "isSkipped" } },
    {
      updatePageProperties: {
        objectId: "skipped_slide",
        pageProperties: { pageBackgroundFill: { solidFill: { color: { rgbColor: { red: 0.1, green: 0.4, blue: 0.3 } }, alpha: 1 } } },
        fields: "pageBackgroundFill.solidFill.color",
      },
    },
    { createSlide: { objectId: "picture_background", slideLayoutReference: { predefinedLayout: "BLANK" } } },
    {
      updatePageProperties: {
        objectId: "picture_background",
        pageProperties: { pageBackgroundFill: { stretchedPictureFill: { contentUrl: PUBLIC_IMAGE } } },
        fields: "pageBackgroundFill.stretchedPictureFill.contentUrl",
      },
    },
  ];
  const written = await slides.batchUpdate({ presentationId, requests });
  if (written.kind !== "ok") throw new Error(`batchUpdate failed: ${written.status} ${written.message}`);

  const notes = await slides.getPresentation({ presentationId, fields: "slides(objectId,slideProperties(notesPage(notesProperties)))" });
  if (notes.kind !== "ok") throw new Error(`notes get failed: ${notes.message}`);
  const notesRequests = [...JSON.stringify(notes.body).matchAll(/"objectId":"([^"]+)","slideProperties":\{"notesPage":\{"notesProperties":\{"speakerNotesObjectId":"([^"]+)"/g)]
    .filter((match) => match[1] === "g1a2b3c4d5_0_1" || match[1] === "p")
    .map((match) => ({ insertText: { objectId: match[2], text: match[1] === "p" ? "Welcome everyone." : "Say the budget first.\nThen the timeline." } }));
  const notesWritten = await slides.batchUpdate({ presentationId, requests: notesRequests });
  if (notesWritten.kind !== "ok") throw new Error(`notes failed: ${notesWritten.message}`);
  return presentationId;
}

function agendaSlide(): readonly unknown[] {
  const body = "Plan the launch\n\tBudget\n\tTimeline\nShip it\nSee the title slide";
  const range = (text: string): Readonly<{ type: "FIXED_RANGE"; startIndex: number; endIndex: number }> => {
    const start = body.replace(/\t/g, "").indexOf(text);
    return { type: "FIXED_RANGE", startIndex: start, endIndex: start + text.length };
  };
  return [
    {
      createSlide: {
        objectId: "g1a2b3c4d5_0_1",
        slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
        placeholderIdMappings: [
          { layoutPlaceholder: { type: "TITLE", index: 0 }, objectId: "agenda_title" },
          { layoutPlaceholder: { type: "BODY", index: 0 }, objectId: "agenda_body" },
        ],
      },
    },
    { insertText: { objectId: "agenda_title", text: "Agenda" } },
    { insertText: { objectId: "agenda_body", text: body } },
    { createParagraphBullets: { objectId: "agenda_body", textRange: { type: "ALL" }, bulletPreset: "BULLET_DISC_CIRCLE_SQUARE" } },
    { updateTextStyle: { objectId: "agenda_body", textRange: range("launch"), style: { bold: true, link: { url: "https://sashaslides.com" } }, fields: "bold,link" } },
    {
      updateTextStyle: {
        objectId: "agenda_body",
        textRange: range("Budget"),
        style: { italic: true, foregroundColor: { opaqueColor: { themeColor: "ACCENT2" } } },
        fields: "italic,foregroundColor",
      },
    },
    {
      updateTextStyle: {
        objectId: "agenda_body",
        textRange: range("Timeline"),
        style: { underline: true, backgroundColor: { opaqueColor: { rgbColor: { red: 1, green: 0.9, blue: 0.2 } } } },
        fields: "underline,backgroundColor",
      },
    },
    { updateTextStyle: { objectId: "agenda_body", textRange: range("Ship"), style: { smallCaps: true }, fields: "smallCaps" } },
    { updateTextStyle: { objectId: "agenda_body", textRange: range("it"), style: { baselineOffset: "SUPERSCRIPT" }, fields: "baselineOffset" } },
    { updateTextStyle: { objectId: "agenda_body", textRange: range("title slide"), style: { link: { pageObjectId: "p" } }, fields: "link" } },
    {
      createShape: {
        objectId: "numbered_box",
        shapeType: "TEXT_BOX",
        elementProperties: place({ x: 420, y: 250, width: 260, height: 120, rotation: 0, flipped: false, pageObjectId: "g1a2b3c4d5_0_1" }),
      },
    },
    { insertText: { objectId: "numbered_box", text: "First\nSecond\nThird\nNext slide" } },
    { createParagraphBullets: { objectId: "numbered_box", textRange: { type: "FIXED_RANGE", startIndex: 0, endIndex: 19 }, bulletPreset: "NUMBERED_DIGIT_ALPHA_ROMAN" } },
    {
      updateTextStyle: {
        objectId: "numbered_box",
        textRange: { type: "ALL" },
        style: { weightedFontFamily: { fontFamily: "Roboto", weight: 300 }, fontSize: { magnitude: 20, unit: "PT" } },
        fields: "weightedFontFamily,fontSize",
      },
    },
    { updateTextStyle: { objectId: "numbered_box", textRange: { type: "FIXED_RANGE", startIndex: 19, endIndex: 29 }, style: { link: { relativeLink: "NEXT_SLIDE" } }, fields: "link" } },
    {
      updateParagraphStyle: {
        objectId: "numbered_box",
        textRange: { type: "ALL" },
        style: { alignment: "CENTER", lineSpacing: 150, spaceAbove: { magnitude: 6, unit: "PT" }, spaceBelow: { magnitude: 4, unit: "PT" } },
        fields: "alignment,lineSpacing,spaceAbove,spaceBelow",
      },
    },
  ];
}

function shapesSlide(): readonly unknown[] {
  const pageObjectId = "shapes_slide";
  const requests: unknown[] = [{ createSlide: { objectId: pageObjectId, slideLayoutReference: { predefinedLayout: "BLANK" } } }];
  FIXTURE_SHAPE_TYPES.forEach((shapeType, index) => {
    const objectId = `shape_${shapeType.toLowerCase()}`;
    requests.push({
      createShape: {
        objectId,
        shapeType,
        elementProperties: place({ x: 20 + (index % 9) * 75, y: 20 + Math.floor(index / 9) * 60, width: 60, height: 45, rotation: 0, flipped: false, pageObjectId }),
      },
    });
  });
  requests.push(
    {
      updateShapeProperties: {
        objectId: "shape_rectangle",
        shapeProperties: {
          shapeBackgroundFill: { solidFill: { color: { rgbColor: { red: 0.2, green: 0.4, blue: 0.8 } }, alpha: 0.5 } },
          outline: { outlineFill: { solidFill: { color: { rgbColor: { red: 0.9, green: 0.1, blue: 0.1 } } } }, weight: { magnitude: 3, unit: "PT" }, dashStyle: "DASH" },
          contentAlignment: "MIDDLE",
        },
        fields: "shapeBackgroundFill.solidFill,outline,contentAlignment",
      },
    },
    {
      updateShapeProperties: {
        objectId: "shape_ellipse",
        shapeProperties: { shapeBackgroundFill: { solidFill: { color: { themeColor: "ACCENT1" } } }, outline: { propertyState: "NOT_RENDERED" }, contentAlignment: "BOTTOM" },
        fields: "shapeBackgroundFill.solidFill,outline.propertyState,contentAlignment",
      },
    },
    { updateShapeProperties: { objectId: "shape_triangle", shapeProperties: { shapeBackgroundFill: { propertyState: "NOT_RENDERED" } }, fields: "shapeBackgroundFill.propertyState" } },
    { insertText: { objectId: "shape_rectangle", text: "Middle" } },
    { insertText: { objectId: "shape_ellipse", text: "Bottom" } },
    { insertText: { objectId: "shape_text_box", text: "Grows" } },
  );
  FIXTURE_ROTATIONS.forEach((rotated, index) => {
    requests.push({
      createShape: {
        objectId: rotated.objectId,
        shapeType: "RIGHT_ARROW",
        elementProperties: place({
          x: 60 + (index % 3) * 210,
          y: 230 + Math.floor(index / 3) * 80,
          width: 120,
          height: 50,
          rotation: rotated.rotation,
          flipped: rotated.flipped,
          pageObjectId,
        }),
      },
    });
  });
  return requests;
}

function mediaSlide(options: Readonly<{ chart: Readonly<{ spreadsheetId: string; chartId: number }> }>): readonly unknown[] {
  const pageObjectId = "media_slide";
  const requests: unknown[] = [
    { createSlide: { objectId: pageObjectId, slideLayoutReference: { predefinedLayout: "BLANK" } } },
    {
      createImage: {
        objectId: "logo_image",
        url: PUBLIC_IMAGE,
        elementProperties: place({ x: 30, y: 30, width: 200, height: 68, rotation: 0, flipped: false, pageObjectId }),
      },
    },
    {
      updateImageProperties: {
        objectId: "logo_image",
        imageProperties: { outline: { outlineFill: { solidFill: { color: { rgbColor: { red: 0.1, green: 0.1, blue: 0.1 } } } }, weight: { magnitude: 2, unit: "PT" } } },
        fields: "outline",
      },
    },
    { createVideo: { objectId: "talk_video", source: "YOUTUBE", id: "dQw4w9WgXcQ", elementProperties: place({ x: 470, y: 30, width: 200, height: 112, rotation: 0, flipped: false, pageObjectId }) } },
    {
      createSheetsChart: {
        objectId: "revenue_chart",
        spreadsheetId: options.chart.spreadsheetId,
        chartId: options.chart.chartId,
        linkingMode: "LINKED",
        elementProperties: place({ x: 470, y: 170, width: 200, height: 150, rotation: 0, flipped: false, pageObjectId }),
      },
    },
  ];
  FIXTURE_LINES.forEach((line, index) => {
    const elementProperties = place({ x: 40 + index * 80, y: 150, width: 60, height: 120, rotation: 0, flipped: line.antiDiagonal, pageObjectId });
    requests.push(
      { createLine: { objectId: line.objectId, lineCategory: line.category, elementProperties } },
      {
        updateLineProperties: {
          objectId: line.objectId,
          lineProperties: {
            startArrow: line.startArrow,
            endArrow: line.endArrow,
            dashStyle: line.dash,
            weight: { magnitude: 2 + index, unit: "PT" },
            lineFill: { solidFill: { color: { rgbColor: { red: 0.1 * index, green: 0.3, blue: 0.6 } } } },
          },
          fields: "startArrow,endArrow,dashStyle,weight,lineFill",
        },
      },
    );
  });
  return requests;
}

function tableSlide(): readonly unknown[] {
  const pageObjectId = "table_slide";
  const objectId = "budget_table";
  const cell = (rowIndex: number, columnIndex: number): Readonly<{ rowIndex: number; columnIndex: number }> => ({ rowIndex, columnIndex });
  const range = (rowIndex: number, columnIndex: number, rowSpan: number, columnSpan: number): unknown => ({ location: cell(rowIndex, columnIndex), rowSpan, columnSpan });
  const solid = (red: number, green: number, blue: number): unknown => ({ solidFill: { color: { rgbColor: { red, green, blue } } } });
  return [
    { createSlide: { objectId: pageObjectId, slideLayoutReference: { predefinedLayout: "BLANK" } } },
    { createTable: { objectId, rows: 3, columns: 3, elementProperties: place({ x: 60, y: 60, width: 480, height: 200, rotation: 0, flipped: false, pageObjectId }) } },
    { insertText: { objectId, cellLocation: cell(0, 0), text: "Merged two by two" } },
    { insertText: { objectId, cellLocation: cell(0, 2), text: "Q3" } },
    { insertText: { objectId, cellLocation: cell(2, 0), text: "Total" } },
    { insertText: { objectId, cellLocation: cell(2, 2), text: "42" } },
    { mergeTableCells: { objectId, tableRange: range(0, 0, 2, 2) } },
    {
      updateTableBorderProperties: {
        objectId,
        tableRange: range(0, 0, 3, 3),
        borderPosition: "TOP",
        tableBorderProperties: { tableBorderFill: solid(0.9, 0.1, 0.1), weight: { magnitude: 3, unit: "PT" }, dashStyle: "SOLID" },
        fields: "tableBorderFill,weight,dashStyle",
      },
    },
    {
      updateTableBorderProperties: {
        objectId,
        tableRange: range(0, 0, 3, 3),
        borderPosition: "LEFT",
        tableBorderProperties: { tableBorderFill: solid(0.1, 0.2, 0.9), weight: { magnitude: 2, unit: "PT" }, dashStyle: "DASH" },
        fields: "tableBorderFill,weight,dashStyle",
      },
    },
    {
      updateTableBorderProperties: {
        objectId,
        tableRange: range(0, 0, 3, 3),
        borderPosition: "INNER_HORIZONTAL",
        tableBorderProperties: { tableBorderFill: solid(0.1, 0.6, 0.2), weight: { magnitude: 1, unit: "PT" } },
        fields: "tableBorderFill,weight",
      },
    },
    {
      updateTableCellProperties: {
        objectId,
        tableRange: range(2, 2, 1, 1),
        tableCellProperties: { tableCellBackgroundFill: solid(1, 0.95, 0.8), contentAlignment: "MIDDLE" },
        fields: "tableCellBackgroundFill.solidFill.color,contentAlignment",
      },
    },
    { updateTableColumnProperties: { objectId, columnIndices: [2], tableColumnProperties: { columnWidth: { magnitude: 100, unit: "PT" } }, fields: "columnWidth" } },
    { updateTableRowProperties: { objectId, rowIndices: [2], tableRowProperties: { minRowHeight: { magnitude: 60, unit: "PT" } }, fields: "minRowHeight" } },
  ];
}

function groupSlide(): readonly unknown[] {
  const pageObjectId = "group_slide";
  const radians = (30 * Math.PI) / 180;
  return [
    { createSlide: { objectId: pageObjectId, slideLayoutReference: { predefinedLayout: "BLANK" } } },
    { createShape: { objectId: "group_left", shapeType: "RECTANGLE", elementProperties: place({ x: 200, y: 150, width: 100, height: 60, rotation: 0, flipped: false, pageObjectId }) } },
    { createShape: { objectId: "group_right", shapeType: "ELLIPSE", elementProperties: place({ x: 320, y: 170, width: 80, height: 80, rotation: 15, flipped: false, pageObjectId }) } },
    { groupObjects: { groupObjectId: "rotated_group", childrenObjectIds: ["group_left", "group_right"] } },
    {
      updatePageElementTransform: {
        objectId: "rotated_group",
        applyMode: "RELATIVE",
        transform: { scaleX: Math.cos(radians), scaleY: Math.cos(radians), shearX: -Math.sin(radians), shearY: Math.sin(radians), translateX: 0, translateY: 0, unit: "PT" },
      },
    },
  ];
}

/** A box whose centre sits at (x + width / 2, y + height / 2) in points, rotated and optionally mirrored about it. */
function place(
  options: Readonly<{ x: number; y: number; width: number; height: number; rotation: number; flipped: boolean; pageObjectId: string }>,
): unknown {
  const radians = (options.rotation * Math.PI) / 180;
  const flip = options.flipped ? -1 : 1;
  const scaleX = Math.cos(radians) * flip;
  const shearY = Math.sin(radians) * flip;
  const shearX = -Math.sin(radians);
  const scaleY = Math.cos(radians);
  const centreX = options.x + options.width / 2;
  const centreY = options.y + options.height / 2;
  return {
    pageObjectId: options.pageObjectId,
    size: { width: { magnitude: options.width, unit: "PT" }, height: { magnitude: options.height, unit: "PT" } },
    transform: {
      scaleX,
      scaleY,
      shearX,
      shearY,
      translateX: centreX - (scaleX * options.width) / 2 - (shearX * options.height) / 2,
      translateY: centreY - (shearY * options.width) / 2 - (scaleY * options.height) / 2,
      unit: "PT",
    },
  };
}

/** A spreadsheet with four numbers and a column chart, for `createSheetsChart`. */
async function createSheetsChart(options: Readonly<{ accessToken: string }>): Promise<Readonly<{ spreadsheetId: string; chartId: number }>> {
  const headers = { authorization: `Bearer ${options.accessToken}`, "content-type": "application/json" };
  const created = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
    method: "POST",
    headers,
    body: JSON.stringify({
      properties: { title: "Sasha import fixture chart" },
      sheets: [{ properties: { sheetId: 0, title: "Revenue" }, data: [{ rowData: [["Q1", 10], ["Q2", 14], ["Q3", 9], ["Q4", 17]].map(([label, value]) => ({ values: [{ userEnteredValue: { stringValue: String(label) } }, { userEnteredValue: { numberValue: Number(value) } }] })) }] }],
    }),
  });
  const spreadsheetId = readString(await created.json(), "spreadsheetId");
  const source = (column: number): unknown => ({ sourceRange: { sources: [{ sheetId: 0, startRowIndex: 0, endRowIndex: 4, startColumnIndex: column, endColumnIndex: column + 1 }] } });
  const charted = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      requests: [{ addChart: { chart: { spec: { title: "Revenue", basicChart: { chartType: "COLUMN", domains: [{ domain: source(0) }], series: [{ series: source(1) }] } }, position: { overlayPosition: { anchorCell: { sheetId: 0, rowIndex: 6, columnIndex: 0 } } } } } }],
    }),
  });
  const answer: unknown = await charted.json();
  const chartId = /"chartId":\s*(\d+)/.exec(JSON.stringify(answer))?.[1];
  if (chartId === undefined) throw new Error(`no chart: ${JSON.stringify(answer).slice(0, 300)}`);
  return { spreadsheetId, chartId: Number(chartId) };
}

/** Signed `contentUrl`s become `https://fixture.invalid/content/<n>` (see the header). */
function stableContentAddresses(text: string): string {
  const seen = new Map<string, string>();
  return text.replace(/"contentUrl": "([^"]+)"/g, (_whole, address: string) => {
    const known = seen.get(address) ?? `https://fixture.invalid/content/${seen.size + 1}`;
    seen.set(address, known);
    return `"contentUrl": "${known}"`;
  });
}

function readString(body: unknown, key: string): string {
  if (typeof body === "object" && body !== null && key in body) {
    const value: unknown = (body as Readonly<Record<string, unknown>>)[key];
    if (typeof value === "string") return value;
  }
  throw new Error(`answer has no ${key}: ${JSON.stringify(body).slice(0, 300)}`);
}

main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
