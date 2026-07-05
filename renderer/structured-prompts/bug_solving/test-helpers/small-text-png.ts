/**
 * small-text-png.ts — a tiny, SELF-CONTAINED, OFFLINE "render service" for the
 * merge-phase integration test. It rasterises a slide's small text into a small
 * PNG so the merge phase's render/diff runs on REAL pixels — no network, no
 * Chrome, no Google, no canvas/sharp/resvg native lib (none are installed in
 * this devcontainer; only `pngjs` is available in the root node_modules).
 *
 * WHY a built-in bitmap font: we probed node_modules for `sharp`,
 * `@resvg/resvg-js`, `canvas`, `pureimage` — NONE are present offline. `pngjs`
 * IS (root node_modules, resolvable from the bug_solving cwd). So we draw text
 * with a minimal built-in 5x7 monospace bitmap font straight into a pngjs
 * RGBA buffer and emit a real PNG.
 *
 * DETERMINISM: the PNG bytes are a pure function of the input text (+ fixed
 * width/scale/colors). No Date.now / Math.random touches the pixels. Two runs
 * with the same text produce byte-identical PNGs; a one-character text change
 * flips pixels ⇒ a real pixel/byte diff. This is what lets `renderAndDiff`
 * compute the changed-slide set from ACTUAL pixels rather than a scripted list.
 */
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 5x7 bitmap font. Each glyph is 7 rows of a 5-bit mask (MSB = leftmost pixel).
// Only the characters the fixture text uses are defined; anything else falls
// back to a filled box so an unexpected char still perturbs the pixels.
// ---------------------------------------------------------------------------
const FONT: Record<string, number[]> = {
  " ": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1c, 0x12, 0x11, 0x11, 0x11, 0x12, 0x1c],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  "=": [0x00, 0x00, 0x1f, 0x00, 0x1f, 0x00, 0x00],
  ":": [0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x00],
  "_": [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f],
};
const FALLBACK = [0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f, 0x1f];

const GLYPH_W = 5;
const GLYPH_H = 7;
const SCALE = 2;          // 2x scale keeps images tiny (<= 256px wide) yet legible.
const PAD = 2;            // px border (post-scale)
const GAP = 1;           // inter-glyph gap in glyph cells

export interface RenderOpts {
  /** max PNG width in px (default 256 — keep small per the task). */
  maxWidth?: number;
}

/**
 * Rasterise `text` into a small PNG buffer (deterministic; text-only input).
 * White background, black glyphs. Width is clamped to `maxWidth` (default 256),
 * truncating the text to fit — so images stay small.
 */
export function renderTextPngBuffer(text: string, opts: RenderOpts = {}): Buffer {
  const maxWidth = opts.maxWidth ?? 256;
  const cellW = (GLYPH_W + GAP) * SCALE;
  // how many chars fit within maxWidth (minus padding)?
  const usable = Math.max(1, maxWidth - PAD * 2);
  const maxChars = Math.max(1, Math.floor(usable / cellW));
  const chars = [...text.toUpperCase()].slice(0, maxChars);

  const width = Math.min(maxWidth, PAD * 2 + chars.length * cellW);
  const height = PAD * 2 + GLYPH_H * SCALE;
  const png = new PNG({ width, height });

  // white background, opaque.
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; png.data[i + 3] = 255;
  }

  const setPx = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const idx = (width * y + x) << 2;
    png.data[idx] = 0; png.data[idx + 1] = 0; png.data[idx + 2] = 0; png.data[idx + 3] = 255;
  };

  chars.forEach((ch, ci) => {
    const glyph = FONT[ch] ?? FALLBACK;
    const ox = PAD + ci * cellW;
    for (let gy = 0; gy < GLYPH_H; gy++) {
      const rowBits = glyph[gy];
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if ((rowBits >> (GLYPH_W - 1 - gx)) & 1) {
          // draw a SCALE x SCALE block for this "on" pixel.
          for (let sy = 0; sy < SCALE; sy++) {
            for (let sx = 0; sx < SCALE; sx++) {
              setPx(ox + gx * SCALE + sx, PAD + gy * SCALE + sy);
            }
          }
        }
      }
    }
  });

  return PNG.sync.write(png);
}

/** Rasterise `text` into a PNG at `outPath`. Returns the byte length written. */
export function renderSlideTextPng(text: string, outPath: string, opts: RenderOpts = {}): number {
  const buf = renderTextPngBuffer(text, opts);
  writeFileSync(outPath, buf);
  return buf.length;
}

/** Stable content hash of a PNG file's bytes (for byte-exact per-slide compare). */
export function pngHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * True iff two PNG files differ pixel-for-pixel. Reads both back through pngjs
 * and compares RGBA buffers (falls back to a byte compare on size mismatch).
 * This is the REAL pixel diff `renderAndDiff` uses to detect a changed slide.
 */
export function pngPixelsDiffer(aPath: string, bPath: string): boolean {
  const a = readFileSync(aPath);
  const b = readFileSync(bPath);
  if (a.length !== b.length) return true;
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return true;
  return !pa.data.equals(pb.data);
}
