#!/usr/bin/env npx tsx
/**
 * filtered-rating-server.ts — SxS rating UI for a single bug_solving task.
 *
 * Shows, per slide: original HTML screenshot (Chrome) vs the task's freshly
 * uploaded Slides render, plus the full review toolset the main
 * rating-server offers: Good/Bad/Skip buttons, a comment box, an
 * annotation canvas over the rendered image, a client-side diff overlay,
 * and task-specific "Show analysis" / "Show diff" reveals per slide.
 *
 * Per-slide links to the HTML source and the Google Slides page appear at
 * the top of each card when the relevant inputs are wired:
 *   * HTML source link:  --html-dir + "${slide_id}.html" (or --fixtures alias)
 *   * Google Slides link: read from <thumbnails>/manifest.json, which
 *     upload-and-scrape.ts writes with presentation_id + parallel
 *     slide_object_ids so we can build `…/edit#slide=id.<oid>` deep links.
 *
 * Ratings (status + comment + annotation png) persist to
 * <thumbnails>/../ratings.json so a subsequent bug_solving retry can read
 * them. UI is Preact (esm.sh, no bundler) so reveal + draw state survives
 * re-renders.
 *
 * Usage:
 *   npx tsx filtered-rating-server.ts --port 4701 \
 *       --slides slide_04,slide_11 \
 *       --analysis /workspace/scratch/analysis.md \
 *       --diffs /workspace/scratch/diffs \
 *       --thumbnails /workspace/scratch/thumbnails \
 *       [--originals /tmp/sxs-complex/originals] \
 *       [--html-dir renderer/html2slides/e2e/fixtures] \
 *       [--ratings-file /workspace/scratch/ratings.json] \
 *       [--task-title "bug_solving: clipping"]
 */
import { resolve, dirname } from "path";
import { startFilteredRatingServer } from "./filtered-rating-server-lib";
import type { Args } from "./filtered-rating-server-lib";

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {
    originals: "/tmp/sxs-complex/originals",
    html_dir: null,
    ratings_file: null,
    task_title: "bug_solving",
    baseline_dir: null,
    bug_context: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--port") a.port = +argv[++i];
    else if (v === "--slides") a.slides = argv[++i].split(",").map((s: string) => s.trim());
    else if (v === "--analysis") a.analysis = resolve(argv[++i]);
    else if (v === "--diffs") a.diffs = resolve(argv[++i]);
    else if (v === "--thumbnails") a.thumbnails = resolve(argv[++i]);
    else if (v === "--originals") a.originals = resolve(argv[++i]);
    else if (v === "--html-dir" || v === "--fixtures") a.html_dir = resolve(argv[++i]);
    else if (v === "--ratings-file") a.ratings_file = resolve(argv[++i]);
    else if (v === "--task-title") a.task_title = argv[++i];
    else if (v === "--baseline-dir") a.baseline_dir = resolve(argv[++i]);
    else if (v === "--bug-context") a.bug_context = resolve(argv[++i]);
  }
  if (!a.port || !a.slides || !a.analysis || !a.diffs || !a.thumbnails) {
    throw new Error(
      "usage: --port N --slides csv --analysis md --diffs dir --thumbnails dir " +
      "[--originals dir] [--html-dir dir] [--ratings-file file] [--task-title str] " +
      "[--baseline-dir dir]",
    );
  }
  // Default ratings file sits beside the scratch dir so a future retry can
  // read the user's verdicts alongside analysis.md.
  if (!a.ratings_file) {
    a.ratings_file = resolve(dirname(a.thumbnails!), "ratings.json");
  }
  // Required fields are guaranteed populated by the validation above; the
  // optional/defaulted ones are also populated. We materialize the final
  // Args by spreading the partial — TypeScript narrows the assertion via
  // the explicit return-type annotation.
  return {
    port: a.port!,
    slides: a.slides!,
    analysis: a.analysis!,
    diffs: a.diffs!,
    thumbnails: a.thumbnails!,
    originals: a.originals!,
    html_dir: a.html_dir!,
    ratings_file: a.ratings_file,
    task_title: a.task_title!,
    baseline_dir: a.baseline_dir!,
  } as Args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await startFilteredRatingServer(args);
  // The lib starts the listener but doesn't keep the process alive on its
  // own — but Node's HTTP server holds the event loop open as long as it's
  // listening, so simply returning here is fine.
}
main().catch(e => { console.error(e); process.exit(1); });
