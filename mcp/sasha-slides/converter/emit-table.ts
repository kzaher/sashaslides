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
import type { Border, BorderSideName, SizePx, TableCellModel, TableElement, TypeStyle } from "./extraction.js";
import {
  emuDimension,
  predictGoogleRowHeightPx,
  specForColumnWidthPx,
  specForRowHeightPx,
} from "./geometry.js";
import { placeBox } from "./geometry.js";
import type { BorderPosition, SlidesApiRequest, TableRange } from "./slides-api.js";
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
      ...styleRequestsFor({ objectId, composed, baseStyle: cell.style, scale: context.scale, cellLocation }),
    );
  }

  requests.push(...borderRequests({ objectId, grid, element }));

  return {
    requests,
    unsupported: [
      ...rowHeights.anomalies.map((anomaly) => tableRowAnomaly({ anomaly, element, viewportPx })),
      ...reportTextLosses({
        scale: context.scale,
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
 * Borders, SIDE BY SIDE.
 *
 * THE BUG THIS REPLACES. Every request went out as `borderPosition: "ALL"`, which draws all four
 * edges of the range. CSS borders are per side, so `tbody td { border-bottom: 1px solid #e2e2e8 }`
 * -- one faint hairline under each row -- became a box around every cell, i.e. a full dark grid
 * where the design had no vertical rules at all. Measured on a real candidate: 16 cells boxed at
 * 1px #1b1b1f, the total row's `border-top: 3px double` boxed on all four sides at 3px, and two
 * cells whose only border is `border-left: 4px solid #d9480f` wrapped in a 4px orange rectangle.
 * It was the loudest thing on the slide and none of it was in the HTML.
 *
 * Slides addresses sides individually (TOP / BOTTOM / LEFT / RIGHT), so each side is emitted with
 * its OWN width, colour and dash, and a side with no border is not emitted at all. `ALL` is kept
 * for the genuinely uniform case: it is one request instead of four and says the same thing.
 */
function borderRequests(
  options: Readonly<{ objectId: string; grid: Grid; element: TableElement }>,
): readonly SlidesApiRequest[] {
  const { objectId, grid } = options;
  const bordered = grid.placements.filter((placement) => placement.cell.border !== null);

  /*
   * CLEAR GOOGLE'S DEFAULT GRID FIRST.
   *
   * `createTable` does not make a borderless table: every cell arrives with Slides' own 1pt grey
   * border on all four edges. Our requests only ADD borders, so a design with horizontal
   * hairlines and no vertical rules still rendered with a full grey grid through the body and a
   * box around the whole table -- measured after the per-side fix, when the emitted requests
   * provably contained no vertical border at all and the rules were still on the slide.
   *
   * Requests apply in order, so this goes FIRST and whatever the CSS does ask for is painted
   * over it. A table with NO borders at all needs this request and nothing else, which is why
   * the early return for "no bordered cells" is below it rather than above.
   */
  const clearDefault: SlidesApiRequest = {
    updateTableBorderProperties: {
      objectId,
      tableRange: {
        location: { rowIndex: 0, columnIndex: 0 },
        rowSpan: grid.rowCount,
        columnSpan: grid.columnCount,
      },
      borderPosition: "ALL",
      /*
       * CLEARED BY A TRANSPARENT FILL. Two other ways were tried against the live API and both
       * failed:
       *   * `weight: 0` is REFUSED -- "The border weight 0.0 should not be less than or equal to
       *     zero" -- and a rejected request takes the whole atomic batch with it;
       *   * naming `tableBorderFill` in the mask with no value (the protobuf way to reset a
       *     field) is ACCEPTED and does nothing: the grey default grid was still on the
       *     rendered slide.
       * An alpha-0 fill is a real value rather than a reset, and a border that paints nothing is
       * indistinguishable from one that is not there. The weight is kept above zero because the
       * API insists on it; at alpha 0 it makes no mark.
       */
      tableBorderProperties: {
        tableBorderFill: { solidFill: solidFillFromPaint({ hex: "#ffffff", alpha: 0 }) },
        weight: { magnitude: 9525, unit: "EMU" },
      },
      fields: "tableBorderFill,weight",
    },
  };

  // NOTHING IS BORDERED: the blanket clear is the whole answer, and with no per-side request
  // after it there is no ordering to get wrong.
  if (bordered.length === 0) return [clearDefault];

  const signatures = new Set(bordered.map((placement) => borderSignature(placement.cell.border)));
  if (signatures.size === 1 && bordered.length === grid.placements.length) {
    // SAFETY: bordered is non-empty and every entry has a non-null border.
    const border = bordered[0]!.cell.border!;
    if (border.uniform) {
      // NO CLEAR NEEDED, AND NONE WANTED. This single `ALL` covers every segment of the table,
      // so Google's default is replaced rather than hidden -- and a blanket clear has been
      // measured to WIN over requests that follow it, so adding one here could erase the very
      // border this branch exists to draw.
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
  }

  /*
   * NO BLANKET CLEAR HERE, AND THAT IS THE WHOLE POINT.
   *
   * Sending one alpha-0 `ALL` over the table and then painting the real sides on top LOOKS like
   * it should work -- requests apply in order -- and it does not: measured on the live API, the
   * blanket clear won and the per-side borders that followed it vanished (the #e2e2e8 hairlines
   * and the 4px #d9480f flag bars were in the requests and absent from the render).
   *
   * So every cell states ALL FOUR of its sides outright: the CSS value where there is one, a
   * transparent border where there is not. One request per side, one final value each, no
   * ordering to depend on. It costs more requests than a clear-then-paint would, and it is the
   * only shape that has been seen to render correctly.
   */
  const facing = facingBordersOf(grid);
  return grid.placements.flatMap((placement) =>
    sideRequestsFor({
      objectId,
      range: rangeOf(placement),
      border: placement.cell.border,
      neighbourDraws: facing.get(keyOfPlacement(placement)) ?? NO_NEIGHBOUR_DRAWS,
    }),
  );
}

type SideFlags = Readonly<Record<BorderSideName, boolean>>;
const NO_NEIGHBOUR_DRAWS: SideFlags = { top: false, right: false, bottom: false, left: false };

function keyOfPlacement(placement: CellPlacement): string {
  return `${String(placement.rowIndex)},${String(placement.columnIndex)}`;
}

/**
 * For each cell, which of its sides the NEIGHBOUR on that side wants drawn.
 *
 * ADJACENT CELLS SHARE ONE SEGMENT. A cell's bottom edge IS the next row's top edge, and Slides
 * keeps one border for it -- so whichever request lands last decides. Having every cell state all
 * four of its own sides therefore erased the thing the neighbour had just drawn: the #e2e2e8
 * hairline under each row is also the TOP of the row below, every row below said "no top", and
 * the hairlines disappeared from the render while sitting plainly in the requests.
 *
 * So a cell only clears a side when the neighbour across it agrees there is nothing there.
 */
function facingBordersOf(grid: Grid): ReadonlyMap<string, SideFlags> {
  const byCell = new Map<string, CellPlacement>();
  for (const placement of grid.placements) {
    for (let row = placement.rowIndex; row < placement.rowIndex + placement.rowSpan; row += 1) {
      for (let column = placement.columnIndex; column < placement.columnIndex + placement.columnSpan; column += 1) {
        byCell.set(`${String(row)},${String(column)}`, placement);
      }
    }
  }
  const draws = (row: number, column: number, side: BorderSideName): boolean => {
    const neighbour = byCell.get(`${String(row)},${String(column)}`);
    const border = neighbour?.cell.border;
    return border !== undefined && border !== null && border.sides[side].widthPx > 0;
  };
  const facing = new Map<string, SideFlags>();
  for (const placement of grid.placements) {
    const { rowIndex: row, columnIndex: column } = placement;
    facing.set(keyOfPlacement(placement), {
      top: draws(row - 1, column, "bottom"),
      bottom: draws(row + placement.rowSpan, column, "top"),
      left: draws(row, column - 1, "right"),
      right: draws(row, column + placement.columnSpan, "left"),
    });
  }
  return facing;
}

/** CSS side -> the `borderPosition` that addresses that edge of a 1x1 range. */
const SIDE_POSITIONS: readonly Readonly<{ side: BorderSideName; position: BorderPosition }>[] = [
  { side: "top", position: "TOP" },
  { side: "right", position: "RIGHT" },
  { side: "bottom", position: "BOTTOM" },
  { side: "left", position: "LEFT" },
];

/**
 * One request per side that is actually drawn. A uniform border still collapses to a single
 * `ALL`, because four requests saying the same thing is three round trips of nothing.
 */
function sideRequestsFor(
  options: Readonly<{
    objectId: string;
    range: ReturnType<typeof rangeOf>;
    border: Border | null;
    neighbourDraws: SideFlags;
  }>,
): readonly SlidesApiRequest[] {
  const { objectId, range, border, neighbourDraws } = options;
  const requests: SlidesApiRequest[] = [];
  for (const { side, position } of SIDE_POSITIONS) {
    const edge = border === null ? null : border.sides[side];
    const drawn = edge !== null && edge.widthPx > 0;
    // LEAVE THE NEIGHBOUR'S LINE ALONE. The segment is shared, so clearing a side this cell does
    // not draw would erase the one the cell across it does.
    if (!drawn && neighbourDraws[side]) continue;
    requests.push({
      updateTableBorderProperties: {
        objectId,
        tableRange: range,
        borderPosition: position,
        tableBorderProperties: drawn
          ? borderPropertiesFor({ widthPx: edge.widthPx, hex: edge.hex, style: edge.style, uniform: true, sides: border!.sides })
          : INVISIBLE_BORDER,
        fields: "tableBorderFill.solidFill,weight,dashStyle",
      },
    });
  }
  return requests;
}

/**
 * A border that is there as far as the API is concerned and paints nothing. Weight zero is
 * REFUSED -- "The border weight 0.0 should not be less than or equal to zero" -- so the weight
 * stays at 1px and the fill is fully transparent instead.
 */
const INVISIBLE_BORDER = {
  tableBorderFill: { solidFill: solidFillFromPaint({ hex: "#ffffff", alpha: 0 }) },
  weight: { magnitude: 9525, unit: "EMU" as const },
  dashStyle: dashStyleFromCss("solid"),
};

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
