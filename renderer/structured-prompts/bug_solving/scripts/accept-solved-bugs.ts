#!/usr/bin/env npx tsx
/**
 * accept-solved-bugs.ts — accept GREEN bug_solving fixes ONE CLUSTER AT A TIME,
 * with a HUMAN verifying that no slide regressed before the cluster is kept.
 *
 * This is deliberately NOT the old hands-free "merge-all-green behind an
 * automated pixel gate" flow. The invariant is now:
 *
 *   > A cluster is kept ONLY if the user confirms NO regression on ANY slide it
 *   > changed — its own targeted slides AND any rippled slides. Otherwise the
 *   > cluster is reverted and the accepted state is left untouched.
 *
 * KEY INSIGHT — only the RIPPLE needs verification. A cluster's OWN targeted
 * slides were ALREADY rated good by the user (that's why the cluster is green in
 * the candidate ledger). So on accept, the only slides that need FRESH human
 * verification are the RIPPLE = slides that changed but are NOT in the cluster's
 * intended set. Ripple slides ARE the potential regressions. Therefore:
 *   - a cluster with NO ripple auto-accepts (nothing new to verify) and the loop
 *     continues to the next pending cluster in the SAME invocation.
 *   - a cluster WITH ripple is presented as regression candidates and either
 *     verified by a human (TTY) or rejected by default (non-interactive).
 *
 * You run the skill REPEATEDLY. Each invocation drives the loop until a cluster
 * needs human verification (then EXITS) or none remain:
 *
 *   invocation N   : finalize the previous in_review cluster from the user's
 *                    ratings of its RIPPLE (keep-if-clean / revert-if-any-bad),
 *                    then walk pending clusters: auto-accept the no-ripple ones,
 *                    and for the first rippled one either boot a rating UI on the
 *                    ripple + EXIT (TTY) or reject-by-default + keep looping (no TTY).
 *   (human)        : opens the rating UI, rates EVERY rippled slide good/bad.
 *   invocation N+1 : reads those ratings, keeps-or-reverts, walks the next …
 *
 * STATE MACHINE  (.bug-solving-history/accept-state.json)
 *   Each green cluster is one of:
 *     pending    — classified green, not yet reviewed.
 *     in_review  — merged onto the accepted state + rendered; it RIPPLED to slides
 *                  it did not target; a rating UI is up on `port` filtered to the
 *                  ripple; awaiting the user's good/bad on every `ripple` slide.
 *                  Carries { changed, intended, ripple, ratingDir, port, preMergeCommit }.
 *                  (No-ripple clusters never enter this state — they auto-accept.)
 *     accepted   — no ripple (auto), OR the user rated every rippled slide good →
 *                  committed onto the staging branch (and fast-forwarded into --target).
 *     rejected   — the user rated ≥1 rippled slide bad, OR it rippled and there was
 *                  no TTY to verify, OR its genuine conflict could NOT be
 *                  auto-resolved → reverted to preMergeCommit; accepted state unchanged.
 *     conflict_resolved — composing this cluster hit a GENUINE cherry-pick conflict
 *                  (unmerged paths) that a structured-prompting agent auto-resolved
 *                  IN the staging worktree (markers gone; change STAGED, not
 *                  committed). The run PAUSES + prints the resolver's monitor link so
 *                  the user can inspect exactly how it was merged. On the NEXT run the
 *                  cluster is rendered+diffed+verified (its ripple) from the resolved
 *                  staged state, as if it had composed cleanly. Carries
 *                  { conflictFiles, resolveMonitorUrl, preMergeCommit }.
 *   The "accepted state" is the staging worktree's HEAD: it starts at <base>
 *   and accumulates one commit per accepted cluster. --target is fast-forwarded
 *   to it after each accept.
 *
 * PER-STEP FLOW (see run())
 *   1. If a cluster is in_review: read <ratingDir>/ratings.json for its `ripple`
 *      slides (the only ones under review). EVERY rippled slide good → COMMIT the
 *      staged merge, mark accepted, fast-forward --target. ANY rippled slide bad
 *      (or still unrated) → `git restore` the converter back to preMergeCommit
 *      (drop the staged merge), mark rejected, report which slide the user flagged.
 *   2. Walk pending green clusters. For each, START its review:
 *      a. Compose THAT ONE cluster's diff onto the accepted state via git's real
 *         3-way merge: materialise the base-relative diff as a commit on <base> in
 *         a temp worktree, then cherry-pick it onto the staging branch (composes
 *         with prior clusters that touched the same file). A GENUINE conflict is
 *         handed to a structured-prompting agent that resolves it in the staging
 *         worktree (→ conflict_resolved + monitor link + PAUSE); --no-auto-resolve
 *         restores the old "resolve manually, then re-run" fail.
 *      b. Render the WHOLE deck sequentially (RECORD_CONCURRENCY=1) at the
 *         accepted baseline and post-merge, structural-diff → changed set;
 *         intended = changed ∩ cluster.slides, ripple = changed \ intended.
 *      c. If ripple is EMPTY → auto-accept (commit + ff) and CONTINUE to the next
 *         pending cluster in the same invocation (no human needed).
 *      d. If ripple is NON-EMPTY → present the regression candidates, then:
 *           interactive (TTY): render the RIPPLE slides to Slides (--mode full),
 *             boot a rating UI FILTERED to the ripple, mark in_review, print the
 *             URL + rippled slides, and EXIT for the human.
 *           non-interactive: reject by default (revert to preMergeCommit), mark
 *             rejected, and CONTINUE to the next pending cluster.
 *   3. If nothing is pending/in_review: print the final accepted/rejected tally
 *      and the resulting --target commits.
 *
 * FLAGS
 *   --target <ref>   branch to land accepted clusters onto (default: current).
 *   --base <ref>     workers' fork point / accepted-state origin (default HEAD).
 *   --ledger <file>  candidate ratings (default .bug-solving-history/candidates.json).
 *   --port <n>       rating-UI base port (default 4731; each cluster picks the
 *                    next free port from here).
 *   --history-dir <d> persistent rating ledger (default .bug-solving-history).
 *   --fixtures <dir> fixture deck (default renderer/html2slides/e2e/fixtures).
 *   --worktrees <d>  worker worktree root (default .claude/worktrees).
 *   --state <file>   state file (default <history-dir>/accept-state.json).
 *   --reset          clear accept-state (drop the staging worktree) and re-classify.
 *   --repo <dir>     repo root (default cwd).
 *   --commit         actually merge+render+classify and commit/revert. This is
 *                    the DEFAULT; the human's good/bad decision is the real gate
 *                    on rippled clusters. --no-commit makes it report-only.
 *   --interactive / --non-interactive
 *                    force the ripple-verification mode (default: auto-detected
 *                    from TTY). interactive → boot a rating UI + pause on ripple;
 *                    non-interactive → reject rippled clusters by default.
 *   --no-auto-resolve
 *                    on a GENUINE cherry-pick conflict, FAIL with the old
 *                    "resolve manually, then re-run" message instead of spawning
 *                    a structured-prompting agent to resolve it. (default: auto-resolve.)
 *   --stop           halt WITHOUT continuing a conflict_resolved cluster; leaves its
 *                    staged resolution + state intact so a later re-run can continue.
 *   --only <task[,…]> restrict eligibility to exactly these cluster task_ids
 *                    (others ignored entirely, not even classified as pending),
 *                    e.g. --only pseudo-glyph-center accepts just slide_04.
 *   --skip <task[,…]> exclude these cluster task_ids. Both match the cluster
 *                    `task` slug (the bs-<task>-<ts> name minus prefix/timestamp).
 *
 * The human IS the gate on RIPPLED clusters — there is no --yes. No-ripple
 * clusters auto-accept. Chrome must be on :9222 (renders).
 * This operates on its OWN staging worktree + its OWN rating-UI ports; it does
 * NOT touch the running scaffolding/monitor.
 *
 * EXIT: 0 a step completed (cluster started / finalized / all done) ·
 *       2 setup error · 3 nothing green to accept.
 */
import { execSync, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { ClaudeEngine, Session } from "../../../../structured-prompting/src/index.js";
import type { ClaudeModel } from "../../../../structured-prompting/src/index.js";
import { assertCleanTree } from "../workspace-setup.js";
import { computeChanges, applyChanges } from "./patcher.js";

// Converter payload globs the patcher composes over (top-level converter .ts),
// mirroring the old `renderer/html2slides/*.ts` git-diff pathspec.
const CONVERTER_GLOBS = ["renderer/html2slides/*.ts"];

type Cls = "green" | "red" | "neutral";
// conflict_resolved: a GENUINE cherry-pick conflict was auto-resolved by a
// structured-prompting agent IN the staging worktree (markers gone, change
// staged but NOT committed). It awaits the user's decision to CONTINUE: on the
// next run the cluster is rendered+diffed+verified from the resolved staged
// state exactly like a freshly-composed pending cluster.
type Status = "pending" | "in_review" | "accepted" | "rejected" | "conflict_resolved";

interface Cluster {
  task: string;
  dir: string;
  slides: string[];
  status: Status;
  // populated while in_review:
  changed?: string[];        // intended ∪ ripple = every slide this cluster changed
  intended?: string[];       // the cluster's own targeted slides that actually changed
  ripple?: string[];         // OTHER slides that changed (must be verified too)
  ratingDir?: string;        // where ratings.json for this review lives
  port?: number;             // rating-UI port
  preMergeCommit?: string;   // staging HEAD before this cluster's merge (revert target)
  // populated when a genuine cherry-pick conflict was auto-resolved by an agent:
  conflictFiles?: string[];  // the files that had conflict markers
  resolveMonitorUrl?: string;// the resolver engine's monitor URL (inspect the reasoning)
}
interface State {
  ts: string;
  base: string;
  target: string;
  stagingDir: string;
  stagingBranch: string;
  clusters: Record<string, Cluster>;
}

function fail(m: string): never { console.error(`❌ ${m}`); process.exit(2); }
function sh(cmd: string, cwd: string): string { return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function shLive(cmd: string, cwd: string): void { execSync(cmd, { cwd, stdio: "inherit", maxBuffer: 128 * 1024 * 1024 }); }

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt: Record<string, string> = {}; const flags = new Set<string>();
for (let i = 0; i < argv.length; i++) {
  const t = argv[i];
  if (t === "--reset" || t === "--commit" || t === "--no-commit" || t === "--interactive" || t === "--non-interactive" || t === "--no-auto-resolve" || t === "--stop") flags.add(t);
  else if (t.startsWith("--")) opt[t.slice(2)] = argv[++i];
  else fail(`unexpected arg ${t}`);
}
const doCommit = !flags.has("--no-commit"); // default: real merge+commit; the human is the gate
// Compose backend: how a cluster's converter diff is composed onto the accepted
// state. "git" (default) = materialise the diff as a commit on <base> and
// cherry-pick it (3-way, preserves the existing conflict-resolver-agent flow).
// "patcher" = the git-AGNOSTIC path (computeChanges base→cluster, applyChanges
// onto the staging dir with a per-file 3-way line merge) — ready for the coming
// full-disk-copy branches where there is no git to cherry-pick. Both route a
// genuine conflict to the SAME resolver agent.
const composeBackend: "git" | "patcher" = (opt.compose === "patcher") ? "patcher" : "git";
// On a GENUINE cherry-pick conflict, auto-resolve it with a structured-prompting
// agent (default) instead of failing. --no-auto-resolve restores the old manual
// "resolve manually, then re-run" fail behaviour.
const autoResolve = !flags.has("--no-auto-resolve");
// Model for the conflict-resolver agent. A careful merge wants a strong model,
// so default to "opus"; BUG_SOLVING_MODEL overrides (matches the scaffolding).
const resolveModel: ClaudeModel = ((): ClaudeModel => {
  const m = process.env.BUG_SOLVING_MODEL;
  return (m === "opus" || m === "sonnet" || m === "haiku" || m === "fable") ? m : "opus";
})();

// Cluster filters: match the cluster `task` slug (the bs-<task>-<ts> name minus
// prefix/timestamp). --only restricts eligibility to exactly these tasks (others
// are not even classified as pending); --skip excludes these tasks.
function parseTaskCsv(v: string | undefined): Set<string> {
  return new Set((v ?? "").split(",").map((t) => t.trim()).filter(Boolean));
}
const onlyTasks = parseTaskCsv(opt.only);
const skipTasks = parseTaskCsv(opt.skip);
/** A cluster task is eligible iff it passes the --only allow-list (if any) and is
 *  not on the --skip list. */
function taskEligible(task: string): boolean {
  if (onlyTasks.size && !onlyTasks.has(task)) return false;
  if (skipTasks.has(task)) return false;
  return true;
}

// Interactivity: a rippled cluster's regressions are only VERIFIABLE by a human at
// a rating UI. If we can't pause for that human (no TTY), we reject rippled clusters
// by default rather than keeping an unverified change. --interactive/--non-interactive
// override the auto-detected default.
const interactive = flags.has("--interactive") ? true
  : flags.has("--non-interactive") ? false
  : !!(process.stdin.isTTY && process.stdout.isTTY);
const repo = resolve(opt.repo ?? process.cwd());
const historyDir = resolve(repo, opt["history-dir"] ?? ".bug-solving-history");
const ledgerPath = resolve(repo, opt.ledger ?? join(historyDir, "candidates.json"));
const fixtures = resolve(repo, opt.fixtures ?? "renderer/html2slides/e2e/fixtures");
const wtRoot = resolve(repo, opt.worktrees ?? ".claude/worktrees");
const statePath = resolve(repo, opt.state ?? join(historyDir, "accept-state.json"));
const basePort = Number(opt.port ?? "4731");

const REC = resolve(repo, "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts");
const DIFF = resolve(repo, "renderer/structured-prompts/bug_solving/scripts/diff-pptx-pairs.ts");
const RATER = resolve(repo, "renderer/html2slides/rating-server.ts");

// ---------------------------------------------------------------------------
// classification (unchanged semantics): a worktree's slides = its recorded
// before/pptx/<slide>.pptx names. green = every slide `good`; red = any `bad`;
// neutral = any unrated (none bad) → IGNORED with a warning.
// ---------------------------------------------------------------------------
function slidesOf(dir: string): string[] {
  const p = join(dir, ".bug-solving-scratch", "before", "pptx");
  return existsSync(p) ? readdirSync(p).filter((f) => f.endsWith(".pptx")).map((f) => basename(f, ".pptx")).sort() : [];
}
interface Classified { dir: string; task: string; slides: string[]; cls: Cls; bad: string[]; missing: string[]; }
function classify(): Classified[] {
  const ledger: Record<string, { status?: string }> = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : {};
  return existsSync(wtRoot) ? readdirSync(wtRoot).filter((d) => d.startsWith("bs-")).map((d) => {
    const dir = join(wtRoot, d); const slides = slidesOf(dir);
    const bad = slides.filter((s) => ledger[s]?.status === "bad");
    const missing = slides.filter((s) => !ledger[s]?.status);
    const cls: Cls = bad.length ? "red" : missing.length ? "neutral" : slides.length ? "green" : "neutral";
    return { dir, task: d.replace(/^bs-|-\d+$/g, ""), slides, cls, bad, missing };
  }) : [];
}

// ---------------------------------------------------------------------------
// state persistence
// ---------------------------------------------------------------------------
function loadState(): State | null {
  return existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) as State : null;
}
function saveState(s: State): void {
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(s, null, 2));
}

/** Create the staging worktree off <base> on a fresh branch, and seed the
 *  cluster ledger from a fresh classification. */
function initState(): State {
  const base = (opt.base ? sh(`git rev-parse ${opt.base}`, repo) : sh("git rev-parse HEAD", repo)).trim();
  const target = opt.target ?? sh("git rev-parse --abbrev-ref HEAD", repo).trim();
  const ts = String(Math.floor(Number(sh("date +%s", repo).trim())));
  const stagingBranch = `sp/accept-${ts}`;
  const stagingDir = join(wtRoot, `accept-${ts}`);

  // --only/--skip restrict which cluster task_ids are eligible. Filtered-out
  // clusters are dropped BEFORE classification display/seeding so they are never
  // classified as pending (not merged, not discarded — just ignored entirely).
  const clAll = classify();
  const cl = clAll.filter((w) => taskEligible(w.task));
  if (onlyTasks.size || skipTasks.size) {
    const dropped = clAll.filter((w) => !taskEligible(w.task)).map((w) => w.task);
    console.error(
      `Cluster filter:${onlyTasks.size ? ` --only=[${[...onlyTasks].join(",")}]` : ""}${skipTasks.size ? ` --skip=[${[...skipTasks].join(",")}]` : ""}` +
      `${dropped.length ? `  ignored=[${dropped.join(",")}]` : ""}`);
  }
  console.error(`Ledger: ${ledgerPath}\nBase: ${base.slice(0, 12)}  Target: ${target}\n`);
  for (const w of cl) console.error(
    `  [${w.cls.toUpperCase().padEnd(7)}] ${basename(w.dir)}  slides=[${w.slides.join(",") || "?"}]` +
    `${w.bad.length ? `  bad=${w.bad.join(",")}` : ""}${w.missing.length ? `  unrated=${w.missing.join(",")}` : ""}`);
  const neutral = cl.filter((w) => w.cls === "neutral");
  const red = cl.filter((w) => w.cls === "red");
  if (neutral.length) console.error(
    `\n⚠  ${neutral.length} NEUTRAL (unrated) worktree(s) — IGNORED (not merged, not discarded). Rate their candidates, then --reset + re-run:\n` +
    neutral.map((w) => `     • ${w.task}  (unrated: ${w.missing.join(",") || "?"})`).join("\n"));
  if (red.length) console.error(
    `\n⚠  ${red.length} RED worktree(s) — SKIPPED: ${red.map((w) => `${w.task}(bad:${w.bad.join(",")})`).join(", ")}`);

  const green = cl.filter((w) => w.cls === "green");
  if (!green.length) { console.error("\nNothing green to accept."); process.exit(3); }
  console.error(`\nGreen clusters (${green.length}): ${green.map((w) => w.task).join(", ")}`);

  // staging worktree = the accepted state; starts at <base>.
  if (existsSync(stagingDir)) { try { sh(`git worktree remove --force "${stagingDir}"`, repo); } catch { /* stale */ } }
  try { sh(`git branch -D ${stagingBranch}`, repo); } catch { /* none */ }
  sh(`git worktree add -b ${stagingBranch} "${stagingDir}" ${base}`, repo);
  console.error(`Staging worktree: ${stagingDir} (branch ${stagingBranch})`);

  const clusters: Record<string, Cluster> = {};
  for (const w of green) clusters[w.task] = { task: w.task, dir: w.dir, slides: w.slides, status: "pending" };
  const s: State = { ts, base, target, stagingDir, stagingBranch, clusters };
  saveState(s);
  return s;
}

function tearDownStaging(s: State): void {
  try { sh(`git worktree remove --force "${s.stagingDir}"`, repo); } catch { /* */ }
  try { sh(`git branch -D ${s.stagingBranch}`, repo); } catch { /* */ }
}

// ---------------------------------------------------------------------------
// render / diff / rate primitives (operate INSIDE the staging worktree)
// ---------------------------------------------------------------------------
function deckIds(): string[] {
  return readdirSync(fixtures).filter((f) => /^slide_\d+\.html$/.test(f)).map((f) => f.replace(/\.html$/, "")).sort();
}

/** Deterministic full-deck pptx render from the staging worktree's CURRENT tree. */
function renderDeckPptx(ids: string[], outDir: string): void {
  rmSync(outDir, { recursive: true, force: true });
  shLive(
    `cd "${join(s0Dir(), "renderer")}" && RECORD_CONCURRENCY=1 npx tsx "${REC}" ` +
    `--mode pptx --fixtures "${fixtures}" --slides "${ids.join(",")}" --out "${outDir}"`,
    repo,
  );
}
// staging dir accessor (set once run() has the state)
let _stagingDir = "";
function s0Dir(): string { return _stagingDir; }

/** Structural-diff two pptx dirs → the set of slides that differ. */
function changedSlides(beforePptx: string, afterPptx: string, diffOut: string): string[] {
  rmSync(diffOut, { recursive: true, force: true });
  shLive(
    `npx tsx "${DIFF}" --before "${beforePptx}" --after "${afterPptx}" --out "${diffOut}"`,
    resolve(repo, "renderer/structured-prompts/bug_solving/scripts"),
  );
  const out: string[] = [];
  for (const f of readdirSync(diffOut)) {
    if (!f.endsWith(".diff")) continue;
    const txt = readFileSync(join(diffOut, f), "utf8");
    if (!/no structural differences/i.test(txt)) out.push(f.replace(/\.diff$/, ""));
  }
  return out.sort();
}

function firstFreePort(from: number): number {
  for (let p = from; p < from + 200; p++) {
    try { execSync(`lsof -ti:${p}`, { stdio: ["ignore", "pipe", "ignore"] }); } // in use → throws only if empty
    catch { return p; } // lsof exits non-zero when the port is free
  }
  return from;
}

/** Render the changed slides to Google Slides (--mode full) and boot a rating
 *  UI FILTERED to those slides. Returns the chosen port. Best-effort on the
 *  render; the UI is what the human uses. */
function bootReviewUi(cluster: Cluster, changed: string[], ratingDir: string): number {
  const csv = changed.join(",");
  rmSync(ratingDir, { recursive: true, force: true }); mkdirSync(ratingDir, { recursive: true });
  console.error(`Rendering changed slides (${csv}) to Slides for review …`);
  try {
    shLive(
      `cd "${join(s0Dir(), "renderer")}" && npx tsx "${REC}" --mode full ` +
      `--fixtures "${fixtures}" --slides "${csv}" --title accept-${cluster.task} --out "${ratingDir}"`,
      repo,
    );
  } catch { console.error("  ⚠ Slides render failed (best-effort) — the rating UI will still show what it has."); }

  const port = firstFreePort(basePort);
  try { execSync(`lsof -ti:${port} | xargs -r kill`, { stdio: "ignore" }); } catch { /* none */ }
  execSync(
    `setsid npx tsx "${RATER}" "${ratingDir}" --port ${port} ` +
    `--filter-slides "${csv}" --slides-dir "${ratingDir}/thumbs" --originals-dir "${ratingDir}/originals" ` +
    `--history-dir "${historyDir}" > "/tmp/accept-review-${cluster.task}.log" 2>&1 < /dev/null & disown`,
    { cwd: repo, shell: "/bin/bash" },
  );
  return port;
}

/** Read the review's ratings for a cluster's RIPPLE slides (the only slides that
 *  need fresh verification — the cluster's OWN intended slides were already rated
 *  green in the candidate ledger, which is why the cluster is green at all).
 *  Returns { good, bad, unrated } over `ripple`. A rippled slide with NO rating
 *  counts as NOT-good (still awaiting the human) → treated as a regression so we
 *  never keep an unverified change. */
function readReview(cluster: Cluster): { good: string[]; bad: string[]; unrated: string[] } {
  const ratingsFile = join(cluster.ratingDir!, "ratings.json");
  const ratings: Record<string, { status?: string }> = existsSync(ratingsFile) ? JSON.parse(readFileSync(ratingsFile, "utf8")) : {};
  const good: string[] = [], bad: string[] = [], unrated: string[] = [];
  for (const sid of cluster.ripple ?? []) {
    const st = ratings[sid]?.status;
    if (st === "good") good.push(sid);
    else if (st === "bad") bad.push(sid);
    else unrated.push(sid);
  }
  return { good, bad, unrated };
}

// ---------------------------------------------------------------------------
// the loop: ONE step per invocation
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  if (flags.has("--reset")) {
    const prev = loadState();
    if (prev) tearDownStaging(prev);
    try { rmSync(statePath, { force: true }); } catch { /* */ }
    console.error("--reset: cleared accept-state.");
  }
  // --stop: an explicit "halt here" for a conflict_resolved cluster the user does
  // NOT want to continue. It leaves the staged resolution + state untouched (so a
  // later re-run without --stop can still continue) and just exits without doing
  // any render/verify work this invocation.
  if (flags.has("--stop")) {
    const st = loadState();
    const cr = st ? Object.values(st.clusters).find((c) => c.status === "conflict_resolved") : undefined;
    console.error(cr
      ? `--stop: halting. Cluster ${cr.task} stays conflict_resolved (staged, not committed)${cr.resolveMonitorUrl ? ` — resolution: ${cr.resolveMonitorUrl}` : ""}. Re-run WITHOUT --stop to continue it, or --reset to discard.`
      : `--stop: halting. Nothing to continue.`);
    process.exit(0);
  }

  let s = loadState();
  if (!s) {
    // No prior accept-state → initState() is about to create the staging worktree
    // off <base>. That base is the accepted-state ORIGIN, so it must reflect
    // COMMITTED reality: a dirty converter tree in the main checkout would make
    // the accepted baseline diverge from what workers forked from. Fail early
    // (BUG_SOLVING_ALLOW_DIRTY=1 to override). Scoped to the converter dir so
    // stray untracked scratch dirs don't block.
    assertCleanTree(repo, ["renderer/html2slides"]);
    s = initState();
  }
  _stagingDir = s.stagingDir;
  if (!existsSync(s.stagingDir)) fail(`staging worktree missing (${s.stagingDir}); re-run with --reset`);

  console.error(`\nAccepted state: ${s.stagingBranch} @ ${sh(`git -C "${s.stagingDir}" rev-parse --short HEAD`, repo).trim()}  →  target ${s.target}`);

  // --only/--skip also gate selection from an EXISTING state (a re-run without
  // --reset): only eligible clusters are finalized/started this invocation.
  if (onlyTasks.size || skipTasks.size) {
    const ignored = Object.values(s.clusters).filter((c) => (c.status === "pending" || c.status === "in_review") && !taskEligible(c.task)).map((c) => c.task);
    if (ignored.length) console.error(`Cluster filter active — ignoring this run: [${ignored.join(",")}]`);
  }

  // ---- STEP 1: finalize any in_review cluster from the user's ratings -------
  const inReview = Object.values(s.clusters).find((c) => c.status === "in_review" && taskEligible(c.task));
  if (inReview) {
    if (!doCommit) {
      const r = readReview(inReview);
      console.error(`(--no-commit) cluster ${inReview.task} in_review — good:[${r.good.join(",")}] bad:[${r.bad.join(",")}] unrated:[${r.unrated.join(",")}]. No keep/revert.`);
      process.exit(0);
    }
    finalizeInReview(s, inReview);
    saveState(s);
    // fall through to start the NEXT pending cluster in the same invocation.
  }

  // ---- STEP 1.5: CONTINUE any conflict_resolved cluster. Its genuine conflict
  //   was auto-resolved by an agent on a PRIOR run and STAGED (not committed); the
  //   user chose to re-run = "continue". Render+diff+verify its ripple from the
  //   resolved staged state, exactly like a freshly-composed pending cluster.
  const resolved = Object.values(s.clusters).find((c) => c.status === "conflict_resolved" && taskEligible(c.task));
  if (resolved) {
    if (!doCommit) {
      console.error(`(--no-commit) cluster ${resolved.task} conflict_resolved (staged). Would render+classify its ripple with --commit. Resolution: ${resolved.resolveMonitorUrl ?? "(no monitor)"}.`);
      process.exit(0);
    }
    const outcome = resumeConflictResolved(s, resolved);
    saveState(s);
    if (outcome === "paused") process.exit(0); // rippled → in_review; wait for the human.
    // "accepted"/"rejected" → fall through to the pending loop.
  }

  // ---- STEP 2: start pending clusters. A cluster whose ONLY changes are its own
  //   (already-approved) slides has no ripple → nothing to verify → auto-accept and
  //   loop to the next. A cluster that rippled to OTHER slides is a potential
  //   regression: pause for the human (TTY) or reject by default (non-TTY) and loop.
  for (;;) {
    const pending = Object.values(s.clusters).find((c) => c.status === "pending" && taskEligible(c.task));
    if (!pending) break;
    if (!doCommit) {
      console.error(`(--no-commit) next pending cluster: ${pending.task} (slides ${pending.slides.join(",")}). Would merge+render+classify (auto-accept if no ripple; verify/reject if rippled) with --commit.`);
      process.exit(0);
    }
    const outcome = await startReview(s, pending);
    saveState(s);
    if (outcome === "paused") process.exit(0); // in_review: wait for the human to rate + re-run
    if (outcome === "conflict") process.exit(0); // conflict_resolved (staged): the user inspects the resolution + re-runs to continue
    // "accepted" (no ripple) or "rejected" (rippled + non-interactive) → keep looping.
  }

  // ---- STEP 3: nothing left --------------------------------------------------
  reportFinal(s);
  process.exit(0);
}

/** Commit the staged merge onto the staging branch, mark accepted, ff target. */
function commitAccept(s: State, c: Cluster, reason: string): void {
  const changedCsv = (c.changed ?? []).join(",");
  sh(`git -C "${s.stagingDir}" add -- renderer/html2slides`, repo);
  execFileSync("git", ["-C", s.stagingDir, "commit", "-q",
    "-m", `SashaSlides: accept solved bug (${c.task}) — ${reason}, changed: ${changedCsv}`,
    "-m", "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"], { cwd: repo });
  const head = sh(`git -C "${s.stagingDir}" rev-parse --short HEAD`, repo).trim();
  c.status = "accepted";
  console.error(`✅ ACCEPTED ${c.task} — committed ${head} on ${s.stagingBranch} (${reason}).`);
  fastForwardTarget(s);
}

/** Revert the staged merge back to the pre-merge commit, mark rejected. */
function revertReject(s: State, c: Cluster, reason: string): void {
  sh(`git -C "${s.stagingDir}" restore --source ${c.preMergeCommit} --staged --worktree -- renderer/html2slides`, repo);
  c.status = "rejected";
  console.error(`❌ REJECTED ${c.task} — reverted the merge (${reason}). Accepted state unchanged.`);
}

/** Finalize an in_review cluster from the human's ratings of the RIPPLE slides.
 *  The cluster's own intended slides were already approved (green ledger); only the
 *  ripple (potential regressions) was up for review. EVERY rippled slide good →
 *  accept; ANY bad or (defensively) unrated → reject. */
function finalizeInReview(s: State, c: Cluster): void {
  const r = readReview(c);
  const notGood = [...r.bad, ...r.unrated];
  const ripple = c.ripple ?? [];
  console.error(`\n── Finalizing in_review cluster: ${c.task}`);
  console.error(`   intended=[${(c.intended ?? []).join(",")}]  ripple(verified)=[${ripple.join(",")}]  good=[${r.good.join(",")}]  bad=[${r.bad.join(",")}]  unrated=[${r.unrated.join(",")}]`);

  if (notGood.length === 0 && ripple.length > 0) {
    // CLEAN: every rippled (potential-regression) slide was rated good.
    commitAccept(s, c, `human-verified no regression on rippled slides [${ripple.join(",")}]`);
  } else if (ripple.length === 0) {
    // Defensive: an in_review cluster should always have carried a non-empty ripple
    // (no-ripple clusters auto-accept without ever entering in_review). Accept if we
    // somehow got here with nothing to verify.
    commitAccept(s, c, "no ripple to verify");
  } else {
    // ANY bad — or unrated (still awaiting / non-interactive finalize) → revert.
    const flagged = r.bad.length ? `bad ripple: ${r.bad.join(",")}` : `unverified ripple (no rating): ${r.unrated.join(",")}`;
    revertReject(s, c, flagged);
  }
  // tear down the review rating UI port (best-effort).
  if (c.port) { try { execSync(`lsof -ti:${c.port} | xargs -r kill`, { stdio: "ignore" }); } catch { /* */ } }
}

/** Fast-forward --target to the staging branch HEAD (accepted state), without
 *  disturbing the caller's checked-out branch or the running scaffolding. */
function fastForwardTarget(s: State): void {
  const stagingHead = sh(`git -C "${s.stagingDir}" rev-parse HEAD`, repo).trim();
  const cur = sh("git rev-parse --abbrev-ref HEAD", repo).trim();
  if (cur === s.target) {
    // target is checked out in the MAIN worktree: fast-forward in place if clean.
    const dirty = sh("git status --porcelain", repo).trim().length > 0;
    if (dirty) { console.error(`⚠ target ${s.target} is checked out here and dirty — NOT auto-advancing. Merge ${s.stagingBranch} manually.`); return; }
    try { sh(`git merge --ff-only ${stagingHead}`, repo); console.error(`   → ${s.target} fast-forwarded to ${stagingHead.slice(0, 12)}`); }
    catch { console.error(`⚠ could not ff ${s.target} → ${stagingHead.slice(0, 12)} (diverged). Merge ${s.stagingBranch} manually.`); }
  } else {
    // target is NOT checked out: update the ref only if it is an ancestor (ff-safe).
    try {
      const isAncestor = (() => { try { execSync(`git merge-base --is-ancestor ${s.target} ${stagingHead}`, { cwd: repo }); return true; } catch { return false; } })();
      if (isAncestor) { sh(`git branch -f ${s.target} ${stagingHead}`, repo); console.error(`   → ${s.target} fast-forwarded to ${stagingHead.slice(0, 12)}`); }
      else console.error(`⚠ ${s.target} is not an ancestor of the staging HEAD — NOT auto-advancing. Merge ${s.stagingBranch} manually.`);
    } catch (e) { console.error(`⚠ could not advance ${s.target}: ${(e as Error).message}`); }
  }
}

// "paused"   — in_review: a rating UI is up on the ripple; wait for the human.
// "accepted" — no ripple, committed onto the accepted state; loop to next.
// "rejected" — rippled + non-interactive, reverted; loop to next.
// "conflict" — a GENUINE cherry-pick conflict was auto-resolved by an agent and
//              STAGED (conflict_resolved); pause + exit so the user inspects the
//              resolution (monitor link) before continuing.
type ReviewOutcome = "paused" | "accepted" | "rejected" | "conflict";

/** A free TCP port for the resolver engine's monitor — deliberately OFF the
 *  running scaffolding monitor (4711/4712) and the rating-UI base range so a
 *  concurrent bug_solving run + rating servers are never disturbed. Probes
 *  upward from `from` (default 4741), skipping 4711/4712. */
function freeEnginePort(from = 4741): number {
  const forbidden = new Set([4711, 4712]);
  for (let p = from; p < from + 200; p++) {
    if (forbidden.has(p)) continue;
    // lsof exits non-zero (throws) when the port is FREE → that's the one we want.
    try { execSync(`lsof -ti:${p}`, { stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return p; }
  }
  return from;
}

/** Gather everything the resolver agent needs to make an informed merge:
 *   - the unmerged (conflicted) file list from the staging worktree,
 *   - each conflicted file's current contents WITH the cherry-pick's markers,
 *   - THIS cluster's task + intended slides + its converter diff (its intent),
 *   - the already-ACCEPTED clusters whose diff touched the SAME file(s) and what
 *     they changed (the other side's intent).
 *  Pure/read-only: no git mutation, safe to unit-test against a synthetic state. */
interface ConflictContext {
  files: { path: string; markedContents: string }[];
  clusterDiff: string;
  overlappingAccepted: { task: string; diff: string }[];
}
function gatherConflictContext(s: State, c: Cluster, conflictedFiles: string[]): ConflictContext {
  const files = conflictedFiles.map((path) => {
    let markedContents = "";
    try { markedContents = readFileSync(join(s.stagingDir, path), "utf8"); } catch { /* deleted-in-one-side etc. */ }
    return { path, markedContents };
  });
  // THIS cluster's converter intent = its base-relative diff.
  let clusterDiff = "";
  try { clusterDiff = sh(`git -C "${c.dir}" diff ${s.base} -- 'renderer/html2slides/*.ts'`, repo); } catch { /* */ }

  // Already-accepted clusters that touched any conflicted file — the OTHER side.
  const overlappingAccepted: { task: string; diff: string }[] = [];
  for (const other of Object.values(s.clusters)) {
    if (other.status !== "accepted" || other.task === c.task) continue;
    let odiff = "";
    try { odiff = sh(`git -C "${other.dir}" diff ${s.base} -- 'renderer/html2slides/*.ts'`, repo); } catch { /* */ }
    if (!odiff.trim()) continue;
    // Does this accepted cluster's diff touch any conflicted file?
    const touches = conflictedFiles.some((f) => odiff.includes(`diff --git a/${f}`) || odiff.includes(` ${basename(f)}\n`));
    if (touches) overlappingAccepted.push({ task: other.task, diff: odiff });
  }
  return { files, clusterDiff, overlappingAccepted };
}

/** Build the RESOLVE prompt the agent runs (in the staging worktree) to merge a
 *  genuine cherry-pick conflict, preserving BOTH sides. Kept separate from the
 *  engine call so it can be inspected/unit-tested. */
function buildResolvePrompt(c: Cluster, ctx: ConflictContext): string {
  const fileList = ctx.files.map((f) => `  - ${f.path}`).join("\n");
  const accepted = ctx.overlappingAccepted.length
    ? ctx.overlappingAccepted.map((a) => `### accepted cluster "${a.task}" (already merged) added:\n\`\`\`diff\n${a.diff.slice(0, 8000)}\n\`\`\``).join("\n\n")
    : "(could not identify the specific accepted cluster(s) from state; both sides' changes are visible as the conflict markers in the file.)";
  return [
    `You are resolving a git CHERRY-PICK CONFLICT in THIS git worktree (your cwd). The bug-fix pipeline is composing the converter fix from cluster "${c.task}" (which targets slides ${c.slides.join(", ")}) onto a stack of ALREADY-ACCEPTED converter fixes, and git could not auto-merge these file(s):`,
    fileList,
    ``,
    `Each conflicted file currently contains git conflict markers (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`). Both sides are INTENTIONAL, INDEPENDENTLY-REVIEWED fixes — you MUST preserve BOTH sides' changes (both injector calls / both edits), not pick one.`,
    ``,
    `## What cluster "${c.task}" is adding (one side):`,
    "```diff",
    ctx.clusterDiff.slice(0, 8000),
    "```",
    ``,
    `## What the already-accepted cluster(s) added (the other side):`,
    accepted,
    ``,
    `## Your job`,
    `1. EDIT the conflicted file(s) listed above to a clean, correct merge that keeps BOTH sides' changes.`,
    `2. REMOVE every conflict marker (\`<<<<<<<\`, \`=======\`, \`>>>>>>>\`) — none may remain.`,
    `3. Keep the code COMPILING (this is TypeScript under renderer/html2slides). Do not introduce type errors, duplicate declarations, or dropped calls.`,
    `4. Do NOT run \`git commit\`, \`git cherry-pick --continue\`, or \`git add\` — the orchestrator finalizes and stages the result. Just leave the files edited on disk.`,
    ``,
    `When you have removed ALL markers and the merge is clean, reply with EXACTLY the single word RESOLVED (nothing else). If you genuinely cannot produce a correct both-sides merge, reply "FAILED: <one-line reason>".`,
  ].join("\n");
}

/** Run a structured-prompting agent to resolve a genuine cherry-pick conflict IN
 *  the staging worktree, print the engine monitor link, and PAUSE for the user.
 *  On success: verify no markers remain, stage the resolution, mark the cluster
 *  `conflict_resolved` (awaiting the user's go), return "conflict" (caller exits).
 *  On failure: abort the cherry-pick, revert to preMerge, mark rejected, keep the
 *  monitor link in the message, return "rejected". */
async function resolveConflictWithAgent(
  s: State, c: Cluster, sha: string, conflictedFiles: string[], preMerge: string, cleanupTmp: () => void,
): Promise<ReviewOutcome> {
  console.error(
    `\n⚠ GENUINE conflict composing ${c.task} onto the accepted state in: [${conflictedFiles.join(", ") || "(unknown)"}].` +
    `\n   Handing it to a ${resolveModel} resolver agent (--no-auto-resolve to fail manually instead) …`);

  // Gather context BEFORE any git mutation (markers are still in the worktree).
  const ctx = gatherConflictContext(s, c, conflictedFiles);
  const prompt = buildResolvePrompt(c, ctx);

  const port = freeEnginePort();
  const engine = new ClaudeEngine({ port, persist: true });
  const session = new Session({ sessionId: `accept-conflict-${c.task}-${Date.now()}`, model: resolveModel });

  let agentReply = "";
  let engineErr: string | null = null;
  try {
    agentReply = (await engine.execute(session, (sn) => sn.switchCwd(s.stagingDir).send({ prompt }))).trim();
  } catch (e) {
    engineErr = (e as Error).message;
  }
  c.resolveMonitorUrl = engine.monitorUrl ?? undefined;
  c.conflictFiles = conflictedFiles;

  // Did the agent leave a clean merge? Verify no conflict markers remain in ANY
  // conflicted file, regardless of what it replied (trust the files, not the word).
  const markersRemain = conflictedFiles.some((f) => {
    let txt = ""; try { txt = readFileSync(join(s.stagingDir, f), "utf8"); } catch { return true; }
    return /^(<{7}|={7}|>{7})/m.test(txt);
  });
  const saidFailed = /^FAILED\b/i.test(agentReply) || engineErr !== null;
  const resolved = !markersRemain && !saidFailed;

  if (!resolved) {
    // UNRESOLVED: agent gave up / errored / markers still present → abort the
    // cherry-pick, restore the accepted state, reject the cluster, keep the link.
    try { sh(`git -C "${s.stagingDir}" cherry-pick --abort`, repo); } catch { /* */ }
    try { sh(`git -C "${s.stagingDir}" restore --source ${preMerge} --staged --worktree -- renderer/html2slides`, repo); } catch { /* */ }
    cleanupTmp();
    const why = engineErr ? `engine error: ${engineErr}` : saidFailed ? `agent replied: ${agentReply.slice(0, 200)}` : `conflict markers still present in [${conflictedFiles.join(", ")}]`;
    c.status = "rejected";
    console.error(`\n🔗 Agent could NOT resolve — inspect the reasoning at: ${engine.monitorUrl ?? "(no monitor)"}; the cluster was reverted.`);
    console.error(`❌ REJECTED ${c.task} — auto-resolve failed (${why}). Accepted state unchanged.`);
    return "rejected";
  }

  // RESOLVED: finalize the cherry-pick's merge state and stage the resolution.
  // The cherry-pick is still "in progress" (CHERRY_PICK_HEAD set); `git add` the
  // resolved paths clears the unmerged entries. We do NOT commit — the orchestrator
  // records the commit later (via commitAccept) with the full changed-set message.
  execFileSync("git", ["-C", s.stagingDir, "add", "--", "renderer/html2slides"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  // Drop the in-progress cherry-pick sequencer state so the worktree isn't left
  // "mid-cherry-pick" (the change stays staged; we just clear CHERRY_PICK_HEAD).
  try { sh(`git -C "${s.stagingDir}" cherry-pick --quit`, repo); } catch { /* */ }
  cleanupTmp();

  // converter-scoped tsc sanity (warn only — the user still verifies visually).
  let tscErrors = 0;
  try { execSync("npx tsc --noEmit", { cwd: s.stagingDir, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { tscErrors = ((e as { stdout?: Buffer }).stdout?.toString() || "").split("\n").filter((l) => /error TS/.test(l) && l.includes("renderer/html2slides/")).length; }
  if (tscErrors) console.error(`⚠ tsc (converter-scoped): ${tscErrors} error(s) after the agent's merge — review the resolution carefully.`);

  c.preMergeCommit = preMerge; // revert target if the ripple later turns out bad
  c.status = "conflict_resolved";
  console.error(`\n🔗 Conflict resolved by agent — inspect the full reasoning + resolution at: ${engine.monitorUrl}\n`);
  console.error(
    `Conflict on ${c.task} resolved (staged, not committed) in [${conflictedFiles.join(", ")}]. Review at ${engine.monitorUrl}.` +
    `\nRe-run accept-solved-bugs to CONTINUE (it will render + let you verify this cluster's ripple), or run with --stop / just don't re-run to halt.`);
  return "conflict";
}

/** Merge ONE cluster onto the accepted state, render the deck, and classify by
 *  RIPPLE (slides changed that are NOT in the cluster's intended set):
 *   - no ripple  → auto-accept (the cluster's own slides were already approved).
 *   - ripple + interactive → boot a rating UI filtered to the ripple, mark
 *     in_review, and pause ("paused") for the human to rate + re-run.
 *   - ripple + non-interactive → reject by default (can't verify without a human).
 *  Returns the outcome so the caller's loop can continue on accept/reject. */
async function startReview(s: State, c: Cluster): Promise<ReviewOutcome> {
  console.error(`\n── Starting review of cluster: ${c.task}  (targets ${c.slides.join(",")})`);
  const preMerge = sh(`git -C "${s.stagingDir}" rev-parse HEAD`, repo).trim();
  c.preMergeCommit = preMerge;

  // (a) render the accepted BASELINE deck first (converter == accepted state).
  const ids = deckIds();
  const scratch = join("/tmp", `accept-${s.ts}-${c.task}`);
  console.error(`Rendering BASELINE deck (accepted state) …`);
  renderDeckPptx(ids, join(scratch, "baseline", "pptx"));

  // (b) compose THIS cluster's converter diff onto the accepted state. The
  //     COMPOSE (diff base→cluster + 3-way apply onto the accepted state) goes
  //     through the git-AGNOSTIC patcher so it's ready for the coming full-disk-
  //     copy branches; the git specifics (materialising a base dir, staging,
  //     committing) stay here in the caller. `--compose git` (default) keeps the
  //     exact old cherry-pick behaviour; `--compose patcher` uses computeChanges/
  //     applyChanges. BOTH route a genuine conflict to the SAME resolver agent.
  mkdirSync(scratch, { recursive: true });
  console.error(`Applying cluster ${c.task}'s converter diff (compose=${composeBackend}) …`);

  // temp worktree + branch names are unique per run-ts + cluster task and are
  // ALWAYS cleaned up (success and failure) so no detached worktrees leak.
  const tmpWt = join(wtRoot, `accept-tmp-${s.ts}-${c.task}`);
  const tmpBranch = `sp/accept-tmp-${s.ts}-${c.task}`;
  const cleanupTmp = () => {
    try { sh(`git worktree remove --force "${tmpWt}"`, repo); } catch { /* */ }
    try { sh(`git branch -D ${tmpBranch}`, repo); } catch { /* */ }
  };
  // scrub any stale temp worktree/branch from a prior aborted run before creating.
  cleanupTmp();

  // The conflict routing is shared by both backends: a genuine compose conflict
  // leaves markers in the staging worktree and is either failed (--no-auto-resolve)
  // or handed to the resolver agent (default).
  const routeConflict = async (conflictedFiles: string[], conflictSummary: string): Promise<ReviewOutcome> => {
    if (!autoResolve) {
      // --no-auto-resolve: OLD behaviour — abort, restore, name the file(s), fail.
      try { sh(`git -C "${s.stagingDir}" cherry-pick --abort`, repo); } catch { /* */ }
      try { sh(`git -C "${s.stagingDir}" restore --source ${preMerge} --staged --worktree -- renderer/html2slides`, repo); } catch { /* */ }
      cleanupTmp();
      fail(`cluster ${c.task}: genuine conflict between ${c.task} and an accepted cluster in ${conflictedFiles.join(", ") || conflictSummary}: resolve manually, then re-run (or drop --no-auto-resolve to have an agent resolve it).`);
    }
    // AUTO-RESOLVE: hand the conflict (markers left in the worktree) to a
    // structured-prompting agent that edits the file(s) to a clean merge
    // preserving BOTH sides, prints a monitor link, and pauses for the user.
    // `sha` is unused by the patcher backend (there is no cherry-pick in flight);
    // pass an empty string.
    return resolveConflictWithAgent(s, c, "", conflictedFiles, preMerge, cleanupTmp);
  };

  if (composeBackend === "patcher") {
    // GIT-AGNOSTIC COMPOSE. Materialise the base as a directory (via a throwaway
    // git worktree FOR NOW — once branches are disk copies, this is just a copy),
    // diff base→cluster over the converter globs, then 3-way-apply onto the
    // staging worktree's CURRENT tree (which already carries prior accepted
    // clusters). No `git apply` / `git cherry-pick`.
    let changes;
    try {
      sh(`git worktree add -b ${tmpBranch} "${tmpWt}" ${s.base}`, repo);
      changes = computeChanges(tmpWt, c.dir, CONVERTER_GLOBS);
    } catch (e) {
      cleanupTmp();
      fail(`cluster ${c.task}: could not materialise the base dir at ${s.base.slice(0, 12)} — ${(e as Error).message.split("\n")[0]}.`);
    }
    if (!changes.length) { cleanupTmp(); fail(`cluster ${c.task} has an EMPTY converter diff (worker made no .ts change) — nothing to accept.`); }
    writeFileSync(join(scratch, `${c.task}.changes.json`), JSON.stringify(changes, null, 2));

    const res = applyChanges(s.stagingDir, changes);
    if (!res.ok) {
      // Materialise the conflict marker view on disk (mirrors git cherry-pick) so
      // the resolver agent has the same both-sides markers to work from.
      for (const cf of res.conflicts) {
        try { writeFileSync(join(s.stagingDir, cf.path), cf.merged); } catch { /* */ }
      }
      const conflictedFiles = res.conflicts.map((cf) => cf.path);
      return routeConflict(conflictedFiles, "patcher 3-way conflict");
    }
    // clean compose → stage the composed converter change, drop the temp base.
    execFileSync("git", ["-C", s.stagingDir, "add", "--", "renderer/html2slides"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    cleanupTmp();
    return classifyAndReview(s, c, scratch, ids);
  }

  // GIT COMPOSE (default). The cluster diff is generated against the CLEAN base
  // (`s.base`); when a PRIOR accepted cluster already touched the SAME file,
  // `git apply --3way` fails ("does not match index") because it can't compose
  // two independent base-relative diffs onto an accumulated state. Instead we
  // materialise the cluster's change as a commit ON THE BASE (throwaway temp
  // worktree, where the base-relative patch ALWAYS applies cleanly), then
  // cherry-pick that commit onto the staging branch (accepted state). Cherry-pick
  // is a 3-way merge, so it composes overlapping-context-but-non-conflicting edits.
  const patch = sh(`git -C "${c.dir}" diff ${s.base} -- 'renderer/html2slides/*.ts'`, repo);
  const patchFile = join(scratch, `${c.task}.patch`);
  writeFileSync(patchFile, patch);
  if (!patch.trim()) { cleanupTmp(); fail(`cluster ${c.task} has an EMPTY converter diff (worker made no .ts change) — nothing to accept.`); }

  let sha: string;
  try {
    // 1) fresh temp worktree at the CLEAN base — the base-relative patch applies here.
    sh(`git worktree add -b ${tmpBranch} "${tmpWt}" ${s.base}`, repo);
    execFileSync("git", ["-C", tmpWt, "apply", "--index", "--whitespace=nowarn", patchFile], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    execFileSync("git", ["-C", tmpWt, "-c", "user.email=accept@bug-solving", "-c", "user.name=accept-solved-bugs",
      "commit", "-q", "-m", `cluster ${c.task}`], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    sha = sh(`git -C "${tmpWt}" rev-parse HEAD`, repo).trim();
  } catch (e) {
    const msg = (e as { stderr?: Buffer }).stderr?.toString() || String(e);
    cleanupTmp();
    // the base-relative patch should ALWAYS apply on the base; a failure here means
    // a malformed/stale diff, not a compose conflict.
    fail(`cluster ${c.task}: could not materialise the base-relative diff on ${s.base.slice(0, 12)} — ${msg.split("\n")[0]}. Regenerate the cluster diff.`);
  }

  // 2) cherry-pick (3-way merge) the cluster commit onto the accepted state.
  //    --no-commit stages the composed result without recording a commit yet
  //    (commitAccept records it later with the full changed-set message).
  let conflictErr: string | null = null;
  try {
    execFileSync("git", ["-C", s.stagingDir, "cherry-pick", "--no-commit", sha], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    conflictErr = (e as { stderr?: Buffer }).stderr?.toString() || String(e);
  }

  if (conflictErr !== null) {
    // GENUINE conflict: git left unmerged paths / conflict markers in the staging
    // worktree. Gather the conflicted file list WITHOUT aborting (we leave the
    // markers in place for the resolver agent).
    const conflictedFiles = (() => {
      try { return sh(`git -C "${s.stagingDir}" diff --name-only --diff-filter=U`, repo).trim().split("\n").filter(Boolean); }
      catch { return [] as string[]; }
    })();
    return routeConflict(conflictedFiles, conflictErr.split("\n")[0]);
  }
  // stage the composed converter change (cherry-pick --no-commit already staged it,
  // but re-stage explicitly to be safe) and drop the temp worktree/branch.
  execFileSync("git", ["-C", s.stagingDir, "add", "--", "renderer/html2slides"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  cleanupTmp();

  // Compose succeeded → render POST, diff, classify by ripple, and route.
  return classifyAndReview(s, c, scratch, ids);
}

/** POST-compose classification. Runs after the cluster's converter change is
 *  STAGED in the staging worktree — whether it was composed cleanly by a
 *  cherry-pick (startReview) OR auto-resolved by the conflict agent and then
 *  CONTINUED on a re-run (resumeConflictResolved). Renders the POST deck, diffs
 *  it against the accepted baseline, and routes on the RIPPLE:
 *    - no ripple  → auto-accept.
 *    - ripple + interactive → boot a ripple-filtered rating UI, mark in_review, pause.
 *    - ripple + non-interactive → reject by default.
 *  `scratch` must already contain baseline/pptx from the same accepted state. */
function classifyAndReview(s: State, c: Cluster, scratch: string, ids: string[]): ReviewOutcome {
  // typecheck (converter-scoped) — warn only, don't block the human review.
  let tscErrors = 0;
  try { execSync("npx tsc --noEmit", { cwd: s.stagingDir, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { tscErrors = ((e as { stdout?: Buffer }).stdout?.toString() || "").split("\n").filter((l) => /error TS/.test(l) && l.includes("renderer/html2slides/")).length; }
  if (tscErrors) console.error(`⚠ tsc (converter-scoped): ${tscErrors} error(s) after applying ${c.task} — review carefully.`);

  // (c) render POST deck (converter == accepted + this cluster) and diff.
  console.error(`Rendering POST deck (accepted + ${c.task}) …`);
  renderDeckPptx(ids, join(scratch, "post", "pptx"));
  const changed = changedSlides(join(scratch, "baseline", "pptx"), join(scratch, "post", "pptx"), join(scratch, "diff"));
  const intendedSet = new Set(c.slides);
  const intended = changed.filter((x) => intendedSet.has(x));
  const ripple = changed.filter((x) => !intendedSet.has(x));
  c.changed = changed; c.intended = intended; c.ripple = ripple;
  console.error(`Changed slides: intended=[${intended.join(",") || "(none!)"}]  ripple=[${ripple.join(",") || "none"}]`);

  // (d) classify by ripple. The cluster's OWN intended slides were already rated
  //     green in the candidate ledger, so they need no fresh verification — only
  //     the RIPPLE (slides changed that the cluster did NOT target) are potential
  //     regressions.
  if (ripple.length === 0) {
    // NO RIPPLE: only the cluster's own (already-approved) slides changed (or the
    // fix was a no-op on the accepted state). Nothing to verify → accept now.
    commitAccept(s, c, changed.length
      ? `no ripple — only its own already-approved slides changed [${intended.join(",")}]`
      : `no-op on the accepted state (changed nothing)`);
    console.error(`✓ ${c.task}: no ripple — only its own (already-approved) slides changed — accepted. Continuing to the next cluster.`);
    return "accepted";
  }

  // RIPPLE PRESENT: this cluster changed OTHER slides = potential regressions.
  console.error(
    `\n⚠ REGRESSION CANDIDATES — cluster ${c.task} (intended [${intended.join(",") || "(none)"}]) rippled to ` +
    `${ripple.length} slide(s) it did NOT target: [${ripple.join(",")}]. These are the only slides that need verification.`);

  if (!interactive) {
    // NON-INTERACTIVE: no human to verify the ripple → reject by default (revert the
    // staged merge). The cluster stays out of the accepted state.
    revertReject(s, c, `rippled to [${ripple.join(",")}] — needs human verification (non-interactive)`);
    console.error(`✗ ${c.task} rejected (non-interactive): rippled to [${ripple.join(",")}] — needs human verification. Re-run in a terminal to review.`);
    return "rejected";
  }

  // INTERACTIVE: render the RIPPLE slides (NOT the intended ones — those are already
  // approved) to Slides, boot a rating UI filtered to the ripple, mark in_review.
  const ratingDir = resolve(historyDir, "accept-reviews", c.task);
  const port = bootReviewUi(c, ripple, ratingDir);
  c.ratingDir = ratingDir; c.port = port; c.status = "in_review";
  console.error(
    `\nMerged cluster ${c.task} (intended [${intended.join(",") || "(none)"}]). ` +
    `It RIPPLED to [${ripple.join(",")}].` +
    `\nVERIFY no regressions at http://localhost:${port} — rate EVERY rippled slide [${ripple.join(",")}] good/bad, ` +
    `then re-run accept-solved-bugs to keep-if-clean and proceed to the next cluster.`,
  );
  return "paused";
}

/** CONTINUE a cluster whose GENUINE cherry-pick conflict was auto-resolved by the
 *  agent on a PRIOR run (status conflict_resolved). The resolved converter change
 *  is ALREADY staged in the staging worktree (markers gone), so we skip the whole
 *  compose step and go straight to render+diff+verify the ripple from the resolved
 *  staged state — exactly as if it had composed cleanly. */
function resumeConflictResolved(s: State, c: Cluster): ReviewOutcome {
  console.error(`\n── Continuing conflict-resolved cluster: ${c.task}  (resolved staged merge; targets ${c.slides.join(",")})`);
  if (c.resolveMonitorUrl) console.error(`   (resolution reasoning: ${c.resolveMonitorUrl})`);
  // preMergeCommit was recorded before the conflicting compose; keep it as the
  // revert target if the ripple turns out bad.
  const ids = deckIds();
  const scratch = join("/tmp", `accept-${s.ts}-${c.task}`);
  // Re-render the accepted BASELINE deck (the staging worktree still carries the
  // resolved staged change, but git-diffing pptx needs the ACCEPTED baseline; the
  // baseline == the pre-merge tree, so render it from preMergeCommit's tree by
  // temporarily nothing — instead we render the committed HEAD, which IS the
  // accepted state since the resolved change is only STAGED, not committed).
  //
  // Note: renderDeckPptx renders the worktree's CURRENT tree, which includes the
  // staged+resolved change. To get a clean baseline we render from a checkout of
  // preMergeCommit into the worktree, snapshot, then restore the resolved change.
  // Simpler + safe: stash the staged resolution, render baseline, restore it.
  const stash = sh(`git -C "${s.stagingDir}" stash create`, repo).trim();
  if (stash) {
    // hard-restore to the pre-merge accepted state to render the true baseline …
    sh(`git -C "${s.stagingDir}" restore --source ${c.preMergeCommit} --staged --worktree -- renderer/html2slides`, repo);
    console.error(`Rendering BASELINE deck (accepted state) …`);
    renderDeckPptx(ids, join(scratch, "baseline", "pptx"));
    // … then bring the resolved change back from the stash commit and re-stage it.
    sh(`git -C "${s.stagingDir}" checkout ${stash} -- renderer/html2slides`, repo);
    execFileSync("git", ["-C", s.stagingDir, "add", "--", "renderer/html2slides"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
  } else {
    // No staged change to preserve (shouldn't happen for conflict_resolved) —
    // just render the current tree as baseline.
    console.error(`Rendering BASELINE deck (accepted state) …`);
    renderDeckPptx(ids, join(scratch, "baseline", "pptx"));
  }
  c.status = "pending"; // in-flight marker; classifyAndReview sets the final status
  return classifyAndReview(s, c, scratch, ids);
}

function reportFinal(s: State): void {
  const cl = Object.values(s.clusters);
  const accepted = cl.filter((c) => c.status === "accepted");
  const rejected = cl.filter((c) => c.status === "rejected");
  console.error(`\n================ ACCEPT COMPLETE ================`);
  console.error(`accepted (${accepted.length}): ${accepted.map((c) => c.task).join(", ") || "(none)"}`);
  console.error(`rejected (${rejected.length}): ${rejected.map((c) => `${c.task}${c.ripple?.length ? ` [rippled to ${c.ripple.join(",")}]` : ""}`).join(", ") || "(none)"}`);
  // Defensive: a conflict_resolved cluster should have been continued in STEP 1.5
  // (and thus not still be resolved-but-unfinalized here). Surface it + its link if
  // one somehow lingers so the user can re-run to continue or --reset to discard.
  const stillResolved = cl.filter((c) => c.status === "conflict_resolved");
  if (stillResolved.length) console.error(
    `conflict_resolved awaiting continue (${stillResolved.length}): ` +
    stillResolved.map((c) => `${c.task}${c.resolveMonitorUrl ? ` (resolution: ${c.resolveMonitorUrl})` : ""}`).join(", ") +
    `\n   → re-run WITHOUT --stop to render+verify these, or --reset to discard.`);
  const stagingHead = sh(`git -C "${s.stagingDir}" rev-parse --short HEAD`, repo).trim();
  const targetHead = (() => { try { return sh(`git rev-parse --short ${s.target}`, repo).trim(); } catch { return "?"; } })();
  console.error(`\naccepted state (${s.stagingBranch}): ${stagingHead}`);
  console.error(`target (${s.target}): ${targetHead}`);
  if (accepted.length) {
    console.error(`\nCommits landed on ${s.target}:`);
    try { console.error(sh(`git -C "${s.stagingDir}" log --oneline ${s.base}..HEAD`, repo).trim()); } catch { /* */ }
  }
  console.error(`\nStaging worktree kept at ${s.stagingDir}. Re-run with --reset to start over.`);
  console.error(`================================================`);
}

run().catch((e) => fail(`error: ${(e as Error).message}`));
