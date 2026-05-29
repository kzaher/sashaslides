import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
function load(p: string): PNG { return PNG.sync.read(readFileSync(p)); }
const o = load("/tmp/br-probe-original-native.png");
const s = load("/tmp/sxs/slides/slide_17.png");
const bbox = { x: 820, y: 568, w: 680, h: 79 };
// YIQ distance like pixelmatch.
function yiqDelta(a: number[], b: number[]): number {
  const ry = a[0]*0.29889531+a[1]*0.58662247+a[2]*0.11448223;
  const by = b[0]*0.29889531+b[1]*0.58662247+b[2]*0.11448223;
  return Math.abs(ry-by);
}
const rowHist = new Map<number, number>();
let count = 0;
for (let y = 0; y < bbox.h; y++)
  for (let x = 0; x < bbox.w; x++) {
    const i = (((y+bbox.y))*o.width + (x+bbox.x))*4;
    const oc=[o.data[i],o.data[i+1],o.data[i+2]];
    const sc=[s.data[i],s.data[i+1],s.data[i+2]];
    const d = Math.abs(oc[0]-sc[0])+Math.abs(oc[1]-sc[1])+Math.abs(oc[2]-sc[2]);
    if (d > 80) { rowHist.set(y,(rowHist.get(y)||0)+1); count++; }
  }
console.log(`frame-region pixels with Δ>80: ${count}`);
console.log("by row (frame-local y; header top≈9, header/data1≈24):");
for (const [y,c] of [...rowHist.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10))
  console.log(`  y=${String(y).padStart(2)}: ${c}`);
