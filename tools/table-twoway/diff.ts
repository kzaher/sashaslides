#!/usr/bin/env npx tsx
/**
 * tools/table-twoway/diff.ts — quantitative parity check.
 *
 * For each (NATIVE, MANUAL) thumbnail pair produced by run.ts, compute:
 *   - total pixel count
 *   - mismatched pixel count via pixelmatch (threshold 0.0 — strict)
 *   - percentage mismatch
 *   - bounding box of mismatched pixels (so we can see WHERE drift lives,
 *     not just how much)
 *
 * Exit code 0 if every pair is < 0.1 % mismatch, 1 otherwise.
 *
 * Usage:
 *   npx tsx tools/table-twoway/diff.ts [thumbsDir]
 */
import { readFileSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

const thumbsDir = process.argv[2] || "/tmp/twoway-thumbs";

function load(p: string): PNG {
  if (!existsSync(p)) throw new Error(`missing: ${p}`);
  return PNG.sync.read(readFileSync(p));
}

interface PairResult {
  label: string;
  a: string; b: string;
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
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // pixelmatch writes diff pixels in bright red/yellow; non-diff is
      // a faded grayscale version of the input. A diff pixel has high R
      // and low or moderate B — distinguish from the gray background.
      if (r > 200 && b < 100) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX === -1 ? null : { minX, minY, maxX, maxY };
}

function diffPair(label: string, aPath: string, bPath: string, outDiff?: string): PairResult {
  const a = load(aPath);
  const b = load(bPath);
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${aPath} ${a.width}x${a.height} vs ${bPath} ${b.width}x${b.height}`);
  }
  const { width, height } = a;
  const diffImg = new PNG({ width, height });
  const diff = pixelmatch(a.data, b.data, diffImg.data, width, height, { threshold: 0.0, includeAA: true });
  const bbox = computeBbox(diffImg);
  if (outDiff) writeFileSync(outDiff, PNG.sync.write(diffImg));
  return {
    label, a: aPath, b: bPath,
    width, height,
    total: width * height,
    diff,
    pct: (diff / (width * height)) * 100,
    bbox,
  };
}

const cases: Array<{ label: string; a: string; b: string }> = [
  { label: "T1 — 3×3 no borders, checker fill",       a: "slide_01.png", b: "slide_02.png" },
  { label: "T2 — 3×3 0.02\" black borders, uniform",  a: "slide_03.png", b: "slide_04.png" },
  { label: "T3 — 4×4 0.01\" gray borders, alt rows",  a: "slide_05.png", b: "slide_06.png" },
];

const results: PairResult[] = [];
for (const c of cases) {
  results.push(diffPair(c.label, join(thumbsDir, c.a), join(thumbsDir, c.b), join(thumbsDir, `diff_${c.a.replace(".png", "")}_vs_${c.b}`)));
}

console.log("");
console.log(`Quantitative parity check (thumbs at ${thumbsDir})`);
console.log("=".repeat(75));
for (const r of results) {
  const dims = `${r.width}×${r.height}`;
  const bboxStr = r.bbox
    ? `bbox (${r.bbox.minX},${r.bbox.minY})→(${r.bbox.maxX},${r.bbox.maxY}) size ${r.bbox.maxX - r.bbox.minX + 1}×${r.bbox.maxY - r.bbox.minY + 1}`
    : "no diff pixels";
  console.log(`${r.label}`);
  console.log(`  ${dims}  total=${r.total.toLocaleString()}  diff=${r.diff.toLocaleString()}  pct=${r.pct.toFixed(4)}%`);
  console.log(`  ${bboxStr}`);
}
const fails = results.filter((r) => r.pct >= 0.1);
console.log("=".repeat(75));
console.log(fails.length === 0 ? "PASS — all pairs < 0.1 % diff" : `FAIL — ${fails.length}/${results.length} pair(s) ≥ 0.1 %`);
process.exit(fails.length === 0 ? 0 : 1);
