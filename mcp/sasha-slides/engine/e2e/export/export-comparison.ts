// THE EXPORT AGAINST THE EDITOR, IN PIXELS: every slide of the comparison deck (the sample deck plus
// a slide of shrinking text and growing table rows) is drawn twice in Chrome at 1280 x 720 -- once
// by the editor's own `StaticSlide` with its layout effects (live-slide-entry.ts), once as the
// self-contained page `renderSlideHtml` writes -- and the two screenshots are compared with
// pixelmatch. They are the same renderer, so any difference is the export's: a missing font, a
// layout effect the export's inline pass does not repeat, a wrapper that shifts the slide.
//
//   npx tsx e2e/export/export-comparison.ts <output directory>
//
// Writes live-NN.png, export-NN.png, diff-NN.png and report.json (per slide: mismatched pixels and
// percentage), and exits non-zero when any slide differs by more than MISMATCH_LIMIT_PERCENT.
// Chrome must be listening on 127.0.0.1:9223. Whole run: under 60 seconds.

import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { EXPORT_PAGE_SIZE, EXPORT_READY_ATTRIBUTE, renderSlideHtml } from "../../src/export/slide-html.ts";
import { serveDirectory } from "../../serve-directory.ts";
import { withPage } from "../editor/editor-session.ts";
import { comparisonAssetAddress, comparisonDeck } from "./comparison-deck.ts";

/** A slide may differ from the editor by at most this share of its pixels (anti-aliasing noise). */
export const MISMATCH_LIMIT_PERCENT = 0.5;

export type SlideComparison = Readonly<{
  slideNumber: number;
  mismatchedPixels: number;
  mismatchPercent: number;
  /** Every text run's computed font size, export side; a shrunk box shows here as smaller sizes. */
  exportFontSizes: readonly string[];
  /** Whether the editor drew every run at the same computed size as the export. */
  fontSizesMatch: boolean;
  livePath: string;
  exportPath: string;
  diffPath: string;
}>;

const ENGINE_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));
const output = process.argv[2] ?? join(tmpdir(), "sasha-export-comparison");
await mkdir(output, { recursive: true });
const site = join(tmpdir(), "sasha-export-comparison-site");
await buildSite(site);
await using server = await serveDirectory({ directory: site, host: "127.0.0.1" });

const deck = comparisonDeck();
const comparisons: SlideComparison[] = [];
for (const [index] of deck.slides.entries()) {
  const number = String(index + 1).padStart(2, "0");
  const livePath = join(output, `live-${number}.png`);
  const exportPath = join(output, `export-${number}.png`);
  const liveFontSizes = await shoot({ address: `${server.address}live.html?slide=${index}`, readyAttribute: "data-sasha-live-ready", path: livePath });
  const exportFontSizes = await shoot({ address: `${server.address}export-${number}.html`, readyAttribute: EXPORT_READY_ATTRIBUTE, path: exportPath });
  const diffPath = join(output, `diff-${number}.png`);
  const fontSizesMatch = liveFontSizes.join(" ") === exportFontSizes.join(" ");
  comparisons.push({ slideNumber: index + 1, ...(await compare({ livePath, exportPath, diffPath })), exportFontSizes, fontSizesMatch, livePath, exportPath, diffPath });
}
await writeFile(join(output, "report.json"), `${JSON.stringify(comparisons, null, 2)}\n`);
for (const comparison of comparisons) {
  const sizes = [...new Set(comparison.exportFontSizes)].join(", ");
  console.log(`slide ${comparison.slideNumber}: ${comparison.mismatchedPixels} pixels (${comparison.mismatchPercent.toFixed(3)} %) differ; run sizes ${comparison.fontSizesMatch ? "match" : "DIFFER"} (${sizes})`);
}
const failing = comparisons.filter((comparison) => comparison.mismatchPercent > MISMATCH_LIMIT_PERCENT || !comparison.fontSizesMatch);
if (failing.length > 0) {
  console.error(`${failing.length} slide(s) differ from the editor (over ${MISMATCH_LIMIT_PERCENT} % of pixels, or a run at another size): ${failing.map((comparison) => comparison.slideNumber).join(", ")}`);
  process.exitCode = 1;
}

/** The live page (bundled entry) and one exported page per slide, in one served directory. */
async function buildSite(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await build({
    entryPoints: [join(ENGINE_DIRECTORY, "e2e/export/live-slide-entry.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: join(directory, "live.js"),
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Live slide</title><style>html,body{margin:0;padding:0;width:1280px;height:720px;overflow:hidden;background:#ffffff}</style></head><body><div id="slide"></div><script type="module" src="live.js"></script></body></html>`;
  await writeFile(join(directory, "live.html"), page);
  const deck = comparisonDeck();
  for (const [index, slide] of deck.slides.entries()) {
    await writeFile(join(directory, `export-${String(index + 1).padStart(2, "0")}.html`), renderSlideHtml({ snapshot: deck, slideId: slide.id, assetAddress: comparisonAssetAddress }));
  }
}

/** Screenshots a page once it says it is ready; returns every text run's computed font size. */
async function shoot(options: Readonly<{ address: string; readyAttribute: string; path: string }>): Promise<readonly string[]> {
  return await withPage({ address: options.address, scheme: "light", reducedMotion: true, viewport: EXPORT_PAGE_SIZE }, async (tab) => {
    await tab.waitFor(`document.documentElement.getAttribute(${JSON.stringify(options.readyAttribute)}) === "true"`, 8000);
    await tab.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    await tab.screenshot(options.path);
    const sizes = await tab.evaluate(`[...document.querySelectorAll("[data-sasha-text-content] span")].map((run) => getComputedStyle(run).fontSize)`);
    return Array.isArray(sizes) ? sizes.map(String) : [];
  });
}

async function compare(options: Readonly<{ livePath: string; exportPath: string; diffPath: string }>): Promise<Readonly<{ mismatchedPixels: number; mismatchPercent: number }>> {
  const live = PNG.sync.read(await readFile(options.livePath));
  const exported = PNG.sync.read(await readFile(options.exportPath));
  if (live.width !== exported.width || live.height !== exported.height) throw new Error(`Sizes differ: live ${live.width} x ${live.height}, export ${exported.width} x ${exported.height}.`);
  const diff = new PNG({ width: live.width, height: live.height });
  const mismatchedPixels = pixelmatch(live.data, exported.data, diff.data, live.width, live.height, { threshold: 0.1 });
  await writeFile(options.diffPath, PNG.sync.write(diff));
  return { mismatchedPixels, mismatchPercent: (mismatchedPixels * 100) / (live.width * live.height) };
}
