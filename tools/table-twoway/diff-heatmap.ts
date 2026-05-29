/**
 * diff-heatmap.ts — Count magenta-ish diff pixels per row and per column
 * in /tmp/br-probe-diff.png so we know WHERE the residual diff lives
 * (which rows? which columns?).
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const diff = PNG.sync.read(readFileSync("/tmp/br-probe-diff.png"));
const W = diff.width, H = diff.height;
// Probe a known diff area to discover what pixelmatch's diff color is.
const colorCounts = new Map<string, number>();
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const r = diff.data[i], g = diff.data[i + 1], b = diff.data[i + 2];
    const k = `${r},${g},${b}`;
    colorCounts.set(k, (colorCounts.get(k) || 0) + 1);
  }
}
const sorted = [...colorCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log("top 10 diff-png colors:");
for (let i = 0; i < Math.min(10, sorted.length); i++) console.log(`  ${sorted[i][0]}: ${sorted[i][1]}`);
console.log("");

const isDiff = (r: number, g: number, b: number): boolean =>
  r === 255 && g === 0 && b === 0;

const perRow = new Array<number>(H).fill(0);
const perCol = new Array<number>(W).fill(0);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (isDiff(diff.data[i], diff.data[i + 1], diff.data[i + 2])) {
      perRow[y]++;
      perCol[x]++;
    }
  }
}

const total = perRow.reduce((a, b) => a + b, 0);
console.log(`Total diff pixels detected: ${total} (image: ${W * H})\n`);

console.log("Rows with most diff (top 20):");
const rows = perRow.map((c, y) => ({ y, c })).sort((a, b) => b.c - a.c);
for (let i = 0; i < 20; i++) console.log(`  y=${rows[i].y.toString().padStart(3)}: ${rows[i].c} diffs`);

console.log("\nCols with most diff (top 20):");
const cols = perCol.map((c, x) => ({ x, c })).sort((a, b) => b.c - a.c);
for (let i = 0; i < 20; i++) console.log(`  x=${cols[i].x.toString().padStart(3)}: ${cols[i].c} diffs`);
