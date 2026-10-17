#!/usr/bin/env npx tsx
/**
 * rating-server.ts — E2E rating website for html2slides fidelity
 *
 * Shows side-by-side: original HTML screenshot vs Google Slides screenshot.
 * Two buttons: Good (saves to regression snapshots) / Bad (triggers analysis).
 *
 * Usage: npx tsx rating-server.ts <results-dir> [--port 3456]
 *          [--goldens-dir <dir>] [--html-dir <dir>] [--ratings-file <file>]
 *   --goldens-dir   where a forward "Good" blesses to (default: meta.json goldensDir,
 *                   else the sibling goldens/ of meta.json htmlDir; neither → no bless).
 *   --html-dir      the fixture HTML linked from each card (default: meta.json htmlDir).
 *                   It never enables blessing on its own.
 *   --ratings-file  where verdicts are saved (default: <results-dir>/ratings.json).
 *
 * Results dir should contain:
 *   slide_01_original.png, slide_01_slides.png, slide_02_original.png, ...
 * Or structured as:
 *   originals/slide_01.png, slides/slide_01.png
 *
 * REVERSE mode (--direction reverse, see serve-sxs-reverse.sh and reverse-rating.ts)
 * rates the Google Slides -> Sasha HTML importer instead: "original" is Google's
 * thumbnail, "test" is the Sasha HTML screenshot, a toggle shows the full round trip
 * (original fixture HTML vs Sasha HTML) from round-trip/, each slide shows its
 * metrics.json numbers, verdicts go to ratings-reverse.json (forward ratings.json is
 * never touched) and the user's "Good" click blesses into e2e/goldens-reverse/
 * (override with --reverse-goldens-dir; a forward goldens directory is refused).
 */

import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, statSync, unlinkSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { PNG } from "pngjs";
import { resolveRatingIo, describeRatingIo } from "../structured-prompts/bug_solving/sxs-io.js";
import {
  assertReverseGoldensDirectory,
  blessReverseGolden,
  describeReverseIo,
  findReverseSlide,
  isReverseDirection,
  parseRatingDirection,
  parseReverseView,
  reverseGoldenStatus,
  reverseRatingsFileName,
  scanReverseResults,
  summarizeReverse,
  type FixtureDirectories,
  type RatingDirection,
  type ReverseSlide,
  type ReverseView,
} from "./reverse-rating.js";
import { ratingClientBundle, ratingClientPath, ratingPageHtml } from "./rating-page.js";
import type { RenderedRegion, SlideComparison } from "./rating-wire.js";
import { REVERSE_GOLDEN_DRIFT_LIMIT } from "../structured-prompts/bug_solving/reverse-direction.js";

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
let exitWhenAllRated = false;                   // --exit-when-all-rated: poll + exit(0) when every filter slide is good/bad
let slidesDirOverride: string | null = null;    // --slides-dir path
let originalsDirOverride: string | null = null; // --originals-dir path
let taskAnalysisPath: string | null = null;     // --task-analysis md
let taskDiffsDir: string | null = null;         // --task-diffs dir
let taskTitle: string | null = null;            // --task-title str
let historyDir: string | null = null;           // --history-dir persistent ledger
// --candidate: this server is rating an UNMERGED fix attempt (a bug_solving
// worktree render), NOT the canonical state of main. In candidate mode the
// verdict is recorded to <history-dir>/candidates.json (so green-detection
// still sees pass/fail), but the canonical per-slide ISSUE in ratings.json is
// LEFT UNTOUCHED — only a fix that actually lands on main may update the issue.
// Default (no flag) = canonical: the rating describes main's current render and
// updates the ledger's issue as the source of truth.
let candidateMode = false;
let showAllDefault = false;                     // --show-all: start with EVERY slide visible, not just diffs
// --read-only: serve the VERDICT-ONLY rating UI. All comment editing + every
// annotation drawing tool (pen/rect/clear/colour/size/prior-marks + the draw
// canvas & handlers) are stripped from the client, and the mutating endpoints
// are locked down: /api/rate accepts only { id, status } (comment/annotation in
// the body are ignored; the ledger's existing comment/annotation are preserved)
// and /api/clear-annotation returns 410 Gone. Only the Good/Bad verdict mutates
// state. DEFAULT (no flag) = fully editable defect-identification rating.
// This flag is passed ONLY by the merge/verdict rating boot (the per-fork gate);
// the normal rate:complex / rate:basics invocations stay editable.
let readOnly = false;
// --reject-all-button: show a single "Reject ALL & stop" button that marks EVERY
// filtered slide BAD in one click (a convenience when a whole batch is wrong, e.g.
// 20 slides — no per-slide clicking). Passed ONLY by the MERGE rating boot; it is
// NOT a special verdict — it just reds every shown slide, and --exit-when-all-rated
// then closes the UI. Default (no flag) = hidden.
let rejectAllButton = false;
// --notify-cmd: a shell command executed ONCE when this rating UI comes up, so a
// human is actively pinged that a cluster is waiting to be rated. Configurable via
// the flag or BUG_SOLVING_NOTIFY_CMD. Tokens {url} {port} {title} {slides} {dir}
// are substituted; the same values are also exported as env vars (RATING_URL,
// RATING_PORT, RATING_TITLE, RATING_SLIDES, RATING_DIR). Regardless of whether a
// command is set, a "🔔 NOTIFY USER" line is ALWAYS printed to stdout on boot so an
// orchestrator (or the human) watching stdout always learns a UI is waiting.
let notifyCmd: string | null = process.env.BUG_SOLVING_NOTIFY_CMD ?? null;
// --direction forward|reverse: which importer is being rated (see the header).
let direction: RatingDirection = "forward";
// --reverse-goldens-dir: where a reverse "Good" click blesses to. Defaults to
// e2e/goldens-reverse/ next to this file; tests point it at a temp directory.
let reverseGoldensDirOverride: string | null = null;
// --goldens-dir / --html-dir / --ratings-file: explicit forward overrides (serve-sxs.sh,
// rate-slides.sh). See forwardGoldensDir() and the Usage block above.
let goldensDirOverride: string | null = null;
let htmlDirOverride: string | null = null;
let ratingsFileOverride: string | null = null;
for (let i = 0; i < args.length; i++) {
  const v = args[i];
  if (v === "--port") port = parseInt(args[++i]);
  else if (v === "--filter-slides") filterSlides = args[++i].split(",").map(s => s.trim());
  else if (v === "--exit-when-all-rated") exitWhenAllRated = true;
  else if (v === "--slides-dir") slidesDirOverride = resolve(args[++i]);
  else if (v === "--originals-dir") originalsDirOverride = resolve(args[++i]);
  else if (v === "--task-analysis") taskAnalysisPath = resolve(args[++i]);
  else if (v === "--task-diffs") taskDiffsDir = resolve(args[++i]);
  else if (v === "--task-title") taskTitle = args[++i];
  else if (v === "--history-dir") historyDir = resolve(args[++i]);
  else if (v === "--candidate") candidateMode = true;
  else if (v === "--read-only") readOnly = true;
  else if (v === "--reject-all-button") rejectAllButton = true;
  else if (v === "--show-all") showAllDefault = true;
  else if (v === "--notify-cmd") notifyCmd = args[++i];
  else if (v === "--direction") direction = parseRatingDirection(args[++i] ?? "");
  else if (v === "--reverse-goldens-dir") reverseGoldensDirOverride = resolve(args[++i]);
  else if (v === "--goldens-dir") goldensDirOverride = resolve(args[++i]);
  else if (v === "--html-dir") htmlDirOverride = resolve(args[++i]);
  else if (v === "--ratings-file") ratingsFileOverride = resolve(args[++i]);
}

const reverseMode = isReverseDirection(direction);
const htmlToSlidesDir = dirname(fileURLToPath(import.meta.url));
// Where a metrics row's "set" finds its original fixture HTML (round-trip label link).
const fixtureDirectories: FixtureDirectories = {
  basic: join(htmlToSlidesDir, "e2e", "fixtures-basic"),
  complex: join(htmlToSlidesDir, "e2e", "fixtures"),
};
const reverseGoldensDir = reverseGoldensDirOverride ?? join(htmlToSlidesDir, "e2e", "goldens-reverse");
if (reverseMode) assertReverseGoldensDirectory(reverseGoldensDir);
// Reverse verdicts get their own file so a reverse rating can never overwrite a
// forward one, even when both modes are pointed at the same results directory.
const ratingsFilePath = ratingsFileOverride ?? join(resultsDir, reverseMode ? reverseRatingsFileName : "ratings.json");

/** The results directory's optional meta.json ({ htmlDir, goldensDir, presentationId,
 *  slideIds, … }); {} when absent. */
function readResultsMeta(): { htmlDir?: string; goldensDir?: string; presentationId?: string; slideIds?: Record<string, string> | string[] } {
  const metaFile = join(resultsDir, "meta.json");
  return existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf-8")) : {};
}

/** Where a forward "Good" blesses the current thumb: --goldens-dir, else meta.json's
 *  goldensDir, else the sibling goldens/ of meta.json's htmlDir. --html-dir alone
 *  never enables blessing (rate-slides.sh reviews arbitrary directories). */
function forwardGoldensDir(): string | null {
  if (goldensDirOverride) return goldensDirOverride;
  const meta = readResultsMeta();
  if (meta.goldensDir) return meta.goldensDir;
  return meta.htmlDir ? join(dirname(meta.htmlDir), "goldens") : null;
}

// Resolve the full, documented I/O contract (sxs-io.ts) from the parsed flags.
// This is the single source of truth for WHICH files this server reads (slides,
// originals, manifest, meta, source, orig-annotations) and WRITES (ratings.json,
// annotations/, zoom-crops/) and mirrors to the LEDGER (candidates.json). It is
// printed on boot (describeRatingIo) so the interface is never implicit. The
// existing per-function path derivations below match these documented defaults.
const io = resolveRatingIo({
  resultsDir,
  slidesDir: slidesDirOverride ?? undefined,
  originalsDir: originalsDirOverride ?? undefined,
  filterSlides,
  historyDir: historyDir ?? undefined,
  candidateMode,
  ratingsFile: ratingsFileOverride ?? undefined,
});

/** Fire the per-UI notification when the server comes up. ALWAYS prints a
 *  "🔔 NOTIFY USER" line to stdout (the guaranteed baseline notifier); then, if a
 *  --notify-cmd / BUG_SOLVING_NOTIFY_CMD is configured, runs it with the UI's
 *  context. Never throws — a broken notifier must not take down the rating UI. */
function fireNotify(url: string): void {
  const title = taskTitle ?? resultsDir;
  const slides = (filterSlides ?? []).join(",");
  console.log(`🔔 NOTIFY USER: rate "${title}" → ${url}${slides ? ` (slides: ${slides})` : ""}`);
  if (!notifyCmd) {
    console.log(`  (no --notify-cmd / BUG_SOLVING_NOTIFY_CMD — stdout notice only)`);
    return;
  }
  const cmd = notifyCmd
    .split("{url}").join(url)
    .split("{port}").join(String(port))
    .split("{title}").join(title)
    .split("{slides}").join(slides)
    .split("{dir}").join(resultsDir);
  try {
    execSync(cmd, {
      stdio: "inherit",
      env: { ...process.env, RATING_URL: url, RATING_PORT: String(port), RATING_TITLE: title, RATING_SLIDES: slides, RATING_DIR: resultsDir },
    });
    console.log(`  notify-cmd ran: ${cmd}`);
  } catch (e) {
    console.error(`  ⚠ notify-cmd failed (non-fatal): ${(e as Error).message}`);
  }
}

// Render-parameter badge: surface which conversion mode produced these slides
// (e.g. tablesFormat=baked) so a reviewer never confuses a baked-table run
// with the default native one. Read from meta.json { renderParams?, tablesFormat? }.
let renderBadgeHtml = "";
try {
  const _metaPath = join(resultsDir, "meta.json");
  const _meta = existsSync(_metaPath) ? JSON.parse(readFileSync(_metaPath, "utf-8")) : {};
  // ALWAYS surface the conversion args on top; default tablesFormat to "native"
  // so the badge is never silently empty (a reviewer must always see the mode).
  const _rp: Record<string, unknown> = { tablesFormat: _meta.tablesFormat ?? "native", ...(_meta.renderParams || {}) };
  const parts = Object.entries(_rp)
    .filter(([, val]) => val != null && val !== "")
    .map(([k, val]) => {
      const cls = k === "tablesFormat" && val === "baked" ? "render-badge badge-baked" : "render-badge";
      return `<span class="${cls}">${k}: ${val}</span>`;
    });
  renderBadgeHtml = parts.join("");
} catch { /* meta is optional */ }
// The forward badge describes pptx conversion parameters, which say nothing about
// a reverse run; name the direction instead so the two UIs are never confused.
if (reverseMode) renderBadgeHtml = `<span class="render-badge badge-reverse">Reverse: Google Slides &rarr; Sasha HTML</span>`;

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
  // Further images cropped at the same regions, as [side name, png path]. Reverse
  // mode passes the round trip's fixture screenshot as side "fixture".
  extraSides: ReadonlyArray<readonly [string, string]> = [],
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
    const sides: ReadonlyArray<readonly [string, string]> = [["original", originalPng], ["rendered", slidesPng], ...extraSides];
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
  // REVERSE: the slide list, pairs and metrics come from reverse-rating.ts; the
  // forward-only merges below (meta.json htmlDir positions, goldens regression
  // report, rendered regions, upload manifest) describe the pptx direction.
  if (reverseMode) return attachRatingsAndFilter(findReverseComparisons());
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

  // Merge optional meta.json: { htmlDir, presentationId, slideIds? } (--html-dir wins).
  {
    const meta = readResultsMeta();
    const htmlDir = htmlDirOverride ?? meta.htmlDir;
    const htmlFiles = htmlDir && existsSync(htmlDir)
      ? readdirSync(htmlDir).filter((f: string) => f.endsWith(".html")).sort()
      : [];
    for (let i = 0; i < comparisons.length; i++) {
      const c = comparisons[i];
      // Match the HTML source by slide id first (robust to --filter-slides,
      // where comparisons[i] no longer lines up with htmlFiles[i]); fall back
      // to positional matching only when no id match exists.
      const byId = htmlFiles.find((f: string) => f.replace(/\.html$/, "") === c.id || f.startsWith(c.id + "."));
      const htmlName = byId ?? htmlFiles[i];
      if (htmlName && htmlDir) c.htmlFile = join(htmlDir, htmlName);
      if (meta.presentationId) {
        // slideIds carry the per-slide object id for the #slide deep-link.
        const ids = meta.slideIds as Record<string | number, string> | undefined;
        const sid = ids?.[c.id] ?? ids?.[i];
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
  // slide_NN and match the comparison id 1:1. convert-pptx-io writes it next to
  // the pptx (dirname(pptxPath)), which for `record-rendering --mode full` is
  // the slides-dir / a pptx/ subdir — NOT the results-dir root. So probe the
  // likely locations (results-dir, the --slides-dir, and pptx/ subdirs) and use
  // the first that exists, or the checkbox "Highlight rendered regions" has no
  // data to mark.
  const regionCandidates = [
    join(resultsDir, "rendered-regions.json"),
    ...(slidesDirOverride ? [join(slidesDirOverride, "rendered-regions.json")] : []),
    join(resultsDir, "pptx", "rendered-regions.json"),
    join(resultsDir, "thumbs", "rendered-regions.json"),
    join(resultsDir, "thumbs", "pptx", "rendered-regions.json"),
  ];
  const regionsFile = regionCandidates.find((p) => existsSync(p));
  if (regionsFile) {
    try {
      const regions = JSON.parse(readFileSync(regionsFile, "utf-8")) as Record<string, RenderedRegion[]>;
      for (const c of comparisons) {
        const list = regions[c.id];
        if (list && list.length > 0) c.renderedRegions = list;
      }
    } catch {}
  }

  // Surface the rendered Google-Slides URL from `record-rendering --mode full`'s
  // manifest.json. It lives next to the thumbs (same place as rendered-regions)
  // and carries { presentation_id, slides[], slide_object_ids[] } — NOT the
  // `presentation_url` the sxs-meta path expects, so without this the
  // "Open in Slides" link never appears. Build the per-slide deep-link from the
  // presentation id + the object id of the matching slide.
  const manifestFile = [
    ...(slidesDirOverride ? [join(slidesDirOverride, "manifest.json")] : []),
    join(resultsDir, "thumbs", "manifest.json"),
    join(resultsDir, "manifest.json"),
    join(resultsDir, "pptx", "manifest.json"),
  ].find((p) => existsSync(p));
  if (manifestFile) {
    try {
      const man = JSON.parse(readFileSync(manifestFile, "utf-8")) as {
        presentation_id?: string; slides?: string[]; slide_object_ids?: string[];
      };
      if (man.presentation_id) {
        for (const c of comparisons) {
          if (c.slidesUrl) continue; // an explicit meta/ratings url wins
          const idx = man.slides?.indexOf(c.id) ?? -1;
          const oid = idx >= 0 ? man.slide_object_ids?.[idx] : undefined;
          c.slidesUrl = `https://docs.google.com/presentation/d/${man.presentation_id}/edit`
            + (oid ? `#slide=id.${oid}` : "");
        }
      }
    } catch {}
  }

  return attachRatingsAndFilter(comparisons);
}

/** Reverse slides as comparisons: original = Google thumbnail, test = Sasha HTML screenshot. */
function findReverseComparisons(): SlideComparison[] {
  const scan = scanReverseResults({ resultsDirectory: resultsDir, fixtureDirectories });
  return scan.slides.map((slide): SlideComparison => ({
    id: slide.id,
    originalPng: slide.googlePng,
    slidesPng: slide.sashaPng,
    status: "pending",
    // Against the user's golden, so a Good slide that drifted shows in the default view.
    ...reverseGoldenStatus({ slide, goldensDirectory: reverseGoldensDir, driftLimitPercent: REVERSE_GOLDEN_DRIFT_LIMIT }),
    // htmlFile / slidesUrl stay unset: they would fill the forward "Round-1
    // provenance" panel, and the reverse pane labels already link the fixture,
    // the Sasha HTML and the Google deck (reverse-rating-page.ts).
    ...(slide.reverseDiffPng ? { diffPng: slide.reverseDiffPng } : {}),
    reverse: slide,
  }));
}

/** Shared tail of both directions: saved verdicts, on-disk zoom-crops, --filter-slides. */
function attachRatingsAndFilter(comparisons: SlideComparison[]): SlideComparison[] {
  // Load existing ratings (user ratings override auto-blessing).
  const ratingsFile = ratingsFilePath;
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
          c.annotationPng = ratings[c.id].annotation;
        }
      }
    }
  }

  // Attach any per-annotation zoom-crops on disk (independent of ratings).
  for (const c of comparisons) {
    const crops = listZoomCrops(zoomDir, c.id);
    if (crops.length) c.zoomCrops = crops;
  }

  // --filter-slides narrows the list to a specific set of slide IDs.
  // Used by bug_solving tasks to show only the cluster's slides.
  if (filterSlides && filterSlides.length) {
    const wanted = new Set(filterSlides);
    return comparisons.filter(c => wanted.has(c.id));
  }
  return comparisons;
}

/** Resolve ONE slide's original + render PNG paths directly, WITHOUT the full
 *  findComparisons() deck rescan (which readdir/reads every slide + attaches all
 *  zoom-crops just to locate a single pair — the reason "Good" stalled for
 *  seconds before advancing). Mirrors the two layouts findComparisons builds:
 *    Pattern 1: <originalsDir>/<id>.png + <slidesDir>/<id>.png
 *    Pattern 2: <resultsDir>/<id>_original.png + <resultsDir>/<id>_slides.png
 *  A side whose file is absent comes back null. */
function resolveSlidePaths(id: string): { originalPng: string | null; slidesPng: string | null } {
  if (reverseMode) {
    const slide = findReverseSlide({ resultsDirectory: resultsDir, fixtureDirectories, slideId: id });
    return { originalPng: slide?.googlePng ?? null, slidesPng: slide?.sashaPng ?? null };
  }
  const originalsDir = originalsDirOverride
    ?? (existsSync(join(resultsDir, "originals")) ? join(resultsDir, "originals") : resultsDir);
  const slidesDir = slidesDirOverride
    ?? (existsSync(join(resultsDir, "slides")) ? join(resultsDir, "slides") : resultsDir);
  // Pattern 1 (originals/ + slides/ split layout).
  const p1o = join(originalsDir, `${id}.png`);
  const p1s = join(slidesDir, `${id}.png`);
  if (originalsDir !== slidesDir && existsSync(p1o) && existsSync(p1s)) {
    return { originalPng: p1o, slidesPng: p1s };
  }
  // Pattern 2 (<id>_original.png + <id>_slides.png flat layout), falling back to
  // whichever Pattern-1 file exists on its own.
  const p2o = join(resultsDir, `${id}_original.png`);
  const p2s = join(resultsDir, `${id}_slides.png`);
  return {
    originalPng: existsSync(p2o) ? p2o : (existsSync(p1o) ? p1o : null),
    slidesPng: existsSync(p2s) ? p2s : (existsSync(p1s) ? p1s : null),
  };
}

function saveRating(id: string, status: "good" | "bad", comment?: string, annotationPng?: string, reviewedView?: ReverseView): string | null {
  const ratingsFile = ratingsFilePath;
  const ratings = existsSync(ratingsFile) ? JSON.parse(readFileSync(ratingsFile, "utf-8")) : {};
  const prior = ratings[id];
  // READ-ONLY verdict: a rating must NOT overwrite the comment. When no comment
  // is passed in read-only mode, PRESERVE whatever the ledger already holds; in
  // editable mode an absent comment means the reviewer cleared it and is honoured.
  const keepComment = comment !== undefined ? comment : (readOnly ? prior?.comment : undefined);
  const entry: any = { status, ratedAt: new Date().toISOString() };
  if (keepComment !== undefined) entry.comment = keepComment;
  // REVERSE: record which pair the verdict was given on (reverse step or full
  // round trip), since a slide can be faithful to Google and still lose the fixture.
  if (reverseMode) {
    entry.direction = "reverse";
    entry.view = reviewedView ?? "reverse";
  }
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
  } else if (prior && prior.annotation && existsSync(prior.annotation)) {
    // No new drawing this time — PRESERVE the previously saved annotation so
    // re-rating (e.g. editing the comment and hitting Bad again) never drops it.
    entry.annotation = prior.annotation;
    savedAnnotPath = prior.annotation;
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
      if (candidateMode) {
        // CANDIDATE: this rating judges an UNMERGED fix attempt. Record the
        // verdict in a SEPARATE store and DO NOT touch the canonical issue —
        // overwriting it with a post-fix "leftover" comment would point the
        // next round at a defect tied to a fix that never landed (and whose
        // worktree gets nuked). Only a merge to main may update the issue.
        const candFile = join(historyDir, "candidates.json");
        const cand = existsSync(candFile) ? JSON.parse(readFileSync(candFile, "utf-8")) : {};
        // Read-only verdict preserves the store's existing comment (see above).
        const candComment = comment !== undefined ? comment : (readOnly ? cand[id]?.comment : undefined);
        const rec: any = { status, ratedAt: entry.ratedAt, taskTitle: taskTitle ?? null };
        if (candComment !== undefined) rec.comment = candComment;
        if (savedAnnotPath) {
          const candAnnotDir = join(historyDir, "candidate-annotations");
          mkdirSync(candAnnotDir, { recursive: true });
          const candAnnot = join(candAnnotDir, `${id}.png`);
          copyFileSync(savedAnnotPath, candAnnot);
          rec.annotation = candAnnot;
        }
        cand[id] = rec;
        writeFileSync(candFile, JSON.stringify(cand, null, 2));
      } else {
        // CANONICAL: this rating describes main's current render — the source of
        // truth for the per-slide issue. Update the ledger.
        const ledgerFile = join(historyDir, "ratings.json");
        const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf-8")) : {};
        // Read-only verdict preserves the ledger's existing comment (see above).
        const ledComment = comment !== undefined ? comment : (readOnly ? ledger[id]?.comment : undefined);
        const led: any = { status, ratedAt: entry.ratedAt };
        if (ledComment !== undefined) led.comment = ledComment;
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
      }
    } catch { /* ledger mirror is best-effort, never break a rating save */ }
  }

  if (status === "good") {
    // Keep a simple SxS archive pair. Resolve THIS slide's two paths directly
    // (resolveSlidePaths) instead of findComparisons() — the full-deck rescan
    // is what made "Good" stall for seconds before the UI could advance.
    const snapshotDir = join(resultsDir, "regression-snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    const { originalPng, slidesPng } = resolveSlidePaths(id);
    if (originalPng && slidesPng) {
      copyFileSync(originalPng, join(snapshotDir, `${id}_original.png`));
      copyFileSync(slidesPng, join(snapshotDir, `${id}_slides.png`));

      // REVERSE: the user's Good click is the ONLY writer of e2e/goldens-reverse/,
      // and it must never reach the forward goldens below (meta.json in a reverse
      // results directory may name the fixtures' htmlDir, whose sibling is the
      // FORWARD goldens/ directory).
      const reverseSlide = reverseMode
        ? findReverseSlide({ resultsDirectory: resultsDir, fixtureDirectories, slideId: id })
        : null;
      if (reverseSlide) {
        const blessed = blessReverseGolden({ slide: reverseSlide, goldensDirectory: reverseGoldensDir });
        console.log(`  BLESSED (reverse) ${id} → ${blessed}`);
      }

      // Bless the golden — THIS is the only sanctioned writer of the goldens
      // directory (forwardGoldensDir: --goldens-dir, else meta.json).
      const goldensDir = reverseMode ? null : forwardGoldensDir();
      if (goldensDir) {
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
  return savedAnnotPath;
}

/** Truly clear a slide's persisted annotation: delete the flattened annotation
 *  PNG + all of its zoom-crops, and drop the `annotation` reference from
 *  ratings.json (and the --history-dir ledger / candidate mirrors) so a later
 *  save can't resurrect it via saveRating's "preserve prior annotation" branch.
 *  The rating status/comment are left intact — only the drawing is removed. */
function clearAnnotation(id: string): void {
  // 1. Delete the flattened annotation PNG.
  const annotPath = join(resultsDir, "annotations", `${id}.png`);
  if (existsSync(annotPath)) { try { unlinkSync(annotPath); } catch {} }

  // 2. Delete this slide's zoom-crops (<id>.png and <id>-NN-side.png).
  if (existsSync(zoomDir)) {
    for (const f of readdirSync(zoomDir)) {
      if (f === `${id}.png` || f.startsWith(`${id}-`)) { try { unlinkSync(join(zoomDir, f)); } catch {} }
    }
  }

  // 3. Drop the annotation reference from ratings.json so the next save's
  //    preserve-prior-annotation branch can't bring it back.
  const ratingsFile = ratingsFilePath;
  if (existsSync(ratingsFile)) {
    try {
      const ratings = JSON.parse(readFileSync(ratingsFile, "utf-8"));
      if (ratings[id] && ratings[id].annotation) {
        delete ratings[id].annotation;
        writeFileSync(ratingsFile, JSON.stringify(ratings, null, 2));
      }
    } catch { /* best-effort */ }
  }

  // 4. Mirror the removal to the persistent ledger / candidate stores so the
  //    next round doesn't re-surface the cleared drawing from --history-dir.
  if (historyDir) {
    const stores: Array<[string, string]> = candidateMode
      ? [[join(historyDir, "candidates.json"), join(historyDir, "candidate-annotations", `${id}.png`)]]
      : [[join(historyDir, "ratings.json"), join(historyDir, "annotations", `${id}.png`)]];
    for (const [store, png] of stores) {
      if (existsSync(png)) { try { unlinkSync(png); } catch {} }
      if (existsSync(store)) {
        try {
          const j = JSON.parse(readFileSync(store, "utf-8"));
          if (j[id] && j[id].annotation) { delete j[id].annotation; writeFileSync(store, JSON.stringify(j, null, 2)); }
        } catch { /* best-effort */ }
      }
    }
  }
}

// The page markup (rating-page.ts) with the server settings embedded as JSON; the
// client behind it is rating-ui.ts, bundled by esbuild when the server starts (below).
const HTML = ratingPageHtml({
  taskTitle,
  readOnly,
  reverseMode,
  rejectAllButton,
  taskScoped: Boolean(taskAnalysisPath || taskDiffsDir),
  showAllDefault,
  renderBadgeHtml,
});
let clientJs = "";

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    // no-store (here and on the client bundle): without it a browser caches a
    // stale client and a code change (e.g. draw-mode default) never shows up on refresh.
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store, must-revalidate" });
    res.end(HTML);
    return;
  }

  if (url.pathname === ratingClientPath) {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store, must-revalidate" });
    res.end(clientJs);
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
    if (reverseMode) {
      // REVERSE: deck-level fidelity numbers from metrics.json, verdict counts from
      // ratings-reverse.json, and how many reverse goldens the user has blessed.
      const statusById = new Map(findComparisons().map((comparison) => [comparison.id, comparison.status] as const));
      const summary = summarizeReverse({
        scan: scanReverseResults({ resultsDirectory: resultsDir, fixtureDirectories }),
        statusById,
        goldensDirectory: reverseGoldensDir,
        ratingsFile: ratingsFilePath,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(summary));
      return;
    }
    const goldensDir = forwardGoldensDir();
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
      if (readOnly) {
        // READ-ONLY UI: a rating records ONLY the good/bad status. Any comment,
        // annotation, draw-shape or canvas fields in the body are IGNORED — the
        // ledger's existing comment/annotation stay untouched (saveRating
        // preserves them when none is passed). No zoom-crops are written.
        let id = "", status = "";
        try { ({ id, status } = JSON.parse(body)); } catch { /* malformed → 400 below */ }
        if (!id || (status !== "good" && status !== "bad")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "expected { id, status: 'good' | 'bad' }" }));
          return;
        }
        saveRating(id, status as "good" | "bad");
        console.log(`RATING: ${id} → ${status}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      const { id, status, comment, annotation, shapes, canvasSize, pencilPadding, view } = JSON.parse(body);
      const annotationPath = saveRating(id, status, comment, annotation, reverseMode ? parseReverseView(view) : undefined);
      // Per-annotation zoom-crops: crop original + test at each marked region.
      // Resolve THIS slide's two paths directly (resolveSlidePaths) rather than
      // scanning the whole deck via findComparisons() just to read one pair.
      let zoomCrops: string[] = [];
      if (annotation) {
        const paths = resolveSlidePaths(id);
        // REVERSE: also crop the round trip's fixture screenshot at the same marks,
        // so a flagged region shows Google | Sasha | fixture side by side.
        const fixturePng = reverseMode
          ? findReverseSlide({ resultsDirectory: resultsDir, fixtureDirectories, slideId: id })?.fixturePng ?? null
          : null;
        if (paths.originalPng && paths.slidesPng) {
          try {
            const annotBytes = Buffer.from(String(annotation).replace(/^data:image\/png;base64,/, ""), "base64");
            zoomCrops = generateZoomCrops(
              id, paths.originalPng, paths.slidesPng, annotBytes,
              Array.isArray(shapes) ? shapes : null,
              canvasSize && typeof canvasSize.w === "number" ? canvasSize : null,
              typeof pencilPadding === "number" ? pencilPadding : 20,
              fixturePng ? [["fixture", fixturePng]] : [],
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

  // READ-ONLY UI: annotation-mutation is DISABLED. There is no drawing tool, so
  // the clear-annotation write path is gone (410 Gone). Existing annotations
  // still DISPLAY (served read-only via /img); they just can't be cleared.
  if (readOnly && url.pathname === "/api/clear-annotation") {
    res.writeHead(410, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "annotation editing disabled (read-only rating UI)" }));
    return;
  }

  // Truly clear a slide's persisted annotation (PNG + zoom-crops + the
  // annotation reference in ratings.json / ledger). Wired to the "Clear" button
  // so wiping the live canvas ALSO removes the saved drawing on disk — otherwise
  // it reloads on the next render.
  if (url.pathname === "/api/clear-annotation" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let id = "";
      try { ({ id } = JSON.parse(body)); } catch { /* malformed body → no-op */ }
      if (id) clearAnnotation(id);
      console.log(`CLEAR-ANNOTATION: ${id || "(no id)"}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: !!id }));
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

// Defensive: if the chosen port is momentarily still held (a prior rating server
// that hasn't fully exited), fall back to the next port instead of crashing on an
// unhandled 'error' event. The bound port is printed below either way.
const basePort = port;
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE" && port < basePort + 25) {
    port += 1;
    console.error(`  [rating-server] port ${port - 1} in use → trying ${port}`);
    setTimeout(() => server.listen(port), 150);
  } else {
    console.error(`  [rating-server] listen failed: ${e.message}`);
    process.exit(1);
  }
});
// Bundle the browser client before listening, so a broken client fails the boot loudly
// instead of serving a page that does nothing.
ratingClientBundle().then((bundled) => {
  clientJs = bundled;
  server.listen(port, onListening);
}, (error: unknown) => {
  console.error(`  [rating-server] client bundle failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

function onListening(): void {
  const url = `http://localhost:${port}`;
  console.log(`\n  Rating server: ${url}\n`);
  console.log(`  Results dir: ${resultsDir}`);
  console.log(`  Comparisons: ${findComparisons().length}`);
  // The sxs-io contract names ratings.json; reverse writes its own verdicts file.
  console.log(`\n${reverseMode ? describeRatingIo(io).replace(io.ratingsFile, ratingsFilePath) : describeRatingIo(io)}\n`);
  if (reverseMode) {
    console.log(`${describeReverseIo({ resultsDirectory: resultsDir, goldensDirectory: reverseGoldensDir, ratingsFile: ratingsFilePath })}\n`);
    const scan = scanReverseResults({ resultsDirectory: resultsDir, fixtureDirectories });
    for (const problem of scan.problems) console.log(`  ⚠ ${problem}`);
    if (scan.missingSashaRender.length) console.log(`  ⚠ no Sasha render for: ${scan.missingSashaRender.join(", ")}`);
  }
  console.log(`  Keyboard: g=good, b=bad, n/→=next, p/←=prev${reverseMode ? ", v=reverse step ↔ round trip" : ""}\n`);
  fireNotify(url);

  // Per-fork gate: poll every 5s and EXIT(0) once every filtered slide is rated
  // good/bad, so the solver's rating-gate node (which runs this server in the
  // FOREGROUND) unblocks — no detached process, no leaked capture pipe.
  if (exitWhenAllRated && filterSlides && filterSlides.length) {
    const ratingsFile = ratingsFilePath;
    const wanted = filterSlides;
    const poll = setInterval(() => {
      let ratings: Record<string, { status?: string }> = {};
      try { if (existsSync(ratingsFile)) ratings = JSON.parse(readFileSync(ratingsFile, "utf-8")); } catch { /* mid-write */ }
      const allRated = wanted.every((id) => { const s = ratings[id]?.status; return s === "good" || s === "bad"; });
      if (allRated) {
        clearInterval(poll);
        console.log(`\n  ✓ all ${wanted.length} slide(s) rated → rating server on :${port} exiting.\n`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1500).unref(); // force-exit if a browser keeps a socket open
      }
    }, 5000);
  }
}
