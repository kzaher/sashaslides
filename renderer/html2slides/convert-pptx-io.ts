/**
 * convert-pptx-io.ts — Side-effectful counterpart to convert-pptx-lib.ts.
 *
 * Anything that touches the filesystem, Chrome DevTools Protocol, or the
 * Google Drive API lives here. Pure shape/layout/XML logic stays in
 * convert-pptx-lib.ts and is consumed via plain imports below.
 *
 * Exports:
 *   - extractFromHtml(htmlPath) — open a Chrome tab via CDP, run extract-dom,
 *                                  rasterise visual/image/emoji-text regions,
 *                                  close tab.
 *   - injectGradients(pptxPath, registry) — file-based wrapper for the in-zip
 *                                  helper that writes the patched bytes back.
 *   - injectStrokeAlignment(pptxPath) — file-based wrapper, ditto.
 *   - getAuth() — load the project's stored OAuth tokens for Drive.
 *   - runConvertPptx(opts) — orchestrator: walk a fixture directory in
 *                                  parallel, build a pptx, post-process, and
 *                                  (unless noUpload) upload to Drive.
 */

import CDP from "chrome-remote-interface";
import { google } from "googleapis";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { Readable } from "stream";
import { transformSync } from "esbuild";
import JSZip from "jszip";

import {
  buildPptx,
  injectGradientsIntoZip,
  injectStrokeAlignmentIntoZip,
  injectRound2SameRectAdjIntoZip,
  injectShapeNoLineIntoZip,
  injectCellNoBorderIntoZip,
  injectClipGroupsIntoZip,
  SLIDE_W_PX,
  SLIDE_H_PX,
  type Extraction,
  type SlideInput,
  type Gradient,
} from "./convert-pptx-lib.js";

const CDP_PORT = 9222;

// chrome-remote-interface ships no .d.ts, so its `New` / `Close` static
// methods type as `any`. Narrow at the boundary via a typed shim — the
// only place this codebase tolerates an `any`-bridging cast (external
// API without types — see CLAUDE.md TypeScript style).
interface CDPStatic {
  New(opts: { port: number; url?: string }): Promise<{ id: string }>;
  Close(opts: { port: number; id: string }): Promise<void>;
}
// SAFETY: `CDP` default export is the connect-fn; CDP.New / CDP.Close are
// runtime-attached static methods documented at
// https://github.com/cyrus-and/chrome-remote-interface#cdpnewoptions-callback
// — `CDPStatic` mirrors the documented signature for the two static methods
// we actually call. Untyped JS, runtime contract.
const CDPS = CDP as unknown as CDPStatic;

// Compile extract-dom.ts → JS once at module load. Only this Node-only file
// reads the source; the browser bundle inlines the compiled string at build
// time via esbuild `define` and never touches this module.
const EXTRACT_JS = transformSync(
  readFileSync(join(dirname(new URL(import.meta.url).pathname), "extract-dom.ts"), "utf-8"),
  { loader: "ts", target: "es2020" },
).code;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Rasterisation oversampling factor (deviceScaleFactor + element capture
// scale). Clamp to [1,8]; default 2. A non-finite/missing value falls back to 2
// so unchanged callers stay byte-identical.
export function clampOversampling(n: number | undefined | null): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 2;
  return Math.min(8, Math.max(1, v));
}

// --- Auth ----------------------------------------------------------------
export function getAuth() {
  const creds = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/google_oauth.json", "utf-8")).installed;
  const tokens = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/tokens.json", "utf-8"));
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost:8080");
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", (newTokens: Record<string, unknown>) => {
    const merged = { ...tokens, ...newTokens };
    writeFileSync("/workspaces/sashaslides/.auth/tokens.json", JSON.stringify(merged, null, 2));
  });
  return oauth2;
}

// --- DOM Extraction ------------------------------------------------------
// `oversampling` is the rasterisation scale factor (deviceScaleFactor + the
// per-element capture scale). Defaults to 2 (retina); clamped to [1,8] so an
// unchanged caller and the default UI value both render byte-identically.
export async function extractFromHtml(
  htmlPath: string,
  tablesFormat: "native" | "baked" = "native",
  oversampling: number = 2,
): Promise<{ extraction: Extraction; visualPngs: Map<number, Buffer> }> {
  const scale = clampOversampling(oversampling);
  const absPath = resolve(htmlPath);
  const tab = await CDPS.New({ port: CDP_PORT, url: `file://${absPath}` });
  await sleep(1200);

  const client = await CDP({ target: tab, port: CDP_PORT });
  const { Page, Runtime, Emulation } = client;
  await Page.enable();
  await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: SLIDE_W_PX, height: SLIDE_H_PX, deviceScaleFactor: scale, mobile: false });
  await sleep(800);
  await Runtime.evaluate({ expression: `document.fonts.ready.then(() => true)`, awaitPromise: true, returnByValue: true });
  await sleep(300);

  const { result } = await Runtime.evaluate({ expression: EXTRACT_JS, returnByValue: true });
  const extraction: Extraction = JSON.parse(result.value);

  // Emoji detection: Slides lacks an emoji font, so glyphs like ⚡🔒📊🔍🧐💳
  // render as tofu boxes. For text elements whose content is primarily emoji
  // codepoints, rasterize the element region from Chrome and emit as an image.
  const isEmojiCodepoint = (cp: number): boolean => {
    // Glyphs that render fine in Slides' standard text fonts must stay TEXT
    // (selectable/editable) — never rasterise them. User feedback (slide_07
    // ✓ check icon, slide_13 ▼ conversion-chip arrows): "can't we use fonts
    // in output?" / "text should never be rendered". These BMP symbol glyphs
    // are NOT pictographic emoji and have reliable monochrome font coverage.
    if (cp >= 0x25A0 && cp <= 0x25FF) return false;      // geometric ▲ ▼ ■ ● ○ (text-renderable)
    if (cp >= 0x2713 && cp <= 0x2718) return false;      // check / cross marks ✓ ✔ ✗ ✘
    if (cp >= 0x2600 && cp <= 0x27BF) return true;       // Misc symbols & dingbats (pictographs)
    if (cp === 0x200D || cp === 0xFE0F) return true;     // ZWJ / variation selector
    if (cp >= 0x1F1E6 && cp <= 0x1F1FF) return true;     // Regional indicators (flags)
    if (cp >= 0x1F300 && cp <= 0x1FAFF) return true;     // Main emoji blocks
    if (cp >= 0x2300 && cp <= 0x23FF) return true;       // misc technical (⚙ etc.)
    return false;
  };
  const looksLikeEmojiText = (s: string): boolean => {
    if (!s) return false;
    let emoji = 0, total = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (cp <= 0x20) continue;
      total++;
      if (isEmojiCodepoint(cp)) emoji++;
    }
    if (total === 0) return false;
    return emoji / total >= 0.5 && total <= 4;
  };
  // Re-type emoji-text elements as `image` so the rasterisation loop below
  // captures them. Immutable: build a fresh array instead of mutating in
  // place (ExtractedElement is readonly at the lib API boundary).
  // Tight glyph bbox: the original text bounds match the HOST element (e.g.
  // .stat-icon 42×42, .conversion-badge ::before host 110×30) which makes the
  // captured PNG fully mask the underlying native rect/text. Shrink to a
  // glyph-natural box (fontSize × 1.4 per side) positioned at the textbox's
  // alignment-derived centre so the surrounding native chrome (icon-circle
  // bg, "32% conversion" sibling text) shows through. User feedback wave-12A:
  // "make sure that the text is never baked into images" + "Why are bottom
  // icons rendered?" — the rect was native, only the PNG masked it.
  const retypedElements = extraction.elements.map((el) => {
    // tablesFormat=baked: rasterise each <table> as a single image so rounded
    // corners and every nested element render pixel-perfect (the screenshot
    // loop below captures it; the lib's image case emits slide.addImage). The
    // native <a:tbl> path (which can't do rounded corners) is bypassed.
    if (tablesFormat === "baked" && el.type === "table" && el.bounds.w > 5 && el.bounds.h > 5) {
      return { ...el, type: "image" as const, _bakedTable: true };
    }
    if (el.type !== "text" || !looksLikeEmojiText(el.text || "")) return el;
    const text = el.text || "";
    const visibleChars = Array.from(text).filter((c) => c.codePointAt(0)! > 0x20);
    const numGlyphs = Math.max(1, visibleChars.length);
    const fontSize = el.style?.fontSize || 20;
    const align = el.style?.textAlign || "left";
    const vCentered = el.verticallyCentered === true;
    const glyphW = Math.min(el.bounds.w, fontSize * 1.4 * numGlyphs);
    const glyphH = Math.min(el.bounds.h, fontSize * 1.4);
    let nx: number;
    if (align === "center") nx = el.bounds.x + (el.bounds.w - glyphW) / 2;
    else if (align === "right" || align === "end") nx = el.bounds.x + el.bounds.w - glyphW;
    else nx = el.bounds.x;
    const ny = vCentered ? el.bounds.y + (el.bounds.h - glyphH) / 2 : el.bounds.y;
    return {
      ...el,
      type: "image" as const,
      _wasEmojiText: true,
      bounds: { x: nx, y: ny, w: glyphW, h: glyphH },
    };
  });
  const retypedExtraction: Extraction = { ...extraction, elements: retypedElements };

  // Screenshot visual elements (svg/canvas/images/emoji + the large-radius
  // `clipped-container` device mockups). Captured at `oversampling`× (default
  // 2 = retina) so the rasterised >50%-corner fallback — where a device's
  // rounded chrome can't be a native roundRect and is emitted as a PNG instead
  // — stays retina-sharp (user: "Create 2x resolution because of retina
  // displays"). The browser clips the capture to the element's true rounded
  // geometry; `omitBackground` keeps the four corner cut-outs transparent.
  const RETINA_SCALE = scale;
  const visualPngs = new Map<number, Buffer>();
  for (let i = 0; i < retypedExtraction.elements.length; i++) {
    const el = retypedExtraction.elements[i];
    if ((el.type === "visual" || el.type === "image") && el.bounds.w > 5 && el.bounds.h > 5) {
      const clip = { x: el.bounds.x, y: el.bounds.y, width: el.bounds.w, height: el.bounds.h, scale: RETINA_SCALE };
      const ss = await Page.captureScreenshot({ format: "png", clip, captureBeyondViewport: true, omitBackground: true });
      visualPngs.set(i, Buffer.from(ss.data, "base64"));
    }
  }

  await client.close();
  await CDPS.Close({ port: CDP_PORT, id: tab.id });
  return { extraction: retypedExtraction, visualPngs };
}

// --- File-based wrappers around the pure in-zip injection helpers --------

export async function injectGradients(pptxPath: string, registry: readonly Gradient[]): Promise<void> {
  if (!registry || registry.length === 0) return;
  const buf = readFileSync(pptxPath);
  const zip = await JSZip.loadAsync(buf);
  const patched = await injectGradientsIntoZip(zip, registry);
  if (patched > 0) {
    const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    writeFileSync(pptxPath, out);
    console.log(`  Gradient injection: ${patched} shape(s) patched`);
  }
}

export async function injectStrokeAlignment(pptxPath: string): Promise<void> {
  const buf = readFileSync(pptxPath);
  const zip = await JSZip.loadAsync(buf);
  const patched = await injectStrokeAlignmentIntoZip(zip);
  if (patched > 0) {
    const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    writeFileSync(pptxPath, out);
    console.log(`  Stroke alignment: ${patched} <a:ln> rewrite(s) to algn="in"`);
  }
}

export async function injectRound2SameRectAdj(pptxPath: string): Promise<void> {
  const buf = readFileSync(pptxPath);
  const zip = await JSZip.loadAsync(buf);
  const patched = await injectRound2SameRectAdjIntoZip(zip);
  if (patched > 0) {
    const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    writeFileSync(pptxPath, out);
    console.log(`  round2SameRect adj: ${patched} prstGeom(s) → adj1/adj2`);
  }
}

export async function injectShapeNoLine(pptxPath: string): Promise<void> {
  const buf = readFileSync(pptxPath);
  const zip = await JSZip.loadAsync(buf);
  const patched = await injectShapeNoLineIntoZip(zip);
  if (patched > 0) {
    const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    writeFileSync(pptxPath, out);
    console.log(`  Shape no-line: ${patched} empty <a:ln> rewrite(s) to <a:noFill/>`);
  }
}

export async function injectCellNoBorder(pptxPath: string): Promise<void> {
  const buf = readFileSync(pptxPath);
  const zip = await JSZip.loadAsync(buf);
  const patched = await injectCellNoBorderIntoZip(zip);
  if (patched > 0) {
    const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    writeFileSync(pptxPath, out);
    console.log(`  Cell no-border: ${patched} <a:ln[LRTB] w=0> rewrite(s) to <a:noFill/>`);
  }
}

export async function injectClipGroups(pptxPath: string): Promise<void> {
  const buf = readFileSync(pptxPath);
  const zip = await JSZip.loadAsync(buf);
  const created = await injectClipGroupsIntoZip(zip);
  if (created > 0) {
    const out = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    writeFileSync(pptxPath, out);
    console.log(`  Clip groups: ${created} <p:grpSp>(s) wrapping patch+host pairs`);
  }
}

// --- Public API ----------------------------------------------------------

export interface ConvertPptxOpts {
  htmlDir: string;          // absolute or cwd-relative path; lib will resolve()
  title?: string;            // default "Presentation"
  outPath?: string | null;   // default null → /tmp/<sanitized-title>.pptx
  noUpload?: boolean;        // default false
  only?: string[] | null;    // list of basenames like ["slide_11.html", ...]; default null = all
  tablesFormat?: "native" | "baked"; // default "native" (editable <a:tbl>, square corners);
                                     // "baked" rasterises tables (rounded corners + full fidelity)
  oversampling?: number;             // rasterisation scale factor, clamped [1,8]; default 2 (retina)
}

export interface ConvertPptxResult {
  pptxPath: string;          // where the .pptx was written
  presId?: string;           // set only when not noUpload and upload succeeded
  slideCount: number;
  regionsPath: string;       // path to rendered-regions.json sidecar
}

// --- Entry point ---------------------------------------------------------
export async function runConvertPptx(opts: ConvertPptxOpts): Promise<ConvertPptxResult> {
  const htmlDir = resolve(opts.htmlDir || ".");
  const title = opts.title ?? "Presentation";
  const outPath: string | null = opts.outPath ?? null;
  const noUpload = opts.noUpload ?? false;
  const onlyFiles: readonly string[] | null = opts.only ?? null;
  const tablesFormat: "native" | "baked" = opts.tablesFormat ?? "native";
  const oversampling = clampOversampling(opts.oversampling);

  const htmlFiles = readdirSync(htmlDir)
    .filter(f => f.endsWith(".html"))
    .filter(f => !onlyFiles || onlyFiles.includes(f))
    .sort()
    .map(f => join(htmlDir, f));

  if (htmlFiles.length === 0) { console.error("No HTML files found in", htmlDir); process.exit(1); }
  console.log(`Converting ${htmlFiles.length} HTML slides → pptx "${title}"`);
  console.log(`  tablesFormat: ${tablesFormat}`);
  console.log(`  oversampling: ${oversampling}×`);

  // Step 1: Extract DOM from all slides — fully in parallel. Each slide opens
  // its own short-lived Chrome tab via CDP.New; tabs are independent so there's
  // no cross-talk. Override with EXTRACT_CONCURRENCY=N if Chrome gets unhappy.
  const EXTRACT_CONCURRENCY = Number(process.env.EXTRACT_CONCURRENCY) || htmlFiles.length;
  const slideData: { extraction: Extraction; visualPngs: Map<number, Buffer> }[] = new Array(htmlFiles.length);
  const t0 = Date.now();
  let nextIdx = 0;
  async function extractWorker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= htmlFiles.length) return;
      const f = htmlFiles[idx];
      console.log(`  [${idx + 1}/${htmlFiles.length}] Extracting ${f.split("/").pop()}...`);
      const data = await extractFromHtml(f, tablesFormat, oversampling);
      console.log(`    [${idx + 1}] ${data.extraction.elementCount} elements, ${data.visualPngs.size} visuals`);
      slideData[idx] = data;
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(EXTRACT_CONCURRENCY, htmlFiles.length) }, () => extractWorker()),
  );
  console.log(`  Extraction: ${((Date.now() - t0) / 1000).toFixed(1)}s (concurrency=${Math.min(EXTRACT_CONCURRENCY, htmlFiles.length)})`);

  // Step 2: Build pptx
  console.log("\nBuilding .pptx...");
  const { pres, renderedRegions } = buildPptx(slideData as readonly SlideInput[], title);

  const pptxPath = outPath || `/tmp/${title.replace(/[^a-zA-Z0-9]/g, "_")}.pptx`;
  await pres.writeFile({ fileName: pptxPath });
  console.log(`  Saved: ${pptxPath}`);

  // Sidecar: per-slide rasterised regions so the SxS rating UI can warn the
  // reviewer that the output isn't 100% native primitives.
  const regionsBySlide: Record<string, unknown> = {};
  let totalRegions = 0;
  for (let i = 0; i < renderedRegions.length; i++) {
    // Key by the REAL fixture id (slide_NN from the input html), NOT the slide
    // INDEX. renderedRegions[i] aligns 1:1 with htmlFiles[i]. Index keys
    // (slide_01, slide_02…) broke the rating UI whenever a SUBSET was rendered
    // (e.g. `--slides slide_12` → the lone slide got keyed slide_01), so the UI's
    // lookup by comparison id (slide_12) missed it and the "Highlight rendered
    // regions" checkbox had nothing to mark.
    const key = basename(htmlFiles[i], ".html");
    regionsBySlide[key] = renderedRegions[i];
    totalRegions += renderedRegions[i].length;
  }
  const regionsPath = join(dirname(pptxPath), "rendered-regions.json");
  writeFileSync(regionsPath, JSON.stringify(regionsBySlide, null, 2));
  console.log(`  Rendered regions: ${totalRegions} total across ${renderedRegions.length} slides → ${regionsPath}`);

  // ALL pptxgenjs OOXML fixes are now NATIVE in the vendored fork
  // (deps/pptxgenjs/src) — no zip post-patches remain:
  //   • gradient fills      → fill: { type: 'gradient' } → <a:gradFill>
  //   • stroke align="in"   → width-bearing <a:ln> default
  //   • round2SameRect      → adj1/adj2 handle naming
  //   • empty <a:ln>        → <a:noFill/>
  //   • table-cell noFill   → minimal border form
  //   • shape groups        → slide.addGroup(...) → <p:grpSp>

  if (noUpload) {
    console.log("Done (no upload).");
    return { pptxPath, slideCount: htmlFiles.length, regionsPath };
  }

  // Step 3: Upload to Google Drive as Google Slides
  console.log("\nUploading to Google Slides...");
  const auth = getAuth();
  const driveApi = google.drive({ version: "v3", auth });

  const buf = readFileSync(pptxPath);
  const res = await driveApi.files.create({
    requestBody: { name: title, mimeType: "application/vnd.google-apps.presentation" },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      body: Readable.from(buf),
    },
    fields: "id",
  });
  const presId = res.data.id;
  console.log(`  → https://docs.google.com/presentation/d/${presId}/edit`);
  console.log("Done.");
  return { pptxPath, presId: presId ?? undefined, slideCount: htmlFiles.length, regionsPath };
}
