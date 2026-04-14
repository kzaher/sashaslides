#!/usr/bin/env npx tsx
/**
 * convert-slides-api.ts — Convert HTML slides to Google Slides via the API
 *
 * Pipeline:
 *   1. Extract DOM from HTML files (reuses extract-dom.js + Chrome CDP)
 *   2. Upload visual PNGs to Google Drive (API needs URLs, not base64)
 *   3. Build a single batchUpdate with all slides + elements
 *   4. Execute in one API call
 *
 * Usage: npx tsx convert-slides-api.ts <html-dir> [--title "Presentation Name"]
 */

import CDP from "chrome-remote-interface";
import { google } from "googleapis";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { Readable } from "stream";

const CDP_PORT = 9222;
const SLIDE_W_PX = 1280;
const SLIDE_H_PX = 720;

// EMU constants: 1 inch = 914400 EMU
// Default Google Slides widescreen is 10" x 5.625" (16:9)
const SLIDE_W_EMU = 9144000;  // 10 * 914400
const SLIDE_H_EMU = 5143500;  // 5.625 * 914400
const PX2EMU = SLIDE_W_EMU / SLIDE_W_PX; // 7143.75 — maps 1280px to 10"
// Font scale: px to pt accounting for slide size (px * 0.75 for 13.333" → px * 0.5625 for 10")
const PX2PT = 0.5625;
// Default text box insets: 0.1" left + 0.1" right = 25.6px (182880 EMU), 0.05" top + 0.05" bottom = 12.8px
const TEXT_INSET_PX = 182880 / PX2EMU; // ~25.6px horizontal inset to compensate
const TEXT_INSET_TOP_PX = 45720 / PX2EMU; // ~6.4px vertical top inset to compensate

// Compile extract-dom.ts → JS at startup (stripped of types, ready for Chrome injection)
import { transformSync } from "esbuild";
const EXTRACT_TS = readFileSync(join(dirname(new URL(import.meta.url).pathname), "extract-dom.ts"), "utf-8");
const EXTRACT_JS = transformSync(EXTRACT_TS, { loader: "ts", target: "es2020" }).code;

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function emu(px: number): number { return Math.round(px * PX2EMU); }

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
  const h = hex.replace("#", "");
  return {
    red: parseInt(h.substring(0, 2), 16) / 255,
    green: parseInt(h.substring(2, 4), 16) / 255,
    blue: parseInt(h.substring(4, 6), 16) / 255,
  };
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

// For solidFill.color (shapes, backgrounds, lines): direct rgbColor
function solidColor(hex: string) {
  return { rgbColor: hexToRgb(hex) };
}

// For text foregroundColor: wrapped in opaqueColor
function textColor(hex: string) {
  return { opaqueColor: { rgbColor: hexToRgb(hex) } };
}

// --- Auth ---
function getAuth() {
  const creds = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/google_oauth.json", "utf-8")).installed;
  const tokens = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/tokens.json", "utf-8"));
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost");
  oauth2.setCredentials(tokens);
  // Auto-save refreshed tokens
  oauth2.on("tokens", (newTokens: any) => {
    const merged = { ...tokens, ...newTokens };
    writeFileSync("/workspaces/sashaslides/.auth/tokens.json", JSON.stringify(merged, null, 2));
  });
  return oauth2;
}

// --- DOM Extraction (reused from convert.ts) ---
interface Bounds { x: number; y: number; w: number; h: number; }
interface ExtractedElement { type: string; bounds: Bounds; [key: string]: any; }
interface Extraction { viewport: { w: number; h: number }; elementCount: number; elements: ExtractedElement[]; }

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

  // Screenshot visual elements (svg/canvas) and images
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

// --- Upload visual PNGs to Drive (Slides API needs URLs) ---
async function uploadVisualsToDrive(
  drive: any,
  slides: { visualPngs: Map<number, Buffer> }[],
): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>(); // "slideIdx-elemIdx" -> webContentLink
  const uploads: Promise<void>[] = [];

  for (let si = 0; si < slides.length; si++) {
    for (const [ei, buf] of slides[si].visualPngs) {
      const key = `${si}-${ei}`;
      uploads.push(
        drive.files.create({
          requestBody: { name: `visual_${key}.png`, mimeType: "image/png" },
          media: { mimeType: "image/png", body: Readable.from(buf) },
          fields: "id,webContentLink",
        }).then(async (res: any) => {
          // Make file publicly readable so Slides API can access it
          await drive.permissions.create({
            fileId: res.data.id,
            requestBody: { role: "reader", type: "anyone" },
          });
          const link = `https://drive.google.com/uc?id=${res.data.id}&export=download`;
          urlMap.set(key, link);
        })
      );
    }
  }

  if (uploads.length > 0) {
    console.log(`  Uploading ${uploads.length} visual PNGs to Drive...`);
    await Promise.all(uploads);
  }
  return urlMap;
}

// --- Build batchUpdate requests ---
function buildRequests(
  slides: { extraction: Extraction; visualPngs: Map<number, Buffer> }[],
  visualUrls: Map<string, string>,
): any[] {
  const requests: any[] = [];
  let idCounter = 0;
  const newId = () => `elem_${idCounter++}`;

  for (let si = 0; si < slides.length; si++) {
    const slideId = `slide_${si}`;
    const { extraction } = slides[si];

    // Create slide
    requests.push({ createSlide: { objectId: slideId, insertionIndex: si } });

    // Collect LARGE visual element bounds — used to skip text inside charts/images
    // Only visuals > 100px in both dimensions (not small icons/dots)
    const visualBounds: Bounds[] = [];
    for (const el of extraction.elements) {
      if ((el.type === "visual" || el.type === "image") && el.bounds.w > 100 && el.bounds.h > 100) {
        visualBounds.push(el.bounds);
      }
    }

    for (let ei = 0; ei < extraction.elements.length; ei++) {
      const el = extraction.elements[ei];
      const b = el.bounds;

      // Skip text elements that are mostly inside a LARGE visual (chart labels baked into screenshot)
      if (el.type === "text") {
        const textCx = b.x + b.w / 2;
        const textCy = b.y + b.h / 2;
        const overlapsVisual = visualBounds.some(vb =>
          textCx >= vb.x && textCx <= vb.x + vb.w &&
          textCy >= vb.y && textCy <= vb.y + vb.h
        );
        if (overlapsVisual) continue;
      }

      if (el.type === "_skip") continue; // merged into previous shape

      switch (el.type) {
        case "rect": {
          // Full-slide background
          if (b.w > SLIDE_W_PX * 0.9 && b.h > SLIDE_H_PX * 0.9) {
            requests.push({
              updatePageProperties: {
                objectId: slideId,
                pageProperties: {
                  pageBackgroundFill: {
                    solidFill: { color: solidColor(el.fill || "#ffffff") },
                  },
                },
                fields: "pageBackgroundFill.solidFill.color",
              },
            });
          } else {
            // --- Determine shape type from corner radii ---
            // See extract-dom.ts "Border & Corner Radius Rendering Rules" for full spec
            const cr = el.cornerRadii || { tl: el.borderRadius || 0, tr: el.borderRadius || 0, br: el.borderRadius || 0, bl: el.borderRadius || 0 };
            const minDim = Math.min(b.w, b.h);
            const isCircle = cr.tl >= minDim * 0.4 && cr.tr >= minDim * 0.4 && cr.br >= minDim * 0.4 && cr.bl >= minDim * 0.4
              && Math.abs(b.w - b.h) < b.w * 0.3;
            const allSame = cr.tl === cr.tr && cr.tr === cr.br && cr.br === cr.bl;
            const anyRounded = cr.tl > 2 || cr.tr > 2 || cr.br > 2 || cr.bl > 2;

            let shapeType: string;
            let rotation = 0; // degrees for ROUND_2_SAME_RECTANGLE orientation
            if (isCircle) {
              shapeType = "ELLIPSE";
            } else if (allSame && anyRounded) {
              shapeType = "ROUND_RECTANGLE";
            } else if (anyRounded) {
              // Non-uniform radii: pick best shape
              const topSame = Math.abs(cr.tl - cr.tr) < 2;
              const bottomSame = Math.abs(cr.bl - cr.br) < 2;
              const leftSame = Math.abs(cr.tl - cr.bl) < 2;
              const rightSame = Math.abs(cr.tr - cr.br) < 2;
              const topRounded = cr.tl > 2 || cr.tr > 2;
              const bottomRounded = cr.bl > 2 || cr.br > 2;

              if (topSame && bottomSame && topRounded && !bottomRounded) {
                // Top-left + top-right rounded, bottom square
                shapeType = "ROUND_2_SAME_RECTANGLE";
                rotation = 0;
              } else if (topSame && bottomSame && !topRounded && bottomRounded) {
                // Bottom-left + bottom-right rounded, top square
                shapeType = "ROUND_2_SAME_RECTANGLE";
                rotation = 180;
              } else if (leftSame && rightSame && (cr.tl > 2) && !(cr.tr > 2)) {
                // Left side rounded
                shapeType = "ROUND_2_SAME_RECTANGLE";
                rotation = 270;
              } else if (leftSame && rightSame && !(cr.tl > 2) && (cr.tr > 2)) {
                // Right side rounded
                shapeType = "ROUND_2_SAME_RECTANGLE";
                rotation = 90;
              } else {
                // Arbitrary: approximate with ROUND_2_SAME or ROUND_RECTANGLE
                // Pick the pair with largest combined radius
                const topSum = cr.tl + cr.tr;
                const bottomSum = cr.bl + cr.br;
                if (topSum >= bottomSum && topSum > 4) {
                  shapeType = "ROUND_2_SAME_RECTANGLE";
                  rotation = 0;
                } else if (bottomSum > 4) {
                  shapeType = "ROUND_2_SAME_RECTANGLE";
                  rotation = 180;
                } else {
                  shapeType = "ROUND_RECTANGLE";
                }
              }
            } else {
              shapeType = "RECTANGLE";
            }

            // --- Build transform (apply rotation if needed for ROUND_2_SAME_RECTANGLE) ---
            let transform: any;
            if (rotation === 0) {
              transform = { scaleX: 1, scaleY: 1, translateX: emu(b.x), translateY: emu(b.y), unit: "EMU" };
            } else if (rotation === 180) {
              // Rotate 180°: scaleX=-1, scaleY=-1, translate to opposite corner
              transform = { scaleX: -1, scaleY: -1, translateX: emu(b.x + b.w), translateY: emu(b.y + b.h), unit: "EMU" };
            } else if (rotation === 90) {
              // Rotate 90° CW: swap w/h, adjust position
              transform = { scaleX: 0, scaleY: 0, shearX: -1, shearY: 1, translateX: emu(b.x + b.w), translateY: emu(b.y), unit: "EMU" };
            } else if (rotation === 270) {
              transform = { scaleX: 0, scaleY: 0, shearX: 1, shearY: -1, translateX: emu(b.x), translateY: emu(b.y + b.h), unit: "EMU" };
            }

            // Swap size for 90/270 rotation
            const sizeW = (rotation === 90 || rotation === 270) ? b.h : b.w;
            const sizeH = (rotation === 90 || rotation === 270) ? b.w : b.h;

            // --- Look ahead: merge text into this shape if text bounds match/overlap ---
            // This handles flex-centered text inside containers: the text gets rendered
            // INSIDE the shape with contentAlignment: MIDDLE instead of as a separate text box.
            let mergedTextEl: any = null;
            if (ei + 1 < extraction.elements.length) {
              const next = extraction.elements[ei + 1];
              if (next.type === "text" && next.bounds) {
                const nb = next.bounds;
                // Merge if text bounds are same as rect bounds (same container)
                // or if text center is inside the rect
                const sameBounds = Math.abs(nb.x - b.x) < 5 && Math.abs(nb.y - b.y) < 5 &&
                                   Math.abs(nb.w - b.w) < 5 && Math.abs(nb.h - b.h) < 5;
                const tcx = nb.x + nb.w / 2, tcy = nb.y + nb.h / 2;
                const insideBounds = tcx >= b.x && tcx <= b.x + b.w && tcy >= b.y && tcy <= b.y + b.h;
                if (sameBounds || (insideBounds && (isCircle || b.w < 300))) {
                  mergedTextEl = next;
                  extraction.elements[ei + 1] = { type: "_skip", bounds: nb };
                }
              }
            }

            // --- Pre-create non-uniform border shapes BEFORE content shape ---
            // Slides layers in creation order (later = on top), so border shapes must come first.
            // Content shape then covers the inner area, exposing only the border-width strips.
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
                const bsId = newId();
                requests.push({
                  createShape: {
                    objectId: bsId,
                    shapeType: anyRounded ? shapeType : "RECTANGLE",
                    elementProperties: {
                      pageObjectId: slideId,
                      size: { width: { magnitude: emu(side.w), unit: "EMU" }, height: { magnitude: emu(side.h), unit: "EMU" } },
                      transform: { scaleX: 1, scaleY: 1, translateX: emu(side.x), translateY: emu(side.y), unit: "EMU" },
                    },
                  },
                });
                requests.push({ updateShapeProperties: {
                  objectId: bsId,
                  shapeProperties: {
                    shapeBackgroundFill: { solidFill: { color: solidColor(side.color) } },
                    outline: { propertyState: "NOT_RENDERED" },
                  },
                  fields: "shapeBackgroundFill.solidFill.color,outline.propertyState",
                } });
              }
            }

            // --- Content shape (ON TOP of border shapes) ---
            const shapeId = newId();
            requests.push({
              createShape: {
                objectId: shapeId,
                shapeType,
                elementProperties: {
                  pageObjectId: slideId,
                  size: { width: { magnitude: emu(sizeW), unit: "EMU" }, height: { magnitude: emu(sizeH), unit: "EMU" } },
                  transform,
                },
              },
            });

            // --- Fill (gradient or solid) + outline ---
            const shapeProps: any = {};
            let fields = "";
            if (el.gradient && el.gradient.stops && el.gradient.stops.length >= 2) {
              // Linear gradient fill — map to Slides linearGradient
              const g = el.gradient;
              const angleRad = (g.angle * Math.PI) / 180;
              // Slides gradient uses start/end points as fractions of the shape
              // Convert CSS angle to start/end: 0deg=bottom-to-top, 90deg=left-to-right
              const startX = 0.5 - 0.5 * Math.sin(angleRad);
              const startY = 0.5 + 0.5 * Math.cos(angleRad);
              const endX = 0.5 + 0.5 * Math.sin(angleRad);
              const endY = 0.5 - 0.5 * Math.cos(angleRad);
              shapeProps.shapeBackgroundFill = {
                propertyState: "RENDERED",
              };
              // Note: Slides API uses pageBackgroundFill.stretchedPictureFill or shape-level gradient
              // The linearGradient is not directly settable via shapeBackgroundFill in batchUpdate.
              // Fall back to solid first color, but set it properly.
              shapeProps.shapeBackgroundFill = { solidFill: { color: solidColor(el.gradient.stops[0].color) } };
              fields = "shapeBackgroundFill.solidFill.color";
            } else if (el.fill) {
              shapeProps.shapeBackgroundFill = { solidFill: { color: solidColor(el.fill) } };
              fields = "shapeBackgroundFill.solidFill.color";
            } else {
              shapeProps.shapeBackgroundFill = { propertyState: "NOT_RENDERED" };
              fields = "shapeBackgroundFill.propertyState";
            }
            if (mergedTextEl) {
              shapeProps.contentAlignment = "MIDDLE";
              fields += ",contentAlignment";
            }

            // --- Border outline on content shape ---
            // Non-uniform borders were already created as shapes BEFORE this content shape.
            // For uniform borders, use the shape's outline. For non-uniform, no outline needed.
            if (hasNonUniformBorder) {
              shapeProps.outline = { propertyState: "NOT_RENDERED" };
              fields += ",outline.propertyState";
            } else if (uniform && el.borderWidth > 0 && el.borderColor) {
              const outline: any = {
                outlineFill: { solidFill: { color: solidColor(el.borderColor) } },
                weight: { magnitude: Math.min(el.borderWidth * PX2PT, 6), unit: "PT" },
              };
              if (el.borderStyle === "dashed") outline.dashStyle = "DASH";
              else if (el.borderStyle === "dotted") outline.dashStyle = "DOT";
              shapeProps.outline = outline;
              fields += ",outline";
            } else {
              shapeProps.outline = { propertyState: "NOT_RENDERED" };
              fields += ",outline.propertyState";
            }
            // --- Box shadow (see "Box Shadow Rules" in extract-dom.ts) ---
            // Slides API shadow: { type, blurRadius, color, alpha, rotateWithShape, transform, propertyState }
            if (el.boxShadow && (el.boxShadow.blur > 0 || el.boxShadow.offsetX !== 0 || el.boxShadow.offsetY !== 0)) {
              const sh = el.boxShadow;
              shapeProps.shadow = {
                type: "OUTER",
                blurRadius: { magnitude: Math.min(sh.blur * PX2PT, 30), unit: "PT" },
                color: solidColor(sh.color || "#000000"),
                alpha: 0.25,
                rotateWithShape: false,
                transform: {
                  scaleX: 1, scaleY: 1,
                  translateX: emu(sh.offsetX),
                  translateY: emu(sh.offsetY),
                  unit: "EMU",
                },
                propertyState: "RENDERED",
              };
              fields += ",shadow";
            }
            requests.push({ updateShapeProperties: { objectId: shapeId, shapeProperties: shapeProps, fields } });

            // --- Merged text ---
            if (mergedTextEl) {
              const ms = mergedTextEl.style || {};
              let text = mergedTextEl.text || "";
              if (ms.textTransform === "uppercase") text = text.toUpperCase();
              requests.push({ insertText: { objectId: shapeId, text, insertionIndex: 0 } });
              requests.push({
                updateParagraphStyle: {
                  objectId: shapeId,
                  textRange: { type: "ALL" },
                  style: { alignment: "CENTER" },
                  fields: "alignment",
                },
              });
              requests.push({
                updateTextStyle: {
                  objectId: shapeId,
                  textRange: { type: "ALL" },
                  style: {
                    fontFamily: mapFont(ms.fontFamily || "Arial"),
                    fontSize: { magnitude: (ms.fontSize || 14) * PX2PT, unit: "PT" },
                    foregroundColor: textColor(ms.color || "#ffffff"),
                    bold: ms.fontWeight === "bold",
                  },
                  fields: "fontFamily,fontSize,foregroundColor,bold",
                },
              });
            }
          }
          break;
        }

        case "line": {
          const lineId = newId();
          const isVertical = b.h > b.w * 2;
          requests.push({
            createLine: {
              objectId: lineId,
              lineCategory: "STRAIGHT",
              elementProperties: {
                pageObjectId: slideId,
                size: {
                  width: { magnitude: isVertical ? 0 : emu(b.w), unit: "EMU" },
                  height: { magnitude: isVertical ? emu(b.h) : 0, unit: "EMU" },
                },
                transform: { scaleX: 1, scaleY: 1, translateX: emu(b.x), translateY: emu(b.y), unit: "EMU" },
              },
            },
          });
          requests.push({
            updateLineProperties: {
              objectId: lineId,
              lineProperties: {
                lineFill: { solidFill: { color: solidColor(el.color || "#000000") } },
                weight: { magnitude: Math.max(0.5, isVertical ? b.w * PX2PT : b.h * PX2PT), unit: "PT" },
              },
              fields: "lineFill.solidFill.color,weight",
            },
          });
          break;
        }

        case "text": {
          const s = el.style || {};
          const textId = newId();

          // Use exact measurements from HTML — no artificial bounding box expansion.
          // Instead, set Slides text box insets to 0 so text renders at exact position.
          const bx = b.x;
          const by = b.y;
          const bw = b.w;
          const bh = b.h;

          // Create text box at exact HTML bounds
          requests.push({
            createShape: {
              objectId: textId,
              shapeType: "TEXT_BOX",
              elementProperties: {
                pageObjectId: slideId,
                size: { width: { magnitude: emu(bw), unit: "EMU" }, height: { magnitude: emu(bh), unit: "EMU" } },
                transform: { scaleX: 1, scaleY: 1, translateX: emu(bx), translateY: emu(by), unit: "EMU" },
              },
            },
          });

          // Set content alignment + zero insets (exact positioning)
          requests.push({
            updateShapeProperties: {
              objectId: textId,
              shapeProperties: {
                contentAlignment: "TOP",
              },
              fields: "contentAlignment",
            },
          });

          // Build text content with runs
          let fullText = el.text || "";
          if (s.textTransform === "uppercase") fullText = fullText.toUpperCase();

          requests.push({ insertText: { objectId: textId, text: fullText, insertionIndex: 0 } });

          // Paragraph style (alignment, line spacing)
          const align = s.textAlign === "center" ? "CENTER" : s.textAlign === "right" ? "END" : "START";
          const paraStyle: any = { alignment: align };
          let paraFields = "alignment";
          if (s.lineHeight && s.fontSize) {
            const ratio = s.lineHeight / s.fontSize;
            paraStyle.lineSpacing = ratio * 100; // percentage
            paraFields += ",lineSpacing";
          }
          requests.push({
            updateParagraphStyle: {
              objectId: textId,
              textRange: { type: "ALL" },
              style: paraStyle,
              fields: paraFields,
            },
          });

          // Text styling — use runs if available, otherwise apply base style to all
          if (el.runs && el.runs.length > 0) {
            let idx = 0;
            for (const run of el.runs) {
              let runText = run.text || "";
              if (s.textTransform === "uppercase") runText = runText.toUpperCase();
              const runLen = runText.length;
              if (runLen === 0) continue;

              const rs = run.style || {};
              const style: any = {
                fontFamily: mapFont(rs.fontFamily || s.fontFamily || "Arial"),
                fontSize: { magnitude: (rs.fontSize || s.fontSize || 16) * PX2PT, unit: "PT" },
                foregroundColor: textColor(rs.color || s.color || "#333333"),
                bold: rs.fontWeight === "bold" || (!rs.fontWeight && s.fontWeight === "bold"),
                italic: rs.fontStyle === "italic" || (!rs.fontStyle && s.fontStyle === "italic"),
              };
              let styleFields = "fontFamily,fontSize,foregroundColor,bold,italic";
              if (rs.textDecoration === "underline" || (!rs.textDecoration && s.textDecoration === "underline")) {
                style.underline = true;
                styleFields += ",underline";
              }
              if (rs.textDecoration === "line-through" || (!rs.textDecoration && s.textDecoration === "line-through")) {
                style.strikethrough = true;
                styleFields += ",strikethrough";
              }

              requests.push({
                updateTextStyle: {
                  objectId: textId,
                  textRange: { type: "FIXED_RANGE", startIndex: idx, endIndex: idx + runLen },
                  style,
                  fields: styleFields,
                },
              });
              idx += runLen;
            }
          } else {
            // Apply base style to all text
            const style: any = {
              fontFamily: mapFont(s.fontFamily || "Arial"),
              fontSize: { magnitude: (s.fontSize || 16) * PX2PT, unit: "PT" },
              foregroundColor: textColor(s.color || "#333333"),
              bold: s.fontWeight === "bold",
              italic: s.fontStyle === "italic",
            };
            let styleFields = "fontFamily,fontSize,foregroundColor,bold,italic";
            if (s.textDecoration === "underline") { style.underline = true; styleFields += ",underline"; }
            if (s.textDecoration === "line-through") { style.strikethrough = true; styleFields += ",strikethrough"; }

            requests.push({
              updateTextStyle: {
                objectId: textId,
                textRange: { type: "ALL" },
                style,
                fields: styleFields,
              },
            });
          }
          break;
        }

        case "table": {
          const rows = el.rows || [];
          if (rows.length === 0) break;
          const cols = Math.max(...rows.map((r: any) => r.length));
          const tableId = newId();

          requests.push({
            createTable: {
              objectId: tableId,
              rows: rows.length,
              columns: cols,
              elementProperties: {
                pageObjectId: slideId,
                size: { width: { magnitude: emu(b.w), unit: "EMU" }, height: { magnitude: emu(b.h), unit: "EMU" } },
                transform: { scaleX: 1, scaleY: 1, translateX: emu(b.x), translateY: emu(b.y), unit: "EMU" },
              },
            },
          });

          // Insert text and style each cell
          for (let ri = 0; ri < rows.length; ri++) {
            for (let ci = 0; ci < rows[ri].length; ci++) {
              const cell = rows[ri][ci];
              const cellId = `${tableId}`;
              const text = cell.text || "";
              if (text) {
                requests.push({
                  insertText: {
                    objectId: cellId,
                    cellLocation: { rowIndex: ri, columnIndex: ci },
                    text,
                    insertionIndex: 0,
                  },
                });
              }
              // Cell text style
              const cs = cell.style || {};
              requests.push({
                updateTextStyle: {
                  objectId: cellId,
                  cellLocation: { rowIndex: ri, columnIndex: ci },
                  textRange: { type: "ALL" },
                  style: {
                    fontFamily: mapFont(cs.fontFamily || "Arial"),
                    fontSize: { magnitude: (cs.fontSize || 14) * PX2PT, unit: "PT" },
                    foregroundColor: textColor(cs.color || "#333333"),
                    bold: cs.fontWeight === "bold" || cell.isHeader,
                  },
                  fields: "fontFamily,fontSize,foregroundColor,bold",
                },
              });
              // Cell background
              if (cs.bgColor || cell.isHeader) {
                requests.push({
                  updateTableCellProperties: {
                    objectId: cellId,
                    tableRange: { location: { rowIndex: ri, columnIndex: ci }, rowSpan: 1, columnSpan: 1 },
                    tableCellProperties: {
                      tableCellBackgroundFill: {
                        solidFill: { color: solidColor(cs.bgColor || "#e8e8e8") },
                      },
                    },
                    fields: "tableCellBackgroundFill.solidFill.color",
                  },
                });
              }
            }
          }
          break;
        }

        case "list": {
          const items = el.items || [];
          if (items.length === 0) break;
          const listId = newId();

          // Create text box for the list
          requests.push({
            createShape: {
              objectId: listId,
              shapeType: "TEXT_BOX",
              elementProperties: {
                pageObjectId: slideId,
                size: { width: { magnitude: emu(b.w), unit: "EMU" }, height: { magnitude: emu(b.h), unit: "EMU" } },
                transform: { scaleX: 1, scaleY: 1, translateX: emu(b.x), translateY: emu(b.y), unit: "EMU" },
              },
            },
          });

          // Determine bullet strategy
          const useNativeBullets = el.listStyleType !== "none" && !el.hasPseudoBullet;
          const usePseudoBullets = el.hasPseudoBullet;
          const bulletPrefix = usePseudoBullets ? (el.pseudoBulletChar || "•") + "  " : "";
          const bulletColor = el.pseudoBulletColor || null;

          // Build full text with newlines (prepend bullet char for pseudo-bullets)
          const fullText = items.map((item: any) => bulletPrefix + item.text).join("\n");
          requests.push({ insertText: { objectId: listId, text: fullText, insertionIndex: 0 } });

          // Style each paragraph (item) and apply bullets
          let charIdx = 0;
          for (let ii = 0; ii < items.length; ii++) {
            const item = items[ii];
            const prefixLen = bulletPrefix.length;
            const itemLen = item.text.length;
            const totalLen = prefixLen + itemLen;
            const endIdx = charIdx + totalLen + (ii < items.length - 1 ? 1 : 0); // +1 for newline

            // First: style ALL text in this item (bullet + content) with base style
            requests.push({
              updateTextStyle: {
                objectId: listId,
                textRange: { type: "FIXED_RANGE", startIndex: charIdx, endIndex: charIdx + totalLen },
                style: {
                  fontFamily: mapFont(item.fontFamily || "Arial"),
                  fontSize: { magnitude: (item.fontSize || 16) * PX2PT, unit: "PT" },
                  foregroundColor: textColor(item.color || "#333333"),
                  bold: item.fontWeight === "bold",
                },
                fields: "fontFamily,fontSize,foregroundColor,bold",
              },
            });

            // Then: override bullet prefix color (applied LAST so it wins)
            if (usePseudoBullets && prefixLen > 0 && bulletColor) {
              requests.push({
                updateTextStyle: {
                  objectId: listId,
                  textRange: { type: "FIXED_RANGE", startIndex: charIdx, endIndex: charIdx + prefixLen },
                  style: {
                    foregroundColor: textColor(bulletColor),
                  },
                  fields: "foregroundColor",
                },
              });
            }

            // Native bullet (for lists with CSS list-style)
            if (useNativeBullets) {
              requests.push({
                createParagraphBullets: {
                  objectId: listId,
                  textRange: { type: "FIXED_RANGE", startIndex: charIdx, endIndex: charIdx + totalLen },
                  bulletPreset: el.ordered ? "NUMBERED_DIGIT_ALPHA_ROMAN" : "BULLET_DISC_CIRCLE_SQUARE",
                },
              });
            }

            // Paragraph style (indentation, spacing)
            const paraStyle: any = {
              indentStart: { magnitude: item.level * 18, unit: "PT" },
            };
            let paraFields = "indentStart";
            if (item.lineHeight && item.fontSize) {
              paraStyle.lineSpacing = (item.lineHeight / item.fontSize) * 100;
              paraFields += ",lineSpacing";
            }
            if (item.spacingAfter) {
              paraStyle.spaceBelow = { magnitude: item.spacingAfter * PX2PT, unit: "PT" };
              paraFields += ",spaceBelow";
            }
            requests.push({
              updateParagraphStyle: {
                objectId: listId,
                textRange: { type: "FIXED_RANGE", startIndex: charIdx, endIndex: charIdx + totalLen },
                style: paraStyle,
                fields: paraFields,
              },
            });

            charIdx = endIdx;
          }
          break;
        }

        case "visual":
        case "image": {
          const key = `${si}-${ei}`;
          const url = visualUrls.get(key);
          if (url) {
            const imgId = newId();
            requests.push({
              createImage: {
                objectId: imgId,
                url,
                elementProperties: {
                  pageObjectId: slideId,
                  size: { width: { magnitude: emu(b.w), unit: "EMU" }, height: { magnitude: emu(b.h), unit: "EMU" } },
                  transform: { scaleX: 1, scaleY: 1, translateX: emu(b.x), translateY: emu(b.y), unit: "EMU" },
                },
              },
            });
          }
          break;
        }
      }
    }
  }

  return requests;
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npx tsx convert-slides-api.ts <html-dir> [--title 'Name'] [--presentation <id>]");
    process.exit(1);
  }

  const input = args[0];
  let title = "Converted Presentation";
  const titleIdx = args.indexOf("--title");
  if (titleIdx >= 0 && args[titleIdx + 1]) title = args[titleIdx + 1];


  // Collect HTML files — any .html file, sorted alphabetically
  let htmlFiles: string[] = [];
  if (input.endsWith(".html")) {
    htmlFiles = [resolve(input)];
  } else {
    htmlFiles = readdirSync(input)
      .filter(f => f.endsWith(".html"))
      .sort()
      .map(f => resolve(join(input, f)));
  }

  if (htmlFiles.length === 0) { console.error("No .html files found in " + input); process.exit(1); }

  console.log(`Converting ${htmlFiles.length} HTML slides → Google Slides "${title}"`);

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

  // Step 2: Auth + create presentation
  const auth = getAuth();
  const slidesApi = google.slides({ version: "v1", auth });
  const driveApi = google.drive({ version: "v3", auth });

  console.log(`\nCreating presentation...`);
  const pres = await slidesApi.presentations.create({ requestBody: { title } });
  const presId = pres.data.presentationId!;
  console.log(`  ID: ${presId}`);

  // Delete the default blank slide
  const defaultSlideId = pres.data.slides?.[0]?.objectId;
  if (defaultSlideId) {
    await slidesApi.presentations.batchUpdate({
      presentationId: presId,
      requestBody: { requests: [{ deleteObject: { objectId: defaultSlideId } }] },
    });
  }

  // Step 3: Upload visual PNGs to Drive
  const visualUrls = await uploadVisualsToDrive(driveApi, slideData);
  console.log(`  ${visualUrls.size} visuals uploaded`);

  // Step 4: Build all requests
  console.log(`\nBuilding batch update...`);
  const requests = buildRequests(slideData, visualUrls);
  console.log(`  ${requests.length} total API requests`);

  // Step 5: Execute batchUpdate (split if needed — API may have payload limits)
  const BATCH_SIZE = 500;
  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const batch = requests.slice(i, i + BATCH_SIZE);
    console.log(`  Executing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(requests.length / BATCH_SIZE)} (${batch.length} requests)...`);
    try {
      await slidesApi.presentations.batchUpdate({
        presentationId: presId,
        requestBody: { requests: batch },
      });
    } catch (err: any) {
      console.error(`  Batch failed at request index ~${i}:`, err.message);
      if (err.response?.data?.error?.details) {
        console.error("  Details:", JSON.stringify(err.response.data.error.details).substring(0, 500));
      }
      // Try to identify which request failed
      if (err.response?.data?.error?.message) {
        console.error("  API message:", err.response.data.error.message);
      }
      break;
    }
  }

  const url = `https://docs.google.com/presentation/d/${presId}/edit`;
  console.log(`\n  → ${url}`);
  console.log(`Done.`);
}

main().catch(err => { console.error(err); process.exit(1); });
