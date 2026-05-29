import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const r = PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));
const o = PNG.sync.read(readFileSync("/tmp/sxs/originals/slide_17.png"));
const g = (im: PNG, x: number, y: number) => { const i = (y * im.width + x) * 4; return `(${im.data[i]},${im.data[i + 1]},${im.data[i + 2]})`; };
// Top edge of .colored, mid-column (Q1, x≈1100 render). Walk down from pink into header.
console.log("RENDER top edge @x=1100 (pink → ? → black header):");
for (let y = 108; y <= 124; y++) console.log(`  y=${y} ${g(r, 1100, y)}`);
console.log("ORIGINAL top edge @x=1760 (=1100×1.6), y≈173..198:");
for (let y = 173; y <= 198; y++) console.log(`  y=${y} ${g(o, 1760, y)}`);
