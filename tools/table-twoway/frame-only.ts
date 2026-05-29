/**
 * frame-only.ts — Measure the diff of JUST the pink-framed table region
 * (no padding, so the section-label text above it is excluded). Isolates
 * the table's own rendering fidelity from surrounding text.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
function load(p: string): PNG { return PNG.sync.read(readFileSync(p)); }
const o = load("/tmp/br-probe-original-native.png");
const s = load("/tmp/sxs/slides/slide_17.png");

// Bottom-right pink frame bbox in 1600x900 space (from br-probe output).
const bbox = { x: 820, y: 568, w: 680, h: 79 };
function crop(p: PNG, b: { x: number; y: number; w: number; h: number }): PNG {
  const out = new PNG({ width: b.w, height: b.h });
  for (let y = 0; y < b.h; y++)
    for (let x = 0; x < b.w; x++) {
      const si = ((y + b.y) * p.width + (x + b.x)) * 4;
      const di = (y * out.width + x) * 4;
      out.data[di] = p.data[si]; out.data[di + 1] = p.data[si + 1];
      out.data[di + 2] = p.data[si + 2]; out.data[di + 3] = p.data[si + 3];
    }
  return out;
}
const co = crop(o, bbox), cs = crop(s, bbox);
const total = bbox.w * bbox.h;
for (const t of [0, 0.1, 0.35]) {
  const d = new PNG({ width: bbox.w, height: bbox.h });
  const n = pixelmatch(co.data, cs.data, d.data, bbox.w, bbox.h, { threshold: t, includeAA: true, alpha: 0 });
  if (t === 0.35) writeFileSync("/tmp/frame-only-diff.png", PNG.sync.write(d));
  console.log(`frame-only threshold=${t}: ${n} px / ${total} (${(100 * n / total).toFixed(3)}%)`);
}
