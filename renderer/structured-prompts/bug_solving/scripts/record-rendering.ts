/**
 * record-rendering.ts — ONE generic recording script. Self-contained
 * (no sub-script dependencies inside bug_solving/scripts/). Used both for
 * the wave-level baseline AND for each per-task post-fix recording.
 *
 * Modes (each subsumes the cheaper one):
 *   --mode pptx          per-slide pptx only.            (≈ 5 s/slide)
 *   --mode screenshots   pptx + Chrome HTML screenshots. (≈ 6 s/slide)
 *   --mode full          pptx + screenshots + Slides upload + thumbs scrape.
 *                          (default; ≈ 30 s + 5 s/slide)
 *
 * Output layout under <out>:
 *   pptx/<slide_id>.pptx        per-slide pptx               (modes: pptx, screenshots, full)
 *   originals/<slide_id>.png    Chrome screenshot of fixture (modes: screenshots, full)
 *   thumbs/<slide_id>.png       Slides-rendered thumbnail    (mode: full)
 *   thumbs/manifest.json        presentation_id + oid table  (mode: full)
 *   thumbs/rendered-regions.json                              (mode: full)
 *
 * Idempotent per-step: a step is skipped if its primary output already
 * exists (e.g. mode=full sees pptx/ already populated and skips the pptx
 * step). This lets a "quick" mode-pptx pre-pass coexist with a later
 * mode-full top-up without duplicating expensive work.
 *
 * Usage:
 *   npx tsx record-rendering.ts --slides slide_11,slide_14,... --out <dir> --mode full
 */
import { execSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { Readable } from "stream";
import CDP from "chrome-remote-interface";
import { google } from "googleapis";

type Mode = "pptx" | "screenshots" | "full";
type Args = { slides: string[]; out: string; title: string; fixtures: string; mode: Mode };

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {
    fixtures: "renderer/html2slides/e2e/fixtures",
    mode: "full",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--slides") a.slides = argv[++i].split(",").map((s: string) => s.trim());
    else if (argv[i] === "--out") a.out = resolve(argv[++i]);
    else if (argv[i] === "--title") a.title = argv[++i];
    else if (argv[i] === "--fixtures") a.fixtures = argv[++i];
    else if (argv[i] === "--mode") a.mode = argv[++i] as Mode;
  }
  if (!a.slides || !a.out) {
    throw new Error("usage: --slides <csv> --out <dir> [--title <name>] [--fixtures <dir>] [--mode pptx|screenshots|full]");
  }
  if (a.mode !== "pptx" && a.mode !== "screenshots" && a.mode !== "full") {
    throw new Error(`--mode must be one of: pptx, screenshots, full (got ${a.mode})`);
  }
  return {
    slides: a.slides,
    out: a.out,
    title: a.title ?? `bug_solving-${Date.now()}`,
    fixtures: a.fixtures!,
    mode: a.mode,
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Per-slide pptx (--no-upload). Built sequentially to avoid CDP target
 * thrashing — convert-pptx.ts opens a fresh tab per slide, and >4
 * concurrent tabs occasionally drop the WebSocket. Idempotent: skips
 * slides whose .pptx is already present.
 */
function recordPptx(slides: string[], outDir: string, fixturesDir: string) {
  const missing = slides.filter(id => !existsSync(join(outDir, `${id}.pptx`)));
  if (missing.length === 0) {
    console.log(`  pptx: all ${slides.length} present, skipping`);
    return;
  }
  console.log(`  pptx: building ${missing.length}/${slides.length} (rest cached)...`);
  for (const id of missing) {
    const html = `${id}.html`;
    if (!existsSync(join(fixturesDir, html))) {
      throw new Error(`fixture not found: ${join(fixturesDir, html)}`);
    }
    execSync(
      `npx tsx renderer/html2slides/convert-pptx.ts "${fixturesDir}" ` +
      `--only "${html}" --title "record-${id}-${Date.now()}" ` +
      `--out "${join(outDir, `${id}.pptx`)}" --no-upload`,
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    console.log(`    ${id} → ${join(outDir, `${id}.pptx`)}`);
  }
}

/**
 * Screenshot each fixture HTML in headless Chrome at the same 1280×720 (2×
 * DPR) viewport convert-pptx.ts uses for DOM extraction. Idempotent.
 */
async function screenshotFixtures(slides: string[], fixturesDir: string, outDir: string) {
  const PORT = 9222;
  const missing = slides.filter(id => !existsSync(join(outDir, `${id}.png`)));
  if (missing.length === 0) {
    console.log(`  screenshots: all ${slides.length} present, skipping`);
    return;
  }
  console.log(`  screenshots: capturing ${missing.length}/${slides.length} (rest cached)...`);
  for (const id of missing) {
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
  }
}

/** Google Drive + Slides oauth2 client built from the project's saved tokens. */
function getGoogleAuth() {
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
) {
  if (existsSync(join(thumbsDir, "manifest.json"))) {
    console.log(`  upload+scrape: manifest.json present, skipping`);
    return;
  }
  console.log(`  upload+scrape: combined pptx + Slides scrape...`);
  const pptxPath = join(thumbsDir, `${title}.pptx`);
  const htmlList = slides.map(s => `${s}.html`).join(",");

  // Build combined pptx (single file with all slides).
  execSync(
    `npx tsx renderer/html2slides/convert-pptx.ts "${fixturesDir}" ` +
    `--only "${htmlList}" --title "${title}" --out "${pptxPath}" --no-upload`,
    { stdio: "inherit" },
  );
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

  // Scrape per-slide thumbnails (export-thumbs.ts handles the API +
  // CDP-fallback details we don't want to duplicate here).
  execSync(
    `npx tsx renderer/html2slides/export-thumbs.ts "${presId}" "${thumbsDir}"`,
    { stdio: "inherit" },
  );

  // Per-slide objectIds for deep links #slide=id.<oid>.
  const slidesApi = google.slides({ version: "v1", auth });
  const pres = await slidesApi.presentations.get({ presentationId: presId });
  const slideObjectIds = (pres.data.slides || []).map(s => s.objectId || "");

  // Rename slide_NN.png → <slide_id>.png to match downstream expectations.
  for (let i = 0; i < slides.length; i++) {
    const from = join(thumbsDir, `slide_${String(i + 1).padStart(2, "0")}.png`);
    const to = join(thumbsDir, `${slides[i]}.png`);
    if (from !== to && existsSync(from)) renameSync(from, to);
  }

  writeFileSync(
    join(thumbsDir, "manifest.json"),
    JSON.stringify({
      task_title: title,
      presentation_id: presId,
      slides,
      slide_object_ids: slideObjectIds,
      thumbnails: slides.map(s => `${s}.png`),
      created_at: new Date().toISOString(),
    }, null, 2),
  );
}

async function main() {
  const { slides, out, title, fixtures, mode } = parseArgs(process.argv.slice(2));
  const pptxDir = join(out, "pptx");
  const originalsDir = join(out, "originals");
  const thumbsDir = join(out, "thumbs");
  mkdirSync(pptxDir, { recursive: true });
  if (mode !== "pptx") mkdirSync(originalsDir, { recursive: true });
  if (mode === "full") mkdirSync(thumbsDir, { recursive: true });

  console.log(`[record-rendering] mode=${mode} slides=${slides.length} → ${out}`);

  recordPptx(slides, pptxDir, fixtures);
  if (mode !== "pptx") await screenshotFixtures(slides, fixtures, originalsDir);
  if (mode === "full") await uploadAndScrape(slides, thumbsDir, title, fixtures);

  console.log(`[record-rendering] done.`);
  console.log(`  pptx      → ${pptxDir}`);
  if (mode !== "pptx") console.log(`  originals → ${originalsDir}`);
  if (mode === "full") console.log(`  thumbs    → ${thumbsDir}`);
}

main().catch((e) => { console.error("[record-rendering] failed:", e); process.exit(1); });
