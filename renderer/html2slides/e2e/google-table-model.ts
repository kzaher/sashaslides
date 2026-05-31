// google-table-model.ts — generic empirical model of Google Slides' imported-
// table geometry. Two surfaces, MEASURED not guessed (see google-table-fuzz.ts,
// api-table-probe.ts, google-table-border-study.ts):
//
//   • GRID  = Google's stored geometry, read EXACT from the Slides REST API
//             (presentations.get → tableRows[].rowHeight / tableColumns[].columnWidth).
//   • FILL  = the visible rasterised cell, measured from the thumbnail (pngjs).
//
// They differ: the fill renders ~1.2·font (CSS line-box) while the grid stores
// ~1.0·font, and multi-line content reflows the fill PAST the stored rowHeight.
// Use GRID for native-cell / API-batchUpdate geometry; FILL for corner-MASK
// overlay alignment (masks sit on the visible cell).
//
// All units: px in the 1280px fixture coordinate (px2in = px·10/1280).

/** EXACT grid row height Google stores. Validated on API ground truth:
 *  RMSE 0.65px, R²=0.999. Coefficients are all unit (1.0); the border term is
 *  (N+1)/N because N rows have N+1 horizontal grid lines of width `border`,
 *  split evenly per row (N=1→2·border, large N→border). Border smearing across
 *  random N≈3–6 was the old bogus "1.26·border". */
export function predictGoogleRowHeightGrid(opts: {
  specifiedPx: number; fontPx: number; lines?: number; padYpx?: number;
  borderPx?: number; numRows?: number;
}): number {
  const lines = opts.lines ?? 1, padY = opts.padYpx ?? 0;
  const border = opts.borderPx ?? 0, N = Math.max(1, opts.numRows ?? 1);
  const floor = opts.fontPx * lines + 2 * padY + border * (N + 1) / N;
  return Math.max(opts.specifiedPx + 0.5, floor);
}

/** VISIBLE fill row height (what corner masks must reach). Line-box ≈1.2·font;
 *  border draws between cells so it does NOT grow the fill band. Held-out vs
 *  pixels RMSE ~1px. */
export function predictGoogleRowHeightFill(opts: {
  specifiedPx: number; fontPx: number; lines?: number; padYpx?: number;
}): number {
  const lines = opts.lines ?? 1, padY = opts.padYpx ?? 0;
  const floor = 1.1965 * opts.fontPx * lines + 0.9817 * 2 * padY + 0.5089;
  return Math.max(opts.specifiedPx + 0.7161, floor);
}

/** EXACT grid column width. Google honours table-layout:fixed widths to ~1px;
 *  vertical borders add only ~0.78·t TOTAL (fixed columns absorb most of it).
 *  RMSE 0.66px, R²=0.99998. */
export function predictGoogleColWidth(specifiedPx: number, opts?: { borderPx?: number; numCols?: number }): number {
  const t = opts?.borderPx ?? 0, M = Math.max(1, opts?.numCols ?? 1);
  return 1.0008 * specifiedPx - 0.07 + (t > 0 ? 0.78 * t / M : 0);
}

/** Largest cell font (px) whose single visible line-box still fits a target row
 *  height — set the cell font/line-height to this to STOP Google auto-growing
 *  the row past your specified height (the corner-mask fix). */
export function maxFontForRowHeight(targetRowPx: number, padYpx = 0): number {
  const avail = targetRowPx - 0.9817 * 2 * padYpx - 0.5089;
  return Math.max(1, Math.floor(avail / 1.1965));
}
