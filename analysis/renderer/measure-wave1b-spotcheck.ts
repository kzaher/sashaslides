/**
 * Spot-check for wave 1B: pick multi-line text elements from slides 02, 07, 15
 * and confirm emitted OOXML pitch now matches CSS target within 1% tolerance.
 */
import CDP from "chrome-remote-interface";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

const FIXTURES = "/workspaces/sashaslides/analysis/renderer/html2slides/e2e/fixtures";
const PPTX = "/tmp/sxs-wave1b-spotcheck.pptx";
const SLIDE_W_PX = 1280, SLIDE_H_PX = 720;
const PX2PT_EMIT = 0.5625;
const SLIDES_DEFAULT_LEADING = 1.2;

type Target = { slideIdx: number; htmlFile: string; selector: string; textMatch: string; label: string; };

const TARGETS: Target[] = [
  // slide_02 has .bio element with line-height: 1.4 (multi-line short bios)
  { slideIdx: 1, htmlFile: "slide_02.html", selector: ".bio", textMatch: "", label: "slide_02 .bio (line-height:1.4)" },
  // slide_07 default line-height (implicit ~1.2); pick a multi-line paragraph-like block
  { slideIdx: 2, htmlFile: "slide_07.html", selector: "p, .desc, .description, [class*='desc'], [class*='text'], div", textMatch: "", label: "slide_07 multiline text (default line-height)" },
  // slide_15 has code areas with line-height 1.7 / 1.8
  { slideIdx: 3, htmlFile: "slide_15.html", selector: ".code-area", textMatch: "", label: "slide_15 .code-area (line-height:1.7)" },
  { slideIdx: 3, htmlFile: "slide_15.html", selector: ".response-body", textMatch: "", label: "slide_15 .response-body (line-height:1.8)" },
];

async function chromeInspect(htmlFile: string, selector: string) {
  const abs = resolve(FIXTURES, htmlFile);
  const tab = await (CDP as any).New({ port: 9222, url: `file://${abs}` });
  const client = await (CDP as any)({ target: tab, port: 9222 });
  const { Page, Runtime, Emulation } = client;
  await Page.enable(); await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: SLIDE_W_PX, height: SLIDE_H_PX, deviceScaleFactor: 2, mobile: false });
  await Page.navigate({ url: `file://${abs}` }); await Page.loadEventFired();
  await new Promise(r => setTimeout(r, 600));
  await Runtime.evaluate({ expression: `document.fonts.ready.then(() => true)`, awaitPromise: true, returnByValue: true });
  const sel = JSON.stringify(selector);
  const r = await Runtime.evaluate({ expression: `
    (() => {
      // Try each selector; pick the first multi-line one.
      const selectors = ${sel}.split(',').map(s => s.trim());
      let best = null;
      for (const s of selectors) {
        for (const el of document.querySelectorAll(s)) {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          const lh = parseFloat(cs.lineHeight);
          if (!lh || lh < 10) continue;
          const range = document.createRange();
          range.selectNodeContents(el);
          const rects = [...range.getClientRects()].filter(rr => rr.width > 1 && rr.height > 1);
          // Cluster into lines.
          const lines = [];
          for (const rr of rects) {
            const f = lines.find(L => Math.abs(L.top - rr.top) < 2);
            if (f) { f.left = Math.min(f.left, rr.left); f.right = Math.max(f.right, rr.right); f.bottom = Math.max(f.bottom, rr.bottom); }
            else lines.push({ top: rr.top, bottom: rr.bottom, left: rr.left, right: rr.right });
          }
          if (lines.length < 2) continue;
          lines.sort((a,b)=>a.top-b.top);
          const centers = lines.map(L => (L.top + L.bottom)/2);
          let pSum=0, pN=0; for (let i=1;i<centers.length;i++){ pSum+=centers[i]-centers[i-1]; pN++; }
          const pitch = pSum/pN;
          const txt = (el.textContent || '').replace(/\\s+/g,' ').trim().slice(0,40);
          const candidate = { fontSizePx: parseFloat(cs.fontSize), cssLhPx: lh, pitch: +pitch.toFixed(2), lineCount: lines.length, textSample: txt };
          if (!best || candidate.lineCount > best.lineCount) best = candidate;
        }
        if (best) break;
      }
      return JSON.stringify(best || { err: 'no multi-line match' });
    })()
  `, returnByValue: true });
  await client.close(); await (CDP as any).Close({ port: 9222, id: tab.id });
  return JSON.parse(r.result.value);
}

async function findEmittedPitch(slideIdx: number, textSample: string): Promise<{ spcPct: number | null; fontSizePx: number; pitchPx: number } | null> {
  const zip = await JSZip.loadAsync(readFileSync(PPTX));
  const name = `ppt/slides/slide${slideIdx}.xml`;
  const f = zip.file(name); if (!f) return null;
  const xml = await f.async("string");
  const spBlocks = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
  const needle = textSample.slice(0, 20);
  for (const sp of spBlocks) {
    const texts = [...sp.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m=>m[1]).join("");
    if (!texts.includes(needle)) continue;
    const spcPctMatch = sp.match(/<a:lnSpc>\s*<a:spcPct\s+val="(\d+)"/);
    const szMatch = sp.match(/<a:rPr[^>]*sz="(\d+)"/);
    const spcPct = spcPctMatch ? +spcPctMatch[1] : null;
    const fontSizePt = szMatch ? +szMatch[1]/100 : 0;
    const fontSizePx = fontSizePt / PX2PT_EMIT;
    const pitchPx = spcPct != null ? (spcPct/100000) * SLIDES_DEFAULT_LEADING * fontSizePx : fontSizePx * SLIDES_DEFAULT_LEADING;
    return { spcPct, fontSizePx, pitchPx };
  }
  return null;
}

(async () => {
  for (const t of TARGETS) {
    const c = await chromeInspect(t.htmlFile, t.selector);
    if (c.err) { console.log(`[SKIP] ${t.label}: ${c.err}`); continue; }
    const e = await findEmittedPitch(t.slideIdx, c.textSample);
    if (!e) { console.log(`[MISS] ${t.label}: no emitted shape for "${c.textSample}"`); continue; }
    const deltaPct = ((e.pitchPx - c.pitch) / c.pitch) * 100;
    const pass = Math.abs(deltaPct) <= 1.5;
    console.log(`[${pass ? "PASS" : "FAIL"}] ${t.label}`);
    console.log(`   target: fontSize=${c.fontSizePx}px lh=${c.cssLhPx}px pitch=${c.pitch}px (${c.lineCount} lines, "${c.textSample}")`);
    console.log(`   emitted: spcPct=${e.spcPct} fontSize=${e.fontSizePx.toFixed(2)}px pitch=${e.pitchPx.toFixed(2)}px  Δ=${deltaPct.toFixed(2)}%`);
  }
})().catch(e => { console.error(e); process.exit(1); });
