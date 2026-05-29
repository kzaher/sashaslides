/**
 * classify-diff.ts — Bucket every differing pixel (original vs slide) by
 * Δ magnitude, and locate where the BIG (structural) diffs are vs the
 * small (boundary anti-alias) ones.
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
function load(p: string): PNG { return PNG.sync.read(readFileSync(p)); }
const o = load("/tmp/br-probe-original.png");
const s = load("/tmp/br-probe-slide.png");
const W = o.width, H = o.height;

const buckets = { eq: 0, "1-10": 0, "11-30": 0, "31-80": 0, "81-150": 0, "151+": 0 };
const bigPixels: { x: number; y: number; d: number }[] = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const d = Math.abs(o.data[i] - s.data[i]) + Math.abs(o.data[i + 1] - s.data[i + 1]) + Math.abs(o.data[i + 2] - s.data[i + 2]);
    if (d === 0) buckets.eq++;
    else if (d <= 10) buckets["1-10"]++;
    else if (d <= 30) buckets["11-30"]++;
    else if (d <= 80) buckets["31-80"]++;
    else if (d <= 150) { buckets["81-150"]++; bigPixels.push({ x, y, d }); }
    else { buckets["151+"]++; bigPixels.push({ x, y, d }); }
  }
}
const total = W * H;
console.log(`Total pixels: ${total}`);
for (const [k, v] of Object.entries(buckets)) {
  console.log(`  Δ ${k.padStart(7)}: ${String(v).padStart(6)} (${(100 * v / total).toFixed(2)}%)`);
}
const nonEq = total - buckets.eq;
console.log(`\nDiffering (Δ>0): ${nonEq} (${(100 * nonEq / total).toFixed(2)}%)`);
const structural = buckets["31-80"] + buckets["81-150"] + buckets["151+"];
console.log(`Structural (Δ>30): ${structural} (${(100 * structural / total).toFixed(2)}%)`);

// Cluster big pixels into row bands.
const rowHist = new Map<number, number>();
for (const p of bigPixels) rowHist.set(p.y, (rowHist.get(p.y) || 0) + 1);
const topRows = [...rowHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log("\nBig-diff (Δ>80) pixels by row:");
for (const [y, c] of topRows) console.log(`  y=${String(y).padStart(3)}: ${c}`);
