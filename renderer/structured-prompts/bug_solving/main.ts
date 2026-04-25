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

import {
  Claude,
  Session,
  SessionWithResult,
  describeError,
  safelyJsonStringify,
} from "../../../structured-prompting/src/index.js";
import type { Result } from "../../../structured-prompting/src/types.js";

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
}

export interface SlideVerdict {
  slide_id: string;
  rationale: string;
  isRegression: boolean;
  bugSolved: boolean;
}

export interface TaskResult {
  task_id: string;
  workspace_dir: string;
  analysis_md: string;               // path to analysis.md written by the worker
  verdicts: SlideVerdict[];
  sxs_url: string;                   // http://localhost:<server_port>
  fix_summary: string;               // one-paragraph summary emitted by the worker
}

// ---------- Helpers ----------

/** Path to the shell/ts helper scripts that live alongside main.ts. */
const SCRIPTS = {
  record: "renderer/structured-prompts/bug_solving/scripts/record-pptx.sh",
  baseline: "renderer/structured-prompts/bug_solving/scripts/baseline-record.ts",
  diff: "renderer/structured-prompts/bug_solving/scripts/diff-pptx-pairs.ts",
  uploadScrape: "renderer/structured-prompts/bug_solving/scripts/upload-and-scrape.ts",
  filteredServer: "renderer/structured-prompts/bug_solving/scripts/filtered-rating-server.ts",
};

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
    `How to incorporate the user's comments into your analysis:`,
    `  * The user's words are ground truth — do not argue with them. Your job is`,
    `    to explain the WHY and propose the minimal fix.`,
    `  * For each slide, open the annotation PNG if it exists. The red strokes`,
    `    mark exactly where the user says the rendering is wrong.`,
    `  * Always disambiguate TEXT-vs-BOX when the comment is about alignment.`,
    `  * Write your findings into ${task.scratch_dir}/analysis.md. Use one H2`,
    `    section per slide. Each section must have: "User comment" (verbatim),`,
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
      //   for the whole wave by baseline-record.ts at `task.baseline_dir` —
      //   each task inherits it instead of rebuilding. prependToNextPrompt
      //   is consumed by this send.
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

      // Step 2 — record new pptx.
      .executeShell(() =>
        `cd ${task.workspace_dir} && bash ${SCRIPTS.record} ` +
        `--slides ${ids} --label after --out ${task.scratch_dir}/after`
      )

      // Step 3 — diff shared baseline vs after.
      .executeShell(() =>
        `cd ${task.workspace_dir} && npx tsx ${SCRIPTS.diff} ` +
        `--before ${task.baseline_dir}/pptx --after ${task.scratch_dir}/after ` +
        `--out ${task.scratch_dir}/diffs`
      )

      .parallelFork(task.slides, (child, slide) =>
        child
          .tryMultipleTimes(3, s => (s
            .prependToNextPrompt(
              `You are verifying the fix for ${slide.slide_id}. ` +
              `Analysis: ${task.scratch_dir}/analysis.md. ` +
              `Diff: ${task.scratch_dir}/diffs/${slide.slide_id}.diff. ` +
              `User's original comment: "${slide.user_comment}".`,
            )
            .send({
              prompt: [
                `Read analysis.md (section for ${slide.slide_id}) and the diff file.`,
                `Respond with ONLY a JSON object (no markdown fences, no prose before`,
                `or after) on a single line or pretty-printed, with these keys:`,
                `  slide_id: "${slide.slide_id}",`,
                `  rationale: string (<=500 chars — what changed and why),`,
                `  isRegression: boolean (true if the diff introduces NEW rendering`,
                `    problems not mentioned in analysis.md's "Expected diff"),`,
                `  bugSolved: boolean (true only if the diff clearly addresses the`,
                `    user's original comment AND matches the expected-diff claim).`,
                `No StructuredOutput tool — just raw JSON in your reply.`,
              ].join(" "),
            })
          )),
      )

      // Step 6 — parse prose verdicts, aggregate, throw on any regression
      //   or unsolved bug. The inner branch finishes with a fix-summary
      //   prose reply that we keep verbatim as fix_summary.
      .combineWith<string[], TaskResult>(
        (branch) => branch.send({
          prompt: [
            `Write ${task.scratch_dir}/fix-summary.md — one paragraph covering`,
            `the root cause and what you changed, referencing file:line. Then`,
            `paste the contents of that file back in your reply (no JSON, no`,
            `markdown fences). The orchestrator will use your reply verbatim as`,
            `the fix_summary field.`,
          ].join(" "),
        }),
        (rawVerdicts, fixSummary) => {
          const verdicts: SlideVerdict[] = rawVerdicts.map((raw, i) => {
            const slide_id = task.slides[i].slide_id;
            // Strip optional markdown fences + any leading/trailing prose
            // (agents sometimes ignore "JSON only" and wrap in ```json).
            const stripped = raw.trim()
              .replace(/^```(?:json)?\s*/i, "")
              .replace(/\s*```$/i, "");
            const firstBrace = stripped.indexOf("{");
            const lastBrace = stripped.lastIndexOf("}");
            const jsonSlice = firstBrace >= 0 && lastBrace > firstBrace
              ? stripped.slice(firstBrace, lastBrace + 1)
              : stripped;
            try {
              const parsed = JSON.parse(jsonSlice);
              return {
                slide_id: parsed.slide_id ?? slide_id,
                rationale: String(parsed.rationale ?? "").slice(0, 500),
                isRegression: Boolean(parsed.isRegression),
                bugSolved: Boolean(parsed.bugSolved),
              };
            } catch (e) {
              return {
                slide_id,
                rationale: `verdict parse failed: ${(e as Error).message}. raw: ${raw.slice(0, 200)}`,
                isRegression: true,
                bugSolved: false,
              };
            }
          });
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
            throw new Error(lines.join("\n"));
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

      // Step 7 — upload consolidated pptx + scrape thumbnails.
      //   executeShell receives the current result (TaskResult) and must
      //   produce a command string; we just want the side effect here.
      .executeShell(() =>
        `cd ${task.workspace_dir} && npx tsx ${SCRIPTS.uploadScrape} ` +
        `--slides ${ids} --title "${task.presentation_title}" ` +
        `--out ${task.scratch_dir}/thumbnails`
      )

      // Step 8 — boot filtered rating server (backgrounded). Store URL.
      //   --html-dir is inferred from the first slide's html_file parent; the
      //   SxS UI uses it to expose "View HTML Source" per card. The Slides
      //   deep link is auto-read from thumbnails/manifest.json written by
      //   upload-and-scrape.ts in step 7.
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
            `--thumbnails ${task.scratch_dir}/thumbnails ` +
            `--baseline-dir ${task.baseline_dir}/thumbs ` +
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

  return args.session
    .executeShell(() =>
      `if [ -f "${baselineDir}/thumbs/manifest.json" ] && [ -d "${baselineDir}/pptx" ]; then ` +
      `  echo "[baseline] reusing ${baselineDir}"; ` +
      `else ` +
      `  npx tsx ${SCRIPTS.baseline} --slides ${allSlides.join(",")} --out ${baselineDir}; ` +
      `fi`
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
