/**
 * record-rendering.ts — thin CLI around `recordRendering()` in the lib.
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
 *
 * Usage:
 *   npx tsx record-rendering.ts --slides slide_11,slide_14,... --out <dir> --mode full
 */
import { resolve } from "path";
import { recordRendering, type Mode } from "./record-rendering-lib";

type Args = { slides: string[]; out: string; title?: string; fixtures?: string; mode: Mode };

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {
    fixtures: "renderer/html2slides/e2e/fixtures",
    mode: "full",
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--slides") a.slides = argv[++i].split(",").map((s) => s.trim());
    else if (argv[i] === "--out") a.out = resolve(argv[++i]);
    else if (argv[i] === "--title") a.title = argv[++i];
    else if (argv[i] === "--fixtures") a.fixtures = argv[++i];
    else if (argv[i] === "--mode") a.mode = argv[++i] as Mode;
  }
  if (!a.slides || !a.out) {
    throw new Error(
      "usage: --slides <csv> --out <dir> [--title <name>] [--fixtures <dir>] [--mode pptx|screenshots|full]",
    );
  }
  if (a.mode !== "pptx" && a.mode !== "screenshots" && a.mode !== "full") {
    throw new Error(`--mode must be one of: pptx, screenshots, full (got ${a.mode})`);
  }
  return a as Args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await recordRendering(args);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[record-rendering] failed: ${msg}`);
  process.exit(1);
});
