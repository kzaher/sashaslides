/**
 * google-table-border-study.ts — isolate how table BORDERS affect Google's
 * stored grid geometry, separating the variables the blended `1.26·border`
 * coefficient hides: HORIZONTAL vs VERTICAL borders, thickness, count
 * (rows/cols), and EDGE vs INTERIOR position (border-collapse shares interior
 * borders between neighbours, so an interior row may get half of each).
 *
 * Everything else is FIXED (font 14, padY 2, padX 4, tiny spec height so the
 * floor governs) so the only thing moving is the border config. Measured via
 * the EXACT Slides API grid (presentations.get), not pixels.
 *
 * Subcommands (run from renderer/):
 *   gen      → _border/fixtures/*.html + _border/specs.json + slides.csv
 *   analyze  → reads _border/out/thumbs/manifest.json + the API → _border/border.json + breakdown
 *
 * Between them:
 *   npx tsx structured-prompts/bug_solving/scripts/record-rendering.ts \
 *     --mode full --fixtures html2slides/e2e/_border/fixtures \
 *     --slides "$(cat html2slides/e2e/_border/slides.csv)" \
 *     --out html2slides/e2e/_border/out --title gtl-border
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { google } from "googleapis";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "_border");
const FIX = join(ROOT, "fixtures");
const OUT = join(ROOT, "out");
const FONT = 14, PADX = 4, PADY = 2, SPEC_H = 10;   // fixed; SPEC_H < floor so floor governs
const EMU_PER_IN = 914400, PX_PER_IN = 128;
const emuToPx = (emu: number) => (emu / EMU_PER_IN) * PX_PER_IN;

type Config = "none" | "h" | "v" | "all";
type Spec = Readonly<{ id: string; config: Config; t: number; nRows: number; nCols: number }>;

function hsl(i: number, n: number) { return `hsl(${Math.round((360 * i) / Math.max(1, n))} 70% 55%)`; }

function borderCss(config: Config, t: number): string {
  if (config === "none" || t === 0) return "border:0;";
  if (config === "h") return `border:0;border-top:${t}px solid #111;border-bottom:${t}px solid #111;`;
  if (config === "v") return `border:0;border-left:${t}px solid #111;border-right:${t}px solid #111;`;
  return `border:${t}px solid #111;`;
}

function genFixture(s: Spec): string {
  let k = 0;
  const rows = Array.from({ length: s.nRows }, (_, r) => {
    const tds = Array.from({ length: s.nCols }, (_, c) =>
      `<td style="background:${hsl(k++, s.nRows * s.nCols)};font-size:${FONT}px;line-height:${FONT}px;padding:${PADY}px ${PADX}px;${borderCss(s.config, s.t)}">x</td>`).join("");
    return `<tr style="height:${SPEC_H}px">${tds}</tr>`;
  }).join("\n");
  const cols = Array.from({ length: s.nCols }, () => `<col style="width:120px">`).join("");
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
* { margin:0; padding:0; box-sizing:border-box; }
body { width:1280px; height:720px; background:#fff; font-family:Arial, sans-serif; }
.wrap { position:absolute; left:80px; top:80px; }
table { border-collapse:collapse; table-layout:fixed; }
td { vertical-align:middle; color:#000; overflow:hidden; }
</style></head><body><div class="wrap"><table><colgroup>${cols}</colgroup>
${rows}
</table></div></body></html>`;
}

function cmdGen() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(FIX, { recursive: true });
  const specs: Spec[] = [];
  const shapes: [number, number][] = [[1, 1], [3, 2], [4, 3]];
  let idx = 0;
  // control: no border
  for (const [nRows, nCols] of shapes) specs.push({ id: `b_${String(idx++).padStart(3, "0")}`, config: "none", t: 0, nRows, nCols });
  // border sweeps: config × thickness × shape. ~50% have H borders, 50% V.
  for (const config of ["h", "v", "all"] as Config[])
    for (const t of [1, 2, 3, 4, 6, 8])
      for (const [nRows, nCols] of shapes)
        specs.push({ id: `b_${String(idx++).padStart(3, "0")}`, config, t, nRows, nCols });
  for (const s of specs) writeFileSync(join(FIX, `${s.id}.html`), genFixture(s));
  writeFileSync(join(ROOT, "specs.json"), JSON.stringify(specs, null, 2));
  writeFileSync(join(ROOT, "slides.csv"), specs.map((s) => s.id).join(","));
  console.error(`gen: ${specs.length} border-study tables → ${FIX}`);
  console.log(specs.map((s) => s.id).join(","));
}

function auth() {
  const creds = JSON.parse(readFileSync(resolve("/workspaces/sashaslides/.auth/google_oauth.json"), "utf-8"));
  const tokens = JSON.parse(readFileSync(resolve("/workspaces/sashaslides/.auth/tokens.json"), "utf-8"));
  const c = creds.installed || creds.web || creds;
  const o = new google.auth.OAuth2(c.client_id, c.client_secret, c.redirect_uris?.[0]);
  o.setCredentials(tokens);
  return o;
}

async function cmdAnalyze() {
  const specs: Spec[] = JSON.parse(readFileSync(join(ROOT, "specs.json"), "utf-8"));
  const specById = new Map(specs.map((s) => [s.id, s]));
  const mani = JSON.parse(readFileSync(join(OUT, "thumbs", "manifest.json"), "utf-8"));
  const order: string[] = mani.slides ?? [];
  const slides = google.slides({ version: "v1", auth: auth() });
  const pres = (await slides.presentations.get({ presentationId: mani.presentation_id })).data;
  // gather tables in page order
  const tables: { rowsPx: number[]; colsPx: number[] }[] = [];
  for (const slide of pres.slides ?? []) {
    for (const el of (slide.pageElements ?? []).filter((e) => e.table)) {
      const t = el.table!;
      tables.push({
        rowsPx: (t.tableRows ?? []).map((r) => emuToPx(r.rowHeight?.magnitude ?? 0)),
        colsPx: (t.tableColumns ?? []).map((c) => emuToPx(c.columnWidth?.magnitude ?? 0)),
      });
    }
  }
  // base row height (border 0) = font + 2*padY ; base col width = spec 120
  const baseRow = FONT + 2 * PADY;          // 14 + 4 = 18
  const rowPts: { config: Config; t: number; edge: boolean; nRows: number; add: number }[] = [];
  const colPts: { config: Config; t: number; edge: boolean; nCols: number; add: number }[] = [];
  tables.forEach((tab, i) => {
    const s = specById.get(order[i]); if (!s) return;
    tab.rowsPx.forEach((h, ri) => rowPts.push({ config: s.config, t: s.t, edge: ri === 0 || ri === s.nRows - 1, nRows: s.nRows, add: h - baseRow }));
    tab.colsPx.forEach((w, ci) => colPts.push({ config: s.config, t: s.t, edge: ci === 0 || ci === s.nCols - 1, nCols: s.nCols, add: w - 120 }));
  });
  writeFileSync(join(ROOT, "border.json"), JSON.stringify({ rowPts, colPts }, null, 2));

  const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const fmt = (x: number) => (isNaN(x) ? "  -  " : (x >= 0 ? "+" : "") + x.toFixed(2));
  console.log(`\n=== ROW height ADD vs base(${baseRow}px = font+2padY), by config × thickness × position ===`);
  console.log(`(does a HORIZONTAL border grow the row? edge row = top/bottom of table; interior = shared border)`);
  console.log(`config  t |  edge-row add | interior-row add | add/t edge | add/t interior`);
  for (const config of ["none", "h", "v", "all"] as Config[])
    for (const t of [0, 1, 2, 3, 4, 6, 8]) {
      const e = rowPts.filter((p) => p.config === config && p.t === t && p.edge).map((p) => p.add);
      const inr = rowPts.filter((p) => p.config === config && p.t === t && !p.edge).map((p) => p.add);
      if (!e.length && !inr.length) continue;
      console.log(`${config.padEnd(5)} ${String(t).padStart(2)} | ${fmt(mean(e)).padStart(12)} | ${fmt(mean(inr)).padStart(15)} | ${fmt(mean(e) / t).padStart(9)} | ${fmt(mean(inr) / t).padStart(9)}`);
    }
  console.log(`\n=== COL width ADD vs spec(120px), by config × thickness × position ===`);
  console.log(`(does a VERTICAL border grow the column?)`);
  console.log(`config  t |  edge-col add | interior-col add | add/t edge | add/t interior`);
  for (const config of ["none", "h", "v", "all"] as Config[])
    for (const t of [0, 1, 2, 3, 4, 6, 8]) {
      const e = colPts.filter((p) => p.config === config && p.t === t && p.edge).map((p) => p.add);
      const inr = colPts.filter((p) => p.config === config && p.t === t && !p.edge).map((p) => p.add);
      if (!e.length && !inr.length) continue;
      console.log(`${config.padEnd(5)} ${String(t).padStart(2)} | ${fmt(mean(e)).padStart(12)} | ${fmt(mean(inr)).padStart(15)} | ${fmt(mean(e) / t).padStart(9)} | ${fmt(mean(inr) / t).padStart(9)}`);
    }
}

const cmd = process.argv[2];
if (cmd === "gen") cmdGen();
else if (cmd === "analyze") cmdAnalyze().catch((e) => { console.error("FAILED:", e?.response?.data || e); process.exit(1); });
else { console.error("usage: google-table-border-study.ts gen|analyze"); process.exit(1); }
