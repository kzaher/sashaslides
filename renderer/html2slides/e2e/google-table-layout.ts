/**
 * google-table-layout.ts — reverse-engineer Google Slides' table row-layout by
 * MEASUREMENT (closed-loop), not prediction.
 *
 * Google's renderer auto-grows table rows: a row never renders shorter than an
 * undocumented "minimum row height" floor (≈ font line-height + cell insets),
 * and grows further to fit content. The converter can't compute that floor, so
 * rounded corner-mask overlays drift. This harness measures the floor (and how
 * specified height / font size / content drive the rendered height) by:
 *
 *   1. emitting controlled test-table fixtures (each ROW probes one config;
 *      distinct solid colors make row boundaries crisp),
 *   2. rendering each through the REAL pipeline → Google Slides → scraped
 *      thumbnail (record-rendering.ts --mode full),
 *   3. measuring each row's rendered pixel band in the thumbnail and converting
 *      to CSS px (thumbnail maps the 1280px-wide fixture body 1:1 to the slide),
 *   4. writing the raw measurements (google-table-measurements.json) AND an
 *      importable model module (google-table-model.ts).
 *
 * Run from renderer/ (node_modules):
 *   cd /workspaces/sashaslides/renderer && \
 *     npx tsx html2slides/e2e/google-table-layout.ts [caseId ...]
 *
 * NOTE: needs Chrome on :9222 + a working Drive/Slides upload (same prereqs as
 * record-rendering --mode full). Each case = one Slides upload (~20-30s).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(HERE, "..", "..");                 // /workspaces/sashaslides/renderer
const FIXTURES = join(HERE, "_gtl-fixtures");            // generated test fixtures
const OUT = join(HERE, "_gtl-out");                      // render outputs
const RECORD = join(HERE, "..", "..", "structured-prompts", "bug_solving", "scripts", "record-rendering.ts");

const BODY_W = 1280;          // fixture body width → maps 1:1 to the slide width
const CSS_DPI = 96;           // 1280px body / 96 = 13.33" slide

interface RowSpec { heightPx: number; fontPx: number; text: string; border: boolean; }
interface Case { id: string; desc: string; rows: RowSpec[]; }

// Distinct, easily-separated solid colors per row index.
function rowColor(i: number): string {
  const palette = ["#e74c3c", "#3498db", "#2ecc71", "#f1c40f", "#9b59b6", "#1abc9c",
                   "#e67e22", "#34495e", "#16a085", "#c0392b", "#2980b9", "#27ae60"];
  return palette[i % palette.length];
}

// --- Test matrix ----------------------------------------------------------
// Each case is one slide; each ROW probes one (heightPx, fontPx, text, border).
const CASES: Case[] = [
  {
    id: "floor_vs_specified",
    desc: "Shrinking specified row height, tiny font, no text — find the min-row-height FLOOR.",
    rows: [40, 30, 24, 20, 16, 12, 10, 8, 6, 4].map((h) => ({ heightPx: h, fontPx: 1, text: "", border: false })),
  },
  {
    id: "floor_vs_font",
    desc: "Fixed tiny specified height (2px), increasing font size, no text — does the floor track font line-height?",
    rows: [1, 4, 6, 8, 10, 12, 14, 18, 24, 32].map((f) => ({ heightPx: 2, fontPx: f, text: "", border: false })),
  },
  {
    id: "border_effect",
    desc: "Tiny specified height, tiny font, toggling a 1px border — does a border raise the floor?",
    rows: Array.from({ length: 8 }, (_, i) => ({ heightPx: 2, fontPx: 1, text: "", border: i % 2 === 1 })),
  },
  {
    // Merged from the parallel codex attempt's matrix: it found "multi-line
    // rows track their explicit content line-box" — i.e. the floor becomes
    // lines × 1.2 × fontPx. Tiny specified height + fixed font, increasing line
    // count, so content (not the single-line floor) dominates.
    id: "multiline_content",
    desc: "Fixed font, tiny specified height, increasing line count — does the row track lines × 1.2 × font?",
    rows: [1, 2, 3, 4, 5].map((lines) => ({
      heightPx: 2, fontPx: 12, border: false,
      text: Array.from({ length: lines }, (_, k) => `L${k}`).join("<br>"),
    })),
  },
];

// --- Fixture generation ---------------------------------------------------
function genFixture(c: Case): string {
  // One table, full content width, rows with distinct solid backgrounds. No
  // body padding so the table sits at the slide origin (easy to locate).
  const rows = c.rows.map((r, i) => {
    const bd = r.border ? "border:1px solid #000;" : "border:0;";
    // collapse line-height to the font so the cell's own min is font-driven.
    return `<tr style="height:${r.heightPx}px"><td style="background:${rowColor(i)};font-size:${r.fontPx}px;line-height:${r.fontPx}px;padding:0;${bd}">${r.text || "&nbsp;"}</td></tr>`;
  }).join("\n  ");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { width:${BODY_W}px; height:720px; overflow:hidden; background:#ffffff; font-family:Arial, sans-serif; }
table { border-collapse:collapse; width:300px; table-layout:fixed; }
td { vertical-align:middle; }
</style></head><body>
<table>
  ${rows}
</table>
</body></html>`;
}

// --- Render via the real pipeline ----------------------------------------
function render(c: Case): string {
  mkdirSync(FIXTURES, { recursive: true });
  // Per-case out dir — record-rendering caches by output presence, so a shared
  // dir makes later cases skip (find the prior case's pptx/manifest). Fresh dir
  // per case forces a real convert + upload + scrape each time.
  const out = join(OUT, c.id);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  writeFileSync(join(FIXTURES, `${c.id}.html`), genFixture(c));
  // record-rendering --mode full: convert → upload to Slides → scrape thumb.
  execFileSync("npx", [
    "tsx", RECORD, "--mode", "full",
    "--fixtures", FIXTURES, "--slides", c.id, "--out", out,
  ], { cwd: RENDERER, stdio: "inherit", maxBuffer: 64 * 1024 * 1024 });
  const thumb = join(out, "thumbs", `${c.id}.png`);
  if (!existsSync(thumb)) throw new Error(`no thumbnail produced for ${c.id} at ${thumb}`);
  return thumb;
}

// --- Measurement ----------------------------------------------------------
// Scan a vertical line through the table column; group consecutive rows of
// near-constant color into bands = rendered rows. Convert px→CSS via the
// thumbnail-to-body scale (thumbnail width maps 1:1 to the 1280px body).
function measure(thumbPath: string, c: Case) {
  const png = PNG.sync.read(readFileSync(thumbPath));
  const { width: W, height: H, data } = png;
  const scale = W / BODY_W;                  // thumbnail px per CSS px
  const col = Math.round(150 * scale);       // table is 300px wide → scan its middle
  const at = (x: number, y: number) => {
    const idx = (y * W + x) * 4;
    return [data[idx], data[idx + 1], data[idx + 2]];
  };
  const isWhite = (p: number[]) => p[0] > 245 && p[1] > 245 && p[2] > 245;
  const near = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 60;

  // Walk down the column, splitting into non-white color bands.
  const bands: { startY: number; endY: number; color: number[] }[] = [];
  let cur: { startY: number; endY: number; color: number[] } | null = null;
  for (let y = 0; y < H; y++) {
    const p = at(col, y);
    if (isWhite(p)) { if (cur) { bands.push(cur); cur = null; } continue; }
    if (cur && near(cur.color, p)) { cur.endY = y; }
    else { if (cur) bands.push(cur); cur = { startY: y, endY: y, color: p }; }
  }
  if (cur) bands.push(cur);

  // bands (top→down) should correspond 1:1 to rows. Heights in CSS px.
  const renderedCssPx = bands.map((b) => +(((b.endY - b.startY + 1) / scale)).toFixed(2));
  return {
    thumb: { width: W, height: H, scale: +scale.toFixed(3) },
    bandCount: bands.length,
    rows: c.rows.map((r, i) => ({
      specifiedHeightPx: r.heightPx,
      fontPx: r.fontPx,
      border: r.border,
      renderedHeightPx: renderedCssPx[i] ?? null,
      autoGrowPx: renderedCssPx[i] != null ? +(renderedCssPx[i] - r.heightPx).toFixed(2) : null,
    })),
  };
}

// --- Model emission -------------------------------------------------------
function emitModel(allMeasurements: Record<string, ReturnType<typeof measure>>): string {
  // Fit floor = slope*fontPx + intercept from the font-sweep case (rows whose
  // specified height is tiny, so the rendered height IS the floor). Linear
  // least squares over font >= 4 (font=1 is dominated by the absolute minimum).
  const fontCase = allMeasurements["floor_vs_font"];
  let slope = 1.2, intercept = 0;
  if (fontCase) {
    const pts = fontCase.rows
      .filter((r) => r.renderedHeightPx != null && r.fontPx >= 4)
      .map((r) => [r.fontPx, r.renderedHeightPx as number] as const);
    if (pts.length >= 2) {
      const n = pts.length;
      const sx = pts.reduce((a, p) => a + p[0], 0);
      const sy = pts.reduce((a, p) => a + p[1], 0);
      const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0);
      const sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
      slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      intercept = (sy - slope * sx) / n;
    }
  }
  // Absolute minimum: smallest floor observed at font=1.
  const f1 = fontCase?.rows.find((r) => r.fontPx === 1)?.renderedHeightPx ?? 3;
  const absMinPx = Math.max(0, +f1.toFixed(2));
  return `// google-table-model.ts — AUTO-GENERATED by google-table-layout.ts.
// Empirical model of Google Slides' table row layout, fit from rendered
// measurements (google-table-measurements.json). Heights are CSS px (96dpi).
//
// KEY LAW: a table row never renders shorter than ~one line-box of its cell's
// font (line-height ≈ ${slope.toFixed(2)}), with a ~${absMinPx}px absolute minimum; beyond that
// it honors the specified height, and grows further for content. So the
// auto-grow that breaks rounded corner-mask overlays is FONT-DRIVEN and
// PREDICTABLE — to kill it, either shrink the cell font/line-height so the
// floor drops below the target row height, or position the masks at
// predictGoogleRowHeight() instead of the specified height.
export const GOOGLE_TABLE = {
  lineHeightFactor: ${slope.toFixed(3)},   // rendered floor ≈ factor * fontPx
  floorInterceptPx: ${intercept.toFixed(2)},
  absMinRowHeightPx: ${absMinPx},
};

/** Predicted RENDERED row height in CSS px for a single-line / empty cell. */
export function predictGoogleRowHeight(opts: {
  specifiedPx: number; fontPx: number; contentPx?: number;
}): number {
  const fontFloor = GOOGLE_TABLE.lineHeightFactor * opts.fontPx + GOOGLE_TABLE.floorInterceptPx;
  const floor = Math.max(GOOGLE_TABLE.absMinRowHeightPx, fontFloor);
  return Math.max(opts.specifiedPx, opts.contentPx ?? 0, floor);
}

/** Largest cell font (px) whose line-box still fits within a target row height
 *  — i.e. set the cell's font/line-height to this to STOP Google auto-growing
 *  the row past your specified height (the corner-mask fix). */
export function maxFontForRowHeight(targetRowPx: number): number {
  return Math.max(1, Math.floor((targetRowPx - GOOGLE_TABLE.floorInterceptPx) / GOOGLE_TABLE.lineHeightFactor));
}
`;
}

// --- Main -----------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  // --remodel: re-fit + re-emit the model from the saved measurements (no
  // render/upload). Use after editing emitModel to iterate on the fit.
  if (args.includes("--remodel")) {
    const saved = JSON.parse(readFileSync(join(HERE, "google-table-measurements.json"), "utf-8"));
    writeFileSync(join(HERE, "google-table-model.ts"), emitModel(saved));
    console.error("re-emitted google-table-model.ts from saved measurements");
    return;
  }
  const only = args;
  const cases = only.length ? CASES.filter((c) => only.includes(c.id)) : CASES;
  if (!cases.length) { console.error("no matching cases. available:", CASES.map((c) => c.id).join(", ")); process.exit(1); }

  const results: Record<string, ReturnType<typeof measure>> = {};
  for (const c of cases) {
    console.error(`\n=== ${c.id}: ${c.desc} ===`);
    const thumb = render(c);
    const m = measure(thumb, c);
    results[c.id] = m;
    console.error(`  thumb ${m.thumb.width}x${m.thumb.height} (scale ${m.thumb.scale}), bands=${m.bandCount} vs rows=${c.rows.length}`);
    for (const r of m.rows) {
      console.error(`  spec=${String(r.specifiedHeightPx).padStart(3)}px font=${String(r.fontPx).padStart(2)}px border=${r.border ? "Y" : "N"} → rendered=${r.renderedHeightPx}px (autogrow ${r.autoGrowPx}px)`);
    }
  }

  writeFileSync(join(HERE, "google-table-measurements.json"), JSON.stringify(results, null, 2));
  writeFileSync(join(HERE, "google-table-model.ts"), emitModel(results));
  console.error(`\nWrote google-table-measurements.json + google-table-model.ts`);
  console.error(`(import { predictGoogleRowHeight } from "./e2e/google-table-model" once iterated.)`);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
