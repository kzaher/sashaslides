/**
 * sample-pixels.ts — Sample exact RGB values at a grid of points in
 * both the original and slide crops, side-by-side. Pinpoints where the
 * pixelmatch diff actually comes from.
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
function load(p: string): PNG { return PNG.sync.read(readFileSync(p)); }
const orig = load("/tmp/br-probe-original.png");
const slide = load("/tmp/br-probe-slide.png");

function rgb(p: PNG, x: number, y: number): [number, number, number] {
  const i = (y * p.width + x) * 4;
  return [p.data[i], p.data[i + 1], p.data[i + 2]];
}
function diff(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}
function fmt(c: [number, number, number]): string {
  return `(${c[0].toString().padStart(3)},${c[1].toString().padStart(3)},${c[2].toString().padStart(3)})`;
}

// Header row: y ~ 35. Data row 1: y ~ 50. Data row 2: y ~ 65. Data row 3: y ~ 80.
// Columns: ~ x = 90 (th col), 220 (col 1 g/b), 350 (col 2 y/g), 480 (col 3 r/y), 620 (col 4 b/r).
const samples = [
  { name: "hdr col0",   x:  95, y: 35 },
  { name: "hdr col1",   x: 225, y: 35 },
  { name: "hdr col2",   x: 355, y: 35 },
  { name: "hdr col3",   x: 485, y: 35 },
  { name: "hdr col4",   x: 615, y: 35 },
  { name: "row1 col0",  x:  95, y: 50 },
  { name: "row1 col1",  x: 225, y: 50 },
  { name: "row1 col2",  x: 355, y: 50 },
  { name: "row1 col3",  x: 485, y: 50 },
  { name: "row1 col4",  x: 615, y: 50 },
  { name: "row2 col0",  x:  95, y: 65 },
  { name: "row2 col1",  x: 225, y: 65 },
  { name: "row2 col2",  x: 355, y: 65 },
  { name: "row2 col3",  x: 485, y: 65 },
  { name: "row2 col4",  x: 615, y: 65 },
  { name: "row3 col0",  x:  95, y: 80 },
  { name: "row3 col1",  x: 225, y: 80 },
  { name: "row3 col2",  x: 355, y: 80 },
  { name: "row3 col3",  x: 485, y: 80 },
  { name: "row3 col4",  x: 615, y: 80 },
];

let exact = 0;
let close = 0;
let big = 0;
console.log("name              x   y  | original         slide            | Δ");
console.log("------------------------------------------------------------------");
for (const s of samples) {
  const o = rgb(orig, s.x, s.y);
  const sl = rgb(slide, s.x, s.y);
  const d = diff(o, sl);
  if (d === 0) exact++;
  else if (d <= 30) close++;
  else big++;
  console.log(`${s.name.padEnd(16)} ${String(s.x).padStart(3)} ${String(s.y).padStart(3)} | ${fmt(o)}  ${fmt(sl)}  | ${d}`);
}
console.log(`\nsummary: ${exact} exact, ${close} close (Δ≤30), ${big} big diff (Δ>30)`);
