/**
 * baseline-record.ts — record the "main" (pre-fix) rendering for every slide
 * that will be touched by a bug_solving wave. Produces:
 *   <out>/pptx/<slide_id>.pptx       (per-slide pptx; consumed by diff step)
 *   <out>/thumbs/<slide_id>.png      (Slides-scraped thumbnail; consumed by SxS UI)
 *   <out>/thumbs/manifest.json       (presentation_id + slide_object_ids)
 *   <out>/thumbs/rendered-regions.json  (same shape as main pipeline)
 *
 * Called once at the start of a wave so every per-task worker inherits the
 * same baseline instead of re-building it inside its own worktree. This is
 * both faster (single Slides upload, single scrape) and more correct — all
 * verdicts compare against the identical "before" state.
 *
 * Usage:
 *   npx tsx baseline-record.ts --slides slide_11,slide_14,... --out /tmp/bs-baseline-<ts>
 */
import { execSync } from "child_process";
import { mkdirSync } from "fs";
import { resolve } from "path";

type Args = { slides: string[]; out: string; title: string };

function parseArgs(argv: string[]): Args {
  const a: any = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--slides") a.slides = argv[++i].split(",").map((s: string) => s.trim());
    else if (argv[i] === "--out") a.out = resolve(argv[++i]);
    else if (argv[i] === "--title") a.title = argv[++i];
  }
  if (!a.slides || !a.out) throw new Error("usage: --slides <csv> --out <dir> [--title <name>]");
  if (!a.title) a.title = `bug_solving-baseline-${Date.now()}`;
  return a as Args;
}

async function main() {
  const { slides, out, title } = parseArgs(process.argv.slice(2));
  const pptxDir = resolve(out, "pptx");
  const thumbsDir = resolve(out, "thumbs");
  mkdirSync(pptxDir, { recursive: true });
  mkdirSync(thumbsDir, { recursive: true });

  const csv = slides.join(",");
  console.log(`[baseline] recording ${slides.length} slide(s) → ${out}`);
  console.log(`  slides: ${csv}`);

  console.log(`[baseline][1/2] Building per-slide pptx (for diff)...`);
  execSync(
    `bash renderer/structured-prompts/bug_solving/scripts/record-pptx.sh ` +
    `--slides ${csv} --label baseline --out ${pptxDir}`,
    { stdio: "inherit" },
  );

  console.log(`[baseline][2/2] Uploading combined pptx + scraping thumbs...`);
  execSync(
    `npx tsx renderer/structured-prompts/bug_solving/scripts/upload-and-scrape.ts ` +
    `--slides ${csv} --title "${title}" --out ${thumbsDir}`,
    { stdio: "inherit" },
  );

  console.log(`[baseline] done. pptx → ${pptxDir}, thumbs → ${thumbsDir}`);
}

main().catch((e) => { console.error("[baseline] failed:", e); process.exit(1); });
