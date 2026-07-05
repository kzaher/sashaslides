/**
 * merge-phase.integration.test.ts — a SERIOUS end-to-end integration test for
 * the bug_solving MERGE PHASE that runs against a REAL, throwaway git repository
 * on the filesystem.
 *
 * Unlike merge-phase.test.ts (which fakes EVERY MergeOps method), this test uses
 * the PRODUCTION `realMergeOps` so that:
 *   - COMPOSE   goes through the real git-agnostic patcher (computeChanges +
 *               applyChanges, real 3-way line merge) against a real base worktree,
 *   - PROMOTE   makes a real `git commit` on the staging worktree,
 *   - REVERT    does a real `git restore --source <preMergeRef> …`,
 *   - CAPTURE-XML/readStagingFile read the REAL composed file from disk,
 *   - DEMOTE    writes the REAL `.bug-solving-history/candidates.json` +
 *               `ratings.json` ledger files.
 *
 * The ONLY things mocked are the two side-effects that genuinely need Chrome +
 * the Google Slides upload/thumbnail path (and therefore cannot run hermetically):
 *   (a) the LLM (the conflict-resolver `send`), via MockIO canned `claude`
 *       replies — the resolver's file EDIT is performed by the matcher writing a
 *       resolved file to the real staging worktree, so the real markers-gone
 *       assert reads it back; and
 *   (b) `renderAndDiff` + `captureSlide` (render deck + structural pixel-diff +
 *       per-slide screenshot capture), injected via `realMergeOps`'s new
 *       `renderAndDiff`/`captureSlide`/`tscConverterErrors` override hooks —
 *       scripted per cluster (clean → changed==intended; ripple → changed
 *       includes an extra non-intended slide).
 *
 * Every OTHER effect is genuine filesystem/git behavior on a fresh temp repo
 * created under os.tmpdir() and torn down in afterEach.
 *
 * Cases exercised (one cluster each, in one folded merge run):
 *   - clean-independent (A): edits non-overlapping lines → composes + promotes.
 *   - overlap-clean     (B): edits DIFFERENT lines of the same file A touched →
 *                            3-way compose succeeds, BOTH changes land.
 *   - conflict          (C): edits the SAME lines as A → compose conflicts →
 *                            mocked resolver writes a resolved file → markers
 *                            gone → promotes.
 *   - resolver-fail     (D): conflicts, mocked resolver leaves markers → real
 *                            revert + real demote ledger write.
 *   - ripple            (E): composes clean but the mocked diff reports a changed
 *                            slide OUTSIDE E's intended set → discard + real
 *                            revert + real demote.
 *
 * A second block re-runs the clean + overlap cases with the cluster worktrees as
 * FULL-DISK COPIES (no git metadata) to exercise the git-agnostic patcher path.
 *
 * REFACTOR NOTE: to inject ONLY render/diff/screenshot while keeping git/fs/
 * patcher real, `RealMergeOpsDeps` gained three optional override hooks —
 * `renderAndDiff`, `captureSlide`, `tscConverterErrors`. When omitted (production)
 * the real record-rendering + diff-pptx-pairs + unzip + `npx tsc` paths run
 * unchanged. See merge-phase.ts.
 *
 * Run:  cd /workspaces/sashaslides && \
 *       npx tsx renderer/structured-prompts/bug_solving/merge-phase.integration.test.ts
 *
 * NO network, NO Chrome, NO Google, NO real solve. tsc clean.
 */
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeEngine, Session } from "../../../structured-prompting/src/index.js";
import {
  MockIO,
  type EffectCall,
  type Matcher,
  type SpawnCaptureArgs,
  type SpawnCaptureResult,
} from "../../../structured-prompting/src/server/io.js";
import {
  mergePhase,
  realMergeOps,
  type MergeCluster,
  type MergeReport,
} from "./merge-phase.js";
import { pngPixelsDiffer } from "./test-helpers/small-text-png.js";
import { renderDeck, realRenderAndDiff, renderSlideTextPngToFile } from "./test-helpers/fixture-render.js";

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];
const cleanups: Array<() => void> = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  cleanups.length = 0; // afterEach registry, reset per test
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, err: e });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${((e as Error)?.stack ?? String(e)).split("\n").slice(0, 10).join("\n      ")}`);
  } finally {
    // afterEach: run every registered cleanup even on failure.
    for (const c of cleanups.splice(0).reverse()) { try { c(); } catch { /* */ } }
  }
}
function afterEach(fn: () => void): void { cleanups.push(fn); }

/** A fresh scratch dir under os.tmpdir for a test's render/diff PNG artifacts,
 *  auto-cleaned in afterEach (even on failure). Keeps everything off /tmp fixed
 *  paths and hermetic per-test. */
function mkScratch(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `mp-int-scratch-${tag}-`));
  afterEach(() => { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } });
  return d;
}

// ---------------------------------------------------------------------------
// git helper (real, on the temp repo)
// ---------------------------------------------------------------------------
function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** The `sh(cmd, cwd)` shape realMergeOps expects (matches main.ts mergeSh). */
function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// ---------------------------------------------------------------------------
// MockIO reply builders (mirror merge-phase.test.ts)
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

/** Shared matchers: clock, log, the echo `bash` nodes, and the engine's per-node
 *  `git` diff-capture spawns (all ignored — the REAL git we care about is done
 *  synchronously via execSync in realMergeOps, NOT through the mocked IO). */
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
// Fixture: a real git repo with a converter source + fixtures + ledger seed.
// ---------------------------------------------------------------------------
const CONVERTER_REL = "renderer/html2slides/convert.ts";

/** The BASE converter file — a handful of numbered lines/functions the clusters
 *  edit at different regions to drive the compose/conflict matrix. */
const BASE_CONVERTER = [
  "// convert.ts — fake converter for the merge integration test",
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

interface Fixture {
  repo: string;
  base: string;         // the fork BASE commit SHA
  fixturesDir: string;  // repo-absolute deck dir
  historyDir: string;   // .bug-solving-history
  cleanup: () => void;
}

// ---------------------------------------------------------------------------
// CHANGE 1 — realistic populated ledger + accept-state (Cls/Status, State/Cluster,
// classify) — the green/red classification convention the accept phase uses.
//
// The seed is NOT an empty ledger: it carries BOTH already-APPROVED (good/green)
// and already-DENIED (bad/red) entries, plus one unrated (neutral) slide, so
// classification starts from a populated approved/denied structure. A local
// re-implementation of the classify() convention reads the seeded files
// back and proves the green cluster classifies green/approved and the red one
// red/denied — asserted at the START of every test, BEFORE the merge fold runs.
// ---------------------------------------------------------------------------

/** Green = all good, red = any bad,
 *  neutral = any unrated / none). */
type SeedCls = "green" | "red" | "neutral";
/** Per-cluster accept status. */
type SeedStatus = "pending" | "in_review" | "accepted" | "rejected" | "conflict_resolved";

/** A seeded cluster (the fields we seed). */
interface SeedCluster {
  task: string;
  dir: string;
  slides: string[];
  status: SeedStatus;
  changed?: string[];
  intended?: string[];
  ripple?: string[];
  preMergeCommit?: string;
}
/** The seeded accept-state. */
interface SeedState {
  ts: string;
  base: string;
  target: string;
  stagingDir: string;
  stagingBranch: string;
  clusters: Record<string, SeedCluster>;
}

/** The seeded candidate ledger: slide-id → {status, comment}. Approved slides are
 *  `good`, a denied slide is `bad`, one is left unrated (no status = neutral).
 *  The DENIED (slide_08) and NEUTRAL (slide_11) demonstration slides are
 *  deliberately OUTSIDE the merge deck (slide_02/04/05/07/09) so the populated
 *  approved/denied structure is real WITHOUT perturbing the fold's demote
 *  accounting; every deck slide starts `good` (all green clusters). */
const SEED_CANDIDATES: Record<string, { status?: string; comment: string }> = {
  // APPROVED (green) — the merge fold's deck slides (all green clusters).
  slide_02: { status: "good", comment: "user issue for slide_02" },
  slide_04: { status: "good", comment: "user issue for slide_04" },
  slide_05: { status: "good", comment: "user issue for slide_05" },
  slide_07: { status: "good", comment: "user issue for slide_07" },
  slide_09: { status: "good", comment: "user issue for slide_09" },
  // DENIED (red, off-deck) — a slide the user rated bad; its cluster is red/denied
  // and must NOT be promoted by the merge fold.
  slide_08: { status: "bad", comment: "user issue for slide_08 (regressed)" },
  // UNRATED (neutral, off-deck) — no status ⇒ classify() → neutral (ignored).
  slide_11: { comment: "user issue for slide_11 (not yet rated)" },
};

/** The seeded accept-state: a REALISTIC populated approved/denied structure with
 *  one `accepted` cluster and one `rejected` cluster (real Status values). */
function seedAcceptState(base: string, stagingDir: string): SeedState {
  return {
    ts: "1700000000",
    base,
    target: "main",
    stagingDir,
    stagingBranch: "sp/accept-seed",
    clusters: {
      // already ACCEPTED (approved/green, previously landed).
      "approved-border": {
        task: "approved-border", dir: join(stagingDir, "..", "wt-approved"),
        slides: ["slide_02"], status: "accepted",
        changed: ["slide_02"], intended: ["slide_02"], ripple: [], preMergeCommit: base,
      },
      // already REJECTED (denied/red).
      "denied-inset": {
        task: "denied-inset", dir: join(stagingDir, "..", "wt-denied"),
        slides: ["slide_08"], status: "rejected",
        changed: ["slide_08"], intended: ["slide_08"], ripple: [], preMergeCommit: base,
      },
    },
  };
}

/** Local re-implementation of the green/red classify() semantics for a
 *  set of slides against the seeded candidates.json: green iff every slide good,
 *  red iff any bad, neutral iff any unrated (and none bad) — read from disk. */
function classifyCluster(historyDir: string, slides: string[]): { cls: SeedCls; bad: string[]; missing: string[] } {
  const ledger: Record<string, { status?: string }> =
    JSON.parse(readFileSync(join(historyDir, "candidates.json"), "utf8"));
  const bad = slides.filter((s) => ledger[s]?.status === "bad");
  const missing = slides.filter((s) => !ledger[s]?.status);
  const cls: SeedCls = bad.length ? "red" : missing.length ? "neutral" : slides.length ? "green" : "neutral";
  return { cls, bad, missing };
}

let fixtureCounter = 0;
function makeFixtureRepo(tag: string): Fixture {
  const repo = mkdtempSync(join(tmpdir(), `mp-int-${tag}-${fixtureCounter++}-`));
  const cleanup = () => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* */ } };

  git(repo, "init -q -b main");
  git(repo, "config user.email test@merge.local");
  git(repo, "config user.name merge-integration-test");
  git(repo, "config commit.gpgsign false");

  // converter source
  mkdirSync(join(repo, "renderer/html2slides"), { recursive: true });
  writeFileSync(join(repo, CONVERTER_REL), BASE_CONVERTER);

  // a small fixture deck (a couple of slides)
  const fixturesDir = join(repo, "renderer/html2slides/e2e/fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  for (const sid of ["slide_02", "slide_04", "slide_05", "slide_07", "slide_09"]) {
    writeFileSync(join(fixturesDir, `${sid}.html`), `<html><body>${sid}</body></html>`);
  }

  // CHANGE 1: seed a REALISTIC populated ledger — approved (good) + denied (bad)
  // + one unrated (neutral) — plus a real accept-state.json with an `accepted`
  // and a `rejected` cluster (the accept State/Status shapes).
  const historyDir = join(repo, ".bug-solving-history");
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(join(historyDir, "candidates.json"), JSON.stringify(SEED_CANDIDATES, null, 2));
  writeFileSync(join(historyDir, "ratings.json"), JSON.stringify(
    Object.fromEntries(Object.entries(SEED_CANDIDATES).map(([sid, v]) => [sid, { comment: v.comment }])), null, 2));
  // accept-state.json — populated approved/denied structure. stagingDir is a
  // realistic worktree path under .claude/worktrees.
  const seedStagingDir = join(repo, ".claude/worktrees", "accept-seed");
  writeFileSync(join(historyDir, "accept-state.json"),
    JSON.stringify(seedAcceptState("SEED_BASE", seedStagingDir), null, 2));

  // worktrees dir realMergeOps.compose materialises the throwaway base into.
  mkdirSync(join(repo, ".claude/worktrees"), { recursive: true });

  git(repo, "add -A");
  git(repo, "commit -q -m base");
  const base = git(repo, "rev-parse HEAD");
  return { repo, base, fixturesDir, historyDir, cleanup };
}

/** Create the accumulating staging worktree forked off base. */
function makeStaging(fx: Fixture, tag: string): { stagingDir: string; branch: string; remove: () => void } {
  const branch = `sp/staging-${tag}-${fixtureCounter}`;
  const stagingDir = join(fx.repo, ".claude/worktrees", `staging-${tag}-${fixtureCounter}`);
  git(fx.repo, `worktree add -q -b ${branch} "${stagingDir}" ${fx.base}`);
  const remove = () => {
    try { git(fx.repo, `worktree remove --force "${stagingDir}"`); } catch { /* */ }
    try { git(fx.repo, `branch -D ${branch}`); } catch { /* */ }
  };
  return { stagingDir, branch, remove };
}

/**
 * Build a cluster worktree that edits the converter file. `variant`:
 *   "git"  → real `git worktree add` off base, then edit + commit.
 *   "copy" → full-disk copy of the base tree (no git metadata) + edit.
 * `edit` transforms the BASE converter text into the cluster's modified text.
 */
function makeClusterDir(
  fx: Fixture, task: string, variant: "git" | "copy", edit: (base: string) => string,
): { dir: string; remove: () => void } {
  if (variant === "git") {
    const branch = `sp/wt-${task}-${fixtureCounter}`;
    const dir = join(fx.repo, ".claude/worktrees", `wt-${task}-${fixtureCounter}`);
    git(fx.repo, `worktree add -q -b ${branch} "${dir}" ${fx.base}`);
    writeFileSync(join(dir, CONVERTER_REL), edit(BASE_CONVERTER));
    git(dir, "add -A");
    git(dir, "commit -q -m " + task);
    return {
      dir,
      remove: () => {
        try { git(fx.repo, `worktree remove --force "${dir}"`); } catch { /* */ }
        try { git(fx.repo, `branch -D ${branch}`); } catch { /* */ }
      },
    };
  }
  // full-disk copy (git-agnostic path)
  const dir = mkdtempSync(join(tmpdir(), `mp-copy-${task}-`));
  cpSync(join(fx.repo, "renderer"), join(dir, "renderer"), { recursive: true });
  writeFileSync(join(dir, CONVERTER_REL), edit(BASE_CONVERTER));
  return { dir, remove: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } } };
}

// Line-level edits (non-overlapping vs overlapping) on BASE_CONVERTER.
const editBorder = (s: string) => s.replace("  return 1; // L03 BORDER", "  return 11; // L03 BORDER (cluster A/C)");
const editShadow = (s: string) => s.replace("  return 2; // L06 SHADOW", "  return 22; // L06 SHADOW (cluster B)");
const editBorderAlt = (s: string) => s.replace("  return 1; // L03 BORDER", "  return 99; // L03 BORDER (cluster C conflicting)");
// RIPPLE ENGINEERING (CHANGE 2): the gradient cluster is SUPPOSED to only touch
// GRADIENT (L09 → slide_05, its intended slide). But its edit ALSO rewrites the
// INSET value (L15), which the deck's slide_09 renders. Because each slide's PNG
// text is derived LIVE from the converter's current feature values, perturbing
// INSET makes slide_09's rendered PNG genuinely differ from baseline — so the
// REAL pixel-diff (not a scripted list) detects the extra, non-intended slide and
// the merge phase reverts+demotes the cluster as a ripple regression.
const editGradient = (s: string) =>
  s.replace("  return 3; // L09 GRADIENT", "  return 33; // L09 GRADIENT (cluster E)")
   .replace("  return 5; // L15 INSET", "  return 66; // L15 INSET (rippled by cluster E)");
const editRadius = (s: string) => s.replace("  return 4; // L12 RADIUS", "  return 44; // L12 RADIUS (cluster D)");

// ---------------------------------------------------------------------------
// Run mergePhase against a MockIO with REAL realMergeOps (render/diff mocked).
// ---------------------------------------------------------------------------
interface RunOpts {
  fx: Fixture;
  stagingDir: string;
  clusters: MergeCluster[];
  claudeMatchers: Matcher[];
  scratchRoot: string;
}
async function runPhase(opts: RunOpts): Promise<{ report: MergeReport | undefined; io: MockIO; threw: unknown }> {
  const { fx, stagingDir, clusters } = opts;

  // The fixture deck (slide ids) the render service rasterises.
  const deckIds = ["slide_02", "slide_04", "slide_05", "slide_07", "slide_09"];
  // Where the render service writes real PNGs (baseline + per-cluster post dirs).
  const pngRoot = join(opts.scratchRoot, "pngs");

  // CHANGE 2 — a REAL local small-text render service (offline pngjs 5x7 bitmap
  // font; no Chrome, no Google, no network). Each slide's rendered PNG is derived
  // from its bound converter FEATURE value read LIVE off the staging tree, so an
  // edit that changes a feature's value genuinely changes that slide's pixels and
  // leaves the others byte-identical. renderAndDiff computes `changed` from an
  // ACTUAL per-slide PNG pixel compare — not a scripted list.
  //
  // BASELINE = the ACCEPTED-STATE converter = the staging worktree's committed
  // HEAD (promote commits it; revert restores to it). Comparing the post-compose
  // working tree against `git show HEAD` gives exactly "what THIS cluster's
  // compose changed vs. the accepted state" — so prior clusters' already-promoted
  // edits never masquerade as this cluster's ripple in the fold.
  const acceptedStateConverter = (): string => {
    try { return git(stagingDir, `show HEAD:${CONVERTER_REL}`); } catch { return BASE_CONVERTER; }
  };
  const currentConverter = (): string => {
    try { return readFileSync(join(stagingDir, CONVERTER_REL), "utf8"); } catch { return ""; }
  };

  // REAL ops for everything except the render/diff/capture side-effects (which in
  // production need Chrome + the Google Slides upload/thumbnail path) + tsc.
  const ops = realMergeOps({
    repo: fx.repo,
    base: fx.base,
    staging: stagingDir,
    fixturesDir: fx.fixturesDir,
    sh,
    historyDir: fx.historyDir,
    // REAL render + pixel-diff. `baselineDir===null` renders the accepted-state
    // baseline PNGs once. Per-cluster, we (re)render the accepted-state baseline
    // (git HEAD) AND the post-compose deck (working tree), then diff pixel-by-
    // pixel — the changed set is computed from real PNG bytes.
    renderAndDiff: (baselineDir, outDir) => {
      if (baselineDir === null) {
        renderDeck(acceptedStateConverter(), deckIds, join(pngRoot, "baseline"));
        return [];
      }
      // rolling accepted-state baseline (per-cluster; reflects prior promotes).
      renderDeck(acceptedStateConverter(), deckIds, join(pngRoot, "baseline"));
      const postDir = join(pngRoot, `post-${outDir.split("post-")[1] ?? "x"}`);
      return realRenderAndDiff(currentConverter, deckIds, join(pngRoot, "baseline"), postDir);
    },
    // REAL screenshot capture: render the just-accepted slide's PNG to disk and
    // point at it, plus read the REAL composed converter off disk as the "xml"
    // (proves the merged text actually landed in the staging tree).
    captureSlide: (sid) => {
      const shotDir = join(pngRoot, "captures");
      mkdirSync(shotDir, { recursive: true });
      const shot = join(shotDir, `${sid}.png`);
      renderSlideTextPngToFile(currentConverter(), sid, shot);
      let xml: string | null = null;
      try { xml = readFileSync(join(stagingDir, CONVERTER_REL), "utf8"); } catch { /* */ }
      return { screenshotPath: shot, xml };
    },
    // MOCK tsc — the fixture is not a real tsc project; the gate is not under
    // test here (the resolver-fail case is driven by markers-remaining).
    tscConverterErrors: () => 0,
  });

  const io = new MockIO({ matchers: [...baseMatchers(), ...opts.claudeMatchers] });
  const engine = new ClaudeEngine({ io, persist: false, hookSignals: false, log: false, port: 0 });
  let report: MergeReport | undefined;
  let threw: unknown = null;
  try {
    report = await engine.execute(
      new Session({ sessionId: "merge-int", cwd: fx.repo }),
      (s) => mergePhase(s, {
        clusters,
        base: fx.base,
        staging: stagingDir,
        fixturesDir: fx.fixturesDir,
        resolveModel: "opus",
        ops,
        scratchRoot: opts.scratchRoot,
      }),
    );
  } catch (e) { threw = e; }
  finally { await engine.shutdown(); }
  return { report, io, threw };
}

// Convenience: read the converter file from a committed staging ref or worktree.
function stagingConverter(stagingDir: string): string {
  return readFileSync(join(stagingDir, CONVERTER_REL), "utf8");
}
function readCandidates(fx: Fixture): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(fx.historyDir, "candidates.json"), "utf8"));
}
function readAcceptState(fx: Fixture): SeedState {
  return JSON.parse(readFileSync(join(fx.historyDir, "accept-state.json"), "utf8"));
}

/**
 * CHANGE 1 — start-of-test assertion. Reads the seeded ledger + accept-state
 * BACK off disk and proves the populated approved/denied structure classifies
 * correctly BEFORE the merge fold runs:
 *   - the seeded candidates carry BOTH good (approved) and bad (denied) entries
 *     plus one unrated (neutral) slide;
 *   - a green cluster (all-good slides) classifies green/approved;
 *   - a red cluster (any-bad slide) classifies red/denied;
 *   - the accept-state has an `accepted` cluster AND a `rejected` cluster.
 * The merge fold below then operates on the green/approved clusters; a denied
 * cluster is never handed to it.
 */
function assertSeededStructure(fx: Fixture): void {
  // real files exist on disk under the temp repo.
  assert.ok(existsSync(join(fx.historyDir, "candidates.json")), "candidates.json seeded on disk");
  assert.ok(existsSync(join(fx.historyDir, "accept-state.json")), "accept-state.json seeded on disk");
  assert.ok(existsSync(join(fx.historyDir, "ratings.json")), "ratings.json seeded on disk");

  // candidates.json carries BOTH approved and denied (not an empty ledger).
  const cand = readCandidates(fx);
  assert.equal(cand["slide_02"].status, "good", "seed: slide_02 approved (good)");
  assert.equal(cand["slide_08"].status, "bad", "seed: slide_08 denied (bad)");
  assert.equal(cand["slide_11"]?.status, undefined, "seed: slide_11 unrated (neutral)");

  // classify a green cluster (all-good) and a red cluster (any-bad) from disk.
  const green = classifyCluster(fx.historyDir, ["slide_02", "slide_04"]);
  assert.equal(green.cls, "green", "an all-good cluster classifies GREEN (approved) at start");
  assert.equal(green.bad.length, 0, "green cluster has no bad slides");
  const red = classifyCluster(fx.historyDir, ["slide_08"]);
  assert.equal(red.cls, "red", "a bad-slide cluster classifies RED (denied) at start");
  assert.deepEqual(red.bad, ["slide_08"], "red cluster's denied slide identified");
  const neutral = classifyCluster(fx.historyDir, ["slide_11"]);
  assert.equal(neutral.cls, "neutral", "an unrated cluster classifies NEUTRAL at start");

  // accept-state has a populated approved/denied structure (accepted + rejected).
  const st = readAcceptState(fx);
  const statuses = Object.values(st.clusters).map((c) => c.status).sort();
  assert.deepEqual(statuses, ["accepted", "rejected"], "accept-state seeds one accepted + one rejected cluster");
  const accepted = Object.values(st.clusters).find((c) => c.status === "accepted");
  const rejected = Object.values(st.clusters).find((c) => c.status === "rejected");
  assert.equal(accepted?.slides[0], "slide_02", "the accepted cluster owns the approved slide");
  assert.equal(rejected?.slides[0], "slide_08", "the rejected cluster owns the denied slide");
  // the denied cluster's slide is bad in candidates ⇒ it would NOT be promoted.
  assert.equal(cand[rejected!.slides[0]].status, "bad", "denied cluster's slide is bad ⇒ not promotable");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function main() {
  console.log("\nmerge-phase INTEGRATION tests (REAL git/fs/patcher; only LLM + render/diff mocked)\n");

  const C = (task: string, dir: string, slides: string[]): MergeCluster => ({ task, dir, slides });

  // (A+B) clean-independent + overlap-clean fold, git-worktree cluster dirs.
  // A edits L03 (border), B edits L06 (shadow) — different lines, same file.
  // Both must compose + promote; the FINAL staging tree carries BOTH edits.
  await test("(A+B) clean-independent + overlap-clean [git worktrees] → both promoted, both edits land", async () => {
    const fx = makeFixtureRepo("ab"); afterEach(fx.cleanup);
    assertSeededStructure(fx); // CHANGE 1: populated approved/denied structure classifies before the fold.
    const st = makeStaging(fx, "ab"); afterEach(st.remove);
    const A = makeClusterDir(fx, "border", "git", editBorder); afterEach(A.remove);
    const B = makeClusterDir(fx, "shadow", "git", editShadow); afterEach(B.remove);
    const clusters = [C("border", A.dir, ["slide_02"]), C("shadow", B.dir, ["slide_07"])];

    const preHead = git(st.stagingDir, "rev-parse HEAD");
    const scratchRoot = mkScratch("ab");
    const { report, threw } = await runPhase({
      fx, stagingDir: st.stagingDir, clusters, scratchRoot,
      claudeMatchers: [{ name: "no-claude", when: isClaude, returns: claudeReply("SHOULD-NOT-FIRE"), optional: true }],
    });
    assert.equal(threw, null, "phase should not throw");
    assert.deepEqual(report!.accepted, ["border", "shadow"], "both clusters accepted");
    assert.equal(report!.rejected.length, 0, "no rejects");

    // REAL git: two new commits on staging (one promote per cluster).
    const head = git(st.stagingDir, "rev-parse HEAD");
    assert.notEqual(head, preHead, "staging HEAD advanced (real commits)");
    const nCommits = Number(git(st.stagingDir, `rev-list --count ${preHead}..HEAD`));
    assert.equal(nCommits, 2, "exactly two promote commits");

    // REAL fs: the committed converter carries BOTH the border and shadow edits.
    const final = stagingConverter(st.stagingDir);
    assert.ok(/return 11; \/\/ L03 BORDER \(cluster A\/C\)/.test(final), "border edit landed");
    assert.ok(/return 22; \/\/ L06 SHADOW \(cluster B\)/.test(final), "shadow edit landed (both composed)");
    // and via `git show` of HEAD blob — proving it's committed, not just on disk.
    const shown = git(st.stagingDir, `show HEAD:${CONVERTER_REL}`);
    assert.ok(shown.includes("return 11;") && shown.includes("return 22;"), "git show HEAD has both edits");

    // working tree clean.
    assert.equal(git(st.stagingDir, "status --porcelain"), "", "staging working tree clean after promotes");

    // capture read the REAL composed XML (contains merged text).
    assert.ok(report!.perSlide["slide_07"]?.xml?.includes("return 22;"), "captured XML is the real composed file");

    // CHANGE 2: capture points at a REAL rendered PNG file (not a fake path), and
    // the two accepted slides' PNGs genuinely differ (different feature values).
    const shotA = report!.perSlide["slide_02"]!.screenshotPath!;
    const shotB = report!.perSlide["slide_07"]!.screenshotPath!;
    assert.ok(existsSync(shotA) && existsSync(shotB), "captured screenshots are real PNG files on disk");
    assert.ok(readFileSync(shotA).slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "screenshot is a real PNG (magic bytes)");
    assert.ok(pngPixelsDiffer(shotA, shotB), "different slides render to different PNGs (real pixels)");

    // clean accepts → NO demotion; ledger untouched (all still good).
    const cand = readCandidates(fx);
    for (const sid of ["slide_02", "slide_07"]) assert.equal(cand[sid].status, "good", `${sid} still good (not demoted)`);
  });

  // (C) conflict → resolver (mock) writes a resolved file → markers gone → promote.
  // Cluster A edits L03, then cluster C ALSO edits L03 (different value) → the
  // 3-way compose onto A's staging state conflicts. The mocked resolver writes a
  // both-sides-clean file into the REAL staging worktree; the REAL markers-gone
  // assert reads it and passes.
  await test("(C) conflict → mocked resolver writes real resolved file → markers gone → promoted", async () => {
    const fx = makeFixtureRepo("c"); afterEach(fx.cleanup);
    assertSeededStructure(fx); // CHANGE 1
    const st = makeStaging(fx, "c"); afterEach(st.remove);
    const A = makeClusterDir(fx, "border", "git", editBorder); afterEach(A.remove);
    const Cc = makeClusterDir(fx, "borderX", "git", editBorderAlt); afterEach(Cc.remove);
    // C's intended slide is slide_04 (bound to RADIUS). The both-sides resolution
    // KEEPS A's border value (so slide_02 = BORDER stays byte-identical to the
    // accepted baseline — no false ripple) and lands C's contribution on RADIUS,
    // which is exactly what slide_04 renders. So the REAL pixel-diff sees only
    // slide_04 change ⇒ intended, no ripple ⇒ promote.
    const clusters = [C("border", A.dir, ["slide_02"]), C("borderX", Cc.dir, ["slide_04"])];

    let resolverFired = 0; let sawMarkers = false; let sawFile = false; let resolverCwd = "";
    // Resolved body: BORDER preserved at A's 11 (slide_02 unchanged); C's fix
    // applied to RADIUS 4→104 (slide_04 changes = its intended slide). Marker-free.
    const resolvedBody = editBorder(BASE_CONVERTER).replace(
      "  return 4; // L12 RADIUS",
      "  return 104; // L12 RADIUS (cluster C's fix, both sides preserved)");
    const scratchRoot = mkScratch("c");
    const { report, io, threw } = await runPhase({
      fx, stagingDir: st.stagingDir, clusters, scratchRoot,
      claudeMatchers: [{
        name: "resolver-writes-clean",
        when: isClaude,
        returns: (c: EffectCall) => {
          resolverFired++;
          const prompt = promptOf(c);
          sawMarkers = prompt.includes("<<<<<<<");
          sawFile = prompt.includes(CONVERTER_REL);
          resolverCwd = cwdOf(c) ?? "";
          // The RESOLVER'S EFFECT: edit the real conflicted file in the staging
          // worktree to a clean, marker-free both-sides merge.
          writeFileSync(join(st.stagingDir, CONVERTER_REL), resolvedBody);
          return claudeReply("RESOLVED");
        },
      }],
    });

    assert.equal(threw, null, "phase should not throw");
    assert.equal(resolverFired, 1, "resolver LLM invoked exactly once (only the conflicting cluster)");
    assert.equal(io.callsOf("spawnCapture").filter(isClaude).length, 1, "one claude spawn");
    assert.ok(sawMarkers, "resolver prompt carried the conflict markers");
    assert.ok(sawFile, "resolver prompt named the conflicted converter file");
    assert.equal(resolverCwd, st.stagingDir, "resolver ran in the staging worktree cwd (switchCwd)");

    assert.deepEqual(report!.accepted, ["border", "borderX"], "both accepted (conflict resolved)");
    assert.equal(report!.conflicts.length, 1, "one conflict recorded");
    assert.equal(report!.conflicts[0].task, "borderX", "the conflict was on cluster C (borderX)");
    assert.equal(report!.conflicts[0].resolved, true, "conflict marked resolved");

    // REAL git/fs: committed converter is marker-free and holds the resolved text.
    const shown = git(st.stagingDir, `show HEAD:${CONVERTER_REL}`);
    assert.ok(!/^(<{7}|={7}|>{7})/m.test(shown), "no conflict markers in committed file");
    assert.ok(shown.includes("return 104; // L12 RADIUS"), "resolved both-sides text committed (A's border kept, C's fix on radius)");
    assert.ok(shown.includes("return 11; // L03 BORDER"), "A's border value preserved (slide_02 undisturbed)");
    assert.equal(git(st.stagingDir, "status --porcelain"), "", "working tree clean after resolve+promote");
    const cand = readCandidates(fx);
    assert.equal(cand["slide_04"].status, "good", "resolved cluster's slide NOT demoted");
  });

  // (D) resolver-fail: conflict, mocked resolver LEAVES markers → real revert to
  // pre-merge ref + real demote ledger write.
  await test("(D) resolver-fail (markers remain) → REAL revert to pre-merge SHA + REAL demote ledger", async () => {
    const fx = makeFixtureRepo("d"); afterEach(fx.cleanup);
    assertSeededStructure(fx); // CHANGE 1
    const st = makeStaging(fx, "d"); afterEach(st.remove);
    // A lands cleanly first; D conflicts with A on L03 and the resolver fails.
    const A = makeClusterDir(fx, "border", "git", editBorder); afterEach(A.remove);
    const D = makeClusterDir(fx, "borderBad", "git", editBorderAlt); afterEach(D.remove);
    const clusters = [C("border", A.dir, ["slide_02"]), C("borderBad", D.dir, ["slide_04"])];

    // Capture the pre-merge SHA of D — the state AFTER A promoted, BEFORE D's
    // compose — by first running A alone is complex; instead we assert the final
    // HEAD equals the SHA right after A's promote (which realMergeOps records as
    // D's preMergeRef and reverts to). We derive it from the report/commit graph.
    let markerCwd = "";
    const scratchRoot = mkScratch("d");
    const { report, threw } = await runPhase({
      fx, stagingDir: st.stagingDir, clusters, scratchRoot,
      claudeMatchers: [{
        name: "resolver-leaves-markers",
        when: isClaude,
        returns: (c: EffectCall) => {
          markerCwd = cwdOf(c) ?? "";
          // resolver "fails": leave the marker-laden file exactly as composed.
          return claudeReply("FAILED: cannot merge these both-sides changes");
        },
      }],
    });

    assert.equal(threw, null, "phase should not throw (reject is controlled)");
    assert.equal(markerCwd, st.stagingDir, "resolver ran in staging cwd");
    assert.deepEqual(report!.accepted, ["border"], "only the clean cluster accepted");
    assert.equal(report!.rejected.length, 1, "one reject");
    assert.equal(report!.rejected[0].task, "borderBad", "borderBad rejected");
    assert.ok(/FAILED|marker|conflict/i.test(report!.rejected[0].reason), "reject reason cites the conflict failure");
    assert.equal(report!.conflicts.find((x) => x.task === "borderBad")?.resolved, false, "conflict recorded UNresolved");

    // REAL git: HEAD is the commit made by A's promote (D reverted). Prove it by
    // (a) working tree clean and (b) the committed converter contains A's edit
    // but NOT D's conflicting value NOR any markers.
    assert.equal(git(st.stagingDir, "status --porcelain"), "", "working tree clean after real revert");
    const shown = git(st.stagingDir, `show HEAD:${CONVERTER_REL}`);
    assert.ok(shown.includes("return 11;"), "A's edit still present (A was accepted)");
    assert.ok(!shown.includes("return 99;"), "D's conflicting edit is GONE (reverted)");
    assert.ok(!/^(<{7}|={7}|>{7})/m.test(shown), "no conflict markers remain in committed file");
    // the on-disk worktree matches HEAD (revert restored --worktree too).
    assert.ok(!/^(<{7}|={7}|>{7})/m.test(stagingConverter(st.stagingDir)), "no markers in the working-tree file either");
    assert.ok(!stagingConverter(st.stagingDir).includes("return 99;"), "D's edit not on disk after revert");

    // Only ONE commit past base (A's promote); D produced no commit.
    const nCommits = Number(git(st.stagingDir, `rev-list --count ${fx.base}..HEAD`));
    assert.equal(nCommits, 1, "exactly one promote commit (A); the rejected D did not commit");

    // REAL demote ledger: slide_04 flipped to bad (a loss the next round re-solves).
    const cand = readCandidates(fx);
    assert.equal(cand["slide_04"].status, "bad", "ledger marks the rejected cluster's slide as bad");
    assert.equal(cand["slide_04"].mergeFailed, true, "ledger records mergeFailed");
    assert.equal(cand["slide_04"].mergeFailedCluster, "borderBad", "ledger records the failing cluster");
    // the accepted cluster's slide stays good.
    assert.equal(cand["slide_02"].status, "good", "accepted cluster's slide untouched in ledger");
    // ratings.json annotated WITHOUT clobbering the user's comment.
    const ratings = JSON.parse(readFileSync(join(fx.historyDir, "ratings.json"), "utf8"));
    assert.equal(ratings["slide_04"].comment, "user issue for slide_04", "original user comment preserved");
    assert.equal(ratings["slide_04"].mergeFailed, true, "ratings annotated with mergeFailed");
    // report accounting matches.
    assert.deepEqual(report!.rejected[0].demotedSlides, ["slide_04"], "report records demoted slides");
  });

  // (E) ripple: composes CLEAN but the mocked diff reports a changed slide OUTSIDE
  // E's intended set → discard + real revert + real demote.
  await test("(E) ripple (clean compose, diff reports non-intended slide) → REAL revert + REAL demote", async () => {
    const fx = makeFixtureRepo("e"); afterEach(fx.cleanup);
    assertSeededStructure(fx); // CHANGE 1
    const st = makeStaging(fx, "e"); afterEach(st.remove);
    const E = makeClusterDir(fx, "gradient", "git", editGradient); afterEach(E.remove);
    const clusters = [C("gradient", E.dir, ["slide_05"])];

    const preHead = git(st.stagingDir, "rev-parse HEAD");
    const scratchRoot = mkScratch("e");
    const { report, threw, io } = await runPhase({
      fx, stagingDir: st.stagingDir, clusters, scratchRoot,
      // editGradient composes CLEAN (no git conflict) but genuinely perturbs BOTH
      // GRADIENT (slide_05, intended) AND INSET (slide_09, NON-intended). The REAL
      // pixel-diff renders both slides different from baseline ⇒ slide_09 is a
      // detected ripple ⇒ revert + demote. No scripted changed-set.
      claudeMatchers: [{ name: "no-claude", when: isClaude, returns: claudeReply("x"), optional: true }],
    });

    assert.equal(threw, null, "phase should not throw");
    assert.equal(io.callsOf("spawnCapture").filter(isClaude).length, 0, "clean compose ⇒ NO resolver send");
    assert.deepEqual(report!.accepted, [], "nothing accepted (rippled)");
    assert.equal(report!.rejected.length, 1, "one reject");
    assert.equal(report!.rejected[0].task, "gradient");
    assert.ok(/slide_09/.test(report!.rejected[0].reason), "reject reason names the rippled slide (real pixel-diff caught it)");
    assert.ok(/pixel-perfect|ripple/i.test(report!.rejected[0].reason), "reject reason cites pixel-perfect/ripple");

    // REAL git: staging HEAD unchanged (no promote), working tree clean, and the
    // committed AND on-disk converter does NOT contain E's edit (reverted).
    assert.equal(git(st.stagingDir, "rev-parse HEAD"), preHead, "staging HEAD unchanged (no promote)");
    assert.equal(git(st.stagingDir, "status --porcelain"), "", "working tree clean after ripple revert");
    const shown = git(st.stagingDir, `show HEAD:${CONVERTER_REL}`);
    assert.ok(!shown.includes("return 33;"), "gradient edit is NOT committed");
    assert.ok(!stagingConverter(st.stagingDir).includes("return 33;"), "gradient edit reverted off disk too");
    assert.ok(stagingConverter(st.stagingDir).includes("return 3; // L09 GRADIENT"), "L09 back to base value");

    // REAL demote ledger: slide_05 → bad.
    const cand = readCandidates(fx);
    assert.equal(cand["slide_05"].status, "bad", "ripple-rejected cluster's slide demoted to bad");
    assert.equal(cand["slide_05"].mergeFailedCluster, "gradient", "ledger records the ripple cluster");
    assert.deepEqual(report!.rejected[0].demotedSlides, ["slide_05"], "report records demoted slides");
  });

  // (F) FULL matrix in ONE folded run + git-agnostic COPY cluster dirs. Exercises
  // ordering + idempotency: A(clean)→B(overlap-clean)→D(conflict-fail)→E(ripple),
  // with the cluster dirs as full-disk COPIES (no git) to drive the git-agnostic
  // patcher path. Asserts the final accounting + on-disk truth for the whole fold.
  await test("(F) full fold [disk-copy clusters, git-agnostic patcher]: clean+overlap promoted, conflict-fail+ripple reverted", async () => {
    const fx = makeFixtureRepo("f"); afterEach(fx.cleanup);
    assertSeededStructure(fx); // CHANGE 1
    const st = makeStaging(fx, "f"); afterEach(st.remove);
    const A = makeClusterDir(fx, "border", "copy", editBorder); afterEach(A.remove);
    const B = makeClusterDir(fx, "shadow", "copy", editShadow); afterEach(B.remove);
    const D = makeClusterDir(fx, "borderBad", "copy", editBorderAlt); afterEach(D.remove);
    const E = makeClusterDir(fx, "gradient", "copy", editGradient); afterEach(E.remove);
    const clusters = [
      C("border", A.dir, ["slide_02"]),
      C("shadow", B.dir, ["slide_07"]),
      C("borderBad", D.dir, ["slide_04"]),
      C("gradient", E.dir, ["slide_05"]),
    ];

    const preHead = git(st.stagingDir, "rev-parse HEAD");
    const scratchRoot = mkScratch("f");
    const { report, threw, io } = await runPhase({
      // No scripted changed-set: A/B/D compose (D conflict-fails), E composes clean
      // but really perturbs INSET (slide_09) → the REAL pixel-diff catches the
      // ripple. All changed-slide detection is pixel-based.
      fx, stagingDir: st.stagingDir, clusters, scratchRoot,
      claudeMatchers: [{
        name: "resolver-fail",
        when: isClaude,
        // D conflicts (edits L03 like A); resolver fails → reverted+demoted.
        returns: claudeReply("FAILED: cannot merge"),
      }],
    });

    assert.equal(threw, null, "phase should not throw");
    // accounting: A + B accepted; D + E rejected.
    assert.deepEqual(report!.accepted, ["border", "shadow"], "clean+overlap accepted, in fold order");
    assert.deepEqual(report!.rejected.map((r) => r.task).sort(), ["borderBad", "gradient"], "conflict-fail + ripple rejected");
    // exactly one claude spawn (only D conflicts; E composes clean → no resolver).
    assert.equal(io.callsOf("spawnCapture").filter(isClaude).length, 1, "resolver only fired for the one conflicting cluster");
    // conflict recorded unresolved for D.
    assert.equal(report!.conflicts.find((c) => c.task === "borderBad")?.resolved, false, "D conflict unresolved");

    // REAL git: two promote commits (A, B). D + E made none.
    const nCommits = Number(git(st.stagingDir, `rev-list --count ${preHead}..HEAD`));
    assert.equal(nCommits, 2, "exactly two promote commits (A, B)");
    const shown = git(st.stagingDir, `show HEAD:${CONVERTER_REL}`);
    assert.ok(shown.includes("return 11;") && shown.includes("return 22;"), "A+B edits committed");
    assert.ok(!shown.includes("return 99;"), "D's conflicting edit reverted");
    assert.ok(!shown.includes("return 33;"), "E's rippling edit reverted");
    assert.ok(shown.includes("return 3; // L09 GRADIENT"), "L09 back to base (E reverted)");
    assert.equal(git(st.stagingDir, "status --porcelain"), "", "working tree clean at end of fold");

    // REAL demote ledger: only D + E slides demoted; A + B stay good.
    const cand = readCandidates(fx);
    assert.equal(cand["slide_04"].status, "bad", "D's slide demoted");
    assert.equal(cand["slide_05"].status, "bad", "E's slide demoted");
    assert.equal(cand["slide_02"].status, "good", "A's slide still good");
    assert.equal(cand["slide_07"].status, "good", "B's slide still good");
    // exactly two demote entries flipped to bad AMONG THE DECK slides (the seed's
    // off-deck denied slide_08 stays bad but is not part of this fold's accounting).
    const deck = new Set(["slide_02", "slide_04", "slide_05", "slide_07", "slide_09"]);
    const badSlides = Object.entries(cand)
      .filter(([k, v]) => v.status === "bad" && deck.has(k)).map(([k]) => k).sort();
    assert.deepEqual(badSlides, ["slide_04", "slide_05"], "exactly the two rejected clusters' deck slides demoted");
    // the seed's off-deck denied slide is untouched by the fold.
    assert.equal(cand["slide_08"].status, "bad", "seed's denied off-deck slide unchanged by the fold");
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed) { for (const f of failures) console.error(`FAIL ${f.name}: ${(f.err as Error)?.message ?? f.err}`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
