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
 *
 * `forwardChain` is the forward direction of the shared fork chain (fork-chain.ts).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionWithResult } from "../../../structured-prompting/src/index.js";
import type { SlideTask, Task, TaskResult } from "./main.js";
import { BRANCH_CD_RENDERER, FORK_SCRIPTS, type DirectionChain } from "./fork-chain.js";
import { acceptDisabled } from "./rating-gate.js";

/** The forward candidate/demotion ledger the fork's rating server and gate mirror verdicts into. */
export const FORWARD_HISTORY_DIR = "/workspaces/sashaslides/.bug-solving-history";

/** Repository-relative scripts only the forward chain runs. */
const SCRIPTS = {
  // record-rendering.ts runs with cwd = <workspace>/renderer so tsx + convert-pptx's node_modules
  // resolve; it writes per-slide pptx to <out>/pptx/<slide_id>.pptx.
  record: "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts",
  diff: "renderer/structured-prompts/bug_solving/scripts/diff-pptx-pairs.ts",
  // The fork's rating UI (step A1), launched with forwardRatingServerArguments.
  ratingServer: "renderer/html2slides/rating-server.ts",
  // Renders the changed non-cluster slides BEFORE/AFTER and image-verifies whether the change is a
  // VISIBLE regression. Writes <shared>/forward/offtarget-gate.json.
  offtargetGate: "renderer/structured-prompts/bug_solving/scripts/offtarget-gate.ts",
} as const;

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

/** The worker's header: where it runs, the cluster, and per slide the user's comment and every
 *  image to open, plus how to write analysis.md. */
function analysisPromptFor(task: Task): string {
  return [
    `Task: ${task.task_id}`,
    `You are running INSIDE an isolated overlay branch (${task.branch_id}); your cwd is the repository root and every edit is captured in the branch's private layer (the base working tree is untouched).`,
    `Scratch (binary artifacts, repo-relative inside the branch): ${task.scratch_dir}`,
    `Analysis dir (write analysis.md / fix-summary.md HERE, repo-relative inside the branch): ${task.analysis_dir}`,
    `Cluster hypothesis: ${task.cluster_description}`,
    ``,
    `Slides in this task, the user's SxS comments, and the IMAGE MANIFEST for each.`,
    `Open EACH listed image with the Read tool (it renders PNGs visually):`,
    ...task.slides.flatMap(s => {
      const target = s.img_original ?? s.original_png;
      const attempt = s.img_attempt ?? s.rendered_png;
      const lines = [
        ``,
        `  ${s.slide_id}: "${s.user_comment}"`,
        `    - TARGET (what the slide SHOULD look like): ${target}`,
        `    - ATTEMPT (what the converter currently produces — the defect is HERE): ${attempt}`,
      ];
      const rawAnn = s.img_annotations ?? s.annotation_png;
      if (rawAnn)
        lines.push(`    - RAW ANNOTATION (the user's marks alone, on transparent bg — just to see the shapes): ${rawAnn}`);
      const highlighted = s.img_highlighted ?? s.composite_png;
      if (highlighted)
        lines.push(`    - HIGHLIGHTED ATTEMPT, MAX CONTRAST (the user's marks applied over the TARGET slide with the marked region colour-shifted for maximum visibility — THIS shows you EXACTLY WHERE on the slide the user is pointing): ${highlighted}`);
      return lines;
    }),
    ``,
    `How to incorporate the user's comments into your analysis:`,
    `  * The user's words are ground truth — do not argue with them. Your job is`,
    `    to explain the WHY and propose the minimal fix.`,
    `  * Open ALL of the images above with the Read tool (it renders PNGs`,
    `    visually). The RAW ANNOTATION alone is meaningless (transparent`,
    `    rectangles on nothing) — use the HIGHLIGHTED ATTEMPT (max-contrast`,
    `    composite) to locate the marked region on the actual slide, then compare`,
    `    the ATTEMPT vs TARGET in that region to see the defect.`,
    `  * Always disambiguate TEXT-vs-BOX when the comment is about alignment.`,
    `  * Write your findings into ${task.analysis_dir}/analysis.md. Use one H2`,
    `    section per slide. Each section must have: "User comment" (verbatim),`,
    `    "Observed in current render" (what you see), "Root cause" (file:line),`,
    `    "Fix strategy" (what you'll change), "Expected diff" (what the pptx`,
    `    XML change will look like). analysis.md is retry-persistent — on`,
    `    subsequent attempts, UPDATE existing sections rather than rewriting.`,
    ``,
    `After writing analysis.md, apply the fix. Do NOT commit.`,
  ].join("\n");
}

function forwardFixPrompt(task: Task): string {
  return [
    `The BEFORE-state pptx files are already at ${task.scratch_dir}/before/pptx/<slide_id>.pptx — the scaffolding recorded them before you started. Use them as reference if helpful.`,
    ``,
    `Your only task right now:`,
    `  1. Open EVERY image in the per-slide IMAGE MANIFEST from the header with the Read tool (TARGET, ATTEMPT, RAW ANNOTATION, and the HIGHLIGHTED ATTEMPT max-contrast composite). Use the highlighted attempt to locate the marked region on the slide, then compare ATTEMPT vs TARGET there.`,
    `  2. Write (or UPDATE if it exists) ${task.analysis_dir}/analysis.md with one H2 section per slide using the template you were given.`,
    `  3. Apply the MINIMAL code fix in renderer/html2slides/extract-dom.ts and/or convert-pptx.ts.`,
    `  4. Do NOT run git commit, git stash, git checkout. Leave changes uncommitted.`,
    `  5. Do NOT record the AFTER pptx, do NOT run the diff script — the orchestrator runs those next.`,
    ``,
    `When analysis.md is written and the code edits are in place, reply with exactly the line: FIX_APPLIED.`,
    `If something blocks you, reply with "FAILED: <one-line reason>" and stop.`,
  ].join("\n");
}

/**
 * The FORWARD direction of the fork chain: HTML fixture -> pptx -> Google Slides. Everything the
 * host reads back from the fork (gate verdict, Google render, AFTER images, ratings) goes to the
 * shared dir, outside the overlay. Step 1 (record the BEFORE pptx) runs in the scaffolding.
 */
export function forwardChain(task: Task): DirectionChain {
  const ids = task.slides.map((slide) => slide.slide_id).join(",");
  const fork = forwardForkPaths(task.shared_dir);
  // Step 7 re-runs step 4c's render; record-rendering is idempotent per phase, so it only repeats
  // work when 4c failed.
  const renderThumbnails =
    `npx tsx "$ROOT/${SCRIPTS.record}" ` +
    `--mode full --fixtures "$ROOT/${task.fixtures_dir}" ` +
    `--slides ${ids} --title "${task.presentation_title}" ` +
    `--out "${fork.thumbnails}" || true`;
  return {
    brief: analysisPromptFor(task),
    fixPrompt: forwardFixPrompt(task),
    afterFix: (fixed: SessionWithResult<string>) => fixed
      // Step 3 — record the AFTER pptx inside the branch, so it picks up the worker's fix.
      .executeShell(() =>
        `${BRANCH_CD_RENDERER} && npx tsx "$ROOT/${SCRIPTS.record}" ` +
        `--mode pptx --fixtures "$ROOT/${task.fixtures_dir}" ` +
        `--slides ${ids} --out "$ROOT/${task.scratch_dir}/after"`
      )
      // Step 4 — pairwise OOXML diffs of the cluster's slides.
      .executeShell(() =>
        `${BRANCH_CD_RENDERER} && npx tsx "$ROOT/${SCRIPTS.diff}" ` +
        `--before "$ROOT/${task.scratch_dir}/before/pptx" --after "$ROOT/${task.scratch_dir}/after/pptx" ` +
        `--out "$ROOT/${task.scratch_dir}/diffs"`
      )
      // Step 4b — REGRESSION SCAN across the whole deck: render every fixture with the fix and diff
      // it against the pristine `before-all` baseline the scaffolding staged (re-rendering it here
      // would nest an overlay inside the jail, which the kernel rejects). Dirs are cleared first so
      // a retry never diffs stale pptx. MERGE_RENDER_CONCURRENCY=1 falls back to serial.
      .executeShell(() => {
        const fx = task.fixtures_dir;
        // /tmp scratch outside the overlay for the whole-deck AFTER pptx.
        const reg = `/tmp/bs-reg-${task.branch_id}`;
        return [
          BRANCH_CD_RENDERER,
          `rm -rf ${reg} "${fork.regDiffs}" && mkdir -p ${reg}`,
          `ALL=$(ls "$ROOT/${fx}"/slide_*.html | xargs -n1 basename | sed 's/[.]html$//' | sort -V | paste -sd,)`,
          `RECORD_CONCURRENCY=${process.env.MERGE_RENDER_CONCURRENCY || "5"} npx tsx "$ROOT/${SCRIPTS.record}" --mode pptx --fixtures "$ROOT/${fx}" --slides "$ALL" --out ${reg}/after-all`,
          `npx tsx "$ROOT/${SCRIPTS.diff}" --before "$ROOT/${task.scratch_dir}/before-all/pptx" --after ${reg}/after-all/pptx --out "${fork.regDiffs}"`,
        ].join(" && ");
      })
      // Step 4c — render the AFTER state to Google Slides so each verdict can judge PIXEL-ONLY
      // fixes the OOXML diff is blind to. Cleared first so a retry re-renders the new fix.
      // Best-effort: the verdict falls back to the diff when the AFTER image is missing.
      .executeShell(() => `${BRANCH_CD_RENDERER} && rm -rf "${fork.thumbnails}" && ${renderThumbnails}`)
      // Step 4d — VISUAL off-target gate over step 4b's reg-diffs: renders each changed non-cluster
      // slide BEFORE/AFTER and asks an image verifier whether the change is a VISIBLE regression.
      // Best-effort: step 6b falls back to the structural check when its file is missing (a
      // previous attempt's file is removed first so it can never stand in).
      .executeShell(() =>
        `${BRANCH_CD_RENDERER} && rm -f "${fork.offtargetGate}" && npx tsx "$ROOT/${SCRIPTS.offtargetGate}" ` +
        `--scratch "${fork.root}" --cluster ${ids} --workdir "$ROOT" ` +
        `--fixtures "$ROOT/${task.fixtures_dir}" ` +
        `--record "$ROOT/${SCRIPTS.record}" ` +
        `--title "${task.presentation_title}-offtarget" || true`,
      )
      // Step 4e — each slide's AFTER thumbnail copied to <shared>/images/<id>_after.png with the
      // user's marks composited over it, for the verdict header. Best-effort per slide.
      .executeShell(() => {
        const composite = `"$ROOT/${FORK_SCRIPTS.composite}"`;
        const cmds = task.slides.map(s => {
          const images = forwardAfterImages(fork, s.slide_id);
          const ann = s.img_annotations ? ` "${s.img_annotations}" "${images.highlightedAfter}"` : ``;
          return `npx tsx ${composite} refresh "${images.thumbnail}" "${images.after}"${ann} || true`;
        });
        return `${BRANCH_CD_RENDERER} && mkdir -p "${fork.images}" && ${cmds.join(" && ")}`;
      }),
    verdictHeader: (slide) => forwardVerdictHeader(task, slide),
    verdictPrompt: forwardVerdictPrompt,
    sxsServerSpec: {
      port: task.server_port,
      slides: task.slides.map(s => s.slide_id),
      analysis_md: `${task.analysis_dir}/analysis.md`,
      diffs_dir: `${task.scratch_dir}/diffs`,
      // record-rendering --mode full writes the thumbnail to <out>/thumbs/<id>.png.
      thumbnails_dir: join(fork.thumbnails, "thumbs"),
      task_title: `bug_solving: ${task.task_id}`,
    },
    // C2: only off-target changes the step-4d visual gate confirmed are VISIBLY worse.
    gateFailures: () => {
      const offTarget = offTargetRegressions(fork, task.slides.map(s => s.slide_id));
      return offTarget.length
        ? [`OFF-TARGET VISIBLE REGRESSIONS (${offTarget.length}) — non-cluster slides the image verifier judged visibly worse after this fix: ${offTarget.join(", ")}`]
        : [];
    },
    // Step 7 — post-verdict productization, NON-FATAL (`|| true`, writeSxsMeta swallows): a flaky
    // Google upload must never throw an already-PASSED fix away.
    afterVerdict: (passed: SessionWithResult<TaskResult>) => passed.combineWith<string, TaskResult>(
      (branch) => branch.executeShell(() => `${BRANCH_CD_RENDERER} && ${renderThumbnails}`),
      (taskResult) => {
        writeSxsMeta(fork.thumbnails, task.slides);
        return taskResult;
      },
    ),
    // Step A1 — the fork's rating UI on its shared Google render. NO_ACCEPT (no human) skips it.
    ratingServerCommand: (tr) => {
      if (acceptDisabled(process.env)) {
        return `${BRANCH_CD_RENDERER} && echo "[rating-server] NO_ACCEPT → skipping ${task.task_id} rating UI"`;
      }
      const spec = tr.sxs_server_spec;
      const log = `${fork.root}/rating-server.log`;
      const serverArguments = forwardRatingServerArguments({
        resultsDirectory: fork.thumbnails,
        slidesDirectory: spec.thumbnails_dir,
        port: spec.port,
        slides: spec.slides,
        // repo-relative inside the branch → absolute via $ROOT
        analysisPath: `$ROOT/${spec.analysis_md}`,
        diffsDirectory: `$ROOT/${spec.diffs_dir}`,
        taskTitle: spec.task_title,
        historyDirectory: FORWARD_HISTORY_DIR,
      });
      return (
        `${BRANCH_CD_RENDERER} && mkdir -p "${fork.root}" && ` +
        `echo "[rating-server] ${task.task_id} → http://localhost:${spec.port} (log ${log})" && ` +
        `npx tsx "$ROOT/${SCRIPTS.ratingServer}" ${serverArguments.map((argument) => `"${argument}"`).join(" ")} 2> "${log}"`
      );
    },
    // The history dir is outside the repository but inside the overlay's lower, so the gate's
    // ledger mirror lands in the branch upper: best-effort only.
    ratings: { resultsDirectory: fork.thumbnails, ratingsFile: null, historyDirectory: FORWARD_HISTORY_DIR },
  };
}
