#!/usr/bin/env npx tsx
/**
 * check-goldens.ts — Pixel-perfect regression check for basic fixtures.
 *
 * Compares each /current/<name>.png against e2e/goldens/<name>.png using pixelmatch.
 * For each mismatch, writes a diff PNG to <outDir>/diff_<name>.png and prints the
 * path + pixel delta. Exits non-zero on any regression.
 *
 * Usage:
 *   npx tsx check-goldens.ts <currentDir> <outDir>
 *     --goldens <dir>   override goldens dir (default: e2e/goldens)
 *     --threshold 0.1   per-pixel color threshold (default 0.1)
 *     --bless           copy current → goldens (create/update goldens)
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname, resolve } from "path";
import { execSync } from "child_process";
import { createRequire } from "module";
const require = createRequire("/workspaces/sashaslides/package.json");
const pmMod = require("pixelmatch");
const pixelmatch = pmMod.default || pmMod;
const { PNG } = require("pngjs");

const args = process.argv.slice(2);
const currentDir = resolve(args[0]);
const outDir = resolve(args[1]);
let goldensDir = resolve(dirname(new URL(import.meta.url).pathname), "e2e/goldens");
let originalsDir: string | null = null;
let threshold = 0.1;
for (let i = 2; i < args.length; i++) {
  if (args[i] === "--goldens") goldensDir = resolve(args[++i]);
  if (args[i] === "--originals") originalsDir = resolve(args[++i]);
  if (args[i] === "--threshold") threshold = parseFloat(args[++i]);
  if (args[i] === "--bless") {
    // Enforcement: ONLY the user may bless a golden, and only via the SxS
    // rating UI (rating-server.ts writes to goldens when a user clicks Good).
    // This script must never bulk-promote renders into the blessed set.
    console.error(
      "ERROR: --bless is disabled. Goldens can only be updated through the " +
      "SxS rating UI when the USER rates a slide as 'good'. See " +
      "analysis/renderer/html2slides/README.md → 'Blessing goldens'."
    );
    process.exit(2);
  }
}

mkdirSync(outDir, { recursive: true });
mkdirSync(goldensDir, { recursive: true });

const currentFiles = readdirSync(currentDir).filter(f => f.endsWith(".png")).sort();

interface Result { file: string; status: "ok" | "regressed" | "new" | "missing-current"; diffPixels?: number; diffPath?: string; }
const results: Result[] = [];
let regressions = 0;

for (const f of currentFiles) {
  const curPath = join(currentDir, f);
  const goldPath = join(goldensDir, f);
  if (!existsSync(goldPath)) {
    // No golden yet — diff the current render against the HTML truth
    // (original screenshot) so the SxS can show "where does Slides deviate
    // from the HTML I wrote?". Original is 2×; downscale to match the
    // thumbnail before pixelmatch.
    const origPath = originalsDir ? join(originalsDir, f) : "";
    if (origPath && existsSync(origPath)) {
      try {
        const cur = PNG.sync.read(readFileSync(curPath));
        // Both images are blurred and downscaled to a small common size before
        // diff — raw pixelmatch on full-res screenshots lights up every
        // antialiased glyph edge because Chrome's font hinting differs from
        // Slides' thumbnail renderer. Blurring collapses that sub-pixel noise
        // so only *structural* differences (missing shapes, wrong colors,
        // position shifts of ≥~4px) survive into the red overlay.
        const dw = cur.width, dh = cur.height;
        const origResized = join(outDir, `_orig_resized_${f}`);
        const curBlurred = join(outDir, `_cur_blurred_${f}`);
        execSync(`convert "${origPath}" -resize ${dw}x${dh}! -blur 0x2 "${origResized}"`);
        execSync(`convert "${curPath}" -blur 0x2 "${curBlurred}"`);
        const orig = PNG.sync.read(readFileSync(origResized));
        const curBl = PNG.sync.read(readFileSync(curBlurred));
        try { require("fs").unlinkSync(origResized); } catch {}
        try { require("fs").unlinkSync(curBlurred); } catch {}
        const diff = new PNG({ width: dw, height: dh });
        // alpha: 0 makes the grayscale background pure white (the math
        // collapses to 255), but pixelmatch hardcodes opaque pixels. So the
        // diff PNG renders as "white bg + red diffs" — when overlaid on the
        // original in the UI, the white hides the original. Post-process: set
        // alpha=0 on every non-diff pixel so the overlay is truly transparent
        // except for the red/yellow diff marks.
        const n = pixelmatch(orig.data, curBl.data, diff.data, dw, dh, {
          threshold: 0.35, includeAA: true, alpha: 0,
          diffColor: [255, 0, 0], aaColor: [255, 255, 0],
        });
        for (let i = 0; i < diff.data.length; i += 4) {
          const r = diff.data[i], g = diff.data[i + 1], b = diff.data[i + 2];
          const isDiffRed = r === 255 && g === 0 && b === 0;
          const isAaYellow = r === 255 && g === 255 && b === 0;
          if (!isDiffRed && !isAaYellow) diff.data[i + 3] = 0;
        }
        const diffPath = join(outDir, `diff_${f}`);
        writeFileSync(diffPath, PNG.sync.write(diff));
        results.push({ file: f, status: "new", diffPixels: n, diffPath });
        continue;
      } catch (e: any) {
        // fall through — still mark as new
      }
    }
    results.push({ file: f, status: "new" });
    continue;
  }
  const cur = PNG.sync.read(readFileSync(curPath));
  const gold = PNG.sync.read(readFileSync(goldPath));
  if (cur.width !== gold.width || cur.height !== gold.height) {
    // size mismatch → synthesize an "all-diff" marker
    const diffPath = join(outDir, `diff_${f}`);
    copyFileSync(curPath, diffPath);
    results.push({ file: f, status: "regressed", diffPixels: cur.width * cur.height, diffPath });
    regressions++;
    continue;
  }
  const diff = new PNG({ width: cur.width, height: cur.height });
  const n = pixelmatch(gold.data, cur.data, diff.data, cur.width, cur.height, {
    threshold, includeAA: false, alpha: 0,
    diffColor: [255, 0, 0], aaColor: [255, 255, 0],
  });
  // Make non-diff pixels transparent so the diff PNG overlays cleanly on
  // the original in the SxS UI (pixelmatch's drawPixel hardcodes alpha=255).
  for (let i = 0; i < diff.data.length; i += 4) {
    const r = diff.data[i], g = diff.data[i + 1], b = diff.data[i + 2];
    const isDiffRed = r === 255 && g === 0 && b === 0;
    const isAaYellow = r === 255 && g === 255 && b === 0;
    if (!isDiffRed && !isAaYellow) diff.data[i + 3] = 0;
  }
  if (n > 0) {
    const diffPath = join(outDir, `diff_${f}`);
    writeFileSync(diffPath, PNG.sync.write(diff));
    results.push({ file: f, status: "regressed", diffPixels: n, diffPath });
    regressions++;
  } else {
    results.push({ file: f, status: "ok", diffPixels: 0 });
  }
}

// Missing goldens the other way
const goldFiles = new Set(existsSync(goldensDir) ? readdirSync(goldensDir).filter(f => f.endsWith(".png")) : []);
for (const g of goldFiles) if (!currentFiles.includes(g)) results.push({ file: g, status: "missing-current" });

const report = { threshold, regressions, results };
writeFileSync(join(outDir, "regression-report.json"), JSON.stringify(report, null, 2));

console.log(`Goldens: ${goldensDir}`);
console.log(`Current: ${currentDir}`);
for (const r of results) {
  const tag = r.status === "ok" ? "OK " : r.status === "regressed" ? "REG" : r.status === "new" ? "NEW" : "MIS";
  console.log(`  [${tag}] ${r.file}${r.diffPixels ? ` — ${r.diffPixels}px diff → ${r.diffPath}` : ""}`);
}
console.log(`\n${regressions} regression(s), ${results.filter(r => r.status === "new").length} new, ${results.filter(r => r.status === "ok").length} unchanged`);
process.exit(regressions > 0 ? 1 : 0);
