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

const args = process.argv.slice(2);
const resultsDir = resolve(args[0] || ".");
let port = 3456;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") port = parseInt(args[++i]);
}

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
</style>
</head>
<body>
<div class="header">
  <h1>html2slides Fidelity Rating</h1>
  <div class="stats" id="stats"></div>
</div>
<div id="regressionBanner"></div>
<div class="nav" id="nav"></div>
<div class="labels"><span>Original HTML</span><span>Google Slides</span></div>
<div class="slide-pair" id="pair"></div>
<div class="draw-toolbar" id="drawToolbar">
  <label style="display:flex; gap:6px; align-items:center; cursor:pointer;">
    <input type="checkbox" id="showDiff" onchange="toggleShowDiff()"> Show diff at full size (hide small diff panel)
  </label>
  <span style="width: 24px;"></span>
  <span>Draw on Slides render:</span>
  <button id="drawToggle" onclick="toggleDraw()">Draw</button>
  <input type="color" id="drawColor" value="#e94560">
  <label><input type="range" id="drawSize" min="2" max="20" value="6"> px</label>
  <button onclick="clearDraw()">Clear</button>
</div>
<div class="slide-id" id="slideId"></div>
<div class="slide-links" id="slideLinks"></div>
<div class="comment-box">
  <textarea id="comment" placeholder="What's wrong? (optional — saved with Bad ratings)" rows="2"></textarea>
</div>
<div class="actions">
  <button class="btn btn-good" onclick="rate('good')">Good ✓</button>
  <button class="btn btn-bad" onclick="rate('bad')">Bad ✗</button>
  <button class="btn btn-skip" onclick="navigate(1)">Skip →</button>
</div>
<div id="savedComment"></div>
<div class="analysis" id="analysis" style="display:none"></div>
<div id="goldenReport" style="margin: 24px; padding: 12px 16px; background: #0f1a30; border-left: 4px solid #f1c40f; border-radius: 0 6px 6px 0; font-size: 13px; color: #ccc; font-family: ui-monospace, monospace;"></div>

<script>
let comparisons = [];
let currentIdx = 0;

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
  const pairHtml =
    '<div class="panel original"><img id="originalImg" src="/img?path=' + encodeURIComponent(c.originalPng) + '">' + diffOverlay + '</div>' +
    '<div class="panel slides"><img id="slidesImg" src="/img?path=' + encodeURIComponent(c.slidesPng) + '"><canvas id="drawCanvas"></canvas></div>';
  document.getElementById('pair').innerHTML = pairHtml;
  setupDrawCanvas(c.annotationPng);
  if (showDiff) computeClientSideDiff();

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
  const visible = visibleComparisons();
  const visIdx = visible.findIndex(x => x.id === c.id);
  document.getElementById('slideId').innerHTML = c.id + badge + diffBadge + ' (' + (visIdx >= 0 ? visIdx+1 : '-') + '/' + visible.length + ' visible, ' + comparisons.length + ' total — ' + (showAll ? '<a href="#" onclick="showAll=false; render(); return false">only diffs</a>' : '<a href="#" onclick="showAll=true; render(); return false">show all</a>') + ')';

  // Links to HTML source and Google Slides page
  let links = '';
  if (c.htmlFile) links += '<a href="/html?path=' + encodeURIComponent(c.htmlFile) + '" target="_blank">View HTML Source</a>';
  if (c.slidesUrl) links += '<a href="' + c.slidesUrl + '" target="_blank">Open in Google Slides</a>';
  document.getElementById('slideLinks').innerHTML = links;

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

  // Clear comment box for new slide
  document.getElementById('comment').value = c.comment || '';
}

async function rate(status) {
  const c = comparisons[currentIdx];
  const comment = document.getElementById('comment').value.trim();
  // Export annotation canvas if anything was drawn.
  let annotation;
  const canvas = document.getElementById('drawCanvas');
  if (canvas && canvasHasStrokes) {
    annotation = canvas.toDataURL('image/png');
  }
  await fetch('/api/rate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.id, status, comment: comment || undefined, annotation }),
  });
  c.status = status;
  c.comment = comment || undefined;
  navigate(1);
}

// --- Draw overlay on Slides render ---
let drawMode = false;
let canvasHasStrokes = false;
let drawHistory = []; // stack of ImageData snapshots, one per completed stroke
function undoDraw() {
  const canvas = document.getElementById('drawCanvas');
  if (!canvas || drawHistory.length === 0) return;
  const ctx = canvas.getContext('2d');
  const prev = drawHistory.pop();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (prev) ctx.putImageData(prev, 0, 0);
  canvasHasStrokes = drawHistory.length > 0 || !!prev;
}
let showDiff = false;
function toggleShowDiff() {
  showDiff = document.getElementById('showDiff').checked;
  render();
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
}
function setupDrawCanvas(annotationPath) {
  const img = document.getElementById('slidesImg');
  const canvas = document.getElementById('drawCanvas');
  if (!img || !canvas) return;
  canvas.style.pointerEvents = drawMode ? 'auto' : 'none';
  document.getElementById('drawToggle').classList.toggle('active', drawMode);
  canvasHasStrokes = false;
  drawHistory = [];
  const init = () => {
    canvas.width = img.naturalWidth || img.clientWidth;
    canvas.height = img.naturalHeight || img.clientHeight;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (annotationPath) {
      const saved = new Image();
      saved.onload = () => { ctx.drawImage(saved, 0, 0, canvas.width, canvas.height); canvasHasStrokes = true; };
      saved.src = '/img?path=' + encodeURIComponent(annotationPath) + '&t=' + Date.now();
    }
  };
  if (img.complete && img.naturalWidth) init();
  else img.onload = init;

  let drawing = false;
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
    drawHistory.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (drawHistory.length > 50) drawHistory.shift();
    ctx.strokeStyle = document.getElementById('drawColor').value;
    ctx.lineWidth = parseFloat(document.getElementById('drawSize').value) * (canvas.width / canvas.getBoundingClientRect().width);
    const p = getPos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y);
  };
  canvas.onpointermove = (e) => {
    if (!drawing) return;
    const ctx = canvas.getContext('2d');
    const p = getPos(e); ctx.lineTo(p.x, p.y); ctx.stroke();
    canvasHasStrokes = true;
  };
  canvas.onpointerup = () => { drawing = false; };
  canvas.onpointercancel = () => { drawing = false; };
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
  if (e.key === 'b') { commentEl.focus(); e.preventDefault(); }
  if (e.key === 'Enter') { const comment = commentEl.value.trim(); if (comment) rate('bad'); }
});

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
      res.writeHead(200, { "Content-Type": "image/png" });
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
