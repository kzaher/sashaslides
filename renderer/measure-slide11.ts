/**
 * Measurement script for slide_11 vertical-centering fix.
 *
 * Three measurements:
 *   1. TARGET — Live Chrome rendering of the HTML. For each ".inner" pill,
 *      report the pill's border-box rect AND the text node's Range rect.
 *      The text's center-Y within the pill is the ground truth.
 *   2. EMITTED — Parse /tmp/sxs/basics.pptx. For each Leaf text shape,
 *      read <a:off> / <a:ext> bounds, and <a:bodyPr anchor="..."> (ctr|t|b).
 *      Compute what center-Y pptxgenjs is asking Slides to render at.
 *   3. RASTER — Load /tmp/sxs/slides/slide_11.png. Find pink pill rects
 *      by pixel color, then find the dark-red text centroid inside each.
 *      That's what Slides actually rendered.
 *
 * Success criterion: TARGET, EMITTED, RASTER all agree on text-center-Y
 * within 2 px (scaled appropriately).
 */
import CDP from "chrome-remote-interface";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const { PNG } = require("pngjs");

const HTML = resolve("/workspaces/sashaslides/analysis/renderer/html2slides/e2e/fixtures-basic/slide_11_nested_divs.html");
const PPTX = "/tmp/sxs/basics.pptx";
const PNG_PATH = "/tmp/sxs/slides/slide_11.png";
const SLIDE_W_PX = 1280, SLIDE_H_PX = 720;
const EMU_PER_IN = 914400, SLIDE_W_IN = 10;
const EMU2PX = SLIDE_W_PX / (SLIDE_W_IN * EMU_PER_IN);

async function measureChrome() {
  const tab = await (CDP as any).New({ port: 9222, url: `file://${HTML}` });
  const client = await (CDP as any)({ target: tab, port: 9222 });
  const { Page, Runtime, Emulation } = client;
  await Page.enable(); await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: SLIDE_W_PX, height: SLIDE_H_PX, deviceScaleFactor: 2, mobile: false });
  await Page.navigate({ url: `file://${HTML}` });
  await Page.loadEventFired();
  await new Promise(r => setTimeout(r, 400));
  const script = `
    (() => {
      const out = [];
      for (const inner of document.querySelectorAll('.inner')) {
        const r = inner.getBoundingClientRect();
        const textNode = [...inner.childNodes].find(n => n.nodeType === 3);
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const tr = range.getBoundingClientRect();
        out.push({
          text: textNode.textContent.trim(),
          pill: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cy: Math.round(r.y + r.height/2) },
          textRect: { x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height), cy: Math.round(tr.y + tr.height/2) },
        });
      }
      return JSON.stringify(out);
    })()
  `;
  const r = await Runtime.evaluate({ expression: script, returnByValue: true });
  await client.close(); await (CDP as any).Close({ port: 9222, id: tab.id });
  return JSON.parse(r.result.value);
}

async function measurePptx() {
  const buf = readFileSync(PPTX);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("ppt/slides/slide11.xml")!.async("string");
  // Extract each <p:sp> with its bounds, bodyPr anchor, and visible text.
  const spBlocks = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
  const out: any[] = [];
  for (const sp of spBlocks) {
    const off = sp.match(/<a:off x="(\d+)" y="(\d+)"\/>/);
    const ext = sp.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    if (!off || !ext) continue;
    const x = +off[1] * EMU2PX, y = +off[2] * EMU2PX;
    const w = +ext[1] * EMU2PX, h = +ext[2] * EMU2PX;
    const anchor = sp.match(/<a:bodyPr[^>]*anchor="(\w+)"/);
    const texts = [...sp.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]);
    out.push({
      text: texts.join(""),
      x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
      cy: Math.round(y + h/2),
      anchor: anchor?.[1] || "(default=t)",
    });
  }
  return out;
}

function measureRaster() {
  const png = PNG.sync.read(readFileSync(PNG_PATH));
  const { width: W, height: H, data } = png;
  // Detect pink pill pixels: #fee2e2 (254, 226, 226) bg OR #ef4444 (239, 68, 68) border.
  // Pills are small (~96x48 in 1600x900). Scan rows.
  const pillMask = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < W * H; p++, i += 4) {
    const r = data[i], g = data[i+1], b = data[i+2];
    const pink = r > 240 && g > 210 && g < 240 && b > 210 && b < 240;
    const red = r > 220 && g < 110 && b < 110;
    const darkRed = r > 120 && r < 180 && g < 50 && b < 50;
    if (pink || red) pillMask[p] = 1;
    if (darkRed) pillMask[p] = 2; // text pixel
  }
  // Find 3 pill clusters by column projection.
  const colHas = new Uint8Array(W);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (pillMask[y * W + x] === 1) { colHas[x] = 1; break; }
    }
  }
  // Find contiguous column ranges.
  const clusters: { x0: number; x1: number }[] = [];
  let start = -1;
  for (let x = 0; x <= W; x++) {
    if (x < W && colHas[x]) { if (start < 0) start = x; }
    else if (start >= 0) {
      if (x - start > 40) clusters.push({ x0: start, x1: x - 1 });
      start = -1;
    }
  }
  // For each cluster, find pill Y-range (rows with pink) + text Y-range (rows with dark red).
  const out: any[] = [];
  for (const c of clusters) {
    let pillYMin = H, pillYMax = -1, textYMin = H, textYMax = -1, textCount = 0, textYSum = 0;
    for (let y = 0; y < H; y++) {
      let hasPill = false, hasText = false;
      for (let x = c.x0; x <= c.x1; x++) {
        const m = pillMask[y * W + x];
        if (m === 1) hasPill = true;
        else if (m === 2) { hasText = true; textCount++; textYSum += y; }
      }
      if (hasPill) { if (y < pillYMin) pillYMin = y; if (y > pillYMax) pillYMax = y; }
      if (hasText) { if (y < textYMin) textYMin = y; if (y > textYMax) textYMax = y; }
    }
    out.push({
      pill: { x: c.x0, x1: c.x1, yMin: pillYMin, yMax: pillYMax, cy: Math.round((pillYMin + pillYMax) / 2) },
      text: textCount > 0 ? {
        yMin: textYMin, yMax: textYMax,
        cy: Math.round((textYMin + textYMax) / 2),
        centroidY: Math.round(textYSum / textCount),
      } : null,
    });
  }
  return { W, H, clusters: out };
}

(async () => {
  console.log("=== 1. TARGET — live Chrome (HTML pixels, slide space 1280x720) ===");
  const chrome = await measureChrome();
  for (const c of chrome) {
    const offset = c.textRect.cy - c.pill.cy;
    console.log(`  ${c.text}: pill cy=${c.pill.cy}  text cy=${c.textRect.cy}  offset=${offset >= 0 ? '+' : ''}${offset}`);
  }
  const chromeOffset = chrome[0] ? chrome[0].textRect.cy - chrome[0].pill.cy : 0;

  console.log("\n=== 2. EMITTED — parsed basics.pptx slide11.xml (slide space 1280x720) ===");
  const pptx = await measurePptx();
  const leafShapes = pptx.filter(s => /^Leaf [ABC]$/.test(s.text));
  const pillShapes = pptx.filter(s => s.w < 100 && s.w > 50 && s.h < 60 && s.h > 20 && !s.text);
  for (const s of leafShapes) {
    console.log(`  TEXT shape "${s.text}": y=${s.y} h=${s.h} cy=${s.cy} anchor=${s.anchor}`);
  }
  for (const s of pillShapes) {
    console.log(`  PILL shape:          y=${s.y} h=${s.h} cy=${s.cy}`);
  }

  console.log("\n=== 3. RASTER — rendered thumbnail /tmp/sxs/slides/slide_11.png ===");
  const raster = measureRaster();
  console.log(`  thumbnail size: ${raster.W}x${raster.H}`);
  const thumbScale = raster.H / SLIDE_H_PX;
  for (const c of raster.clusters) {
    if (!c.text) continue;
    const textCyInSlidePx = Math.round(c.text.cy / thumbScale);
    const pillCyInSlidePx = Math.round(c.pill.cy / thumbScale);
    const offset = textCyInSlidePx - pillCyInSlidePx;
    console.log(`  cluster x=${c.pill.x}-${c.pill.x1}: pill.cy(thumb)=${c.pill.cy} → ${pillCyInSlidePx}px slide   text.cy(thumb)=${c.text.cy} → ${textCyInSlidePx}px slide   offset=${offset >= 0 ? '+' : ''}${offset}`);
  }

  console.log("\n=== VERDICT ===");
  const firstPill = raster.clusters.find(c => c.text);
  if (firstPill && firstPill.text) {
    const rasterOffset = Math.round(firstPill.text.cy / thumbScale) - Math.round(firstPill.pill.cy / thumbScale);
    const delta = rasterOffset - chromeOffset;
    console.log(`  Chrome (target) text-vs-pill offset: ${chromeOffset}px`);
    console.log(`  Raster  (actual) text-vs-pill offset: ${rasterOffset}px`);
    console.log(`  Divergence: ${delta}px ${Math.abs(delta) <= 2 ? "✓ within 2 px tolerance" : "✗ BUG STILL PRESENT"}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
