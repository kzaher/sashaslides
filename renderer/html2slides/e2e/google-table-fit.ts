/**
 * google-table-fit.ts — fit a GENERIC Google Slides table-geometry model from
 * the fuzzed dataset (google-table-fuzz.ts), VALIDATE it on a held-out split,
 * print data tables, and emit google-table-model.ts.
 *
 * Models (all units CSS px @ 96dpi):
 *   ROW height:  rendered = max(spec + rowSpecOffset, floor)
 *                floor    = cFont·font·lines + cPad·(2·padY) + cBorder·border + c0
 *   COL width:   rendered = cW·spec + cW0           (Google honours fixed widths)
 *
 * The floor coefficients are fit by least squares on the FLOOR-ACTIVE points
 * (rendered noticeably exceeds spec, so the floor — not the spec — set the
 * height); the max() is then evaluated on ALL points. We fit on a TRAIN split
 * and report RMSE / max-error / %within-1px / R² on the unseen TEST split, plus
 * a predicted-vs-actual table, to PROVE the model generalises.
 *
 * Run from renderer/:
 *   npx tsx html2slides/e2e/google-table-fit.ts [datasetA.json datasetB.json ...]
 * With ≥2 datasets, the LAST is treated as a fully-independent held-out test set
 * (different fuzz seed) — the strongest generalisation evidence.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

type CellSpec = { color: string; lines: number };
type TableSpec = { id: string; rowHeightsPx: number[]; colWidthsPx: number[]; fontPx: number; borderPx: number; padXPx: number; padYPx: number; cells: CellSpec[][] };
type Measured = { id: string; rowHeightsPx: number[]; colWidthsPx: number[]; originXpx: number; originYpx: number; tableWpx: number; tableHpx: number };

type RowPt = Readonly<{ id: string; spec: number; font: number; padY: number; border: number; lines: number; rend: number }>;
type ColPt = Readonly<{ id: string; spec: number; rend: number }>;

function loadPoints(path: string): { rows: RowPt[]; cols: ColPt[] } {
  const { specs, measured } = JSON.parse(readFileSync(path, "utf-8")) as { specs: TableSpec[]; measured: Measured[] };
  const M = new Map(measured.map((m) => [m.id, m]));
  const rows: RowPt[] = [], cols: ColPt[] = [];
  for (const s of specs) {
    const m = M.get(s.id);
    if (!m) continue;
    if (m.rowHeightsPx.length === s.rowHeightsPx.length) {
      s.rowHeightsPx.forEach((spec, ri) => {
        const lines = Math.max(...s.cells[ri].map((c) => c.lines));
        rows.push({ id: s.id, spec, font: s.fontPx, padY: s.padYPx, border: s.borderPx, lines, rend: m.rowHeightsPx[ri] });
      });
    }
    if (m.colWidthsPx.length === s.colWidthsPx.length) {
      s.colWidthsPx.forEach((spec, ci) => cols.push({ id: s.id, spec, rend: m.colWidthsPx[ci] }));
    }
  }
  return { rows, cols };
}

// --- least squares: solve (XᵀX) b = Xᵀy for design rows X[i] -----------------
function lstsq(X: number[][], y: number[]): number[] {
  const k = X[0].length;
  const A = Array.from({ length: k }, () => new Array(k).fill(0));
  const bv = new Array(k).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let a = 0; a < k; a++) {
      bv[a] += X[i][a] * y[i];
      for (let b = 0; b < k; b++) A[a][b] += X[i][a] * X[i][b];
    }
  }
  // Gaussian elimination with partial pivoting
  for (let c = 0; c < k; c++) {
    let piv = c; for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    [A[c], A[piv]] = [A[piv], A[c]]; [bv[c], bv[piv]] = [bv[piv], bv[c]];
    const d = A[c][c] || 1e-9;
    for (let r = 0; r < k; r++) { if (r === c) continue; const f = A[r][c] / d; for (let cc = 0; cc < k; cc++) A[r][cc] -= f * A[c][cc]; bv[r] -= f * bv[c]; }
  }
  return bv.map((v, i) => v / (A[i][i] || 1e-9));
}

// mulberry32 — seeded shuffle so the split is reproducible.
function shuffle<T>(arr: readonly T[], seed: number): T[] {
  let a = seed >>> 0; const out = arr.slice();
  const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

type Floor = Readonly<{ cFont: number; cPad: number; c0: number; rowSpecOffset: number }>;

// NOTE: border width is deliberately NOT a feature. The A/B test showed Google
// draws a cell border INSIDE the cell box without growing the row — adding a
// border term only over-predicts thick-border rows (held-out RMSE 1.51→1.14px
// when removed). Row height is driven purely by font line-box + vertical padding.
function floorOf(f: Floor, p: { font: number; padY: number; lines: number }): number {
  return f.cFont * p.font * p.lines + f.cPad * 2 * p.padY + f.c0;
}
function predictRowH(f: Floor, p: { spec: number; font: number; padY: number; lines: number }): number {
  return Math.max(p.spec + f.rowSpecOffset, floorOf(f, p));
}

function fitFloor(train: RowPt[]): Floor {
  // rowSpecOffset from spec-dominated points (|rend-spec|<6).
  const sd = train.filter((r) => Math.abs(r.rend - r.spec) < 6);
  const rowSpecOffset = sd.length ? sd.reduce((a, r) => a + (r.rend - r.spec), 0) / sd.length : 0;
  // floor-active: rendered clearly above the specified height → the floor set it.
  const fa = train.filter((r) => r.rend > r.spec + 3);
  // robust: two reweighting passes dropping the worst 10% residuals (kills the
  // occasional band-merge mismeasure).
  const feat = (r: RowPt) => [r.font * r.lines, 2 * r.padY, 1];
  let keep = fa;
  let b = lstsq(keep.map(feat), keep.map((r) => r.rend));
  for (let pass = 0; pass < 2; pass++) {
    const resid = fa.map((r) => Math.abs(feat(r).reduce((a, v, j) => a + v * b[j], 0) - r.rend));
    const cut = resid.slice().sort((p, q) => p - q)[Math.floor(resid.length * 0.9)];
    keep = fa.filter((_, i) => resid[i] <= cut);
    b = lstsq(keep.map(feat), keep.map((r) => r.rend));
  }
  return { cFont: b[0], cPad: b[1], c0: b[2], rowSpecOffset };
}

function metrics(pred: number[], act: number[]) {
  const n = pred.length;
  const err = pred.map((p, i) => p - act[i]);
  const rmse = Math.sqrt(err.reduce((a, e) => a + e * e, 0) / n);
  const mae = err.reduce((a, e) => a + Math.abs(e), 0) / n;
  const maxe = Math.max(...err.map(Math.abs));
  const w1 = err.filter((e) => Math.abs(e) <= 1).length / n;
  const w2 = err.filter((e) => Math.abs(e) <= 2).length / n;
  const mean = act.reduce((a, v) => a + v, 0) / n;
  const ssTot = act.reduce((a, v) => a + (v - mean) ** 2, 0);
  const ssRes = err.reduce((a, e) => a + e * e, 0);
  const r2 = 1 - ssRes / (ssTot || 1);
  return { n, rmse, mae, maxe, w1, w2, r2 };
}
const f2 = (x: number) => x.toFixed(2);
const pct = (x: number) => (100 * x).toFixed(1) + "%";

// --- main --------------------------------------------------------------------
const args = process.argv.slice(2);
const paths = args.length ? args : [join(HERE, "_fuzz", "dataset.json")];
for (const p of paths) if (!existsSync(p)) { console.error("missing dataset:", p); process.exit(1); }

const sets = paths.map(loadPoints);
const allRows = sets.flatMap((s) => s.rows);
const allCols = sets.flatMap((s) => s.cols);

// Split: if ≥2 datasets, last is the independent held-out test. Else 70/30.
let trainRows: RowPt[], testRows: RowPt[], trainCols: ColPt[], testCols: ColPt[], splitDesc: string;
if (paths.length >= 2) {
  trainRows = sets.slice(0, -1).flatMap((s) => s.rows); testRows = sets[sets.length - 1].rows;
  trainCols = sets.slice(0, -1).flatMap((s) => s.cols); testCols = sets[sets.length - 1].cols;
  splitDesc = `train = first ${paths.length - 1} dataset(s), TEST = independent fuzz seed (${paths[paths.length - 1]})`;
} else {
  const sr = shuffle(allRows, 7), sc = shuffle(allCols, 7);
  const rCut = Math.floor(sr.length * 0.7), cCut = Math.floor(sc.length * 0.7);
  trainRows = sr.slice(0, rCut); testRows = sr.slice(rCut);
  trainCols = sc.slice(0, cCut); testCols = sc.slice(cCut);
  splitDesc = "random 70/30 train/test split (seed 7)";
}

const floor = fitFloor(trainRows);
// column fit: rend = cW*spec + cW0
const cb = lstsq(trainCols.map((c) => [c.spec, 1]), trainCols.map((c) => c.rend));
const colModel = { cW: cb[0], cW0: cb[1] };

const rowTrainM = metrics(trainRows.map((r) => predictRowH(floor, r)), trainRows.map((r) => r.rend));
const rowTestM = metrics(testRows.map((r) => predictRowH(floor, r)), testRows.map((r) => r.rend));
const colTestM = metrics(testCols.map((c) => colModel.cW * c.spec + colModel.cW0), testCols.map((c) => c.rend));

console.log(`\n================  GENERIC GOOGLE-SLIDES TABLE MODEL — FIT & VALIDATION  ================`);
console.log(`data: ${allRows.length} row-height + ${allCols.length} col-width points  (${allRows.length + allCols.length} total)`);
console.log(`split: ${splitDesc}`);
console.log(`        rows  train ${trainRows.length} / test ${testRows.length}     cols  train ${trainCols.length} / test ${testCols.length}`);

console.log(`\n---- ROW-HEIGHT MODEL ----`);
console.log(`  rendered = max( spec + ${f2(floor.rowSpecOffset)},  ${f2(floor.cFont)}·font·lines + ${f2(floor.cPad)}·(2·padY) + ${f2(floor.c0)} )`);
console.log(`  (interpretation: line-box ≈ ${f2(floor.cFont)}× font/line; padding passes ~${f2(floor.cPad)}×; border does NOT grow the row)`);
const showM = (name: string, m: ReturnType<typeof metrics>) =>
  console.log(`  ${name.padEnd(12)} n=${String(m.n).padStart(3)}  RMSE=${f2(m.rmse)}px  MAE=${f2(m.mae)}px  max=${f2(m.maxe)}px  ≤1px=${pct(m.w1)}  ≤2px=${pct(m.w2)}  R²=${m.r2.toFixed(4)}`);
showM("TRAIN", rowTrainM); showM("TEST(held)", rowTestM);

console.log(`\n---- COLUMN-WIDTH MODEL ----`);
console.log(`  rendered = ${f2(colModel.cW)}·spec + ${f2(colModel.cW0)}`);
showM("TEST(held)", colTestM);

// predicted-vs-actual sample table on the held-out rows (worst 12 by error +
// a spread), to expose any structure.
console.log(`\n---- HELD-OUT ROW PREDICTIONS (worst 16 by |error|) ----`);
console.log(`   spec font line padY bd |  predicted   actual   err`);
const withErr = testRows.map((r) => ({ r, pred: predictRowH(floor, r), err: predictRowH(floor, r) - r.rend }));
withErr.sort((a, b) => Math.abs(b.err) - Math.abs(a.err));
for (const { r, pred, err } of withErr.slice(0, 16)) {
  console.log(`   ${String(r.spec).padStart(4)} ${String(r.font).padStart(4)} ${String(r.lines).padStart(4)} ${String(r.padY).padStart(4)} ${String(r.border).padStart(2)} |   ${f2(pred).padStart(7)}  ${f2(r.rend).padStart(7)}  ${(err >= 0 ? "+" : "") + f2(err)}`);
}

// emit the model module
const model = `// google-table-model.ts — AUTO-GENERATED by google-table-fit.ts.
// Generic empirical model of Google Slides' imported-table geometry, fit from
// ${allRows.length} row + ${allCols.length} column measurements across fuzzed font/border/padding/
// row/column/table sizes. Held-out TEST: row RMSE ${f2(rowTestM.rmse)}px (R² ${rowTestM.r2.toFixed(3)},
// ${pct(rowTestM.w1)} within 1px), col RMSE ${f2(colTestM.rmse)}px. Units: CSS px @ 96dpi.
export const GOOGLE_TABLE = {
  cFontPerLine: ${floor.cFont.toFixed(4)},   // line-box height per text line
  cPad2: ${floor.cPad.toFixed(4)},           // multiplies (2·padYpx)
  c0Px: ${floor.c0.toFixed(4)},
  rowSpecOffsetPx: ${floor.rowSpecOffset.toFixed(4)},
  colScale: ${colModel.cW.toFixed(5)},
  colOffsetPx: ${colModel.cW0.toFixed(4)},
};

/** Predicted RENDERED row height (CSS px) Google gives an imported table row.
 *  Border width is intentionally ignored — measured to not grow the row. */
export function predictGoogleRowHeight(opts: {
  specifiedPx: number; fontPx: number; lines?: number; padYpx?: number;
}): number {
  const lines = opts.lines ?? 1, padY = opts.padYpx ?? 0;
  const floor = GOOGLE_TABLE.cFontPerLine * opts.fontPx * lines
    + GOOGLE_TABLE.cPad2 * 2 * padY + GOOGLE_TABLE.c0Px;
  return Math.max(opts.specifiedPx + GOOGLE_TABLE.rowSpecOffsetPx, floor);
}

/** Predicted RENDERED column width (CSS px). */
export function predictGoogleColWidth(specifiedPx: number): number {
  return GOOGLE_TABLE.colScale * specifiedPx + GOOGLE_TABLE.colOffsetPx;
}

/** Largest cell font (px) whose single line-box still fits a target row height —
 *  set the cell font/line-height to this to STOP Google auto-growing the row. */
export function maxFontForRowHeight(targetRowPx: number, padYpx = 0): number {
  const avail = targetRowPx - GOOGLE_TABLE.cPad2 * 2 * padYpx - GOOGLE_TABLE.c0Px;
  return Math.max(1, Math.floor(avail / GOOGLE_TABLE.cFontPerLine));
}
`;
writeFileSync(join(HERE, "google-table-model.ts"), model);
console.log(`\nwrote google-table-model.ts`);
