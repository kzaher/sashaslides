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
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { CLIENT_SCRIPT } from "./rating-server-client.js";

const args = process.argv.slice(2);
const resultsDir = resolve(args[0] || ".");
let port = 3456;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") port = parseInt(args[++i]);
}

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
  diffPng?: string;        // /tmp/.../diffs/diff_slide_NN.png (pixelmatch output)
  diffStatus?: string;     // "ok" | "regressed" | "new" | "missing-current"
  diffPixels?: number;
  // Rasterized regions the converter emitted as addImage instead of native
  // primitives (visuals, images, emoji fallbacks). Surface these to the user
  // because any region in this list represents a fidelity compromise.
  renderedRegions?: RenderedRegion[];
}

function findComparisons(): SlideComparison[] {
  const comparisons: SlideComparison[] = [];

  // Check for originals/ and slides/ subdirectories
  const originalsDir = existsSync(join(resultsDir, "originals")) ? join(resultsDir, "originals") : resultsDir;
  const slidesDir = existsSync(join(resultsDir, "slides")) ? join(resultsDir, "slides") : resultsDir;

  // Pattern 1: originals/slide_01.png + slides/slide_01.png
  if (originalsDir !== slidesDir) {
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
  const allFiles = readdirSync(resultsDir).filter(f => f.endsWith("_original.png")).sort();
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
      if (htmlFiles[i]) c.htmlFile = join(meta.htmlDir, htmlFiles[i]);
      if (meta.presentationId) {
        const slideFrag = meta.slideIds?.[i] ? `#slide=id.${meta.slideIds[i]}` : "";
        c.slidesUrl = `https://docs.google.com/presentation/d/${meta.presentationId}/edit${slideFrag}`;
      }
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

  return comparisons;
}

function saveRating(id: string, status: "good" | "bad", comment?: string, annotationPng?: string) {
  const ratingsFile = join(resultsDir, "ratings.json");
  const ratings = existsSync(ratingsFile) ? JSON.parse(readFileSync(ratingsFile, "utf-8")) : {};
  const entry: any = { status, comment, ratedAt: new Date().toISOString() };
  if (annotationPng) {
    // Annotations persist under resultsDir/annotations/ so /tmp wipes only
    // break the PNGs, not the metadata.
    const annotDir = join(resultsDir, "annotations");
    mkdirSync(annotDir, { recursive: true });
    const annotPath = join(annotDir, `${id}.png`);
    const b64 = annotationPng.replace(/^data:image\/png;base64,/, "");
    writeFileSync(annotPath, Buffer.from(b64, "base64"));
    entry.annotation = annotPath;
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
}

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>html2slides Rating</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; }
  .header { padding: 16px 24px; background: #16213e; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { font-size: 18px; font-weight: 600; }
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
  .draw-toolbar { display: flex; gap: 8px; padding: 0 24px; align-items: center; font-size: 12px; color: #aaa; }
  .draw-toolbar button { background: #2a2a4e; color: #e0e0e0; border: 1px solid #444; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .draw-toolbar button.active { background: #e94560; border-color: #e94560; color: white; }
  .draw-toolbar input[type=color] { width: 28px; height: 24px; border: 1px solid #444; border-radius: 4px; background: transparent; cursor: pointer; }
  .labels { display: flex; gap: 4px; padding: 0 24px; }
  .labels span { width: 49%; text-align: center; font-size: 12px; color: #666; text-transform: uppercase; letter-spacing: 1px; }
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
  #goldenReport { margin: 24px; padding: 12px 16px; background: #0f1a30; border-left: 4px solid #f1c40f; border-radius: 0 6px 6px 0; font-size: 13px; color: #ccc; font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<script type="module">${CLIENT_SCRIPT}</script>
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
      const { id, status, comment, annotation } = JSON.parse(body);
      saveRating(id, status, comment, annotation);
      console.log(`RATING: ${id} → ${status}${comment ? ` | ${comment}` : ''}${annotation ? ' [+annotation]' : ''}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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

  res.writeHead(404);
  res.end("Not found");
});

server.listen(port, () => {
  console.log(`\n  Rating server: http://localhost:${port}\n`);
  console.log(`  Results dir: ${resultsDir}`);
  console.log(`  Comparisons: ${findComparisons().length}`);
  console.log(`\n  Keyboard: g=good, b=bad, n/→=next, p/←=prev\n`);
});
