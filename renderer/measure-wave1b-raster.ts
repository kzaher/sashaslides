/**
 * Raster measurement for wave1b line-height fix.
 *
 * For slides 06 + 08, measure the actual line-to-line pitch (vertical
 * distance between successive text rows of glyphs) in the rendered
 * Google Slides thumbnail, compare to the Chrome target.
 *
 * Target: CSS line-height * fontSize (resolved in Chrome).
 * Tolerance: ±1.5% of target pitch.
 */
import { readFileSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
import CDP from "chrome-remote-interface";

type Pix = { data: Uint8Array; W: number; H: number };

function loadMask(path: string, pred: (r: number, g: number, b: number) => boolean): Pix {
  const png = PNG.sync.read(readFileSync(path));
  const W = png.width, H = png.height;
  const mask = new Uint8Array(W * H);
  for (let p = 0, i = 0; p < W * H; p++, i += 4) {
    if (pred(png.data[i], png.data[i+1], png.data[i+2])) mask[p] = 1;
  }
  return { data: mask, W, H };
}

/** For each row in [y0,y1], how many mask pixels appear in x range. */
function rowCounts(m: Pix, x0: number, x1: number, y0: number, y1: number): number[] {
  const out: number[] = [];
  for (let y = y0; y < y1; y++) {
    let c = 0;
    for (let x = x0; x < x1; x++) if (m.data[y * m.W + x]) c++;
    out.push(c);
  }
  return out;
}

/** Split row-counts into line clusters (contiguous runs of rows with count>threshold). */
function lineClusters(counts: number[], yStart: number, threshold = 3): { y: number; h: number; cy: number }[] {
  const out: { y: number; h: number; cy: number }[] = [];
  let s = -1;
  for (let i = 0; i <= counts.length; i++) {
    const on = i < counts.length && counts[i] > threshold;
    if (on && s < 0) s = i;
    else if (!on && s >= 0) {
      const y0 = yStart + s, y1 = yStart + i - 1;
      if (i - s >= 2) out.push({ y: y0, h: y1 - y0 + 1, cy: Math.round((y0 + y1) / 2) });
      s = -1;
    }
  }
  return out;
}

async function chromeTarget(htmlPath: string, selector: string): Promise<{ cssLh: string; fontSizePx: number; linePitchPx: number; bounds: any }> {
  const tab = await (CDP as any).New({ port: 9222, url: `file://${htmlPath}` });
  const client = await (CDP as any)({ target: tab, port: 9222 });
  const { Page, Runtime, Emulation } = client;
  await Page.enable(); await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await Page.navigate({ url: `file://${htmlPath}` });
  await Page.loadEventFired();
  await new Promise(r => setTimeout(r, 400));
  const expr = `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      // Per-line rects via Range to get actual line pitch.
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()].filter(rr => rr.width > 0 && rr.height > 0);
      // Pitch = average distance between consecutive line centers.
      let pitch = null;
      if (rects.length >= 2) {
        const centers = rects.map(rr => rr.top + rr.height / 2);
        const diffs = [];
        for (let i = 1; i < centers.length; i++) diffs.push(centers[i] - centers[i-1]);
        pitch = diffs.reduce((a,b) => a+b, 0) / diffs.length;
      }
      return {
        cssLh: cs.lineHeight,
        fontSizePx: parseFloat(cs.fontSize),
        linePitchPx: pitch,
        bounds: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        numLines: rects.length,
      };
    })()
  `;
  const res = await Runtime.evaluate({ expression: expr, returnByValue: true });
  await client.close(); await (CDP as any).Close({ port: 9222, id: tab.id });
  return res.result.value;
}

(async () => {
  // Slide 06 — quote.
  const s6 = await chromeTarget(
    "/workspaces/sashaslides/analysis/renderer/html2slides/e2e/fixtures/slide_06.html",
    ".quote-text",
  );
  // Slide 08 — step descriptions. Pick the first (step 1).
  const s8 = await chromeTarget(
    "/workspaces/sashaslides/analysis/renderer/html2slides/e2e/fixtures/slide_08.html",
    ".step-desc",
  );

  const mkRaster = (png: string, bounds: any, W = 1600, H = 900) => {
    // Scale slide bounds (1280x720) to thumbnail space.
    const sx = W / 1280, sy = H / 720;
    const x0 = Math.floor(bounds.x * sx) - 4;
    const x1 = Math.ceil((bounds.x + bounds.w) * sx) + 4;
    const y0 = Math.floor(bounds.y * sy) - 8;
    const y1 = Math.ceil((bounds.y + bounds.h) * sy) + 8;
    const dark = loadMask(png, (r, g, b) => r < 130 && g < 130 && b < 130);
    const counts = rowCounts(dark, Math.max(0, x0), Math.min(dark.W, x1), Math.max(0, y0), Math.min(dark.H, y1));
    const clusters = lineClusters(counts, Math.max(0, y0));
    let pitch = null;
    if (clusters.length >= 2) {
      const diffs = [];
      for (let i = 1; i < clusters.length; i++) diffs.push(clusters[i].cy - clusters[i-1].cy);
      pitch = diffs.reduce((a,b) => a+b, 0) / diffs.length;
    }
    // Convert thumbnail pitch back to slide-px for apples-to-apples.
    const pitchSlide = pitch !== null ? pitch * 720 / H : null;
    return { numLines: clusters.length, pitchThumb: pitch, pitchSlide };
  };

  const r6 = mkRaster("/tmp/sxs-complex/slides/slide_06.png", s6.bounds);
  const r8 = mkRaster("/tmp/sxs-complex/slides/slide_08.png", s8.bounds);

  const verdict = (target: number, actual: number | null) => {
    if (actual === null) return { pct: "n/a", ok: false };
    const delta = actual - target;
    const pct = ((delta / target) * 100).toFixed(2) + "%";
    return { pct, delta: delta.toFixed(2), ok: Math.abs(delta) / target < 0.015 };
  };

  console.log("=== slide_06 .quote-text ===");
  console.log(`  CSS line-height=${s6.cssLh}  fontSize=${s6.fontSizePx}px  Chrome target pitch=${s6.linePitchPx?.toFixed(2)}px (${s6.numLines} lines)`);
  console.log(`  Raster: ${r6.numLines} lines, pitch=${r6.pitchSlide?.toFixed(2)}px slide  (${r6.pitchThumb?.toFixed(2)}px thumb)`);
  if (s6.linePitchPx !== null && r6.pitchSlide !== null) {
    const v = verdict(s6.linePitchPx, r6.pitchSlide);
    console.log(`  Δ = ${v.delta}px = ${v.pct}  ${v.ok ? "✓ within 1.5%" : "✗ out of tolerance"}`);
  }

  console.log("\n=== slide_08 .step-desc (step 1) ===");
  console.log(`  CSS line-height=${s8.cssLh}  fontSize=${s8.fontSizePx}px  Chrome target pitch=${s8.linePitchPx?.toFixed(2)}px (${s8.numLines} lines)`);
  console.log(`  Raster: ${r8.numLines} lines, pitch=${r8.pitchSlide?.toFixed(2)}px slide  (${r8.pitchThumb?.toFixed(2)}px thumb)`);
  if (s8.linePitchPx !== null && r8.pitchSlide !== null) {
    const v = verdict(s8.linePitchPx, r8.pitchSlide);
    console.log(`  Δ = ${v.delta}px = ${v.pct}  ${v.ok ? "✓ within 1.5%" : "✗ out of tolerance"}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
