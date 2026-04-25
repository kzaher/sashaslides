/**
 * record-rendering.ts — ONE generic recording script. Used both for the
 * wave-level baseline AND for each per-task recording. Replaces the older
 * baseline-record.ts + the bare record-pptx.sh / upload-and-scrape.ts pair.
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
 * step). This makes BUG_SOLVING_BASELINE_DIR re-runs cheap and lets the
 * "quick" mode-pptx pre-pass coexist with a later mode-full top-up.
 *
 * Usage:
 *   npx tsx record-rendering.ts --slides slide_11,slide_14,... --out <dir> --mode full
 */
import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import CDP from "chrome-remote-interface";

type Mode = "pptx" | "screenshots" | "full";
type Args = { slides: string[]; out: string; title: string; fixtures: string; mode: Mode };

function parseArgs(argv: string[]): Args {
  const a: any = { fixtures: "renderer/html2slides/e2e/fixtures", mode: "full" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--slides") a.slides = argv[++i].split(",").map((s: string) => s.trim());
    else if (argv[i] === "--out") a.out = resolve(argv[++i]);
    else if (argv[i] === "--title") a.title = argv[++i];
    else if (argv[i] === "--fixtures") a.fixtures = argv[++i];
    else if (argv[i] === "--mode") a.mode = argv[++i];
  }
  if (!a.slides || !a.out) {
    throw new Error("usage: --slides <csv> --out <dir> [--title <name>] [--fixtures <dir>] [--mode pptx|screenshots|full]");
  }
  if (!["pptx", "screenshots", "full"].includes(a.mode)) {
    throw new Error(`--mode must be one of: pptx, screenshots, full (got ${a.mode})`);
  }
  if (!a.title) a.title = `bug_solving-${Date.now()}`;
  return a as Args;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Per-slide pptx via the existing record-pptx.sh helper. Idempotent: the
 * shell helper itself doesn't check, so we filter slides whose .pptx is
 * already present.
 */
function recordPptx(slides: string[], outDir: string, fixturesDir: string) {
  const missing = slides.filter(id => !existsSync(join(outDir, `${id}.pptx`)));
  if (missing.length === 0) {
    console.log(`  pptx: all ${slides.length} present, skipping`);
    return;
  }
  console.log(`  pptx: building ${missing.length}/${slides.length} (rest cached)...`);
  execSync(
    `bash renderer/structured-prompts/bug_solving/scripts/record-pptx.sh ` +
    `--slides ${missing.join(",")} --label record --out ${outDir} --fixtures ${fixturesDir}`,
    { stdio: "inherit" },
  );
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

/**
 * Combined pptx upload to Google Slides + per-slide thumbnail scrape.
 * Idempotent: skipped if <thumbsDir>/manifest.json exists.
 */
function uploadAndScrape(slides: string[], thumbsDir: string, title: string, fixturesDir: string) {
  if (existsSync(join(thumbsDir, "manifest.json"))) {
    console.log(`  upload+scrape: manifest.json present, skipping`);
    return;
  }
  console.log(`  upload+scrape: combined pptx + Slides scrape...`);
  execSync(
    `npx tsx renderer/structured-prompts/bug_solving/scripts/upload-and-scrape.ts ` +
    `--slides ${slides.join(",")} --title "${title}" --out ${thumbsDir} --fixtures ${fixturesDir}`,
    { stdio: "inherit" },
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

  // [1/?] per-slide pptx (always)
  recordPptx(slides, pptxDir, fixtures);

  // [2/?] Chrome screenshots (modes: screenshots, full)
  if (mode !== "pptx") {
    await screenshotFixtures(slides, fixtures, originalsDir);
  }

  // [3/?] Slides upload + thumbs scrape (mode: full)
  if (mode === "full") {
    uploadAndScrape(slides, thumbsDir, title, fixtures);
  }

  console.log(`[record-rendering] done.`);
  console.log(`  pptx      → ${pptxDir}`);
  if (mode !== "pptx") console.log(`  originals → ${originalsDir}`);
  if (mode === "full") console.log(`  thumbs    → ${thumbsDir}`);
}

main().catch((e) => { console.error("[record-rendering] failed:", e); process.exit(1); });
