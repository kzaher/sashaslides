/**
 * sample-col.ts — Sample a single column's pixel values vertically in
 * BOTH original and slide, showing how the row-boundary anti-alias
 * progresses pixel-by-pixel.
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
function load(p: string): PNG { return PNG.sync.read(readFileSync(p)); }
const o = load("/tmp/br-probe-original.png");
const s = load("/tmp/br-probe-slide.png");
const x = parseInt(process.argv[2] || "200");
const y0 = parseInt(process.argv[3] || "40");
const y1 = parseInt(process.argv[4] || "50");
function fmt(c: [number, number, number]): string {
  return `(${c[0].toString().padStart(3)},${c[1].toString().padStart(3)},${c[2].toString().padStart(3)})`;
}
console.log(`Col x=${x}, y=${y0}..${y1}`);
console.log("  y   | original         slide            | Δ");
console.log("  ----+-------------------------------------+----");
for (let y = y0; y <= y1; y++) {
  const i = (y * o.width + x) * 4;
  const oc: [number, number, number] = [o.data[i], o.data[i + 1], o.data[i + 2]];
  const sc: [number, number, number] = [s.data[i], s.data[i + 1], s.data[i + 2]];
  const d = Math.abs(oc[0] - sc[0]) + Math.abs(oc[1] - sc[1]) + Math.abs(oc[2] - sc[2]);
  console.log(`  ${String(y).padStart(3)} | ${fmt(oc)}  ${fmt(sc)}  | ${d}`);
}
