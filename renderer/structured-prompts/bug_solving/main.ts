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
 *     ratings.json; the fork's chain is `forwardChain` (forward-fork.ts: record pptx,
 *     diff, off-target gate, Google render, verdict).
 *   · reverse — Google Slides -> Sasha engine document -> Sasha HTML. Clusters from
 *     `.sxs-reverse/ratings-reverse.json` (keyed "<set>__slide_NN", the user's comment,
 *     annotation and zoom crops are the issue); the fork's chain is `reverseChain`
 *     (reverse-run-task.ts): the worker fixes the importer / engine renderer / HTML export,
 *     the reverse pipeline re-records the cluster's slides OFFLINE from the fork, a
 *     regression gate re-runs every set and compares against the user's goldens-reverse
 *     and the current metrics (no slide may rise > 0.05 points), the verdict compares the
 *     Sasha render with Google's thumbnail, and the fork's own reverse rating UI BLOCKS
 *     for the user's good/bad. Same overlays, retries, markers and MERGE_PHASE (its
 *     converter filter widened to the reverse files; the stability branch is skipped —
 *     it classifies the forward deck). Goldens stay user-only in both directions.
 *   Pure parts live in reverse-direction.ts and reverse-regression-gate.ts. Both
 *   directions run the same skeleton, fork-chain.ts `forkChain`.
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
} from "../../../structured-prompting/src/index.js";
import type { Result } from "../../../structured-prompting/src/index.js";
import { readdirSync } from "fs";
import { join } from "path";
import { forkChain } from "./fork-chain.js";
import { FORWARD_HISTORY_DIR, forwardChain } from "./forward-fork.js";
import { llmMerge, ledgerDemote, realLlmMergeOps, defaultConverterFilter, type GreenCluster, type MergeReport } from "./llm-merge.js";
import { acceptDisabled } from "./rating-gate.js";
import { notGreenReason, readRatingMarker } from "./rating-marker.js";
import { STABILITY_JSON } from "./stability.js";
import { isReverseFixFile, type ReversePaths, type ReverseSlideContext, type SolveDirection } from "./reverse-direction.js";
import { reverseChain } from "./reverse-run-task.js";

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
                                     //   branch) can read it. See rating-marker.ts.
  scratch_dir: string;               // REPO-RELATIVE scratch, created INSIDE the branch (binary pptx/diff artifacts)
  analysis_dir: string;              // REPO-RELATIVE model docs dir, created INSIDE the branch (analysis.md / fix-summary.md)
  fixtures_dir: string;              // repo-relative fixtures dir for this cluster's slides (e.g. fixtures-basic)
  server_port: number;               // unique port for the filtered rating server
  presentation_title: string;        // fork-unique, e.g. "bug_solving-clipping-curves-1713512345"
  slides: SlideTask[];
  cluster_description: string;       // root-cause hypothesis for the wave
  retry_budget: number;              // e.g. 3
  direction: SolveDirection;         // which round trip this fork repairs (forwardChain or reverseChain)
}

export interface SlideVerdict {
  slide_id: string;
  rationale: string;
  isRegression: boolean;
  bugSolved: boolean;
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

  // ---- Per-fork rating outcome (folded in by fork-chain.ts steps A1–A3) ----
  // A fork only reaches the rating gate once its verdict PASSED (step 6b did not
  // throw). These fields reflect the human rating recorded in the fork's own UI:
  rated: boolean;                    // true once every slide got a good/bad verdict
  green: boolean;                    // true iff rated && every slide is `good`
  bad_slides: string[];              // slides rated bad (or, on a timeout, unrated)
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
// The rating gate lives INSIDE each fork (fork-chain.ts steps A1–A3): a solved fork
// boots its own UI, blocks on the human rating, and writes a rating-outcome.json
// marker to its SHARED dir (outside the overlay). AFTER the whole parallelFork
// barrier, this final phase reads those markers off disk and folds every GREEN
// cluster together with the SIMPLE LLM MERGE (llm-merge.ts): base + each green
// fork's version of a changed converter file → one LLM-merged file, retest, and
// promote onto the working tree. RED / unrated clusters are excluded + demoted.

/**
 * Classify every task by its on-disk rating marker, DEMOTE the non-green ones
 * (rated bad / unrated / no marker; `demote` must not throw), and
 * return the GREEN clusters, each addressed by its fork's branch_id.
 */
function selectGreenClusters(
  tasks: Task[],
  demote: (slides: string[], cluster: string, reason: string) => void,
  log: (msg: string) => void,
): GreenCluster[] {
  const green: GreenCluster[] = [];
  for (const t of tasks) {
    const cluster: GreenCluster = {
      task: t.task_id,
      branch_id: t.branch_id,
      slides: t.slides.map((s) => s.slide_id),
      // ABSOLUTE shared dir — reaped with the solve overlay on a successful merge.
      shared_dir: t.shared_dir,
    };
    const outcome = readRatingMarker(t);
    if (outcome?.green === true) {
      green.push(cluster);
      log(`[merge-final] ${t.task_id} → GREEN (all rated good) — accept candidate.`);
    } else {
      const reason = notGreenReason(outcome);
      log(`[merge-final] ${t.task_id} → EXCLUDED (${reason}) — demoting for re-solve.`);
      demote(cluster.slides, cluster.task, reason);
    }
  }
  return green;
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
      return { historyDir: FORWARD_HISTORY_DIR, converterFilter: defaultConverterFilter, forwardDeckSlides: (slides) => slides };
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
  },
): SessionWithResult<MergeReport | null> {
  const log = (m: string): void => console.error(m);

  // NO_ACCEPT → skip the merge entirely (forks already booted UIs + skipped
  // their waits). Return a null report on a real (no-op) node.
  if (acceptDisabled(process.env)) {
    log("[merge-final] BUG_SOLVING_NO_ACCEPT=1 → skipping final merge; leaving fixes in their forks.");
    return branch
      .executeShell(() => `echo merge-final:skipped-no-accept`)
      .combineWith<string, MergeReport | null>(
        (b) => b.executeShell(() => `echo merge-final:skipped-leaf`),
        () => null,
      );
  }

  // Real demote (ledger only). ledgerDemote is idempotent + non-throwing.
  const demote = (slides: string[], cluster: string, reason: string): void => {
    try { ledgerDemote(opts.merge.historyDir, slides, cluster, reason); }
    catch (e) { log(`[merge-final] demote wiring failure for ${cluster} (non-fatal): ${(e as Error)?.message ?? String(e)}`); }
  };

  // Select GREEN clusters at RUNTIME from the on-disk markers (demoting the rest)
  // inside a pipe so it runs at exec time, after the forks wrote their markers.
  // The pipe body's returned SessionWithResult carries the (logged-only) report.
  return branch
    .executeShell(() => `echo merge-final:selecting-green`)
    .pipe<MergeReport | null>((s) => {
      const green = selectGreenClusters(opts.tasks, demote, log).map((cluster) => ({ ...cluster, slides: opts.merge.forwardDeckSlides(cluster.slides) }));
      if (green.length === 0) {
        log("[merge-final] no GREEN clusters — nothing to merge.");
        return installNullReport(s);
      }
      log(`[merge-final] folding ${green.length} GREEN cluster(s): ${green.map((g) => g.task).join(", ")}`);
      // llmMerge: base + each fork's converter version → LLM-merged file(s),
      // retest, promote onto the working tree.
      return llmMerge(s, {
        repo: opts.repo,
        greenClusters: green,
        converterFilter: opts.merge.converterFilter,
        ops: realLlmMergeOps({ repo: opts.repo, fixturesDir: runFixturesDir(opts.repo, opts.tasks), historyDir: opts.merge.historyDir }),
      }).combineWith<string, MergeReport | null>(
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
// fork-chain.ts steps A1–A3), THEN — after the parallelFork barrier — a FINAL merge phase
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

  // Each fork runs the shared chain (fork-chain.ts) with its direction's parts.
  const runTaskFor = (s: Session, task: Task): SessionWithResult<TaskResult> => {
    switch (task.direction) {
      case "forward":
        return forkChain(s, task, forwardChain(task));
      case "reverse":
        if (args.reverse === null) throw new Error(`${task.task_id}: a reverse task needs main({ reverse })`);
        return forkChain(s, task, reverseChain(task, args.reverse));
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
  // gate (fork-chain.ts steps A1–A3: boot the fork's UI → BLOCK on the human rating →
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
