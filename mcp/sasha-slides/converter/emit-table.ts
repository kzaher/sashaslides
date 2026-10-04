/**
 * emit-table.ts — native Slides tables.
 *
 * This is the one element where the geometry cannot be copied across naively,
 * and where CLAUDE.md's measured model earns its keep:
 *
 *  - Columns are honoured almost exactly (`rendered = 1.003·spec − 0.10`), so
 *    the specified width is the inverse of the measured one. Sub-pixel on a
 *    narrow column, ~1 px on a full-width table.
 *  - Rows are honoured ONLY DOWN TO A FLOOR. `minRowHeight` is a minimum, and
 *    Slides grows a row whose line box plus vertical padding needs more room:
 *    `max(spec + 0.72, 1.197·font·lines + 0.98·(2·padY) + 0.51)`. When the
 *    floor exceeds the height Chrome measured, the row WILL render taller and
 *    nothing in the API prevents it — so it is reported as an anomaly with the
 *    predicted overflow rather than silently specified and hoped for.
 *
 * Request order is load-bearing: merges go before any cell write, because
 * writing into a cell that a later merge absorbs is an error, and a merged
 * region is addressed by its upper-left cell.
 */
import type { Border, SizePx, TableCellModel, TableElement, TypeStyle } from "./extraction.js";
import {
  emuDimension,
  predictGoogleRowHeightPx,
  specForColumnWidthPx,
  specForRowHeightPx,
} from "./geometry.js";
import { placeBox } from "./geometry.js";
import type { SlidesApiRequest, TableRange } from "./slides-api.js";
import { dashStyleFromCss, solidFillFromPaint } from "./slides-paint.js";
import type { ElementEmission, EmitContext } from "./emit-context.js";
import { contentAlignmentFor, featureSite } from "./emit-context.js";
import { composeRuns, reportTextLosses, styleRequestsFor } from "./emit-text.js";
import type { UnsupportedFeature } from "./unsupported-feature.js";

export function emitTable(
  options: Readonly<{ element: TableElement; context: EmitContext; viewportPx: SizePx }>,
): ElementEmission {
  const { element, context, viewportPx } = options;
  const grid = layOutGrid(element);
  if (grid.rowCount === 0 || grid.columnCount === 0) return { requests: [], unsupported: [] };

  const objectId = context.ids.next("tbl");
  const requests: SlidesApiRequest[] = [
    {
      createTable: {
        objectId,
        elementProperties: placeBox({
          bounds: element.bounds,
          pageObjectId: context.pageObjectId,
          scale: context.scale,
        }),
        rows: grid.rowCount,
        columns: grid.columnCount,
      },
    },
  ];

  // Merges first: a merge absorbs cells, so any text written into them before
  // the merge would either error or be discarded.
  for (const placement of grid.placements) {
    if (placement.rowSpan === 1 && placement.columnSpan === 1) continue;
    requests.push({ mergeTableCells: { objectId, tableRange: rangeOf(placement) } });
  }

  requests.push(...columnWidthRequests({ objectId, grid, element, context }));
  const rowHeights = rowHeightPlan({ grid, element });
  requests.push(...rowHeightRequests({ objectId, rowHeights, context }));

  const styles: TypeStyle[] = [];
  for (const placement of grid.placements) {
    const { cell } = placement;
    const cellLocation = { rowIndex: placement.rowIndex, columnIndex: placement.columnIndex };
    styles.push(cell.style);

    const fillOrAlignment = cellPropertiesFor(cell);
    if (fillOrAlignment !== null) {
      requests.push({
        updateTableCellProperties: {
          objectId,
          tableRange: rangeOf(placement),
          tableCellProperties: fillOrAlignment.properties,
          fields: fillOrAlignment.fields,
        },
      });
    }

    const composed = composeRuns({ runs: cell.runs, fallbackText: cell.text });
    if (composed.text.length === 0) continue;
    requests.push({ insertText: { objectId, text: composed.text, insertionIndex: 0, cellLocation } });
    requests.push(
      ...styleRequestsFor({ objectId, composed, baseStyle: cell.style, cellLocation }),
    );
  }

  requests.push(...borderRequests({ objectId, grid, element }));

  return {
    requests,
    unsupported: [
      ...rowHeights.anomalies.map((anomaly) => tableRowAnomaly({ anomaly, element, viewportPx })),
      ...reportTextLosses({
        bounds: element.bounds,
        viewportPx,
        elementType: "table",
        domIndex: element.domIndex,
        styles,
      }),
    ],
  };
}

type CellPlacement = Readonly<{
  rowIndex: number;
  columnIndex: number;
  rowSpan: number;
  columnSpan: number;
  cell: TableCellModel;
}>;

type Grid = Readonly<{
  rowCount: number;
  columnCount: number;
  placements: readonly CellPlacement[];
}>;

/**
 * Resolve the DOM's row lists — which omit cells covered by a `rowspan` above —
 * into explicit grid coordinates, growing the column count as spans demand.
 */
function layOutGrid(element: TableElement): Grid {
  const occupied = new Set<string>();
  const placements: CellPlacement[] = [];
  let columnCount = 0;

  for (let rowIndex = 0; rowIndex < element.rows.length; rowIndex++) {
    // SAFETY: rowIndex is bounded by element.rows.length.
    const row = element.rows[rowIndex]!;
    let columnIndex = 0;
    for (const cell of row) {
      while (occupied.has(`${rowIndex},${columnIndex}`)) columnIndex++;
      const rowSpan = Math.max(1, cell.rowspan);
      const columnSpan = Math.max(1, cell.colspan);
      for (let r = rowIndex; r < rowIndex + rowSpan; r++) {
        for (let c = columnIndex; c < columnIndex + columnSpan; c++) occupied.add(`${r},${c}`);
      }
      placements.push({ rowIndex, columnIndex, rowSpan, columnSpan, cell });
      columnIndex += columnSpan;
      columnCount = Math.max(columnCount, columnIndex);
    }
  }
  return { rowCount: element.rows.length, columnCount, placements };
}

function rangeOf(placement: CellPlacement): TableRange {
  return {
    location: { rowIndex: placement.rowIndex, columnIndex: placement.columnIndex },
    rowSpan: placement.rowSpan,
    columnSpan: placement.columnSpan,
  };
}

/**
 * One request per column, using the inverse of the measured column law so the
 * RENDERED width matches what Chrome laid out. Widths come from the measured
 * cell boxes where a single-column cell exists for that column; a column with
 * only spanned cells falls back to an even share of the remaining width.
 */
function columnWidthRequests(
  options: Readonly<{ objectId: string; grid: Grid; element: TableElement; context: EmitContext }>,
): readonly SlidesApiRequest[] {
  const { objectId, grid, element, context } = options;
  const measured = new Map<number, number>();
  for (const placement of grid.placements) {
    if (placement.columnSpan !== 1) continue;
    const bounds = placement.cell.bounds;
    if (bounds === null || bounds.w <= 0) continue;
    measured.set(placement.columnIndex, bounds.w);
  }

  const evenShare = element.bounds.w / grid.columnCount;
  const requests: SlidesApiRequest[] = [];
  for (let columnIndex = 0; columnIndex < grid.columnCount; columnIndex++) {
    const targetPx = measured.get(columnIndex) ?? evenShare;
    requests.push({
      updateTableColumnProperties: {
        objectId,
        columnIndices: [columnIndex],
        tableColumnProperties: {
          columnWidth: emuDimension(specForColumnWidthPx(targetPx), context.scale),
        },
      fields: "columnWidth",
      },
    });
  }
  return requests;
}

type RowPlan = Readonly<{
  rowIndex: number;
  /** What Chrome measured, and therefore the target. */
  measuredPx: number;
  /** What to put in `minRowHeight` to render at the target. */
  specPx: number;
}>;

type RowAnomaly = Readonly<{ rowIndex: number; measuredPx: number; predictedPx: number }>;

type RowHeightPlan = Readonly<{ rows: readonly RowPlan[]; anomalies: readonly RowAnomaly[] }>;

/**
 * Per-row spec heights plus the rows Slides will refuse to render that short.
 *
 * `lines` for the floor prediction is derived from the measured cell box rather
 * than guessed: Chrome already laid the text out, so the box height divided by
 * the line pitch is the line count, and that is the number the law needs.
 */
function rowHeightPlan(options: Readonly<{ grid: Grid; element: TableElement }>): RowHeightPlan {
  const { grid, element } = options;
  const measuredByRow = new Map<number, number>();
  const metricsByRow = new Map<number, Readonly<{ fontPx: number; padYPx: number; lines: number }>>();

  for (const placement of grid.placements) {
    if (placement.rowSpan !== 1) continue;
    const { cell } = placement;
    const bounds = cell.bounds;
    const padYPx = (cell.paddingPx.top + cell.paddingPx.bottom) / 2;
    const lineHeightPx = cell.style.lineHeightPx > 0 ? cell.style.lineHeightPx : cell.style.fontSizePx * 1.2;
    const innerPx = bounds === null ? 0 : bounds.h - cell.paddingPx.top - cell.paddingPx.bottom;
    const lines = innerPx > 0 ? Math.max(1, Math.round(innerPx / lineHeightPx)) : 1;
    if (bounds !== null && bounds.h > 0) {
      measuredByRow.set(placement.rowIndex, Math.max(measuredByRow.get(placement.rowIndex) ?? 0, bounds.h));
    }
    const previous = metricsByRow.get(placement.rowIndex);
    metricsByRow.set(placement.rowIndex, {
      fontPx: Math.max(previous?.fontPx ?? 0, cell.style.fontSizePx),
      padYPx: Math.max(previous?.padYPx ?? 0, padYPx),
      lines: Math.max(previous?.lines ?? 1, lines),
    });
  }

  const evenShare = element.bounds.h / grid.rowCount;
  const rows: RowPlan[] = [];
  const anomalies: RowAnomaly[] = [];
  for (let rowIndex = 0; rowIndex < grid.rowCount; rowIndex++) {
    const measuredPx = measuredByRow.get(rowIndex) ?? evenShare;
    const specPx = specForRowHeightPx(measuredPx);
    rows.push({ rowIndex, measuredPx, specPx });

    const metrics = metricsByRow.get(rowIndex);
    if (metrics === undefined) continue;
    const prediction = predictGoogleRowHeightPx({
      specPx,
      fontPx: metrics.fontPx,
      lines: metrics.lines,
      padYPx: metrics.padYPx,
    });
    // Only worth the user's attention once the overflow is visible.
    if (prediction.floorWins && prediction.renderedPx - measuredPx > ROW_OVERFLOW_EPSILON_PX) {
      anomalies.push({ rowIndex, measuredPx, predictedPx: prediction.renderedPx });
    }
  }
  return { rows, anomalies };
}

function rowHeightRequests(
  options: Readonly<{ objectId: string; rowHeights: RowHeightPlan; context: EmitContext }>,
): readonly SlidesApiRequest[] {
  const { objectId, rowHeights, context } = options;
  return rowHeights.rows.map((row) => ({
    updateTableRowProperties: {
      objectId,
      rowIndices: [row.rowIndex],
      tableRowProperties: { minRowHeight: emuDimension(row.specPx, context.scale) },
      fields: "minRowHeight",
    },
  }));
}

function cellPropertiesFor(
  cell: TableCellModel,
): Readonly<{
  properties: Readonly<{
    tableCellBackgroundFill?: Readonly<{ solidFill: ReturnType<typeof solidFillFromPaint> }>;
    contentAlignment?: ReturnType<typeof contentAlignmentFor>;
  }>;
  fields: string;
}> | null {
  const fields: string[] = [];
  let properties: {
    tableCellBackgroundFill?: Readonly<{ solidFill: ReturnType<typeof solidFillFromPaint> }>;
    contentAlignment?: ReturnType<typeof contentAlignmentFor>;
  } = {};
  if (cell.fill !== null) {
    properties = { ...properties, tableCellBackgroundFill: { solidFill: solidFillFromPaint(cell.fill) } };
    fields.push("tableCellBackgroundFill.solidFill.color", "tableCellBackgroundFill.solidFill.alpha");
  }
  // Header cells are the common case for vertical centring and the extractor
  // does not record a per-cell vertical alignment, so MIDDLE is applied to
  // headers only — guessing it for body cells would move every value.
  if (cell.isHeader) {
    properties = { ...properties, contentAlignment: contentAlignmentFor(true) };
    fields.push("contentAlignment");
  }
  if (fields.length === 0) return null;
  return { properties, fields: fields.join(",") };
}

/**
 * Borders. When every cell asks for the same border, one `ALL` request covers
 * the table; otherwise each cell gets its own 1x1 range, which is the finest
 * granularity the API offers and is enough for the per-cell borders in
 * `fixtures-basic/slide_15_table_borders.html`.
 */
function borderRequests(
  options: Readonly<{ objectId: string; grid: Grid; element: TableElement }>,
): readonly SlidesApiRequest[] {
  const { objectId, grid } = options;
  const bordered = grid.placements.filter((placement) => placement.cell.border !== null);
  if (bordered.length === 0) return [];

  const signatures = new Set(bordered.map((placement) => borderSignature(placement.cell.border)));
  if (signatures.size === 1 && bordered.length === grid.placements.length) {
    // SAFETY: bordered is non-empty and every entry has a non-null border.
    const border = bordered[0]!.cell.border!;
    return [
      {
        updateTableBorderProperties: {
          objectId,
          tableRange: {
            location: { rowIndex: 0, columnIndex: 0 },
            rowSpan: grid.rowCount,
            columnSpan: grid.columnCount,
          },
          borderPosition: "ALL",
          tableBorderProperties: borderPropertiesFor(border),
          fields: borderFieldsFor(border),
        },
      },
    ];
  }

  return bordered.map((placement) => ({
    updateTableBorderProperties: {
      objectId,
      tableRange: rangeOf(placement),
      borderPosition: "ALL" as const,
      // SAFETY: `bordered` only contains placements whose border is non-null.
      tableBorderProperties: borderPropertiesFor(placement.cell.border!),
      fields: borderFieldsFor(placement.cell.border!),
    },
  }));
}

function borderPropertiesFor(border: Border): Readonly<{
  tableBorderFill?: Readonly<{ solidFill: ReturnType<typeof solidFillFromPaint> }>;
  weight: Readonly<{ magnitude: number; unit: "EMU" }>;
  dashStyle: ReturnType<typeof dashStyleFromCss>;
}> {
  return {
    ...(border.hex === null
      ? {}
      : { tableBorderFill: { solidFill: solidFillFromPaint({ hex: border.hex, alpha: 1 }) } }),
    // 9525 EMU per CSS px at 96 dpi; a border is a stroke weight, not a page
    // extent, so it does not scale with the slide-to-page mapping.
    weight: { magnitude: Math.max(1, Math.round(border.widthPx * 9525)), unit: "EMU" },
    dashStyle: dashStyleFromCss(border.style),
  };
}

function borderFieldsFor(border: Border): string {
  return border.hex === null
    ? "weight,dashStyle"
    : "tableBorderFill.solidFill.color,weight,dashStyle";
}

function borderSignature(border: Border | null): string {
  if (border === null) return "none";
  return `${border.widthPx}|${border.hex ?? ""}|${border.style}`;
}

function tableRowAnomaly(
  options: Readonly<{ anomaly: RowAnomaly; element: TableElement; viewportPx: SizePx }>,
): UnsupportedFeature {
  const { anomaly, element, viewportPx } = options;
  return {
    ...featureSite({
      bounds: element.bounds,
      viewportPx,
      elementType: "table",
      domIndex: element.domIndex,
    }),
    kind: "table-row-height-floor",
    fallback: "geometry-floor",
    rowIndex: anomaly.rowIndex,
    measuredPx: anomaly.measuredPx,
    predictedPx: anomaly.predictedPx,
  };
}

/**
 * The law's own held-out row RMSE is 1.02 px, so an overflow under ~1.5 px is
 * inside the model's error bar and not worth reporting as an anomaly.
 */
const ROW_OVERFLOW_EPSILON_PX = 1.5;
