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
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, copyFileSync } from "fs";
import { join, resolve } from "path";

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

  // Load existing ratings
  const ratingsFile = join(resultsDir, "ratings.json");
  if (existsSync(ratingsFile)) {
    const ratings = JSON.parse(readFileSync(ratingsFile, "utf-8"));
    for (const c of comparisons) {
      if (ratings[c.id]) {
        c.status = ratings[c.id].status;
        c.comment = ratings[c.id].comment;
        c.analysis = ratings[c.id].analysis;
        c.htmlFile = ratings[c.id].htmlFile;
        c.slidesUrl = ratings[c.id].slidesUrl;
      }
    }
  }

  return comparisons;
}

function saveRating(id: string, status: "good" | "bad", comment?: string) {
  const ratingsFile = join(resultsDir, "ratings.json");
  const ratings = existsSync(ratingsFile) ? JSON.parse(readFileSync(ratingsFile, "utf-8")) : {};
  ratings[id] = { status, comment, ratedAt: new Date().toISOString() };
  writeFileSync(ratingsFile, JSON.stringify(ratings, null, 2));

  // If good, copy to regression snapshots
  if (status === "good") {
    const snapshotDir = join(resultsDir, "regression-snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    const comp = findComparisons().find(c => c.id === id);
    if (comp) {
      copyFileSync(comp.originalPng, join(snapshotDir, `${id}_original.png`));
      copyFileSync(comp.slidesPng, join(snapshotDir, `${id}_slides.png`));
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
  .slide-pair { display: flex; gap: 4px; padding: 12px 24px; align-items: flex-start; }
  .slide-pair img { width: 49%; border: 2px solid #333; border-radius: 4px; }
  .slide-pair img.original { border-color: #4a90d9; }
  .slide-pair img.slides { border-color: #e94560; }
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
<div class="nav" id="nav"></div>
<div class="labels"><span>Original HTML</span><span>Google Slides</span></div>
<div class="slide-pair" id="pair"></div>
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

<script>
let comparisons = [];
let currentIdx = 0;

async function load() {
  const resp = await fetch('/api/comparisons');
  comparisons = await resp.json();
  // Find first pending
  const pendingIdx = comparisons.findIndex(c => c.status === 'pending');
  currentIdx = pendingIdx >= 0 ? pendingIdx : 0;
  render();
}

function render() {
  const c = comparisons[currentIdx];
  if (!c) return;

  document.getElementById('pair').innerHTML =
    '<img class="original" src="/img?path=' + encodeURIComponent(c.originalPng) + '">' +
    '<img class="slides" src="/img?path=' + encodeURIComponent(c.slidesPng) + '">';

  const badge = '<span class="status-badge status-' + c.status + '">' + c.status + '</span>';
  document.getElementById('slideId').innerHTML = c.id + badge + ' (' + (currentIdx+1) + '/' + comparisons.length + ')';

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

  // Nav
  document.getElementById('nav').innerHTML = comparisons.map((c, i) =>
    '<a href="#" class="' + (i === currentIdx ? 'current' : '') + ' status-' + c.status + '" onclick="currentIdx=' + i + '; render(); return false;">' + c.id.replace('slide_', 'S') + '</a>'
  ).join('');

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
  await fetch('/api/rate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: c.id, status, comment: comment || undefined }),
  });
  c.status = status;
  c.comment = comment || undefined;
  navigate(1);
}

function navigate(delta) {
  currentIdx = Math.max(0, Math.min(comparisons.length - 1, currentIdx + delta));
  render();
}

document.addEventListener('keydown', e => {
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

  if (url.pathname === "/api/rate" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { id, status, comment } = JSON.parse(body);
      saveRating(id, status, comment);
      console.log(`RATING: ${id} → ${status}${comment ? ` | ${comment}` : ''}`);
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
