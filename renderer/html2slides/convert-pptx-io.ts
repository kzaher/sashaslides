/**
 * convert-pptx-io.ts — Side-effectful counterpart to convert-pptx-lib.ts.
 *
 * Anything that touches the filesystem, Chrome DevTools Protocol, or the
 * Google Drive API lives here. Pure shape/layout/XML logic stays in
 * convert-pptx-lib.ts and is consumed via plain imports below.
 *
 * Exports:
 *   - extractFromHtml(htmlPath) — open a Chrome tab via CDP, run extract-dom,
 *                                  apply the shared post-extraction fixes
 *                                  (post-extraction.ts), screenshot every
 *                                  region they mark for rasterising, close tab.
 *   - runConvertPptx(opts) — orchestrator: walk a fixture directory in
 *                                  parallel, build a pptx, run the shared
 *                                  postProcessPptx, and (unless noUpload)
 *                                  upload to Drive.
 */

import CDPraw from "chrome-remote-interface";
import { google } from "googleapis";
import type { CdpModule } from "../../types/cdp-types.ts";
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { Readable } from "stream";

import { extractorScript } from "./extractor-script.ts";
import { loadDevOAuthClient } from "./dev-google-auth.ts";
import { applyPostExtractionFixes, clampOversampling, rasterJobFor, type RasterJob, type TablesFormat } from "./post-extraction.ts";

import {
  buildEditableSvg,
  drawioFileName,
  drawioFolderSegments,
  ensureFolderPath,
  uploadDrawioSvg,
} from "./drawio-store.ts";
import {
  buildPptx,
  postProcessPptx,
  SLIDE_W_PX,
  SLIDE_H_PX,
  type Extraction,
  type SlideInput,
} from "./convert-pptx-lib.js";

// The Chrome DevTools port. HTML2SLIDES_CHROME_PORT lets a run use its own browser, so two
// conversions (or an agent and the container Chrome) never share one tab pool.
const CDP_PORT = Number(process.env.HTML2SLIDES_CHROME_PORT ?? "9222");

// chrome-remote-interface ships no .d.ts; its default export is declared
// `unknown` (types/ambient.d.ts). `CdpModule` is the shared, precise boundary
// type covering the connect-fn plus the runtime-attached New / Close / List
// static methods documented at
// https://github.com/cyrus-and/chrome-remote-interface#cdpnewoptions-callback
const CDP = CDPraw as CdpModule;

// Compile extract-dom.ts → JS once at module load (extractor-script.ts). The
// browser bundle inlines the same compiled string at build time via esbuild
// `define` and never touches this module.
const EXTRACT_JS = extractorScript();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- DOM Extraction ------------------------------------------------------
// `oversampling` is the rasterisation scale factor (deviceScaleFactor + the
// per-element capture scale). Defaults to 2 (retina); clamped to [1,8] so an
// unchanged caller and the default UI value both render byte-identically.
export async function extractFromHtml(
  htmlPath: string,
  tablesFormat: TablesFormat = "native",
  oversampling: number = 2,
): Promise<{ extraction: Extraction; visualPngs: Map<number, Buffer> }> {
  const scale = clampOversampling(oversampling);
  const absPath = resolve(htmlPath);
  const tab = await CDP.New({ port: CDP_PORT, url: `file://${absPath}` });
  // The tab MUST be closed even if extraction throws (socket hang up, font
  // timeout, …) — an orphaned tab per failed render is what leaked Chrome to
  // dozens of procs and started dropping WebSockets. So everything below runs in
  // a try/finally that always closes the client + tab.
  let client: Awaited<ReturnType<typeof CDP>> | null = null;
  try {
  client = await CDP({ target: tab, port: CDP_PORT });
  const { Page, Runtime, Emulation } = client;
  await Page.enable();
  await Runtime.enable();
  // Wait for the REAL page-load event, not a fixed sleep. The tab was opened
  // with the file:// URL, so `load` may have already fired before we connected
  // — check readyState first, else await the event (bounded, so a stuck page
  // can't hang forever).
  {
    const loaded = Page.loadEventFired();
    const rs = await Runtime.evaluate({ expression: "document.readyState", returnByValue: true });
    if (rs.result?.value !== "complete") await Promise.race([loaded, sleep(5000)]);
  }
  await Emulation.setDeviceMetricsOverride({ width: SLIDE_W_PX, height: SLIDE_H_PX, deviceScaleFactor: scale, mobile: false });
  // Asset-readiness gate — screenshot only once every asset the render depends
  // on has actually finished loading, never on a timer. Waits for: stylesheets,
  // every <img>, and every @font-face. `document.fonts.ready` can resolve
  // BEFORE a fonts.googleapis.com face registers (extraction would then measure
  // FALLBACK-font metrics — ~1px shorter line boxes, every block drifting up
  // cumulatively), so we ALSO poll fonts.check() per used family. Each wait is
  // individually bounded (setTimeout fallback) so one stuck asset can't hang the
  // render.
  await Runtime.evaluate({
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      const settle = (el) => new Promise(r => { el.addEventListener('load', r); el.addEventListener('error', r); setTimeout(r, 3000); });
      await Promise.all([...document.querySelectorAll('link[rel=stylesheet]')].map(l => l.sheet ? 0 : settle(l)));
      await Promise.all([...document.images].map(img => img.complete ? 0 : settle(img)));
      await Promise.all([...document.fonts].map(f => f.load().catch(() => {})));
      await document.fonts.ready;
      const fams = [...new Set([...document.querySelectorAll('*')].map(
        e => getComputedStyle(e).fontFamily.split(',')[0].replace(/["']/g, '').trim()).filter(Boolean))];
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !fams.every(f => document.fonts.check('16px "' + f + '"')))
        await new Promise(r => setTimeout(r, 50));
      return true;
    })()`,
  });

  const { result } = await Runtime.evaluate({ expression: EXTRACT_JS, returnByValue: true });
  if (typeof result.value !== "string") throw new Error("extract-dom did not return a JSON string");
  const extraction: Extraction = JSON.parse(result.value);

  // The shared post-extraction fixes (emoji text and baked tables become images).
  const retypedExtraction = applyPostExtractionFixes(extraction, { tablesFormat });

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
    const job = rasterJobFor(el);
    if (job === null) continue;
    const clip = { x: el.bounds.x, y: el.bounds.y, width: el.bounds.w, height: el.bounds.h, scale: RETINA_SCALE };
    // A `text-glow` visual is the halo of a glowing text-shadow ALONE: hide
    // everything else and make the glyph fill transparent, so the PNG holds
    // only the shadow over transparency and the native text paints on top.
    const glowId = glowIdOf(job);
    if (glowId !== undefined) {
      const sel = `[data-h2s-glow="${glowId}"]`;
      const css = `html,body{background:transparent !important}*,*::before,*::after{visibility:hidden !important}` +
        `${sel},${sel} *{visibility:visible !important;color:transparent !important;` +
        `-webkit-text-fill-color:transparent !important;background:transparent !important;border-color:transparent !important}`;
      await Runtime.evaluate({ expression: `(() => { const s = document.createElement("style"); s.id = "h2s-glow-capture"; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s); })()` });
      // `omitBackground` alone still returns an opaque white PNG here.
      await Emulation.setDefaultBackgroundColorOverride({ color: { r: 0, g: 0, b: 0, a: 0 } });
    }
    const ss = await Page.captureScreenshot({ format: "png", clip, captureBeyondViewport: true, omitBackground: true });
    if (glowId !== undefined) {
      await Runtime.evaluate({ expression: `document.getElementById("h2s-glow-capture")?.remove()` });
      await Emulation.setDefaultBackgroundColorOverride({});
    }
    visualPngs.set(i, Buffer.from(ss.data, "base64"));
  }

  return { extraction: retypedExtraction, visualPngs };
  } finally {
    try { if (client) await client.close(); } catch { /* */ }
    try { await CDP.Close({ port: CDP_PORT, id: tab.id }); } catch { /* */ }
  }
}

// --- Public API ----------------------------------------------------------

export interface ConvertPptxOpts {
  htmlDir: string;          // absolute or cwd-relative path; lib will resolve()
  title?: string;            // default "Presentation"
  outPath?: string | null;   // default null → /tmp/<sanitized-title>.pptx
  noUpload?: boolean;        // default false
  only?: string[] | null;    // list of basenames like ["slide_11.html", ...]; default null = all
  tablesFormat?: TablesFormat;       // default "native" (editable <a:tbl>, square corners);
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
  const tablesFormat: TablesFormat = opts.tablesFormat ?? "native";
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
  const { pres, renderedRegions, drawioDiagrams } = buildPptx(slideData as readonly SlideInput[], title);

  const pptxPath = outPath || `/tmp/${title.replace(/[^a-zA-Z0-9]/g, "_")}.pptx`;
  // The shared OOXML post-processing (convert-pptx-lib.ts postProcessPptx), the
  // same pipeline the product's buildPptxInMemory runs.
  writeFileSync(pptxPath, await postProcessPptx(pres));
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

  if (noUpload) {
    console.log("Done (no upload).");
    return { pptxPath, slideCount: htmlFiles.length, regionsPath };
  }

  // Step 3: Upload to Google Drive as Google Slides
  console.log("\nUploading to Google Slides...");
  const auth = loadDevOAuthClient({ persistRefreshedTokens: true });
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

  // Step 4 (Phase 1, drawio): upload each editable diagram source as a
  // `.drawio.svg` under drawio/slide/<presId>/ on Drive, then link the on-slide
  // image to it. The image is found by its alt-text description
  // (`drawio:<diagramId>`, set at build time — cNvPr descr survives the Slides
  // import where objectName does not). The link is a REAL image hyperlink via
  // updateImageProperties fields:"link"; the Drive webViewLink ends in the
  // fileId, so the editor detects editability by URL shape + resolves the file
  // by path. Strict no-op when the deck carries no drawio diagrams.
  if (presId && drawioDiagrams.length > 0) {
    console.log(`\nUploading ${drawioDiagrams.length} drawio diagram(s) to Drive...`);
    const slidesApi = google.slides({ version: "v1", auth });
    const folderId = await ensureFolderPath(driveApi, drawioFolderSegments("slide", presId));
    // Map altText (description) → image objectId from the imported deck.
    const presRes = await slidesApi.presentations.get({ presentationId: presId });
    const imageByDescr = new Map<string, string>();
    for (const page of presRes.data.slides ?? []) {
      for (const pe of page.pageElements ?? []) {
        if (pe.image && pe.description) imageByDescr.set(pe.description, pe.objectId!);
      }
    }
    for (const d of drawioDiagrams) {
      const svg = buildEditableSvg(d.xml, d.baseSvg);
      const { fileId, webViewLink } = await uploadDrawioSvg(driveApi, folderId, drawioFileName(d.diagramId), svg);
      const objectId = imageByDescr.get(d.altText);
      if (!objectId) {
        // The image MUST be present — a miss means the altText didn't survive
        // import (a converter bug), so fail loudly rather than silently
        // dropping the diagram's editability.
        throw new Error(`drawio: no imported image with description ${JSON.stringify(d.altText)} (diagram ${d.diagramId})`);
      }
      await slidesApi.presentations.batchUpdate({
        presentationId: presId,
        requestBody: {
          requests: [{
            updateImageProperties: {
              objectId,
              imageProperties: { link: { url: webViewLink } },
              fields: "link",
            },
          }],
        },
      });
      console.log(`  ${d.diagramId} → drive:${fileId} (linked image ${objectId})`);
    }
  }

  console.log("Done.");
  return { pptxPath, presId: presId ?? undefined, slideCount: htmlFiles.length, regionsPath };
}

// The glow id a capture isolates, or undefined for a capture of the region as painted.
function glowIdOf(job: RasterJob): number | undefined {
  switch (job.kind) {
    case "text-glow": return job.glowId;
    case "emoji":
    case "baked-table":
    case "element": return undefined;
    default: {
      const unhandled: never = job;
      throw new Error(`unhandled raster job ${JSON.stringify(unhandled)}`);
    }
  }
}
