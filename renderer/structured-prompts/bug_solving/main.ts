/**
 * bug_solving — structured prompt for resolving a clustered batch of
 * html2slides rendering bugs across one or more slides.
 *
 * ## How to use
 *   1. cd /workspaces/sashaslides
 *   2. Create a sibling `./clusters.ts` that exports `CLUSTERS` of type
 *      `Cluster[]` (see `workspace-setup.ts`). Example:
 *        export const CLUSTERS = [
 *          { task_id: "clipping", cluster_description: "...",
 *            slide_ids: ["slide_11", "slide_12", "slide_14", "slide_28"] },
 *        ];
 *      main-scaffolding.ts imports CLUSTERS from that file by default and
 *      refuses to build until you create it. This is intentional — it
 *      prevents accidental smoke runs.
 *   3. Build:  `npx tsx structured-prompting/build.ts renderer/structured-prompts/bug_solving/main-scaffolding.ts`
 *   4. Run:    `node structured-prompting/dist/main-scaffolding.mjs`
 *   5. The engine monitor URL is printed on the first lines of stderr
 *      (look for `┌── structured-prompting monitor`). Scaffolding prints
 *      it again at the end along with per-task SxS server URLs.
 *   6. Separately, start the port-range notifier ONCE per session so
 *      per-task SxS servers surface in chat as they come up:
 *        Monitor({
 *          command: "bash renderer/structured-prompts/bug_solving/scripts/notify-new-servers.sh",
 *          persistent: true, timeout_ms: 3600000,
 *          description: "bug_solving SxS servers",
 *        })
 *      Each task that successfully finishes will produce one
 *      `NEW http://localhost:<port>` line in the chat. The notifier
 *      also re-announces a port when an old listener dies and a new
 *      one binds — convenient when restarting a server.
 *
 * ## Scaffolding lifecycle (detached servers + rating-gated accept)
 *   When `main()` (this solve-only structured prompt) returns and
 *   engine.execute resolves, main-scaffolding.ts:
 *     1. boots one rating server per SUCCESSFUL TaskResult (detached +
 *        unref()'d, so they survive scaffolding exit) — ALL up front so
 *        the human can rate every thread in parallel;
 *     2. runs the POST-RUN, per-thread RATING-GATED accept phase
 *        (accept-orchestration.ts): serially per thread it BLOCKS until
 *        the human rates every slide good/bad, then GREEN (all good) →
 *        accept via mergePhase on the SAME engine; RED (any bad, or a
 *        non-TTY rating deadline) → demote for re-solve, NOT accepted.
 *   The accept is opt-out via `BUG_SOLVING_NO_ACCEPT=1` (leaves the UIs
 *   up and exits, the old behavior). The servers stay up until the user
 *   kills them (`lsof -ti:4720-4800 | xargs -r kill`); Ctrl-C on the
 *   scaffolding does NOT reach them.
 *
 * ## Per-task pipeline (retryable up to task.retry_budget times)
 *   1. record-pptx.sh → one .pptx per slide, parallel, --no-upload (BEFORE)
 *   2. worker writes analysis.md + applies code fix
 *   3. record-pptx.sh → AFTER
 *   4. diff-pptx-pairs.ts → OOXML-level diff + summary.json per slide
 *   5. parallelFork per slide: sub-session emits a typed JSON verdict
 *      {slide_id, rationale, isRegression, bugSolved}
 *   6. aggregate verdicts — throw if any isRegression || !bugSolved;
 *      analysis.md is kept so the next attempt refines rather than
 *      restarts
 *   7. upload-and-scrape.ts → uploads a combined pptx under a
 *      fork-unique title, scrapes per-slide PNG thumbnails
 *   8. emits a SxsServerSpec in the TaskResult so main-scaffolding.ts can
 *      boot the filtered rating server AFTER this prompt resolves, and so
 *      the rating-gated accept phase can locate the thread's ratings.json.
 *
 * ## Return type
 *   `main()` is SOLVE-ONLY and returns
 *   `SessionWithResult<Array<Result<TaskResult>>>` (the parallelFork
 *   results). Each TaskResult carries an `sxs_server_spec`, NOT a running
 *   URL. The accept/merge is NOT chained into this graph — it runs
 *   post-run in the scaffolding, gated by the per-thread human rating.
 */

import {
  Session,
  SessionWithResult,
  describeError,
} from "../../../structured-prompting/src/index.js";
import type { Result } from "../../../structured-prompting/src/index.js";
import { writeFileSync, readFileSync, readdirSync, copyFileSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { fixtureSetSlug } from "./workspace-setup.js";
import { realMergeOps, mergePhase, type MergeCluster, type MergePhaseArgs, type MergeReport } from "./merge-phase.js";
import { acceptDisabled } from "./accept-orchestration.js";

/**
 * Write the sxs-meta.json sidecar consumed by rating-server.ts so each SxS card
 * can show the round-1 provenance the user complained was missing: the original
 * source HTML, the live presentation URL, the original annotation they drew, and
 * the original comment they typed. The harness COPIES the html fixture + the
 * annotation PNG into resultsDir (source/ and orig-annotations/) so the rating
 * server's existing static routes can reach them (it cannot serve arbitrary
 * absolute /tmp paths via /html). Best-effort and fully non-fatal — a throw here
 * must NEVER convert an already-PASSED fix into a retry.
 *
 * @param resultsDir  the rating-server resultsDir (= <scratch>/thumbnails)
 * @param slides      per-slide round-1 records (html_file, user_comment, annotation_png)
 */
function writeSxsMeta(resultsDir: string, slides: SlideTask[]): void {
  try {
    // Read the STRUCTURED manifest record-rendering --mode full wrote
    // (<thumbs>/manifest.json = { presentation_id, slides, ... }) rather than
    // regex-scraping the upload's stdout. The presentation URL is derived from
    // the typed presentation_id field.
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
    const annotDir = join(resultsDir, "orig-annotations");
    mkdirSync(resultsDir, { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(annotDir, { recursive: true });

    const meta: Record<string, {
      html_file?: string;
      presentation_url?: string;
      original_comment?: string;
      original_annotation?: string;
      original_png?: string;
    }> = {};

    for (const s of slides) {
      const entry: (typeof meta)[string] = {};
      // Copy the source HTML into resultsDir/source/<id>.html (served via /html,
      // which resolves relative to resultsDir).
      if (s.html_file && existsSync(s.html_file)) {
        const dst = join(sourceDir, `${s.slide_id}.html`);
        try { copyFileSync(s.html_file, dst); entry.html_file = `source/${s.slide_id}.html`; } catch {}
      }
      if (presentationUrl) entry.presentation_url = presentationUrl;
      if (s.user_comment) entry.original_comment = s.user_comment;
      // Copy the original annotation PNG (served via /img by absolute path, but
      // copy into resultsDir so it survives a /tmp wipe of the source).
      if (s.annotation_png && existsSync(s.annotation_png)) {
        const dst = join(annotDir, `${s.slide_id}.png`);
        try { copyFileSync(s.annotation_png, dst); entry.original_annotation = `orig-annotations/${s.slide_id}.png`; } catch {}
      }
      if (s.original_png && existsSync(s.original_png)) entry.original_png = s.original_png;
      meta[s.slide_id] = entry;
    }

    writeFileSync(join(resultsDir, "sxs-meta.json"), JSON.stringify(meta, null, 2));
  } catch (e) {
    console.error(`[writeSxsMeta] non-fatal: ${(e as Error).message}`);
  }
}

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

  // ---- Consolidated per-task image dir (all under the WORKTREE scratch) ----
  // Every image a worker needs for this slide lives in ONE dir keyed by the
  // fixture set:  <worktree>/.bug-solving-scratch/<fixtureSetSlug>/slide_NN_*.png
  // These are COPIES/derivations of the scattered /tmp sources, materialized in
  // buildTasks() AFTER the worktree exists. All absolute paths inside the worktree.
  img_original?: string;             // slide_NN_original.png  — the TARGET render
  img_annotations?: string;          // slide_NN_annotations.png — RAW annotation (may be absent)
  img_attempt?: string;              // slide_NN_attempt.png — the render being evaluated
                                     //   (build-time = OUR CURRENT render; verify-time refreshed
                                     //    from the just-recorded AFTER thumbnail)
  img_highlighted?: string;          // slide_NN_highlighted_attempt.png — max-contrast composite
                                     //   (annotation applied over the slide)
}

export interface Task {
  task_id: string;                   // stable slug, e.g. "clipping-curves"
  branch_id: string;                 // overlay branch id (bs-<task>-<ts>); the fork runs INSIDE it
  workspace_dir: string;             // repo root (the branch's merged view resolves repo-relative paths from here)
  scratch_dir: string;               // REPO-RELATIVE scratch, created INSIDE the branch (binary pptx/diff artifacts)
  analysis_dir: string;              // REPO-RELATIVE model docs dir, created INSIDE the branch (analysis.md / fix-summary.md)
  fixtures_dir: string;              // repo-relative fixtures dir for this cluster's slides (e.g. fixtures-basic)
  server_port: number;               // unique port for the filtered rating server
  presentation_title: string;        // fork-unique, e.g. "bug_solving-clipping-curves-1713512345"
  slides: SlideTask[];
  cluster_description: string;       // root-cause hypothesis for the wave
  retry_budget: number;              // e.g. 3
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

/**
 * C2 off-target regression detection. Reads the whole-deck diff produced by
 * step 4b (<scratch>/reg-diffs/<slide>.diff) and returns any slide NOT in this
 * cluster whose pptx changed between HEAD and the worker's fix (its diff is not
 * "(no structural differences detected)"). Those are unexpected regressions the
 * fix introduced on unrelated slides and must fail the attempt.
 */
function detectOffTargetRegressions(task: Task): string[] {
  const regDir = `${task.scratch_dir}/reg-diffs`;
  if (!existsSync(regDir)) return [];
  const clusterIds = new Set(task.slides.map(s => s.slide_id));
  const out: string[] = [];
  for (const f of readdirSync(regDir)) {
    if (!f.endsWith(".diff")) continue;
    const sid = f.replace(/\.diff$/, "");
    if (clusterIds.has(sid)) continue; // cluster slides are EXPECTED to change
    let txt = "";
    try { txt = readFileSync(join(regDir, f), "utf-8"); } catch { continue; }
    if (!/no structural differences/i.test(txt)) out.push(sid);
  }
  return out.sort();
}

/** Off-target regressions to FAIL on. Prefers the visual gate's verdict
 *  (<scratch>/offtarget-gate.json `regressions` = slides the image verifier
 *  judged visibly WORSE after the fix). Falls back to the conservative binary
 *  structural check (detectOffTargetRegressions) if the gate file is missing or
 *  corrupt, so a gate-script failure can never silently drop the off-target
 *  safety net. */
function readOffTargetRegressions(task: Task): string[] {
  const f = join(task.scratch_dir, "offtarget-gate.json");
  if (existsSync(f)) {
    try {
      const o = JSON.parse(readFileSync(f, "utf-8")) as { regressions?: unknown };
      if (Array.isArray(o.regressions)) return o.regressions.filter((s): s is string => typeof s === "string");
    } catch { /* fall through to the structural check */ }
  }
  return detectOffTargetRegressions(task);
}

/** Spec for a post-run rating server that main-scaffolding.ts will boot as
 *  a tracked child process. main.ts returns this spec; it does NOT launch
 *  the server itself (see header: subprocess lifetime). */
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
  sxs_server_spec: SxsServerSpec;    // scaffolding boots the server, not main.ts
  fix_summary: string;               // one-paragraph summary emitted by the worker

  // ---- Per-fork rating outcome (folded in by runTask steps A1–A3) ----
  // A fork only reaches the rating gate once its verdict PASSED (step 6b did not
  // throw). These fields reflect the human rating recorded in the fork's own UI:
  rated: boolean;                    // true once every slide got a good/bad verdict
  green: boolean;                    // true iff rated && every slide is `good`
  bad_slides: string[];              // slides rated bad (or, on a timeout, unrated)
}

/** The outcome marker each fork writes at `<scratch>/rating-outcome.json` once
 *  its rating gate resolves (or is skipped under NO_ACCEPT). The FINAL merge
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

/** Where a task's rating-outcome marker lives. */
export const ratingMarkerPath = (task: Task): string =>
  join(task.scratch_dir, "rating-outcome.json");

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
  filteredServer: "renderer/structured-prompts/bug_solving/scripts/filtered-rating-server.ts",
  // Visual off-target gate: renders changed non-cluster slides BEFORE/AFTER and
  // image-verifies whether the change is a VISIBLE regression (vs the old binary
  // structural fail). Writes <scratch>/offtarget-gate.json.
  offtargetGate: "renderer/structured-prompts/bug_solving/scripts/offtarget-gate.ts",
  // Refresh CLI (`refresh` mode): overwrites the consolidated slide_NN_attempt.png
  // (and re-composites slide_NN_highlighted_attempt.png over the AFTER render)
  // from the just-recorded AFTER thumbnail so the verifier sees the real attempt.
  composite: "renderer/structured-prompts/bug_solving/scripts/annotation-composite.ts",
  // Rating gate CLI (`wait-for-ratings`): boots INSIDE the fork after step 7 —
  // BLOCKS on the cluster's ratings.json, then writes rating-outcome.json.
  waitRatings: "renderer/structured-prompts/bug_solving/scripts/wait-for-ratings.ts",
  // The overlay-branch runner itself (repo-relative). Used from inside a fork's
  // branch to spin a FRESH base branch for the whole-deck baseline render.
  overlayBranch: "renderer/structured-prompts/bug_solving/scripts/overlay-branch.sh",
};

/** History dir the per-fork rating server + gate mirror verdicts into (the
 *  persistent ledger the next clustering round reads). Matches
 *  filtered-rating-server.ts's hard-coded --history-dir. */
const HISTORY_DIR = "/workspaces/sashaslides/.bug-solving-history";

const slideIdsCsv = (t: Task) => t.slides.map(s => s.slide_id).join(",");

/**
 * Every executeShell command runs INSIDE the fork's overlay branch (the engine
 * wraps it via overlay-branch.sh once `.switchBranch(branch_id)` is set). The
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

// ---------- Merge-phase args (shared with the scaffolding's accept phase) ----------
//
// The accept/merge itself no longer runs INSIDE this solve graph — it runs
// POST-RUN in main-scaffolding.ts, gated by the per-thread human rating (see
// accept-orchestration.ts). `deriveMergeArgs` is EXPORTED so the scaffolding can
// build the same staging worktree + realMergeOps it always did, and hand the
// GREEN (all-rated-good) clusters to `mergePhase` on the SAME engine/monitor.

/**
 * Run a shell command in `cwd`, returning stdout (throws on non-zero). Passed
 * into `realMergeOps` so the production merge ops drive git + record/diff
 * scripts.
 */
function mergeSh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Derive the merge-phase args from THIS run's tasks. Every input the merge
 * needs is already on the `Task[]`:
 *   - each cluster = one Task → its `workspace_dir` (the modified side the
 *     patcher composes) + its intended slides (`slides[].slide_id`).
 *   - `base` = the run's fork ref: worktrees fork from HEAD at launch, so
 *     `git rev-parse HEAD` in the repo IS that fork ref (the scaffolding runs
 *     this before any promote commit touches HEAD).
 *   - `target` = the branch the accepted state accumulates onto. Default the
 *     current branch; overridable via `BUG_SOLVING_MERGE_TARGET`.
 *   - `fixturesDir` = the repo-absolute fixture deck (shared across tasks; the
 *     merge retest renders the WHOLE deck, so any task's dir works — they all
 *     point at the same fixture set for a run).
 *
 * A dedicated staging worktree (the accumulating accepted state) is created off
 * `base` so the merge does NOT disturb the scaffolding's tree; it's torn down
 * after the phase unless `BUG_SOLVING_KEEP_STAGING=1`.
 */
export interface DerivedMergeArgs {
  args: MergePhaseArgs;
  stagingDir: string;
  stagingBranch: string;
  cleanup: () => void;
}
export function deriveMergeArgs(repo: string, tasks: Task[]): DerivedMergeArgs {
  const clusters: MergeCluster[] = tasks.map((t) => ({
    task: t.task_id,
    dir: t.workspace_dir,
    slides: t.slides.map((s) => s.slide_id),
  }));

  // base = the run's fork ref (HEAD at launch — worktrees forked from it).
  const base = mergeSh("git rev-parse HEAD", repo).trim();
  // target = the branch to accumulate onto; default = current branch.
  const target = process.env.BUG_SOLVING_MERGE_TARGET
    ?? mergeSh("git rev-parse --abbrev-ref HEAD", repo).trim();

  // Fixtures: every task in a run shares one fixture set; use task[0]'s
  // (repo-absolute). fixtures_dir is repo-relative on the Task.
  const fixturesDir = tasks.length
    ? join(tasks[0].workspace_dir, tasks[0].fixtures_dir)
    : join(repo, "renderer/html2slides/e2e/fixtures");

  // Staging worktree = the accumulating accepted state, forked off <base>.
  const ts = String(Date.now());
  const stagingDir = join(repo, ".claude/worktrees", `merge-phase-${ts}`);
  const stagingBranch = `sp/merge-phase-${ts}`;
  mergeSh(`git worktree add -b ${stagingBranch} "${stagingDir}" ${base}`, repo);

  const ops = realMergeOps({ repo, base, staging: stagingDir, fixturesDir, sh: mergeSh });

  const cleanup = () => {
    if (process.env.BUG_SOLVING_KEEP_STAGING === "1") return;
    try { mergeSh(`git worktree remove --force "${stagingDir}"`, repo); } catch { /* */ }
    try { mergeSh(`git branch -D ${stagingBranch}`, repo); } catch { /* */ }
  };

  return {
    args: { clusters, base, staging: stagingDir, fixturesDir, ops },
    stagingDir,
    stagingBranch,
    cleanup,
  };
}

// ---------- Final merge phase (after the parallelFork barrier) ----------
//
// The rating gate now lives INSIDE each fork (runTask steps A1–A3): a solved
// fork boots its own UI, blocks on the human rating, and writes a
// rating-outcome.json marker. AFTER the whole parallelFork barrier, this final
// phase reads those markers off disk, folds every GREEN cluster together WITH
// the LLM conflict resolver (mergePhase), whose renderAndDiff step IS the
// whole-deck regression recording, and promotes the clean result onto the
// target. RED / unrated clusters are excluded and demoted for re-solve.

/** A cluster classified by its on-disk rating marker. */
export interface ClassifiedCluster {
  cluster: MergeCluster;
  /** the outcome marker (null = missing/malformed = treated as not-green). */
  outcome: RatingOutcomeMarker | null;
  green: boolean;
}

/** Injected surface so the green-selection + demotion is unit-testable with no
 *  engine / git / filesystem. */
export interface GreenSelectionDeps {
  /** read a task's rating-outcome marker (default: readRatingMarker). */
  readMarker: (task: Task) => RatingOutcomeMarker | null;
  /** demote an excluded cluster's slides back to the ledger for re-solve
   *  (mirrors realMergeOps.demoteForResolve). Non-throwing + idempotent. */
  demote: (slides: string[], cluster: string, reason: string) => void;
  /** per-line logging (default console.error). */
  log?: (msg: string) => void;
}

/**
 * PURE green-selection: classify every task by its rating marker, DEMOTE the
 * non-green ones (rated bad / unrated / no marker), and return the GREEN
 * MergeClusters to fold. No engine, no git — every side-effect is on `deps`, so
 * this unit-tests directly. Returns both the green clusters (for mergePhase) and
 * the full classification (for logging).
 */
export function selectGreenClusters(
  tasks: Task[],
  deps: GreenSelectionDeps,
): { green: MergeCluster[]; classified: ClassifiedCluster[] } {
  const log = deps.log ?? ((m: string) => console.error(m));
  const classified: ClassifiedCluster[] = [];
  const green: MergeCluster[] = [];

  for (const t of tasks) {
    const cluster: MergeCluster = {
      task: t.task_id,
      dir: t.workspace_dir,
      slides: t.slides.map((s) => s.slide_id),
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

/**
 * Wire the FINAL merge phase onto a chain after the parallelFork barrier. Runs
 * as engine nodes (monitor-visible). Because the execution branch can't receive
 * the fork results, it reads each cluster's rating-outcome marker OFF DISK (the
 * forks wrote them before the barrier). GREEN clusters → mergePhase (LLM compose
 * + conflict resolution + whole-deck regression recording); non-green → demoted.
 * Under BUG_SOLVING_NO_ACCEPT the whole phase is a no-op (the forks skipped
 * their waits too). Returns a SessionWithResult<MergeReport|null> (the report is
 * logged; main() discards it and returns the TaskResults).
 */
export function finalMergePhase(
  branch: Session,
  opts: {
    repo: string;
    tasks: Task[];
    /** injected for tests; production uses the real disk/git wiring. */
    readMarker?: (task: Task) => RatingOutcomeMarker | null;
    demote?: (slides: string[], cluster: string, reason: string) => void;
    /** run mergePhase over the green clusters. Default: real deriveMergeArgs +
     *  mergePhase + cleanup. */
    runMerge?: (s: Session, green: MergeCluster[]) => SessionWithResult<MergeReport>;
    disabled?: (env: NodeJS.ProcessEnv) => boolean;
    log?: (msg: string) => void;
  },
): SessionWithResult<MergeReport | null> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const disabled = opts.disabled ?? acceptDisabled;

  // NO_ACCEPT → skip the merge entirely (forks already booted UIs + skipped
  // their waits). Return a null report on a real (no-op) node.
  if (disabled(process.env)) {
    log("[merge-final] BUG_SOLVING_NO_ACCEPT=1 → skipping final merge; leaving fixes in their worktrees.");
    return branch
      .executeShell(() => `echo merge-final:skipped-no-accept`)
      .combineWith<string, MergeReport | null>(
        (b) => b.executeShell(() => `echo merge-final:skipped-leaf`),
        () => null,
      );
  }

  // Real demote (ledger only — never touches staging), reusable for excluded
  // clusters. realMergeOps.demoteForResolve is idempotent + non-throwing.
  const demote = opts.demote ?? ((slides: string[], cluster: string, reason: string) => {
    try {
      const ops = realMergeOps({ repo: opts.repo, base: "HEAD", staging: opts.repo, fixturesDir: opts.repo, sh: mergeSh, historyDir: HISTORY_DIR });
      ops.demoteForResolve(slides, cluster, reason);
    } catch (e) {
      log(`[merge-final] demote wiring failure for ${cluster} (non-fatal): ${(e as Error)?.message ?? String(e)}`);
    }
  });
  const readMarker = opts.readMarker ?? readRatingMarker;

  // Select GREEN clusters at RUNTIME from the on-disk markers (demoting the rest)
  // inside a pipe so it runs at exec time, after the forks wrote their markers.
  // The pipe body's returned SessionWithResult carries the (logged-only) report.
  return branch
    .executeShell(() => `echo merge-final:selecting-green`)
    .pipe<MergeReport | null>((s) => {
      const { green } = selectGreenClusters(opts.tasks, { readMarker, demote, log });
      if (green.length === 0) {
        log("[merge-final] no GREEN clusters — nothing to merge.");
        return installNullReport(s);
      }
      log(`[merge-final] folding ${green.length} GREEN cluster(s): ${green.map((g) => g.task).join(", ")}`);
      // Real merge: deriveMergeArgs (staging worktree + realMergeOps) + the
      // mergePhase graph, torn down after. Injectable for tests.
      if (opts.runMerge) return opts.runMerge(s, green).combineWith<string, MergeReport | null>(
        (b2) => b2.executeShell(() => `echo merge-final:done`),
        (rep) => logMergeReport(rep, log),
      );
      const derived = deriveMergeArgs(opts.repo, opts.tasks);
      log(`[merge-final] staging worktree: ${derived.stagingDir} (branch ${derived.stagingBranch})`);
      return mergePhase(s, { ...derived.args, clusters: green })
        .combineWith<string, MergeReport | null>(
          (b2) => b2.executeShell(() => `echo merge-final:cleanup`),
          (rep) => { try { derived.cleanup(); } catch { /* */ } return logMergeReport(rep, log); },
        );
    });
}

/** Install a null MergeReport on a real graph node (mirrors merge-phase's
 *  installValue). */
function installNullReport(session: Session): SessionWithResult<MergeReport | null> {
  return session
    .executeShell(() => `echo merge-final:no-green`)
    .combineWith<string, MergeReport | null>(
      (b) => b.executeShell(() => `echo merge-final:no-green-leaf`),
      () => null,
    );
}

/** Log the final MergeReport (accepted / rejected+demoted / conflicts) and
 *  return it. */
function logMergeReport(report: MergeReport, log: (m: string) => void): MergeReport {
  log("\n================ FINAL MERGE PHASE COMPLETE ================");
  log(`accepted (${report.accepted.length}): ${report.accepted.join(", ") || "(none)"}`);
  log(`rejected (${report.rejected.length}): ${report.rejected.map((r) => `${r.task} (${r.reason})${r.demotedSlides.length ? ` → demoted: [${r.demotedSlides.join(",")}]` : ""}`).join("; ") || "(none)"}`);
  log(`conflicts (${report.conflicts.length}): ${report.conflicts.map((c) => `${c.task}[${c.files.join(",")}]=${c.resolved ? "resolved" : "UNRESOLVED"}`).join("; ") || "(none)"}`);
  log(`per-slide captures: ${Object.keys(report.perSlide).length} slide(s)`);
  log("==========================================================\n");
  return report;
}

// ---------- Main ----------

// main() runs the parallelFork solve+verify+fix-summary graph AND the per-fork
// rating gate (each solved fork boots its own UI and BLOCKS on the human rating,
// steps A1–A3), THEN — after the parallelFork barrier — a FINAL merge phase
// (finalMergePhase) folds every GREEN cluster together with the LLM conflict
// resolver + whole-deck regression recording (mergePhase) and promotes the clean
// result. The merge report is LOGGED, not returned: main() still returns the
// per-task TaskResults (`SessionWithResult<Array<Result<TaskResult>>>`). Under
// BUG_SOLVING_NO_ACCEPT the forks skip their waits and the final phase is a
// no-op. Nothing lands until a human rates every slide of a thread good.
export function main(args: {
  session: Session;
  tasks: Task[];
}): SessionWithResult<Array<Result<TaskResult>>> {

  // --- inner per-task attempt body ----------------------------------------
  const runTask = (s: Session, task: Task): SessionWithResult<TaskResult> => {
    const ids = slideIdsCsv(task);
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
      // (after-all) and WITHOUT it (baseline — the fix git-stashed, then
      // restored), then diff. Step 6b fails the attempt if any NON-cluster
      // slide changed (an off-target regression). Dirs are cleared first so a
      // retry never diffs stale pptx (the round-2 idempotent-cache trap).
      .executeShell(() => {
        const fx = task.fixtures_dir;
        const rec = SCRIPTS.record;
        // Shared /tmp scratch OUTSIDE the overlay (readable from BOTH this fix
        // branch and the fresh base branch below): before/after whole-deck pptx
        // land here so the diff can compare them.
        const reg = `/tmp/bs-reg-${task.branch_id}`;
        // Baseline runs in a SEPARATE overlay branch whose upper is EMPTY, so
        // its lower (the unmodified working tree) renders WITHOUT the fix. It
        // captures its OWN repo root as $R (a different merged mount than $ROOT).
        const baseInner =
          `R="$PWD"; cd "$R/renderer" && ` +
          `A=$(ls "$R/${fx}"/slide_*.html | xargs -n1 basename | sed "s/[.]html$//" | sort -V | paste -sd,) && ` +
          `RECORD_CONCURRENCY=1 npx tsx "$R/${rec}" --mode pptx --fixtures "$R/${fx}" --slides "$A" --out ${reg}/before-all`;
        return [
          BRANCH_CD_RENDERER,
          `rm -rf ${reg} "$ROOT/${task.scratch_dir}/reg-diffs" && mkdir -p ${reg}`,
          `ALL=$(ls "$ROOT/${fx}"/slide_*.html | xargs -n1 basename | sed 's/[.]html$//' | sort -V | paste -sd,)`,
          // RECORD_CONCURRENCY=1 forces SEQUENTIAL rendering of the whole-deck
          // before/after passes. Concurrent Chrome tabs race on web-font load,
          // shifting text metrics → nondeterministic pptx → PHANTOM off-target
          // regressions (this is what falsely failed flex-panel-width: a no-op
          // fix drew a disjoint set of "changed" slides each run). Sequential
          // rendering is empirically byte-deterministic (full-deck HEAD-vs-HEAD
          // = 0 structural drift), so the off-target diff reflects ONLY the fix.
          // AFTER = this branch (has the fix), rendered to the shared /tmp scratch.
          `RECORD_CONCURRENCY=1 npx tsx "$ROOT/${rec}" --mode pptx --fixtures "$ROOT/${fx}" --slides "$ALL" --out ${reg}/after-all`,
          // BEFORE = a FRESH base branch (empty upper → pristine converter). The
          // worker's edits live in THIS branch's upper, so `git stash` can't
          // toggle them; a separate empty-upper branch gives the unmodified tree.
          `bash "$ROOT/${SCRIPTS.overlayBranch}" run bs-regbase-${task.branch_id} bash -c '${baseInner}'`,
          `npx tsx "$ROOT/${SCRIPTS.diff}" --before ${reg}/before-all/pptx --after ${reg}/after-all/pptx --out "$ROOT/${task.scratch_dir}/reg-diffs"`,
        ].join(" && ");
      })

      // Step 4c — render the AFTER state to Google Slides BEFORE the verdict so
      // each per-slide verifier can VISUALLY compare the target vs the post-fix
      // render. This is what lets the verdict judge PIXEL-ONLY fixes the OOXML
      // structural diff is blind to (e.g. a rounded-corner image mask whose
      // <p:pic> XML is unchanged). The thumbnails dir is cleared first so every
      // retry attempt re-renders the NEW fix (uploadAndScrape is idempotent on a
      // present manifest and would otherwise reuse a stale render). Best-effort
      // (`|| true`): a flaky Google upload must not block the verdict — the
      // verifier falls back to the diff when the AFTER image is missing.
      .executeShell(() =>
        `${BRANCH_CD_RENDERER} && rm -rf "$ROOT/${task.scratch_dir}/thumbnails" && ` +
        `npx tsx "$ROOT/${SCRIPTS.record}" ` +
        `--mode full --fixtures "$ROOT/${task.fixtures_dir}" ` +
        `--slides ${ids} --title "${task.presentation_title}" ` +
        `--out "$ROOT/${task.scratch_dir}/thumbnails" || true`,
      )

      // Step 4d — VISUAL off-target gate. Reads step 4b's reg-diffs, and for any
      // NON-cluster slide the fix changed structurally, renders it BEFORE/AFTER
      // to Slides and asks an image-aware verifier whether the change is a
      // VISIBLE regression (a benign reflow passes). Writes
      // <scratch>/offtarget-gate.json, which step 6b reads. Best-effort
      // (`|| true`): the helper always writes the file + exits 0, and step 6b
      // falls back to the conservative binary structural check if it's missing.
      .executeShell(() =>
        `${BRANCH_CD_RENDERER} && npx tsx "$ROOT/${SCRIPTS.offtargetGate}" ` +
        `--scratch "$ROOT/${task.scratch_dir}" --cluster ${ids} --workdir "$ROOT" ` +
        `--fixtures "$ROOT/${task.fixtures_dir}" ` +
        `--record "$ROOT/${SCRIPTS.record}" ` +
        `--title "${task.presentation_title}-offtarget" || true`,
      )

      // Step 4e — REFRESH the consolidated per-slide attempt images from the
      // AFTER thumbnails step 4c just rendered, so the verifier's
      // slide_NN_attempt.png (and slide_NN_highlighted_attempt.png) reflect the
      // REAL post-fix render rather than the build-time "our current render".
      // Best-effort per slide (`|| true`) — a missing AFTER thumb just leaves
      // the build-time attempt in place (the CLI logs and keeps it).
      .executeShell(() => {
        const slug = fixtureSetSlug(task.fixtures_dir);
        const dir = `"$ROOT/${task.scratch_dir}/${slug}"`;
        const composite = `"$ROOT/${SCRIPTS.composite}"`;
        const cmds = task.slides.map(s => {
          const after = `"$ROOT/${task.scratch_dir}/thumbnails/thumbs/${s.slide_id}.png"`;
          const attempt = `${dir}/${s.slide_id}_attempt.png`;
          const highlighted = `${dir}/${s.slide_id}_highlighted_attempt.png`;
          // Pass the raw annotation (if any) so the highlighted composite is
          // rebuilt over the AFTER render. Annotations live in /tmp (outside the
          // overlay), reachable by absolute path inside the branch.
          const ann = s.img_annotations ? ` "${s.img_annotations}" ${highlighted}` : ``;
          return `npx tsx ${composite} refresh ${after} ${attempt}${ann} || true`;
        });
        return `${BRANCH_CD_RENDERER} && mkdir -p ${dir} && ${cmds.join(" && ")}`;
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
        child.tryMultipleTimes<string>(VERDICT_RETRIES, (c) =>
          c
            .prependToNextPrompt(
              `You are verifying the fix for ${slide.slide_id}. ` +
              `Analysis: ${task.analysis_dir}/analysis.md. ` +
              `Diff (OOXML structural): ${task.scratch_dir}/diffs/${slide.slide_id}.diff. ` +
              // Consolidated per-task images (one dir, self-describing names). The
              // ATTEMPT + HIGHLIGHTED ATTEMPT were refreshed in step 4e from the
              // just-recorded AFTER render, so they reflect the REAL post-fix output.
              `TARGET render (what it SHOULD look like): ${slide.img_original ?? slide.original_png}. ` +
              `ATTEMPT render (the post-fix Google-Slides output): ${slide.img_attempt ?? `${task.scratch_dir}/thumbnails/thumbs/${slide.slide_id}.png`}. ` +
              ((slide.img_annotations ?? slide.annotation_png) ? `RAW annotation (the user's marks alone, on transparent bg): ${slide.img_annotations ?? slide.annotation_png}. ` : ``) +
              ((slide.img_highlighted ?? slide.composite_png) ? `HIGHLIGHTED ATTEMPT (max contrast — shows WHERE the user marked, over the render): ${slide.img_highlighted ?? slide.composite_png}. ` : ``) +
              `User's original comment: "${slide.user_comment}".`,
            )
            .send({
              prompt: [
                `Read analysis.md (the H2 section for ${slide.slide_id}) and the diff file.`,
                `Then use the Read tool to VIEW (open as images — the Read tool renders a PNG visually) ALL of these from the header: the TARGET render, the ATTEMPT render, AND — if listed — the "RAW annotation" and the "HIGHLIGHTED ATTEMPT" (max-contrast composite) images. You MUST open the highlighted attempt when one is provided.`,
                `The RAW annotation alone is transparent marks on nothing — open the HIGHLIGHTED ATTEMPT to locate the marked region ON the render (the marked region is colour-shifted so it pops). FOCUS your judgement on that MARKED REGION: locate the same region in the ATTEMPT render and the TARGET, and decide whether the specific defect the user marked is gone — not whether the slide merely looks broadly okay.`,
                `Compare TARGET vs ATTEMPT (within the marked region first, then overall) against the user's comment to judge whether the defect is fixed and nothing new broke.`,
                `IMPORTANT: the OOXML diff can be EMPTY for a correct PIXEL-ONLY fix (e.g. a rasterized rounded-corner image mask). In that case judge from the IMAGES, not the diff — an empty diff is NOT evidence of failure.`,
                `If the ATTEMPT render file is missing/unreadable, judge from the diff + analysis alone and say so in the rationale.`,
                `Respond with ONLY a single-line JSON object (no prose, no code fences, no trailing commentary) with these keys:`,
                `  slide_id     (string, must equal "${slide.slide_id}"),`,
                `  rationale    (string, <=500 chars; what changed visually and/or structurally, and why),`,
                `  isRegression (boolean; true if the diff OR the AFTER image introduces NEW rendering problems not mentioned in analysis.md's Expected-diff section),`,
                `  bugSolved    (boolean; true ONLY if the user's MARKED REGION (from the annotation) in the ATTEMPT render now matches the TARGET — the circled defect is visibly GONE — AND the user's comment is addressed AND it matches the Expected-diff claim. A pixel-only fix with an empty diff still counts as solved when the ATTEMPT image's marked region is correct. If an annotation was provided but you could not open it, set bugSolved=false and say so in the rationale).`,
                `Example:`,
                `{"slide_id":"${slide.slide_id}","rationale":"device corners now rounded in the AFTER render; target and after match","isRegression":false,"bugSolved":true}`,
              ].join(" "),
            })
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
              thumbnails_dir: `${task.scratch_dir}/thumbnails/thumbs`,
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
        const offTarget = readOffTargetRegressions(task);
        if (offTarget.length)
          lines.push(`OFF-TARGET VISIBLE REGRESSIONS (${offTarget.length}) — non-cluster slides the image verifier judged visibly worse after this fix: ${offTarget.join(", ")}`);
        if (lines.length) throw new Error(lines.join("\n"));
      })

      // Step 7 — upload consolidated pptx + scrape thumbnails.
      //   This is our only Google-side effect in main.ts and it's
      //   short-lived (finishes before the result is returned).
      //   `combineWith` preserves the upstream TaskResult across the
      //   executeShell side effect.
      //
      // Step 8 — no action needed here. The TaskResult already carries
      //   `sxs_server_spec` from step 6. main-scaffolding.ts reads it
      //   after engine.execute resolves and spawns the filtered rating
      //   server as a tracked child process (see file header:
      //   "subprocess lifetime").
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
          `--out "$ROOT/${task.scratch_dir}/thumbnails" || true`
        ),
        (taskResult) => {
          // Best-effort: write the sxs-meta.json provenance sidecar into the
          // rating-server resultsDir (= <scratch>/thumbnails) so every SxS card
          // shows the original HTML link, the presentation URL (read from the
          // structured manifest.json the upload wrote — not scraped from stdout),
          // the original annotation, and the original comment. A throw here must
          // not lose an already-PASSED fix → writeSxsMeta swallows its own errors.
          writeSxsMeta(`${task.scratch_dir}/thumbnails`, task.slides);
          return taskResult;
        },
      )

      // ── Step A1 — BOOT this fork's rating server DETACHED ──────────────────
      // Only a SOLVED fork reaches here (step 6b threw for a failed verdict).
      // The server survives this node (setsid + `& disown`) so the human can
      // rate it while the fork blocks in A2 and the OTHER forks run in parallel.
      // filtered-rating-server.ts translates the old argv into rating-server.ts
      // (which prints the notify line + runs BUG_SOLVING_NOTIFY_CMD on boot),
      // pointed at this cluster's thumbnails + diffs + analysis, filtered to its
      // slides, with the persistent --history-dir. Under BUG_SOLVING_NO_ACCEPT
      // we still boot the UI for review (the wait in A2 is skipped).
      .combineWith<string, TaskResult>(
        (branch) => branch.executeShell((tr) => {
          const spec = tr.sxs_server_spec;
          // spec.analysis_md / diffs_dir / thumbnails_dir are repo-relative
          // (built from task.scratch_dir / analysis_dir); resolve them as
          // absolute inside the branch via $ROOT. The rating server binds
          // localhost:<port>, reachable from the host (the branch shares the
          // host network namespace — only user+mount are unshared).
          const server = `"$ROOT/${SCRIPTS.filteredServer}"`;
          const log = `"$ROOT/${task.scratch_dir}/rating-server.log"`;
          const inner =
            `npx tsx ${server} ` +
            `--port ${spec.port} ` +
            `--slides ${spec.slides.join(",")} ` +
            `--analysis "$ROOT/${spec.analysis_md}" ` +
            `--diffs "$ROOT/${spec.diffs_dir}" ` +
            `--thumbnails "$ROOT/${spec.thumbnails_dir}" ` +
            `--task-title "${spec.task_title}"`;
          // setsid + `& disown` detaches the server so it outlives this node.
          return (
            `${BRANCH_CD_RENDERER} && ` +
            `setsid ${inner} > ${log} 2>&1 < /dev/null & disown; ` +
            `echo "[rating-server] ${task.task_id} → http://localhost:${spec.port} (log ${task.scratch_dir}/rating-server.log)"`
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
          return (
            `${BRANCH_CD_RENDERER} && npx tsx ${wait} ` +
            `--results-dir "$ROOT/${task.scratch_dir}/thumbnails" ` +
            `--slides ${ids} ` +
            `--task-id ${task.task_id} ` +
            `--marker "$ROOT/${ratingMarkerPath(task)}" ` +
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
  // GREEN clusters through mergePhase (LLM compose + conflict resolution +
  // whole-deck regression recording). The merge report is LOGGED, not returned —
  // main() still yields the per-task TaskResults.
  const repo = process.cwd();
  return args.session
    .parallelFork(args.tasks, (child, task) =>
      child
        // Run this task's WHOLE chain (worker model `send`s + record/diff
        // shells) INSIDE its own overlay branch — a zero-copy COW mount over the
        // working tree. Every command is wrapped via overlay-branch.sh, so the
        // worker's edits + scratch land in the branch's isolated upper layer and
        // never touch the base tree (nor sibling forks). Replaces the old git
        // worktree + switchCwd.
        .switchBranch(task.branch_id)
        .try<Result<TaskResult>>(
          (s) => s.tryMultipleTimes<TaskResult>(
            task.retry_budget,
            (s2) => runTask(s2, task),
          ),
          // Don't cancel sibling tasks when one task fails outright.
          (s, e) => s.materializeError(describeError(e)),
        ),
    )
    // FINAL PHASE: fold GREEN clusters after the barrier. The execution branch
    // (finalMergePhase) can't receive `taskResults` — it reads the rating-outcome
    // markers the forks wrote before the barrier — so the combine callback simply
    // discards the (logged-only) merge report and returns the TaskResults.
    .combineWith<MergeReport | null, Array<Result<TaskResult>>>(
      (branch) => finalMergePhase(branch, { repo, tasks: args.tasks }),
      (taskResults, _mergeReport) => taskResults,
    );
}
