/**
 * fork-chain.ts — one attempt of a bug_solving fork, shared by both directions.
 *
 * Every fork runs this chain inside its overlay branch, wrapped by main.ts's
 * `tryMultipleTimes(retry_budget)`. The direction (forward-fork.ts `forwardChain`,
 * reverse-run-task.ts `reverseChain`) supplies only what differs: the worker's brief,
 * the recordings and gates between the fix and the verdicts, the verdict text, the
 * rating UI and where the ratings land.
 *
 *   2   worker     — brief + fix prompt → analysis.md + the fix; must reply FIX_APPLIED.
 *   3–4 afterFix   — the direction's recordings, diffs, gates and AFTER images.
 *   5   verdicts   — one per slide, retried until the reply parses.
 *   6   summary    — fix-summary.md + the TaskResult; 6b fails on a regression, an
 *                    unsolved slide or a direction gate failure (→ the next attempt).
 *   7   afterVerdict — post-verdict productization; must stay non-fatal.
 *   A1  rating UI  — the fork's own rating server, foreground until every slide is rated.
 *   A2  wait       — wait-for-ratings.ts → the rating-outcome marker (always exits 0).
 *   A3  fold       — the marker into the TaskResult.
 *
 * Imports only types from main.ts, so the direction modules and main.ts never import
 * each other at runtime.
 */
import type { ClaudeModel, Session, SessionWithResult } from "../../../structured-prompting/src/index.js";
import type { SlideTask, SlideVerdict, SxsServerSpec, Task, TaskResult } from "./main.js";
import { ratingMarkerPath, readRatingMarker } from "./rating-marker.js";

/** How many times a single-slide verdict whose reply does not parse is re-prompted. */
export const VERDICT_RETRIES = 3;

// Optional SEPARATE model for the per-slide verdicts — usually a cheaper one (sonnet|haiku).
// Set via solve.sh --validation-model → BUG_SOLVING_VALIDATION_MODEL. Unset → the solver model.
const VALIDATION_MODEL = (process.env.BUG_SOLVING_VALIDATION_MODEL || undefined) as ClaudeModel | undefined;

/**
 * Every executeShell command runs INSIDE the fork's overlay branch, whose runner sets cwd to the
 * merged working-tree root. This captures it as `$ROOT` (repository-relative paths resolve as
 * `"$ROOT/<path>"`) and moves into `renderer/` for node_modules resolution.
 */
export const BRANCH_CD_RENDERER = `ROOT="$PWD"; cd "$ROOT/renderer"`;

/** Repository-relative helper scripts both directions run. */
export const FORK_SCRIPTS = {
  /** `refresh` mode: copies an AFTER render and composites the user's marks over it. */
  composite: "renderer/structured-prompts/bug_solving/scripts/annotation-composite.ts",
  /** Blocks on the fork's ratings, then writes the rating-outcome marker. */
  waitRatings: "renderer/structured-prompts/bug_solving/scripts/wait-for-ratings.ts",
} as const;

/** What a direction contributes to the shared chain. */
export type DirectionChain = Readonly<{
  /** The worker's header, prepended to `fixPrompt`. */
  brief: string;
  fixPrompt: string;
  /** Steps 3–4: the shells between the worker's fix and the verdicts. */
  afterFix: (fixed: SessionWithResult<string>) => SessionWithResult<string>;
  verdictHeader: (slide: SlideTask) => string;
  verdictPrompt: (slideId: string) => string;
  /** What step A1's rating UI shows. */
  sxsServerSpec: SxsServerSpec;
  /** Step 6b's extra failure lines (off-target or reverse regression gate); none = pass. */
  gateFailures: () => string[];
  /** Step 7: post-verdict productization. Must never throw a passed fix away. */
  afterVerdict: (passed: SessionWithResult<TaskResult>) => SessionWithResult<TaskResult>;
  /** Step A1's foreground rating-server command. */
  ratingServerCommand: (result: TaskResult) => string;
  /** Step A2: the rating UI's results dir, its ratings file when not the default, the ledger. */
  ratings: Readonly<{ resultsDirectory: string; ratingsFile: string | null; historyDirectory: string }>;
}>;

/**
 * Typed, validated parse of a per-slide verdict reply. Throws on malformed JSON or wrong field
 * types: it is the verdict step's `assert`, so a bad reply is re-prompted, and the message tells
 * the retry what was wrong.
 */
export function parseSlideVerdict(raw: string, expectedSlideId: string): SlideVerdict {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("verdict response contained no JSON object");
  let o: Record<string, unknown>;
  try { o = JSON.parse(m[0]) as Record<string, unknown>; }
  catch (e) { throw new Error(`verdict JSON did not parse: ${(e as Error).message}`); }
  if (typeof o.rationale !== "string") throw new Error("verdict.rationale must be a string");
  if (typeof o.isRegression !== "boolean") throw new Error("verdict.isRegression must be a boolean");
  if (typeof o.bugSolved !== "boolean") throw new Error("verdict.bugSolved must be a boolean");
  const slide_id = typeof o.slide_id === "string" && o.slide_id ? o.slide_id : expectedSlideId;
  return { slide_id, rationale: o.rationale, isRegression: o.isRegression, bugSolved: o.bugSolved };
}

/** A verdict reply that still does not parse after every retry counts as a regression, so the
 *  attempt is retried rather than rated. */
function verdictOf(response: string, slide: SlideTask | undefined): SlideVerdict {
  const slideId = slide?.slide_id ?? "(unknown)";
  try {
    return parseSlideVerdict(response, slideId);
  } catch (cause) {
    return {
      slide_id: slideId,
      rationale: `(verdict unparseable after ${VERDICT_RETRIES} retries: ${cause instanceof Error ? cause.message : String(cause)}) raw=${response.slice(0, 200)}`,
      isRegression: true,
      bugSolved: false,
    };
  }
}

export function forkChain(session: Session, task: Task, direction: DirectionChain): SessionWithResult<TaskResult> {
  const ids = task.slides.map((slide) => slide.slide_id).join(",");
  // Typed replies (`send<T>`) are avoided on purpose: typia's transform only inlines inside
  // structured-prompting/src, and elsewhere the generic call survives to runtime and throws.
  // Plain strings parsed here are robust to that.
  const fixed = session
    // 2 — the worker: analysis.md + the fix, nothing else.
    .prependToNextPrompt(direction.brief)
    .send({ prompt: direction.fixPrompt })
    .assert((acknowledgement: string) => {
      if (!/FIX_APPLIED/.test(acknowledgement)) throw new Error(`Worker did not confirm fix applied. Response: ${acknowledgement.slice(0, 300)}`);
    });

  const verified = direction.afterFix(fixed)
    // 5 — one verdict per slide, retried until it parses. `switchModel` is sticky, so every retry
    // uses the validation model too.
    .parallelFork(task.slides, (child, slide) =>
      (VALIDATION_MODEL ? child.switchModel(VALIDATION_MODEL) : child)
        .tryMultipleTimes<string>(VERDICT_RETRIES, (attempt) =>
          attempt
            .prependToNextPrompt(direction.verdictHeader(slide))
            .send({ prompt: direction.verdictPrompt(slide.slide_id) })
            .assert((raw: string) => { parseSlideVerdict(raw, slide.slide_id); }),
        ),
    )
    // 6 — fix summary + the TaskResult. The rating fields start unrated; A3 fills them.
    .combineWith<string, TaskResult>(
      (branch) => branch.send({
        prompt:
          `All per-slide verdicts are now in. Write ${task.analysis_dir}/fix-summary.md — one paragraph covering ` +
          `the root cause and what you changed, with file:line references. After writing the file, reply with its ` +
          `contents verbatim (just the text, no JSON, no code fence).`,
      }),
      (verdictResponses, fixSummary) => ({
        task_id: task.task_id,
        workspace_dir: task.workspace_dir,
        analysis_md: `${task.analysis_dir}/analysis.md`,
        verdicts: verdictResponses.map((response, index) => verdictOf(response, task.slides[index])),
        sxs_server_spec: direction.sxsServerSpec,
        fix_summary: fixSummary.trim(),
        rated: false,
        green: false,
        bad_slides: [],
      }),
    )
    // 6b — a throw here is caught by the surrounding tryMultipleTimes → the next attempt.
    .assert((result: TaskResult) => {
      const lines: string[] = [];
      const regressions = result.verdicts.filter((verdict) => verdict.isRegression);
      const unsolved = result.verdicts.filter((verdict) => !verdict.bugSolved);
      if (regressions.length) lines.push(`REGRESSIONS (${regressions.length}):`, ...regressions.map((verdict) => `  - ${verdict.slide_id}: ${verdict.rationale}`));
      if (unsolved.length) lines.push(`UNSOLVED (${unsolved.length}):`, ...unsolved.map((verdict) => `  - ${verdict.slide_id}: ${verdict.rationale}`));
      lines.push(...direction.gateFailures());
      if (lines.length) throw new Error(lines.join("\n"));
    });

  return direction.afterVerdict(verified)
    // A1 — only a SOLVED fork gets here. The server runs in the FOREGROUND and exits once every
    // slide is rated, so this node IS the wait (detaching it leaked the engine's capture pipe).
    .combineWith<string, TaskResult>(
      (branch) => branch.executeShell((result) => direction.ratingServerCommand(result)),
      (result) => result,
    )
    // A2 — block on the ratings, then write the marker to the shared dir (outside the overlay, so
    // the host reads it). Always exits 0: a timeout writes green:false.
    .combineWith<string, TaskResult>(
      (branch) => branch.executeShell(() => {
        const { resultsDirectory, ratingsFile, historyDirectory } = direction.ratings;
        return (
          `${BRANCH_CD_RENDERER} && npx tsx "$ROOT/${FORK_SCRIPTS.waitRatings}" --results-dir "${resultsDirectory}" ` +
          (ratingsFile === null ? `` : `--ratings-file "${ratingsFile}" `) +
          `--slides ${ids} --task-id ${task.task_id} --marker "${ratingMarkerPath(task)}" --history-dir ${historyDirectory}`
        );
      }),
      (result) => result,
    )
    // A3 — fold the marker (missing or malformed = unrated, not green). bad_slides = the slides
    // rated bad plus, on a timeout, the ones still unrated.
    .combineWith<string, TaskResult>(
      (branch) => branch.executeShell(() => `echo rating-marker-read ${task.task_id}`),
      (result) => {
        const outcome = readRatingMarker(task);
        return {
          ...result,
          rated: outcome?.rated ?? false,
          green: outcome?.green ?? false,
          bad_slides: outcome ? [...outcome.bad, ...outcome.unrated] : [],
        };
      },
    );
}
