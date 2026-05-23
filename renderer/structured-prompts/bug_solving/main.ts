/**
 * bug_solving — structured prompt for resolving a clustered batch of
 * html2slides rendering bugs across one or more slides.
 *
 * A single "task" = one cluster of slides whose bugs share a root cause
 * (e.g. "clipping library / curved edges" covering slides 11, 12, 14, 28).
 * Every task gets its own forked session working inside its own git
 * worktree, with a per-task scratch directory under the worktree.
 *
 * Pipeline per task (retryable up to N times):
 *   1. Record ORIGINAL pptx — 1 file per slide, built in parallel from
 *      the current code state in the worktree.
 *   2. Inspect user comments + rendered/original/annotation PNGs, write
 *      an analysis markdown into the workspace (persistent — kept in
 *      sync across retry rounds), then apply the code fix.
 *   3. Record NEW pptx after the fix (same per-slide layout).
 *   4. Emit a human-readable diff per slide (OOXML-level) into
 *      `diffs/<slide_id>.diff`.
 *   5. For each slide fork a sub-session that reads the diff + the
 *      original analysis + user comment and produces a structured JSON
 *      verdict: {slide_id, rationale, isRegression, bugSolved}.
 *   6. Aggregate verdicts: if any isRegression || !bugSolved, throw →
 *      retry (state from step 2 is preserved so the next attempt refines
 *      rather than restarts).
 *   7. Upload the combined pptx (of all slides in the task) under a
 *      fork-unique presentation name, scrape per-slide PNG thumbnails.
 *   8. Boot a filtered rating-server on a per-task port that shows only
 *      this task's slides with two extra buttons per SxS row:
 *      "Show analysis" (analysis.md) and "Show diff analysis"
 *      (per-slide verdict JSON).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";

/** Best-effort directory listing — returns [] on ENOENT instead of throwing. */
function readdirSyncSafe(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}
import { resolve as resolvePath } from "path";
import { execSync } from "child_process";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
  Claude,
  Session,
  SessionWithResult,
  ValidationError,
  describeError,
  safelyJsonStringify,
} from "../../../structured-prompting/src/index.js";
import type { Result } from "../../../structured-prompting/src/api/wire.js";

/**
 * Produce a pixel-diff PNG between two reference images. Pixels that differ
 * (above a small RGB threshold) are coloured red; matching pixels are
 * left as a faded version of `aPath`. The two inputs are downscaled to a
 * shared 1280×720 grid first so different DPRs / Slides-vs-Chrome
 * resolution mismatches line up. Output is written to `diffPath`.
 *
 * Used by Step 7.5 (visual check) so the model gets a third image with
 * "where do we still differ from the ground truth" pre-marked.
 */

/**
 * Extract OOXML structural facts from a per-slide `.pptx` so the verdict
 * model can answer "is this still a native table?" / "how many shapes?"
 * without re-deriving from pixels.
 *
 * Counts: `<a:tbl>` (native pptx table), `<p:graphicFrame>` (the wrapper
 * pptx uses for tables/charts), `<p:sp>` (every other shape), `<p:pic>`
 * (raster image — should be ZERO for a fixture that has no <img>), and
 * `<p:grpSp>` (clip-group wrappers from rule 3). Returns a one-line
 * summary the prompt can include verbatim.
 *
 * Best-effort: failures (e.g. pptx not present) return "facts unavailable".
 */
function structuralFacts(pptxPath: string): string {
  if (!existsSync(pptxPath)) return "facts unavailable (pptx missing)";
  try {
    const xml = execSync(
      `unzip -p ${JSON.stringify(pptxPath)} ppt/slides/slide1.xml 2>/dev/null`,
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 },
    );
    const count = (re: RegExp): number => (xml.match(re) ?? []).length;
    const tbl = count(/<a:tbl[\s>]/g);
    const gFrame = count(/<p:graphicFrame[\s>]/g);
    const sp = count(/<p:sp[\s>]/g);
    const pic = count(/<p:pic[\s>]/g);
    const grpSp = count(/<p:grpSp[\s>]/g);
    return `<a:tbl>=${tbl} <p:graphicFrame>=${gFrame} <p:sp>=${sp} <p:pic>=${pic} <p:grpSp>=${grpSp}`;
  } catch {
    return "facts unavailable (unzip failed)";
  }
}

function pixelDiffPng(aPath: string, bPath: string, diffPath: string): void {
  const W = 1280, H = 720;
  const loadAndResize = (path: string) => {
    const png = PNG.sync.read(readFileSync(path));
    if (png.width === W && png.height === H) return png;
    // Nearest-neighbor resize to W×H. Fast + good enough for diff overlay.
    const out = new PNG({ width: W, height: H });
    for (let y = 0; y < H; y++) {
      const sy = Math.min(png.height - 1, Math.floor((y / H) * png.height));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(png.width - 1, Math.floor((x / W) * png.width));
        const si = (sy * png.width + sx) * 4;
        const di = (y * W + x) * 4;
        out.data[di] = png.data[si];
        out.data[di + 1] = png.data[si + 1];
        out.data[di + 2] = png.data[si + 2];
        out.data[di + 3] = png.data[si + 3];
      }
    }
    return out;
  };
  const a = loadAndResize(aPath);
  const b = loadAndResize(bPath);
  const diff = new PNG({ width: W, height: H });
  pixelmatch(a.data, b.data, diff.data, W, H, {
    threshold: 0.1,
    diffColor: [255, 0, 0],   // red on differences
    diffColorAlt: [255, 165, 0],
    alpha: 0.4,                // matched pixels render as faded `a`
  });
  writeFileSync(diffPath, PNG.sync.write(diff));
}

// ---------- Types ----------

export interface SlideTask {
  slide_id: string;                  // "slide_11"
  html_file: string;                 // absolute path to the fixture HTML
  user_comment: string;              // text pulled from ratings.json
  annotation_png?: string;           // absolute path if present
  rendered_png: string;              // absolute path in /tmp/sxs-complex/slides
  original_png: string;              // absolute path in /tmp/sxs-complex/originals
}

export interface Task {
  task_id: string;                   // stable slug, e.g. "clipping-curves"
  workspace_dir: string;             // git worktree created for this task
  scratch_dir: string;               // per-task scratch (under workspace_dir)
  server_port: number;               // unique port for the filtered rating server
  presentation_title: string;        // fork-unique, e.g. "bug_solving-clipping-curves-1713512345"
  slides: SlideTask[];
  cluster_description: string;       // root-cause hypothesis for the wave
  retry_budget: number;              // e.g. 3
  // Shared baseline recorded ONCE per wave on main's HEAD (see
  // scripts/baseline-record.ts). Contains:
  //   <baseline_dir>/pptx/<slide_id>.pptx    → consumed by the diff step
  //   <baseline_dir>/thumbs/<slide_id>.png   → shown in the SxS as "baseline" toggle
  //   <baseline_dir>/thumbs/manifest.json    → presentation_id + slide oids
  baseline_dir: string;
  // Where each slide's fixture HTML lives. Propagated to record-rendering
  // via `--fixtures` so multi-source clusters (e.g. tables that span
  // fixtures-basic AND fixtures) can flatten into one dir under a
  // namespaced ID (basic_slide_14, complex_slide_05) without collisions.
  fixtures_dir: string;
  // Where the prior wave's SxS rating server wrote per-annotation
  // zoom-crops (3× nearest-neighbour blow-ups of the regions the user
  // marked). Filenames: `<slide_id>(-NN)?-(rendered|original).png`.
  // Step 7.5 attaches every matching crop to the visual-verification
  // prompt so workers can see single-pixel detail the user flagged.
  zoom_crops_dir: string;
}

export type SlideVerdict = {
  slide_id: string;
  rationale: string;
  isRegression: boolean;
  bugSolved: boolean;
};

export type VisualVerdict = {
  slide_id: string;
  visualVerdict: "pass" | "fail";
  reason: string;
};


export interface TaskResult {
  task_id: string;
  workspace_dir: string;
  analysis_md: string;               // path to analysis.md written by the worker
  verdicts: SlideVerdict[];
  sxs_url: string;                   // http://localhost:<server_port>
  fix_summary: string;               // one-paragraph summary emitted by the worker
}

// ---------- Helpers ----------

/** Path to the shell/ts helper scripts that live alongside main.ts.
 *
 * IMPORTANT — worktree vs. parent repo:
 *   - `record` runs from the worker's worktree (`cd ${task.workspace_dir}`),
 *     because it MUST use the worktree's converter code — that's the whole
 *     point of bug-solving. The worker is allowed (and expected) to edit
 *     `renderer/html2slides/*.ts` in their worktree; `record-rendering`
 *     then produces a pptx using those edits.
 *   - `diff` and `filteredServer` are INFRASTRUCTURE: they don't depend on
 *     the worker's converter code, so they must be PINNED to the parent
 *     repo's copy. Without this pin, a worker who edits one of these
 *     scripts in their worktree (mistakenly believing it's converter code)
 *     poisons the post-pass for the whole wave. This actually happened
 *     once: a worker rewrote `filtered-rating-server.ts` into a lossy
 *     compatibility wrapper that dropped --html-dir / --baseline-dir /
 *     --bug-context and never wired the Slides deep link from
 *     thumbnails/manifest.json. The next wave seeded the broken copy
 *     forward and the SxS lost its HTML + Slides links until restored.
 */
const PARENT_REPO_ROOT = process.cwd();
const SCRIPTS = {
  // Worktree-relative (the worker is allowed to edit converter code that
  // record-rendering pulls in via tsx).
  record: "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts",
  // Pinned absolute to the parent repo so the worker can't break infra.
  diff: resolvePath(PARENT_REPO_ROOT, "renderer/structured-prompts/bug_solving/scripts/diff-pptx-pairs.ts"),
  filteredServer: resolvePath(PARENT_REPO_ROOT, "renderer/structured-prompts/bug_solving/scripts/filtered-rating-server.ts"),
};

/** Path to the tsxx profiling launcher. Behaves like `npx tsx` but emits a
 *  per-statement timing profile to /tmp/tsxx-XXXX/profile.txt on exit. Used
 *  for the recording call sites where we want to know which step dominates
 *  the per-task budget. See tools/tsxx/. */
const TSXX = "node /workspaces/sashaslides/tools/tsxx/tsxx.mjs";

const slideIdsCsv = (t: Task) => t.slides.map(s => s.slide_id).join(",");

/** Build the per-slide analysis prompt text. Included in the first-round
 *  prompt so the worker knows exactly how to treat user SxS comments. */
function analysisPromptFor(task: Task): string {
  return [
    `Task: ${task.task_id}`,
    `Workspace: ${task.workspace_dir}`,
    `Scratch: ${task.scratch_dir}`,
    `Cluster hypothesis: ${task.cluster_description}`,
    ``,
    `Slides in this task and the user's SxS comments for each:`,
    ...task.slides.map(s =>
      `  - ${s.slide_id}: "${s.user_comment}"` +
      (s.annotation_png ? ` (annotation: ${s.annotation_png})` : ``)
    ),
    ``,
    `IMPORTANT — CLUSTER SCOPE:`,
    `  * Multiple parallel clusters run on this wave. Each cluster owns ONE`,
    `    root-cause family (the "Cluster hypothesis" above). A user's SxS`,
    `    comment may mention MULTIPLE distinct issues on the same slide — only`,
    `    the issue(s) matching THIS cluster's hypothesis are yours to fix.`,
    `    The other issues are owned by sibling clusters and will be addressed`,
    `    in their worktrees.`,
    `  * Example: if the user's comment on slide_X mentions both wrong text`,
    `    positioning AND a clipping bug, and this cluster's hypothesis is`,
    `    "vertical text positioning", then your scope is ONLY the positioning`,
    `    part. Leaving the clipping concern unfixed is correct behaviour —`,
    `    NOT a regression, NOT an unsolved bug from this cluster's perspective.`,
    `  * If a slide's user-comment topics don't overlap with this cluster's`,
    `    hypothesis AT ALL, say so explicitly in analysis.md and apply no fix`,
    `    for that slide. The verdict will mark bugSolved=true on the grounds`,
    `    that nothing in this cluster's scope was broken.`,
    ``,
    `How to incorporate the user's comments into your analysis:`,
    `  * The user's words are ground truth — do not argue with them. Your job is`,
    `    to explain the WHY and propose the minimal fix WITHIN THIS CLUSTER'S SCOPE.`,
    `  * For each slide, open the annotation PNG if it exists. The red strokes`,
    `    mark exactly where the user says the rendering is wrong. Read those`,
    `    strokes through the lens of this cluster's hypothesis.`,
    `  * Always disambiguate TEXT-vs-BOX when the comment is about alignment.`,
    `  * Write your findings into ${task.scratch_dir}/analysis.md. Use one H2`,
    `    section per slide. Each section must have: "User comment" (verbatim),`,
    `    "In-scope for this cluster" (which part of the comment is yours to fix),`,
    `    "Observed in current render" (what you see), "Root cause" (file:line),`,
    `    "Fix strategy" (what you'll change), "Expected diff" (what the pptx`,
    `    XML change will look like). analysis.md is retry-persistent — on`,
    `    subsequent attempts, UPDATE existing sections rather than rewriting.`,
    ``,
    `After writing analysis.md, apply the fix. Do NOT commit.`,
  ].join("\n");
}

// ---------- Main ----------

export function main(args: {
  session: Session;
  tasks: Task[];
}): SessionWithResult<Array<Result<TaskResult>>> {

  // --- inner per-task attempt body ----------------------------------------
  const runTask = (s: Session, task: Task): SessionWithResult<TaskResult> => {
    const ids = slideIdsCsv(task);
    return s
      // Step 1 — read user comments + annotations, write analysis.md, apply
      //   the minimal code fix. The BEFORE pptx was already recorded ONCE
      //   for the whole wave at `task.baseline_dir` (see Step 0 of main()) —
      //   each task inherits it instead of rebuilding.
      .prependToNextPrompt(analysisPromptFor(task))
      .send({
        prompt: [
          `The shared BASELINE pptx files (main's current rendering) are at`,
          `${task.baseline_dir}/pptx/<slide_id>.pptx — use them as the "before"`,
          `reference. Write or UPDATE ${task.scratch_dir}/analysis.md using the`,
          `template in the instructions you received. Then apply the minimal`,
          `code fix to renderer/html2slides/extract-dom.ts and/or convert-pptx.ts.`,
          `Do not run git commit. When done, respond with exactly "FIX_APPLIED".`,
        ].join(" "),
      })

      // Step 2 — quick post-fix recording: per-slide pptx ONLY (mode=pptx).
      //   Cheapest possible record so the verdict step has a diff input
      //   without paying the screenshot/upload tax on attempts that may
      //   fail and retry.
      .executeShell(() =>
        `cd ${task.workspace_dir} && ${TSXX} ${SCRIPTS.record} ` +
        `--mode pptx --slides ${ids} --fixtures ${task.fixtures_dir} ` +
        `--out ${task.scratch_dir}/after`
      )

      // Step 3 — diff shared baseline vs after.
      .executeShell(() =>
        `cd ${task.workspace_dir} && npx tsx ${SCRIPTS.diff} ` +
        `--before ${task.baseline_dir}/pptx --after ${task.scratch_dir}/after/pptx ` +
        `--out ${task.scratch_dir}/diffs`
      )

      // Step 4-5 — per-slide verdict: split into TWO sends.
      //   First send asks the model to read analysis.md + diff and write its
      //   reasoning as prose to a file (zero JSON discipline, just
      //   thinking). Second send is structured (typia-typed) and emits the
      //   strict SlideVerdict shape — the engine parses, no manual
      //   stripping/try-catch needed downstream.
      .parallelFork(task.slides, (child, slide) =>
        child
          .tryMultipleTimes(3, s => (s
            .prependToNextPrompt(
              `You are verifying the fix for ${slide.slide_id}. ` +
              `Cluster hypothesis (this cluster's scope): "${task.cluster_description.split("\n")[0]}". ` +
              `Analysis: ${task.scratch_dir}/analysis.md. ` +
              `Diff: ${task.scratch_dir}/diffs/${slide.slide_id}.diff. ` +
              `User's original comment: "${slide.user_comment}". ` +
              `NOTE: the user's comment may mention concerns OUTSIDE this cluster's scope — ` +
              `those are owned by sibling clusters and are not your responsibility on this run.`,
            )
            .send({
              prompt: [
                `Step A — REASONING ONLY (no structured output yet).`,
                `Read analysis.md (section for ${slide.slide_id}) and the diff file.`,
                `Write your full reasoning to ${task.scratch_dir}/${slide.slide_id}-verdict.md`,
                `as plain markdown. Your reasoning MUST address all three of:`,
                `(1) what the diff changed,`,
                `(2) whether the diff addresses THIS CLUSTER'S SCOPE of the user's`,
                `comment — i.e. the issue(s) that match the cluster hypothesis. If`,
                `the comment also mentions concerns that belong to sibling clusters,`,
                `EXPLICITLY name them and note they are out of scope for this verdict.`,
                `(3) whether the diff introduces NEW problems (regressions) — either`,
                `to this slide OR to any other slide — that were NOT present before`,
                `and are NOT in the "Expected diff" section.`,
                `Then reply with exactly "VERDICT_THINKING_DONE".`,
              ].join(" "),
            })
            .send<SlideVerdict>({
              prompt: [
                `Step B — emit your verdict as a SlideVerdict structured-output object.`,
                `slide_id="${slide.slide_id}". rationale: <=500 chars summarising your`,
                `${slide.slide_id}-verdict.md analysis.`,
                ``,
                `Definitions (read carefully — these are scoped to THIS cluster):`,
                ``,
                `isRegression=true iff the diff INTRODUCES NEW problems that were not`,
                `present before this diff — either on this slide or on any other`,
                `slide — and are NOT documented in the analysis's "Expected diff"`,
                `section. Leaving a pre-existing problem unfixed is NOT a regression.`,
                `Failing to address a part of the user's comment that belongs to a`,
                `sibling cluster (different hypothesis) is NOT a regression.`,
                ``,
                `bugSolved=true iff the diff fixes the part of the user's comment that`,
                `falls within THIS CLUSTER'S hypothesis. If the user's comment has`,
                `multiple concerns and only one of them is in this cluster's scope,`,
                `bugSolved=true when that one concern is fixed — even if the other`,
                `concerns remain. If NONE of the comment's concerns belong to this`,
                `cluster (rare — flag in rationale), bugSolved=true on the grounds`,
                `that nothing was broken from this cluster's perspective and no fix`,
                `was warranted.`,
              ].join(" "),
            })
          )),
      )

      // Step 6 — aggregate typed verdicts. No JSON parsing needed — the
      //   engine returned SlideVerdict[] directly thanks to send<T>. Branch
      //   asks the worker for a one-paragraph fix-summary (keeps prose).
      .combineWith<string, TaskResult>(
        (branch) => branch.send({
          prompt: [
            `Write ${task.scratch_dir}/fix-summary.md — one paragraph covering`,
            `the root cause and what you changed, referencing file:line. Then`,
            `paste the contents of that file back in your reply (no JSON, no`,
            `markdown fences). The orchestrator will use your reply verbatim as`,
            `the fix_summary field.`,
          ].join(" "),
        }),
        (verdicts, fixSummary) => {
          const regressions = verdicts.filter(v => v.isRegression);
          const unsolved = verdicts.filter(v => !v.bugSolved);
          if (regressions.length > 0 || unsolved.length > 0) {
            const lines: string[] = [];
            if (regressions.length)
              lines.push(`REGRESSIONS (${regressions.length}):`,
                ...regressions.map(r => `  - ${r.slide_id}: ${r.rationale}`));
            if (unsolved.length)
              lines.push(`UNSOLVED (${unsolved.length}):`,
                ...unsolved.map(r => `  - ${r.slide_id}: ${r.rationale}`));
            // ValidationError → tryMultipleTimes can retry. A bare Error
            // would also be retried today, but isCatchable() rejects bare
            // Errors so future bugs in this aggregator (e.g. a TypeError
            // from a malformed verdict) abort the wave instead of looping.
            throw new ValidationError(lines.join("\n"));
          }
          return {
            task_id: task.task_id,
            workspace_dir: task.workspace_dir,
            analysis_md: `${task.scratch_dir}/analysis.md`,
            verdicts,
            sxs_url: "",
            fix_summary: fixSummary,
          };
        },
      )

      // Step 7 — top up the post-fix recording: now that the verdict is good,
      //   add Chrome screenshots + Slides upload + thumbs scrape to the same
      //   <after> dir. mode=full skips the pptx step (already done in Step 2).
      .executeShell(() =>
        `cd ${task.workspace_dir} && ${TSXX} ${SCRIPTS.record} ` +
        `--mode full --slides ${ids} --title "${task.presentation_title}" ` +
        `--fixtures ${task.fixtures_dir} ` +
        `--out ${task.scratch_dir}/after`
      )

      // Step 7.5 — visual check via vision. For each slide, generate a
      //   pixel-diff PNG between the Chrome ground truth and the post-fix
      //   Slides render (red marks on differences), then split the model
      //   call into two sends:
      //     (a) prose: model looks at test, baseline, and diff; writes its
      //         observations to `${slide_id}-visual.md`.
      //     (b) structured: send<VisualVerdict> emits the typed pass/fail.
      //   Aggregate via assert: if ANY slide is "fail", throw →
      //   tryMultipleTimes retries the whole task. Combine returns upstream
      //   so the outer chain shape is preserved for Step 8.
      .combineWith<VisualVerdict[]>(
        (branch) => branch
          .parallelFork(task.slides, (child, slide) => {
            const testPath = resolvePath(task.scratch_dir, "after/thumbs", `${slide.slide_id}.png`);
            const baselinePath = resolvePath(task.baseline_dir, "originals", `${slide.slide_id}.png`);
            const diffPath = resolvePath(task.scratch_dir, "after/diffs", `${slide.slide_id}-vs-truth.png`);
            // Generate the marked-differences PNG inline so the model sees
            // EXACTLY where the post-fix Slides render still diverges from
            // the Chrome ground truth. Built lazily here (parallelFork apply
            // runs at execution time, after Step 7's screenshots exist).
            mkdirSync(resolvePath(task.scratch_dir, "after/diffs"), { recursive: true });
            pixelDiffPng(baselinePath, testPath, diffPath);
            // Pre-compute OOXML structural facts from the produced pptx so
            // the model doesn't have to guess "is it a table?" from a pixel
            // diff (the previous failure mode — workers refused to pass
            // structurally-correct slides because vision can't confirm
            // <a:tbl> presence).
            const facts = structuralFacts(
              resolvePath(task.scratch_dir, "after/pptx", `${slide.slide_id}.pptx`),
            );
            // Zoom-crops the user generated by drawing on the prior wave's
            // SxS server. The filtered-rating-server writes a per-annotation
            // crop of the marked region against BOTH the rendered thumbnail
            // and the original Chrome screenshot to
            //   <ratings-dir>/zoom-crops/<slide_id>(-NN)?-(rendered|original).png
            // The NN is a 1-based zero-padded shape index (one rectangle or
            // one pencil stroke = one annotation = one indexed crop pair).
            // If present, attach them so the worker actually SEES the
            // 1-pixel detail the user flagged — vision routinely misses
            // single-pixel borders at slide-thumbnail resolution. Each shape
            // gets its own pair; ordering is shape index then side.
            const zoomCropsForSlide: string[] = [];
            if (existsSync(task.zoom_crops_dir)) {
              const slidePrefix = slide.slide_id;
              // List, filter, sort: indexed shapes first (01, 02, …),
              // then unindexed fallback ("<id>-rendered.png" /
              // "<id>-original.png"). Within each, rendered then original
              // so the worker sees "what we produce" before "what we want".
              const all: string[] = [];
              for (const f of readdirSyncSafe(task.zoom_crops_dir)) {
                if (f === `${slidePrefix}.png`) continue;
                if (!f.startsWith(`${slidePrefix}-`)) continue;
                if (!f.endsWith(".png")) continue;
                all.push(f);
              }
              all.sort();
              for (const f of all) zoomCropsForSlide.push(resolvePath(task.zoom_crops_dir, f));
            }
            const haveZoomCrops = zoomCropsForSlide.length > 0;
            const baseAttachments = [
              readFileSync(testPath).toString("base64"),
              readFileSync(baselinePath).toString("base64"),
              readFileSync(diffPath).toString("base64"),
            ];
            const zoomAttachments = zoomCropsForSlide.map(
              (p) => readFileSync(p).toString("base64"),
            );
            return child
              .send({
                prompt: [
                  `Visual verification — STEP A (reasoning, write to file).`,
                  `Slide: ${slide.slide_id}.`,
                  ``,
                  `THE USER'S BUG REPORT (this is the ONLY thing the fix must address):`,
                  `  """${slide.user_comment}"""`,
                  ``,
                  `Cluster hypothesis (background context, not the success criterion):`,
                  `  ${task.cluster_description.split("\n")[0]}`,
                  ``,
                  `STRUCTURAL FACTS extracted directly from the produced pptx XML`,
                  `(USE THESE — they answer "is it a table?" deterministically;`,
                  `do NOT try to re-derive structure from pixels):`,
                  `  slide XML element counts: ${facts}`,
                  ``,
                  `PNG attachments (in order):`,
                  `  (1) test       — post-fix Slides render (what we now produce).`,
                  `  (2) baseline   — Chrome render of the HTML fixture (ground truth).`,
                  `  (3) diff       — pixel difference of (1) vs (2): RED pixels mark`,
                  `                    where the post-fix render still differs from`,
                  `                    ground truth. Faded pixels match.`,
                  ...(haveZoomCrops ? [
                    `  (4..) zoom-crops — nearest-neighbour blow-ups of the EXACT`,
                    `                    regions the user marked on the prior wave's`,
                    `                    SxS UI. ORDERING: ` +
                    zoomCropsForSlide.map((p, i) => `(${i+4}) ` + p.replace(/.*\//,"")).join(", ") + ".",
                    `                    Each pair (rendered, original) is ONE marked`,
                    `                    region. If you can't see the bug in the`,
                    `                    full-slide thumbnails, LOOK HERE — these are`,
                    `                    the precise pixels the user is pointing at.`,
                    `                    If the post-fix zoom matches the original`,
                    `                    zoom in EVERY marked region, PASS.`,
                  ] : []),
                  ``,
                  `FOCUS your analysis on whether THE USER'S BUG (quoted above) is`,
                  `fixed. Unrelated pixel drift — text anti-aliasing, sub-pixel`,
                  `padding shifts, font-metric rounding — IS NOT a failure. Whole-`,
                  `slide red wash in the diff is usually just AA + font hinting`,
                  `between Chrome and Slides; ignore unless the user flagged it.`,
                  ``,
                  `Structural complaints from the user (e.g. "it's not a table",`,
                  `"emit as native shape") MUST be answered using the structural`,
                  `facts above, NOT the pixel diff. If facts.<a:tbl> ≥ 1 and the`,
                  `user said "not a table", the bug is FIXED.`,
                  ``,
                  `Write your analysis to ${task.scratch_dir}/${slide.slide_id}-visual.md`,
                  `as markdown: (1) what the user reported, (2) whether it's fixed`,
                  `(visually AND structurally${haveZoomCrops ? " AND in the zoom-crop" : ""}),`,
                  `(3) severity of any remaining flagged-by-user issue. Then reply with`,
                  `exactly "VISUAL_THINKING_DONE".`,
                ].join("\n"),
                base64_attachments: [...baseAttachments, ...zoomAttachments],
              })
              .send<VisualVerdict>({
                prompt: [
                  `STEP B — emit your VisualVerdict structured-output object.`,
                  `slide_id="${slide.slide_id}".`,
                  `visualVerdict="pass" iff THE USER'S SPECIFIC BUG (quoted in Step A) is addressed —`,
                  `EITHER visually fixed in the test render OR structurally satisfied per the OOXML facts.`,
                  `Unrelated pixel drift (text AA, sub-pixel shifts, font metrics) is NOT a fail.`,
                  `Only fail if the user's flagged issue is still visibly present OR a NEW major regression`,
                  `(missing content, wrong colour bands, broken layout — not minor pixel noise) appeared.`,
                  `reason: <=300 chars; cite the structural facts when relevant.`,
                ].join(" "),
              });
          })
          .assert((verdicts) => {
            const failed = verdicts.filter(v => v.visualVerdict !== "pass");
            if (failed.length > 0) {
              // ValidationError so tryMultipleTimes retries. See note on
              // the verdict aggregator above and the doc on ValidationError.
              throw new ValidationError(
                `VISUAL CHECK FAILED:\n` +
                failed.map(v => `  - ${v.slide_id}: ${v.reason}`).join("\n"),
              );
            }
          }),
      )

      // Step 8 — boot filtered rating server (backgrounded). Store URL.
      //   --thumbnails reads the post-fix Slides scrape;
      //   --baseline-dir reads main's pre-fix Slides scrape (left panel toggle);
      //   --originals reads baseline's Chrome screenshots (left panel default);
      //   --html-dir surfaces "View HTML Source" per card.
      //   The Slides deep link is auto-read from thumbnails/manifest.json.
      .combineWith<string, TaskResult>(
        (branch) => branch.executeShell(() => {
          const htmlDir = task.slides[0]?.html_file
            ? task.slides[0].html_file.replace(/\/[^/]+$/, "")
            : "";
          return (
            `cd ${task.workspace_dir} && ` +
            `lsof -ti:${task.server_port} | xargs -r kill 2>/dev/null; ` +
            `nohup npx tsx ${SCRIPTS.filteredServer} ` +
            `--port ${task.server_port} --slides ${ids} ` +
            `--analysis ${task.scratch_dir}/analysis.md ` +
            `--diffs ${task.scratch_dir}/diffs ` +
            `--thumbnails ${task.scratch_dir}/after/thumbs ` +
            `--originals ${task.baseline_dir}/originals ` +
            `--baseline-dir ${task.baseline_dir}/thumbs ` +
            `--bug-context ${task.scratch_dir}/bug-context.json ` +
            (htmlDir ? `--html-dir ${htmlDir} ` : ``) +
            `--task-title "${task.task_id}" ` +
            `> ${task.scratch_dir}/server.log 2>&1 & disown; ` +
            `sleep 2; echo http://localhost:${task.server_port}`
          );
        }),
        (partial, serverUrl) => ({ ...partial, sxs_url: serverUrl.trim() }),
      );
  };

  // Step 0 — record main's BASELINE pptx + Slides thumbs ONCE for every
  //   unique slide in the wave. Every per-task attempt later references
  //   `${task.baseline_dir}/pptx` for diff and `${task.baseline_dir}/thumbs`
  //   for the SxS "compare vs baseline" toggle. Idempotent: skipped if the
  //   manifest already exists (e.g. retried wave with BUG_SOLVING_BASELINE_DIR).
  const allSlides = [
    ...new Set(args.tasks.flatMap(t => t.slides.map(s => s.slide_id))),
  ].sort();
  const baselineDir = args.tasks[0]?.baseline_dir;
  if (!baselineDir) {
    throw new Error("main: tasks must carry baseline_dir (set by buildTasks).");
  }

  // All tasks in a wave currently share the same fixtures_dir (set by the
  // single buildTasks call). If a future wave needs heterogenous dirs per
  // task we'd record per-task and skip the shared baseline.
  const sharedFixtures = args.tasks[0]?.fixtures_dir;
  if (!sharedFixtures) {
    throw new Error("main: tasks must carry fixtures_dir (set by buildTasks).");
  }

  return args.session
    .executeShell(() =>
      `${TSXX} ${SCRIPTS.record} --mode full ` +
      `--slides ${allSlides.join(",")} --fixtures ${sharedFixtures} ` +
      `--out ${baselineDir}`
    )
    .parallelFork(args.tasks, (child, task) =>
      child
        .try<Result<TaskResult>>(
          (s) => s.tryMultipleTimes<TaskResult>(
            task.retry_budget,
            (s2) => runTask(s2, task),
          ),
          // Don't cancel sibling tasks when one task fails outright.
          (s, e) => s.materializeError(describeError(e)),
        ),
    );
}
