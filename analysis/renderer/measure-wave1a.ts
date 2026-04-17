/**
 * Measurement script for slide_01 (complex) vertical-align bug.
 *
 * Targets: the two outlined CTA buttons — "Get Started" (Starter card) and
 * "Contact Sales" (Enterprise card). Both have `padding: 12px 0` + a
 * 2px border. The user annotation marks their text as misaligned.
 *
 * TARGET (Chrome):   for each <button class="cta"> element, capture the
 *                    border-box rect and the text Range rect; compute text
 *                    center-Y relative to the button box.
 * EMITTED (PPTX):    parse /tmp/sxs-wave1a.pptx, read slide1.xml, locate the
 *                    text shape whose run matches "Get Started" / "Contact Sales"
 *                    (picking the outlined cards, not the filled middle card
 *                    — which we distinguish by x position). Report <a:off>,
 *                    <a:ext>, <a:bodyPr anchor="...">, and the implied
 *                    text-center-Y.
 */
import CDP from "chrome-remote-interface";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const JSZip = require("jszip");

const HTML = resolve("/workspaces/sashaslides/analysis/renderer/html2slides/e2e/fixtures/slide_01.html");
const PPTX = "/tmp/sxs-wave1a.pptx";
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
      for (const btn of document.querySelectorAll('button.cta')) {
        const r = btn.getBoundingClientRect();
        const textNode = [...btn.childNodes].find(n => n.nodeType === 3);
        const range = document.createRange();
        range.selectNodeContents(textNode);
        const tr = range.getBoundingClientRect();
        const cs = getComputedStyle(btn);
        out.push({
          text: textNode.textContent.trim(),
          className: btn.className,
          box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cy: Math.round(r.y + r.height/2) },
          textRect: { x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height), cy: Math.round(tr.y + tr.height/2) },
          padTop: cs.paddingTop,
          padBot: cs.paddingBottom,
          borderT: cs.borderTopWidth,
          borderB: cs.borderBottomWidth,
          bg: cs.backgroundColor,
          font: cs.fontSize + " / " + cs.lineHeight,
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
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  const spBlocks = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
  const out: any[] = [];
  for (const sp of spBlocks) {
    const off = sp.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/);
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

function reportRow(label: string, textCy: number, boxCy: number) {
  const off = textCy - boxCy;
  console.log(`  ${label.padEnd(30)} box.cy=${String(boxCy).padStart(4)}  text.cy=${String(textCy).padStart(4)}  offset=${off >= 0 ? '+' : ''}${off}`);
}

(async () => {
  console.log("=== 1. TARGET — Chrome live render (slide space 1280x720) ===");
  const chrome = await measureChrome();
  for (const c of chrome) {
    reportRow(`"${c.text}" (${c.className})`, c.textRect.cy, c.box.cy);
    console.log(`    box=${JSON.stringify(c.box)} textRect=${JSON.stringify(c.textRect)}`);
    console.log(`    padT=${c.padTop} padB=${c.padBot} borderT=${c.borderT} borderB=${c.borderB} bg=${c.bg} font=${c.font}`);
  }

  console.log("\n=== 2. EMITTED — parsed /tmp/sxs-wave1a.pptx slide1.xml ===");
  const pptx = await measurePptx();
  // CTA texts in the pptx
  for (const s of pptx) {
    if (s.text === "Get Started" || s.text === "Contact Sales") {
      const textCy = s.anchor === "ctr" ? s.cy : s.y + /* approx font baseline */ 14; // only meaningful when anchored
      console.log(`  TEXT "${s.text}": y=${s.y} h=${s.h} cy=${s.cy} anchor=${s.anchor}  x=${s.x} w=${s.w}`);
    }
  }
  // Also: matching outline-button rect shapes. Filter by similar geometry.
  // Print rect-looking shapes near the button text for sanity.
  console.log("\n  (all sp blocks with no text — likely rects/borders):");
  for (const s of pptx) {
    if (!s.text && s.h > 20 && s.h < 80 && s.w > 100 && s.w < 400) {
      console.log(`    RECT: y=${s.y} h=${s.h} cy=${s.cy} x=${s.x} w=${s.w}`);
    }
  }

  console.log("\n=== 3. DELTA ===");
  const tolerance = 2;
  for (const c of chrome) {
    if (!c.className.includes("cta-outline")) continue;
    const match = pptx.find(s => s.text === c.text && Math.abs(s.x - c.box.x) < 20);
    if (!match) { console.log(`  ${c.text}: NO MATCHING PPTX SHAPE`); continue; }
    // Ground truth: Chrome text center-Y relative to button box.
    const chromeOffset = c.textRect.cy - c.box.cy;
    // Emitted: if anchor=ctr then emitted text center ≈ box cy of the TEXT shape.
    // But the text shape bounds may differ from the button rect bounds — report both.
    const emittedTextCy = match.cy;  // center of the text shape
    const emittedRectCy = c.box.cy;  // approx — what we want target to be near
    const emittedOffset = emittedTextCy - emittedRectCy;
    const delta = emittedOffset - chromeOffset;
    console.log(`  ${c.text}:`);
    console.log(`    Chrome: text.cy(${c.textRect.cy}) - box.cy(${c.box.cy}) = ${chromeOffset}  (truth)`);
    console.log(`    PPTX  : textShape.cy(${emittedTextCy}) anchor=${match.anchor} — text should render at ≈ ${match.anchor === "ctr" ? emittedTextCy : "top of box + baseline"}`);
    console.log(`    Delta vs Chrome: ${delta}px  ${Math.abs(delta) <= tolerance ? "OK" : "BUG"}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
