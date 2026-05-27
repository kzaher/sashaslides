#!/usr/bin/env npx tsx
/**
 * tools/table-twoway/run.ts — two-renderer table test harness.
 *
 * Goal: prove our coordinate math + emission can hit pixel-perfect parity
 * between
 *   (A) the native pptxgenjs `slide.addTable()` path, and
 *   (B) a manual "shapes only" path that reconstructs the same table from
 *       per-cell `addShape("rect")` fills + per-edge filled-rect borders.
 *
 * Both paths consume the SAME `layoutTable()` output so any divergence is
 * caused by Slides rasterising the two emission flavours differently —
 * never by the source coordinates drifting.
 *
 * Output: a single .pptx with one slide per test case per mode (native,
 * manual). Upload to Slides + export thumbs to compare visually. Aim:
 * thumbs of slide_native and slide_manual should be indistinguishable.
 *
 * Usage:
 *   npx tsx tools/table-twoway/run.ts [--out /tmp/twoway.pptx]
 */
import * as pptxgenModule from "pptxgenjs";
import type PptxGenJS from "pptxgenjs";
import { writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync } from "fs";
import { join } from "path";
import { Readable } from "stream";
import { google } from "googleapis";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { spawn } from "child_process";
import { injectCellNoBorder } from "../../renderer/html2slides/convert-pptx-io.js";

type Slide = PptxGenJS.Slide;
type ShapeProps = PptxGenJS.ShapeProps;

const PptxGenJSCtor =
  ((pptxgenModule as unknown as { default?: typeof PptxGenJS }).default
    ?? (pptxgenModule as unknown as typeof PptxGenJS));

// Slide geometry — matches the rest of the project (10" × 5.625", 16:9).
const SLIDE_W_IN = 10;
const SLIDE_H_IN = 5.625;
// Coordinate lattice: snap every emitted x/y/w/h to this granularity (in
// inches) so the native graphicFrame and manual shapes both compute the
// same edges. 0.01" is the user-suggested quantum.
const Q_INCH = 0.01;
const q = (v: number): number => Math.round(v / Q_INCH) * Q_INCH;

// ---- layoutTable: single source of truth for geometry --------------------
interface TableSpec {
  label: string;
  x: number; y: number;          // top-left in inches
  cols: number; rows: number;
  /** Per-column width (inches). Length === cols. */
  colW: number[];
  /** Per-row height (inches). Length === rows. */
  rowH: number[];
  borderW: number;               // border width (inches); 0 = no borders
  borderColor: string;           // hex (with or without leading #)
  cellBgs: string[][];           // [row][col] hex
  cellTexts?: string[][];        // optional [row][col] text
  cellFg?: string;               // text color
}

interface CellRect { x: number; y: number; w: number; h: number; bg: string; text?: string; }
interface BorderRect { x: number; y: number; w: number; h: number; color: string; }
interface TableLayout {
  spec: TableSpec;
  total: { x: number; y: number; w: number; h: number };
  cells: CellRect[];
  borders: BorderRect[];
}

/**
 * Border-COLLAPSE model — matches what pptxgenjs `addTable` does natively.
 *
 * Cells abut (no inter-cell gap): cell (ri, ci) is at
 *   cx = x + ci * cellW   cy = y + ri * cellH
 *   size cellW × cellH
 *
 * Borders are thin filled rects placed at the gridlines, STRADDLING the
 * shared cell edges (so half the border width sits inside each adjacent
 * cell). For algn="ctr" stroke semantics that's a rect centered on the
 * gridline, width = borderW, length = full table extent. We use a small
 * positive `bwOut` shift so the OUTER perimeter sits algn="in" inside
 * the (x, y, totalW, totalH) box — matching how Google Slides renders
 * the addTable outer outline.
 */
function layoutTable(spec: TableSpec): TableLayout {
  const { x, y, cols, rows, colW, rowH, borderW, borderColor, cellBgs, cellTexts } = spec;
  if (colW.length !== cols) throw new Error(`colW length ${colW.length} !== cols ${cols}`);
  if (rowH.length !== rows) throw new Error(`rowH length ${rowH.length} !== rows ${rows}`);
  // Prefix sums so cell (ri,ci) is at (x + colXPrefix[ci], y + rowYPrefix[ri]).
  const colXPrefix = [0];
  for (const w of colW) colXPrefix.push(colXPrefix[colXPrefix.length - 1] + w);
  const rowYPrefix = [0];
  for (const h of rowH) rowYPrefix.push(rowYPrefix[rowYPrefix.length - 1] + h);
  const totalW = q(colXPrefix[cols]);
  const totalH = q(rowYPrefix[rows]);

  const cells: CellRect[] = [];
  for (let ri = 0; ri < rows; ri++) {
    for (let ci = 0; ci < cols; ci++) {
      cells.push({
        x: q(x + colXPrefix[ci]),
        y: q(y + rowYPrefix[ri]),
        w: q(colW[ci]),
        h: q(rowH[ri]),
        bg: cellBgs[ri][ci],
        text: cellTexts?.[ri]?.[ci],
      });
    }
  }

  const borders: BorderRect[] = [];
  if (borderW > 0) {
    const half = borderW / 2;
    for (let ci = 0; ci <= cols; ci++) {
      const gx = x + colXPrefix[ci];
      const lx = ci === 0 ? gx : ci === cols ? gx - borderW : gx - half;
      borders.push({ x: q(lx), y: q(y), w: q(borderW), h: totalH, color: borderColor });
    }
    for (let ri = 0; ri <= rows; ri++) {
      const gy = y + rowYPrefix[ri];
      const ly = ri === 0 ? gy : ri === rows ? gy - borderW : gy - half;
      borders.push({ x: q(x), y: q(ly), w: totalW, h: q(borderW), color: borderColor });
    }
  }
  return { spec, total: { x: q(x), y: q(y), w: totalW, h: totalH }, cells, borders };
}

// ---- renderer A: native pptxgenjs addTable -------------------------------
function renderNative(slide: Slide, layout: TableLayout): void {
  const { spec, total } = layout;
  const innerX = total.x;
  const innerY = total.y;
  const innerW = total.w;
  const innerH = total.h;
  // Borders disabled in addTable — drawn as shape-rects after the
  // graphicFrame. This isolates "addTable cell fill rendering" from
  // "addTable border rendering" so we can iterate them independently.
  const bw = 0;
  const colW = spec.colW.map(q);
  const rowH = spec.rowH.map(q);
  // Build rows[][] for addTable. Border on each cell: if bw=0 we skip;
  // otherwise we set the cell border to {pt,color}. pptxgenjs renders
  // adjacent cells' borders as a single stroke at their shared edge.
  const PT_PER_IN = 72;
  const borderPt = bw * PT_PER_IN;
  const tableRows = layout.cells.length === 0 ? [] : Array.from({ length: spec.rows }, (_, ri) =>
    Array.from({ length: spec.cols }, (_, ci) => {
      const cell = layout.cells[ri * spec.cols + ci];
      const opts: PptxGenJS.TableCellProps = {
        fill: { color: cell.bg.replace("#", "") },
        valign: "middle",
        align: "center",
        fontFace: "Arial",
        fontSize: 10,
      };
      if (cell.text !== undefined) {
        // text drawn inside cell via addTable text content
      }
      if (bw > 0) {
        opts.border = [
          { type: "solid", pt: borderPt, color: spec.borderColor.replace("#", "") },
          { type: "solid", pt: borderPt, color: spec.borderColor.replace("#", "") },
          { type: "solid", pt: borderPt, color: spec.borderColor.replace("#", "") },
          { type: "solid", pt: borderPt, color: spec.borderColor.replace("#", "") },
        ];
      }
      return { text: cell.text || "", options: opts };
    })
  );
  slide.addTable(tableRows, {
    x: innerX,
    y: innerY,
    w: innerW,
    h: innerH,
    colW,
    rowH,
    fontFace: "Arial",
    fontSize: 10,
  });
  // Borders as shape-rects (same code path as renderManual) so any
  // diff between renderNative and renderManual is now isolated to
  // cell-fill rendering inside the graphicFrame.
  for (const b of layout.borders) {
    slide.addShape("rect", {
      x: b.x, y: b.y, w: b.w, h: b.h,
      fill: { color: b.color.replace("#", "") },
      line: { type: "none" },
    });
  }
}

// ---- renderer B: manual shapes only --------------------------------------
function renderManual(slide: Slide, layout: TableLayout): void {
  // Slides paints `<a:tc>` cells INCLUSIVE on bottom/right edge pixels
  // (probe of F1: at y=176, native renders row-0's colour, the bottom
  // edge of row 0's box). `<p:sp>` rects paint EXCLUSIVE on bottom/
  // right. To emulate inclusive-bottom: extend each cell's h (and w)
  // by exactly ONE display pixel = 1/160" = 0.00625" — NOT quantised
  // (the 0.01" lattice is 1.6 display px and overshoots). Draw cells
  // in REVERSE so earlier-row cells paint last and own the shared
  // boundary pixel.
  const ONE_PX_IN = 1 / 160;
  const cellsOrdered = layout.cells.slice().reverse();
  for (const c of cellsOrdered) {
    // Slides paints `<a:tc>` cells INCLUSIVE on bottom edge ONLY when
    // there's no border on that edge. Borders (when present) own the
    // boundary pixel. The behaviour at the table's outer right/bottom
    // edges depends on opaque internal Slides rounding (probed: F5
    // paints inclusive on bottom but not right; F11 paints inclusive
    // on both; F1 paints inclusive on neither bottom nor right when
    // borders=0… etc). We pick the rule that minimises total diff
    // across the test matrix: extend H by 1 px ONLY when there are no
    // borders. Accept that thick-border outer edges will have a 1-px
    // residual on non-white cells (F5: 720 px @ y=368, F11: 643 px).
    const extendH = layout.spec.borderW > 0 ? 0 : ONE_PX_IN;
    slide.addShape("rect", {
      x: c.x, y: c.y, w: c.w, h: c.h + extendH,
      fill: { color: c.bg.replace("#", "") },
      line: { type: "none" },
    });
    if (c.text) {
      slide.addText(c.text, {
        x: c.x, y: c.y, w: c.w, h: c.h,
        align: "center", valign: "middle",
        fontFace: "Arial", fontSize: 10,
        color: (layout.spec.cellFg || "#000000").replace("#", ""),
        margin: 0,
      });
    }
  }
  for (const b of layout.borders) {
    slide.addShape("rect", {
      x: b.x, y: b.y, w: b.w, h: b.h,
      fill: { color: b.color.replace("#", "") },
      line: { type: "none" },
    });
  }
}

// ---- test fixtures --------------------------------------------------------
function fillGrid(rows: number, cols: number, val: string): string[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => val));
}
function checker(rows: number, cols: number, a: string, b: string): string[][] {
  return Array.from({ length: rows }, (_, ri) =>
    Array.from({ length: cols }, (_, ci) => (ri + ci) % 2 === 0 ? a : b),
  );
}
function uniform(n: number, v: number): number[] { return Array.from({ length: n }, () => v); }

const FIXTURES: TableSpec[] = [
  // === uniform sizes × varying border widths ===
  {
    label: "F1 — 3×3 no borders, checker fill",
    x: 1, y: 0.5, cols: 3, rows: 3,
    colW: uniform(3, 1.5), rowH: uniform(3, 0.6),
    borderW: 0, borderColor: "#000000",
    cellBgs: checker(3, 3, "#fde2e2", "#dbeafe"),
  },
  {
    label: "F2 — 3×3 0.005\" hairline border, uniform",
    x: 1, y: 0.5, cols: 3, rows: 3,
    colW: uniform(3, 1.5), rowH: uniform(3, 0.6),
    borderW: 0.005, borderColor: "#000000",
    cellBgs: fillGrid(3, 3, "#ffffff"),
  },
  {
    label: "F3 — 3×3 0.01\" border, uniform",
    x: 1, y: 0.5, cols: 3, rows: 3,
    colW: uniform(3, 1.5), rowH: uniform(3, 0.6),
    borderW: 0.01, borderColor: "#666666",
    cellBgs: fillGrid(3, 3, "#ffffff"),
  },
  {
    label: "F4 — 3×3 0.02\" border, uniform",
    x: 1, y: 0.5, cols: 3, rows: 3,
    colW: uniform(3, 1.5), rowH: uniform(3, 0.6),
    borderW: 0.02, borderColor: "#111111",
    cellBgs: fillGrid(3, 3, "#ffffff"),
  },
  {
    label: "F5 — 3×3 0.05\" thick border, uniform",
    x: 1, y: 0.5, cols: 3, rows: 3,
    colW: uniform(3, 1.5), rowH: uniform(3, 0.6),
    borderW: 0.05, borderColor: "#1e40af",
    cellBgs: fillGrid(3, 3, "#dbeafe"),
  },
  // === variable cell sizes ===
  {
    label: "F6 — 3×3 variable colW [2.5, 1.2, 0.8], no borders",
    x: 1, y: 0.5, cols: 3, rows: 3,
    colW: [2.5, 1.2, 0.8], rowH: uniform(3, 0.6),
    borderW: 0, borderColor: "#000000",
    cellBgs: checker(3, 3, "#d1fae5", "#fef3c7"),
  },
  {
    label: "F7 — variable colW + variable rowH, 0.02\" border",
    x: 0.8, y: 0.5, cols: 4, rows: 4,
    colW: [2.1, 1.4, 1.1, 1.9], rowH: [0.4, 0.7, 0.55, 0.3],
    borderW: 0.02, borderColor: "#374151",
    cellBgs: Array.from({ length: 4 }, (_, ri) =>
      Array.from({ length: 4 }, (_, ci) => ci === 0 ? "#111827" : ri % 2 === 0 ? "#ffffff" : "#f3f4f6"),
    ),
  },
  // === edge shapes ===
  {
    label: "F8 — 1×5 single row, 0.02\" border",
    x: 0.5, y: 0.5, cols: 5, rows: 1,
    colW: uniform(5, 1.4), rowH: [0.8],
    borderW: 0.02, borderColor: "#111111",
    cellBgs: [["#fee2e2", "#fef3c7", "#d1fae5", "#dbeafe", "#e9d5ff"]],
  },
  {
    label: "F9 — 6×1 single column, 0.01\" border",
    x: 4, y: 0.5, cols: 1, rows: 6,
    colW: [2.5], rowH: uniform(6, 0.4),
    borderW: 0.01, borderColor: "#666666",
    cellBgs: Array.from({ length: 6 }, (_, ri) => [ri % 2 === 0 ? "#ffffff" : "#f3f4f6"]),
  },
  {
    label: "F10 — 1×1 single cell, 0.03\" border",
    x: 2, y: 0.5, cols: 1, rows: 1,
    colW: [3.0], rowH: [1.5],
    borderW: 0.03, borderColor: "#dc2626",
    cellBgs: [["#fee2e2"]],
  },
  // === odd sizes / off-grid ===
  {
    label: "F11 — odd sizes [0.93, 1.27, 0.41, 1.59], rowH [0.31, 0.47, 0.83], 0.03\" border",
    x: 0.7, y: 0.5, cols: 4, rows: 3,
    colW: [0.93, 1.27, 0.41, 1.59], rowH: [0.31, 0.47, 0.83],
    borderW: 0.03, borderColor: "#7c3aed",
    cellBgs: checker(3, 4, "#ffffff", "#ede9fe"),
  },
  // === large grid ===
  {
    label: "F12 — 5×5 0.01\" border, dense checker",
    x: 0.5, y: 0.5, cols: 5, rows: 5,
    colW: uniform(5, 1.5), rowH: uniform(5, 0.5),
    borderW: 0.01, borderColor: "#374151",
    cellBgs: checker(5, 5, "#ffffff", "#fef3c7"),
  },
];

// ---- pixel diff -----------------------------------------------------------
interface PairResult {
  fixtureIdx: number;
  label: string;
  width: number; height: number;
  total: number;
  diff: number;
  pct: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

function computeBbox(diffPng: PNG): PairResult["bbox"] {
  const { width, height, data } = diffPng;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] > 200 && data[i + 2] < 100) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX === -1 ? null : { minX, minY, maxX, maxY };
}

function diffPair(label: string, idx: number, aPath: string, bPath: string, outDiff: string): PairResult {
  const a = PNG.sync.read(readFileSync(aPath));
  const b = PNG.sync.read(readFileSync(bPath));
  const { width, height } = a;
  const diffImg = new PNG({ width, height });
  const diff = pixelmatch(a.data, b.data, diffImg.data, width, height, { threshold: 0.0, includeAA: true });
  const bbox = computeBbox(diffImg);
  writeFileSync(outDiff, PNG.sync.write(diffImg));
  return { fixtureIdx: idx, label, width, height, total: width * height, diff, pct: (diff / (width * height)) * 100, bbox };
}

// ---- main -----------------------------------------------------------------
async function main(): Promise<void> {
  const outPath = process.argv.includes("--out")
    ? process.argv[process.argv.indexOf("--out") + 1]
    : "/tmp/twoway.pptx";
  const sxsDir = "/tmp/twoway-sxs";
  const sxsOriginals = join(sxsDir, "originals");   // NATIVE
  const sxsThumbnails = join(sxsDir, "slides");     // MANUAL
  const sxsDiffs = join(sxsDir, "diffs");
  for (const d of [sxsDir, sxsOriginals, sxsThumbnails, sxsDiffs]) mkdirSync(d, { recursive: true });

  // 1. build pptx — slide i*2 = NATIVE(i), slide i*2+1 = MANUAL(i).
  const pres = new PptxGenJSCtor();
  pres.defineLayout({ name: "WIDESCREEN", width: SLIDE_W_IN, height: SLIDE_H_IN });
  pres.layout = "WIDESCREEN";
  // F00: control — blank slide × 2. Measures Slides' baseline noise floor
  // for an identical PNG export of identically-empty slides. Any diff here
  // is intrinsic to the rasterisation pipeline, not our rendering.
  pres.addSlide();
  pres.addSlide();
  for (const spec of FIXTURES) {
    const layout = layoutTable(spec);
    { const s = pres.addSlide(); renderNative(s, layout); }
    { const s = pres.addSlide(); renderManual(s, layout); }
  }
  await pres.writeFile({ fileName: outPath });
  // Post-pass: pptxgenjs emits `<a:ln[LRTB] w="0" cap="flat" cmpd="sng"
  // algn="ctr"><a:solidFill>…</a:solidFill></a:ln[LRTB]>` on every cell.
  // Even with w=0 Slides leaves a hairline of AA pixels at the cell
  // edges (visible as 1-px row-boundary lines in the F1 diff). Rewriting
  // them to <a:noFill/> kills the AA and lets the cell fill reach the
  // exact rowH boundary — matching how addShape rects render.
  await injectCellNoBorder(outPath);
  console.log(`Wrote ${outPath} (${FIXTURES.length} fixtures × 2 modes = ${FIXTURES.length * 2} slides)`);

  // 2. upload
  console.log("Uploading...");
  const creds = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/google_oauth.json", "utf-8")).installed;
  const tokens = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/tokens.json", "utf-8"));
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost:8080");
  oauth2.setCredentials(tokens);
  const drive = google.drive({ version: "v3", auth: oauth2 });
  const buf = readFileSync(outPath);
  const res = await drive.files.create({
    requestBody: { name: `table-twoway-${Date.now()}`, mimeType: "application/vnd.google-apps.presentation" },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      body: Readable.from(buf),
    },
    fields: "id",
  });
  const presId = res.data.id!;
  console.log(`  https://docs.google.com/presentation/d/${presId}/edit`);

  // 3. export thumbs (use the existing export-thumbs.ts machinery indirectly
  //    via the project's html2slides exporter — simplest is to shell out).
  const rawThumbs = "/tmp/twoway-thumbs";
  mkdirSync(rawThumbs, { recursive: true });
  console.log("Exporting thumbnails...");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["tsx", "renderer/html2slides/export-thumbs.ts", presId, rawThumbs], {
      cwd: "/workspaces/sashaslides",
      stdio: "inherit",
    });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`export-thumbs exit ${code}`)));
  });

  // 4. split thumbs into native/manual + compute pixel diff.
  // Slide 1, 2 = blank control. Then 2*i+3 = native F(i+1), 2*i+4 = manual F(i+1).
  const results: PairResult[] = [];
  const slideIds: string[] = [];
  {
    const id = "F00";
    slideIds.push(id);
    const nativeDst  = join(sxsOriginals,  `${id}.png`);
    const manualDst  = join(sxsThumbnails, `${id}.png`);
    copyFileSync(join(rawThumbs, "slide_01.png"), nativeDst);
    copyFileSync(join(rawThumbs, "slide_02.png"), manualDst);
    results.push(diffPair("F0 — blank control (Slides noise floor)", -1, nativeDst, manualDst, join(sxsDiffs, `${id}.png`)));
  }
  for (let i = 0; i < FIXTURES.length; i++) {
    const id = `F${String(i + 1).padStart(2, "0")}`;
    slideIds.push(id);
    const nativeSrc  = join(rawThumbs, `slide_${String(i * 2 + 3).padStart(2, "0")}.png`);
    const manualSrc  = join(rawThumbs, `slide_${String(i * 2 + 4).padStart(2, "0")}.png`);
    const nativeDst  = join(sxsOriginals,  `${id}.png`);
    const manualDst  = join(sxsThumbnails, `${id}.png`);
    copyFileSync(nativeSrc, nativeDst);
    copyFileSync(manualSrc, manualDst);
    results.push(diffPair(FIXTURES[i].label, i, nativeDst, manualDst, join(sxsDiffs, `${id}.png`)));
  }

  // 5. quantitative report.
  console.log("");
  console.log("Quantitative parity check (NATIVE vs MANUAL)");
  console.log("=".repeat(80));
  for (const r of results) {
    const bboxStr = r.bbox
      ? `bbox (${r.bbox.minX},${r.bbox.minY})→(${r.bbox.maxX},${r.bbox.maxY}) size ${r.bbox.maxX - r.bbox.minX + 1}×${r.bbox.maxY - r.bbox.minY + 1}`
      : "clean";
    console.log(`F${String(r.fixtureIdx + 1).padStart(2, "0")}  diff=${r.diff.toString().padStart(6)}px  pct=${r.pct.toFixed(4).padStart(8)}%  ${bboxStr}  · ${r.label}`);
  }
  const totalDiff = results.reduce((a, b) => a + b.diff, 0);
  const totalPx = results.reduce((a, b) => a + b.total, 0);
  console.log("=".repeat(80));
  console.log(`Total: ${totalDiff.toLocaleString()} / ${totalPx.toLocaleString()} px = ${((totalDiff / totalPx) * 100).toFixed(4)}%`);

  // 6. write manifest.json + ratings stubs for the filtered-rating-server.
  writeFileSync(join(sxsThumbnails, "manifest.json"), JSON.stringify({
    presentation_id: presId,
    slides: slideIds,
    slide_object_ids: slideIds.map(() => "p1"),
  }, null, 2));
  const ratingsPath = join(sxsDir, "ratings.json");
  if (!existsSync(ratingsPath)) writeFileSync(ratingsPath, "{}");
  const emptyMd = join(sxsDir, "empty.md");
  if (!existsSync(emptyMd)) writeFileSync(emptyMd, "(table-twoway parity check — no analysis prose)");

  // 7. launch the filtered-rating-server on port 4750 with originals=native,
  //    thumbnails=manual, diffs/=pixelmatch diffs.
  console.log("\nLaunching SxS view...");
  const port = "4750";
  spawn("npx", [
    "tsx", "renderer/structured-prompts/bug_solving/scripts/filtered-rating-server.ts",
    "--port", port,
    "--slides", slideIds.join(","),
    "--analysis", emptyMd,
    "--diffs", sxsDiffs,
    "--thumbnails", sxsThumbnails,
    "--originals", sxsOriginals,
    "--ratings-file", ratingsPath,
    "--task-title", "table-twoway",
  ], {
    cwd: "/workspaces/sashaslides",
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  }).unref();
  await new Promise<void>((resolve) => setTimeout(resolve, 2500));
  console.log(`\nSxS view: http://localhost:${port}/`);
  console.log("  · LEFT = NATIVE (slide.addTable)");
  console.log("  · RIGHT = MANUAL (per-cell + per-edge addShape)");
  console.log("  · DIFF = pixelmatch (red pixels = mismatch)");
}

main().catch((e) => { console.error(e); process.exit(1); });
