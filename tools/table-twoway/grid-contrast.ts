import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const r = PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));      // 1600x900
const o = PNG.sync.read(readFileSync("/tmp/sxs/originals/slide_17.png"));    // 2560x1440
const get = (im: PNG, x: number, y: number) => { const i = (y * im.width + x) * 4; return [im.data[i], im.data[i + 1], im.data[i + 2]]; };
// Render: gridline at x=1124 vs cell interior x=1100, data row A y=166.
console.log("RENDER (1600px):");
console.log("  cell interior (1100,166):", get(r, 1100, 166));
console.log("  gridline x=1124   (166) :", get(r, 1124, 166), "  +/-1:", get(r, 1123, 166), get(r, 1125, 166));
// Original is 2x: same slide coords ×1.6 (2560/1600). gridline ~1798, cell ~1760, y~266.
const sx = (x: number) => Math.round(x * 2560 / 1600), sy = (y: number) => Math.round(y * 1440 / 900);
console.log("ORIGINAL (2560px):");
console.log("  cell interior:", get(o, sx(1100), sy(166)));
// scan a few px around the expected gridline to find the whitest
let best = [0, 0, 0], bx = 0;
for (let x = sx(1124) - 4; x <= sx(1124) + 4; x++) { const c = get(o, x, sy(166)); if (c[0] + c[1] + c[2] > best[0] + best[1] + best[2]) { best = c; bx = x; } }
console.log("  gridline (whitest near boundary):", best, "@x=", bx);
