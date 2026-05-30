/**
 * E3 — the DEFINITIVE measurement: render edge vs ORIGINAL (Chrome) edge,
 * which is what the user actually compares. Original is 2560x1440 (2x);
 * scale to the 1600x900 render space by ×0.625. For each table edge, find
 * where pink ends / cell begins in BOTH and report the render−original
 * delta in render-px. |delta| <= ~1 = matches Chrome (rasterization floor).
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const R = PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));      // 1600x900
const O = PNG.sync.read(readFileSync("/tmp/sxs/originals/slide_17.png"));   // 2560x1440
const c2s = 1.25;
const oScale = O.width / R.width; // 1.6 : original-px per render-px

const isPink = (c: number[]) => Math.abs(c[0] - 236) <= 26 && Math.abs(c[1] - 72) <= 26 && Math.abs(c[2] - 153) <= 26;
function pxOf(im: PNG, x: number, y: number) { const i = (y * im.width + x) * 4; return [im.data[i], im.data[i + 1], im.data[i + 2]]; }

// In `im`, along a line, find the first NON-pink x/y starting from outside.
function firstCell(im: PNG, fixed: "x" | "y", fixedVal: number, from: number, to: number): number {
  const step = to >= from ? 1 : -1;
  for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
    const c = fixed === "y" ? pxOf(im, v, fixedVal) : pxOf(im, fixedVal, v);
    if (!isPink(c)) return v;
  }
  return NaN;
}

const TABLES = [
  { name: ".colored   ", x: 664, y: 92,  w: 528, h: 109 },
  { name: ".colored-nb", x: 664, y: 278, w: 528, h: 104 },
];
for (const t of TABLES) {
  const L = Math.round(t.x * c2s), Rr = Math.round((t.x + t.w) * c2s);
  const TP = Math.round(t.y * c2s), B = Math.round((t.y + t.h) * c2s);
  const midY = Math.round((TP + B) / 2), midX = Math.round((L + R.height === 0 ? 0 : (L + Rr) / 2));
  console.log(`\n=== ${t.name} (render−original edge delta, render-px) ===`);
  const edges: [string, () => number, () => number][] = [
    ["LEFT ", () => firstCell(R, "y", midY, L - 10, L + 22), () => firstCell(O, "y", Math.round(midY * oScale), Math.round((L - 10) * oScale), Math.round((L + 22) * oScale)) / oScale],
    ["RIGHT", () => firstCell(R, "y", midY, Rr + 10, Rr - 22), () => firstCell(O, "y", Math.round(midY * oScale), Math.round((Rr + 10) * oScale), Math.round((Rr - 22) * oScale)) / oScale],
    ["TOP  ", () => firstCell(R, "x", midX, TP - 10, TP + 22), () => firstCell(O, "x", Math.round(midX * oScale), Math.round((TP - 10) * oScale), Math.round((TP + 22) * oScale)) / oScale],
    ["BOT  ", () => firstCell(R, "x", midX, B + 10, B - 22), () => firstCell(O, "x", Math.round(midX * oScale), Math.round((B + 10) * oScale), Math.round((B - 22) * oScale)) / oScale],
  ];
  for (const [lbl, rf, of_] of edges) {
    const rv = rf(), ov = of_();
    const d = rv - ov;
    const flag = Math.abs(d) <= 1.2 ? "ok" : "✗ OFF";
    console.log(`  ${lbl}: render@${rv.toFixed(1)}  original@${ov.toFixed(1)}  Δ=${d.toFixed(1)}px  ${flag}`);
  }
}
