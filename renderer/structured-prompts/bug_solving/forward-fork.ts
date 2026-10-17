/**
 * forward-fork.ts — what a FORWARD fork shares with the host process, and how its rating UI starts.
 *
 * A fork's commands run INSIDE its overlay branch, so a file they write under a repo-relative path
 * lands in the branch's private upper layer, invisible to the host process. The host reads several
 * of those files: step 6b's off-target gate, step 7's sxs-meta.json (writeSxsMeta) and the verdict's
 * AFTER image. Every artefact that crosses that boundary therefore lives in the task's SHARED dir
 * (/overlays/shared/<run>/<task>, outside the overlay), as the reverse direction's reverseForkPaths
 * (reverse-direction.ts) already does. Binary artefacts only the fork reads (before/after pptx, the
 * per-slide diffs) stay in the repo-relative scratch dir.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SlideTask, Task } from "./main.js";

export type ForwardForkPaths = Readonly<{
  /** offtarget-gate.ts's --scratch: reg-diffs/, offtarget-gate.json and the gate's own renders. */
  root: string;
  /** Step 4b's whole-deck structural diffs, one <slide>.diff per fixture. */
  regDiffs: string;
  /** Step 4d's visual verdict (offtarget-gate.ts writes `{ regressions, verdicts, changed }`). */
  offtargetGate: string;
  /** Steps 4c / 7: the cluster's Google render (thumbs/, originals/, thumbs/manifest.json). It is
   *  the fork's rating UI results dir, so ratings.json and sxs-meta.json land here too. */
  thumbnails: string;
  /** The staged per-slide images (workspace-setup.ts stageSlideImages) and step 4e's AFTER images. */
  images: string;
}>;

export function forwardForkPaths(sharedDirectory: string): ForwardForkPaths {
  const root = join(sharedDirectory, "forward");
  return {
    root,
    regDiffs: join(root, "reg-diffs"),
    offtargetGate: join(root, "offtarget-gate.json"),
    thumbnails: join(root, "thumbnails"),
    images: join(sharedDirectory, "images"),
  };
}

/** One slide's post-fix images: step 4c's Google thumbnail, and the copies step 4e makes of it. */
export function forwardAfterImages(paths: ForwardForkPaths, slideId: string): Readonly<{ thumbnail: string; after: string; highlightedAfter: string }> {
  return {
    thumbnail: join(paths.thumbnails, "thumbs", `${slideId}.png`),
    after: join(paths.images, `${slideId}_after.png`),
    highlightedAfter: join(paths.images, `${slideId}_highlighted_after.png`),
  };
}

/** Slides OUTSIDE the cluster whose pptx changed structurally: a `<slide>.diff` in step 4b's
 *  reg-diffs that is not "(no structural differences detected)". Sorted. */
export function changedOffTargets(regDiffsDirectory: string, clusterSlideIds: readonly string[]): string[] {
  if (!existsSync(regDiffsDirectory)) return [];
  const cluster = new Set(clusterSlideIds);
  const changed: string[] = [];
  for (const file of readdirSync(regDiffsDirectory)) {
    if (!file.endsWith(".diff")) continue;
    const slideId = file.replace(/\.diff$/, "");
    if (cluster.has(slideId)) continue; // cluster slides are EXPECTED to change
    let text = "";
    try { text = readFileSync(join(regDiffsDirectory, file), "utf-8"); } catch { continue; }
    if (!/no structural differences/i.test(text)) changed.push(slideId);
  }
  return changed.sort();
}

/** The off-target regressions step 6b fails on: the visual gate's `regressions` when its file
 *  parses, else every structurally changed off-target slide, so a gate-script failure can never
 *  silently drop the safety net. */
export function offTargetRegressions(paths: ForwardForkPaths, clusterSlideIds: readonly string[]): string[] {
  if (existsSync(paths.offtargetGate)) {
    try {
      const gate = JSON.parse(readFileSync(paths.offtargetGate, "utf-8")) as { regressions?: unknown };
      if (Array.isArray(gate.regressions)) return gate.regressions.filter((s): s is string => typeof s === "string");
    } catch { /* fall through to the structural check */ }
  }
  return changedOffTargets(paths.regDiffs, clusterSlideIds);
}

/** The header of one slide's verdict: TARGET, the BEFORE render the user rated, and the AFTER
 *  render step 4c made of the fix (copied by step 4e), with the user's marks over each. */
export function forwardVerdictHeader(task: Task, slide: SlideTask): string {
  const after = forwardAfterImages(forwardForkPaths(task.shared_dir), slide.slide_id);
  const annotation = slide.img_annotations ?? slide.annotation_png;
  const highlightedBefore = slide.img_highlighted ?? slide.composite_png;
  return [
    `You are verifying the fix for ${slide.slide_id}.`,
    `Analysis: ${task.analysis_dir}/analysis.md.`,
    `Diff (OOXML structural): ${task.scratch_dir}/diffs/${slide.slide_id}.diff.`,
    `TARGET render (what it SHOULD look like): ${slide.img_original ?? slide.original_png}.`,
    `BEFORE render (the pre-fix Google-Slides output the user rated BAD): ${slide.img_attempt ?? slide.rendered_png}.`,
    `AFTER render (the post-fix Google-Slides output): ${after.after}.`,
    annotation ? `RAW annotation (the user's marks alone, on transparent bg): ${annotation}.` : ``,
    highlightedBefore ? `HIGHLIGHTED BEFORE (max contrast — the user's marks over the old render): ${highlightedBefore}.` : ``,
    slide.img_annotations ? `HIGHLIGHTED AFTER (max contrast — the same marks over the post-fix render): ${after.highlightedAfter}.` : ``,
    `User's original comment: "${slide.user_comment}".`,
  ].filter((line) => line.length > 0).join(" ");
}

/** The question of one slide's verdict (answered as one line of JSON, parsed by main.ts's parseSlideVerdict). */
export function forwardVerdictPrompt(slideId: string): string {
  return [
    `Read analysis.md (the H2 section for ${slideId}) and the diff file.`,
    `Then use the Read tool to VIEW (open as images — the Read tool renders a PNG visually) ALL of these from the header: the TARGET render, the BEFORE render, the AFTER render, AND — if listed — the "RAW annotation" and both HIGHLIGHTED images. You MUST open HIGHLIGHTED AFTER when one is provided.`,
    `The RAW annotation alone is transparent marks on nothing — open the HIGHLIGHTED images to locate the marked region ON the render (the marked region is colour-shifted so it pops). FOCUS your judgement on that MARKED REGION: locate the same region in the AFTER render and the TARGET, and decide whether the specific defect the user marked is gone — not whether the slide merely looks broadly okay.`,
    `Compare TARGET vs AFTER (within the marked region first, then overall), using BEFORE to see what changed, against the user's comment to judge whether the defect is fixed and nothing new broke.`,
    `IMPORTANT: the OOXML diff can be EMPTY for a correct PIXEL-ONLY fix (e.g. a rasterized rounded-corner image mask). In that case judge from the IMAGES, not the diff — an empty diff is NOT evidence of failure.`,
    `If the AFTER render file is missing/unreadable, judge from the diff + analysis alone and say so in the rationale.`,
    `Respond with ONLY a single-line JSON object (no prose, no code fences, no trailing commentary) with these keys:`,
    `  slide_id     (string, must equal "${slideId}"),`,
    `  rationale    (string, <=500 chars; what changed visually and/or structurally, and why),`,
    `  isRegression (boolean; true if the diff OR the AFTER image introduces NEW rendering problems not mentioned in analysis.md's Expected-diff section),`,
    `  bugSolved    (boolean; true ONLY if the user's MARKED REGION (from the annotation) in the AFTER render now matches the TARGET — the circled defect is visibly GONE — AND the user's comment is addressed AND it matches the Expected-diff claim. A pixel-only fix with an empty diff still counts as solved when the AFTER image's marked region is correct. If an annotation was provided but you could not open it, set bugSolved=false and say so in the rationale).`,
    `Example:`,
    `{"slide_id":"${slideId}","rationale":"device corners now rounded in the AFTER render; target and after match","isRegression":false,"bugSolved":true}`,
  ].join(" ");
}

/**
 * The argv (after `npx tsx rating-server.ts`) of a forward fork's own rating UI: the fork's Google
 * render as the results dir, only the cluster's slides, verdict-only (--read-only), exiting once
 * every slide is rated (so the node running it IS the block), with the analysis + per-slide diffs,
 * recording a CANDIDATE verdict into the ledger. The twin of reverseRatingServerArguments. No
 * goldens flag: a forward fork's "Good" never blesses (its results dir has no meta.json).
 */
export function forwardRatingServerArguments(options: Readonly<{
  resultsDirectory: string;
  slidesDirectory: string;
  port: number;
  slides: readonly string[];
  analysisPath: string;
  diffsDirectory: string;
  taskTitle: string;
  historyDirectory: string;
}>): readonly string[] {
  return [
    options.resultsDirectory,
    "--port", String(options.port),
    "--filter-slides", options.slides.join(","),
    "--slides-dir", options.slidesDirectory,
    "--task-analysis", options.analysisPath,
    "--task-diffs", options.diffsDirectory,
    "--task-title", options.taskTitle,
    "--read-only",
    "--exit-when-all-rated",
    "--history-dir", options.historyDirectory,
    "--candidate",
  ];
}

/**
 * Write the sxs-meta.json sidecar rating-server.ts reads, so each SxS card shows the round-1
 * provenance: the source HTML, the presentation URL (from the upload's thumbs/manifest.json), the
 * user's original annotation and comment. The HTML and the annotation are COPIED into resultsDir
 * (source/, orig-annotations/) so the server's static routes reach them. Runs in the HOST process,
 * which is why resultsDir must be the fork's shared thumbnails dir. Fully non-fatal: a throw here
 * must NEVER turn an already-PASSED fix into a retry.
 */
export function writeSxsMeta(resultsDir: string, slides: readonly SlideTask[]): void {
  try {
    let presentationUrl: string | undefined;
    const manifestPath = join(resultsDir, "thumbs", "manifest.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { presentation_id?: string };
        if (typeof manifest.presentation_id === "string" && manifest.presentation_id) {
          presentationUrl = `https://docs.google.com/presentation/d/${manifest.presentation_id}/edit`;
        }
      } catch { /* malformed manifest → no URL */ }
    }
    const sourceDir = join(resultsDir, "source");
    const annotationDir = join(resultsDir, "orig-annotations");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(annotationDir, { recursive: true });
    const meta: Record<string, {
      html_file?: string;
      presentation_url?: string;
      original_comment?: string;
      original_annotation?: string;
      original_png?: string;
    }> = {};
    for (const slide of slides) {
      const entry: (typeof meta)[string] = {};
      if (slide.html_file && existsSync(slide.html_file)) {
        try { copyFileSync(slide.html_file, join(sourceDir, `${slide.slide_id}.html`)); entry.html_file = `source/${slide.slide_id}.html`; } catch { /* best-effort */ }
      }
      if (presentationUrl) entry.presentation_url = presentationUrl;
      if (slide.user_comment) entry.original_comment = slide.user_comment;
      if (slide.annotation_png && existsSync(slide.annotation_png)) {
        try { copyFileSync(slide.annotation_png, join(annotationDir, `${slide.slide_id}.png`)); entry.original_annotation = `orig-annotations/${slide.slide_id}.png`; } catch { /* best-effort */ }
      }
      // The staged copy on /overlays first: the fork's rating UI runs in the jail, where /tmp is empty.
      const originalPng = slide.img_original ?? slide.original_png;
      if (originalPng && existsSync(originalPng)) entry.original_png = originalPng;
      meta[slide.slide_id] = entry;
    }
    writeFileSync(join(resultsDir, "sxs-meta.json"), JSON.stringify(meta, null, 2));
  } catch (e) {
    console.error(`[writeSxsMeta] non-fatal: ${(e as Error).message}`);
  }
}
