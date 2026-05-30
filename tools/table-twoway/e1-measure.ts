/**
 * E1 — precise misalignment map of slide_17's two colored tables.
 * For each table, for each of the 4 corners, scan inward along the
 * horizontal edge and the vertical edge and report:
 *   - where PINK (wrapper) ends
 *   - where WHITE (border/underlay) runs (count)
 *   - where the CELL fill begins
 * Then compare the four corners + the table bounds to surface the 1-2px
 * misalignments the user flagged, and flag white-underlay leak.
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
const im = PNG.sync.read(readFileSync("/tmp/sxs/slides/slide_17.png"));
const W = im.width;
const px = (x: number, y: number) => { const i = (y * W + x) * 4; return [im.data[i], im.data[i + 1], im.data[i + 2]]; };
const isPink = (c: number[]) => Math.abs(c[0] - 236) <= 26 && Math.abs(c[1] - 72) <= 26 && Math.abs(c[2] - 153) <= 26;
const isWhite = (c: number[]) => c[0] >= 238 && c[1] >= 238 && c[2] >= 238;
const c2s = 1.25;

interface T { name: string; x: number; y: number; w: number; h: number; }
const TABLES: T[] = [
  { name: ".colored   (top-right)",   x: 664, y: 92,  w: 528, h: 109 },
  { name: ".colored-nb(right-center)", x: 664, y: 278, w: 528, h: 104 },
];

// Walk from `start` toward `end` (step ±1), classify the run lengths of
// pink / white / other(=cell). Returns boundary coords.
function scan(fixed: "x" | "y", fixedVal: number, from: number, to: number) {
  const step = to >= from ? 1 : -1;
  let pinkEnd = -1, whiteRun = 0, cellStart = -1;
  for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
    const c = fixed === "y" ? px(v, fixedVal) : px(fixedVal, v);
    if (isPink(c)) pinkEnd = v;
    else if (isWhite(c) && cellStart < 0) whiteRun++;
    else if (!isWhite(c)) { cellStart = v; break; }
  }
  return { pinkEnd, whiteRun, cellStart };
}

for (const t of TABLES) {
  const L = Math.round(t.x * c2s), R = Math.round((t.x + t.w) * c2s);
  const TP = Math.round(t.y * c2s), B = Math.round((t.y + t.h) * c2s);
  const midY = Math.round((TP + B) / 2), midX = Math.round((L + R) / 2);
  console.log(`\n=== ${t.name}  bounds slide-px L=${L} R=${R} T=${TP} B=${B} ===`);
  // Left edge (scan right from outside): expect pink → [white border] → cell
  const left = scan("y", midY, L - 8, L + 20);
  const right = scan("y", midY, R + 8, R - 20);
  const top = scan("x", midX, TP - 8, TP + 20);
  const bot = scan("x", midX, B + 8, B - 20);
  console.log(`  LEFT  edge: pink→ ends x=${left.pinkEnd}, white ${left.whiteRun}px, cell@x=${left.cellStart}  (bound L=${L}, Δcell=${left.cellStart - L})`);
  console.log(`  RIGHT edge: pink→ ends x=${right.pinkEnd}, white ${right.whiteRun}px, cell@x=${right.cellStart}  (bound R=${R}, Δcell=${right.cellStart - (R - 1)})`);
  console.log(`  TOP   edge: pink→ ends y=${top.pinkEnd}, white ${top.whiteRun}px, cell@y=${top.cellStart}  (bound T=${TP}, Δcell=${top.cellStart - TP})`);
  console.log(`  BOT   edge: pink→ ends y=${bot.pinkEnd}, white ${bot.whiteRun}px, cell@y=${bot.cellStart}  (bound B=${B}, Δcell=${bot.cellStart - (B - 1)})`);
  // Per-corner outer transition (diagonal) to catch per-corner asymmetry
  for (const [cn, cx, cy, dx, dy] of [["TL", L, TP, 1, 1], ["TR", R, TP, -1, 1], ["BL", L, B, 1, -1], ["BR", R, B, -1, -1]] as [string, number, number, number, number][]) {
    let pinkE = -1, wr = 0, cell = "-";
    for (let d = -6; d <= 14; d++) {
      const c = px(cx + dx * d, cy + dy * d);
      if (isPink(c)) pinkE = d;
      else if (isWhite(c) && cell === "-") wr++;
      else if (!isWhite(c)) { cell = `(${c[0]},${c[1]},${c[2]})@d=${d}`; break; }
    }
    console.log(`    ${cn}: pink→d=${pinkE}, white ${wr}px, cell ${cell}`);
  }
  // White-underlay leak: count WHITE pixels in a 2px ring just inside each edge (excl. corners)
  let leak = 0;
  for (let x = L + 18; x < R - 18; x++) { if (isWhite(px(x, TP + 1))) leak++; if (isWhite(px(x, B - 2))) leak++; }
  for (let y = TP + 18; y < B - 18; y++) { if (isWhite(px(L + 1, y))) leak++; if (isWhite(px(R - 2, y))) leak++; }
  console.log(`  WHITE leak in 1px perimeter ring (excl corners): ${leak} px`);
}
