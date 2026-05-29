/**
 * scan-band.ts — Compare original vs slide pixel-by-pixel along a single
 * horizontal scanline, printing every column where they differ.
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
function load(p: string): PNG { return PNG.sync.read(readFileSync(p)); }
const o = load("/tmp/br-probe-original.png");
const s = load("/tmp/br-probe-slide.png");

const y = parseInt(process.argv[2] || "17");
console.log(`Scanline y=${y}: original vs slide`);
const diffs: number[] = [];
let prevDiff = false;
for (let x = 0; x < o.width; x++) {
  const i = (y * o.width + x) * 4;
  const oc: [number, number, number] = [o.data[i], o.data[i + 1], o.data[i + 2]];
  const sc: [number, number, number] = [s.data[i], s.data[i + 1], s.data[i + 2]];
  const d = Math.abs(oc[0] - sc[0]) + Math.abs(oc[1] - sc[1]) + Math.abs(oc[2] - sc[2]);
  if (d > 0) {
    if (!prevDiff || x % 50 === 0) {
      console.log(`  x=${String(x).padStart(3)}  orig=(${oc[0].toString().padStart(3)},${oc[1].toString().padStart(3)},${oc[2].toString().padStart(3)})  slide=(${sc[0].toString().padStart(3)},${sc[1].toString().padStart(3)},${sc[2].toString().padStart(3)})  Δ=${d}`);
    }
    diffs.push(x);
    prevDiff = true;
  } else {
    prevDiff = false;
  }
}
console.log(`\ntotal diffs at y=${y}: ${diffs.length} / ${o.width}`);
