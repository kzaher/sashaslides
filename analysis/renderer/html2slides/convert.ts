#!/usr/bin/env npx tsx
/**
 * convert.ts — Convert HTML slides to .pptx via DOM extraction + pptxgenjs
 *
 * Pipeline per slide:
 *   1. Open HTML in Chrome at 1280×720
 *   2. Inject extract-dom.js → get flat element list
 *   3. Screenshot any <svg>/<canvas> regions as PNGs
 *   4. Map elements to pptxgenjs calls
 *   5. Generate .pptx
 *
 * Usage: npx tsx convert.ts <html-dir> <output.pptx> [--screenshot-originals]
 */

import CDP from "chrome-remote-interface";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";

const CDP_PORT = 9222;
const SLIDE_W_PX = 1280;
const SLIDE_H_PX = 720;
const SLIDE_W_IN = 13.333;
const SLIDE_H_IN = 7.5;
const PX2IN = SLIDE_W_IN / SLIDE_W_PX; // 0.01041...

import { transformSync } from "esbuild";
const EXTRACT_TS = readFileSync(join(dirname(new URL(import.meta.url).pathname), "extract-dom.ts"), "utf-8");
const EXTRACT_JS = transformSync(EXTRACT_TS, { loader: "ts", target: "es2020" }).code;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

interface Bounds { x: number; y: number; w: number; h: number; }
interface ExtractedElement {
  type: "text" | "rect" | "line" | "image" | "visual" | "table" | "list";
  bounds: Bounds;
  [key: string]: any;
}
interface Extraction {
  viewport: { w: number; h: number };
  elementCount: number;
  elements: ExtractedElement[];
}

function px(v: number): number { return Math.round(v * PX2IN * 1000) / 1000; }

async function extractFromHtml(htmlPath: string): Promise<{ extraction: Extraction; screenshotPath: string; visualPngs: Map<number, string> }> {
  const absPath = resolve(htmlPath);
  const tab = await (CDP as any).New({ port: CDP_PORT, url: `file://${absPath}` });
  await sleep(1200);

  const client = await CDP({ target: tab, port: CDP_PORT });
  const { Page, Runtime, Emulation } = client;
  await Page.enable();
  await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: SLIDE_W_PX, height: SLIDE_H_PX, deviceScaleFactor: 2, mobile: false });
  await sleep(800);

  // Wait for fonts
  await Runtime.evaluate({ expression: `document.fonts.ready.then(() => true)`, awaitPromise: true, returnByValue: true });
  await sleep(300);

  // Screenshot original
  const screenshot = await Page.captureScreenshot({ format: "png", captureBeyondViewport: false });
  const screenshotBuf = Buffer.from(screenshot.data, "base64");
  const screenshotPath = htmlPath.replace(".html", "_original.png");
  writeFileSync(screenshotPath, screenshotBuf);

  // Extract DOM
  const { result } = await Runtime.evaluate({ expression: EXTRACT_JS, returnByValue: true });
  const extraction: Extraction = JSON.parse(result.value);

  // Screenshot visual elements (svg/canvas)
  const visualPngs = new Map<number, string>();
  for (let i = 0; i < extraction.elements.length; i++) {
    const el = extraction.elements[i];
    if (el.type === "visual" && el.bounds.w > 5 && el.bounds.h > 5) {
      const clip = { x: el.bounds.x, y: el.bounds.y, width: el.bounds.w, height: el.bounds.h, scale: 2 };
      const ss = await Page.captureScreenshot({ format: "png", clip, captureBeyondViewport: true });
      const pngPath = htmlPath.replace(".html", `_visual_${i}.png`);
      writeFileSync(pngPath, Buffer.from(ss.data, "base64"));
      visualPngs.set(i, pngPath);
    }
  }

  await client.close();
  await (CDP as any).Close({ port: CDP_PORT, id: tab.id });

  return { extraction, screenshotPath, visualPngs };
}

async function buildPptx(slides: { extraction: Extraction; visualPngs: Map<number, string>; htmlFile: string }[]): Promise<any> {
  const pptxgenModule = await import("pptxgenjs");
  const PptxGenJS = (pptxgenModule as any).default || pptxgenModule;
  const pptx = new PptxGenJS();

  pptx.defineLayout({ name: "WIDE", width: SLIDE_W_IN, height: SLIDE_H_IN });
  pptx.layout = "WIDE";

  for (const { extraction, visualPngs } of slides) {
    const slide = pptx.addSlide();

    for (let i = 0; i < extraction.elements.length; i++) {
      const el = extraction.elements[i];
      const b = el.bounds;

      try {
        switch (el.type) {
          case "rect":
            if (b.w > SLIDE_W_PX * 0.95 && b.h > SLIDE_H_PX * 0.95) {
              // Full-slide background
              slide.background = { color: el.fill?.replace("#", "") || "FFFFFF" };
            } else {
              slide.addShape("rect", {
                x: px(b.x), y: px(b.y), w: px(b.w), h: px(b.h),
                fill: { color: el.fill?.replace("#", "") || "FFFFFF" },
                ...(el.borderWidth > 0 ? { line: { color: el.borderColor?.replace("#", "") || "000000", width: Math.max(0.5, el.borderWidth * 0.75) } } : {}),
                ...(el.borderRadius > 0 ? { rectRadius: el.borderRadius * PX2IN } : {}),
              });
            }
            break;

          case "line": {
            const isVertical = b.h > b.w * 2;
            if (isVertical) {
              slide.addShape("line", {
                x: px(b.x), y: px(b.y), w: 0, h: px(b.h),
                line: { color: el.color?.replace("#", "") || "000000", width: Math.max(0.5, b.w * 0.75) },
              });
            } else {
              slide.addShape("line", {
                x: px(b.x), y: px(b.y), w: px(b.w), h: 0,
                line: { color: el.color?.replace("#", "") || "000000", width: Math.max(0.5, b.h * 0.75) },
              });
            }
            break;
          }

          case "text": {
            const s = el.style || {};
            let textContent = el.text || "";
            if (s.textTransform === "uppercase") textContent = textContent.toUpperCase();
            const fontSize = Math.round((s.fontSize || 16) * 0.75); // px to pt
            const align = s.textAlign === "center" ? "center" : s.textAlign === "right" ? "right" : "left";
            const baseOpts: any = {
              fontFace: s.fontFamily || "Arial",
              color: s.color?.replace("#", "") || "333333",
              bold: s.fontWeight === "bold",
              italic: s.fontStyle === "italic",
              align,
            };
            if (s.textDecoration === "underline") baseOpts.underline = { style: "sng" };
            if (s.textDecoration === "line-through") baseOpts.strike = "sngStrike";
            const lhMultiple = s.lineHeight && s.fontSize ? Math.round((s.lineHeight / s.fontSize) * 100) / 100 : undefined;

            // Single-line detection: if height fits ~1 line, pad width 30% to prevent font-difference wrapping
            const lineH = s.lineHeight || (s.fontSize || 16) * 1.4;
            const isSingleLine = !textContent.includes("\n") && b.h <= lineH * 1.4;
            let bx = b.x, bw = b.w;
            if (isSingleLine) {
              const extra = b.w * 0.3;
              if (align === "center") {
                bx = Math.max(0, b.x - extra / 2);
                bw = Math.min(SLIDE_W_PX - bx, b.w + extra);
              } else if (align === "right") {
                bx = Math.max(0, b.x - extra);
                bw = Math.min(SLIDE_W_PX - bx, b.w + extra);
              } else {
                bw = Math.min(SLIDE_W_PX - b.x, b.w + extra);
              }
            }

            // Build text runs for pptxgenjs
            if (el.runs && el.runs.length > 0) {
              // Styled text runs (inline spans with different colors/bold/etc.)
              const textRuns: any[] = [];
              for (const run of el.runs) {
                let runText = run.text || "";
                if (s.textTransform === "uppercase") runText = runText.toUpperCase();
                const runStyle = run.style || {};
                const runOpts: any = {
                  ...baseOpts,
                  fontSize: runStyle.fontSize ? Math.round(runStyle.fontSize * 0.75) : fontSize,
                  color: (runStyle.color || s.color || "#333")?.replace("#", ""),
                  bold: runStyle.fontWeight === "bold" || (runStyle.fontWeight === undefined && s.fontWeight === "bold"),
                  italic: runStyle.fontStyle === "italic" || (runStyle.fontStyle === undefined && s.fontStyle === "italic"),
                  ...(lhMultiple ? { lineSpacingMultiple: lhMultiple } : {}),
                };
                if (runStyle.textDecoration === "underline") runOpts.underline = { style: "sng" };
                // Handle newlines within runs
                if (runText.includes("\n")) {
                  const parts = runText.split("\n");
                  parts.forEach((part: string, pi: number) => {
                    const opts = { ...runOpts };
                    if (pi > 0 || textRuns.length > 0 && runText.startsWith("\n")) opts.breakType = "break";
                    textRuns.push({ text: part, options: opts });
                  });
                } else {
                  textRuns.push({ text: runText, options: runOpts });
                }
              }
              slide.addText(textRuns, {
                x: px(bx), y: px(b.y), w: px(bw), h: px(b.h),
                valign: "top", wrap: true, shrinkText: true, margin: 0,
              });
            } else if (textContent.includes("\n")) {
              const lines = textContent.split("\n");
              const textRuns = lines.map((line: string) => ({
                text: line,
                options: { ...baseOpts, fontSize, breakType: "break" as const, ...(lhMultiple ? { lineSpacingMultiple: lhMultiple } : {}) },
              }));
              delete textRuns[0].options.breakType;
              slide.addText(textRuns, {
                x: px(bx), y: px(b.y), w: px(bw), h: px(b.h),
                valign: "top", wrap: true, shrinkText: true, margin: 0,
              });
            } else {
              slide.addText(textContent, {
                x: px(bx), y: px(b.y), w: px(bw), h: px(b.h),
                fontSize, ...baseOpts,
                valign: "top", wrap: true, shrinkText: true, margin: 0,
                ...(lhMultiple ? { lineSpacingMultiple: lhMultiple } : {}),
              });
            }
            break;
          }

          case "table": {
            const tableRows: any[][] = [];
            for (const row of el.rows || []) {
              const tableRow: any[] = [];
              for (const cell of row) {
                tableRow.push({
                  text: cell.text || "",
                  options: {
                    fontSize: Math.round((cell.style?.fontSize || 14) * 0.75),
                    fontFace: cell.style?.fontFamily || "Arial",
                    color: cell.style?.color?.replace("#", "") || "333333",
                    bold: cell.style?.fontWeight === "bold" || cell.isHeader,
                    fill: { color: cell.style?.bgColor?.replace("#", "") || (cell.isHeader ? "E8E8E8" : "FFFFFF") },
                    align: cell.style?.textAlign === "center" ? "center" : "left",
                    border: { type: "solid", color: el.borderColor?.replace("#", "") || "CCCCCC", pt: 0.5 },
                    colspan: cell.colspan > 1 ? cell.colspan : undefined,
                    rowspan: cell.rowspan > 1 ? cell.rowspan : undefined,
                    margin: [2, 4, 2, 4],
                  },
                });
              }
              tableRows.push(tableRow);
            }
            if (tableRows.length > 0) {
              slide.addTable(tableRows, {
                x: px(b.x), y: px(b.y), w: px(b.w),
                fontSize: 10,
                border: { type: "solid", color: el.borderColor?.replace("#", "") || "CCCCCC", pt: 0.5 },
              });
            }
            break;
          }

          case "list": {
            const items = el.items || [];
            const columnCount = el.columnCount || 1;

            if (columnCount > 1 && items.length > 1) {
              // Multi-column list: split items into columns and render as separate text boxes
              const perCol = Math.ceil(items.length / columnCount);
              const colWidth = b.w / columnCount;
              for (let col = 0; col < columnCount; col++) {
                const colItems = items.slice(col * perCol, (col + 1) * perCol);
                const colText: any[] = [];
                for (const item of colItems) {
                  const spPts = item.spacingAfter ? Math.round(item.spacingAfter * 0.75) : 0;
                  const lhMultiple = item.lineHeight && item.fontSize ? Math.round((item.lineHeight / item.fontSize) * 100) / 100 : undefined;
                  colText.push({
                    text: item.text,
                    options: {
                      fontSize: Math.round((item.fontSize || 16) * 0.75),
                      fontFace: item.fontFamily || "Arial",
                      color: item.color?.replace("#", "") || "333333",
                      bold: item.fontWeight === "bold",
                      bullet: el.listStyleType === "none" ? false : (el.ordered ? { type: "number" } : true),
                      indentLevel: item.level,
                      paraSpaceAfter: spPts,
                      ...(lhMultiple ? { lineSpacingMultiple: lhMultiple } : {}),
                    },
                  });
                }
                if (colText.length > 0) {
                  slide.addText(colText, {
                    x: px(b.x + col * colWidth), y: px(b.y), w: px(colWidth), h: px(b.h),
                    valign: "top", margin: 0,
                  });
                }
              }
            } else {
              // Single-column list
              const listText: any[] = [];
              for (const item of items) {
                const spPts = item.spacingAfter ? Math.round(item.spacingAfter * 0.75) : 0;
                const lhMultiple = item.lineHeight && item.fontSize ? Math.round((item.lineHeight / item.fontSize) * 100) / 100 : undefined;
                listText.push({
                  text: item.text,
                  options: {
                    fontSize: Math.round((item.fontSize || 16) * 0.75),
                    fontFace: item.fontFamily || "Arial",
                    color: item.color?.replace("#", "") || "333333",
                    bold: item.fontWeight === "bold",
                    bullet: el.listStyleType === "none" ? false : (el.ordered ? { type: "number", indent: item.level * 18 } : { indent: item.level * 18 }),
                    indentLevel: item.level,
                    paraSpaceAfter: spPts,
                    ...(lhMultiple ? { lineSpacingMultiple: lhMultiple } : {}),
                  },
                });
              }
              if (listText.length > 0) {
                slide.addText(listText, {
                  x: px(b.x), y: px(b.y), w: px(b.w), h: px(b.h),
                  valign: "top", margin: 0,
                });
              }
            }
            break;
          }

          case "image":
            // Skip external images (can't embed URLs in pptx reliably)
            // If it's a data: URL or local file, try to embed
            if (el.src?.startsWith("data:")) {
              try {
                slide.addImage({ data: el.src, x: px(b.x), y: px(b.y), w: px(b.w), h: px(b.h) });
              } catch {}
            }
            break;

          case "visual": {
            const pngPath = visualPngs.get(i);
            if (pngPath && existsSync(pngPath)) {
              const imgData = readFileSync(pngPath).toString("base64");
              slide.addImage({
                data: `image/png;base64,${imgData}`,
                x: px(b.x), y: px(b.y), w: px(b.w), h: px(b.h),
              });
            }
            break;
          }
        }
      } catch (err: any) {
        // Skip elements that fail — don't crash the whole slide
      }
    }
  }

  return pptx;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: npx tsx convert.ts <html-dir-or-file> <output.pptx> [--screenshot-originals]");
    process.exit(1);
  }

  const input = args[0];
  const outputPptx = args[1];
  const screenshotOriginals = args.includes("--screenshot-originals");

  // Collect HTML files
  let htmlFiles: string[] = [];
  if (input.endsWith(".html")) {
    htmlFiles = [resolve(input)];
  } else {
    htmlFiles = readdirSync(input)
      .filter(f => f.startsWith("slide_") && f.endsWith(".html"))
      .sort()
      .map(f => resolve(join(input, f)));
  }

  if (htmlFiles.length === 0) {
    console.error("No slide_*.html files found");
    process.exit(1);
  }

  console.log(`Converting ${htmlFiles.length} HTML slides → ${outputPptx}`);

  const slides: { extraction: Extraction; visualPngs: Map<number, string>; htmlFile: string }[] = [];

  for (let i = 0; i < htmlFiles.length; i++) {
    const f = htmlFiles[i];
    console.log(`  [${i + 1}/${htmlFiles.length}] Extracting ${f.split("/").pop()}...`);
    const { extraction, screenshotPath, visualPngs } = await extractFromHtml(f);
    console.log(`    ${extraction.elementCount} elements`);
    slides.push({ extraction, visualPngs, htmlFile: f });
  }

  console.log(`\nBuilding .pptx...`);
  mkdirSync(dirname(resolve(outputPptx)), { recursive: true });
  const pptx = await buildPptx(slides);
  await pptx.writeFile({ fileName: resolve(outputPptx) });
  console.log(`  → ${outputPptx}`);

  // Write extraction data for debugging — embed visual PNGs as base64
  const extractionData = slides.map((s, i) => {
    const elements = s.extraction.elements.map((el: any, idx: number) => {
      if (el.type === "visual") {
        const pngPath = s.visualPngs.get(idx);
        if (pngPath && existsSync(pngPath)) {
          return { ...el, pngData: readFileSync(pngPath).toString("base64") };
        }
      }
      return el;
    });
    return {
      slide: i + 1,
      file: s.htmlFile.split("/").pop(),
      elementCount: s.extraction.elementCount,
      elements,
    };
  });
  writeFileSync(outputPptx.replace(".pptx", "_extractions.json"), JSON.stringify(extractionData, null, 2));

  console.log(`Done.`);
}

main().catch(err => { console.error(err); process.exit(1); });
