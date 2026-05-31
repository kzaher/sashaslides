/**
 * google-table-fuzz.ts — collect HUNDREDS of (spec → rendered) data points for
 * Google Slides table geometry, across fuzzed font / border / padding / row /
 * column / table sizes, so a GENERIC layout model can be fit + held-out
 * validated (see google-table-fit.ts).
 *
 * Why: Google Slides re-rasterises imported tables with its own row-height
 * floor, cell insets and column quantisation. The rounded corner-mask overlays
 * in convert-pptx-lib.ts must be placed where Google ACTUALLY renders each cell
 * edge — not where the HTML spec puts them — or they drift (the visible
 * "anomalies"). We can't derive Google's rules, so we measure them at scale.
 *
 * Each fuzzed table is one slide: a fixed-layout grid of solid-colour cells
 * (a checkerboard so every row AND column boundary is a crisp colour
 * transition). record-rendering --mode full packs ALL slides into ONE pptx,
 * uploads once, and scrapes a thumbnail per slide — so ~100 tables cost a
 * single upload. We then measure, per table, every rendered row-band height,
 * column-band width and the table origin, in CSS px.
 *
 * Subcommands (run from renderer/):
 *   npx tsx html2slides/e2e/google-table-fuzz.ts gen [N] [seed]
 *       → writes _fuzz/fixtures/*.html + _fuzz/specs.json (ground-truth specs)
 *       → prints the slide-id CSV to feed record-rendering
 *   # then render (one upload):
 *   npx tsx structured-prompts/bug_solving/scripts/record-rendering.ts \
 *       --mode full --fixtures html2slides/e2e/_fuzz/fixtures \
 *       --slides "<csv>" --out html2slides/e2e/_fuzz/out --title gtl-fuzz
 *   npx tsx html2slides/e2e/google-table-fuzz.ts measure
 *       → reads _fuzz/out/thumbs/*.png + specs.json → _fuzz/dataset.json
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "_fuzz");
const FIX = join(ROOT, "fixtures");
const OUT = join(ROOT, "out");
const BODY_W = 1280;            // fixture body width maps 1:1 to the slide width
const TABLE_LEFT = 80;          // table origin in the fixture (CSS px)
const TABLE_TOP = 80;

// ---- seeded PRNG (mulberry32) — reproducible fuzzing, no Math.random --------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- spec types -------------------------------------------------------------
type CellSpec = Readonly<{ color: string; lines: number }>;
type TableSpec = Readonly<{
  id: string;
  rowHeightsPx: readonly number[];   // specified <tr> heights
  colWidthsPx: readonly number[];    // specified <col> widths
  fontPx: number;
  borderPx: number;                  // 0..3, collapsed border on every cell
  padXPx: number;
  padYPx: number;
  cells: readonly (readonly CellSpec[])[];  // [row][col]
}>;

function hsl(i: number, n: number): string {
  const h = Math.round((360 * i) / Math.max(1, n));
  return `hsl(${h} 70% 55%)`;
}

function genSpec(idx: number, r: () => number): TableSpec {
  const pick = <T,>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)];
  const nRows = 1 + Math.floor(r() * 6);          // 1..6
  const nCols = 1 + Math.floor(r() * 4);          // 1..4
  const fontPx = pick([6, 8, 10, 11, 12, 14, 16, 18, 20, 24, 28]);
  const borderPx = pick([0, 0, 1, 1, 2, 3]);      // weight toward 0/1 (common)
  const padXPx = pick([0, 2, 4, 6, 8]);
  const padYPx = pick([0, 1, 2, 4, 6]);
  const rowHeightsPx = Array.from({ length: nRows }, () => pick([8, 12, 16, 20, 24, 30, 40, 50, 60]));
  // column widths sum to a fuzzed table width in [360, 1040]
  const totalW = 360 + Math.floor(r() * 680);
  const raw = Array.from({ length: nCols }, () => 0.5 + r());
  const rawSum = raw.reduce((a, c) => a + c, 0);
  const colWidthsPx = raw.map((w) => Math.round((w / rawSum) * totalW));
  let colorK = 0;
  const cells = Array.from({ length: nRows }, (_, ri) =>
    Array.from({ length: nCols }, (_, ci) => {
      const lines = r() < 0.25 ? 1 + Math.floor(r() * 3) : 1; // mostly single-line
      return { color: hsl(colorK++, nRows * nCols), lines } as CellSpec;
    }),
  );
  return { id: `fz_${String(idx).padStart(3, "0")}`, rowHeightsPx, colWidthsPx, fontPx, borderPx, padXPx, padYPx, cells };
}

function genFixture(s: TableSpec): string {
  const cols = s.colWidthsPx.map((w) => `<col style="width:${w}px">`).join("");
  const bd = s.borderPx > 0 ? `border:${s.borderPx}px solid #111;` : "border:0;";
  const rows = s.cells.map((row, ri) => {
    const tds = row.map((c) => {
      const txt = Array.from({ length: c.lines }, (_, k) => `x${k}`).join("<br>");
      return `<td style="background:${c.color};font-size:${s.fontPx}px;line-height:${s.fontPx}px;` +
        `padding:${s.padYPx}px ${s.padXPx}px;${bd}">${txt}</td>`;
    }).join("");
    return `<tr style="height:${s.rowHeightsPx[ri]}px">${tds}</tr>`;
  }).join("\n");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { width:${BODY_W}px; height:720px; background:#fff; font-family:Arial, sans-serif; }
.wrap { position:absolute; left:${TABLE_LEFT}px; top:${TABLE_TOP}px; }
table { border-collapse:collapse; table-layout:fixed; }
td { vertical-align:middle; color:#000; overflow:hidden; }
</style></head><body>
<div class="wrap"><table><colgroup>${cols}</colgroup>
${rows}
</table></div></body></html>`;
}

// ---- measurement ------------------------------------------------------------
type Measured = Readonly<{
  id: string;
  scale: number;
  originXpx: number; originYpx: number;     // table origin in CSS px
  rowHeightsPx: readonly number[];          // rendered row-band heights
  colWidthsPx: readonly number[];           // rendered column-band widths
  tableWpx: number; tableHpx: number;
}>;

function measureTable(thumbPath: string, s: TableSpec): Measured | null {
  const png = PNG.sync.read(readFileSync(thumbPath));
  const { width: W, height: H, data } = png;
  const scale = W / BODY_W;
  const at = (x: number, y: number) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  const isWhite = (p: number[]) => p[0] > 244 && p[1] > 244 && p[2] > 244;
  // table bbox = the non-white blob nearest the known origin.
  const ex = Math.round(TABLE_LEFT * scale), ey = Math.round(TABLE_TOP * scale);
  const colHasInk = (x: number) => { for (let y = Math.max(0, ey - 10); y < H; y++) if (!isWhite(at(x, y))) return true; return false; };
  const rowHasInk = (y: number) => { for (let x = Math.max(0, ex - 10); x < W; x++) if (!isWhite(at(x, y))) return true; return false; };
  let left = ex; while (left > 0 && colHasInk(left - 1)) left--;
  while (left < W && !colHasInk(left)) left++;
  let top = ey; while (top > 0 && rowHasInk(top - 1)) top--;
  while (top < H && !rowHasInk(top)) top++;
  let right = left; while (right + 1 < W && colHasInk(right + 1)) right++;
  let bottom = top; while (bottom + 1 < H && rowHasInk(bottom + 1)) bottom++;
  if (right <= left || bottom <= top) return null;

  // --- Projection/consensus boundary detection ---------------------------
  // A TRUE row boundary spans the whole table width: every column's colour
  // changes at that y. Text glyphs / column boundaries change only a few x, so
  // averaging the colour across the full width (a "row signature") cancels them
  // — leaving sharp signature jumps only at real row boundaries. Symmetric for
  // columns. This is robust to multi-line text, thick borders and per-cell hues.
  // profile along `axis`, averaging colour over the orthogonal range [olo,ohi].
  // `huesOnly` skips near-black (text/border) and near-white pixels so only the
  // saturated cell fills contribute — essential for COLUMN detection, where the
  // cross-section otherwise runs through centred text glyphs.
  const colorful = (p: number[]) => { const mx = Math.max(p[0], p[1], p[2]), mn = Math.min(p[0], p[1], p[2]); return mx - mn > 25 && mx > 60; };
  const profile = (axis: "row" | "col", lo: number, hi: number, olo: number, ohi: number, huesOnly = false) => {
    const sig: number[][] = [];
    for (let p = lo; p <= hi; p++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let o = olo; o <= ohi; o += 1) { const c = axis === "row" ? at(o, p) : at(p, o); if (huesOnly && !colorful(c)) continue; r += c[0]; g += c[1]; b += c[2]; n++; }
      if (n === 0) sig.push([255, 255, 255]); else sig.push([r / n, g / n, b / n]);
    }
    return sig;
  };
  // boundaries = grouped signature-derivative peaks, weighted-centred, with
  // boundaries within `dropEdge` of either end discarded (those are the table's
  // OWN outer border, already captured by the bbox — not an interior cell edge).
  const boundaries = (sig: number[][], span: number): number[] => {
    const d = sig.map((c, i) => i === 0 ? 0 : Math.abs(c[0] - sig[i - 1][0]) + Math.abs(c[1] - sig[i - 1][1]) + Math.abs(c[2] - sig[i - 1][2]));
    const win = Math.max(2, Math.round(scale * 4));
    const dropEdge = Math.max(scale * 2.5, scale * (s.borderPx + 2));
    const TH = 28;
    const cand: number[] = [];
    for (let i = 1; i < d.length; i++) if (d[i] > TH) cand.push(i);
    const out: number[] = [];
    let gPrev = -1e9, num = 0, den = 0;
    const flush = () => { if (den > 0) { const c = num / den; if (c > dropEdge && c < span - dropEdge) out.push(c); } num = 0; den = 0; };
    for (const i of cand) { if (i - gPrev > win) flush(); num += i * d[i]; den += d[i]; gPrev = i; }
    flush();
    return out;
  };
  // ROWS: project across the full width.
  const rowBs = boundaries(profile("row", top, bottom, left, right), bottom - top);
  // COLUMNS: within the TALLEST row band, take the per-column MEDIAN hue over
  // the full band height (skipping dark text/border + white). Text is a vertical
  // minority, so the median locks onto the solid cell fill — no AA-fringe band.
  const rowEdges = [top, ...rowBs.map((b) => top + b), bottom];
  let ta = top, tb = bottom, best = -1;
  for (let i = 1; i < rowEdges.length; i++) { const h = rowEdges[i] - rowEdges[i - 1]; if (h > best) { best = h; ta = Math.round(rowEdges[i - 1]); tb = Math.round(rowEdges[i]); } }
  const med = (xs: number[]) => xs.length ? xs.slice().sort((a, b) => a - b)[xs.length >> 1] : 255;
  const colSig: number[][] = [];
  for (let x = left; x <= right; x++) {
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    for (let y = ta; y <= tb; y++) { const c = at(x, y); if (!colorful(c)) continue; rs.push(c[0]); gs.push(c[1]); bs.push(c[2]); }
    colSig.push([med(rs), med(gs), med(bs)]);
  }
  const colBs = boundaries(colSig, right - left);
  if (process.env.DBG === s.id) {
    const d = colSig.map((c, i) => i === 0 ? 0 : Math.abs(c[0] - colSig[i - 1][0]) + Math.abs(c[1] - colSig[i - 1][1]) + Math.abs(c[2] - colSig[i - 1][2]));
    const peaks = d.map((v, i) => [i, +v.toFixed(0)] as const).filter(([, v]) => v > 10);
    console.error(`DBG ${s.id}: rowBand=[${ta},${tb}] left=${left} right=${right} colDeriv peaks(>10)=${JSON.stringify(peaks)}`);
  }
  const toBands = (bs: number[], span: number) => {
    const edges = [0, ...bs, span];
    const out: number[] = [];
    for (let i = 1; i < edges.length; i++) out.push(+(((edges[i] - edges[i - 1]) / scale)).toFixed(2));
    return out;
  };
  return {
    id: s.id, scale: +scale.toFixed(4),
    originXpx: +(left / scale).toFixed(2), originYpx: +(top / scale).toFixed(2),
    rowHeightsPx: toBands(rowBs, bottom - top),
    colWidthsPx: toBands(colBs, right - left),
    tableWpx: +(((right - left) / scale)).toFixed(2),
    tableHpx: +(((bottom - top) / scale)).toFixed(2),
  };
}

// ---- subcommands ------------------------------------------------------------
function cmdGen(N: number, seed: number) {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(FIX, { recursive: true });
  const r = rng(seed);
  const specs: TableSpec[] = [];
  for (let i = 0; i < N; i++) {
    const s = genSpec(i, r);
    specs.push(s);
    writeFileSync(join(FIX, `${s.id}.html`), genFixture(s));
  }
  writeFileSync(join(ROOT, "specs.json"), JSON.stringify(specs, null, 2));
  const csv = specs.map((s) => s.id).join(",");
  writeFileSync(join(ROOT, "slides.csv"), csv);
  console.error(`gen: wrote ${N} fixtures (seed ${seed}) → ${FIX}`);
  console.log(csv); // stdout = the CSV for record-rendering
}

function cmdMeasure() {
  const specs: TableSpec[] = JSON.parse(readFileSync(join(ROOT, "specs.json"), "utf-8"));
  const thumbs = join(OUT, "thumbs");
  if (!existsSync(thumbs)) throw new Error(`no thumbs dir at ${thumbs} — render first`);
  const have = new Set(readdirSync(thumbs).filter((f) => f.endsWith(".png")).map((f) => f.replace(/\.png$/, "")));
  const data: Measured[] = [];
  let miss = 0;
  for (const s of specs) {
    if (!have.has(s.id)) { miss++; continue; }
    const m = measureTable(join(thumbs, `${s.id}.png`), s);
    if (m) data.push(m); else miss++;
  }
  writeFileSync(join(ROOT, "dataset.json"), JSON.stringify({ specs, measured: data }, null, 2));
  console.error(`measure: ${data.length} tables measured, ${miss} missing/failed → ${join(ROOT, "dataset.json")}`);
}

const cmd = process.argv[2];
if (cmd === "gen") cmdGen(parseInt(process.argv[3] ?? "100", 10), parseInt(process.argv[4] ?? "12345", 10));
else if (cmd === "measure") cmdMeasure();
else { console.error("usage: google-table-fuzz.ts gen [N] [seed] | measure"); process.exit(1); }
