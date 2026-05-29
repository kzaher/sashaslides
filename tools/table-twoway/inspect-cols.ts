/**
 * inspect-cols.ts — Walk a horizontal scanline across the bottom-right
 * table region and report column-boundary pixel x-coords by detecting
 * color transitions. Reports widths in slide-px space (1600x900).
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

function loadPng(p: string): PNG {
  return PNG.sync.read(readFileSync(p));
}

function classify(r: number, g: number, b: number): string {
  // Coarse classify pixel by background color category.
  if (r < 40 && g < 40 && b < 40) return "BLK";        // #111 header
  if (r > 220 && g > 60 && g < 100 && b > 140 && b < 170) return "PNK"; // wrap pink
  if (r > 195 && g > 240 && b > 215) return "GRN";     // #d1fae5
  if (r > 245 && g > 230 && b > 180 && b < 210) return "YEL"; // #fef3c7
  if (r > 245 && g > 215 && b > 215 && g < 235) return "RED"; // #fee2e2
  if (r > 210 && g > 220 && b > 245) return "BLU";     // #dbeafe
  if (r > 245 && g > 245 && b > 245) return "WHT";
  return `??(${r},${g},${b})`;
}

function scanRow(png: PNG, y: number, x0: number, x1: number): void {
  console.log(`  scan y=${y}, x=${x0}..${x1}:`);
  let runChar = "";
  let runStart = x0;
  const W = png.width;
  for (let x = x0; x <= x1; x++) {
    const i = (y * W + x) * 4;
    const c = classify(png.data[i], png.data[i + 1], png.data[i + 2]);
    if (c !== runChar) {
      if (runChar !== "" && (x - runStart) > 1) {
        console.log(`    ${runStart}..${x - 1} (${x - runStart}px) ${runChar}`);
      }
      runChar = c;
      runStart = x;
    }
  }
  console.log(`    ${runStart}..${x1} (${x1 - runStart + 1}px) ${runChar}`);
}

function scanCol(png: PNG, x: number, y0: number, y1: number): void {
  console.log(`  scan x=${x}, y=${y0}..${y1}:`);
  let runChar = "";
  let runStart = y0;
  const W = png.width;
  for (let y = y0; y <= y1; y++) {
    const i = (y * W + x) * 4;
    const c = classify(png.data[i], png.data[i + 1], png.data[i + 2]);
    if (c !== runChar) {
      if (runChar !== "" && (y - runStart) > 1) {
        console.log(`    ${runStart}..${y - 1} (${y - runStart}px) ${runChar}`);
      }
      runChar = c;
      runStart = y;
    }
  }
  console.log(`    ${runStart}..${y1} (${y1 - runStart + 1}px) ${runChar}`);
}

function main(): void {
  const orig = loadPng("/tmp/br-probe-original.png");
  const slide = loadPng("/tmp/br-probe-slide.png");
  console.log(`ORIGINAL (Chrome) ${orig.width}x${orig.height}:`);
  // Vertical scan at x=400 (inside the data columns; will pass through
  // header row then 3 data rows). Reports row heights.
  scanCol(orig, 400, 0, orig.height - 1);
  console.log("");
  scanCol(orig, 100, 0, orig.height - 1); // through leftmost col (should be black L)
  console.log(`\nSLIDE (Google Slides) ${slide.width}x${slide.height}:`);
  scanCol(slide, 400, 0, slide.height - 1);
  console.log("");
  scanCol(slide, 100, 0, slide.height - 1);
}
main();
