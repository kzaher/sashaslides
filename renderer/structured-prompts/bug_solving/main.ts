/**
 * bug_solving — structured prompt for resolving a clustered batch of
 * html2slides rendering bugs across one or more slides.
 *
 * ## Flow
 *   The end-to-end flow is a STATE MACHINE, documented (not narrated in prose
 *   here) in `docs/merge-flow.drawio`. Two pages:
 *     · "top-level pipeline (main.ts)" — CLUSTERS → SOLVE_FANOUT → PER_FORK_RATE
 *       → COLLECT_GREEN → MERGE_PHASE → DONE.
 *     · "merge-flow" — the MERGE_PHASE sub-machine: ALL_MERGE → ALL_DETECT →
 *       ALL_AT_ONCE_RATE → {ACCEPT_ALL | STOPPED | SEQ_*} (llm-merge.ts).
 *   Code comments reference states by id (e.g. SOLVE_FANOUT, PER_FORK_RATE)
 *   instead of restating the flow. Open the diagram to follow the sequence.
 *
 * ## How to run
 *   `npm run renderer:solver:run` (solve.sh) builds + launches. Clusters are the
 *   slides marked BAD in the live SxS ratings.json (NO clusters.ts). `--continue`
 *   skips solve and resumes MERGE_PHASE off the persisted overlays + green markers;
 *   `--clean` wipes prior state. The engine monitor + per-task SxS URLs are printed.
 *
 * ## Directions (`solve.sh --direction forward|reverse`, default forward)
 *   · forward — HTML fixture -> pptx -> Google Slides. Clusters from the forward SxS
 *     ratings.json; the fork's chain is `runTask` below (record pptx, diff, off-target
 *     gate, Google render, verdict).
 *   · reverse — Google Slides -> Sasha engine document -> Sasha HTML. Clusters from
 *     `.sxs-reverse/ratings-reverse.json` (keyed "<set>__slide_NN", the user's comment,
 *     annotation and zoom crops are the issue); the fork's chain is `reverseRunTask`
 *     (reverse-run-task.ts): the worker fixes the importer / engine renderer / HTML export,
 *     the reverse pipeline re-records the cluster's slides OFFLINE from the fork, a
 *     regression gate re-runs every set and compares against the user's goldens-reverse
 *     and the current metrics (no slide may rise > 0.05 points), the verdict compares the
 *     Sasha render with Google's thumbnail, and the fork's own reverse rating UI BLOCKS
 *     for the user's good/bad. Same overlays, retries, markers and MERGE_PHASE (its
 *     converter filter widened to the reverse files; the stability branch is skipped —
 *     it classifies the forward deck). Goldens stay user-only in both directions.
 *   Pure parts live in reverse-direction.ts and reverse-regression-gate.ts.
 *
 * `main()` builds the whole graph: the solve forks (each with its own rating
 * gate, PER_FORK_RATE) and, after their barrier, MERGE_PHASE (finalMergePhase).
 * It returns the forks' `Array<Result<TaskResult>>`. `BUG_SOLVING_NO_ACCEPT=1`
 * skips the rating waits and the merge.
 */

import {
  Session,
  SessionWithResult,
  describeError,
  type ClaudeModel,
} from "../../../structured-prompting/src/index.js";
import type { Result } from "../../../structured-prompting/src/index.js";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { forwardAfterImages, forwardForkPaths, forwardRatingServerArguments, forwardVerdictHeader, forwardVerdictPrompt, offTargetRegressions, writeSxsMeta } from "./forward-fork.js";
import { llmMerge, ledgerDemote, realLlmMergeOps, defaultConverterFilter, type GreenCluster, type MergeReport } from "./llm-merge.js";
import { acceptDisabled } from "./rating-gate.js";
import { STABILITY_JSON } from "./stability.js";
import { isReverseFixFile, type ReversePaths, type ReverseSlideContext, type SolveDirection } from "./reverse-direction.js";
import { reverseRunTask } from "./reverse-run-task.js";

// ---------- Types ----------

export interface SlideTask {
  slide_id: string;                  // "slide_11"
  html_file: string;                 // absolute path to the fixture HTML
  user_comment: string;              // text pulled from ratings.json
  annotation_png?: string;           // absolute path if present (transparent marks, ~1600x900)
  composite_png?: string;            // absolute path if written: annotation applied onto the
                                     //   target render, marked region colour-shifted to MAX
                                     //   contrast — shows WHERE the user marked, on the slide
  rendered_png: string;              // absolute path in /tmp/sxs-complex/slides
  original_png: string;              // absolute path in /tmp/sxs-complex/originals

  // ---- Staged per-task images: <shared_dir>/images/ (workspace-setup.ts stageSlideImages) ----
  // COPIES of the /tmp sources onto the /overlays volume, which the jailed fork can
  // read (its /tmp is empty). Step 4e adds <id>_after.png / <id>_highlighted_after.png
  // beside them (forward-fork.ts forwardAfterImages).
  img_original?: string;             // slide_NN_original.png  — the TARGET render
  img_annotations?: string;          // slide_NN_annotations.png — RAW annotation (may be absent)
  img_attempt?: string;              // slide_NN_attempt.png — the PRE-fix render the user rated
  img_highlighted?: string;          // slide_NN_highlighted_attempt.png — max-contrast composite
                                     //   (annotation applied over the pre-fix render)
  /** REVERSE direction only: the exported Sasha page, the fixture, the import, the
   *  user's zoom crops and the current metrics row (reverse-direction.ts). */
  reverse?: ReverseSlideContext;
}

export interface Task {
  task_id: string;                   // stable slug, e.g. "clipping-curves"
  branch_id: string;                 // overlay branch id (bs-<task>-<ts>); the fork runs INSIDE it
  workspace_dir: string;             // repo root (the branch's merged view resolves repo-relative paths from here)
  shared_dir: string;                // ABSOLUTE, OUTSIDE the overlay (/overlays/shared/<run-id>/<task_id>).
                                     //   A command run inside the fork's branch can write here and the
                                     //   result is visible from OUTSIDE the overlay — used for the
                                     //   rating-outcome marker so the final merge (which runs outside any
                                     //   branch) can read it. See ratingMarkerPath.
  scratch_dir: string;               // REPO-RELATIVE scratch, created INSIDE the branch (binary pptx/diff artifacts)
  analysis_dir: string;              // REPO-RELATIVE model docs dir, created INSIDE the branch (analysis.md / fix-summary.md)
  fixtures_dir: string;              // repo-relative fixtures dir for this cluster's slides (e.g. fixtures-basic)
  server_port: number;               // unique port for the filtered rating server
  presentation_title: string;        // fork-unique, e.g. "bug_solving-clipping-curves-1713512345"
  slides: SlideTask[];
  cluster_description: string;       // root-cause hypothesis for the wave
  retry_budget: number;              // e.g. 3
  direction: SolveDirection;         // which round trip this fork repairs (forward = runTask, reverse = reverseRunTask)
}

export interface SlideVerdict {
  slide_id: string;
  rationale: string;
  isRegression: boolean;
  bugSolved: boolean;
}

/** How many times to re-prompt a single-slide verdict whose response doesn't
 *  parse/validate into a SlideVerdict. */
const VERDICT_RETRIES = 3;
// Optional SEPARATE model for the per-slide VALIDATION (verdict) step — usually a
// smaller/cheaper one (sonnet|haiku). Set via solve.sh --validation-model →
// BUG_SOLVING_VALIDATION_MODEL. Unset → verdicts inherit the solver model.
const VALIDATION_MODEL = (process.env.BUG_SOLVING_VALIDATION_MODEL || undefined) as ClaudeModel | undefined;

/**
 * Typed, validated parse of a per-slide verdict response. Throws on malformed
 * JSON or wrong field types — used as the verdict step's `assert` so a bad
 * response is RETRIED (instead of the old "manual regex + silent fallback to
 * isRegression=true"). The thrown message tells the retry what was wrong.
 */
function parseSlideVerdict(raw: string, expectedSlideId: string): SlideVerdict {
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

/** What a fork's rating UI shows (step A1 launches it from this spec). */
export interface SxsServerSpec {
  port: number;
  slides: string[];                  // slide ids to show in the filtered UI
  analysis_md: string;               // path to task-level analysis.md
  diffs_dir: string;                 // per-slide .diff files live here
  thumbnails_dir: string;            // slide_<id>.png live here
  task_title: string;                // header displayed in the UI
}

export interface TaskResult {
  task_id: string;
  workspace_dir: string;
  analysis_md: string;               // path to analysis.md written by the worker
  verdicts: SlideVerdict[];
  sxs_server_spec: SxsServerSpec;    // what step A1's rating UI shows
  fix_summary: string;               // one-paragraph summary emitted by the worker

  // ---- Per-fork rating outcome (folded in by runTask steps A1–A3) ----
  // A fork only reaches the rating gate once its verdict PASSED (step 6b did not
  // throw). These fields reflect the human rating recorded in the fork's own UI:
  rated: boolean;                    // true once every slide got a good/bad verdict
  green: boolean;                    // true iff rated && every slide is `good`
  bad_slides: string[];              // slides rated bad (or, on a timeout, unrated)
}

/** The outcome marker each fork writes at `<shared_dir>/rating-outcome.json`
 *  once its rating gate resolves (or is skipped under NO_ACCEPT). The FINAL merge
 *  phase reads these from disk to decide which clusters are GREEN. Shape must
 *  match scripts/wait-for-ratings.ts's writer. */
export interface RatingOutcomeMarker {
  task_id: string;
  rated: boolean;
  green: boolean;
  good: string[];
  bad: string[];
  unrated: string[];
  slides: string[];
}

/** Where a task's rating-outcome marker lives. This is an ABSOLUTE path on the
 *  shared `/overlays/shared/<run-id>/<task_id>` volume — OUTSIDE any fork's
 *  overlay — so a marker written by wait-for-ratings.ts running INSIDE the fork's
 *  branch is visible to the final merge phase, which runs OUTSIDE the branch.
 *  (Writing it under the repo-relative scratch would land it in the branch's
 *  private upper layer, invisible from outside — the task-8 cross-boundary gap.) */
export const ratingMarkerPath = (task: Task): string =>
  join(task.shared_dir, "rating-outcome.json");

/** Read + validate a task's rating-outcome marker. Returns null if the marker is
 *  absent (fork failed / never rated) or malformed — the FINAL merge phase and
 *  step A3 treat null as "unrated, not green". */
export function readRatingMarker(task: Task): RatingOutcomeMarker | null {
  const f = ratingMarkerPath(task);
  if (!existsSync(f)) return null;
  try {
    const o = JSON.parse(readFileSync(f, "utf8")) as Partial<RatingOutcomeMarker>;
    if (typeof o.green !== "boolean") return null;
    return {
      task_id: typeof o.task_id === "string" ? o.task_id : task.task_id,
      rated: o.rated === true,
      green: o.green,
      good: Array.isArray(o.good) ? o.good.filter((s): s is string => typeof s === "string") : [],
      bad: Array.isArray(o.bad) ? o.bad.filter((s): s is string => typeof s === "string") : [],
      unrated: Array.isArray(o.unrated) ? o.unrated.filter((s): s is string => typeof s === "string") : [],
      slides: Array.isArray(o.slides) ? o.slides.filter((s): s is string => typeof s === "string") : [],
    };
  } catch { return null; }
}

// ---------- Helpers ----------

/** Path to the shell/ts helper scripts that live alongside main.ts. */
const SCRIPTS = {
  // record-pptx.sh was inlined into record-rendering.ts (a tsx CLI). It must
  // run with cwd = <workspace>/renderer so tsx + convert-pptx's node_modules
  // resolve, and it writes per-slide pptx to <out>/pptx/<slide_id>.pptx.
  record: "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts",
  diff: "renderer/structured-prompts/bug_solving/scripts/diff-pptx-pairs.ts",
  // The fork's rating UI (step A1), launched with forwardRatingServerArguments.
  ratingServer: "renderer/html2slides/rating-server.ts",
  // Visual off-target gate: renders changed non-cluster slides BEFORE/AFTER and
  // image-verifies whether the change is a VISIBLE regression (vs the old binary
  // structural fail). Writes <shared>/forward/offtarget-gate.json.
  offtargetGate: "renderer/structured-prompts/bug_solving/scripts/offtarget-gate.ts",
  // Refresh CLI (`refresh` mode): copies the AFTER thumbnail to <id>_after.png
  // (and composites <id>_highlighted_after.png over it) for the verdict.
  composite: "renderer/structured-prompts/bug_solving/scripts/annotation-composite.ts",
  // Rating gate CLI (`wait-for-ratings`): boots INSIDE the fork after step 7 —
  // BLOCKS on the cluster's ratings.json, then writes rating-outcome.json.
  waitRatings: "renderer/structured-prompts/bug_solving/scripts/wait-for-ratings.ts",
};

/** History dir the per-fork rating server + gate mirror verdicts into (the
 *  persistent, write-only audit ledger; the merge demotes into it too). */
const HISTORY_DIR = "/workspaces/sashaslides/.bug-solving-history";

const slideIdsCsv = (t: Task) => t.slides.map(s => s.slide_id).join(",");

/**
 * Every executeShell command runs INSIDE the fork's overlay branch (the engine
 * wraps it via cow-workspace's branchRunCommand once `.switchBranch(branch_id)` is set). The
 * branch runner sets cwd = the merged working-tree root, so at command start
 * `$PWD` IS the repo root inside the branch. We capture it as `$ROOT` so
 * repo-relative paths (scripts, fixtures, scratch — all stored repo-relative on
 * the Task) resolve as absolute paths inside the branch, then cd into
 * `renderer/` for node_modules resolution. Prefix a command body with this and
 * reference `"$ROOT/<repo-relative-path>"` everywhere.
 */
const BRANCH_CD_RENDERER = `ROOT="$PWD"; cd "$ROOT/renderer"`;

/** Build the per-slide analysis prompt text. Included in the first-round
 *  prompt so the worker knows exactly how to treat user SxS comments. */
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
      // All images live in ONE consolidated per-task dir inside this worktree,
      // keyed by the fixture set — self-describing filenames.
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

// ---------- Fixtures dir (shared across a run) ----------

/** The repo-absolute fixture deck for the merge retest. Every task in a run
 *  shares one fixture set, so task[0]'s dir is authoritative. */
function runFixturesDir(repo: string, tasks: Task[]): string {
  return tasks.length
    ? join(tasks[0].workspace_dir, tasks[0].fixtures_dir)
    : join(repo, "renderer/html2slides/e2e/fixtures");
}

// ---------- Final merge phase (after the parallelFork barrier) ----------
//
// The rating gate lives INSIDE each fork (runTask steps A1–A3): a solved fork
// boots its own UI, blocks on the human rating, and writes a rating-outcome.json
// marker to its SHARED dir (outside the overlay). AFTER the whole parallelFork
// barrier, this final phase reads those markers off disk and folds every GREEN
// cluster together with the SIMPLE LLM MERGE (llm-merge.ts): base + each green
// fork's version of a changed converter file → one LLM-merged file, retest, and
// promote onto the working tree. RED / unrated clusters are excluded + demoted.

/** A cluster classified by its on-disk rating marker. */
export interface ClassifiedCluster {
  cluster: GreenCluster;
  /** the outcome marker (null = missing/malformed = treated as not-green). */
  outcome: RatingOutcomeMarker | null;
  green: boolean;
}

/** Injected surface so the green-selection + demotion is unit-testable with no
 *  engine / workspace / filesystem. */
export interface GreenSelectionDeps {
  /** read a task's rating-outcome marker (default: readRatingMarker). */
  readMarker: (task: Task) => RatingOutcomeMarker | null;
  /** demote an excluded cluster's slides back to the ledger for re-solve
   *  (mirrors llm-merge's ledgerDemote). Non-throwing + idempotent. */
  demote: (slides: string[], cluster: string, reason: string) => void;
  /** per-line logging (default console.error). */
  log?: (msg: string) => void;
}

/**
 * PURE green-selection: classify every task by its rating marker, DEMOTE the
 * non-green ones (rated bad / unrated / no marker), and return the GREEN clusters
 * (each addressed by its fork's branch_id) to fold. No engine, no workspace —
 * every side-effect is on `deps`, so this unit-tests directly. Returns both the
 * green clusters (for llmMerge) and the full classification (for logging).
 */
export function selectGreenClusters(
  tasks: Task[],
  deps: GreenSelectionDeps,
): { green: GreenCluster[]; classified: ClassifiedCluster[] } {
  const log = deps.log ?? ((m: string) => console.error(m));
  const classified: ClassifiedCluster[] = [];
  const green: GreenCluster[] = [];

  for (const t of tasks) {
    const cluster: GreenCluster = {
      task: t.task_id,
      branch_id: t.branch_id,
      slides: t.slides.map((s) => s.slide_id),
      // ABSOLUTE shared dir — reaped with the solve overlay on a successful merge.
      shared_dir: t.shared_dir,
    };
    const outcome = deps.readMarker(t);
    const isGreen = outcome?.green === true;
    classified.push({ cluster, outcome, green: isGreen });

    if (isGreen) {
      green.push(cluster);
      log(`[merge-final] ${t.task_id} → GREEN (all rated good) — accept candidate.`);
    } else {
      const reason = outcome == null
        ? "no rating marker (fork failed or never rated) — excluded from merge"
        : outcome.bad.length
          ? `user rated ${outcome.bad.join(", ")} bad`
          : outcome.unrated.length
            ? `rating incomplete — unrated slide(s) [${outcome.unrated.join(", ")}]`
            : "not green";
      log(`[merge-final] ${t.task_id} → EXCLUDED (${reason}) — demoting for re-solve.`);
      try { deps.demote(cluster.slides, cluster.task, reason); }
      catch (e) { log(`[merge-final] demote threw for ${t.task_id} (continuing): ${(e as Error)?.message ?? String(e)}`); }
    }
  }
  return { green, classified };
}

/** What MERGE_PHASE needs to know about the run's direction (the phase itself is
 *  shared). */
export interface MergeSettings {
  /** the ledger excluded clusters are demoted into. */
  historyDir: string;
  /** which changed files the LLM merge folds. */
  converterFilter: (relativePath: string) => boolean;
  /** a green cluster's slides as FORWARD-deck slide ids — the retest renders the
   *  forward deck, so only those are "intended" changes there. */
  forwardDeckSlides: (slides: string[]) => string[];
}

/**
 * The merge settings of a direction. Reverse: its own ledger (reverse ids never
 * enter the forward reconcile), the importer / engine / export files, and NO
 * intended forward-deck slide — a reverse fix must leave the forward deck unchanged,
 * so the unchanged forward retest reports any forward change as a ripple to rate.
 */
export function mergeSettingsFor(direction: SolveDirection, reversePaths: ReversePaths | null): MergeSettings {
  switch (direction) {
    case "forward":
      return { historyDir: HISTORY_DIR, converterFilter: defaultConverterFilter, forwardDeckSlides: (slides) => slides };
    case "reverse":
      if (reversePaths === null) throw new Error("mergeSettingsFor(reverse): the reverse paths are required");
      return { historyDir: reversePaths.historyDirectory, converterFilter: isReverseFixFile, forwardDeckSlides: () => [] };
    default:
      return assertNever(direction);
  }
}

/**
 * Wire the FINAL merge phase onto a chain after the parallelFork barrier. Runs
 * as engine nodes (monitor-visible). Because the execution branch can't receive
 * the fork results, it reads each cluster's rating-outcome marker OFF DISK (the
 * forks wrote them to their shared dirs before the barrier). GREEN clusters →
 * llmMerge (base + each fork's version → one LLM-merged file, retest, promote);
 * non-green → demoted. Under BUG_SOLVING_NO_ACCEPT the whole phase is a no-op
 * (the forks skipped their waits too). Returns a SessionWithResult<MergeReport|
 * null> (the report is logged; main() discards it and returns the TaskResults).
 */
export function finalMergePhase(
  branch: Session,
  opts: {
    repo: string;
    tasks: Task[];
    /** which direction the run repairs: picks the ledger, the files the merge folds,
     *  and which slides the forward retest treats as intended (mergeSettingsFor). */
    merge: MergeSettings;
    /** injected for tests; production uses the real disk wiring. */
    readMarker?: (task: Task) => RatingOutcomeMarker | null;
    demote?: (slides: string[], cluster: string, reason: string) => void;
    /** run llmMerge over the green clusters. Default: real llmMerge + realLlmMergeOps. */
    runMerge?: (s: Session, green: GreenCluster[]) => SessionWithResult<MergeReport>;
    disabled?: (env: NodeJS.ProcessEnv) => boolean;
    log?: (msg: string) => void;
  },
): SessionWithResult<MergeReport | null> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const disabled = opts.disabled ?? acceptDisabled;

  // NO_ACCEPT → skip the merge entirely (forks already booted UIs + skipped
  // their waits). Return a null report on a real (no-op) node.
  if (disabled(process.env)) {
    log("[merge-final] BUG_SOLVING_NO_ACCEPT=1 → skipping final merge; leaving fixes in their forks.");
    return branch
      .executeShell(() => `echo merge-final:skipped-no-accept`)
      .combineWith<string, MergeReport | null>(
        (b) => b.executeShell(() => `echo merge-final:skipped-leaf`),
        () => null,
      );
  }

  // Real demote (ledger only). ledgerDemote is idempotent + non-throwing.
  const demote = opts.demote ?? ((slides: string[], cluster: string, reason: string) => {
    try { ledgerDemote(opts.merge.historyDir, slides, cluster, reason); }
    catch (e) { log(`[merge-final] demote wiring failure for ${cluster} (non-fatal): ${(e as Error)?.message ?? String(e)}`); }
  });
  const readMarker = opts.readMarker ?? readRatingMarker;

  // Select GREEN clusters at RUNTIME from the on-disk markers (demoting the rest)
  // inside a pipe so it runs at exec time, after the forks wrote their markers.
  // The pipe body's returned SessionWithResult carries the (logged-only) report.
  return branch
    .executeShell(() => `echo merge-final:selecting-green`)
    .pipe<MergeReport | null>((s) => {
      const selected = selectGreenClusters(opts.tasks, { readMarker, demote, log });
      const green = selected.green.map((cluster) => ({ ...cluster, slides: opts.merge.forwardDeckSlides(cluster.slides) }));
      if (green.length === 0) {
        log("[merge-final] no GREEN clusters — nothing to merge.");
        return installNullReport(s);
      }
      log(`[merge-final] folding ${green.length} GREEN cluster(s): ${green.map((g) => g.task).join(", ")}`);
      // llmMerge: base + each fork's converter version → LLM-merged file(s),
      // retest, promote onto the working tree. Injectable for tests.
      const runMerge = opts.runMerge ?? ((s2: Session, g: GreenCluster[]) =>
        llmMerge(s2, {
          repo: opts.repo,
          greenClusters: g,
          converterFilter: opts.merge.converterFilter,
          ops: realLlmMergeOps({ repo: opts.repo, fixturesDir: runFixturesDir(opts.repo, opts.tasks), historyDir: opts.merge.historyDir }),
        }));
      return runMerge(s, green).combineWith<string, MergeReport | null>(
        (b2) => b2.executeShell(() => `echo merge-final:done`),
        (rep) => logMergeReport(rep, log),
      );
    });
}

/** Install a null MergeReport on a real graph node (mirrors llm-merge's
 *  installValue). */
function installNullReport(session: Session): SessionWithResult<MergeReport | null> {
  return session
    .executeShell(() => `echo merge-final:no-green`)
    .combineWith<string, MergeReport | null>(
      (b) => b.executeShell(() => `echo merge-final:no-green-leaf`),
      () => null,
    );
}

/** Log the final MergeReport (mode / accepted / rejected+demoted / merged files)
 *  and return it. */
function logMergeReport(report: MergeReport, log: (m: string) => void): MergeReport {
  log("\n================ FINAL MERGE PHASE COMPLETE ================");
  log(`mode: ${report.mode}`);
  log(`accepted (${report.accepted.length}): ${report.accepted.join(", ") || "(none)"}`);
  log(`rejected (${report.rejected.length}): ${report.rejected.map((r) => `${r.task} (${r.reason})${r.demotedSlides.length ? ` → demoted: [${r.demotedSlides.join(",")}]` : ""}`).join("; ") || "(none)"}`);
  log(`merged files (${report.mergedFiles.length}): ${report.mergedFiles.join(", ") || "(none)"}`);
  log("==========================================================\n");
  return report;
}

// ---------- Stability branch (runs PARALLEL to the solve forks) ----------
//
// The 3× whole-deck stability classification feeds ONLY the final merge's
// regression gate (STABILITY_JSON, read at merge time). It's INDEPENDENT of the
// forks, so it runs as its OWN branch CONCURRENTLY with the fork-set (see main()'s
// outer parallelFork over ["forks","stability"]) — visible as its own thread in
// the engine UI, joined at the barrier BEFORE the merge. Previously this blocked
// the whole run ~5 min at startup before any solver could begin.
//
// Rendered as a single `executeShell` node invoking stability.ts's standalone CLI
// (record + classify + write). The command ALWAYS exits 0 (`|| echo …`) so a flaky
// render can NEVER cancel the sibling fork branch (parallelFork cancels siblings on
// throw); the merge gate degrades to xml-stable when STABILITY_JSON is absent.
export function stabilityBranch(
  session: Session,
  opts: { repo: string; fixturesDirRel: string },
): SessionWithResult<string> {
  return session.executeShell(() => stabilityCommand(opts));
}

/**
 * PURE (env + fs) builder for the stability node's shell command. Extracted from
 * stabilityBranch so it's directly unit-testable. Returns:
 *   • an `echo …skipped` when NO_ACCEPT or BUG_SOLVING_SKIP_STABILITY (no merge
 *     will consult the gate),
 *   • an `echo …no fixtures` when the deck is empty/unreadable,
 *   • otherwise the stability.ts CLI invocation, ALWAYS suffixed `|| echo …` so it
 *     exits 0 (a flaky render must never cancel the sibling fork branch).
 */
export function stabilityCommand(opts: { repo: string; fixturesDirRel: string }): string {
  const skip = acceptDisabled(process.env) || process.env.BUG_SOLVING_SKIP_STABILITY === "1";
  if (skip) return `echo "[stability] skipped (no-accept / BUG_SOLVING_SKIP_STABILITY)"`;
  const attempts = Number(process.env.BUG_SOLVING_STABILITY_ATTEMPTS) || 3;
  const STABILITY_SCRIPT = "renderer/structured-prompts/bug_solving/stability.ts";
  let deck: string[] = [];
  try {
    deck = readdirSync(join(opts.repo, opts.fixturesDirRel))
      .filter((f) => /^slide_\d+\.html$/.test(f))
      .map((f) => f.replace(/\.html$/, ""))
      .sort();
  } catch { /* fixtures dir unreadable → empty deck → skip below */ }
  if (deck.length === 0) return `echo "[stability] no slide_*.html fixtures — skipping"`;
  const csv = deck.join(",");
  return (
    `cd "${opts.repo}" && npx tsx "${join(opts.repo, STABILITY_SCRIPT)}" ` +
    `--slides "${csv}" --out "${STABILITY_JSON}" --fixtures "${opts.fixturesDirRel}" --attempts ${attempts} ` +
    `|| echo "[stability] non-fatal failure — merge gate degrades to xml-stable"`
  );
}

// ---------- Main ----------

// main() runs the parallelFork solve+verify+fix-summary graph AND the per-fork
// rating gate (each solved fork boots its own UI and BLOCKS on the human rating,
// steps A1–A3), THEN — after the parallelFork barrier — a FINAL merge phase
// (finalMergePhase) folds every GREEN cluster together with the LLM conflict
// resolver + whole-deck regression recording (llmMerge) and promotes the clean
// result. The merge report is LOGGED, not returned: main() still returns the
// per-task TaskResults (`SessionWithResult<Array<Result<TaskResult>>>`). Under
// BUG_SOLVING_NO_ACCEPT the forks skip their waits and the final phase is a
// no-op. Nothing lands until a human rates every slide of a thread good.
export function main(args: {
  session: Session;
  tasks: Task[];
  /** the run's direction (every task shares it) and, for reverse, where its inputs
   *  live + the Chrome it screenshots with. */
  direction: SolveDirection;
  reverse: Readonly<{ paths: ReversePaths; chromePort: number }> | null;
}): SessionWithResult<Array<Result<TaskResult>>> {

  // --- inner per-task attempt body ----------------------------------------
  const runTask = (s: Session, task: Task): SessionWithResult<TaskResult> => {
    const ids = slideIdsCsv(task);
    // Everything the HOST reads back from this fork (gate verdict, Google render,
    // AFTER images, ratings) goes to the shared dir, outside the overlay.
    const fork = forwardForkPaths(task.shared_dir);
    return s
      // Steps 1–4 combined: the worker runs the record/analyze/fix/
      // diff loop itself via its bash tool. We fold it into one `send`
      // for two reasons:
      //   (a) `executeShell` only exists on SessionWithResult — we need
      //       a result-producing op (send) before we can chain shells.
      //   (b) The worker already has the full context (annotations,
      //       user comments, scratch dir layout) from
      //       `analysisPromptFor(task)` — asking it to drive its own
      //       shell loop is cheaper and more natural than bouncing
      //       between our shell and its model calls.
      // Step 1 (record BEFORE pptx) runs in the scaffolding, not here —
      // it's a side-effect-only script with no model judgement, and
      // lifting it out keeps this graph clean. See main-scaffolding.ts.
      //
      // Steps 2, 3, 4 below: one model-driven step (analyze+fix) then
      // two script-only steps (record-after, diff) invoked via
      // executeShell now that we have a SessionWithResult from step 2.
      //
      // NOTE on typed responses: we deliberately use `.send({prompt})`
      // (returns `SessionWithResult<string>`) and JSON.parse in
      // `combine` callbacks instead of `.send<T>({prompt})`. Reason:
      // typia's `json.schema<T>()` transform only inlines when the
      // source file is in typia's internal TS program. We hit a silent-
      // no-op case for files outside `structured-prompting/src/` — the
      // generic call survived to runtime and threw ("no transform has
      // been configured"). Plain string responses + manual JSON parsing
      // are robust to that.

      // Step 2 — model: write/update analysis.md + apply the code fix.
      .prependToNextPrompt(analysisPromptFor(task))
      .send({
        prompt: [
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
        ].join("\n"),
      })
      .assert((ack: string) => {
        if (!/FIX_APPLIED/.test(ack)) {
          throw new Error(`Worker did not confirm fix applied. Response: ${ack.slice(0, 300)}`);
        }
      })

      // Step 3 — record AFTER pptx via shell (one file per slide). Runs INSIDE
      // the branch (cwd = repo root → renderer/) so it picks up the worker's
      // just-applied fix from the branch's upper layer
      // (record-rendering.ts → <out>/pptx/<slide_id>.pptx).
      .executeShell(() =>
        `${BRANCH_CD_RENDERER} && npx tsx "$ROOT/${SCRIPTS.record}" ` +
        `--mode pptx --fixtures "$ROOT/${task.fixtures_dir}" ` +
        `--slides ${ids} --out "$ROOT/${task.scratch_dir}/after"`
      )

      // Step 4 — pairwise diffs via shell. before/after pptx live under the
      // `pptx/` subdir that record-rendering writes; diff-pptx-pairs needs
      // JSZip so it also runs from renderer/ for node_modules resolution.
      .executeShell(() =>
        `${BRANCH_CD_RENDERER} && npx tsx "$ROOT/${SCRIPTS.diff}" ` +
        `--before "$ROOT/${task.scratch_dir}/before/pptx" --after "$ROOT/${task.scratch_dir}/after/pptx" ` +
        `--out "$ROOT/${task.scratch_dir}/diffs"`
      )

      // Step 4b — REGRESSION SCAN across the WHOLE fixture deck (not just this
      // cluster's slides). Render every fixture WITH the worker's fix
      // (after-all) and diff it against the pristine `before-all` baseline into
      // <shared>/forward/reg-diffs, which step 4d and the host's step 6b read.
      // Dirs are cleared first so a retry never diffs stale pptx (the round-2
      // idempotent-cache trap).
      .executeShell(() => {
        const fx = task.fixtures_dir;
        const rec = SCRIPTS.record;
        // Shared /tmp scratch OUTSIDE the overlay (readable from BOTH this fix
        // branch and the fresh base branch below): before/after whole-deck pptx
        // land here so the diff can compare them.
        const reg = `/tmp/bs-reg-${task.branch_id}`;
        return [
          BRANCH_CD_RENDERER,
          `rm -rf ${reg} "${fork.regDiffs}" && mkdir -p ${reg}`,
          `ALL=$(ls "$ROOT/${fx}"/slide_*.html | xargs -n1 basename | sed 's/[.]html$//' | sort -V | paste -sd,)`,
          // Whole-deck AFTER pass. Formerly RECORD_CONCURRENCY=1 because
          // concurrent Chrome tabs raced on web-font load → shifted text metrics
          // → nondeterministic pptx → PHANTOM off-target regressions (this falsely
          // failed flex-panel-width). That race is now closed by the
          // asset-readiness gate in convert-pptx-io (waits for stylesheets/fonts/
          // images, not a timer): verified all 34 fixtures render byte-identical
          // extractSlideXml + extractRenderedPartsHash at concurrency=5 vs serial,
          // at 2.6× the speed. Env-overridable back to 1 via MERGE_RENDER_CONCURRENCY.
          `RECORD_CONCURRENCY=${process.env.MERGE_RENDER_CONCURRENCY || "5"} npx tsx "$ROOT/${rec}" --mode pptx --fixtures "$ROOT/${fx}" --slides "$ALL" --out ${reg}/after-all`,
          // BEFORE = the pristine whole-deck baseline recordBeforePptx staged at
          // startup (this branch's `before-all`, rendered BEFORE the worker ran).
          // We do NOT re-render it here: mounting a fresh baseline overlay inside
          // the worker's jail is a nested overlay (overlay-over-overlay), which
          // the kernel rejects ("wrong fs type … on overlay", exit 32).
          `npx tsx "$ROOT/${SCRIPTS.diff}" --before "$ROOT/${task.scratch_dir}/before-all/pptx" --after ${reg}/after-all/pptx --out "${fork.regDiffs}"`,
        ].join(" && ");
      })

      // Step 4c — render the AFTER state to Google Slides BEFORE the verdict so
      // each per-slide verifier can VISUALLY compare the target vs the post-fix
      // render. This is what lets the verdict judge PIXEL-ONLY fixes the OOXML
      // structural diff is blind to (e.g. a rounded-corner image mask whose
      // <p:pic> XML is unchanged). It writes to <shared>/forward/thumbnails, which
      // the host and the rating UI read. The dir is cleared first so every
      // retry attempt re-renders the NEW fix (uploadAndScrape is idempotent on a
      // present manifest and would otherwise reuse a stale render). Best-effort
      // (`|| true`): a flaky Google upload must not block the verdict — the
      // verifier falls back to the diff when the AFTER image is missing.
      .executeShell(() =>
        `${BRANCH_CD_RENDERER} && rm -rf "${fork.thumbnails}" && ` +
        `npx tsx "$ROOT/${SCRIPTS.record}" ` +
        `--mode full --fixtures "$ROOT/${task.fixtures_dir}" ` +
        `--slides ${ids} --title "${task.presentation_title}" ` +
        `--out "${fork.thumbnails}" || true`,
      )

      // Step 4d — VISUAL off-target gate. Reads step 4b's reg-diffs, and for any
      // NON-cluster slide the fix changed structurally, renders it BEFORE/AFTER
      // to Slides and asks an image-aware verifier whether the change is a
      // VISIBLE regression (a benign reflow passes). Writes
      // <shared>/forward/offtarget-gate.json, which the host's step 6b reads.
      // Best-effort (`|| true`): the helper exits 0, and step 6b falls back to the
      // conservative binary structural check if the file is missing (a previous
      // attempt's file is removed first so it can never stand in).
      .executeShell(() =>
        `${BRANCH_CD_RENDERER} && rm -f "${fork.offtargetGate}" && npx tsx "$ROOT/${SCRIPTS.offtargetGate}" ` +
        `--scratch "${fork.root}" --cluster ${ids} --workdir "$ROOT" ` +
        `--fixtures "$ROOT/${task.fixtures_dir}" ` +
        `--record "$ROOT/${SCRIPTS.record}" ` +
        `--title "${task.presentation_title}-offtarget" || true`,
      )

      // Step 4e — copy each slide's AFTER thumbnail (step 4c) to
      // <shared>/images/<id>_after.png and composite the user's marks over it
      // (<id>_highlighted_after.png), next to the staged BEFORE images, for the
      // verdict header (forwardVerdictHeader). Best-effort per slide (`|| true`):
      // a missing AFTER thumb leaves no _after.png and the verdict says so.
      .executeShell(() => {
        const composite = `"$ROOT/${SCRIPTS.composite}"`;
        const cmds = task.slides.map(s => {
          const images = forwardAfterImages(fork, s.slide_id);
          const ann = s.img_annotations ? ` "${s.img_annotations}" "${images.highlightedAfter}"` : ``;
          return `npx tsx ${composite} refresh "${images.thumbnail}" "${images.after}"${ann} || true`;
        });
        return `${BRANCH_CD_RENDERER} && mkdir -p "${fork.images}" && ${cmds.join(" && ")}`;
      })

      // Step 5 — per-slide verdict fork. Each slide gets its own sub-
      // session that reads the diff + analysis + comment, emits a JSON
      // object as plain text, and we parse it in the combineWith below.
      // parallelFork already creates independent child sessions — no
      // explicit fork()/compact() needed; the children inherit the
      // parent chain's conversation state directly, which helps them
      // know what happened in steps 1–4 without extra prompting.
      .parallelFork(task.slides, (child, slide) =>
        // Retry the verdict prompt (up to VERDICT_RETRIES) until the response
        // parses + validates into a SlideVerdict. The `assert` runs the typed
        // parser; a throw triggers a re-send rather than accepting garbage.
        //
        // The per-slide VALIDATION (verdict) can use a SEPARATE, cheaper model
        // than the solver — set BUG_SOLVING_VALIDATION_MODEL (solve.sh
        // --validation-model, e.g. sonnet|haiku). Unset → inherits the solver
        // model. `switchModel` is sticky, so every verdict retry uses it.
        (VALIDATION_MODEL ? child.switchModel(VALIDATION_MODEL) : child)
          .tryMultipleTimes<string>(VERDICT_RETRIES, (c) =>
          c
            .prependToNextPrompt(forwardVerdictHeader(task, slide))
            .send({ prompt: forwardVerdictPrompt(slide.slide_id) })
            .assert((raw: string) => { parseSlideVerdict(raw, slide.slide_id); }),
        ),
      )

      // Step 6 — aggregate verdicts. Parse each slide's JSON response,
      // throw if any regression or unsolved. Since we no longer rely on
      // typia to emit a typed TaskResult, we synthesize it ourselves from
      // the ground-truth fields the orchestrator controls.
      .combineWith<string, TaskResult>(
        (branch) => branch.send({
          prompt: [
            `All per-slide verdicts are now in. Write ${task.analysis_dir}/fix-summary.md —`,
            `one paragraph covering the root cause and what you changed, with file:line`,
            `references. After writing the file, reply with its contents verbatim (just`,
            `the text, no JSON, no code fence).`,
          ].join(" "),
        }),
        (verdictStrings, fixSummary) => {
          // Each response already passed the validating `assert` (with retries),
          // so parseSlideVerdict won't normally throw here. Keep a defensive
          // fallback for the rare all-retries-failed case.
          const verdicts: SlideVerdict[] = verdictStrings.map((s, i) => {
            try {
              return parseSlideVerdict(s, task.slides[i].slide_id);
            } catch (e) {
              return {
                slide_id: task.slides[i].slide_id,
                rationale: `(verdict unparseable after ${VERDICT_RETRIES} retries: ${(e as Error).message}) raw=${s.slice(0, 200)}`,
                isRegression: true,  // conservatively treat an unparseable verdict as a regression
                bugSolved: false,
              };
            }
          });
          const aggregate: TaskResult = {
            task_id: task.task_id,
            workspace_dir: task.workspace_dir,
            analysis_md: `${task.analysis_dir}/analysis.md`,
            verdicts,
            sxs_server_spec: {
              port: task.server_port,
              slides: task.slides.map(s => s.slide_id),
              analysis_md: `${task.analysis_dir}/analysis.md`,
              diffs_dir: `${task.scratch_dir}/diffs`,
              // record-rendering --mode full writes the Slides thumbnail to
              // <out>/thumbs/<id>.png, so the SxS slides-dir must be that
              // subdir (not the bare out dir) or the rating UI shows no render.
              thumbnails_dir: join(fork.thumbnails, "thumbs"),
              task_title: `bug_solving: ${task.task_id}`,
            },
            fix_summary: fixSummary.trim(),
            // Rating fields default to unrated/not-green; steps A1–A3 (below)
            // boot the fork's UI, BLOCK on the human rating, then overwrite these
            // from the rating-outcome.json marker.
            rated: false,
            green: false,
            bad_slides: [],
          };
          return aggregate;
        },
      )
      // Step 6b — throw if any verdict is a regression or not solved.
      // assert() rejects the upstream on throw, which the surrounding
      // tryMultipleTimes then catches and routes to a retry attempt.
      .assert((tr: TaskResult) => {
        const lines: string[] = [];
        const regressions = tr.verdicts.filter(v => v.isRegression);
        const unsolved = tr.verdicts.filter(v => !v.bugSolved);
        if (regressions.length)
          lines.push(`REGRESSIONS (${regressions.length}):`,
            ...regressions.map(r => `  - ${r.slide_id}: ${r.rationale}`));
        if (unsolved.length)
          lines.push(`UNSOLVED (${unsolved.length}):`,
            ...unsolved.map(r => `  - ${r.slide_id}: ${r.rationale}`));
        // C2: fail on off-target regressions — but ONLY ones the step-4d visual
        // gate confirmed are VISIBLY worse (not any structural change). Falls
        // back to the binary structural check if the gate file is absent.
        const offTarget = offTargetRegressions(fork, task.slides.map(s => s.slide_id));
        if (offTarget.length)
          lines.push(`OFF-TARGET VISIBLE REGRESSIONS (${offTarget.length}) — non-cluster slides the image verifier judged visibly worse after this fix: ${offTarget.join(", ")}`);
        if (lines.length) throw new Error(lines.join("\n"));
      })

      // Step 7 — upload consolidated pptx + scrape thumbnails into the shared
      //   thumbnails dir (re-runs step 4c's render; every phase is idempotent).
      //   `combineWith` preserves the upstream TaskResult across the
      //   executeShell side effect.
      .combineWith<string, TaskResult>(
        // upload-and-scrape.ts was inlined into record-rendering.ts (commit
        // 346965d), so `--mode full` (pptx + Slides upload + thumb scrape) is
        // the replacement. Runs from the worktree's renderer/ for node_modules.
        // `|| true` makes it NON-FATAL: this is post-verdict productization for
        // the SxS review — a flaky Google upload must NOT throw away an
        // already-PASSED fix (which is exactly what the dead script was doing).
        (branch) => branch.executeShell(() =>
          `${BRANCH_CD_RENDERER} && npx tsx "$ROOT/${SCRIPTS.record}" ` +
          `--mode full --fixtures "$ROOT/${task.fixtures_dir}" ` +
          `--slides ${ids} --title "${task.presentation_title}" ` +
          `--out "${fork.thumbnails}" || true`
        ),
        (taskResult) => {
          // Best-effort: write the sxs-meta.json provenance sidecar into the
          // rating-server resultsDir (= <shared>/forward/thumbnails, which this
          // host process can see) so every SxS card
          // shows the original HTML link, the presentation URL (read from the
          // structured manifest.json the upload wrote — not scraped from stdout),
          // the original annotation, and the original comment. A throw here must
          // not lose an already-PASSED fix → writeSxsMeta swallows its own errors.
          writeSxsMeta(fork.thumbnails, task.slides);
          return taskResult;
        },
      )

      // ── Step A1 — this fork's rating UI ─────────────────────────────────────
      // Only a SOLVED fork reaches here (step 6b threw for a failed verdict).
      // rating-server.ts (forwardRatingServerArguments) on the fork's shared
      // Google render, filtered to the cluster's slides, verdict-only, recording a
      // candidate verdict into the history ledger. It runs in the FOREGROUND and
      // exits once every slide is rated (--exit-when-all-rated), so THIS node is
      // the wait; detaching it (`setsid … & disown`) leaked the engine's capture
      // pipe and hung the node. The scaffolding announces "✅ RATING UI READY →
      // url" when the port starts listening; stderr goes to the log. The server
      // binds localhost:<port>, reachable from the host (only user+mount
      // namespaces are unshared). NO_ACCEPT (no human to rate) skips the UI.
      .combineWith<string, TaskResult>(
        (branch) => branch.executeShell((tr) => {
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
            historyDirectory: HISTORY_DIR,
          });
          return (
            `${BRANCH_CD_RENDERER} && mkdir -p "${fork.root}" && ` +
            `echo "[rating-server] ${task.task_id} → http://localhost:${spec.port} (log ${log})" && ` +
            `npx tsx "$ROOT/${SCRIPTS.ratingServer}" ${serverArguments.map((argument) => `"${argument}"`).join(" ")} 2> "${log}"`
          );
        }),
        (taskResult) => taskResult,
      )

      // ── Step A2 — BLOCK on this cluster's ratings.json (wait-for-ratings) ───
      // Polls the fork's own ratings.json until every slide is good/bad (honoring
      // BUG_SOLVING_NO_ACCEPT → skip, and BUG_SOLVING_RATING_TIMEOUT_MS/TTY →
      // finite deadline). On completion it WRITES the rating-outcome.json marker
      // and prints a summary. ALWAYS exits 0 (a timeout writes green:false).
      .combineWith<string, TaskResult>(
        (branch) => branch.executeShell(() => {
          const wait = `"$ROOT/${SCRIPTS.waitRatings}"`;
          const ids = slideIdsCsv(task);
          // --history-dir is an ABSOLUTE path OUTSIDE the repo (/workspaces/…/
          // .bug-solving-history) → it is part of the overlay LOWER, so a write
          // there from inside the branch lands in the branch upper (isolated).
          // The persistent ledger mirror is best-effort here; task 9's merge
          // rewrite reconciles ledgers from branch state.
          // --marker is an ABSOLUTE /overlays/shared path OUTSIDE the overlay, so
          // the marker this wait writes from INSIDE the branch is visible to the
          // final merge phase running outside it (NOT prefixed with $ROOT).
          return (
            `${BRANCH_CD_RENDERER} && npx tsx ${wait} ` +
            `--results-dir "${fork.thumbnails}" ` +
            `--slides ${ids} ` +
            `--task-id ${task.task_id} ` +
            `--marker "${ratingMarkerPath(task)}" ` +
            `--history-dir ${HISTORY_DIR}`
          );
        }),
        (taskResult) => taskResult,
      )

      // ── Step A3 — fold the rating outcome into the TaskResult ──────────────
      // Read the marker the wait wrote and set rated/green/bad_slides. A missing
      // or malformed marker is conservatively treated as unrated + not-green.
      .combineWith<string, TaskResult>(
        (branch) => branch.executeShell(() => `echo rating-marker-read ${task.task_id}`),
        (taskResult) => {
          const outcome = readRatingMarker(task);
          return {
            ...taskResult,
            rated: outcome?.rated ?? false,
            green: outcome?.green ?? false,
            // bad_slides = rated-bad slides plus (on a timeout) any still-unrated.
            bad_slides: outcome ? [...outcome.bad, ...outcome.unrated] : [],
          };
        },
      );
  };

  // Each fork runs its direction's chain (forward = runTask above, reverse =
  // reverseRunTask in reverse-run-task.ts); everything around it is shared.
  const runTaskFor = (s: Session, task: Task): SessionWithResult<TaskResult> => {
    switch (task.direction) {
      case "forward":
        return runTask(s, task);
      case "reverse": {
        if (args.reverse === null) throw new Error(`${task.task_id}: a reverse task needs main({ reverse })`);
        return reverseRunTask(s, task, {
          paths: args.reverse.paths,
          chromePort: args.reverse.chromePort,
          branchCdRenderer: BRANCH_CD_RENDERER,
          parseVerdict: parseSlideVerdict,
          verdictRetries: VERDICT_RETRIES,
          validationModel: VALIDATION_MODEL,
          ratingMarkerPath,
          readRatingMarker,
          acceptDisabled: acceptDisabled(process.env),
          waitRatingsScript: SCRIPTS.waitRatings,
          compositeScript: SCRIPTS.composite,
        });
      }
      default:
        return assertNever(task.direction);
    }
  };

  // --- outer parallel fork, opus all the way --------------------------------
  // parallelFork spawns independent child sessions per task; explicit
  // fork()/compact() on the outer session isn't needed — the scaffolding
  // root carries no real prior conversation, and compact() would just
  // strip its (empty) context.
  //
  // Each fork now runs the solve+verify+fix-summary chain AND its own rating
  // gate (runTask steps A1–A3: boot the fork's UI → BLOCK on the human rating →
  // write rating-outcome.json). AFTER the whole parallelFork barrier, a FINAL
  // merge phase (finalMergePhase) reads those markers off disk and folds the
  // GREEN clusters through llmMerge (LLM compose + conflict resolution +
  // whole-deck regression recording). The merge report is LOGGED, not returned —
  // main() still yields the per-task TaskResults.
  const repo = process.cwd();
  const fixturesDirRel = args.tasks[0]?.fixtures_dir ?? "renderer/html2slides/e2e/fixtures";

  // ── TWO PARALLEL HETEROGENEOUS BRANCHES, joined, THEN merge ──────────────
  // parallelCombineWith2 runs both branches CONCURRENTLY (Promise.all) as their
  // own indented threads in the engine UI, then joins:
  //   • BRANCH 1 (forks)     → the per-task fork-set (nested parallelFork:
  //                            solve+verify+fix-summary + the per-fork human
  //                            rating gate). This is the run's long pole.
  //   • BRANCH 2 (stability) → the whole-deck 3× classification (its own thread),
  //                            which ONLY the final merge gate needs. It runs
  //                            ALONGSIDE the solve instead of blocking startup ~5m.
  // The join keeps the fork TaskResults (stability only produced STABILITY_JSON on
  // disk). THEN combineWith runs the FINAL merge phase after the barrier (reads
  // the forks' rating markers + STABILITY_JSON — both ready). combineWith stays
  // sequential BY DESIGN: the merge MUST run after the barrier.
  return args.session
    .parallelCombineWith2<Array<Result<TaskResult>>, string, Array<Result<TaskResult>>>(
      // BRANCH 1 — the solve fork-set.
      (forks) => forks.parallelFork(args.tasks, (c, task) =>
        c
          // Run this task's WHOLE chain (worker model `send`s + record/diff
          // shells) INSIDE its own overlay branch — a zero-copy COW mount over the
          // working tree. The worker's edits + scratch land in the branch's
          // isolated upper layer and never touch the base tree (nor sibling forks).
          .switchBranch(task.branch_id)
          .try<Result<TaskResult>>(
            (s) => s.tryMultipleTimes<TaskResult>(task.retry_budget, (s2) => runTaskFor(s2, task)),
            // Don't cancel sibling tasks when one task fails outright.
            (s, e) => s.materializeError(describeError(e)),
          )),
      // BRANCH 2 — the stability classification (its own thread; non-throwing so
      // a flaky render can't cancel BRANCH 1).
      // The stability classification describes the FORWARD deck; a reverse run's
      // merge retest needs no classifier (it degrades to xml-stable), so skip it.
      (stab) => stabilityApplies(args.direction)
        ? stabilityBranch(stab, { repo, fixturesDirRel })
        : stab.executeShell(() => `echo "[stability] skipped (reverse direction)"`),
      // JOIN — keep the fork results; stability's side effect was STABILITY_JSON.
      (taskResults, _stability) => taskResults,
    )
    // FINAL PHASE: fold GREEN clusters after the barrier. finalMergePhase reads the
    // rating-outcome markers the forks wrote (and STABILITY_JSON) OFF DISK, so the
    // combine just returns the upstream TaskResults.
    .combineWith<MergeReport | null, Array<Result<TaskResult>>>(
      (branch) => finalMergePhase(branch, { repo, tasks: args.tasks, merge: mergeSettingsFor(args.direction, args.reverse?.paths ?? null) }),
      (taskResults) => taskResults,
    );
}

/** Whether the forward stability classification is worth running for a direction. */
function stabilityApplies(direction: SolveDirection): boolean {
  switch (direction) {
    case "forward":
      return true;
    case "reverse":
      return false;
    default:
      return assertNever(direction);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
