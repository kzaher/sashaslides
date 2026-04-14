#!/usr/bin/env npx tsx
/**
 * E2E test runner for html2slides converter.
 *
 * Pipeline:
 *   1. Screenshot all HTML fixtures (originals)
 *   2. Convert fixtures → Google Slides via API
 *   3. Export Slides thumbnails
 *   4. Compare current thumbnails vs previous snapshots → detect regressions
 *   5. Launch SxS rating server for review
 *
 * Directory structure:
 *   e2e/
 *     fixtures/          ← HTML slide files (slide_01.html ... slide_30.html)
 *     snapshots/         ← blessed thumbnails from previous accepted runs
 *     runs/
 *       <timestamp>/     ← each run's artifacts
 *         originals/     ← HTML screenshots
 *         thumbs/        ← Slides API thumbnails
 *         diff-report.json ← what changed vs snapshots
 *     eval-set/          ← rated slides (good+bad saved here, skip ignored)
 *
 * Usage:
 *   npx tsx e2e/run-e2e.ts [--skip-convert] [--port 3456]
 *
 * --skip-convert  Reuse the latest run's conversion (skip API calls)
 * --port N        Rating server port (default 3456)
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { createServer } from "http";
import { createHash } from "crypto";

const E2E_DIR = dirname(new URL(import.meta.url).pathname);
const H2S_DIR = resolve(E2E_DIR, "..");
const FIXTURES_DIR = join(E2E_DIR, "fixtures");
const SNAPSHOTS_DIR = join(E2E_DIR, "snapshots");
const RUNS_DIR = join(E2E_DIR, "runs");
const EVAL_DIR = join(E2E_DIR, "eval-set");

// Parse args
const args = process.argv.slice(2);
const skipConvert = args.includes("--skip-convert");
let port = 3456;
const portIdx = args.indexOf("--port");
if (portIdx >= 0) port = parseInt(args[portIdx + 1]);

function run(cmd: string, opts?: { cwd?: string; timeout?: number }): string {
  console.log(`  $ ${cmd.substring(0, 120)}${cmd.length > 120 ? "..." : ""}`);
  return execSync(cmd, {
    cwd: opts?.cwd || H2S_DIR,
    timeout: opts?.timeout || 300_000,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex").substring(0, 16);
}

async function main() {
  // Setup directories
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  mkdirSync(RUNS_DIR, { recursive: true });
  mkdirSync(EVAL_DIR, { recursive: true });

  // Find fixtures
  const fixtures = readdirSync(FIXTURES_DIR)
    .filter(f => f.startsWith("slide_") && f.endsWith(".html"))
    .sort();
  console.log(`\n=== E2E Test: ${fixtures.length} fixtures ===\n`);

  // Determine run directory
  let runDir: string;
  if (skipConvert) {
    // Find latest run
    const runs = readdirSync(RUNS_DIR).sort().reverse();
    if (runs.length === 0) {
      console.error("No previous runs found. Run without --skip-convert first.");
      process.exit(1);
    }
    runDir = join(RUNS_DIR, runs[0]);
    console.log(`Reusing latest run: ${runs[0]}`);
  } else {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
    runDir = join(RUNS_DIR, ts);
    mkdirSync(runDir, { recursive: true });
  }

  const originalsDir = join(runDir, "originals");
  const thumbsDir = join(runDir, "thumbs");
  mkdirSync(originalsDir, { recursive: true });
  mkdirSync(thumbsDir, { recursive: true });

  if (!skipConvert) {
    // Step 1: Screenshot HTML fixtures
    console.log("\n--- Step 1: Screenshot HTML fixtures ---");
    try {
      const out = run(
        `npx tsx /workspaces/sashaslides/analysis/scripts/screenshot-html-slides.ts ${FIXTURES_DIR} ${originalsDir}`,
        { timeout: 120_000 }
      );
      console.log(out.trim());
    } catch (err: any) {
      console.error("Screenshot failed:", err.stderr?.substring(0, 500) || err.message);
      process.exit(1);
    }

    // Step 2: Convert via Slides API
    console.log("\n--- Step 2: Convert HTML → Google Slides ---");
    let presId: string;
    try {
      const out = run(
        `npx tsx convert-slides-api.ts ${FIXTURES_DIR} --title "E2E Test ${new Date().toISOString().substring(0, 10)}"`,
        { timeout: 600_000 }
      );
      console.log(out.trim());
      // Extract presentation ID
      const idMatch = out.match(/ID:\s*(\S+)/);
      if (!idMatch) throw new Error("Could not find presentation ID in output");
      presId = idMatch[1];
    } catch (err: any) {
      console.error("Conversion failed:", err.stderr?.substring(0, 500) || err.message);
      process.exit(1);
    }

    // Step 3: Export thumbnails
    console.log("\n--- Step 3: Export Slides thumbnails ---");
    try {
      const out = run(`npx tsx export-thumbs.ts ${presId} ${thumbsDir}`, { timeout: 120_000 });
      console.log(out.trim());
    } catch (err: any) {
      console.error("Thumbnail export failed:", err.stderr?.substring(0, 500) || err.message);
      process.exit(1);
    }

    // Save metadata
    writeFileSync(join(runDir, "meta.json"), JSON.stringify({
      timestamp: new Date().toISOString(),
      presentationId: presId,
      fixtureCount: fixtures.length,
      presentationUrl: `https://docs.google.com/presentation/d/${presId}/edit`,
    }, null, 2));
  }

  // Step 4: Compare with snapshots — detect regressions
  console.log("\n--- Step 4: Compare with previous snapshots ---");
  const diffReport: Record<string, { status: string; detail?: string }> = {};
  const thumbFiles = readdirSync(thumbsDir).filter(f => f.endsWith(".png")).sort();
  const snapshotFiles = new Set(
    existsSync(SNAPSHOTS_DIR) ? readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith(".png")) : []
  );

  let newCount = 0, changedCount = 0, unchangedCount = 0;
  for (const tf of thumbFiles) {
    const snapshotPath = join(SNAPSHOTS_DIR, tf);
    const thumbPath = join(thumbsDir, tf);
    const slideId = tf.replace(".png", "");

    if (!snapshotFiles.has(tf)) {
      diffReport[slideId] = { status: "new" };
      newCount++;
    } else {
      const snapHash = fileHash(snapshotPath);
      const thumbHash = fileHash(thumbPath);
      if (snapHash !== thumbHash) {
        diffReport[slideId] = { status: "changed", detail: `${snapHash} → ${thumbHash}` };
        changedCount++;
      } else {
        diffReport[slideId] = { status: "unchanged" };
        unchangedCount++;
      }
    }
  }

  writeFileSync(join(runDir, "diff-report.json"), JSON.stringify(diffReport, null, 2));
  console.log(`  New: ${newCount}, Changed: ${changedCount}, Unchanged: ${unchangedCount}`);

  // Step 5: Prepare SxS comparison directory
  console.log("\n--- Step 5: Setting up SxS review ---");
  const sxsDir = join(runDir, "sxs");
  mkdirSync(join(sxsDir, "originals"), { recursive: true });
  mkdirSync(join(sxsDir, "slides"), { recursive: true });

  // Copy originals and thumbs for review
  for (const tf of thumbFiles) {
    const slideId = tf.replace(".png", "");
    const origPath = join(originalsDir, tf);
    const thumbPath = join(thumbsDir, tf);
    if (existsSync(origPath)) copyFileSync(origPath, join(sxsDir, "originals", tf));
    if (existsSync(thumbPath)) copyFileSync(thumbPath, join(sxsDir, "slides", tf));
  }

  // Inject diff status into ratings.json so the UI can show it
  const initialRatings: Record<string, any> = {};
  for (const [slideId, info] of Object.entries(diffReport)) {
    initialRatings[slideId] = { diffStatus: info.status };
  }
  writeFileSync(join(sxsDir, "ratings.json"), JSON.stringify(initialRatings, null, 2));

  console.log(`\n=== Results ===`);
  console.log(`  Run directory: ${runDir}`);
  console.log(`  Presentation: ${existsSync(join(runDir, "meta.json")) ? JSON.parse(readFileSync(join(runDir, "meta.json"), "utf-8")).presentationUrl : "(reused)"}`);
  console.log(`  ${thumbFiles.length} slides: ${newCount} new, ${changedCount} changed, ${unchangedCount} unchanged`);

  // Step 6: Launch rating server
  console.log(`\n--- Launching SxS rating server ---`);
  console.log(`  Directory: ${sxsDir}`);

  // Kill any existing server on the port
  try { execSync(`lsof -ti:${port} | xargs -r kill`, { stdio: "ignore" }); } catch {}
  await new Promise(r => setTimeout(r, 500));

  // Launch the rating server with eval-set support
  launchRatingServer(sxsDir, port, runDir);
}

function launchRatingServer(sxsDir: string, port: number, runDir: string) {
  // Enhanced rating server that saves to eval-set on good/bad, skips on skip
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(RATING_HTML);
      return;
    }

    if (url.pathname === "/api/comparisons") {
      const comparisons = findComparisons(sxsDir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(comparisons));
      return;
    }

    if (url.pathname === "/api/rate" && req.method === "POST") {
      let body = "";
      req.on("data", (d: string) => (body += d));
      req.on("end", () => {
        const { id, status, comment } = JSON.parse(body);
        saveRating(sxsDir, runDir, id, status, comment);
        console.log(`  RATE: ${id} → ${status}${comment ? ` | ${comment}` : ""}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (url.pathname === "/img") {
      const imgPath = url.searchParams.get("path") || "";
      if (existsSync(imgPath) && imgPath.endsWith(".png")) {
        res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=3600" });
        res.end(readFileSync(imgPath));
        return;
      }
      res.writeHead(404); res.end("Not found"); return;
    }

    res.writeHead(404); res.end("Not found");
  });

  server.listen(port, () => {
    console.log(`\n  Rating server: http://localhost:${port}`);
    console.log(`  Keys: g=good, b=focus comment (Enter to submit bad), s=skip, →/n=next, ←/p=prev`);
    console.log(`\n  good/bad → saved to eval-set/`);
    console.log(`  skip → not saved to eval-set\n`);
  });
}

interface SlideComparison {
  id: string;
  originalPng: string;
  slidesPng: string;
  status: "pending" | "good" | "bad" | "skip";
  diffStatus?: string;
  comment?: string;
}

function findComparisons(sxsDir: string): SlideComparison[] {
  const originalsDir = join(sxsDir, "originals");
  const slidesDir = join(sxsDir, "slides");
  const ratingsFile = join(sxsDir, "ratings.json");
  const ratings = existsSync(ratingsFile) ? JSON.parse(readFileSync(ratingsFile, "utf-8")) : {};

  const origFiles = readdirSync(originalsDir).filter(f => f.match(/slide_\d+.*\.png$/)).sort();
  return origFiles.map(f => {
    const id = f.replace(".png", "");
    const slidesFile = join(slidesDir, f);
    if (!existsSync(slidesFile)) return null;
    return {
      id,
      originalPng: join(originalsDir, f),
      slidesPng: slidesFile,
      status: ratings[id]?.status === "good" || ratings[id]?.status === "bad" || ratings[id]?.status === "skip"
        ? ratings[id].status : "pending",
      diffStatus: ratings[id]?.diffStatus,
      comment: ratings[id]?.comment,
    };
  }).filter(Boolean) as SlideComparison[];
}

function saveRating(sxsDir: string, runDir: string, id: string, status: "good" | "bad" | "skip", comment?: string) {
  // Update ratings.json
  const ratingsFile = join(sxsDir, "ratings.json");
  const ratings = existsSync(ratingsFile) ? JSON.parse(readFileSync(ratingsFile, "utf-8")) : {};
  ratings[id] = { ...ratings[id], status, comment, ratedAt: new Date().toISOString() };
  writeFileSync(ratingsFile, JSON.stringify(ratings, null, 2));

  // Save to eval-set if good or bad (skip = don't save)
  if (status === "good" || status === "bad") {
    const evalSlideDir = join(EVAL_DIR, id);
    mkdirSync(evalSlideDir, { recursive: true });

    const origSrc = join(sxsDir, "originals", `${id}.png`);
    const thumbSrc = join(sxsDir, "slides", `${id}.png`);
    if (existsSync(origSrc)) copyFileSync(origSrc, join(evalSlideDir, "original.png"));
    if (existsSync(thumbSrc)) copyFileSync(thumbSrc, join(evalSlideDir, "slides.png"));

    // Save the fixture HTML too
    const htmlSrc = join(FIXTURES_DIR, `${id}.html`);
    if (existsSync(htmlSrc)) copyFileSync(htmlSrc, join(evalSlideDir, "fixture.html"));

    writeFileSync(join(evalSlideDir, "rating.json"), JSON.stringify({
      status,
      comment,
      ratedAt: new Date().toISOString(),
      runDir: runDir,
    }, null, 2));

    // If good, also update snapshots (bless this version)
    if (status === "good") {
      copyFileSync(thumbSrc, join(SNAPSHOTS_DIR, `${id}.png`));
    }
  }
}

const RATING_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>E2E html2slides Rating</title>
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
  .btn-skip { background: #7f8c8d; color: white; }
  .btn-skip:hover { background: #95a5a6; }
  .slide-id { text-align: center; padding: 8px; font-size: 14px; color: #888; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; margin-left: 8px; }
  .badge-good { background: #27ae60; color: white; }
  .badge-bad { background: #c0392b; color: white; }
  .badge-skip { background: #7f8c8d; color: white; }
  .badge-pending { background: #555; color: #aaa; }
  .badge-new { background: #8e44ad; color: white; }
  .badge-changed { background: #e67e22; color: white; }
  .badge-unchanged { background: #2c3e50; color: #95a5a6; }
  .nav { display: flex; gap: 4px; padding: 8px 24px; flex-wrap: wrap; }
  .nav a { color: #4a90d9; text-decoration: none; font-size: 12px; padding: 4px 8px; border-radius: 4px; cursor: pointer; }
  .nav a:hover { background: #2a2a4e; }
  .nav a.current { background: #4a90d9; color: white; }
  .nav a.rated-good { border-bottom: 2px solid #27ae60; }
  .nav a.rated-bad { border-bottom: 2px solid #c0392b; }
  .nav a.rated-skip { border-bottom: 2px solid #7f8c8d; }
  .comment-box { margin: 8px 24px; display: flex; gap: 8px; }
  .comment-box textarea { flex: 1; padding: 10px 12px; border: 1px solid #444; border-radius: 6px; background: #2a2a4e; color: #e0e0e0; font-family: inherit; font-size: 14px; resize: vertical; min-height: 36px; }
  .comment-box textarea::placeholder { color: #666; }
  .comment-box textarea:focus { outline: none; border-color: #4a90d9; }
  .saved-comment { margin: 4px 24px; padding: 8px 12px; background: #2a2a4e; border-left: 3px solid #e94560; border-radius: 0 6px 6px 0; font-size: 13px; color: #ccc; }
</style>
</head>
<body>
<div class="header">
  <h1>E2E html2slides Fidelity Rating</h1>
  <div class="stats" id="stats"></div>
</div>
<div class="nav" id="nav"></div>
<div class="labels"><span>Original HTML (blue border)</span><span>Google Slides (red border)</span></div>
<div class="slide-pair" id="pair"></div>
<div class="slide-id" id="slideId"></div>
<div class="comment-box">
  <textarea id="comment" placeholder="What's wrong? (optional)" rows="2"></textarea>
</div>
<div class="actions">
  <button class="btn btn-good" onclick="rate('good')">Good (g)</button>
  <button class="btn btn-bad" onclick="rate('bad')">Bad (b→type→Enter)</button>
  <button class="btn btn-skip" onclick="rate('skip')">Skip (s)</button>
</div>
<div id="savedComment"></div>

<script>
let comparisons = [];
let currentIdx = 0;

async function load() {
  const resp = await fetch('/api/comparisons');
  comparisons = await resp.json();
  const pendingIdx = comparisons.findIndex(c => c.status === 'pending');
  currentIdx = pendingIdx >= 0 ? pendingIdx : 0;
  render();
}

function render() {
  const c = comparisons[currentIdx];
  if (!c) return;

  document.getElementById('pair').innerHTML =
    '<img class="original" src="/img?path=' + encodeURIComponent(c.originalPng) + '&t=' + Date.now() + '">' +
    '<img class="slides" src="/img?path=' + encodeURIComponent(c.slidesPng) + '&t=' + Date.now() + '">';

  let badges = '<span class="badge badge-' + c.status + '">' + c.status + '</span>';
  if (c.diffStatus) badges += '<span class="badge badge-' + c.diffStatus + '">' + c.diffStatus + '</span>';
  document.getElementById('slideId').innerHTML = c.id + badges + ' (' + (currentIdx+1) + '/' + comparisons.length + ')';

  const good = comparisons.filter(c => c.status === 'good').length;
  const bad = comparisons.filter(c => c.status === 'bad').length;
  const skip = comparisons.filter(c => c.status === 'skip').length;
  const pending = comparisons.filter(c => c.status === 'pending').length;
  document.getElementById('stats').textContent =
    good + ' good / ' + bad + ' bad / ' + skip + ' skip / ' + pending + ' pending';

  document.getElementById('nav').innerHTML = comparisons.map((c, i) => {
    let cls = i === currentIdx ? 'current' : '';
    if (c.status !== 'pending') cls += ' rated-' + c.status;
    return '<a class="' + cls + '" onclick="currentIdx=' + i + '; render();">' +
      c.id.replace('slide_', '') + '</a>';
  }).join('');

  const savedEl = document.getElementById('savedComment');
  if (c.comment) {
    savedEl.innerHTML = '<div class="saved-comment">' + c.comment.replace(/</g, '&lt;') + '</div>';
  } else {
    savedEl.innerHTML = '';
  }
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
  if (document.activeElement === commentEl) {
    if (e.key === 'Escape') { commentEl.blur(); e.preventDefault(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { rate('bad'); e.preventDefault(); }
    return;
  }
  if (e.key === 'ArrowRight' || e.key === 'n') navigate(1);
  if (e.key === 'ArrowLeft' || e.key === 'p') navigate(-1);
  if (e.key === 'g') rate('good');
  if (e.key === 's') rate('skip');
  if (e.key === 'b') { commentEl.focus(); e.preventDefault(); }
  if (e.key === 'Enter') { const comment = commentEl.value.trim(); if (comment) rate('bad'); }
});

load();
</script>
</body>
</html>`;

main().catch(err => { console.error(err); process.exit(1); });
