/**
 * seam-probe.ts — Artifact detector (no HTML comparison). Scans the
 * INTERIOR of a table's cell grid in the Slides render for any wrapper-
 * background pixels. Inside a fully-tiled cell grid there should be ZERO
 * background pixels — any found is a seam/gap artifact between cell rects.
 *
 * Targets the bottom-right `.colored-nb` table on slide_17. The pink
 * wrapper (#ec4899) sits BEHIND the cells; if it shows anywhere inside
 * the grid interior, cells aren't tiling cleanly.
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

const slide = PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));
const W = slide.width;
const cssToSlide = 1.25;

const isPink = (r: number, g: number, b: number): boolean =>
  Math.abs(r - 236) <= 30 && Math.abs(g - 72) <= 30 && Math.abs(b - 153) <= 30;
// Light grey slide page bg (#f3f4f6).
const isPageBg = (r: number, g: number, b: number): boolean =>
  r >= 238 && r <= 248 && g >= 239 && g <= 249 && b >= 240 && b <= 250;

// Table cell-grid bounds in CSS px (from extract dump). `wrapped` = sits
// inside a pink `.colored-wrap`/`.table-wrap`, so pink showing inside the
// grid interior is a seam artifact.
const TABLES = [
  { name: "row1-L .rounded   ", x: 88,  y: 92,  w: 528, h: 136, wrapped: true },
  { name: "row1-R .colored   ", x: 664, y: 92,  w: 528, h: 109, wrapped: true },
  { name: "row2-L .rounded-nb ", x: 88,  y: 278, w: 528, h: 134, wrapped: true },
  { name: "row2-R .colored-nb ", x: 664, y: 278, w: 528, h: 104, wrapped: true },
  { name: "row3-L shape(text) ", x: 88,  y: 462, w: 528, h: 104, wrapped: true },
  { name: "row3-R shape(empty)", x: 664, y: 462, w: 528, h: 48,  wrapped: true },
];

// Inset past the corner arc (12px CSS radius = 15 slide-px) so the
// rectangular probe never samples the pink that legitimately sits
// outside a rounded corner. Pink found beyond this inset = a real
// interior seam between cells/masks.
const INSET = 18;
let allClean = true;
for (const t of TABLES) {
  const x0 = Math.round(t.x * cssToSlide + INSET), y0 = Math.round(t.y * cssToSlide + INSET);
  const x1 = Math.round((t.x + t.w) * cssToSlide - INSET), y1 = Math.round((t.y + t.h) * cssToSlide - INSET);
  let pink = 0;
  const rowHist = new Map<number, number>();
  const colHist = new Map<number, number>();
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const i = (y * W + x) * 4;
      if (isPink(slide.data[i], slide.data[i + 1], slide.data[i + 2])) {
        pink++; rowHist.set(y, (rowHist.get(y) || 0) + 1); colHist.set(x, (colHist.get(x) || 0) + 1);
      }
    }
  if (pink > 0) allClean = false;
  console.log(`${pink === 0 ? "✓" : "✗"} ${t.name}  interior x=${x0}..${x1} y=${y0}..${y1}  pink(seam)=${pink}`);
  if (pink > 0) {
    const rws = [...rowHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const cls = [...colHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    console.log(`     pink rows ${rws.map(([y, c]) => `${y}:${c}`).join(" ")}  | cols ${cls.map(([x, c]) => `${x}:${c}`).join(" ")}`);
  }
}
console.log(allClean ? "\n✓ ALL tables tile cleanly — no interior pink seams." : "\n✗ Seam artifacts present.");
void isPageBg;
