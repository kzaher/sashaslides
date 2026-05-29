import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const s = PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));
const W = s.width;
// .colored table TL corner ~ slide (830,115). Sample diagonal in/out.
console.log("TL corner diagonal (.colored), slide-space:");
for (let d=-8; d<=22; d++){
  const x=830+d, y=115+d;
  const i=(y*W+x)*4;
  console.log(`  (${x},${y}) = (${s.data[i]},${s.data[i+1]},${s.data[i+2]})`);
}
