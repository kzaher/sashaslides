/**
 * record-rendering-lib.ts — recording pipeline as a callable library.
 *
 * Modes (each subsumes the cheaper one):
 *   "pptx"          per-slide pptx only.            (≈ 5 s/slide)
 *   "screenshots"   pptx + Chrome HTML screenshots. (≈ 6 s/slide)
 *   "full"          pptx + screenshots + Slides upload + thumbs scrape.
 *                                                    (≈ 30 s + 5 s/slide)
 *
 * Output layout under <out>:
 *   pptx/<slide_id>.pptx        per-slide pptx               (modes: pptx, screenshots, full)
 *   originals/<slide_id>.png    Chrome screenshot of fixture (modes: screenshots, full)
 *   thumbs/<slide_id>.png       Slides-rendered thumbnail    (mode: full)
 *   thumbs/manifest.json        presentation_id + oid table  (mode: full)
 *   thumbs/rendered-regions.json                              (mode: full)
 *
 * Idempotent per-step: a step is skipped if its primary output already
 * exists.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { Readable } from "stream";
import { pathToFileURL } from "url";
import CDPDefault from "chrome-remote-interface";
import { google } from "googleapis";
import { runConvertPptx } from "../../../html2slides/convert-pptx-io";
import { DEV_CREDENTIALS_PATH, DEV_TOKENS_PATH, loadDevOAuthClient } from "../../../html2slides/dev-google-auth.ts";
import { DEFAULT_CAPTURE_CHROME_PORT, openChromeTab } from "../../../html2slides/reverse/chrome-capture.ts";
import { exportThumbs } from "../../../html2slides/export-thumbs-lib";
import type { CdpModule } from "../../../../types/cdp-types.ts";

// chrome-remote-interface ships no .d.ts; its default export is declared
// `unknown` (types/ambient.d.ts). Narrow it to the shared typed boundary once.
const CDP = CDPDefault as CdpModule;

export type Mode = "pptx" | "screenshots" | "full";

export interface RecordRenderingOpts {
  slides: string[];
  out: string;
  title?: string;
  fixtures?: string;
  mode?: Mode;
  /** The DevTools port of the headless Chrome that captures and reaps tabs. Default DEFAULT_CAPTURE_CHROME_PORT. */
  chromePort?: number;
}

export interface RecordRenderingResult {
  pptxDir: string;
  originalsDir?: string;
  thumbsDir?: string;
  presId?: string;
}

/**
 * Bounded-concurrency map: run `fn(item)` for every item in `items`,
 * never more than `concurrency` in flight at a time. Returns the
 * resolved values in the same order as `items`. Errors bubble out
 * (first rejection wins; other in-flight tasks keep running but their
 * results are discarded).
 *
 * Used by the per-slide loops below: convert-pptx and the CDP
 * screenshot capture both open a fresh Chrome tab per slide; >4
 * concurrent tabs occasionally drop the WebSocket. concurrency=4 is
 * the empirical sweet spot (≈4× speedup over fully serial without the
 * tab-thrash failures).
 */
async function pLimit<T, R>(concurrency: number, items: readonly T[], fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;
  let firstErr: unknown = null;
  async function worker() {
    while (firstErr == null) {
      const i = nextIdx++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (firstErr == null) firstErr = e;
      }
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  if (firstErr != null) throw firstErr;
  return results;
}

/**
 * The ONE bounded-concurrency knob for every step that opens Chrome tabs (pptx
 * DOM-extraction AND screenshots). Each concurrent tab is a WebSocket to Chrome,
 * and too many at once make Chrome drop connections ("socket hang up") and race
 * on web-font load (nondeterministic metrics). Env-overridable via
 * `RECORD_CONCURRENCY`. Default is 5: the two historical hazards of parallel
 * tabs are now closed — the tab-leak cascade by reap-tabs-at-start + screenshot
 * tab-reuse + finally-close, and the web-font-load race (nondeterministic
 * metrics) by the asset-readiness gate in convert-pptx-io. Verified: all 34
 * fixtures render byte-identical extractSlideXml + extractRenderedPartsHash at
 * concurrency=5 vs serial, at ~2.6× the speed. Set RECORD_CONCURRENCY=1 (or
 * MERGE_RENDER_CONCURRENCY=1 for the gate renders) to drop back to serial on a
 * constrained host, or if many forks render at once and 5×N tabs pressure Chrome.
 */
function chromeConcurrency(): number {
  const n = Number(process.env.RECORD_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/**
 * Close EVERY open page in Chrome before a render, so it starts from a clean slate.
 * This breaks the leak CASCADE: once a socket drops mid-batch, the render's own
 * per-slide CDP.Close calls fail (dead connection) and its tabs orphan; those pile
 * up across renders/retries until Chrome is overloaded and drops MORE sockets. A
 * fresh render can't clean the previous one's orphans via a dead connection — but
 * it CAN reap them here through a fresh connection. Uses a fresh CDP List/Close, so
 * it's independent of any wedged connection. GATED on RECORD_REAP_TABS=1 (set only
 * by the SEQUENTIAL merge/baseline renders) so it never reaps a PARALLEL solve
 * render's in-flight tabs.
 */
async function reapAllPages(port: number): Promise<void> {
  if (process.env.RECORD_REAP_TABS !== "1") return;
  try {
    const list = await CDP.List({ port });
    const pages = list.filter((t) => t.type === "page");
    for (const t of pages) { try { await CDP.Close({ port, id: t.id }); } catch { /* */ } }
    if (pages.length) console.log(`  [reap] closed ${pages.length} pre-existing tab(s) for a clean render`);
  } catch { /* chrome down / no targets — fine */ }
}

/**
 * Per-slide pptx (--no-upload). Built with bounded concurrency (see
 * `chromeConcurrency`) — convert-pptx opens a fresh Chrome tab per slide for DOM
 * extraction. Idempotent: skips slides whose .pptx is already present.
 */
async function recordPptx(slides: string[], outDir: string, fixturesDir: string) {
  const missing = slides.filter((id) => !existsSync(join(outDir, `${id}.pptx`)));
  if (missing.length === 0) {
    console.log(`  pptx: all ${slides.length} present, skipping`);
    return;
  }
  const conc = chromeConcurrency();
  console.log(`  pptx: building ${missing.length}/${slides.length} (rest cached, concurrency=${conc})...`);
  await pLimit(conc, missing, async (id) => {
    const html = `${id}.html`;
    if (!existsSync(join(fixturesDir, html))) {
      throw new Error(`fixture not found: ${join(fixturesDir, html)}`);
    }
    await runConvertPptx({
      htmlDir: fixturesDir,
      only: [html],
      title: `record-${id}-${Date.now()}`,
      outPath: join(outDir, `${id}.pptx`),
      noUpload: true,
    });
    console.log(`    ${id} → ${join(outDir, `${id}.pptx`)}`);
  });
}

/**
 * Screenshot each fixture HTML in headless Chrome at the same 1280×720 (2×
 * DPR) viewport convert-pptx uses for DOM extraction. Idempotent.
 */
async function screenshotFixtures(slides: string[], fixturesDir: string, outDir: string, port: number) {
  const missing = slides.filter((id) => !existsSync(join(outDir, `${id}.png`)));
  if (missing.length === 0) {
    console.log(`  screenshots: all ${slides.length} present, skipping`);
    return;
  }
  const conc = Math.min(chromeConcurrency(), missing.length);
  console.log(`  screenshots: capturing ${missing.length}/${slides.length} (rest cached, concurrency=${conc}, tab-reuse)...`);
  // Each worker owns ONE reused tab (the shared capture tab: load event subscribed
  // before navigating, readiness polled) for its whole lifetime, closed ONCE at the
  // end by `await using`. No per-slide tab churn (the tab-leak + Chrome-wedge
  // source). A shared cursor hands the next slide to whichever worker is free.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    await using tab = await openChromeTab({ port, deviceScaleFactor: 2 });
    for (let i = cursor++; i < missing.length; i = cursor++) {
      const id = missing[i];
      const outPath = join(outDir, `${id}.png`);
      const capture = await tab.capture({ address: pathToFileURL(resolve(fixturesDir, `${id}.html`)).href });
      writeFileSync(outPath, capture.png);
      console.log(`    ${id} → ${outPath}${capture.readiness === "timedOut" ? " (page never reported ready)" : ""}`);
    }
  };
  await Promise.all(Array.from({ length: conc }, () => worker()));
}

/** Google Drive + Slides oauth2 client built from the project's saved tokens (dev-google-auth.ts). */
export function getGoogleAuth() {
  if (!existsSync(DEV_CREDENTIALS_PATH) || !existsSync(DEV_TOKENS_PATH)) {
    throw new Error(
      `Missing Google credentials. Run \`npx tsx /workspaces/sashaslides/.auth/generate-token.ts\` first. ` +
        `Looked for: ${DEV_CREDENTIALS_PATH}, ${DEV_TOKENS_PATH}`,
    );
  }
  return loadDevOAuthClient({ persistRefreshedTokens: true });
}

/**
 * Pre-flight: force a token refresh so a dead/expired OAuth grant fails LOUDLY
 * before a multi-cluster run, instead of every `--mode full` upload throwing
 * `invalid_grant` that step-7's `|| true` silently swallows (which produces
 * empty rating servers after a full run). `getAccessToken()` returns the cached
 * token or refreshes via the refresh_token; a dead refresh token throws here.
 * Returns the access-token expiry (ms epoch) on success.
 */
export async function assertGoogleAuthFresh(): Promise<{ expiry?: number }> {
  const oauth2 = getGoogleAuth();
  // Force a refresh (mark the cached access token expired) so we validate the
  // long-lived REFRESH token — the thing that actually lapses for Testing-mode
  // OAuth apps — rather than handing back a still-valid access token that would
  // only fail mid-run once it needs refreshing. A dead refresh token throws
  // `invalid_grant` here; a good one refreshes (and the `tokens` listener in
  // getGoogleAuth persists the new token, so the run starts with a fresh hour).
  if (oauth2.credentials) oauth2.credentials.expiry_date = 1;
  const res = await oauth2.getAccessToken();
  if (!res || !res.token) throw new Error("Google auth returned no access token");
  return { expiry: oauth2.credentials?.expiry_date ?? undefined };
}

/**
 * Build a combined pptx for all slides, upload to Google Slides under a
 * fork-unique presentation name, scrape per-slide thumbnails, and write a
 * manifest with presentation_id + per-slide objectIds for deep links.
 * Idempotent: skipped if <thumbsDir>/manifest.json already exists.
 */
async function uploadAndScrape(
  slides: string[],
  thumbsDir: string,
  title: string,
  fixturesDir: string,
): Promise<string | undefined> {
  if (existsSync(join(thumbsDir, "manifest.json"))) {
    console.log(`  upload+scrape: manifest.json present, skipping`);
    return undefined;
  }
  console.log(`  upload+scrape: combined pptx + Slides scrape...`);
  const pptxPath = join(thumbsDir, `${title}.pptx`);
  const htmlList = slides.map((s) => `${s}.html`);

  // Build combined pptx (single file with all slides).
  await runConvertPptx({
    htmlDir: fixturesDir,
    only: htmlList,
    title,
    outPath: pptxPath,
    noUpload: true,
  });
  if (!existsSync(pptxPath)) throw new Error("combined pptx not produced: " + pptxPath);

  // Upload as Google Slides presentation.
  const auth = getGoogleAuth();
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.create({
    requestBody: { name: title, mimeType: "application/vnd.google-apps.presentation" },
    media: {
      mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      body: Readable.from(readFileSync(pptxPath)),
    },
    fields: "id",
  });
  const presId = res.data.id!;
  console.log(`    presentation: https://docs.google.com/presentation/d/${presId}/edit`);

  // Scrape per-slide thumbnails. Pass `fileNames` so exportThumbs writes
  // each PNG directly under its fixture-id name (no position-based
  // slide_NN.png intermediate → no rename loop → no overwrite bug).
  // Previously, this scrape used position-based names + a rename loop,
  // which silently overwrote thumbs when fixture-id names collided with
  // intermediate position names (wave-10A only got 5 of 7 thumbs because
  // of exactly that — slide_04 and slide_06 got clobbered).
  await exportThumbs({
    presId,
    outDir: thumbsDir,
    fileNames: slides.map((id) => `${id}.png`),
  });

  // Per-slide objectIds for deep links #slide=id.<oid>.
  const slidesApi = google.slides({ version: "v1", auth });
  const pres = await slidesApi.presentations.get({ presentationId: presId });
  const slideObjectIds = (pres.data.slides || []).map((s) => s.objectId || "");

  writeFileSync(
    join(thumbsDir, "manifest.json"),
    JSON.stringify({
      task_title: title,
      presentation_id: presId,
      slides,
      slide_object_ids: slideObjectIds,
      thumbnails: slides.map((s) => `${s}.png`),
      created_at: new Date().toISOString(),
    }, null, 2),
  );
  return presId;
}

export async function recordRendering(opts: RecordRenderingOpts): Promise<RecordRenderingResult> {
  const slides = opts.slides;
  const out = resolve(opts.out);
  const title = opts.title ?? `bug_solving-${Date.now()}`;
  const fixtures = opts.fixtures ?? "renderer/html2slides/e2e/fixtures";
  const mode: Mode = opts.mode ?? "full";
  const chromePort = opts.chromePort ?? DEFAULT_CAPTURE_CHROME_PORT;
  if (!slides || slides.length === 0) throw new Error("recordRendering: slides is required and non-empty");
  if (!opts.out) throw new Error("recordRendering: out is required");
  if (mode !== "pptx" && mode !== "screenshots" && mode !== "full") {
    throw new Error(`recordRendering: mode must be one of pptx|screenshots|full (got ${mode})`);
  }

  const pptxDir = join(out, "pptx");
  const originalsDir = join(out, "originals");
  const thumbsDir = join(out, "thumbs");
  mkdirSync(pptxDir, { recursive: true });
  if (mode !== "pptx") mkdirSync(originalsDir, { recursive: true });
  if (mode === "full") mkdirSync(thumbsDir, { recursive: true });

  console.log(`[record-rendering] mode=${mode} slides=${slides.length} → ${out}`);

  // ASSERT every phase produced a COMPLETE set — fail EARLY + LOUD rather than
  // emitting a partial result a downstream gate misreads (a pptx-only render made
  // the merge flag all 34 slides). Each phase's per-slide output must exist.
  const assertComplete = (dir: string, ext: string, label: string): void => {
    const missing = slides.filter((id) => !existsSync(join(dir, `${id}.${ext}`)));
    if (missing.length > 0) {
      throw new Error(`[record-rendering] INCOMPLETE ${label}: ${missing.length}/${slides.length} missing (${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""}) in ${dir} — failing early instead of emitting a partial render.`);
    }
  };

  // Full mode needs Google — verify the token is live BEFORE rendering, so a dead
  // token fails here with a clear message (not silently as an empty thumb set).
  if (mode === "full") await assertGoogleAuthFresh();

  // Start from a clean Chrome (reap orphaned tabs from a prior crashed/wedged
  // render) so this render can't inherit the leak cascade. Gated (see reapAllPages).
  await reapAllPages(chromePort);

  await recordPptx(slides, pptxDir, fixtures);
  assertComplete(pptxDir, "pptx", "pptx");
  if (mode !== "pptx") {
    await screenshotFixtures(slides, fixtures, originalsDir, chromePort);
    assertComplete(originalsDir, "png", "screenshots");
  }
  let presId: string | undefined;
  if (mode === "full") {
    presId = await uploadAndScrape(slides, thumbsDir, title, fixtures);
    assertComplete(thumbsDir, "png", "thumbnails");
  }

  console.log(`[record-rendering] done.`);
  console.log(`  pptx      → ${pptxDir}`);
  if (mode !== "pptx") console.log(`  originals → ${originalsDir}`);
  if (mode === "full") console.log(`  thumbs    → ${thumbsDir}`);

  return {
    pptxDir,
    originalsDir: mode !== "pptx" ? originalsDir : undefined,
    thumbsDir: mode === "full" ? thumbsDir : undefined,
    presId,
  };
}
