#!/usr/bin/env npx tsx
/**
 * rating-server.ts — E2E rating website for html2slides fidelity
 *
 * Shows side-by-side: original HTML screenshot vs Google Slides screenshot.
 * Two buttons: Good (saves to regression snapshots) / Bad (triggers analysis).
 *
 * Usage: npx tsx rating-server.ts <results-dir> [--port 3456]
 *
 * Results dir should contain:
 *   slide_01_original.png, slide_01_slides.png, slide_02_original.png, ...
 * Or structured as:
 *   originals/slide_01.png, slides/slide_01.png
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, statSync, unlinkSync } from "fs";
import { join, resolve, dirname } from "path";
import { PNG } from "pngjs";

const args = process.argv.slice(2);
const resultsDir = resolve(args[0] || ".");
let port = 3456;
// Optional bug_solving / task-scoped flags. When any of these is set the UI
// stays functionally identical to the default rating flow (Good / Bad /
// Skip, draw canvas, diff overlay, etc.) and just gains two extra buttons
// per slide: "Show analysis" (renders the slide_id H2 section of the
// provided markdown) and "Show diff analysis" (renders the slide_id.diff
// + .summary.json from the provided directory).
let filterSlides: string[] | null = null;      // --filter-slides csv
let slidesDirOverride: string | null = null;    // --slides-dir path
let originalsDirOverride: string | null = null; // --originals-dir path
let taskAnalysisPath: string | null = null;     // --task-analysis md
let taskDiffsDir: string | null = null;         // --task-diffs dir
let taskTitle: string | null = null;            // --task-title str
let historyDir: string | null = null;           // --history-dir persistent ledger
for (let i = 0; i < args.length; i++) {
  const v = args[i];
  if (v === "--port") port = parseInt(args[++i]);
  else if (v === "--filter-slides") filterSlides = args[++i].split(",").map(s => s.trim());
  else if (v === "--slides-dir") slidesDirOverride = resolve(args[++i]);
  else if (v === "--originals-dir") originalsDirOverride = resolve(args[++i]);
  else if (v === "--task-analysis") taskAnalysisPath = resolve(args[++i]);
  else if (v === "--task-diffs") taskDiffsDir = resolve(args[++i]);
  else if (v === "--task-title") taskTitle = args[++i];
  else if (v === "--history-dir") historyDir = resolve(args[++i]);
}

// Render-parameter badge: surface which conversion mode produced these slides
// (e.g. tablesFormat=baked) so a reviewer never confuses a baked-table run
// with the default native one. Read from meta.json { renderParams?, tablesFormat? }.
let renderBadgeHtml = "";
try {
  const _metaPath = join(resultsDir, "meta.json");
  if (existsSync(_metaPath)) {
    const _meta = JSON.parse(readFileSync(_metaPath, "utf-8"));
    const _rp: Record<string, unknown> = { tablesFormat: _meta.tablesFormat, ...(_meta.renderParams || {}) };
    const parts = Object.entries(_rp)
      .filter(([, val]) => val != null && val !== "")
      .map(([k, val]) => {
        const cls = k === "tablesFormat" && val === "baked" ? "render-badge badge-baked" : "render-badge";
        return `<span class="${cls}">${k}: ${val}</span>`;
      });
    renderBadgeHtml = parts.join("");
  }
} catch { /* meta is optional */ }

interface RenderedRegion { x: number; y: number; w: number; h: number; kind: string; }
interface SlideComparison {
  id: string;
  originalPng: string;
  slidesPng: string;
  status: "pending" | "good" | "bad";
  comment?: string;
  analysis?: string;
  htmlFile?: string;
  slidesUrl?: string;
  // Round-1 provenance, populated from sxs-meta.json (written by the
  // bug_solving harness). These are what the USER originally saw/typed when
  // they rated the slide bad, surfaced per-card so a reviewer can always reach
  // the source HTML, the live presentation, the annotation they drew, and the
  // comment they wrote. All optional → older runs degrade gracefully.
  origComment?: string;        // the original user comment from round-1 rating
  origAnnotationPng?: string;  // absolute path (served via /img) to the round-1 annotation PNG
  diffPng?: string;        // /tmp/.../diffs/diff_slide_NN.png (pixelmatch output)
  diffStatus?: string;     // "ok" | "regressed" | "new" | "missing-current"
  diffPixels?: number;
  // Rasterized regions the converter emitted as addImage instead of native
  // primitives (visuals, images, emoji fallbacks). Surface these to the user
  // because any region in this list represents a fidelity compromise.
  renderedRegions?: RenderedRegion[];
  // Per-annotation zoom-crops: focused, nearest-neighbour-upscaled crops of
  // each marked region, one per side (original + test/slides), shown below the
  // slide so you can compare the exact spot you flagged at high zoom.
  zoomCrops?: string[];
}

// Zoom-crops live alongside the annotations under the results dir so they
// survive /tmp wipes the same way.
const zoomDir = join(resultsDir, "zoom-crops");

/**
 * Crop `srcPngBytes` to `bbox` (in annotation-canvas coords) and scale UP with
 * nearest-neighbour so the longest edge approaches `targetLongestEdge`. Zoom is
 * derived from the bbox size (small marks zoom more) and clamped to an integer
 * in [minZoom, maxZoom] so the upscale stays crisp. Returns PNG bytes.
 */
function zoomCropPng(
  srcPngBytes: Buffer,
  bbox: { x: number; y: number; w: number; h: number; canvasW: number; canvasH: number },
  targetLongestEdge = 1200,
  minZoom = 1,
  maxZoom = 10,
): Buffer {
  const src = PNG.sync.read(srcPngBytes);
  // The annotation canvas may differ in resolution from the source image;
  // scale the bbox into source coordinates.
  const sx = src.width / bbox.canvasW;
  const sy = src.height / bbox.canvasH;
  const cropX = Math.max(0, Math.round(bbox.x * sx));
  const cropY = Math.max(0, Math.round(bbox.y * sy));
  const cropW = Math.max(1, Math.min(src.width - cropX, Math.round(bbox.w * sx)));
  const cropH = Math.max(1, Math.min(src.height - cropY, Math.round(bbox.h * sy)));
  const longest = Math.max(cropW, cropH);
  const zoomRaw = Math.floor(targetLongestEdge / longest);
  const zoom = Math.max(minZoom, Math.min(maxZoom, zoomRaw || 1));
  const outW = cropW * zoom, outH = cropH * zoom;
  const out = new PNG({ width: outW, height: outH });
  for (let oy = 0; oy < outH; oy++) {
    const srcY = cropY + Math.floor(oy / zoom);
    for (let ox = 0; ox < outW; ox++) {
      const srcX = cropX + Math.floor(ox / zoom);
      const si = (srcY * src.width + srcX) * 4;
      const oi = (oy * outW + ox) * 4;
      out.data[oi] = src.data[si];
      out.data[oi + 1] = src.data[si + 1];
      out.data[oi + 2] = src.data[si + 2];
      out.data[oi + 3] = src.data[si + 3];
    }
  }
  return PNG.sync.write(out);
}

/** Fallback when no explicit shape list is sent: the bounding box of all
 *  non-transparent pixels in the flattened annotation PNG, padded. */
function annotationBbox(
  annotationPngBytes: Buffer,
  padding = 20,
  alphaThreshold = 8,
): { x: number; y: number; w: number; h: number; canvasW: number; canvasH: number } | null {
  const png = PNG.sync.read(annotationPngBytes);
  const W = png.width, H = png.height;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (png.data[(y * W + x) * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  const x = Math.max(0, minX - padding), y = Math.max(0, minY - padding);
  return { x, y, w: Math.min(W, maxX + padding) - x, h: Math.min(H, maxY + padding) - y, canvasW: W, canvasH: H };
}

/** List crop PNGs for a slide (`<id>.png` or `<id>-NN-side.png`), sorted. */
function listZoomCrops(dir: string, slideId: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f === `${slideId}.png` || f.startsWith(`${slideId}-`))
    .map(f => join(dir, f))
    .sort();
}

/** Crop original + test (slides) for each annotation shape (or the fallback
 *  bbox) and write them under zoomDir. Returns the list of written crop paths.
 *  Shapes are {x,y,w,h} in canvas coords; rect shapes are used as-is, others
 *  (pencil) get `padPx` padding. */
function generateZoomCrops(
  id: string, originalPng: string, slidesPng: string,
  annotBytes: Buffer,
  shapes: Array<{ kind?: string; x: number; y: number; w: number; h: number }> | null,
  canvasSize: { w: number; h: number } | null,
  padPx: number,
): string[] {
  // Clear stale crops for this slide first so a re-rate with fewer marks
  // doesn't leave orphans.
  if (existsSync(zoomDir)) {
    for (const f of readdirSync(zoomDir)) {
      if (f === `${id}.png` || f.startsWith(`${id}-`)) { try { unlinkSync(join(zoomDir, f)); } catch {} }
    }
  }
  mkdirSync(zoomDir, { recursive: true });
  const written: string[] = [];
  const writePair = (idx: number, bbox: { x: number; y: number; w: number; h: number; canvasW: number; canvasH: number }) => {
    const sides: Array<["original" | "rendered", string]> = [["original", originalPng], ["rendered", slidesPng]];
    for (const [side, srcPath] of sides) {
      if (!existsSync(srcPath)) continue;
      const outPath = join(zoomDir, `${id}-${String(idx).padStart(2, "0")}-${side}.png`);
      try { writeFileSync(outPath, zoomCropPng(readFileSync(srcPath), bbox)); written.push(outPath); } catch {}
    }
  };
  const canvasW = canvasSize?.w || 0, canvasH = canvasSize?.h || 0;
  if (shapes && shapes.length && canvasW > 0 && canvasH > 0) {
    shapes.forEach((sh, i) => {
      const pad = sh.kind === "rect" ? 0 : padPx;
      writePair(i + 1, {
        x: Math.max(0, sh.x - pad), y: Math.max(0, sh.y - pad),
        w: sh.w + pad * 2, h: sh.h + pad * 2, canvasW, canvasH,
      });
    });
  } else {
    // Fallback: one crop of the whole annotation bbox.
    const bb = annotationBbox(annotBytes, padPx, 8);
    if (bb) writePair(1, bb);
  }
  return written;
}

function findComparisons(): SlideComparison[] {
  const comparisons: SlideComparison[] = [];

  // Check for originals/ and slides/ subdirectories. --originals-dir /
  // --slides-dir overrides let a task-scoped server serve files that
  // live outside the standard results_dir layout (e.g. bug_solving
  // scratch dirs that keep rendered thumbnails in `thumbnails/` and
  // reuse the main originals at /tmp/sxs-complex/originals).
  const originalsDir = originalsDirOverride
    ?? (existsSync(join(resultsDir, "originals")) ? join(resultsDir, "originals") : resultsDir);
  const slidesDir = slidesDirOverride
    ?? (existsSync(join(resultsDir, "slides")) ? join(resultsDir, "slides") : resultsDir);

  // Pattern 1: originals/slide_01.png + slides/slide_01.png.
  // Guard existence: a stale/missing --originals-dir (e.g. a wiped /tmp path)
  // must degrade to "no comparisons", NOT crash the whole server on an
  // unguarded readdirSync inside the listen callback.
  if (originalsDir !== slidesDir && existsSync(originalsDir) && existsSync(slidesDir)) {
    const origFiles = readdirSync(originalsDir).filter(f => f.match(/slide_\d+.*\.png$/)).sort();
    for (const f of origFiles) {
      const slidesFile = join(slidesDir, f);
      if (existsSync(slidesFile)) {
        comparisons.push({
          id: f.replace(".png", ""),
          originalPng: join(originalsDir, f),
          slidesPng: slidesFile,
          status: "pending",
        });
      }
    }
  }

  // Pattern 2: slide_01_original.png + slide_01_slides.png
  const allFiles = existsSync(resultsDir)
    ? readdirSync(resultsDir).filter(f => f.endsWith("_original.png")).sort()
    : [];
  for (const f of allFiles) {
    const base = f.replace("_original.png", "");
    const slidesFile = join(resultsDir, `${base}_slides.png`);
    if (existsSync(slidesFile)) {
      comparisons.push({
        id: base,
        originalPng: join(resultsDir, f),
        slidesPng: slidesFile,
        status: "pending",
      });
    }
  }

  // Merge optional meta.json: { htmlDir, presentationId, slideIds? }
  const metaFile = join(resultsDir, "meta.json");
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
    const htmlFiles = meta.htmlDir && existsSync(meta.htmlDir)
      ? readdirSync(meta.htmlDir).filter((f: string) => f.endsWith(".html")).sort()
      : [];
    for (let i = 0; i < comparisons.length; i++) {
      const c = comparisons[i];
      // Match the HTML source by slide id first (robust to --filter-slides,
      // where comparisons[i] no longer lines up with htmlFiles[i]); fall back
      // to positional matching only when no id match exists.
      const byId = htmlFiles.find((f: string) => f.replace(/\.html$/, "") === c.id || f.startsWith(c.id + "."));
      const htmlName = byId ?? htmlFiles[i];
      if (htmlName) c.htmlFile = join(meta.htmlDir, htmlName);
      if (meta.presentationId) {
        // slideIds carry the per-slide object id for the #slide deep-link.
        const sid = meta.slideIds?.[c.id] ?? meta.slideIds?.[i];
        const slideFrag = sid ? `#slide=id.${sid}` : "";
        c.slidesUrl = `https://docs.google.com/presentation/d/${meta.presentationId}/edit${slideFrag}`;
      }
    }
  }

  // Merge sxs-meta.json sidecar (written by the bug_solving harness, main.ts
  // step 7). It carries the round-1 provenance for each slide so the SxS card
  // can show: source HTML, live presentation URL, the original annotation the
  // user drew, and the original comment they typed. Paths inside the sidecar
  // are relative to resultsDir (the harness COPIES the html + annotation into
  // resultsDir/source/ and resultsDir/orig-annotations/ so the existing static
  // routes — /html relative-to-resultsDir, /img by absolute path — can serve
  // them without exposing arbitrary absolute paths). Best-effort: a malformed
  // or absent sidecar leaves every field undefined (older runs degrade fine).
  const sxsMetaFile = join(resultsDir, "sxs-meta.json");
  if (existsSync(sxsMetaFile)) {
    try {
      const sxsMeta = JSON.parse(readFileSync(sxsMetaFile, "utf-8")) as Record<string, {
        html_file?: string;
        presentation_url?: string;
        original_comment?: string;
        original_annotation?: string;
        original_png?: string;
      }>;
      for (const c of comparisons) {
        const m = sxsMeta[c.id];
        if (!m) continue;
        // html_file is stored relative to resultsDir (e.g. "source/slide_11.html").
        if (m.html_file) {
          const abs = resolve(resultsDir, m.html_file);
          if (existsSync(abs)) c.htmlFile = abs;
        }
        if (m.presentation_url) c.slidesUrl = m.presentation_url;
        if (m.original_comment) c.origComment = m.original_comment;
        // original_annotation is stored relative to resultsDir
        // (e.g. "orig-annotations/slide_11.png"); /img serves it by absolute path.
        if (m.original_annotation) {
          const abs = resolve(resultsDir, m.original_annotation);
          if (existsSync(abs)) c.origAnnotationPng = abs;
        }
      }
    } catch (e) {
      console.error("sxs-meta.json present but unreadable:", (e as Error).message);
    }
  }

  // Merge regression report from goldens check: adds diff image path, diff
  // pixel count, and auto-marks unchanged slides as "good" so the default
  // view shows only slides that actually diverge from blessed goldens.
  const reportFile = join(resultsDir, "diffs", "regression-report.json");
  if (existsSync(reportFile)) {
    const report = JSON.parse(readFileSync(reportFile, "utf-8"));
    const byFile = new Map<string, any>();
    for (const r of (report.results || [])) byFile.set(r.file.replace(".png", ""), r);
    for (const c of comparisons) {
      const r = byFile.get(c.id);
      if (!r) continue;
      c.diffStatus = r.status;
      c.diffPixels = r.diffPixels || 0;
      if (r.diffPath && existsSync(r.diffPath)) c.diffPng = r.diffPath;
      // Auto-bless: a slide that matches its golden has no diff to rate.
      if (r.status === "ok") c.status = "good";
    }
  }

  // Merge rendered-regions sidecar emitted by convert-pptx.ts. Keys are
  // slide_NN and match the comparison id 1:1.
  const regionsFile = join(resultsDir, "rendered-regions.json");
  if (existsSync(regionsFile)) {
    try {
      const regions = JSON.parse(readFileSync(regionsFile, "utf-8")) as Record<string, RenderedRegion[]>;
      for (const c of comparisons) {
        const list = regions[c.id];
        if (list && list.length > 0) c.renderedRegions = list;
      }
    } catch {}
  }

  // Load existing ratings (user ratings override auto-blessing).
  const ratingsFile = join(resultsDir, "ratings.json");
  if (existsSync(ratingsFile)) {
    const ratings = JSON.parse(readFileSync(ratingsFile, "utf-8"));
    for (const c of comparisons) {
      if (ratings[c.id] && ratings[c.id].status) {
        c.status = ratings[c.id].status;
        c.comment = ratings[c.id].comment;
        c.analysis = ratings[c.id].analysis;
        if (ratings[c.id].htmlFile) c.htmlFile = ratings[c.id].htmlFile;
        if (ratings[c.id].slidesUrl) c.slidesUrl = ratings[c.id].slidesUrl;
        if (ratings[c.id].annotation && existsSync(ratings[c.id].annotation)) {
          (c as any).annotationPng = ratings[c.id].annotation;
        }
      }
    }
  }

  // Attach any per-annotation zoom-crops on disk (independent of ratings).
  for (const c of comparisons) {
    const crops = listZoomCrops(zoomDir, c.id);
    if (crops.length) (c as any).zoomCrops = crops;
  }

  // --filter-slides narrows the list to a specific set of slide IDs.
  // Used by bug_solving tasks to show only the cluster's slides.
  if (filterSlides && filterSlides.length) {
    const wanted = new Set(filterSlides);
    return comparisons.filter(c => wanted.has(c.id));
  }
  return comparisons;
}

function saveRating(id: string, status: "good" | "bad", comment?: string, annotationPng?: string): string | null {
  const ratingsFile = join(resultsDir, "ratings.json");
  const ratings = existsSync(ratingsFile) ? JSON.parse(readFileSync(ratingsFile, "utf-8")) : {};
  const entry: any = { status, comment, ratedAt: new Date().toISOString() };
  let savedAnnotPath: string | null = null;
  if (annotationPng) {
    // Annotations persist under resultsDir/annotations/ so /tmp wipes only
    // break the PNGs, not the metadata.
    const annotDir = join(resultsDir, "annotations");
    mkdirSync(annotDir, { recursive: true });
    const annotPath = join(annotDir, `${id}.png`);
    const b64 = annotationPng.replace(/^data:image\/png;base64,/, "");
    writeFileSync(annotPath, Buffer.from(b64, "base64"));
    entry.annotation = annotPath;
    savedAnnotPath = annotPath;
  }
  ratings[id] = entry;
  writeFileSync(ratingsFile, JSON.stringify(ratings, null, 2));

  // Mirror to persistent backup (survives /tmp wipes).
  const metaFile = join(resultsDir, "meta.json");
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
    if (meta.ratingsBackup) {
      try { writeFileSync(meta.ratingsBackup, JSON.stringify(ratings, null, 2)); } catch {}
    }
  }

  // Mirror to the persistent per-slide LEDGER (--history-dir). Keyed by slide_id
  // and OUTSIDE any worktree, so the comment + annotation survive worktree
  // cleanup and /tmp wipes — the next round reads them back to auto-populate the
  // provenance panel. Annotation PNG is copied into the ledger so it's not just
  // a dangling path into a deleted scratch dir.
  if (historyDir) {
    try {
      mkdirSync(historyDir, { recursive: true });
      const ledgerFile = join(historyDir, "ratings.json");
      const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf-8")) : {};
      const led: any = { status, comment, ratedAt: entry.ratedAt };
      if (savedAnnotPath) {
        const ledAnnotDir = join(historyDir, "annotations");
        mkdirSync(ledAnnotDir, { recursive: true });
        const ledAnnot = join(ledAnnotDir, `${id}.png`);
        copyFileSync(savedAnnotPath, ledAnnot);
        led.annotation = ledAnnot;
      } else if (ledger[id]?.annotation) {
        led.annotation = ledger[id].annotation; // keep last annotation if none redrawn
      }
      ledger[id] = led;
      writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
    } catch { /* ledger mirror is best-effort, never break a rating save */ }
  }

  if (status === "good") {
    // Keep a simple SxS archive pair
    const snapshotDir = join(resultsDir, "regression-snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    const comp = findComparisons().find(c => c.id === id);
    if (comp) {
      copyFileSync(comp.originalPng, join(snapshotDir, `${id}_original.png`));
      copyFileSync(comp.slidesPng, join(snapshotDir, `${id}_slides.png`));

      // Bless the blessed golden — THIS is the only sanctioned writer of the
      // goldens directory. We infer goldens dir from meta.json (htmlDir is
      // `fixtures-basic/`; goldens sit at the sibling `goldens/`).
      const metaFile = join(resultsDir, "meta.json");
      if (existsSync(metaFile)) {
        const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
        if (meta.htmlDir) {
          const goldensDir = meta.goldensDir || join(dirname(meta.htmlDir), "goldens");
          mkdirSync(goldensDir, { recursive: true });
          const srcBase = id.replace(/^slide_/, "slide_").split(".")[0];
          const srcPng = join(resultsDir, "slides", `${srcBase}.png`);
          if (existsSync(srcPng)) {
            copyFileSync(srcPng, join(goldensDir, `${srcBase}.png`));
            console.log(`  BLESSED ${srcBase} → ${goldensDir}`);
          }
        }
      }
    }
  }
  return savedAnnotPath;
}

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${taskTitle || "html2slides Rating"}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; }
  .header { padding: 16px 24px; background: #16213e; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header-right { display: flex; align-items: center; gap: 12px; }
  .render-badge { font-size: 12px; font-weight: 700; letter-spacing: 0.3px; padding: 4px 10px; border-radius: 999px; background: #2a3a5e; color: #9fb3d1; border: 1px solid #3a4a6e; }
  .render-badge.badge-baked { background: #14532d; color: #86efac; border-color: #166534; }
  .stats { font-size: 14px; color: #888; }
  .slide-pair { display: flex; gap: 4px; padding: 12px 24px; align-items: flex-start; flex-wrap: wrap; }
  .slide-pair .panel { width: 49%; position: relative; }
  .slide-pair .panel img { width: 100%; border: 2px solid #333; border-radius: 4px; display: block; }
  .slide-pair .panel.original img { border-color: #4a90d9; }
  .slide-pair .panel.slides img { border-color: #e94560; }
  .slide-pair .panel.diff img { border-color: #f1c40f; background: #111; }
  .slide-pair .panel.slides canvas { position: absolute; inset: 2px; width: calc(100% - 4px); height: calc(100% - 4px); cursor: crosshair; touch-action: none; border-radius: 4px; }
  .slide-pair .panel.slides canvas.rendered-overlay { pointer-events: none; mix-blend-mode: plus-lighter; cursor: default; }
  .slide-pair .panel.original .diff-overlay { position: absolute; inset: 2px; width: calc(100% - 4px); height: calc(100% - 4px); border-radius: 4px; pointer-events: none; }
  .slide-pair .panel.original canvas.diff-overlay { background: transparent; }
  /* Blink-comparator: tabs stack the two panels and flick between them in
     place (press f) so pixel-level shifts pop; toggle back to side-by-side. */
  .flip-tabs { display: flex; align-items: center; gap: 4px; padding: 8px 24px 0; }
  .flip-tab { font-size: 11px; padding: 3px 12px; border-radius: 4px 4px 0 0; border: 1px solid #2a3a5a; background: #16213e; color: #9fb3d0; cursor: pointer; text-transform: uppercase; letter-spacing: 0.5px; }
  .flip-tab:hover { background: #1d2d4f; color: #e0e0e0; }
  .flip-tab.active { background: #27ae60; color: #fff; border-color: #27ae60; font-weight: 600; }
  .flip-tab.toggle { border-radius: 4px; background: #0f1a30; margin-left: auto; }
  .flip-tab.toggle.active { background: #4a90d9; border-color: #4a90d9; color: #fff; }
  .slide-pair.flip { display: block; position: relative; }
  .slide-pair.flip .panel { width: 100%; position: absolute; inset: 0; opacity: 0; pointer-events: none; }
  .slide-pair.flip .panel.flip-active { position: relative; opacity: 1; pointer-events: auto; z-index: 1; }
  .draw-toolbar { display: flex; gap: 8px; padding: 0 24px; align-items: center; font-size: 12px; color: #aaa; }
  .draw-toolbar button { background: #2a2a4e; color: #e0e0e0; border: 1px solid #444; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .draw-toolbar button.active { background: #e94560; border-color: #e94560; color: white; }
  .draw-toolbar input[type=color] { width: 28px; height: 24px; border: 1px solid #444; border-radius: 4px; background: transparent; cursor: pointer; }
  .labels { display: flex; gap: 4px; padding: 0 24px; }
  .labels span { width: 49%; text-align: center; font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 1px; }
  .labels a { color: #4a90d9; text-decoration: none; font-weight: 600; }
  .labels a:hover { text-decoration: underline; }
  .actions { display: flex; gap: 12px; padding: 12px 24px; justify-content: center; }
  .btn { padding: 12px 36px; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; transition: 0.2s; }
  .btn-good { background: #27ae60; color: white; }
  .btn-good:hover { background: #2ecc71; }
  .btn-bad { background: #c0392b; color: white; }
  .btn-bad:hover { background: #e74c3c; }
  .btn-skip { background: #555; color: white; }
  .slide-id { text-align: center; padding: 8px; font-size: 14px; color: #888; }
  .slide-links { text-align: center; padding: 4px 24px; font-size: 13px; }
  .slide-links a { color: #4a90d9; text-decoration: none; margin: 0 12px; }
  .slide-links a:hover { text-decoration: underline; }
  .status-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-left: 8px; }
  .status-good { background: #27ae60; color: white; }
  .status-bad { background: #c0392b; color: white; }
  .status-pending { background: #555; color: #aaa; }
  .status-regressed { background: #e94560; color: white; animation: pulse 1.5s ease-in-out infinite; }
  .status-new { background: #8e44ad; color: white; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
  .nav a.diff-regressed { box-shadow: inset 0 -3px 0 #e94560; font-weight: 700; color: #ff6b81; }
  .nav a.diff-new { box-shadow: inset 0 -3px 0 #8e44ad; color: #c39bd3; }
  .nav a.diff-ok { opacity: 0.6; }
  .regression-banner { background: #2a0a14; border-left: 4px solid #e94560; color: #ffb8c4; padding: 10px 16px; margin: 12px 24px; border-radius: 0 6px 6px 0; font-size: 14px; font-weight: 600; }
  .rendered-banner { background: #2a1f0a; border-left: 4px solid #f1c40f; color: #ffe9a8; padding: 10px 16px; margin: 12px 24px; border-radius: 0 6px 6px 0; font-size: 14px; font-weight: 600; }
  .rendered-banner .kinds { font-weight: 400; color: #c9b57a; margin-left: 8px; font-size: 13px; }
  .nav { display: flex; gap: 8px; padding: 8px 24px; flex-wrap: wrap; }
  .nav a { color: #4a90d9; text-decoration: none; font-size: 12px; padding: 4px 8px; border-radius: 4px; }
  .nav a:hover { background: #2a2a4e; }
  .nav a.current { background: #4a90d9; color: white; }
  .analysis { margin: 12px 24px; padding: 12px; background: #2a2a4e; border-radius: 6px; font-size: 13px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
  .comment-box { margin: 12px 24px; display: flex; gap: 8px; }
  .comment-box textarea { flex: 1; padding: 10px 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a4e; color: #e0e0e0; font-family: inherit; font-size: 14px; resize: vertical; min-height: 40px; }
  .comment-box textarea::placeholder { color: #666; }
  .comment-box textarea:focus { outline: none; border-color: #4a90d9; }
  .saved-comment { margin: 4px 24px; padding: 8px 12px; background: #2a2a4e; border-left: 3px solid #e94560; border-radius: 0 6px 6px 0; font-size: 13px; color: #ccc; }
  .saved-comment .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .zoom-crops { margin: 8px 24px; padding: 10px 12px; background: #0e1f2e; border-left: 4px solid #3498db; border-radius: 0 6px 6px 0; }
  .zoom-crops-label { font-size: 13px; color: #cfe4f7; margin-bottom: 8px; }
  .zoom-crops-grid { display: flex; gap: 16px; flex-wrap: wrap; }
  .zoom-crop-pair { display: flex; gap: 8px; background: #050a0e; padding: 6px; border-radius: 4px; }
  .zoom-crop figure { margin: 0; }
  .zoom-crop figcaption { color: #7dafd5; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; text-align: center; }
  .zoom-crop img { display: block; max-width: 320px; max-height: 360px; image-rendering: pixelated; border: 1px solid #1f2933; }
  .orig-meta { margin: 8px 24px; padding: 10px 14px; background: #1f2a3a; border-left: 4px solid #7dafd5; border-radius: 0 6px 6px 0; }
  .orig-meta .om-title { font-size: 11px; color: #7dafd5; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
  .orig-meta .om-links { margin-bottom: 8px; font-size: 13px; }
  .orig-meta .om-links a { color: #4a90d9; text-decoration: none; margin-right: 16px; }
  .orig-meta .om-links a:hover { text-decoration: underline; }
  .orig-meta .om-body { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
  .orig-meta .om-annotation img { display: block; max-width: 360px; max-height: 280px; border: 1px solid #2f3b4d; border-radius: 4px; background: #050a0e; }
  .orig-meta .om-annotation figcaption, .orig-meta .om-comment .om-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .orig-meta .om-comment { flex: 1; min-width: 200px; font-size: 13px; color: #ddd; white-space: pre-wrap; word-break: break-word; }
  .orig-meta figure { margin: 0; }
</style>
</head>
<body>
<div class="header">
  <h1>${taskTitle || "html2slides Fidelity Rating"}</h1>
  <div class="header-right">${renderBadgeHtml}<div class="stats" id="stats"></div></div>
</div>
<div id="regressionBanner"></div>
<div id="renderedBanner"></div>
<div class="nav" id="nav"></div>
<div class="labels"><span id="labelOriginal">Original HTML</span><span id="labelSlides">Google Slides</span></div>
<div class="flip-tabs" id="flipTabs">
  <button class="flip-tab" id="flipOriginal" onclick="setFlipSide('left')" title="Show the original (target) full-size">Original</button>
  <button class="flip-tab" id="flipRendered" onclick="setFlipSide('right')" title="Show the Slides render full-size">Rendered</button>
  <button class="flip-tab toggle" id="flipToggle" onclick="toggleFlip()" title="Blink-flip (stacked, tab between) vs classic side-by-side. Press f to flick.">&#9635; Flip</button>
</div>
<div class="slide-pair" id="pair"></div>
<div class="draw-toolbar" id="drawToolbar">
  <label style="display:flex; gap:6px; align-items:center; cursor:pointer;">
    <input type="checkbox" id="showDiff" onchange="toggleShowDiff()"> Show diff at full size (hide small diff panel)
  </label>
  <span style="width: 24px;"></span>
  <label style="display:flex; gap:6px; align-items:center; cursor:pointer;" title="Brightens rasterized regions on the Slides render by adding 128 to all RGB channels (via plus-lighter blend)">
    <input type="checkbox" id="showRendered" onchange="toggleShowRendered()"> Highlight rendered regions (+128 channels)
  </label>
  <span style="width: 24px;"></span>
  <span>Draw on Slides render:</span>
  <button id="drawToggle" onclick="toggleDraw()">Draw</button>
  <button id="toolPen" class="active" onclick="setTool('pen')" title="Freehand pen">&#9998; Pen</button>
  <button id="toolRect" onclick="setTool('rect')" title="Drag to draw a rectangle">&#9645; Rect</button>
  <input type="color" id="drawColor" value="#e94560">
  <label><input type="range" id="drawSize" min="2" max="20" value="6"> px</label>
  <button onclick="clearDraw()">Clear</button>
  <span style="width: 24px;"></span>
  <label style="display:flex; gap:6px; align-items:center; cursor:pointer;" title="Hover over either image to magnify the region under the cursor"><input type="checkbox" id="loupeToggle" onchange="toggleLoupe()"> Magnifier</label>
  <label style="display:flex; gap:4px; align-items:center;" title="Magnifier zoom level"><input type="range" id="loupeZoomCtl" min="2" max="10" value="3" style="width:70px;"> zoom</label>
</div>
<!-- Magnifier loupe: a fixed-position lens that follows the cursor and shows a
     zoomed background-image of the image underneath. -->
<div id="loupe" style="display:none; position:fixed; pointer-events:none; border:2px solid #e94560; border-radius:50%; box-shadow:0 0 0 1px rgba(0,0,0,.6), 0 4px 16px rgba(0,0,0,.5); z-index:2000; background-repeat:no-repeat;"></div>
<div class="slide-id" id="slideId"></div>
<div class="slide-links" id="slideLinks"></div>
<!-- Round-1 provenance panel: original source HTML link, live presentation
     link, the original annotation the user drew, and the original comment they
     typed. Populated from sxs-meta.json; hidden entirely when no provenance
     exists for the current slide (older runs). -->
<div id="origMeta"></div>
<div class="comment-box">
  <textarea id="comment" placeholder="What's wrong? (optional — saved with Bad ratings)" rows="2"></textarea>
</div>
<div class="actions">
  <button class="btn btn-good" onclick="rate('good')">Good ✓</button>
  <button class="btn btn-bad" onclick="rate('bad')">Bad ✗</button>
  <button class="btn btn-skip" onclick="navigate(1)">Skip →</button>
</div>
<!-- bug_solving task-scoped reveal buttons. Hidden unless the server was
     started with --task-analysis / --task-diffs. Each button toggles a
     panel with the slide-specific section (analysis.md H2 per slide,
     diffs/<slide_id>.diff + summary.json). -->
<div id="taskReveals" style="display:none; padding: 8px 24px; gap: 10px; justify-content: center;">
  <button class="btn btn-skip" id="showAnalysisBtn" style="background:#e67e22" onclick="toggleTaskPanel('analysis')">Show analysis</button>
  <button class="btn btn-skip" id="showDiffAnalysisBtn" style="background:#f1c40f; color:#1a1a2e" onclick="toggleTaskPanel('diff')">Show diff analysis</button>
</div>
<div id="taskAnalysisPanel" style="display:none; margin: 8px 24px; padding: 12px; background: #2a1f0a; border-left: 4px solid #e67e22; border-radius: 0 6px 6px 0;"><pre id="taskAnalysisBody" style="white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, monospace; font-size: 12px; color: #ffe9a8; max-height: 400px; overflow-y: auto;">loading…</pre></div>
<div id="taskDiffPanel" style="display:none; margin: 8px 24px; padding: 12px; background: #2a2a0a; border-left: 4px solid #f1c40f; border-radius: 0 6px 6px 0;"><pre id="taskDiffBody" style="white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, monospace; font-size: 12px; color: #f5e49d; max-height: 400px; overflow-y: auto;">loading…</pre></div>
<div id="savedComment"></div>
<div id="zoomCrops"></div>
<div class="analysis" id="analysis" style="display:none"></div>
<div id="goldenReport" style="margin: 24px; padding: 12px 16px; background: #0f1a30; border-left: 4px solid #f1c40f; border-radius: 0 6px 6px 0; font-size: 13px; color: #ccc; font-family: ui-monospace, monospace;"></div>

<script>
const TASK_SCOPED = ${taskAnalysisPath || taskDiffsDir ? "true" : "false"};
let comparisons = [];
let currentIdx = 0;

/** Toggle one of the two task-scoped reveal panels. When opening, fetch
 *  the slide-specific payload from the server; when closing, just hide.
 *  The buttons are only visible if the server was started in task mode. */
async function toggleTaskPanel(kind) {
  const c = comparisons[currentIdx];
  if (!c) return;
  const panel = document.getElementById(kind === 'analysis' ? 'taskAnalysisPanel' : 'taskDiffPanel');
  const body = document.getElementById(kind === 'analysis' ? 'taskAnalysisBody' : 'taskDiffBody');
  const btn = document.getElementById(kind === 'analysis' ? 'showAnalysisBtn' : 'showDiffAnalysisBtn');
  const opening = panel.style.display === 'none';
  panel.style.display = opening ? 'block' : 'none';
  btn.classList.toggle('active', opening);
  if (opening) {
    body.textContent = 'loading…';
    const endpoint = kind === 'analysis' ? '/api/task-analysis' : '/api/task-diff';
    const r = await fetch(endpoint + '?slide=' + encodeURIComponent(c.id));
    body.textContent = await r.text();
  }
}

let showAll = false;
function visibleComparisons() {
  // By default, hide slides that match their blessed golden (status=good +
  // diffStatus=ok). Show everything else: regressed, new fixtures, bad, pending.
  if (showAll) return comparisons;
  return comparisons.filter(c =>
    c.status !== 'good' ||
    (c.diffStatus && c.diffStatus !== 'ok')
  );
}

function humanizeAge(ms) {
  if (ms == null) return 'never';
  const s = Math.round(ms/1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s/60) + 'm ago';
  if (s < 86400) return (s/3600).toFixed(1) + 'h ago';
  return (s/86400).toFixed(1) + 'd ago';
}
async function refreshReport() {
  const r = await fetch('/api/summary').then(r => r.json());
  const age = r.oldestRenderMs != null ? humanizeAge(r.nowMs - r.oldestRenderMs) : 'no render yet';
  document.getElementById('goldenReport').innerHTML =
    '<b>Goldens report</b> — ' +
    r.matching + '/' + r.goldenTotal + ' goldens still pixel-match current render' +
    (r.regressed ? ' · <span style="color:#e94560">' + r.regressed + ' regressed</span>' : '') +
    (r.new ? ' · <span style="color:#8e44ad">' + r.new + ' new (never blessed)</span>' : '') +
    ' · oldest current-render thumbnail: ' + age + ' (proves re-scrape)';
}
async function load() {
  const resp = await fetch('/api/comparisons');
  comparisons = await resp.json();
  refreshReport();
  const visible = visibleComparisons();
  const pendingIdx = visible.findIndex(c => c.status === 'pending');
  const firstVisibleId = (visible[pendingIdx >= 0 ? pendingIdx : 0] || {}).id;
  currentIdx = comparisons.findIndex(c => c.id === firstVisibleId);
  if (currentIdx < 0) currentIdx = 0;
  render();
}

function render() {
  const c = comparisons[currentIdx];
  if (!c) return;

  // Always two panels: Original · Slides. When "Show diff" is checked we
  // compute the diff IN THE BROWSER between the exact two <img>s on screen
  // (after they've both been downscaled to the panel size) and paint it to
  // a canvas overlay on the original. That way the diff is guaranteed to be
  // the difference between what the user actually sees — no server-side
  // downscaling, no blur, no threshold mystery.
  const diffOverlay = (showDiff && c.slidesPng)
    ? '<canvas class="diff-overlay" id="diffCanvas"></canvas>'
    : '';
  const renderedOverlayHtml = (c.renderedRegions && c.renderedRegions.length)
    ? '<canvas class="rendered-overlay" id="renderedOverlay"></canvas>'
    : '';
  const pairHtml =
    '<div class="panel original"><img id="originalImg" src="/img?path=' + encodeURIComponent(c.originalPng) + '">' + diffOverlay + '</div>' +
    '<div class="panel slides"><img id="slidesImg" src="/img?path=' + encodeURIComponent(c.slidesPng) + '">' + renderedOverlayHtml + '<canvas id="drawCanvas"></canvas></div>';
  document.getElementById('pair').innerHTML = pairHtml;
  setupDrawCanvas(c.annotationPng);
  applyFlip(); // re-apply blink-comparator state to the freshly-rebuilt panels
  if (showDiff) computeClientSideDiff();
  paintRenderedOverlay(c);

  const badge = '<span class="status-badge status-' + c.status + '">' + c.status + '</span>';
  let diffBadge = '';
  if (c.diffStatus) {
    const diffClass = c.diffStatus === 'ok' ? 'good' : c.diffStatus;
    diffBadge = '<span class="status-badge status-' + diffClass + '">⚠ ' + c.diffStatus.toUpperCase() + (c.diffPixels ? ' · ' + c.diffPixels + 'px' : '') + '</span>';
  }
  // Top regression banner — makes the "this is a golden that regressed" state
  // impossible to miss (e.g. slide_10 was good, now differs from its golden).
  const banner = c.diffStatus === 'regressed'
    ? '<div class="regression-banner">⚠ REGRESSION — this slide was previously blessed as a golden but now diverges from it by ' + (c.diffPixels || 0) + ' pixels. Check the yellow diff panel on the right.</div>'
    : '';
  const bannerEl = document.getElementById('regressionBanner');
  if (bannerEl) bannerEl.innerHTML = banner;

  // Rendered-regions warning — fires whenever the converter fell back to a
  // rasterized image instead of native Slides primitives. Non-empty means
  // this slide isn't 100% native; reviewer can toggle the highlight overlay
  // to see exactly where.
  const rbEl = document.getElementById('renderedBanner');
  if (rbEl) {
    if (c.renderedRegions && c.renderedRegions.length) {
      const kinds = {};
      for (const r of c.renderedRegions) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
      const kindStr = Object.keys(kinds).map(k => k + '×' + kinds[k]).join(', ');
      rbEl.innerHTML = '<div class="rendered-banner">⚠ RENDERED CONTENT — ' + c.renderedRegions.length + ' region(s) emitted as rasterized image(s) instead of native Slides primitives.<span class="kinds">(' + kindStr + ') — toggle "Highlight rendered regions" to see them.</span></div>';
    } else {
      rbEl.innerHTML = '';
    }
  }
  const visible = visibleComparisons();
  const visIdx = visible.findIndex(x => x.id === c.id);
  document.getElementById('slideId').innerHTML = c.id + badge + diffBadge + ' (' + (visIdx >= 0 ? visIdx+1 : '-') + '/' + visible.length + ' visible, ' + comparisons.length + ' total — ' + (showAll ? '<a href="#" onclick="showAll=false; render(); return false">only diffs</a>' : '<a href="#" onclick="showAll=true; render(); return false">show all</a>') + ')';

  // Column headers double as links: "Original HTML" → the source fixture,
  // "Google Slides" → the live presentation. Placed at the TOP, above each
  // panel, instead of a separate strip at the bottom.
  const lo = document.getElementById('labelOriginal');
  const ls = document.getElementById('labelSlides');
  if (lo) lo.innerHTML = c.htmlFile
    ? '<a href="/html?path=' + encodeURIComponent(c.htmlFile) + '" target="_blank">Original HTML ↗</a>'
    : 'Original HTML';
  if (ls) ls.innerHTML = c.slidesUrl
    ? '<a href="' + c.slidesUrl + '" target="_blank">Google Slides ↗</a>'
    : 'Google Slides';
  document.getElementById('slideLinks').innerHTML = ''; // links now live in the top labels

  // Stats
  const good = comparisons.filter(c => c.status === 'good').length;
  const bad = comparisons.filter(c => c.status === 'bad').length;
  const pending = comparisons.filter(c => c.status === 'pending').length;
  document.getElementById('stats').textContent = good + ' good / ' + bad + ' bad / ' + pending + ' pending';

  // Nav — only visible comparisons, mapped back to their real index
  document.getElementById('nav').innerHTML = visible.map(c => {
    const i = comparisons.findIndex(x => x.id === c.id);
    const cls = (i === currentIdx ? 'current ' : '') + 'status-' + c.status + ' diff-' + (c.diffStatus || 'none');
    return '<a href="#" class="' + cls + '" onclick="currentIdx=' + i + '; render(); return false;">' + c.id.replace('slide_', 'S') + '</a>';
  }).join('');

  // Analysis
  const analysisEl = document.getElementById('analysis');
  if (c.analysis) { analysisEl.style.display = 'block'; analysisEl.textContent = c.analysis; }
  else { analysisEl.style.display = 'none'; }

  // Saved comment
  const savedEl = document.getElementById('savedComment');
  if (c.comment) {
    savedEl.innerHTML = '<div class="saved-comment"><div class="label">Comment</div>' + c.comment.replace(/</g, '&lt;') + '</div>';
  } else {
    savedEl.innerHTML = '';
  }

  // Round-1 provenance panel: original source HTML, live presentation, the
  // annotation the user drew, and the comment they typed when they rated the
  // slide bad. Each piece is rendered only if present, and the whole panel is
  // hidden when none exist (older runs without sxs-meta.json).
  const omEl = document.getElementById('origMeta');
  if (omEl) {
    const parts = [];
    const links = [];
    if (c.htmlFile) links.push('<a href="/html?path=' + encodeURIComponent(c.htmlFile) + '" target="_blank">Original source HTML ↗</a>');
    if (c.slidesUrl) links.push('<a href="' + c.slidesUrl + '" target="_blank">Open rendered presentation in Slides ↗</a>');
    if (links.length) parts.push('<div class="om-links">' + links.join('') + '</div>');
    const body = [];
    if (c.origAnnotationPng) {
      body.push('<div class="om-annotation"><figure><figcaption>Original annotation</figcaption><img src="/img?path=' + encodeURIComponent(c.origAnnotationPng) + '"></figure></div>');
    }
    if (c.origComment) {
      body.push('<div class="om-comment"><div class="om-label">Original comment</div>' + c.origComment.replace(/</g, '&lt;') + '</div>');
    }
    if (body.length) parts.push('<div class="om-body">' + body.join('') + '</div>');
    if (parts.length) {
      omEl.innerHTML = '<div class="orig-meta"><div class="om-title">Round-1 provenance</div>' + parts.join('') + '</div>';
    } else {
      omEl.innerHTML = '';
    }
  }

  // Per-annotation zoom-crops: original (target) vs test (Slides) for each
  // marked region, grouped by region index from the filename <id>-NN-side.png.
  const zcEl = document.getElementById('zoomCrops');
  if (c.zoomCrops && c.zoomCrops.length) {
    const groups = {};
    for (const p of c.zoomCrops) {
      const m = p.match(/-(\\d+)-(original|rendered)\\.png$/);
      const key = m ? m[1] : '00';
      const side = m ? m[2] : 'crop';
      (groups[key] = groups[key] || {})[side] = p;
    }
    const keys = Object.keys(groups).sort();
    let html = '<div class="zoom-crops"><div class="zoom-crops-label">🔍 Marked regions — original (target) vs test (Slides render), ' + keys.length + ' region(s):</div><div class="zoom-crops-grid">';
    for (const k of keys) {
      const g = groups[k];
      html += '<div class="zoom-crop-pair">';
      [['original', 'original (target)'], ['rendered', 'test (slides)']].forEach(function(pair) {
        if (g[pair[0]]) {
          html += '<div class="zoom-crop"><figure><figcaption>' + pair[1] + '</figcaption><img src="/img?path=' + encodeURIComponent(g[pair[0]]) + '&t=' + Date.now() + '"></figure></div>';
        }
      });
      html += '</div>';
    }
    html += '</div></div>';
    zcEl.innerHTML = html;
  } else {
    zcEl.innerHTML = '';
  }

  // Pre-fill the comment box: this round's saved comment if any, otherwise the
  // prior round's comment (origComment) so the reviewer edits it in place rather
  // than retyping. Falls back to empty for a never-commented slide.
  document.getElementById('comment').value = c.comment || c.origComment || '';

  // Task-scoped reveal buttons: shown when --task-analysis or --task-diffs
  // was configured. Buttons reset to collapsed state on every slide change
  // so stale content from the previous slide doesn't flash.
  if (TASK_SCOPED) {
    document.getElementById('taskReveals').style.display = 'flex';
    document.getElementById('taskAnalysisPanel').style.display = 'none';
    document.getElementById('taskDiffPanel').style.display = 'none';
    document.getElementById('showAnalysisBtn').classList.remove('active');
    document.getElementById('showDiffAnalysisBtn').classList.remove('active');
  }
}

async function rate(status) {
  const c = comparisons[currentIdx];
  const comment = document.getElementById('comment').value.trim();
  // Export annotation canvas if anything was drawn.
  let annotation, shapes, canvasSize;
  const canvas = document.getElementById('drawCanvas');
  if (canvas && canvasHasStrokes) {
    annotation = canvas.toDataURL('image/png');
    // Send the committed shapes (canvas coords) so the server can crop each
    // marked region into an original|test pair. Empty when the annotation was
    // loaded from disk rather than drawn this session → server falls back to
    // the whole-annotation bbox.
    shapes = drawShapes.slice();
    canvasSize = { w: canvas.width, h: canvas.height };
  }
  const resp = await fetch('/api/rate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.id, status, comment: comment || undefined, annotation, shapes, canvasSize, pencilPadding: 24 }),
  });
  const result = await resp.json().catch(() => ({}));
  c.status = status;
  c.comment = comment || undefined;
  if (result && Array.isArray(result.zoomCrops)) c.zoomCrops = result.zoomCrops.length ? result.zoomCrops : undefined;
  // Persist the saved annotation path back onto the in-memory comparison so the
  // re-render below (navigate → render → setupDrawCanvas) RELOADS the strokes
  // instead of showing a blank canvas. Without this, rating "bad" wiped the
  // drawing on single-slide sets (navigate stays on the same slide).
  if (result && result.annotationPath) c.annotationPng = result.annotationPath;
  navigate(1);
}

// --- Draw overlay on Slides render ---
let drawMode = false;
let drawTool = 'pen'; // 'pen' (freehand) | 'rect' (drag rectangle)
function setTool(t) {
  drawTool = t;
  document.getElementById('toolPen').classList.toggle('active', t === 'pen');
  document.getElementById('toolRect').classList.toggle('active', t === 'rect');
}

// --- Blink-comparator flip ---
let flipMode = false;   // false = side-by-side (DEFAULT); true = stacked/tabbed (flick between).
                        // SxS shows both panels — incl. the rendered panel's annotation canvas.
let flipSide = 'left';  // 'left' = original (target), 'right' = rendered (Slides)
function applyFlip() {
  const pair = document.getElementById('pair');
  if (!pair) return;
  pair.classList.toggle('flip', flipMode);
  const orig = pair.querySelector('.panel.original');
  const slides = pair.querySelector('.panel.slides');
  if (orig) orig.classList.toggle('flip-active', flipMode && flipSide === 'left');
  if (slides) slides.classList.toggle('flip-active', flipMode && flipSide === 'right');
  const set = (id, on) => { const e = document.getElementById(id); if (e) e.classList.toggle('active', on); };
  set('flipOriginal', flipMode && flipSide === 'left');
  set('flipRendered', flipMode && flipSide === 'right');
  set('flipToggle', !flipMode);
  const t = document.getElementById('flipToggle');
  if (t) t.innerHTML = flipMode ? '&#9635; Flip' : '&#8644; Side-by-side';
}
function setFlipSide(side) { flipMode = true; flipSide = side; applyFlip(); }
function toggleFlip() { flipMode = !flipMode; applyFlip(); }
function flickFlip() { if (flipMode) { flipSide = flipSide === 'left' ? 'right' : 'left'; applyFlip(); } }
let canvasHasStrokes = false;
let drawHistory = []; // stack of ImageData snapshots, one per completed stroke
let drawShapes = []; // committed annotation shapes (canvas coords) for per-region zoom-crops
// Cached PNG of the draw canvas, composited into the magnifier so the loupe
// shows your strokes over the Slides render (not just the bare image).
// Refreshed whenever the drawing changes.
let drawCanvasDataUrl = null;
function refreshDrawCache() {
  const c = document.getElementById('drawCanvas');
  drawCanvasDataUrl = (c && canvasHasStrokes) ? c.toDataURL('image/png') : null;
}
function undoDraw() {
  const canvas = document.getElementById('drawCanvas');
  if (!canvas || drawHistory.length === 0) return;
  const ctx = canvas.getContext('2d');
  const prev = drawHistory.pop();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (prev) ctx.putImageData(prev, 0, 0);
  canvasHasStrokes = drawHistory.length > 0 || !!prev;
  drawShapes.pop();
  refreshDrawCache();
}
let showDiff = false;
function toggleShowDiff() {
  showDiff = document.getElementById('showDiff').checked;
  // Toggle the diff overlay IN PLACE. A full render() would rebuild the #pair
  // innerHTML — which destroys the draw canvas (losing in-progress
  // annotations) and reset the comment box to the last-SAVED value (losing
  // unsaved text). The diff canvas lives on the ORIGINAL panel and is
  // independent of the draw canvas (SLIDES panel) and the comment box, so we
  // add/remove just it and leave unsaved work intact.
  const c = comparisons[currentIdx];
  const origPanel = document.querySelector('#pair .panel.original');
  if (!origPanel || !c) return;
  let canvas = document.getElementById('diffCanvas');
  if (showDiff && c.slidesPng) {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.id = 'diffCanvas';
      canvas.className = 'diff-overlay';
      origPanel.appendChild(canvas);
    }
    computeClientSideDiff();
  } else if (canvas) {
    canvas.remove();
  }
}
let showRendered = false;
function toggleShowRendered() {
  showRendered = document.getElementById('showRendered').checked;
  paintRenderedOverlay(comparisons[currentIdx]);
}

// Paint the rendered-region highlight overlay on the Slides panel. Each
// region is filled with rgb(128,128,128); combined with the canvas's
// mix-blend-mode:plus-lighter this literally adds 128 to each channel of the
// image below (clamped to 255). A transparent canvas when the checkbox is
// off makes the panel render exactly as before.
function paintRenderedOverlay(c) {
  const canvas = document.getElementById('renderedOverlay');
  if (!canvas) return;
  const img = document.getElementById('slidesImg');
  const init = () => {
    canvas.width = img.naturalWidth || img.clientWidth;
    canvas.height = img.naturalHeight || img.clientHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!showRendered || !c || !c.renderedRegions) return;
    ctx.fillStyle = 'rgb(128,128,128)';
    for (const r of c.renderedRegions) {
      ctx.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
    }
  };
  if (img && img.complete && img.naturalWidth) init();
  else if (img) img.addEventListener('load', init, { once: true });
}

// Compute a per-pixel diff in the browser between the two <img>s currently
// visible (left panel original, right panel slides). Writes red pixels to the
// overlay canvas wherever the two images differ by more than THRESHOLD. Both
// images are downscaled to a common WORK_W x WORK_H grid so different source
// resolutions (original = 2560x1440, slides thumb = 1600x900) line up 1:1
// before comparison — that's the "two pictures on screen" alignment.
function computeClientSideDiff() {
  const origImg = document.getElementById('originalImg');
  const slidesImg = document.getElementById('slidesImg');
  const out = document.getElementById('diffCanvas');
  if (!origImg || !slidesImg || !out) return;
  const wait = (img) => new Promise(r => {
    if (img.complete && img.naturalWidth) r();
    else img.addEventListener('load', () => r(), { once: true });
  });
  Promise.all([wait(origImg), wait(slidesImg)]).then(() => {
    const WORK_W = 1600, WORK_H = 900;
    const THRESHOLD = 10; // per-channel L1 sum; tuned for font-hinting noise
    const a = document.createElement('canvas');
    a.width = WORK_W; a.height = WORK_H;
    const actx = a.getContext('2d');
    actx.drawImage(origImg, 0, 0, WORK_W, WORK_H);
    const aData = actx.getImageData(0, 0, WORK_W, WORK_H).data;

    const b = document.createElement('canvas');
    b.width = WORK_W; b.height = WORK_H;
    const bctx = b.getContext('2d');
    bctx.drawImage(slidesImg, 0, 0, WORK_W, WORK_H);
    const bData = bctx.getImageData(0, 0, WORK_W, WORK_H).data;

    out.width = WORK_W; out.height = WORK_H;
    const octx = out.getContext('2d');
    const diffImg = octx.createImageData(WORK_W, WORK_H);
    const dData = diffImg.data;
    let count = 0;
    for (let i = 0; i < aData.length; i += 4) {
      const dr = Math.abs(aData[i] - bData[i]);
      const dg = Math.abs(aData[i + 1] - bData[i + 1]);
      const db = Math.abs(aData[i + 2] - bData[i + 2]);
      if (dr + dg + db > THRESHOLD) {
        dData[i] = 255; dData[i + 1] = 0; dData[i + 2] = 0; dData[i + 3] = 200;
        count++;
      }
      // else leave as rgba(0,0,0,0) — fully transparent
    }
    octx.putImageData(diffImg, 0, 0);
    console.log('client diff: ' + count + ' pixels');
  });
}
function toggleDraw() {
  drawMode = !drawMode;
  document.getElementById('drawToggle').classList.toggle('active', drawMode);
  const canvas = document.getElementById('drawCanvas');
  if (canvas) canvas.style.pointerEvents = drawMode ? 'auto' : 'none';
}
function clearDraw() {
  const canvas = document.getElementById('drawCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvasHasStrokes = false;
  drawHistory = [];
  drawShapes = [];
  refreshDrawCache();
}
function setupDrawCanvas(annotationPath) {
  const img = document.getElementById('slidesImg');
  const canvas = document.getElementById('drawCanvas');
  if (!img || !canvas) return;
  canvas.style.pointerEvents = drawMode ? 'auto' : 'none';
  document.getElementById('drawToggle').classList.toggle('active', drawMode);
  canvasHasStrokes = false;
  drawHistory = [];
  drawShapes = [];
  const init = () => {
    canvas.width = img.naturalWidth || img.clientWidth;
    canvas.height = img.naturalHeight || img.clientHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (annotationPath) {
      const saved = new Image();
      saved.onload = () => { ctx.drawImage(saved, 0, 0, canvas.width, canvas.height); canvasHasStrokes = true; refreshDrawCache(); };
      saved.src = '/img?path=' + encodeURIComponent(annotationPath) + '&t=' + Date.now();
    }
  };
  if (img.complete && img.naturalWidth) init();
  else img.onload = init;

  let drawing = false;
  let rectStart = null;     // {x,y} where a rect drag began
  let rectSnapshot = null;  // canvas state before the rect, restored each move for live preview
  let lastPos = null;       // most recent pointer pos (rect end + pencil tracking)
  let penBbox = null;       // accumulated bbox of the current pencil stroke
  const getPos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
  };
  canvas.onpointerdown = (e) => {
    if (!drawMode) return;
    drawing = true; canvas.setPointerCapture(e.pointerId);
    const ctx = canvas.getContext('2d');
    // Snapshot current canvas BEFORE this stroke so Ctrl+Z can revert to it.
    // Cap history at 50 entries to bound memory.
    const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
    drawHistory.push(snap);
    if (drawHistory.length > 50) drawHistory.shift();
    ctx.strokeStyle = document.getElementById('drawColor').value;
    ctx.lineWidth = parseFloat(document.getElementById('drawSize').value) * (canvas.width / canvas.getBoundingClientRect().width);
    const p = getPos(e); lastPos = p;
    if (drawTool === 'rect') {
      // Defer drawing to pointermove; keep the pre-rect image to redraw against.
      rectStart = p; rectSnapshot = snap;
    } else {
      penBbox = { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
    }
  };
  canvas.onpointermove = (e) => {
    if (!drawing) return;
    const ctx = canvas.getContext('2d');
    const p = getPos(e); lastPos = p;
    if (drawTool === 'rect') {
      // Live preview: restore the pre-rect snapshot, then stroke the current box.
      ctx.putImageData(rectSnapshot, 0, 0);
      ctx.strokeRect(rectStart.x, rectStart.y, p.x - rectStart.x, p.y - rectStart.y);
    } else {
      if (penBbox) { penBbox.minX = Math.min(penBbox.minX, p.x); penBbox.minY = Math.min(penBbox.minY, p.y); penBbox.maxX = Math.max(penBbox.maxX, p.x); penBbox.maxY = Math.max(penBbox.maxY, p.y); }
      ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    canvasHasStrokes = true;
  };
  const endStroke = () => {
    if (drawing) {
      // Commit this stroke's region (canvas coords) so the server can crop it.
      // Rect → the box; pencil → the stroke's bounding box (padded server-side).
      if (drawTool === 'rect' && rectStart && lastPos) {
        const x = Math.min(rectStart.x, lastPos.x), y = Math.min(rectStart.y, lastPos.y);
        const w = Math.abs(lastPos.x - rectStart.x), h = Math.abs(lastPos.y - rectStart.y);
        if (w > 3 && h > 3) drawShapes.push({ kind: 'rect', x, y, w, h });
      } else if (penBbox) {
        const w = penBbox.maxX - penBbox.minX, h = penBbox.maxY - penBbox.minY;
        if (w > 3 || h > 3) drawShapes.push({ kind: 'pencil', x: penBbox.minX, y: penBbox.minY, w, h });
      }
    }
    drawing = false; rectStart = null; rectSnapshot = null; penBbox = null;
    refreshDrawCache();
  };
  canvas.onpointerup = endStroke;
  canvas.onpointercancel = endStroke;
}

function navigate(delta) {
  const visible = visibleComparisons();
  if (visible.length === 0) return;
  const curId = comparisons[currentIdx] && comparisons[currentIdx].id;
  let vIdx = visible.findIndex(c => c.id === curId);
  if (vIdx < 0) vIdx = 0;
  vIdx = Math.max(0, Math.min(visible.length - 1, vIdx + delta));
  currentIdx = comparisons.findIndex(c => c.id === visible[vIdx].id);
  render();
}

document.addEventListener('keydown', e => {
  // Ctrl/Cmd+Z — undo last drawing stroke (works globally, even while typing
  // in the comment box, so drawing workflow isn't interrupted).
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    undoDraw();
    e.preventDefault();
    return;
  }
  const commentEl = document.getElementById('comment');
  // Don't intercept keys when typing in the comment box
  if (document.activeElement === commentEl) {
    if (e.key === 'Escape') { commentEl.blur(); e.preventDefault(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { rate('bad'); e.preventDefault(); }
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'n') navigate(1);
  if (e.key === 'ArrowLeft' || e.key === 'p') navigate(-1);
  if (e.key === 'g') rate('good');
  if (e.key === 'f') { flickFlip(); e.preventDefault(); } // blink-flick original↔rendered
  if (e.key === 'b') { commentEl.focus(); e.preventDefault(); }
  if (e.key === 'Enter') { const comment = commentEl.value.trim(); if (comment) rate('bad'); }
});

// --- Magnifier loupe ---
let loupeOn = false;
function toggleLoupe() {
  loupeOn = document.getElementById('loupeToggle').checked;
  if (!loupeOn) { const l = document.getElementById('loupe'); if (l) l.style.display = 'none'; }
}
// Listen at the document level in CAPTURE phase so the draw-canvas's
// pointer-events:auto (when Draw is on) can't block the magnifier. Hit-test
// the cursor against the natural-resolution rects of the two <img>s and show a
// zoomed CSS background-image of whichever one is under the cursor.
document.addEventListener('mousemove', (e) => {
  const lens = document.getElementById('loupe');
  if (!lens) return;
  if (!loupeOn) { lens.style.display = 'none'; return; }
  const size = 240;
  const zEl = document.getElementById('loupeZoomCtl');
  const zoom = zEl ? parseFloat(zEl.value) : 3;
  const imgs = [document.getElementById('originalImg'), document.getElementById('slidesImg')].filter(Boolean);
  for (const img of imgs) {
    if (!img.naturalWidth) continue;
    const r = img.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) continue;
    const nx = ((e.clientX - r.left) / r.width) * img.naturalWidth;
    const ny = ((e.clientY - r.top) / r.height) * img.naturalHeight;
    lens.style.display = 'block';
    lens.style.left = (e.clientX - size / 2) + 'px';
    lens.style.top = (e.clientY - size / 2) + 'px';
    lens.style.width = size + 'px';
    lens.style.height = size + 'px';
    // Over the Slides render, composite the draw-canvas (your strokes) ON TOP of
    // the image so the magnifier shows the annotation. The drawCanvas shares the
    // image's natural resolution, so one backgroundSize/Position aligns both
    // layers (CSS repeats a single value across all background images). The data
    // URL MUST be quoted — it contains commas that would otherwise split the
    // multi-background list.
    const drawUrl = (img.id === 'slidesImg' && drawCanvasDataUrl) ? drawCanvasDataUrl : null;
    lens.style.backgroundImage = drawUrl
      ? ('url("' + drawUrl + '"), url("' + img.src + '")')
      : ('url("' + img.src + '")');
    lens.style.backgroundSize = (img.naturalWidth * zoom) + 'px ' + (img.naturalHeight * zoom) + 'px';
    lens.style.backgroundPosition = (-(nx * zoom - size / 2)) + 'px ' + (-(ny * zoom - size / 2)) + 'px';
    return;
  }
  lens.style.display = 'none';
}, true);

load();
</script>
</body>
</html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
    return;
  }

  if (url.pathname === "/api/comparisons") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(findComparisons()));
    return;
  }

  if (url.pathname === "/api/summary") {
    // Goldens health summary + freshness-of-current-render. The "oldest"
    // timestamp reported is the OLDEST CURRENT-RENDER thumbnail under
    // results/slides/ — this is the file being compared against the golden,
    // so its mtime proves the render was actually re-scraped. The golden
    // file's own mtime is irrelevant (a golden could be years old and still
    // correct).
    const metaFile = join(resultsDir, "meta.json");
    let goldensDir: string | null = null;
    if (existsSync(metaFile)) {
      const meta = JSON.parse(readFileSync(metaFile, "utf-8"));
      if (meta.goldensDir) goldensDir = meta.goldensDir;
      else if (meta.htmlDir) goldensDir = join(dirname(meta.htmlDir), "goldens");
    }
    const comparisons = findComparisons();
    const matching = comparisons.filter(c => c.diffStatus === "ok").length;
    const regressed = comparisons.filter(c => c.diffStatus === "regressed").length;
    const newCount = comparisons.filter(c => c.diffStatus === "new").length;
    let goldenTotal = 0;
    if (goldensDir && existsSync(goldensDir)) {
      goldenTotal = readdirSync(goldensDir).filter(f => f.endsWith(".png")).length;
    }

    // Oldest CURRENT-RENDER thumbnail mtime under slides/.
    const slidesDir = join(resultsDir, "slides");
    let oldestRenderMs = Infinity;
    if (existsSync(slidesDir)) {
      for (const f of readdirSync(slidesDir).filter(f => f.endsWith(".png"))) {
        const m = statSync(join(slidesDir, f)).mtimeMs;
        if (m < oldestRenderMs) oldestRenderMs = m;
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      matching, regressed, new: newCount, total: comparisons.length,
      goldenTotal,
      oldestRenderMs: oldestRenderMs === Infinity ? null : oldestRenderMs,
      nowMs: Date.now(),
    }));
    return;
  }

  if (url.pathname === "/api/rate" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { id, status, comment, annotation, shapes, canvasSize, pencilPadding } = JSON.parse(body);
      const annotationPath = saveRating(id, status, comment, annotation);
      // Per-annotation zoom-crops: crop original + test at each marked region.
      let zoomCrops: string[] = [];
      if (annotation) {
        const comp = findComparisons().find(c => c.id === id);
        if (comp) {
          try {
            const annotBytes = Buffer.from(String(annotation).replace(/^data:image\/png;base64,/, ""), "base64");
            zoomCrops = generateZoomCrops(
              id, comp.originalPng, comp.slidesPng, annotBytes,
              Array.isArray(shapes) ? shapes : null,
              canvasSize && typeof canvasSize.w === "number" ? canvasSize : null,
              typeof pencilPadding === "number" ? pencilPadding : 20,
            );
          } catch (e) { console.error("zoom-crop generation failed:", (e as Error).message); }
        }
      }
      console.log(`RATING: ${id} → ${status}${comment ? ` | ${comment}` : ''}${annotation ? ' [+annotation]' : ''}${zoomCrops.length ? ` [${zoomCrops.length} crops]` : ''}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, annotationPath, zoomCrops }));
    });
    return;
  }

  if (url.pathname === "/html") {
    // Serve HTML source files for inspection — resolve relative to resultsDir
    const relPath = url.searchParams.get("path") || "";
    const htmlPath = resolve(resultsDir, relPath);
    if (existsSync(htmlPath) && htmlPath.endsWith(".html")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(readFileSync(htmlPath));
      return;
    }
    res.writeHead(404); res.end("Not found"); return;
  }

  if (url.pathname === "/img") {
    const imgPath = url.searchParams.get("path") || "";
    if (existsSync(imgPath) && imgPath.endsWith(".png")) {
      // ETag based on mtime so browsers refetch after regen overwrites the
      // thumbnail on disk. Without this, Chrome caches the previous render
      // indefinitely and the rating UI shows stale content — reviewer thinks
      // a fix didn't land when actually it did.
      const st = statSync(imgPath);
      const etag = `"${st.mtimeMs.toFixed(0)}-${st.size}"`;
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304); res.end(); return;
      }
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "no-cache, must-revalidate",
        "ETag": etag,
      });
      res.end(readFileSync(imgPath));
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Task-scoped: serve the H2 section of --task-analysis that matches the
  // current slide_id. Returns plain text (or "(no section …)" if none).
  if (url.pathname === "/api/task-analysis") {
    const slideId = url.searchParams.get("slide") || "";
    if (!taskAnalysisPath || !existsSync(taskAnalysisPath)) {
      res.writeHead(404); res.end(`task-analysis not configured (--task-analysis ${taskAnalysisPath ?? "(unset)"})`); return;
    }
    const md = readFileSync(taskAnalysisPath, "utf-8");
    // Parse: find an H2 whose heading contains slideId, collect lines until
    // the next H2 (or EOF). Case-insensitive substring match so both
    // "## slide_04" and "## Slide 04: …" work.
    const lines = md.split(/\r?\n/);
    let inSection = false;
    const out: string[] = [];
    for (const line of lines) {
      const h2 = line.match(/^##\s+(.*)$/);
      if (h2) {
        if (inSection) break;
        inSection = h2[1].toLowerCase().includes(slideId.toLowerCase());
        if (inSection) out.push(line);
        continue;
      }
      if (inSection) out.push(line);
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(out.length ? out.join("\n").trim() : `(no section found for ${slideId} in ${taskAnalysisPath})`);
    return;
  }

  // Task-scoped: serve <slide_id>.diff + .summary.json contents from
  // --task-diffs. Concatenated in that order for easy reading.
  if (url.pathname === "/api/task-diff") {
    const slideId = url.searchParams.get("slide") || "";
    if (!taskDiffsDir) {
      res.writeHead(404); res.end("task-diffs not configured (--task-diffs)"); return;
    }
    const diffFile = join(taskDiffsDir, `${slideId}.diff`);
    const summaryFile = join(taskDiffsDir, `${slideId}.summary.json`);
    let body = "";
    if (existsSync(diffFile)) body += readFileSync(diffFile, "utf-8");
    else body += `(no diff file for ${slideId} at ${diffFile})`;
    if (existsSync(summaryFile)) body += "\n\n--- summary.json ---\n" + readFileSync(summaryFile, "utf-8");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(body);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(port, () => {
  console.log(`\n  Rating server: http://localhost:${port}\n`);
  console.log(`  Results dir: ${resultsDir}`);
  console.log(`  Comparisons: ${findComparisons().length}`);
  console.log(`\n  Keyboard: g=good, b=bad, n/→=next, p/←=prev\n`);
});
