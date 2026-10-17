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
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { compareImages, keepOnlyDiffMarks, type RgbaImage } from "./reverse/reverse-metrics.ts";

function writeDiffPng(path: string, image: RgbaImage): void {
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(image.data);
  writeFileSync(path, PNG.sync.write(png));
}

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
    // rating UI (serve-sxs.sh → rating-server.ts --goldens-dir writes to goldens
    // when a user clicks Good). This script must never bulk-promote renders.
    console.error(
      "ERROR: --bless is disabled. Goldens can only be updated through the " +
      "SxS rating UI when the USER rates a slide as 'good'. See " +
      "renderer/html2slides/README.md → 'Blessing goldens'."
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
    // from the HTML I wrote?". The original (2×) is resampled to the
    // thumbnail's size and both are blurred before pixelmatch: Chrome's font
    // hinting differs from Slides' thumbnail renderer, and the blur collapses
    // that sub-pixel noise so only structural differences survive into the
    // red overlay (reverse/reverse-metrics.ts, the reverse gate's comparator;
    // radius 2 is a standard deviation of 2 px, what ImageMagick's
    // `-blur 0x2` applied here before).
    const origPath = originalsDir ? join(originalsDir, f) : "";
    if (origPath && existsSync(origPath)) {
      try {
        const cur = PNG.sync.read(readFileSync(curPath));
        const orig = PNG.sync.read(readFileSync(origPath));
        const comparison = compareImages({ expected: cur, actual: orig, threshold: 0.35, blurRadius: 2 });
        const diffPath = join(outDir, `diff_${f}`);
        writeDiffPng(diffPath, comparison.diffImage);
        results.push({ file: f, status: "new", diffPixels: comparison.mismatchedPixels, diffPath });
        continue;
      } catch {
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
  // Transparent except the marks, so the diff PNG overlays cleanly on the original in the SxS UI.
  keepOnlyDiffMarks(diff.data);
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
