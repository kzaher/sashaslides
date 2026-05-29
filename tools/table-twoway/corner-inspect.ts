import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const r = PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));
const W = r.width;
const g = (x: number, y: number) => { const i = (y * W + x) * 4; return [r.data[i], r.data[i + 1], r.data[i + 2]]; };
const isPink = (c: number[]) => Math.abs(c[0] - 236) <= 28 && Math.abs(c[1] - 72) <= 28 && Math.abs(c[2] - 153) <= 28;
const isWhite = (c: number[]) => c[0] >= 235 && c[1] >= 235 && c[2] >= 235;
// .colored table slide bounds: x 830..1490, y 115..251 (CSS 664,92,528,109 ×1.25).
const L = 830, R = 1490, T = 115, B = 251;
const tag = (c: number[]) => isPink(c) ? "PINK" : isWhite(c) ? "WHITE" : `(${c[0]},${c[1]},${c[2]})`;

console.log("=== Outer-edge transitions (looking for PINK→WHITE→fill = border present) ===");
console.log("TL diag (in from top-left):");
for (let d = -6; d <= 10; d++) console.log(`  (${L+d},${T+d}) ${tag(g(L+d,T+d))}`);
console.log("TR diag (in from top-right):");
for (let d = -6; d <= 10; d++) console.log(`  (${R-d},${T+d}) ${tag(g(R-d,T+d))}`);
console.log("BL diag (in from bottom-left):");
for (let d = -6; d <= 10; d++) console.log(`  (${L+d},${B-d}) ${tag(g(L+d,B-d))}`);
console.log("BR diag (in from bottom-right):");
for (let d = -6; d <= 10; d++) console.log(`  (${R-d},${B-d}) ${tag(g(R-d,B-d))}`);

console.log("\n=== Edge positions ===");
// BR: rightmost x at mid-bottom-row (y=235) where non-pink fill ends; bottom-most y at x=1450 where fill ends.
const rowY = 235; let lastFillX = -1;
for (let x = R - 60; x <= R + 8; x++) { const c = g(x, rowY); if (!isPink(c)) lastFillX = x; }
console.log(`BR right edge: last non-pink x at y=${rowY} = ${lastFillX} (table right ≈ ${R})`);
const colX = 1450; let lastFillY = -1;
for (let y = B - 60; y <= B + 8; y++) { const c = g(colX, y); if (!isPink(c)) lastFillY = y; }
console.log(`BR bottom edge: last non-pink y at x=${colX} = ${lastFillY} (table bottom ≈ ${B})`);
// BL bottom
const colXL = 870; let lastFillYL = -1;
for (let y = B - 60; y <= B + 8; y++) { const c = g(colXL, y); if (!isPink(c)) lastFillYL = y; }
console.log(`BL bottom edge: last non-pink y at x=${colXL} = ${lastFillYL} (table bottom ≈ ${B})`);
// Left edge x for BL/TL (leftmost non-pink at a mid row)
let firstFillX = -1;
for (let x = L - 8; x <= L + 60; x++) { const c = g(x, 180); if (firstFillX < 0 && !isPink(c)) firstFillX = x; }
console.log(`Left edge: first non-pink x at y=180 = ${firstFillX} (table left ≈ ${L})`);
