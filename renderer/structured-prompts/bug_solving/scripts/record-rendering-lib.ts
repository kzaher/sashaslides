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
import CDPDefault from "chrome-remote-interface";
import { google } from "googleapis";
import { runConvertPptx } from "../../../html2slides/convert-pptx-io";
import { exportThumbs } from "../../../html2slides/export-thumbs-lib";

// chrome-remote-interface ships no .d.ts (its default export types as
// `unknown` via types/ambient.d.ts). Narrow the boundary into the methods we
// actually invoke — the only place untyped CDP becomes typed.
interface CDPTarget { id: string; url: string; type: string }
interface CDPEmulation {
  setDeviceMetricsOverride(opts: { width: number; height: number; deviceScaleFactor: number; mobile: boolean }): Promise<unknown>;
}
interface CDPPage {
  enable(): Promise<unknown>;
  navigate(opts: { url: string }): Promise<unknown>;
  loadEventFired(): Promise<unknown>;
  captureScreenshot(opts?: { format?: string; clip?: { x: number; y: number; width: number; height: number; scale?: number } }): Promise<{ data: string }>;
}
interface CDPClient {
  Page: CDPPage;
  Emulation: CDPEmulation;
  close(): Promise<void>;
}
interface CDPModule {
  (opts?: { target?: { id: string; url: string }; port?: number }): Promise<CDPClient>;
  New(opts: { port: number; url?: string }): Promise<CDPTarget>;
  Close(opts: { port: number; id: string }): Promise<void>;
}
const CDP = CDPDefault as CDPModule;

export type Mode = "pptx" | "screenshots" | "full";

export interface RecordRenderingOpts {
  slides: string[];
  out: string;
  title?: string;
  fixtures?: string;
  mode?: Mode;
}

export interface RecordRenderingResult {
  pptxDir: string;
  originalsDir?: string;
  thumbsDir?: string;
  presId?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
 * Per-slide pptx (--no-upload). Built with bounded concurrency (4
 * at a time) — convert-pptx opens a fresh Chrome tab per slide for
 * DOM extraction, and >4 concurrent tabs occasionally drop the
 * WebSocket. concurrency=4 is the empirical sweet spot. Idempotent:
 * skips slides whose .pptx is already present.
 */
async function recordPptx(slides: string[], outDir: string, fixturesDir: string) {
  const missing = slides.filter((id) => !existsSync(join(outDir, `${id}.pptx`)));
  if (missing.length === 0) {
    console.log(`  pptx: all ${slides.length} present, skipping`);
    return;
  }
  // Concurrency is env-overridable (RECORD_CONCURRENCY): the default 4 is fast,
  // but concurrent Chrome tabs racing on web-font load make text metrics — and
  // thus the emitted pptx — nondeterministic. Set RECORD_CONCURRENCY=1 to render
  // SEQUENTIALLY for a byte-deterministic pass (regression gates / off-target
  // scans), where a stable diff matters more than speed.
  const recordConcurrency = Number(process.env.RECORD_CONCURRENCY) || 4;
  console.log(`  pptx: building ${missing.length}/${slides.length} (rest cached, concurrency=${recordConcurrency})...`);
  await pLimit(recordConcurrency, missing, async (id) => {
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
async function screenshotFixtures(slides: string[], fixturesDir: string, outDir: string) {
  const PORT = 9222;
  const missing = slides.filter((id) => !existsSync(join(outDir, `${id}.png`)));
  if (missing.length === 0) {
    console.log(`  screenshots: all ${slides.length} present, skipping`);
    return;
  }
  console.log(`  screenshots: capturing ${missing.length}/${slides.length} (rest cached, concurrency=4)...`);
  await pLimit(4, missing, async (id) => {
    const htmlPath = resolve(fixturesDir, `${id}.html`);
    const outPath = join(outDir, `${id}.png`);
    const target = await CDP.New({ port: PORT, url: "about:blank" });
    const client = await CDP({ target, port: PORT });
    try {
      const { Page, Emulation } = client;
      await Page.enable();
      await Emulation.setDeviceMetricsOverride({
        width: 1280, height: 720, deviceScaleFactor: 2, mobile: false,
      });
      await Page.navigate({ url: "file://" + htmlPath });
      await Page.loadEventFired();
      await sleep(300);
      const { data } = await Page.captureScreenshot({
        format: "png",
        clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 },
      });
      writeFileSync(outPath, Buffer.from(data, "base64"));
      console.log(`    ${id} → ${outPath}`);
    } finally {
      await client.close();
      await CDP.Close({ port: PORT, id: target.id });
    }
  });
}

/** Google Drive + Slides oauth2 client built from the project's saved tokens. */
export function getGoogleAuth() {
  const credsPath = resolve("/workspaces/sashaslides/.auth/google_oauth.json");
  const tokensPath = resolve("/workspaces/sashaslides/.auth/tokens.json");
  if (!existsSync(credsPath) || !existsSync(tokensPath)) {
    throw new Error(
      `Missing Google credentials. Run \`npx tsx /workspaces/sashaslides/.auth/generate-token.ts\` first. ` +
        `Looked for: ${credsPath}, ${tokensPath}`,
    );
  }
  const creds = JSON.parse(readFileSync(credsPath, "utf-8")).installed;
  const tokens = JSON.parse(readFileSync(tokensPath, "utf-8"));
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret, creds.redirect_uris?.[0]);
  oauth2.setCredentials(tokens);
  oauth2.on("tokens", (newTokens) => {
    writeFileSync(tokensPath, JSON.stringify({ ...tokens, ...newTokens }, null, 2));
  });
  return oauth2;
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

  await recordPptx(slides, pptxDir, fixtures);
  if (mode !== "pptx") await screenshotFixtures(slides, fixtures, originalsDir);
  let presId: string | undefined;
  if (mode === "full") presId = await uploadAndScrape(slides, thumbsDir, title, fixtures);

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
