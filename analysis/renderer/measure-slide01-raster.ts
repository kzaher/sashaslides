/**
 * Raster measurement for slide_01 CTA/chip vertical alignment.
 * Measures in BOTH the current rendered thumbnail (Slides) and the
 * original HTML screenshot (Chrome) for raster-vs-raster comparison.
 */
import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");

function loadMask(path: string, pred: (r: number, g: number, b: number) => boolean) {
  const png = PNG.sync.read(readFileSync(path));
  const W = png.width, H = png.height;
  const m = new Uint8Array(W * H);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    if (pred(png.data[i], png.data[i+1], png.data[i+2])) m[p] = 1;
  }
  return { data: m, W, H };
}

function bboxInBand(mask: {data: Uint8Array; W: number; H: number}, xMin: number, xMax: number, yMin: number, yMax: number) {
  let x0 = mask.W, x1 = -1, y0 = mask.H, y1 = -1, count = 0;
  for (let y = yMin; y < yMax; y++) {
    for (let x = xMin; x < xMax; x++) {
      if (mask.data[y * mask.W + x]) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        count++;
      }
    }
  }
  if (count === 0) return null;
  return { x0, x1, y0, y1, cx: Math.round((x0+x1)/2), cy: Math.round((y0+y1)/2) };
}

function textCentroid(mask: {data: Uint8Array; W: number; H: number}, x0: number, x1: number, y0: number, y1: number) {
  let n = 0, sx = 0, sy = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (mask.data[y * mask.W + x]) { n++; sx += x; sy += y; }
    }
  }
  return n === 0 ? null : { count: n, cy: Math.round(sy / n) };
}

function measure(pngPath: string, label: string) {
  const png = PNG.sync.read(readFileSync(pngPath));
  const W = png.width, H = png.height;
  const sx = W / 1280, sy = H / 720;
  console.log(`\n### ${label}  (${W}x${H}, scale ${sx.toFixed(2)}x)`);

  const indigo = loadMask(pngPath, (r, g, b) => r > 80 && r < 160 && g > 80 && g < 130 && b > 200);
  const purplish = loadMask(pngPath, (r, g, b) => r > 100 && r < 180 && g > 70 && g < 130 && b > 200);
  const whiteText = loadMask(pngPath, (r, g, b) => r > 240 && g > 240 && b > 240);

  const slidePxY = (y: number) => Math.floor(y * sy);
  const slidePxX = (x: number) => Math.floor(x * sx);

  const cases = [
    { label: "Get Started (outline)",  x0: 0, x1: slidePxX(480), y0: slidePxY(570), y1: slidePxY(630), pill: indigo, text: indigo },
    { label: "Get Started (filled)",   x0: slidePxX(480), x1: slidePxX(800), y0: slidePxY(570), y1: slidePxY(630), pill: purplish, text: whiteText },
    { label: "Contact Sales (outline)",x0: slidePxX(800), x1: W, y0: slidePxY(570), y1: slidePxY(630), pill: indigo, text: indigo },
    { label: "MOST POPULAR chip",      x0: slidePxX(520), x1: slidePxX(760), y0: slidePxY(145), y1: slidePxY(200), pill: indigo, text: whiteText },
  ];
  for (const c of cases) {
    const pb = bboxInBand(c.pill, c.x0, c.x1, c.y0, c.y1);
    if (!pb) { console.log(`  ${c.label}: no pill`); continue; }
    const tc = textCentroid(c.text, pb.x0 + 4, pb.x1 - 4, pb.y0 + 4, pb.y1 - 4);
    const off = tc ? tc.cy - pb.cy : null;
    const offSlide = off !== null ? off * 720 / H : null;
    console.log(`  ${c.label.padEnd(26)} pill.cy=${pb.cy}  text.cy=${tc?.cy ?? "?"}  offset=${off} thumb  (${offSlide?.toFixed(1)} slide-px)`);
  }
}

measure("/tmp/sxs-complex/slides/slide_01.png", "RENDERED — current main (wave1a + wave1b)");
measure("/tmp/sxs-complex/originals/slide_01.png", "ORIGINAL — Chrome HTML (ground truth)");
