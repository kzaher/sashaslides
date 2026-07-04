/**
 * annotation-composite.ts — build a max-contrast COMPOSITE of a user's SxS
 * annotation applied onto the target slide render.
 *
 * ## Why this exists
 * The rating UI stores the user's drawn marks (rectangles / pen strokes) as a
 * PNG that is ~99% TRANSPARENT — just the shapes on an empty background. A
 * bug_solving worker handed that PNG alone sees floating rectangles with ZERO
 * slide context and cannot tell WHERE on the slide the user is pointing.
 *
 * `makeAnnotationComposite` fixes that: it renders an OPAQUE image the size of
 * the base (target) render, and everywhere the annotation is "marked" it shifts
 * the base pixel to MAXIMUM CONTRAST (per-channel `(v + 128) & 255` — the user's
 * "colour + 0.5 mod 1" half-shift), so the marked region visibly pops while the
 * slide's structure still shows through underneath. Unmarked pixels are copied
 * verbatim. The result is one image that shows BOTH the slide and exactly where
 * the user marked.
 *
 * The annotation is drawn OVER THE ORIGINAL/target slide by the rating UI, so
 * its coordinates align to the ORIGINAL render — pass the original_png as the
 * base. The annotation may be a different resolution than the base; we
 * nearest-neighbour sample the annotation for each base pixel.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
// pngjs lives in the repo-root node_modules; a plain require resolves it from
// whatever cwd runs the scaffolding (repo root) and from the worktree symlink.
import { PNG } from "pngjs";

/** Alpha threshold above which an annotation pixel counts as "marked". The
 *  rating UI's strokes are fully opaque where drawn and 0 elsewhere; 40 gives a
 *  little slack for any anti-aliased edge. */
const MARK_ALPHA = 40;

/**
 * Composite `annotationPngPath` (transparent marks) onto `basePngPath` (the
 * opaque target render) and write an OPAQUE PNG to `outPngPath`.
 *
 * @returns true iff both inputs parsed and the output was written; false (and a
 *          logged warning) on any read/parse/write failure — never throws.
 */
export function makeAnnotationComposite(
  basePngPath: string,
  annotationPngPath: string,
  outPngPath: string,
): boolean {
  let base: PNG;
  let ann: PNG;
  try {
    base = PNG.sync.read(readFileSync(basePngPath));
  } catch (e) {
    console.error(`[annotation-composite] cannot read base ${basePngPath}: ${(e as Error).message}`);
    return false;
  }
  try {
    ann = PNG.sync.read(readFileSync(annotationPngPath));
  } catch (e) {
    console.error(`[annotation-composite] cannot read annotation ${annotationPngPath}: ${(e as Error).message}`);
    return false;
  }

  try {
    const bw = base.width, bh = base.height;
    const aw = ann.width, ah = ann.height;
    const out = new PNG({ width: bw, height: bh });

    for (let y = 0; y < bh; y++) {
      // Nearest-neighbour source row in the annotation for this base row.
      const ay = Math.min(ah - 1, Math.floor((y * ah) / bh));
      for (let x = 0; x < bw; x++) {
        const ax = Math.min(aw - 1, Math.floor((x * aw) / bw));
        const bi = (bw * y + x) << 2;
        const ai = (aw * ay + ax) << 2;

        const r = base.data[bi];
        const g = base.data[bi + 1];
        const b = base.data[bi + 2];
        const marked = ann.data[ai + 3] > MARK_ALPHA;

        if (marked) {
          // Half-shift each channel: maximally different from the original while
          // still deterministic and reversible, so the slide structure remains
          // legible under the recolour.
          out.data[bi] = (r + 128) & 255;
          out.data[bi + 1] = (g + 128) & 255;
          out.data[bi + 2] = (b + 128) & 255;
        } else {
          out.data[bi] = r;
          out.data[bi + 1] = g;
          out.data[bi + 2] = b;
        }
        out.data[bi + 3] = 255; // force opaque
      }
    }

    writeFileSync(outPngPath, PNG.sync.write(out));
    return true;
  } catch (e) {
    console.error(`[annotation-composite] failed compositing → ${outPngPath}: ${(e as Error).message}`);
    return false;
  }
}

/**
 * Refresh the consolidated `slide_NN_attempt.png` (and, when an annotation
 * exists, `slide_NN_highlighted_attempt.png`) from the just-recorded AFTER
 * thumbnail so the verify step's images reflect the LATEST render rather than
 * the build-time "our current render". Best-effort: never throws, logs on miss.
 *
 * @param afterPng      the AFTER render (e.g. <scratch>/thumbnails/thumbs/<id>.png)
 * @param attemptOut    consolidated slide_NN_attempt.png to overwrite
 * @param annotationPng optional raw annotation to re-composite over the AFTER render
 * @param highlightedOut optional consolidated slide_NN_highlighted_attempt.png
 */
export function refreshConsolidatedAttempt(
  afterPng: string,
  attemptOut: string,
  annotationPng?: string,
  highlightedOut?: string,
): void {
  if (!existsSync(afterPng)) {
    console.error(`[annotation-composite] refresh: AFTER render missing ${afterPng} (keeping build-time attempt)`);
    return;
  }
  try { copyFileSync(afterPng, attemptOut); }
  catch (e) { console.error(`[annotation-composite] refresh: cannot copy ${afterPng} → ${attemptOut}: ${(e as Error).message}`); }
  // Re-composite the annotation over the AFTER render so "highlighted attempt"
  // reflects the latest render too. Only when both an annotation and an output
  // path are provided.
  if (annotationPng && highlightedOut && existsSync(annotationPng)) {
    makeAnnotationComposite(afterPng, annotationPng, highlightedOut);
  }
}

// ---- CLI: refresh one slide's consolidated attempt/highlighted images -------
// Usage: tsx annotation-composite.ts refresh <afterPng> <attemptOut> [annotationPng] [highlightedOut]
// Runs from the worktree renderer/ (pngjs resolves there). Always exits 0 —
// this is a post-render refresh and must never fail the verdict pipeline.
if (process.argv[2] === "refresh") {
  const [, , , afterPng, attemptOut, annotationPng, highlightedOut] = process.argv;
  if (afterPng && attemptOut) {
    refreshConsolidatedAttempt(
      afterPng,
      attemptOut,
      annotationPng || undefined,
      highlightedOut || undefined,
    );
  } else {
    console.error("refresh: need <afterPng> <attemptOut> [annotationPng] [highlightedOut]");
  }
}
