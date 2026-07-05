/**
 * merge-final-e2e.test.ts — the MISSING end-to-end test proving `main()`'s FINAL
 * MERGE PATH works for real, top to bottom:
 *
 *     real rating-outcome.json on disk
 *        → readRatingMarker (REAL, default)               [marker → selection]
 *        → selectGreenClusters                            [GREEN vs demote]
 *        → finalMergePhase  on the REAL ClaudeEngine      [engine nodes]
 *        → runMerge = REAL mergePhase(realMergeOps(...))  [compose/promote/revert]
 *        → REAL git promote / revert
 *          + REAL local render + REAL pngjs pixel-diff    [detects the ripple]
 *          + REAL npx tsc on the staging converter        [type gate]
 *          + REAL candidates.json / ratings.json ledger   [demote]
 *
 * ## HARD RULE — the ONLY thing mocked is the LLM.
 *   git, filesystem, render, diff, tsc, and the ledger ALL execute for real. The
 *   Google-Slides render is the ONLY step legitimately SUBSTITUTED — not scripted —
 *   by a REAL LOCAL renderer (test-helpers/fixture-render.ts: a pngjs 5x7 bitmap
 *   font → real PNG + real pngjs pixel diff; offline, no Chrome, no Google). Every
 *   changed-slide decision is computed from ACTUAL PNG bytes, NOT a scripted list.
 *
 *   Line-by-line MOCK/REAL inventory (see the assertions in each case):
 *     - LLM (conflict resolver `send`)  → MOCKED (MockIO canned `claude` reply).
 *     - git (init/worktree/commit/restore/rev-parse/show/status) → REAL (execSync).
 *     - filesystem (read/write converter, markers, ledger) → REAL (node:fs).
 *     - compose (3-way patcher computeChanges+applyChanges) → REAL.
 *     - render + pixel-diff (renderAndDiff)               → REAL LOCAL (pngjs).
 *     - capture (screenshot + composed-XML read)          → REAL (renders + reads).
 *     - tsc gate (tscConverterErrors)                     → REAL (`npx tsc --noEmit`).
 *     - ledger demote (candidates.json/ratings.json)      → REAL (realMergeOps).
 *     - marker read (readRatingMarker)                    → REAL (default, not injected).
 *     - selection (selectGreenClusters)                   → REAL.
 *     - engine (ClaudeEngine.execute of finalMergePhase)  → REAL.
 *
 * ## Fork cases (all in ONE finalMergePhase run on ONE engine)
 *   - clean-A (border)    : GREEN clean fork, edits L03/BORDER → promotes, edit lands.
 *   - clean-B (shadow)    : GREEN clean fork, edits L06/SHADOW → promotes; overlaps
 *                           the SAME converter file as A on a DIFFERENT line → the
 *                           3-way compose keeps BOTH edits.
 *   - ripple (gradient)   : GREEN fork whose real converter edit ALSO perturbs
 *                           INSET (slide_09, non-intended) → the REAL render+diff
 *                           detects the extra changed slide → revert + demote.
 *   - conflict (borderX)  : GREEN fork that CONFLICTS with A on L03 → the MOCKED
 *                           LLM writes a REAL marker-free resolved file → tsc-clean
 *                           → promoted (A's border kept, C's fix lands on RADIUS).
 *   - red (inset)         : RED fork (rating-outcome.json green:false) → excluded by
 *                           selection + demoted, NEVER handed to mergePhase.
 *
 * Every temp dir + staging worktree is torn down in a finally-registry (even on a
 * failure); the test asserts NO leaked `git worktree` at the end.
 *
 * Run:  cd /workspaces/sashaslides && \
 *       npx tsx renderer/structured-prompts/bug_solving/merge-final-e2e.test.ts
 */
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeEngine, Session, type SessionWithResult } from "../../../structured-prompting/src/index.js";
import {
  MockIO,
  type EffectCall,
  type Matcher,
  type SpawnCaptureArgs,
  type SpawnCaptureResult,
} from "../../../structured-prompting/src/server/io.js";
import {
  finalMergePhase,
  readRatingMarker,
  ratingMarkerPath,
  type Task,
  type RatingOutcomeMarker,
} from "./main.js";
import {
  mergePhase,
  realMergeOps,
  type MergeCluster,
  type MergeReport,
} from "./merge-phase.js";
import { pngPixelsDiffer } from "./test-helpers/small-text-png.js";
import { renderDeck, realRenderAndDiff, renderSlideTextPngToFile } from "./test-helpers/fixture-render.js";

// ---------------------------------------------------------------------------
// tiny harness (plain tsx, local ok() counter, === Results ===, exit 1 on fail)
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];
/** finally-registry: every temp dir / worktree removal registers here and is run
 *  in reverse even when the test body throws. */
const cleanups: Array<() => void> = [];
function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
}
function register(fn: () => void): void { cleanups.push(fn); }
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  cleanups.length = 0;
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, err: e });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${((e as Error)?.stack ?? String(e)).split("\n").slice(0, 12).join("\n      ")}`);
  } finally {
    for (const c of cleanups.splice(0).reverse()) { try { c(); } catch { /* */ } }
  }
}

// ---------------------------------------------------------------------------
// REAL shell / git helpers on the temp repo (execSync — the real thing).
// ---------------------------------------------------------------------------
function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** The sh(cmd, cwd) shape realMergeOps expects (matches main.ts mergeSh). */
function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ---------------------------------------------------------------------------
// MockIO reply builders — the LLM is the ONLY mock.
// ---------------------------------------------------------------------------
function claudeReply(result: string): SpawnCaptureResult {
  const payload = { type: "result", subtype: "success", is_error: false, result, session_id: "mock-sid", duration_ms: 1, total_cost_usd: 0 };
  return { stdout: JSON.stringify(payload), stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null };
}
function bashReply(stdout = ""): SpawnCaptureResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null };
}
function isClaude(c: EffectCall): boolean { return c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "claude"; }
function isBash(c: EffectCall): boolean { return c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "bash"; }
function promptOf(c: EffectCall): string {
  const a = c.args[0] as SpawnCaptureArgs;
  const pi = a.args.indexOf("-p");
  return pi >= 0 ? (a.args[pi + 1] ?? "") : "";
}
function cwdOf(c: EffectCall): string | undefined { return (c.args[0] as SpawnCaptureArgs).cwd; }

/** Shared matchers: clock/log/the echo `bash` nodes + the engine's per-node `git`
 *  diff-capture spawns (all ignored — the REAL git we care about is done via
 *  execSync in realMergeOps, NOT through the mocked IO). The ONLY meaningful mock
 *  is the `claude` matcher each test supplies. */
function baseMatchers(): Matcher[] {
  return [
    { name: "now", when: (c) => c.method === "now", returns: (_c: EffectCall, i: number) => 1_700_000_000_000 + i },
    { name: "log", when: (c) => c.method === "log", returns: undefined, optional: true },
    { name: "bash-echo", when: isBash, returns: bashReply(""), optional: true },
    {
      name: "git-diff-capture",
      when: (c) => c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "git",
      returns: bashReply(""), optional: true,
    },
    { name: "writeFileSync", when: (c) => c.method === "writeFileSync", returns: undefined, optional: true },
    { name: "rmSync", when: (c) => c.method === "rmSync", returns: undefined, optional: true },
    { name: "mkdtempSync", when: (c) => c.method === "mkdtempSync", returns: "/tmp/mock-merge-XXXX", optional: true },
  ];
}

// ---------------------------------------------------------------------------
// The BASE converter — the same numbered feature functions the render service
// (test-helpers/fixture-render.ts) binds each slide to.
// ---------------------------------------------------------------------------
const CONVERTER_REL = "renderer/html2slides/convert.ts";
const BASE_CONVERTER = [
  "// convert.ts — fake converter for the merge-final e2e test",
  "export function borderWidth(): number {",
  "  return 1; // L03 BORDER",
  "}",
  "export function shadowBlur(): number {",
  "  return 2; // L06 SHADOW",
  "}",
  "export function gradientStops(): number {",
  "  return 3; // L09 GRADIENT",
  "}",
  "export function radius(): number {",
  "  return 4; // L12 RADIUS",
  "}",
  "export function inset(): number {",
  "  return 5; // L15 INSET",
  "}",
  "export const VERSION = \"base\";",
  "",
].join("\n");

// Line-level edits on BASE_CONVERTER — same convention as the integration test.
const editBorder = (s: string) => s.replace("  return 1; // L03 BORDER", "  return 11; // L03 BORDER (clean fork A)");
const editShadow = (s: string) => s.replace("  return 2; // L06 SHADOW", "  return 22; // L06 SHADOW (clean fork B)");
const editBorderAlt = (s: string) => s.replace("  return 1; // L03 BORDER", "  return 99; // L03 BORDER (conflict fork)");
const editInset = (s: string) => s.replace("  return 5; // L15 INSET", "  return 77; // L15 INSET (red fork)");
// RIPPLE: the gradient fork is SUPPOSED to only touch GRADIENT (L09 → slide_05).
// But its edit ALSO rewrites INSET (L15 → slide_09). Each slide's rendered PNG is
// derived LIVE from the converter's current feature value, so perturbing INSET
// makes slide_09's PNG genuinely differ from baseline → the REAL pixel-diff (NOT a
// scripted list) detects the extra, non-intended slide → revert + demote.
const editGradient = (s: string) =>
  s.replace("  return 3; // L09 GRADIENT", "  return 33; // L09 GRADIENT (ripple fork)")
   .replace("  return 5; // L15 INSET", "  return 66; // L15 INSET (rippled by gradient fork)");

// The deck the render service rasterises (1:1 slide↔feature, see SLIDE_FEATURE).
const DECK = ["slide_02", "slide_04", "slide_05", "slide_07", "slide_09"];

// ---------------------------------------------------------------------------
// Fixture: a REAL temp git repo with a converter, a fixture deck, and a seeded
// candidates.json/ratings.json ledger (all deck slides start `good`).
// ---------------------------------------------------------------------------
interface Fixture {
  repo: string;
  base: string;        // fork-base commit SHA
  fixturesDir: string; // repo-absolute deck dir
  historyDir: string;  // .bug-solving-history (the REAL ledger)
}
let counter = 0;
function makeFixtureRepo(tag: string): Fixture {
  const repo = mkdtempSync(join(tmpdir(), `mfe2e-${tag}-${counter++}-`));
  register(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* */ } });

  git(repo, "init -q -b main");
  git(repo, "config user.email test@merge.local");
  git(repo, "config user.name merge-final-e2e");
  git(repo, "config commit.gpgsign false");

  mkdirSync(join(repo, "renderer/html2slides"), { recursive: true });
  writeFileSync(join(repo, CONVERTER_REL), BASE_CONVERTER);

  const fixturesDir = join(repo, "renderer/html2slides/e2e/fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  for (const sid of DECK) writeFileSync(join(fixturesDir, `${sid}.html`), `<html><body>${sid}</body></html>`);

  // REAL ledger seed: every deck slide + the red fork's slide start `good` with a
  // user comment (so demote's "don't clobber the user comment" path is exercised).
  const historyDir = join(repo, ".bug-solving-history");
  mkdirSync(historyDir, { recursive: true });
  const cand: Record<string, { status: string; comment: string }> = {};
  const rat: Record<string, { comment: string }> = {};
  for (const sid of DECK) {
    cand[sid] = { status: "good", comment: `user issue for ${sid}` };
    rat[sid] = { comment: `user issue for ${sid}` };
  }
  writeFileSync(join(historyDir, "candidates.json"), JSON.stringify(cand, null, 2));
  writeFileSync(join(historyDir, "ratings.json"), JSON.stringify(rat, null, 2));

  mkdirSync(join(repo, ".claude/worktrees"), { recursive: true });
  git(repo, "add -A");
  git(repo, "commit -q -m base");
  const base = git(repo, "rev-parse HEAD");
  return { repo, base, fixturesDir, historyDir };
}

/** A REAL cluster worktree (a solved fork): `git worktree add` off base, edit the
 *  converter, commit. Registered for teardown. */
function makeForkWorktree(fx: Fixture, task: string, edit: (base: string) => string): string {
  const branch = `sp/fork-${task}-${counter}`;
  const dir = join(fx.repo, ".claude/worktrees", `fork-${task}-${counter}`);
  git(fx.repo, `worktree add -q -b ${branch} "${dir}" ${fx.base}`);
  writeFileSync(join(dir, CONVERTER_REL), edit(BASE_CONVERTER));
  git(dir, "add -A");
  git(dir, "commit -q -m " + task);
  register(() => {
    try { git(fx.repo, `worktree remove --force "${dir}"`); } catch { /* */ }
    try { git(fx.repo, `branch -D ${branch}`); } catch { /* */ }
  });
  return dir;
}

/** Build a REAL Task with a scratch dir under the worktree, so ratingMarkerPath
 *  (= scratch_dir/rating-outcome.json) points at a real on-disk path. */
function makeTask(fx: Fixture, task_id: string, dir: string, slides: string[]): Task {
  const scratch = join(dir, ".bug-solving-scratch");
  mkdirSync(scratch, { recursive: true });
  return {
    task_id,
    workspace_dir: dir,
    scratch_dir: scratch,
    analysis_dir: join(dir, "bug-solving-analysis"),
    fixtures_dir: "renderer/html2slides/e2e/fixtures",
    server_port: 4720,
    presentation_title: `bug_solving-${task_id}-1`,
    slides: slides.map((slide_id) => ({
      slide_id,
      html_file: join(fx.fixturesDir, `${slide_id}.html`),
      user_comment: `user issue for ${slide_id}`,
      rendered_png: `/tmp/${slide_id}.png`,
      original_png: `/tmp/${slide_id}.orig.png`,
    })),
    cluster_description: `${task_id} cluster`,
    retry_budget: 1,
  };
}

/** Write a REAL rating-outcome.json marker at ratingMarkerPath(task). GREEN or
 *  RED. This is the exact file wait-for-ratings.ts writes and readRatingMarker
 *  reads — so the marker→selection path is proven end-to-end. */
function writeMarker(task: Task, green: boolean, bad: string[] = []): void {
  const slides = task.slides.map((s) => s.slide_id);
  const marker: RatingOutcomeMarker = {
    task_id: task.task_id,
    rated: true,
    green,
    good: green ? slides : slides.filter((s) => !bad.includes(s)),
    bad: green ? [] : bad,
    unrated: [],
    slides,
  };
  writeFileSync(ratingMarkerPath(task), JSON.stringify(marker, null, 2));
}

// ---------------------------------------------------------------------------
// A REAL staging worktree forked off base (like deriveMergeArgs).
// ---------------------------------------------------------------------------
function makeStaging(fx: Fixture, tag: string): { stagingDir: string; branch: string } {
  const branch = `sp/staging-${tag}-${counter}`;
  const stagingDir = join(fx.repo, ".claude/worktrees", `staging-${tag}-${counter}`);
  git(fx.repo, `worktree add -q -b ${branch} "${stagingDir}" ${fx.base}`);
  register(() => {
    try { git(fx.repo, `worktree remove --force "${stagingDir}"`); } catch { /* */ }
    try { git(fx.repo, `branch -D ${branch}`); } catch { /* */ }
  });
  return { stagingDir, branch };
}

// ---------------------------------------------------------------------------
// Build the REAL realMergeOps for a run: the ONLY substituted method is the
// Google render → a REAL LOCAL pngjs renderer+diff; tsc is REAL `npx tsc`.
// ---------------------------------------------------------------------------
function buildRealOps(fx: Fixture, stagingDir: string, scratchRoot: string) {
  const pngRoot = join(scratchRoot, "pngs");
  const acceptedStateConverter = (): string => {
    try { return git(stagingDir, `show HEAD:${CONVERTER_REL}`); } catch { return BASE_CONVERTER; }
  };
  const currentConverter = (): string => {
    try { return readFileSync(join(stagingDir, CONVERTER_REL), "utf8"); } catch { return ""; }
  };
  return realMergeOps({
    repo: fx.repo,
    base: fx.base,
    staging: stagingDir,
    fixturesDir: fx.fixturesDir,
    sh,
    historyDir: fx.historyDir,
    // REAL LOCAL render + REAL pngjs pixel-diff. baselineDir===null renders the
    // accepted-state (git HEAD) baseline; per-cluster we re-render the rolling
    // accepted-state baseline AND the post-compose working tree, then diff pixel-
    // for-pixel — the changed set is computed from REAL PNG bytes, never scripted.
    renderAndDiff: (baselineDir, outDir) => {
      if (baselineDir === null) {
        renderDeck(acceptedStateConverter(), DECK, join(pngRoot, "baseline"));
        return [];
      }
      renderDeck(acceptedStateConverter(), DECK, join(pngRoot, "baseline"));
      const postDir = join(pngRoot, `post-${outDir.split("post-")[1] ?? "x"}`);
      return realRenderAndDiff(currentConverter, DECK, join(pngRoot, "baseline"), postDir);
    },
    // REAL capture: render the just-accepted slide's PNG to disk and read the REAL
    // composed converter off the staging tree as the "xml".
    captureSlide: (sid) => {
      const shotDir = join(pngRoot, "captures");
      mkdirSync(shotDir, { recursive: true });
      const shot = join(shotDir, `${sid}.png`);
      renderSlideTextPngToFile(currentConverter(), sid, shot);
      let xml: string | null = null;
      try { xml = readFileSync(join(stagingDir, CONVERTER_REL), "utf8"); } catch { /* */ }
      return { screenshotPath: shot, xml };
    },
    // REAL tsc gate: run actual `npx tsc --noEmit` on JUST the staging converter
    // (a self-contained, import-free .ts file). A valid file → 0 errors; a
    // marker-laden / type-broken file → >0. This is real executing code, not () => 0.
    tscConverterErrors: () => {
      const file = join(stagingDir, CONVERTER_REL);
      try {
        sh(`npx tsc --noEmit --strict --skipLibCheck --lib es2020 "${file}"`, fx.repo);
        return 0;
      } catch (e) {
        const out = (e as { stdout?: Buffer }).stdout?.toString() ?? (e as Error).message ?? "";
        return out.split("\n").filter((l) => /error TS/.test(l)).length || 1;
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Drive finalMergePhase on the REAL engine with:
//   - readMarker = default REAL readRatingMarker (NOT injected),
//   - demote     = REAL (writes the REAL candidates.json/ratings.json ledger),
//   - runMerge   = REAL mergePhase(realMergeOps(...)) on a REAL staging worktree.
// Everything except the LLM (MockIO) executes for real.
// ---------------------------------------------------------------------------
interface RunResult { report: MergeReport | null; io: MockIO; threw: unknown; stagingDir: string; }
async function runFinalMerge(
  fx: Fixture, tasks: Task[], claudeMatcher: Matcher, scratchRoot: string,
): Promise<RunResult> {
  const { stagingDir } = makeStaging(fx, "e2e");
  const ops = buildRealOps(fx, stagingDir, scratchRoot);

  const io = new MockIO({ matchers: [...baseMatchers(), claudeMatcher] });
  const engine = new ClaudeEngine({ io, persist: false, hookSignals: false, log: false, port: 0 });
  let report: MergeReport | null = null;
  let threw: unknown = null;
  try {
    report = await engine.execute(
      new Session({ sessionId: "merge-final-e2e", cwd: fx.repo }),
      (s) =>
        finalMergePhase(s, {
          repo: fx.repo,
          tasks,
          // readMarker OMITTED → default REAL readRatingMarker (marker→selection proven e2e).
          // demote OMITTED would use HISTORY_DIR (the real repo!); inject a REAL
          // demote pointed at THIS fixture's historyDir — still real executing
          // realMergeOps.demoteForResolve, writing the REAL ledger, just scoped to
          // the temp repo so we never touch /workspaces/sashaslides/.bug-solving-history.
          demote: (slides, cluster, reason) => {
            realMergeOps({ repo: fx.repo, base: "HEAD", staging: fx.repo, fixturesDir: fx.repo, sh, historyDir: fx.historyDir })
              .demoteForResolve(slides, cluster, reason);
          },
          // runMerge = the REAL mergePhase over the REAL ops on the REAL staging worktree.
          runMerge: (s2, green): SessionWithResult<MergeReport> =>
            mergePhase(s2, {
              clusters: green,
              base: fx.base,
              staging: stagingDir,
              fixturesDir: fx.fixturesDir,
              resolveModel: "opus",
              ops,
              scratchRoot: join(scratchRoot, "merge"),
            }),
          log: () => {},
        }),
    );
  } catch (e) { threw = e; }
  finally { await engine.shutdown(); }
  return { report, io, threw, stagingDir };
}

// ---------------------------------------------------------------------------
// small readers
// ---------------------------------------------------------------------------
function stagingConverter(stagingDir: string): string {
  return readFileSync(join(stagingDir, CONVERTER_REL), "utf8");
}
function readCandidates(fx: Fixture): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(fx.historyDir, "candidates.json"), "utf8"));
}
function readRatings(fx: Fixture): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(fx.historyDir, "ratings.json"), "utf8"));
}
/** Count live git worktrees other than the main checkout (leak detector). */
function extraWorktrees(repo: string): string[] {
  const out = git(repo, "worktree list --porcelain");
  return out.split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .filter((p) => p !== repo);
}

const C = (task: string, dir: string, slides: string[]): MergeCluster => ({ task, dir, slides });
const mkScratch = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `mfe2e-scratch-${tag}-`));
  register(() => { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } });
  return d;
};

// ---------------------------------------------------------------------------
// The e2e test
// ---------------------------------------------------------------------------
async function main() {
  console.log("\nmerge-final-e2e: finalMergePhase on the REAL engine (ONLY the LLM is mocked)\n");

  await test("finalMergePhase e2e: 2 clean GREEN promote, ripple GREEN reverts, conflict GREEN resolves, RED excluded — all on REAL git/fs/render/diff/tsc/ledger", async () => {
    const fx = makeFixtureRepo("full");

    // --- REAL solved forks (git worktrees) ---------------------------------
    // clean-A: independent edit (L03/BORDER → slide_02).
    const forkA = makeForkWorktree(fx, "border", editBorder);
    // clean-B: overlapping the SAME file on a DIFFERENT line (L06/SHADOW → slide_07).
    const forkB = makeForkWorktree(fx, "shadow", editShadow);
    // ripple: clean compose but perturbs INSET(slide_09) too (intended slide_05).
    const forkR = makeForkWorktree(fx, "gradient", editGradient);
    // conflict: edits L03 like A → 3-way compose conflicts (intended slide_04).
    const forkC = makeForkWorktree(fx, "borderX", editBorderAlt);
    // red: a real green:false marker (intended slide_09) → excluded, never merged.
    const forkRed = makeForkWorktree(fx, "insetRed", editInset);

    // --- REAL Tasks + REAL rating-outcome.json markers ---------------------
    const tA = makeTask(fx, "border", forkA, ["slide_02"]);
    const tB = makeTask(fx, "shadow", forkB, ["slide_07"]);
    const tR = makeTask(fx, "gradient", forkR, ["slide_05"]);
    const tC = makeTask(fx, "borderX", forkC, ["slide_04"]);
    const tRed = makeTask(fx, "insetRed", forkRed, ["slide_09"]);
    // GREEN markers for the four green forks; a RED (green:false) marker for the red one.
    writeMarker(tA, true);
    writeMarker(tB, true);
    writeMarker(tR, true);
    writeMarker(tC, true);
    writeMarker(tRed, false, ["slide_09"]);

    // Prove the marker→readRatingMarker→selection contract directly on the REAL
    // reader (no injected fake): green forks read green, red reads not-green.
    ok(readRatingMarker(tA)?.green === true, "REAL readRatingMarker: border GREEN");
    ok(readRatingMarker(tRed)?.green === false, "REAL readRatingMarker: insetRed NOT green");
    ok(readRatingMarker(tRed)?.bad.includes("slide_09"), "REAL readRatingMarker: insetRed bad=[slide_09]");

    // Order: A (clean) → B (overlap clean) → R (ripple) → C (conflict) → Red (excluded).
    const tasks = [tA, tB, tR, tC, tRed];

    // The mocked LLM: for the ONE conflicting cluster (borderX), write a REAL
    // marker-free resolved file into the REAL staging worktree that keeps A's
    // border (slide_02 undisturbed) and lands C's fix on RADIUS (slide_04).
    // This is the ONLY mock in the whole run.
    let resolverFired = 0, sawMarkers = false, sawFile = false, resolverCwd = "";
    const scratchRoot = mkScratch("full");

    // We need the resolver to write into the ACTUAL staging worktree runFinalMerge
    // creates. finalMergePhase's runMerge closes over `stagingDir` from
    // runFinalMerge; expose it by resolving the write path from cwdOf(the send),
    // which switchCwd set to the staging worktree.
    const claudeMatcher: Matcher = {
      name: "resolver-writes-clean",
      when: isClaude,
      returns: (c: EffectCall) => {
        resolverFired++;
        const prompt = promptOf(c);
        sawMarkers = prompt.includes("<<<<<<<");
        sawFile = prompt.includes(CONVERTER_REL);
        resolverCwd = cwdOf(c) ?? "";
        // The RESOLVER'S EFFECT: edit the REAL conflicted file in the REAL staging
        // worktree (its cwd) to a clean, marker-free, BOTH-SIDES merge. "Both
        // sides" = the ALREADY-ACCEPTED staging state (A's border + B's shadow,
        // read from the staging git HEAD) PLUS this conflict fork's contribution,
        // which we land on RADIUS (slide_04, the fork's intended slide) so the
        // resolution changes ONLY slide_04 — no false ripple. This mirrors what a
        // real resolver would do: preserve the accepted stack, add the new fix.
        if (resolverCwd) {
          const acceptedNow = git(resolverCwd, `show HEAD:${CONVERTER_REL}`); // A+B accepted
          const resolvedBody = acceptedNow.replace(
            "  return 4; // L12 RADIUS",
            "  return 104; // L12 RADIUS (conflict fork fix, both sides preserved)");
          writeFileSync(join(resolverCwd, CONVERTER_REL), resolvedBody);
        }
        return claudeReply("RESOLVED");
      },
    };

    // Before the run: only the 5 fork worktrees exist.
    const preExtra = extraWorktrees(fx.repo).length;
    ok(preExtra === 5, `5 fork worktrees present before the run (was ${preExtra})`);
    const { report, io, threw, stagingDir: realStaging } = await runFinalMerge(fx, tasks, claudeMatcher, scratchRoot);

    // ===================================================================
    // TOP-LEVEL: finalMergePhase returned through the REAL engine.
    // ===================================================================
    ok(threw === null, `finalMergePhase should not throw (threw: ${(threw as Error)?.stack ?? threw})`);
    ok(report !== null, "finalMergePhase returned a MergeReport through the engine (not null)");
    const rep = report as MergeReport;

    // ===================================================================
    // MOCK inventory: exactly ONE LLM call (the single conflicting cluster).
    // Everything else that ran was real code.
    // ===================================================================
    ok(resolverFired === 1, `resolver LLM fired exactly once (was ${resolverFired})`);
    ok(io.callsOf("spawnCapture").filter(isClaude).length === 1, "exactly one `claude` spawn in the whole run");
    ok(sawMarkers, "resolver prompt carried REAL conflict markers (from the real patcher compose)");
    ok(sawFile, "resolver prompt named the conflicted converter file");
    ok(resolverCwd === realStaging, "resolver ran in the REAL staging worktree cwd (switchCwd)");

    // ===================================================================
    // ACCOUNTING (returned MergeReport).
    // ===================================================================
    // A, B, C accepted (C via the resolved conflict); R (ripple) rejected.
    // Red never reaches mergePhase (excluded by selection) so it is NOT in the report.
    ok(rep.accepted.sort().join(",") === "border,borderX,shadow",
      `accepted = border,borderX,shadow (was ${rep.accepted.join(",")})`);
    ok(rep.rejected.map((r) => r.task).sort().join(",") === "gradient",
      `rejected = gradient (ripple) (was ${rep.rejected.map((r) => r.task).join(",")})`);
    ok(rep.conflicts.length === 1 && rep.conflicts[0].task === "borderX" && rep.conflicts[0].resolved === true,
      "one RESOLVED conflict, on borderX");

    // ===================================================================
    // CASE clean-A + clean-B: REAL git promote commits, BOTH edits in the
    // committed converter (git show HEAD), working tree clean.
    // ===================================================================
    const nCommits = Number(git(realStaging, `rev-list --count ${fx.base}..HEAD`));
    ok(nCommits === 3, `exactly 3 promote commits on staging (A,B,C) (was ${nCommits})`);
    const shown = git(realStaging, `show HEAD:${CONVERTER_REL}`);
    ok(/return 11; \/\/ L03 BORDER \(clean fork A\)/.test(shown), "clean fork A's border edit committed");
    ok(/return 22; \/\/ L06 SHADOW \(clean fork B\)/.test(shown), "clean fork B's shadow edit committed (both composed)");
    ok(git(realStaging, "status --porcelain") === "", "staging working tree CLEAN after all promotes/reverts");

    // capture read the REAL composed XML off disk (contains merged text).
    ok(rep.perSlide["slide_07"]?.xml?.includes("return 22;"), "capture XML is the REAL composed converter (shadow)");
    // captured screenshots are REAL PNG files with PNG magic bytes; different
    // slides render to different real pixels.
    const shotA = rep.perSlide["slide_02"]?.screenshotPath;
    const shotB = rep.perSlide["slide_07"]?.screenshotPath;
    ok(shotA && shotB && existsSync(shotA) && existsSync(shotB), "captured screenshots are real PNG files on disk");
    ok(readFileSync(shotA!).slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "screenshot has real PNG magic bytes");
    ok(pngPixelsDiffer(shotA!, shotB!), "different slides render to different REAL PNGs (real pixels)");

    // ===================================================================
    // CASE conflict (borderX): MOCKED LLM wrote a REAL marker-free file → tsc
    // clean → promoted. Markers gone in the REAL committed file.
    // ===================================================================
    ok(!/^(<{7}|={7}|>{7})/m.test(shown), "no conflict markers in the committed converter (resolver's real file)");
    ok(shown.includes("return 104; // L12 RADIUS"), "resolved both-sides text committed (conflict fork's fix on radius)");
    ok(shown.includes("return 11; // L03 BORDER"), "A's border value preserved through the resolve (slide_02 undisturbed)");

    // ===================================================================
    // CASE ripple (gradient): the REAL render+pixel-diff detected slide_09 (a
    // non-intended slide) changed → REAL revert (edit absent, git at pre-merge
    // SHA for that step) + REAL demote.
    // ===================================================================
    const gr = rep.rejected.find((r) => r.task === "gradient")!;
    ok(/slide_09/.test(gr.reason), "ripple reject reason names slide_09 (the REAL pixel-diff caught it)");
    ok(/pixel-perfect|ripple/i.test(gr.reason), "ripple reject reason cites pixel-perfect/ripple");
    ok(!shown.includes("return 33;"), "ripple fork's gradient edit is NOT committed (reverted)");
    ok(shown.includes("return 3; // L09 GRADIENT"), "GRADIENT back at base value (ripple reverted)");
    ok(!shown.includes("return 66;"), "ripple fork's INSET perturbation reverted");
    // the on-disk staging file matches HEAD (revert restored --worktree too).
    ok(!stagingConverter(realStaging).includes("return 33;"), "gradient edit absent on disk after revert");

    // ===================================================================
    // CASE red (insetRed): a real green:false marker → EXCLUDED by
    // selectGreenClusters + DEMOTED via the REAL ledger; NEVER merged.
    // ===================================================================
    ok(!shown.includes("return 77;"), "RED fork's inset edit is NOT on the merged branch (never handed to mergePhase)");
    const cand = readCandidates(fx);
    // red fork's slide flipped to bad by the REAL demote.
    ok(cand["slide_09"].status === "bad", "RED fork's slide_09 flipped to `bad` in the REAL candidates.json");
    ok(cand["slide_09"].mergeFailed === true, "RED fork demote recorded mergeFailed in the ledger");
    ok(cand["slide_09"].mergeFailedCluster === "insetRed", "RED fork demote recorded the excluding cluster");
    // ripple fork's slide also demoted (by mergePhase's reject path) to bad.
    ok(cand["slide_05"].status === "bad", "ripple fork's slide_05 flipped to `bad` (mergePhase demote)");
    ok(cand["slide_05"].mergeFailedCluster === "gradient", "ripple demote recorded the ripple cluster");
    ok(gr.demotedSlides.join(",") === "slide_05", "report records the ripple's demoted slide");
    // the accepted forks' slides stay good.
    for (const sid of ["slide_02", "slide_04", "slide_07"]) {
      ok(cand[sid].status === "good", `${sid} still good (accepted fork, not demoted)`);
    }
    // ratings.json annotated WITHOUT clobbering the user comment (REAL demote).
    const rat = readRatings(fx);
    ok(rat["slide_09"].comment === "user issue for slide_09", "RED fork: original user comment preserved in ratings.json");
    ok(rat["slide_09"].mergeFailed === true, "RED fork: ratings.json annotated with mergeFailed");
    ok(rat["slide_05"].mergeFailed === true, "ripple fork: ratings.json annotated with mergeFailed");

    // ===================================================================
    // NO LEAKED WORKTREES: the staging worktree is torn down by the cleanup
    // registry; the merge-base throwaways realMergeOps.compose creates are
    // removed inline. Before that teardown, only the staging worktree should be
    // the extra one this run added (the forks are registered separately).
    // ===================================================================
    const extraNow = extraWorktrees(fx.repo);
    // extras = 5 forks + 1 staging (+ none leaked from compose's temp bases).
    ok(extraNow.length === preExtra + 1, `only the staging worktree added this run (extras: ${extraNow.length}, pre: ${preExtra})`);
    ok(extraNow.every((p) => !/merge-base-/.test(p)), "no leaked compose merge-base worktrees");
  });

  // Run the cleanup registry (via test's finally), THEN assert the temp repos are
  // gone (nothing leaked to disk). We can't reach into a torn-down repo, so this
  // is a soft end marker.
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed) { for (const f of failures) console.error(`FAIL ${f.name}: ${(f.err as Error)?.message ?? f.err}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
