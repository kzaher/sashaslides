/**
 * Wave 1B line-height measurement.
 *
 * Target text elements (multi-line main text):
 *   slide_06 — .quote-text  (3-line italic Playfair Display block, line-height:1.6)
 *   slide_08 — .step-desc   (4 pills, blue step-desc paragraphs, line-height:1.6)
 *
 * Per element we produce three line-pitch numbers:
 *
 *   1. CHROME target pitch:  use Range per-line rects via getClientRects()
 *      and measure distance between consecutive line centers (px, slide space).
 *   2. CSS lineHeightPx:     computed style lineHeight resolved to px.
 *   3. EMITTED pitch:        parse /tmp/sxs-wave1b.pptx; pull the shape
 *      whose text matches (or first significant text of its run set),
 *      read <a:lnSpc><a:spcPct val>, and compute
 *      emitted_pitch_px = (spcPct/100000) * fontSize.
 *
 * Tolerance: 1% of CHROME target pitch.
 */
import CDP from "chrome-remote-interface";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");
const { PNG } = require("pngjs");

const FIXTURES = "/workspaces/sashaslides/analysis/renderer/html2slides/e2e/fixtures";
const PPTX = "/tmp/sxs-wave1b.pptx";
const SLIDE_W_PX = 1280, SLIDE_H_PX = 720;

type Target = {
  slideIdx: number; // slide number inside pptx (1-based: slide_06 → 1, slide_08 → 2 in our --only order)
  htmlFile: string;
  selector: string;   // CSS selector for the element to measure
  textMatch: string;  // substring of textContent to match the corresponding emitted shape
  label: string;
};

const TARGETS: Target[] = [
  { slideIdx: 1, htmlFile: "slide_06.html", selector: ".quote-text",                textMatch: "This platform completely transformed", label: "slide_06 .quote-text (3 lines, 26px italic)" },
  { slideIdx: 2, htmlFile: "slide_08.html", selector: ".step:nth-child(1) .step-desc", textMatch: "Deep dive into requirements",         label: "slide_08 step1 .step-desc (4 lines, 13px)" },
  { slideIdx: 2, htmlFile: "slide_08.html", selector: ".step:nth-child(3) .step-desc", textMatch: "Create wireframes",                     label: "slide_08 step2 .step-desc" },
  { slideIdx: 2, htmlFile: "slide_08.html", selector: ".step:nth-child(5) .step-desc", textMatch: "Agile sprints with CI/CD",             label: "slide_08 step3 .step-desc" },
  { slideIdx: 2, htmlFile: "slide_08.html", selector: ".step:nth-child(7) .step-desc", textMatch: "Phased rollout",                       label: "slide_08 step4 .step-desc" },
];

// Raster thumbnails from the current (pre-fix) render. Used to extract the
// actual pitch Slides produced and compute the pt-equivalent default-leading
// factor (typical PowerPoint: 1.2 of font size).
const RASTER_PNGS: Record<string, string> = {
  "slide_06.html": "/tmp/sxs-complex/slides/slide_06.png",
  "slide_08.html": "/tmp/sxs-complex/slides/slide_08.png",
};

// Given a thumbnail PNG and a rough y-range in slide-space pixels, find dark
// text rows (rows containing >=N darker-than-bg pixels) and cluster into lines.
// Returns the mean pitch (slide-space px) between consecutive line centroids.
function rasterPitchInRegion(pngPath: string, x0Slide: number, x1Slide: number, y0Slide: number, y1Slide: number, _darkThresh = 100, minRowPixels = 3): number | null {
  if (!existsSync(pngPath)) return null;
  const png = PNG.sync.read(readFileSync(pngPath));
  const { width: W, height: H, data } = png;
  const scaleX = W / SLIDE_W_PX, scaleY = H / SLIDE_H_PX;
  const x0 = Math.max(0, Math.round(x0Slide * scaleX));
  const x1 = Math.min(W - 1, Math.round(x1Slide * scaleX));
  const y0 = Math.max(0, Math.round(y0Slide * scaleY));
  const y1 = Math.min(H - 1, Math.round(y1Slide * scaleY));
  // Estimate background luminance from the first/last rows of the region (assume
  // those rows are mostly background). Anything with |L - bgL| > 40 is text.
  const luma = (r: number, g: number, b: number) => 0.299*r + 0.587*g + 0.114*b;
  const sampleRow = (yy: number) => {
    let sum = 0, n = 0;
    for (let x = x0; x <= x1; x++) {
      const idx = (yy * W + x) * 4;
      sum += luma(data[idx], data[idx+1], data[idx+2]); n++;
    }
    return n ? sum / n : 255;
  };
  const bgL = (sampleRow(y0) + sampleRow(y1)) / 2;
  // For each row, count text pixels.
  const darkCount = new Array(y1 - y0 + 1).fill(0);
  for (let y = y0; y <= y1; y++) {
    let n = 0;
    for (let x = x0; x <= x1; x++) {
      const idx = (y * W + x) * 4;
      const L = luma(data[idx], data[idx+1], data[idx+2]);
      if (Math.abs(L - bgL) > 40) n++;
    }
    darkCount[y - y0] = n;
  }
  // Cluster rows into lines: contiguous y's with darkCount >= minRowPixels.
  const lines: { y0: number; y1: number; peak: number; peakY: number }[] = [];
  let cur: any = null;
  for (let i = 0; i < darkCount.length; i++) {
    if (darkCount[i] >= minRowPixels) {
      if (!cur) cur = { y0: i, y1: i, peak: darkCount[i], peakY: i };
      else { cur.y1 = i; if (darkCount[i] > cur.peak) { cur.peak = darkCount[i]; cur.peakY = i; } }
    } else if (cur) {
      if (cur.y1 - cur.y0 >= 1) lines.push(cur);
      cur = null;
    }
  }
  if (cur && cur.y1 - cur.y0 >= 1) lines.push(cur);
  if (lines.length < 2) return null;
  // Compute pitch using peak (most-covered) y of each line.
  const centers = lines.map(L => y0 + L.peakY);   // thumbnail px
  let sum = 0, n = 0;
  for (let i = 1; i < centers.length; i++) { sum += (centers[i] - centers[i-1]); n++; }
  const pitchThumb = sum / n;
  return pitchThumb / scaleY;   // back to slide-space px
}

async function measureChrome(htmlFile: string, selector: string): Promise<{ pitch: number; cssLh: string; cssLhPx: number; fontSizePx: number; lineCount: number; rectYs: number[]; bbox: { x: number; y: number; w: number; h: number } }> {
  const abs = resolve(FIXTURES, htmlFile);
  const tab = await (CDP as any).New({ port: 9222, url: `file://${abs}` });
  const client = await (CDP as any)({ target: tab, port: 9222 });
  const { Page, Runtime, Emulation } = client;
  await Page.enable(); await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: SLIDE_W_PX, height: SLIDE_H_PX, deviceScaleFactor: 2, mobile: false });
  await Page.navigate({ url: `file://${abs}` });
  await Page.loadEventFired();
  await new Promise(r => setTimeout(r, 800));
  await Runtime.evaluate({ expression: `document.fonts.ready.then(() => true)`, awaitPromise: true, returnByValue: true });
  await new Promise(r => setTimeout(r, 200));

  const script = `
    (() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ err: "no element" });
      const bboxRect = el.getBoundingClientRect();
      const bbox = { x: bboxRect.x, y: bboxRect.y, w: bboxRect.width, h: bboxRect.height };
      const cs = getComputedStyle(el);
      const rawLh = cs.lineHeight;              // e.g. "1.6" unresolved? Actually Chrome returns px for numeric multipliers.
      const cssLhPx = parseFloat(rawLh);         // NaN if "normal"
      const fontSizePx = parseFloat(cs.fontSize);
      // Build range over all text nodes to get per-line rects.
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = [...range.getClientRects()];
      // Sort by y, keep one rect per distinct line (cluster rects whose top is within 2px).
      const lines = [];
      for (const r of rects) {
        if (r.width < 1 || r.height < 1) continue;
        const found = lines.find(L => Math.abs(L.top - r.top) < 2);
        if (found) {
          found.left = Math.min(found.left, r.left);
          found.right = Math.max(found.right, r.right);
          found.bottom = Math.max(found.bottom, r.bottom);
        } else {
          lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
        }
      }
      lines.sort((a,b) => a.top - b.top);
      const centers = lines.map(L => (L.top + L.bottom) / 2);
      let pitchSum = 0, pitchCount = 0;
      for (let i = 1; i < centers.length; i++) { pitchSum += centers[i] - centers[i-1]; pitchCount++; }
      const pitch = pitchCount > 0 ? pitchSum / pitchCount : 0;
      return JSON.stringify({
        cssLh: rawLh, cssLhPx, fontSizePx,
        lineCount: lines.length,
        centers: centers.map(v => +v.toFixed(2)),
        pitch: +pitch.toFixed(2),
        bbox: { x: +bbox.x.toFixed(1), y: +bbox.y.toFixed(1), w: +bbox.w.toFixed(1), h: +bbox.h.toFixed(1) },
      });
    })()
  `;
  const r = await Runtime.evaluate({ expression: script, returnByValue: true });
  await client.close(); await (CDP as any).Close({ port: 9222, id: tab.id });
  const parsed = JSON.parse(r.result.value);
  if (parsed.err) throw new Error(`${htmlFile} ${selector}: ${parsed.err}`);
  return { pitch: parsed.pitch, cssLh: parsed.cssLh, cssLhPx: parsed.cssLhPx, fontSizePx: parsed.fontSizePx, lineCount: parsed.lineCount, rectYs: parsed.centers, bbox: parsed.bbox };
}

async function loadPptxSlideXml(slideIdx: number): Promise<string> {
  const zip = await JSZip.loadAsync(readFileSync(PPTX));
  const name = `ppt/slides/slide${slideIdx}.xml`;
  const f = zip.file(name);
  if (!f) throw new Error(`${name} not in pptx`);
  return await f.async("string");
}

function findShape(xml: string, textSubstr: string): { spcPct: number | null; fontSizePt: number | null; fullRunText: string } | null {
  const spBlocks = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
  for (const sp of spBlocks) {
    const texts = [...sp.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).join("");
    if (!texts.includes(textSubstr)) continue;
    // Line spacing: look for <a:lnSpc><a:spcPct val="...">
    const spcPctMatch = sp.match(/<a:lnSpc>\s*<a:spcPct\s+val="(\d+)"/);
    const spcPct = spcPctMatch ? +spcPctMatch[1] : null;
    // First run font size in hundredths of pt (sz attribute on rPr)
    const szMatch = sp.match(/<a:rPr[^>]*sz="(\d+)"/);
    const fontSizePt = szMatch ? +szMatch[1] / 100 : null;
    return { spcPct, fontSizePt, fullRunText: texts };
  }
  return null;
}

const PT2PX = 96 / 72;

(async () => {
  console.log("=".repeat(92));
  console.log("WAVE 1B LINE-HEIGHT MEASUREMENT  (slide_06 .quote-text + slide_08 .step-desc)");
  console.log("=".repeat(92));
  const rows: any[] = [];
  for (const t of TARGETS) {
    const chrome = await measureChrome(t.htmlFile, t.selector);
    const xml = await loadPptxSlideXml(t.slideIdx);
    const emitted = findShape(xml, t.textMatch);
    if (!emitted) { console.log(`  [MISS] no emitted shape containing "${t.textMatch}" in slide ${t.slideIdx}`); continue; }

    // Emitted pt → slide-space px. PX2PT = SLIDE_W_IN/SLIDE_W_PX*72 = 0.5625,
    // so slide-space px = pt / 0.5625.
    const PX2PT_EMIT = 0.5625;
    const emittedFontSizePxSlide = emitted.fontSizePt != null ? emitted.fontSizePt / PX2PT_EMIT : NaN;
    // Slides interprets spcPct as a multiplier of its default line spacing
    // (≈1.2 * fontSize). So actual rendered pitch ≈ (spcPct/100000) * 1.2 * fontSizePx.
    const SLIDES_DEFAULT_LEADING = 1.2;
    const emittedPitchPx = emitted.spcPct != null && !isNaN(emittedFontSizePxSlide)
      ? (emitted.spcPct / 100000) * SLIDES_DEFAULT_LEADING * emittedFontSizePxSlide
      : NaN;
    const targetPitch = chrome.pitch;
    const deltaPx = emittedPitchPx - targetPitch;
    const deltaPct = targetPitch > 0 ? (deltaPx / targetPitch) * 100 : 0;
    const pass = Math.abs(deltaPct) <= 1.0;

    // Raster pitch: read slides thumbnail at the bbox region (slight pad).
    const pngPath = RASTER_PNGS[t.htmlFile];
    const rasterPitch = pngPath
      ? rasterPitchInRegion(pngPath, chrome.bbox.x - 2, chrome.bbox.x + chrome.bbox.w + 2, chrome.bbox.y - 4, chrome.bbox.y + chrome.bbox.h + 10)
      : null;
    const rasterDeltaPct = rasterPitch ? ((rasterPitch - targetPitch) / targetPitch) * 100 : NaN;

    rows.push({
      label: t.label,
      cssLh: chrome.cssLh,
      cssLhPx: chrome.cssLhPx.toFixed(2),
      fontSizePx: chrome.fontSizePx.toFixed(2),
      lineCount: chrome.lineCount,
      targetPitchPx: targetPitch.toFixed(2),
      emittedSpcPct: emitted.spcPct,
      emittedFontPt: emitted.fontSizePt,
      emittedFontPx: emittedFontSizePxSlide.toFixed(2),
      emittedPitchPx: emittedPitchPx.toFixed(2),
      deltaPx: deltaPx.toFixed(2),
      deltaPct: deltaPct.toFixed(2) + "%",
      rasterPitchPx: rasterPitch ? rasterPitch.toFixed(2) : "n/a",
      rasterDeltaPct: rasterPitch ? rasterDeltaPct.toFixed(2) + "%" : "n/a",
      pass,
    });
  }

  console.log("\n-- Per-element table --\n");
  for (const r of rows) {
    console.log(`[${r.pass ? "PASS" : "FAIL"}]  ${r.label}`);
    console.log(`    CSS            line-height=${r.cssLh} ( ${r.cssLhPx}px )   fontSize=${r.fontSizePx}px   lines=${r.lineCount}`);
    console.log(`    TARGET pitch   ${r.targetPitchPx}px  (per-line-center distance from Range.getClientRects)`);
    console.log(`    EMITTED        spcPct=${r.emittedSpcPct} (${(r.emittedSpcPct/1000).toFixed(2)}%)  fontSize=${r.emittedFontPt}pt (=${r.emittedFontPx}px)`);
    console.log(`    EMITTED pitch  ${r.emittedPitchPx}px`);
    console.log(`    DELTA (OOXML)  ${r.deltaPx}px  ${r.deltaPct}  (tol: +/-1%)`);
    console.log(`    RASTER pitch   ${r.rasterPitchPx}px  (pre-fix Slides rendering)   vs target ${r.rasterDeltaPct}`);
    console.log("");
  }
  const failed = rows.filter(r => !r.pass).length;
  console.log(`Summary: ${rows.length - failed}/${rows.length} pass (1% tol).`);
})().catch(e => { console.error(e); process.exit(1); });
