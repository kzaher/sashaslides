/**
 * br-probe.ts — Bottom-Right table region: pixel-diff Chrome render vs Slides render.
 *
 * - Downsamples /tmp/sxs/originals/slide_17.png (2560x1440) → 1600x900 via ImageMagick
 *   so its coordinate system matches /tmp/sxs/slides/slide_17.png (1600x900).
 * - Detects bottom-right `.colored-wrap` pink region (#ec4899) bbox in 1600x900 space.
 * - Crops both PNGs to bbox + 20 px padding.
 * - Runs pixelmatch (threshold=0) over the cropped regions.
 * - Writes: /tmp/br-probe-original.png, /tmp/br-probe-slide.png, /tmp/br-probe-diff.png.
 * - Prints: bbox, diff count, total pixels, percentage.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

// Native-DPR Chrome render (1600x900, deviceScaleFactor=1.25). Skips
// Lanczos downsample artifacts that produced ~7-point RGB delta along
// color-boundary scanlines, drowning the real diff signal.
const ORIG_SRC = "/tmp/br-probe-original-native.png";
const SLIDE_SRC = "/tmp/sxs/slides/slide_17.png";

function loadPng(path: string): PNG {
  const buf = readFileSync(path);
  return PNG.sync.read(buf);
}

function ensureNativeOriginal(): void {
  execSync(`npx tsx tools/table-twoway/shot-orig-native.ts`, { stdio: "pipe" });
}

interface Bbox { x: number; y: number; w: number; h: number }

function findBottomRightPinkBbox(png: PNG): Bbox {
  // Target pink: #ec4899 → (236, 72, 153). Tolerate ±24 per channel after AA.
  const isPink = (r: number, g: number, b: number): boolean =>
    Math.abs(r - 236) <= 24 && Math.abs(g - 72) <= 24 && Math.abs(b - 153) <= 24;
  const W = png.width, H = png.height;
  // For each row, count pink pixels in the right half. The bottom-right
  // `.colored-wrap` is a contiguous vertical band of rows with pink. We
  // walk from y=H-1 upward, locating the first row that has pink, then
  // expanding upward as long as consecutive rows have pink. Stop when we
  // hit a clean (no-pink) row — that gap separates this wrap from the
  // one above (the middle-right wrap).
  const rowHasPink = new Array<boolean>(H).fill(false);
  for (let y = 0; y < H; y++) {
    for (let x = Math.floor(W / 2); x < W; x++) {
      const i = (y * W + x) * 4;
      if (isPink(png.data[i], png.data[i + 1], png.data[i + 2])) {
        rowHasPink[y] = true;
        break;
      }
    }
  }
  let yBottom = -1;
  for (let y = H - 1; y >= 0; y--) {
    if (rowHasPink[y]) { yBottom = y; break; }
  }
  if (yBottom < 0) throw new Error("No pink found in right half.");
  let yTop = yBottom;
  while (yTop > 0 && rowHasPink[yTop - 1]) yTop--;
  // Find horizontal extent within [yTop, yBottom].
  let minX = W, maxX = -1;
  for (let y = yTop; y <= yBottom; y++) {
    for (let x = Math.floor(W / 2); x < W; x++) {
      const i = (y * W + x) * 4;
      if (isPink(png.data[i], png.data[i + 1], png.data[i + 2])) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return { x: minX, y: yTop, w: maxX - minX + 1, h: yBottom - yTop + 1 };
}

function cropPng(src: PNG, bbox: Bbox): PNG {
  const out = new PNG({ width: bbox.w, height: bbox.h });
  for (let y = 0; y < bbox.h; y++) {
    for (let x = 0; x < bbox.w; x++) {
      const si = ((y + bbox.y) * src.width + (x + bbox.x)) * 4;
      const di = (y * out.width + x) * 4;
      out.data[di    ] = src.data[si    ];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

function main(): void {
  ensureNativeOriginal();
  if (!existsSync(ORIG_SRC) || !existsSync(SLIDE_SRC)) {
    throw new Error(`Missing inputs:\n  ${ORIG_SRC}\n  ${SLIDE_SRC}`);
  }
  const orig = loadPng(ORIG_SRC);
  const slide = loadPng(SLIDE_SRC);
  if (orig.width !== slide.width || orig.height !== slide.height) {
    throw new Error(`Size mismatch: orig=${orig.width}x${orig.height} slide=${slide.width}x${slide.height}`);
  }
  const bbox = findBottomRightPinkBbox(orig);
  const bboxSlide = findBottomRightPinkBbox(slide);
  console.log(`bottom-right pink in original: x=${bbox.x} y=${bbox.y} w=${bbox.w} h=${bbox.h}`);
  console.log(`bottom-right pink in slide:    x=${bboxSlide.x} y=${bboxSlide.y} w=${bboxSlide.w} h=${bboxSlide.h}`);
  console.log(`delta (slide - orig):          dx=${bboxSlide.x - bbox.x} dy=${bboxSlide.y - bbox.y} dw=${bboxSlide.w - bbox.w} dh=${bboxSlide.h - bbox.h}`);
  const PAD = 20;
  const exp: Bbox = {
    x: Math.max(0, bbox.x - PAD),
    y: Math.max(0, bbox.y - PAD),
    w: Math.min(orig.width  - Math.max(0, bbox.x - PAD), bbox.w + PAD * 2),
    h: Math.min(orig.height - Math.max(0, bbox.y - PAD), bbox.h + PAD * 2),
  };
  console.log(`expanded (+${PAD}px pad):                x=${exp.x} y=${exp.y} w=${exp.w} h=${exp.h}`);
  const cOrig = cropPng(orig, exp);
  const cSlide = cropPng(slide, exp);
  writeFileSync("/tmp/br-probe-original.png", PNG.sync.write(cOrig));
  writeFileSync("/tmp/br-probe-slide.png", PNG.sync.write(cSlide));
  const total = exp.w * exp.h;
  // Strict (threshold=0): every non-identical pixel, including imperceptible AA.
  const diffStrict = new PNG({ width: exp.w, height: exp.h });
  const nStrict = pixelmatch(cOrig.data, cSlide.data, diffStrict.data, exp.w, exp.h, {
    threshold: 0, includeAA: true,
  });
  // Project gate (threshold=0.35, includeAA=true): the SAME settings
  // check-goldens.ts uses for its Chrome-vs-Slides "live" diff. This is
  // the number that decides whether the project considers it a match.
  const diff = new PNG({ width: exp.w, height: exp.h });
  const diffCount = pixelmatch(cOrig.data, cSlide.data, diff.data, exp.w, exp.h, {
    threshold: 0.35, includeAA: true, alpha: 0,
  });
  writeFileSync("/tmp/br-probe-diff.png", PNG.sync.write(diff));
  writeFileSync("/tmp/br-probe-diff-strict.png", PNG.sync.write(diffStrict));
  console.log(`pixelmatch STRICT  (threshold=0,    includeAA): ${nStrict} px / ${total} (${(100 * nStrict / total).toFixed(4)}%)`);
  console.log(`pixelmatch PROJECT (threshold=0.35, includeAA): ${diffCount} px / ${total} (${(100 * diffCount / total).toFixed(4)}%)`);
  console.log(`  /tmp/br-probe-original.png  /tmp/br-probe-slide.png  /tmp/br-probe-diff.png`);
}

main();
