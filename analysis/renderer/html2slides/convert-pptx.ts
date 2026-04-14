#!/usr/bin/env npx tsx
/**
 * convert-pptx.ts — Convert HTML slides to .pptx, then upload to Google Slides
 *
 * Pipeline:
 *   1. Extract DOM from HTML files (reuses extract-dom.ts + Chrome CDP)
 *   2. Build .pptx with pptxgenjs (exact corner radii, native text, shapes)
 *   3. Upload .pptx to Google Drive as Google Slides presentation
 *
 * Advantages over Slides API approach:
 *   - pptxgenjs rectRadius gives exact corner radii (OOXML adj attribute)
 *   - Native text is editable in Slides after import
 *   - Single file upload instead of hundreds of API calls
 *
 * Usage: npx tsx convert-pptx.ts <html-dir> [--title "Presentation Name"] [--out /tmp/output.pptx]
 */

import CDP from "chrome-remote-interface";
import { google } from "googleapis";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { Readable } from "stream";
import { createRequire } from "module";
const require = createRequire("/workspaces/sashaslides/package.json");

const CDP_PORT = 9222;
const SLIDE_W_PX = 1280;
const SLIDE_H_PX = 720;

// pptxgenjs slide dimensions in inches (widescreen 16:9)
const SLIDE_W_IN = 10;
const SLIDE_H_IN = 5.625;
const PX2IN = SLIDE_W_IN / SLIDE_W_PX; // 0.0078125

// Font scale: CSS px to PowerPoint pt
// At 96dpi CSS, 1px = 0.75pt. But our slide is 10" for 1280px, so effective:
const PX2PT = SLIDE_W_IN / SLIDE_W_PX * 72; // 10/1280*72 = 0.5625

// Compile extract-dom.ts → JS at startup
import { transformSync } from "esbuild";
const EXTRACT_TS = readFileSync(join(dirname(new URL(import.meta.url).pathname), "extract-dom.ts"), "utf-8");
const EXTRACT_JS = transformSync(EXTRACT_TS, { loader: "ts", target: "es2020" }).code;

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function px2in(px: number): number { return px * PX2IN; }

function hexToRgb(hex: string): string {
  // pptxgenjs wants hex without # prefix
  return hex.replace("#", "").toUpperCase();
}

// Map web fonts to their closest Google Slides equivalents
const FONT_MAP: Record<string, string> = {
  "Helvetica Neue": "Arial",
  "Helvetica": "Arial",
  "-apple-system": "Roboto",
  "BlinkMacSystemFont": "Roboto",
  "Segoe UI": "Roboto",
  "system-ui": "Roboto",
  "monospace": "Courier New",
};
function mapFont(font: string): string { return FONT_MAP[font] || font; }

// --- Types ---
interface Bounds { x: number; y: number; w: number; h: number; }
interface ExtractedElement { type: string; bounds: Bounds; [key: string]: any; }
interface Extraction { viewport: { w: number; h: number }; elementCount: number; elements: ExtractedElement[]; }

// --- Auth ---
function getAuth() {
  const creds = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/google_oauth.json", "utf-8")).installed;
  const tokens = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/tokens.json", "utf-8"));
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost:8080");
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", (newTokens: any) => {
    const merged = { ...tokens, ...newTokens };
    writeFileSync("/workspaces/sashaslides/.auth/tokens.json", JSON.stringify(merged, null, 2));
  });
  return oauth2;
}

// --- DOM Extraction ---
async function extractFromHtml(htmlPath: string): Promise<{ extraction: Extraction; visualPngs: Map<number, Buffer> }> {
  const absPath = resolve(htmlPath);
  const tab = await (CDP as any).New({ port: CDP_PORT, url: `file://${absPath}` });
  await sleep(1200);

  const client = await CDP({ target: tab, port: CDP_PORT });
  const { Page, Runtime, Emulation } = client;
  await Page.enable();
  await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: SLIDE_W_PX, height: SLIDE_H_PX, deviceScaleFactor: 2, mobile: false });
  await sleep(800);
  await Runtime.evaluate({ expression: `document.fonts.ready.then(() => true)`, awaitPromise: true, returnByValue: true });
  await sleep(300);

  const { result } = await Runtime.evaluate({ expression: EXTRACT_JS, returnByValue: true });
  const extraction: Extraction = JSON.parse(result.value);

  // Screenshot visual elements (svg/canvas/images)
  const visualPngs = new Map<number, Buffer>();
  for (let i = 0; i < extraction.elements.length; i++) {
    const el = extraction.elements[i];
    if ((el.type === "visual" || el.type === "image") && el.bounds.w > 5 && el.bounds.h > 5) {
      const clip = { x: el.bounds.x, y: el.bounds.y, width: el.bounds.w, height: el.bounds.h, scale: 2 };
      const ss = await Page.captureScreenshot({ format: "png", clip, captureBeyondViewport: true });
      visualPngs.set(i, Buffer.from(ss.data, "base64"));
    }
  }

  await client.close();
  await (CDP as any).Close({ port: CDP_PORT, id: tab.id });
  return { extraction, visualPngs };
}

// --- Build pptx ---
function buildPptx(
  slides: { extraction: Extraction; visualPngs: Map<number, Buffer> }[],
  title: string,
): any {
  // ESM/CJS interop for pptxgenjs
  const pptxgenModule = require("pptxgenjs");
  const PptxGenJS = (pptxgenModule as any).default || pptxgenModule;
  const pres = new PptxGenJS();
  pres.title = title;
  pres.layout = "LAYOUT_WIDE"; // 13.333" x 7.5" — wait, we want 10" x 5.625"

  // Actually define custom layout matching our slide dimensions
  pres.defineLayout({ name: "CUSTOM", width: SLIDE_W_IN, height: SLIDE_H_IN });
  pres.layout = "CUSTOM";

  for (let si = 0; si < slides.length; si++) {
    const { extraction, visualPngs } = slides[si];
    const slide = pres.addSlide();

    for (let ei = 0; ei < extraction.elements.length; ei++) {
      const el = extraction.elements[ei];
      if (el.type === "_skip") continue;
      const b = el.bounds;

      switch (el.type) {
        case "rect": {
          // Full-slide background
          if (b.w > SLIDE_W_PX * 0.9 && b.h > SLIDE_H_PX * 0.9) {
            if (el.fill) {
              slide.background = { fill: hexToRgb(el.fill) };
            }
            break;
          }

          // Determine shape type
          const cr = el.cornerRadii || { tl: el.borderRadius || 0, tr: el.borderRadius || 0, br: el.borderRadius || 0, bl: el.borderRadius || 0 };
          const minDim = Math.min(b.w, b.h);
          const isCircle = cr.tl >= minDim * 0.4 && cr.tr >= minDim * 0.4 && cr.br >= minDim * 0.4 && cr.bl >= minDim * 0.4
            && Math.abs(b.w - b.h) < b.w * 0.3;
          const anyRounded = cr.tl > 2 || cr.tr > 2 || cr.br > 2 || cr.bl > 2;

          const shapeName = isCircle ? "ellipse" : anyRounded ? "roundRect" : "rect";

          // Scan for text to merge into this shape
          let mergedTextEl: any = null;
          for (let ti = ei + 1; ti < extraction.elements.length; ti++) {
            const next = extraction.elements[ti];
            if (next.type !== "text" || !next.bounds) continue;
            const nb = next.bounds;
            const sameBounds = Math.abs(nb.x - b.x) < 5 && Math.abs(nb.y - b.y) < 5 &&
                               Math.abs(nb.w - b.w) < 5 && Math.abs(nb.h - b.h) < 5;
            const tcx = nb.x + nb.w / 2, tcy = nb.y + nb.h / 2;
            const insideBounds = tcx >= b.x && tcx <= b.x + b.w && tcy >= b.y && tcy <= b.y + b.h;
            if (sameBounds || (insideBounds && (isCircle || b.w < 300))) {
              mergedTextEl = next;
              extraction.elements[ti] = { type: "_skip", bounds: nb };
              break;
            }
          }

          // Non-uniform border shapes (placed BEFORE content shape)
          const bs = el.borderSides;
          const uniform = el.borderUniform;
          const hasNonUniformBorder = bs && !uniform &&
            ((bs.top?.width > 0 && bs.top?.color) || (bs.right?.width > 0 && bs.right?.color) ||
             (bs.bottom?.width > 0 && bs.bottom?.color) || (bs.left?.width > 0 && bs.left?.color));

          if (hasNonUniformBorder) {
            const sides = [
              bs.top?.width > 0 && bs.top?.color ? { x: b.x, y: b.y - bs.top.width, w: b.w, h: b.h + bs.top.width, color: bs.top.color } : null,
              bs.bottom?.width > 0 && bs.bottom?.color ? { x: b.x, y: b.y, w: b.w, h: b.h + bs.bottom.width, color: bs.bottom.color } : null,
              bs.left?.width > 0 && bs.left?.color ? { x: b.x - bs.left.width, y: b.y, w: b.w + bs.left.width, h: b.h, color: bs.left.color } : null,
              bs.right?.width > 0 && bs.right?.color ? { x: b.x, y: b.y, w: b.w + bs.right.width, h: b.h, color: bs.right.color } : null,
            ].filter(Boolean) as { x: number; y: number; w: number; h: number; color: string }[];

            for (const side of sides) {
              const opts: any = {
                x: px2in(side.x), y: px2in(side.y), w: px2in(side.w), h: px2in(side.h),
                fill: { color: hexToRgb(side.color) },
                line: { type: "none" },
              };
              if (anyRounded) opts.rectRadius = px2in(el.borderRadius);
              slide.addShape(anyRounded ? "roundRect" : "rect", opts);
            }
          }

          // Content shape
          const opts: any = {
            x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
            line: { type: "none" },
          };

          // Fill
          if (el.fill) {
            opts.fill = { color: hexToRgb(el.fill) };
          }

          // Corner radius (pptxgenjs rectRadius is in inches)
          if (anyRounded && !isCircle) {
            opts.rectRadius = px2in(el.borderRadius);
          }

          // Border outline (uniform)
          if (!hasNonUniformBorder && uniform && el.borderWidth > 0 && el.borderColor) {
            opts.line = {
              color: hexToRgb(el.borderColor),
              width: Math.min(el.borderWidth * PX2PT, 6),
              dashType: el.borderStyle === "dashed" ? "dash" : el.borderStyle === "dotted" ? "dot" : "solid",
            };
          }

          // Box shadow
          if (el.boxShadow && (el.boxShadow.blur > 0 || el.boxShadow.offsetX !== 0 || el.boxShadow.offsetY !== 0)) {
            const dx = el.boxShadow.offsetX || 0;
            const dy = el.boxShadow.offsetY || 0;
            // OOXML shadow dir: 0°=east, 90°=south — matches CSS offsetY>0=down
            let angle = Math.atan2(dy, dx) * 180 / Math.PI;
            if (dx === 0 && dy === 0) angle = 90;
            if (angle < 0) angle += 360;
            opts.shadow = {
              type: "outer",
              blur: Math.min(el.boxShadow.blur * PX2PT, 30),
              offset: Math.sqrt(dx * dx + dy * dy) * PX2PT,
              color: hexToRgb(el.boxShadow.color || "#000000"),
              opacity: el.boxShadow.alpha ?? 0.25,
              angle: Math.round(angle),
            };
          }

          slide.addShape(shapeName, opts);

          // Overlay native editable text on merged text elements
          if (mergedTextEl) {
            const ms = mergedTextEl.style || {};
            let text = mergedTextEl.text || "";
            if (ms.textTransform === "uppercase") text = text.toUpperCase();
            slide.addText(text, {
              x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
              align: "center",
              valign: "middle",
              fontSize: (ms.fontSize || 14) * PX2PT,
              fontFace: mapFont(ms.fontFamily || "Arial"),
              color: hexToRgb(ms.color || "#333333"),
              bold: ms.fontWeight === "bold",
              italic: ms.fontStyle === "italic",
              fill: { type: "none" },
              line: { type: "none" },
              margin: 0,
            });
          }

          break;
        }

        case "line": {
          const isVertical = b.h > b.w * 2;
          slide.addShape("line", {
            x: px2in(b.x), y: px2in(b.y),
            w: isVertical ? 0 : px2in(b.w),
            h: isVertical ? px2in(b.h) : 0,
            line: {
              color: hexToRgb(el.color || "#000000"),
              width: Math.max(0.5, isVertical ? b.w * PX2PT : b.h * PX2PT),
            },
          });
          break;
        }

        case "text": {
          const s = el.style || {};
          let fullText = el.text || "";
          if (s.textTransform === "uppercase") fullText = fullText.toUpperCase();

          const align = s.textAlign === "center" ? "center" : s.textAlign === "right" ? "right" : "left";

          // Build text runs if available
          if (el.runs && el.runs.length > 0) {
            const textRuns = el.runs.filter((r: any) => r.text.length > 0).map((run: any) => {
              const rs = run.style || {};
              let runText = run.text;
              if (s.textTransform === "uppercase") runText = runText.toUpperCase();
              return {
                text: runText,
                options: {
                  fontFace: mapFont(rs.fontFamily || s.fontFamily || "Arial"),
                  fontSize: (rs.fontSize || s.fontSize || 16) * PX2PT,
                  color: hexToRgb(rs.color || s.color || "#333333"),
                  bold: rs.fontWeight === "bold" || (!rs.fontWeight && s.fontWeight === "bold"),
                  italic: rs.fontStyle === "italic" || (!rs.fontStyle && s.fontStyle === "italic"),
                  underline: { style: (rs.textDecoration === "underline" || (!rs.textDecoration && s.textDecoration === "underline")) ? "sng" : "none" },
                  strike: (rs.textDecoration === "line-through" || (!rs.textDecoration && s.textDecoration === "line-through")) ? "sngStrike" : undefined,
                },
              };
            });

            slide.addText(textRuns, {
              x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
              valign: "top",
              align,
              lineSpacingMultiple: s.lineHeight && s.fontSize ? s.lineHeight / s.fontSize : undefined,
              fill: { type: "none" },
              line: { type: "none" },
              margin: 0,
            });
          } else {
            const textOpts: any = {
              x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
              valign: "top",
              align,
              fontSize: (s.fontSize || 16) * PX2PT,
              fontFace: mapFont(s.fontFamily || "Arial"),
              color: hexToRgb(s.color || "#333333"),
              bold: s.fontWeight === "bold",
              italic: s.fontStyle === "italic",
              fill: { type: "none" },
              line: { type: "none" },
              margin: 0,
            };
            if (s.lineHeight && s.fontSize) {
              textOpts.lineSpacingMultiple = s.lineHeight / s.fontSize;
            }
            if (s.textDecoration === "underline") textOpts.underline = { style: "sng" };
            if (s.textDecoration === "line-through") textOpts.strike = "sngStrike";

            slide.addText(fullText, textOpts);
          }
          break;
        }

        case "visual":
        case "image": {
          const buf = visualPngs.get(ei);
          if (buf) {
            slide.addImage({
              data: `image/png;base64,${buf.toString("base64")}`,
              x: px2in(b.x), y: px2in(b.y), w: px2in(b.w), h: px2in(b.h),
            });
          }
          break;
        }
      }
    }
  }

  return pres;
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  const htmlDir = resolve(args[0] || ".");
  let title = "Presentation";
  let outPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--title") title = args[++i];
    if (args[i] === "--out") outPath = args[++i];
  }

  const htmlFiles = readdirSync(htmlDir)
    .filter(f => f.endsWith(".html"))
    .sort()
    .map(f => join(htmlDir, f));

  if (htmlFiles.length === 0) { console.error("No HTML files found in", htmlDir); process.exit(1); }
  console.log(`Converting ${htmlFiles.length} HTML slides → pptx "${title}"`);

  // Step 1: Extract DOM from all slides (parallel batches)
  const EXTRACT_BATCH = 4;
  const slideData: { extraction: Extraction; visualPngs: Map<number, Buffer> }[] = new Array(htmlFiles.length);
  const t0 = Date.now();
  for (let i = 0; i < htmlFiles.length; i += EXTRACT_BATCH) {
    const batch = htmlFiles.slice(i, i + EXTRACT_BATCH);
    const results = await Promise.all(batch.map(async (f, bi) => {
      const idx = i + bi;
      console.log(`  [${idx + 1}/${htmlFiles.length}] Extracting ${f.split("/").pop()}...`);
      const data = await extractFromHtml(f);
      console.log(`    [${idx + 1}] ${data.extraction.elementCount} elements, ${data.visualPngs.size} visuals`);
      return { idx, data };
    }));
    for (const { idx, data } of results) slideData[idx] = data;
  }
  console.log(`  Extraction: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // Step 2: Build pptx
  console.log("\nBuilding .pptx...");
  const pres = buildPptx(slideData, title);

  const pptxPath = outPath || `/tmp/${title.replace(/[^a-zA-Z0-9]/g, "_")}.pptx`;
  await pres.writeFile({ fileName: pptxPath });
  console.log(`  Saved: ${pptxPath}`);

  // Step 3: Upload to Google Drive as Google Slides
  console.log("\nUploading to Google Slides...");
  const auth = getAuth();
  const driveApi = google.drive({ version: "v3", auth });

  const buf = readFileSync(pptxPath);
  const res = await driveApi.files.create({
    requestBody: { name: title, mimeType: "application/vnd.google-apps.presentation" },
    media: { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", body: Readable.from(buf) },
    fields: "id",
  });
  const presId = res.data.id;
  console.log(`  → https://docs.google.com/presentation/d/${presId}/edit`);
  console.log("Done.");
}

main().catch(err => { console.error(err); process.exit(1); });
