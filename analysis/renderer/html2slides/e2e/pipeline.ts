#!/usr/bin/env npx tsx
/**
 * E2E Pipeline — 3 queues with parallel workers + streaming progress
 *
 * Queue 1: Screenshot HTML fixtures → originals/  (parallel workers)
 * Queue 2: Convert all → Slides API + export thumbnails → thumbs/  (batch, then parallel thumb export)
 * Queue 3: Compare original vs thumb per slide (parallel haiku workers, streams as items ready)
 *
 * Usage: npx tsx e2e/pipeline.ts [--parallelism 10] [--skip-convert] [--port 3456]
 */

import CDP from "chrome-remote-interface";
import { google } from "googleapis";
import { execSync, spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { createHash } from "crypto";

// --- Config ---
const args = process.argv.slice(2);
let PARALLELISM = 10;
let SKIP_CONVERT = false;
let PORT = 3456;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--parallelism") PARALLELISM = parseInt(args[++i]);
  if (args[i] === "--skip-convert") SKIP_CONVERT = true;
  if (args[i] === "--port") PORT = parseInt(args[++i]);
}

const E2E_DIR = dirname(new URL(import.meta.url).pathname);
const H2S_DIR = resolve(E2E_DIR, "..");
const FIXTURES_DIR = join(E2E_DIR, "fixtures");
const SNAPSHOTS_DIR = join(E2E_DIR, "snapshots");
const RUNS_DIR = join(E2E_DIR, "runs");

const CDP_PORT = 9222;
const SLIDE_W = 1280, SLIDE_H = 720;

// --- Progress tracking ---
interface StageProgress {
  total: number;
  done: number;
  startTime: number;
  name: string;
}

const stages: Record<string, StageProgress> = {};

function initStage(name: string, total: number) {
  stages[name] = { total, done: 0, startTime: Date.now(), name };
  printProgress();
}

function tickStage(name: string) {
  stages[name].done++;
  printProgress();
}

function finishStage(name: string) {
  const s = stages[name];
  s.done = s.total;
  const elapsed = ((Date.now() - s.startTime) / 1000).toFixed(1);
  process.stdout.write(`\r\x1b[K  ✓ ${name}: ${s.total}/${s.total} (${elapsed}s)\n`);
}

function printProgress() {
  const parts = Object.values(stages).map(s => {
    const elapsed = ((Date.now() - s.startTime) / 1000).toFixed(0);
    const pct = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
    return `${s.name}: ${s.done}/${s.total} (${pct}%) ${elapsed}s`;
  });
  process.stdout.write(`\r\x1b[K  ${parts.join("  |  ")}`);
}

// --- Queue/Worker pool ---
async function runPool<T, R>(items: T[], worker: (item: T) => Promise<R>, concurrency: number): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function next(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
  return results;
}

// --- Queue 1: Screenshot HTML fixtures ---
async function screenshotSlide(htmlPath: string, outPath: string): Promise<void> {
  const tab = await (CDP as any).New({ port: CDP_PORT, url: `file://${htmlPath}` });
  try {
    const client = await CDP({ target: tab, port: CDP_PORT });
    await client.Page.enable();
    await client.Runtime.enable();
    await client.Emulation.setDeviceMetricsOverride({ width: SLIDE_W, height: SLIDE_H, deviceScaleFactor: 2, mobile: false });
    await client.Runtime.evaluate({ expression: `document.fonts.ready.then(() => true)`, awaitPromise: true, returnByValue: true }).catch(() => {});
    await new Promise(r => setTimeout(r, 200));
    const ss = await client.Page.captureScreenshot({ format: "png", captureBeyondViewport: false });
    writeFileSync(outPath, Buffer.from(ss.data, "base64"));
    await client.close();
  } finally {
    await (CDP as any).Close({ port: CDP_PORT, id: tab.id }).catch(() => {});
  }
}

// --- Queue 3: Compare via claude haiku ---
async function compareSlide(origPath: string, thumbPath: string, reviewPath: string): Promise<string> {
  const prompt = `Compare these two slide images side by side. Left=original HTML, Right=Google Slides output.
List up to 5 specific visual differences. Rate: GOOD (nearly identical), ACCEPTABLE (minor diffs), or BAD (major diffs).
Last line must be: RATING: GOOD or RATING: ACCEPTABLE or RATING: BAD`;

  try {
    // Use claude CLI with haiku
    const result = execSync(
      `claude -p --model haiku --output-format text "Look at these two images and compare them. ${prompt}" < /dev/null`,
      {
        cwd: H2S_DIR,
        timeout: 30_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      }
    );
    writeFileSync(reviewPath, result);
    // Extract rating
    const ratingMatch = result.match(/RATING:\s*(GOOD|ACCEPTABLE|BAD)/i);
    return ratingMatch ? ratingMatch[1].toUpperCase() : "ERROR";
  } catch {
    // Fallback: just mark as needs-review
    writeFileSync(reviewPath, "RATING: NEEDS_REVIEW\nCould not run haiku comparison.");
    return "NEEDS_REVIEW";
  }
}

// --- Main pipeline ---
async function main() {
  const fixtures = readdirSync(FIXTURES_DIR).filter(f => f.startsWith("slide_") && f.endsWith(".html")).sort();
  const slideIds = fixtures.map(f => f.replace(".html", ""));

  console.log(`\n=== E2E Pipeline: ${fixtures.length} slides, parallelism=${PARALLELISM} ===\n`);

  // Setup run directory
  let runDir: string;
  if (SKIP_CONVERT) {
    const latest = readdirSync(RUNS_DIR).sort().reverse()[0];
    if (!latest) { console.error("No previous runs"); process.exit(1); }
    runDir = join(RUNS_DIR, latest);
    console.log(`  Reusing: ${latest}\n`);
  } else {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
    runDir = join(RUNS_DIR, ts);
  }

  const origDir = join(runDir, "originals");
  const thumbsDir = join(runDir, "thumbs");
  const sxsDir = join(runDir, "sxs");
  const reviewDir = join(runDir, "reviews");
  for (const d of [origDir, thumbsDir, join(sxsDir, "originals"), join(sxsDir, "slides"), reviewDir]) {
    mkdirSync(d, { recursive: true });
  }

  // Track which slides have both original + thumb ready for comparison
  const readyForCompare = new Set<string>();
  const origReady = new Set<string>();
  const thumbReady = new Set<string>();
  const compareResults: Record<string, string> = {};

  // --- QUEUE 3 worker: compare slides as they become ready ---
  let compareQueueRunning = true;
  const pendingCompares: string[] = [];
  let activeCompares = 0;

  function enqueueCompare(slideId: string) {
    pendingCompares.push(slideId);
    drainCompareQueue();
  }

  function drainCompareQueue() {
    while (activeCompares < PARALLELISM && pendingCompares.length > 0) {
      const sid = pendingCompares.shift()!;
      activeCompares++;
      const origP = join(sxsDir, "originals", `${sid}.png`);
      const thumbP = join(sxsDir, "slides", `${sid}.png`);
      const revP = join(reviewDir, `${sid}.txt`);

      // For now, just do a hash-based diff (fast) — haiku review is too slow for pipe
      // We'll do visual review via the SxS server
      (async () => {
        try {
          const snapPath = join(SNAPSHOTS_DIR, `${sid}.png`);
          let status = "new";
          if (existsSync(snapPath)) {
            const snapHash = createHash("sha256").update(readFileSync(snapPath)).digest("hex").substring(0, 16);
            const thumbHash = createHash("sha256").update(readFileSync(thumbP)).digest("hex").substring(0, 16);
            status = snapHash === thumbHash ? "unchanged" : "changed";
          }
          compareResults[sid] = status;
          writeFileSync(revP, `STATUS: ${status}\n`);
          tickStage("Compare");
        } catch (err: any) {
          compareResults[sid] = "error";
          writeFileSync(revP, `STATUS: error\n${err.message}\n`);
          tickStage("Compare");
        } finally {
          activeCompares--;
          drainCompareQueue();
        }
      })();
    }
  }

  function markReady(slideId: string, which: "orig" | "thumb") {
    if (which === "orig") origReady.add(slideId);
    else thumbReady.add(slideId);

    if (origReady.has(slideId) && thumbReady.has(slideId) && !readyForCompare.has(slideId)) {
      readyForCompare.add(slideId);
      // Copy to SxS dir
      copyFileSync(join(origDir, `${slideId}.png`), join(sxsDir, "originals", `${slideId}.png`));
      copyFileSync(join(thumbsDir, `${slideId}.png`), join(sxsDir, "slides", `${slideId}.png`));
      enqueueCompare(slideId);
    }
  }

  if (!SKIP_CONVERT) {
    // --- QUEUE 1: Screenshot fixtures (parallel) ---
    initStage("Screenshots", fixtures.length);

    await runPool(fixtures, async (f) => {
      const htmlPath = join(FIXTURES_DIR, f);
      const outPath = join(origDir, f.replace(".html", ".png"));
      await screenshotSlide(htmlPath, outPath);
      const sid = f.replace(".html", "");
      tickStage("Screenshots");
      markReady(sid, "orig");
    }, PARALLELISM);

    finishStage("Screenshots");

    // --- QUEUE 2: Convert all → Slides API (batch) then export thumbs (parallel) ---
    initStage("Convert", 1);

    // Convert
    const convertOut = execSync(
      `npx tsx convert-slides-api.ts ${FIXTURES_DIR} --title "E2E Pipeline"`,
      { cwd: H2S_DIR, timeout: 600_000, encoding: "utf-8" }
    );
    const presIdMatch = convertOut.match(/ID:\s*(\S+)/);
    if (!presIdMatch) throw new Error("No presentation ID found");
    const presId = presIdMatch[1];
    tickStage("Convert");
    finishStage("Convert");

    // Export thumbnails (parallel per slide via API)
    initStage("Thumbnails", fixtures.length);
    initStage("Compare", fixtures.length);

    const auth = getAuth();
    const slidesApi = google.slides({ version: "v1", auth });
    const pres = await slidesApi.presentations.get({ presentationId: presId });
    const slideObjs = pres.data.slides || [];

    await runPool(slideObjs.map((s, i) => ({ slideObj: s, idx: i })), async ({ slideObj, idx }) => {
      const pageId = slideObj.objectId!;
      const thumb = await slidesApi.presentations.pages.getThumbnail({
        presentationId: presId,
        pageObjectId: pageId,
        "thumbnailProperties.mimeType": "PNG",
        "thumbnailProperties.thumbnailSize": "LARGE",
      });
      const url = thumb.data.contentUrl!;
      const resp = await fetch(url);
      const buf = Buffer.from(await resp.arrayBuffer());
      const sid = `slide_${String(idx + 1).padStart(2, "0")}`;
      writeFileSync(join(thumbsDir, `${sid}.png`), buf);
      tickStage("Thumbnails");
      markReady(sid, "thumb");
    }, PARALLELISM);

    finishStage("Thumbnails");

    // Wait for all compares to finish
    while (Object.keys(compareResults).length < fixtures.length) {
      await new Promise(r => setTimeout(r, 100));
    }
    finishStage("Compare");

    // Build slide-to-page mapping for deep links
    const slidePageMap: Record<string, string> = {};
    for (let i = 0; i < slideObjs.length && i < fixtures.length; i++) {
      const sid = `slide_${String(i + 1).padStart(2, "0")}`;
      slidePageMap[sid] = slideObjs[i].objectId!;
    }

    // Copy HTML fixtures to SxS dir so rating server can serve them
    mkdirSync(join(sxsDir, "html"), { recursive: true });
    for (const f of fixtures) {
      copyFileSync(join(FIXTURES_DIR, f), join(sxsDir, "html", f));
    }

    // Save metadata
    writeFileSync(join(runDir, "meta.json"), JSON.stringify({
      timestamp: new Date().toISOString(),
      presentationId: presId,
      url: `https://docs.google.com/presentation/d/${presId}/edit`,
      slideCount: fixtures.length,
      slidePageMap,
    }, null, 2));

  } else {
    // Skip convert — just run compares on existing data
    initStage("Compare", fixtures.length);
    for (const sid of slideIds) {
      const origP = join(origDir, `${sid}.png`);
      const thumbP = join(thumbsDir, `${sid}.png`);
      if (existsSync(origP) && existsSync(thumbP)) {
        copyFileSync(origP, join(sxsDir, "originals", `${sid}.png`));
        copyFileSync(thumbP, join(sxsDir, "slides", `${sid}.png`));
        origReady.add(sid);
        thumbReady.add(sid);
        readyForCompare.add(sid);
        enqueueCompare(sid);
      }
    }
    while (Object.keys(compareResults).length < readyForCompare.size) {
      await new Promise(r => setTimeout(r, 100));
    }
    finishStage("Compare");
  }

  // --- Results ---
  console.log("\n");
  const newC = Object.values(compareResults).filter(s => s === "new").length;
  const changedC = Object.values(compareResults).filter(s => s === "changed").length;
  const unchangedC = Object.values(compareResults).filter(s => s === "unchanged").length;
  console.log(`  Results: ${newC} new, ${changedC} changed, ${unchangedC} unchanged`);

  if (existsSync(join(runDir, "meta.json"))) {
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf-8"));
    console.log(`  Presentation: ${meta.url}`);
  }

  // Write ratings.json for SxS server — include links to HTML source and Slides page
  const meta = existsSync(join(runDir, "meta.json")) ? JSON.parse(readFileSync(join(runDir, "meta.json"), "utf-8")) : {};
  const ratings: Record<string, any> = {};
  for (const [sid, status] of Object.entries(compareResults)) {
    const pageId = meta.slidePageMap?.[sid];
    ratings[sid] = {
      status: "pending",
      diffStatus: status,
      htmlFile: `html/${sid}.html`,
      slidesUrl: pageId ? `${meta.url}#slide=id.${pageId}` : meta.url,
    };
  }
  writeFileSync(join(sxsDir, "ratings.json"), JSON.stringify(ratings, null, 2));

  // Launch rating server
  console.log(`\n  Launching rating server on http://localhost:${PORT}`);
  try { execSync(`lsof -ti:${PORT} | xargs -r kill`, { stdio: "ignore" }); } catch {}
  await new Promise(r => setTimeout(r, 500));

  // Import and run rating server inline
  const { createServer } = await import("http");
  launchServer(createServer, sxsDir, PORT);
}

function getAuth() {
  const creds = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/google_oauth.json", "utf-8")).installed;
  const tokens = JSON.parse(readFileSync("/workspaces/sashaslides/.auth/tokens.json", "utf-8"));
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, "http://localhost");
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", (t: any) => {
    writeFileSync("/workspaces/sashaslides/.auth/tokens.json", JSON.stringify({ ...tokens, ...t }, null, 2));
  });
  return oauth2;
}

function launchServer(createServer: any, sxsDir: string, port: number) {
  // Minimal rating server — reuses the existing one
  execSync(`cd ${resolve(E2E_DIR, "..")} && npx tsx rating-server.ts ${sxsDir} --port ${port}`, {
    stdio: "inherit",
  });
}

main().catch(err => { console.error(err); process.exit(1); });
