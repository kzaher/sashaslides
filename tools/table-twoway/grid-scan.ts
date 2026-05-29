import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const s = PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));
const W = s.width;
const px = (x: number, y: number) => { const i = (y * W + x) * 4; return [s.data[i], s.data[i + 1], s.data[i + 2]]; };
const lightish = (c: number[]) => c[0] >= 235 && c[1] >= 235 && c[2] >= 235; // near-white gridline
// .colored table CSS (664,92,528,109) → slide ×1.25. Inner column boundaries
// (CSS→slide): 801.8→1002, 899→1124, 996.6→1246, 1094→1368.
// Rows: header y92.5 h27; A y119.5; B y146.5; C y173.5 (CSS) → slide ×1.25.
console.log("Horizontal scans (white gridline pixels between pastel columns):");
for (const [lbl, ycss] of [["header", 105], ["rowA", 133], ["rowB", 160], ["rowC", 187]] as [string, number][]) {
  const y = Math.round(ycss * 1.25);
  const hits: string[] = [];
  for (let x = 995; x <= 1375; x++) { const c = px(x, y); if (lightish(c)) hits.push(`${x}`); }
  console.log(`  ${lbl} (y=${y}): ${hits.length} white px @ x=[${hits.join(",")}]`);
}
console.log("\nVertical scans (white gridline pixels between rows), at mid-cell x:");
for (const [lbl, xcss] of [["Week-col", 730], ["Q2-col", 947]] as [string, number][]) {
  const x = Math.round(xcss * 1.25);
  const hits: string[] = [];
  for (let y = 118; y <= 245; y++) { const c = px(x, y); if (lightish(c)) hits.push(`${y}`); }
  console.log(`  ${lbl} (x=${x}): ${hits.length} white px @ y=[${hits.join(",")}]`);
}
