#!/usr/bin/env npx tsx
/**
 * merge-phase-runner.ts — OPT-IN launcher for the GRAPH-based final merge phase
 * (merge-phase.ts). This is the graph twin of scripts/accept-solved-bugs.ts:
 * instead of an imperative accept loop, it runs `mergePhase` as an ENGINE GRAPH
 * so the monitor shows the compose → conflict-resolution → retest for every
 * cluster, and the whole thing is unit-tested with a mocked LLM
 * (merge-phase.test.ts).
 *
 * It mirrors main-scaffolding.ts's launch contract: build the phase args, boot a
 * ClaudeEngine (prints the monitor URL on bind), execute, print the report.
 *
 * ## What it does
 *   1. Classify GREEN clusters from the worker worktrees + candidate ledger
 *      (same convention as accept-solved-bugs: a worktree whose every recorded
 *      slide is `good` in the ledger).
 *   2. Create a staging worktree off <base> — the accumulating accepted state.
 *   3. Run `mergePhase` on the engine with `realMergeOps` wired to that staging
 *      dir. The engine folds each green cluster in, monitor-visible.
 *   4. Print the MergeReport (accepted / rejected / conflicts / per-slide).
 *
 * This does NOT touch the running scaffolding/monitor: it uses its OWN staging
 * worktree and its OWN engine port (default 4751, off 4711/4712 and the
 * rating-UI base range). Chrome must be on :9222 for the real renders.
 *
 * ## Flags
 *   --base <ref>      workers' fork point / accepted-state origin (default HEAD).
 *   --ledger <file>   candidate ratings (default .bug-solving-history/candidates.json).
 *   --fixtures <dir>  fixture deck (default renderer/html2slides/e2e/fixtures).
 *   --worktrees <d>   worker worktree root (default .claude/worktrees).
 *   --port <n>        engine monitor port (default 4751).
 *   --only <task,…>   restrict to these cluster task slugs.
 *   --repo <dir>      repo root (default cwd).
 *   --keep-staging    do NOT tear down the staging worktree on exit.
 *
 * Run:
 *   cd /workspaces/sashaslides && npx tsx renderer/structured-prompts/bug_solving/merge-phase-runner.ts --base <ref>
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { ClaudeEngine, Session } from "../../../structured-prompting/src/index.js";
import type { ClaudeModel } from "../../../structured-prompting/src/index.js";
import { assertCleanTree } from "./workspace-setup.js";
import { mergePhase, realMergeOps, type MergeCluster, type MergeReport } from "./merge-phase.js";

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function fail(m: string): never { console.error(`❌ ${m}`); process.exit(2); }

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const opt: Record<string, string> = {}; const flags = new Set<string>();
for (let i = 0; i < argv.length; i++) {
  const t = argv[i];
  if (t === "--keep-staging") flags.add(t);
  else if (t.startsWith("--")) opt[t.slice(2)] = argv[++i];
  else fail(`unexpected arg ${t}`);
}
const repo = resolve(opt.repo ?? process.cwd());
const historyDir = resolve(repo, ".bug-solving-history");
const ledgerPath = resolve(repo, opt.ledger ?? join(historyDir, "candidates.json"));
const fixturesDir = resolve(repo, opt.fixtures ?? "renderer/html2slides/e2e/fixtures");
const wtRoot = resolve(repo, opt.worktrees ?? ".claude/worktrees");
const enginePort = Number(opt.port ?? "4751");
const onlyTasks = new Set((opt.only ?? "").split(",").map((t) => t.trim()).filter(Boolean));
const resolveModel: ClaudeModel = ((): ClaudeModel => {
  const m = process.env.BUG_SOLVING_MODEL;
  return (m === "opus" || m === "sonnet" || m === "haiku" || m === "fable") ? m : "opus";
})();

// ---- classification (same convention as accept-solved-bugs) ---------------
function slidesOf(dir: string): string[] {
  const p = join(dir, ".bug-solving-scratch", "before", "pptx");
  return existsSync(p) ? readdirSync(p).filter((f) => f.endsWith(".pptx")).map((f) => basename(f, ".pptx")).sort() : [];
}
function greenClusters(): MergeCluster[] {
  const ledger: Record<string, { status?: string }> = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : {};
  if (!existsSync(wtRoot)) return [];
  const out: MergeCluster[] = [];
  for (const d of readdirSync(wtRoot).filter((x) => x.startsWith("bs-"))) {
    const dir = join(wtRoot, d);
    const slides = slidesOf(dir);
    if (!slides.length) continue;
    const bad = slides.some((s) => ledger[s]?.status === "bad");
    const unrated = slides.some((s) => !ledger[s]?.status);
    if (bad || unrated) continue; // green = every recorded slide is good
    const task = d.replace(/^bs-|-\d+$/g, "");
    if (onlyTasks.size && !onlyTasks.has(task)) continue;
    out.push({ task, dir, slides });
  }
  return out;
}

async function main(): Promise<void> {
  assertCleanTree(repo, ["renderer/html2slides"]);
  const base = (opt.base ? sh(`git rev-parse ${opt.base}`, repo) : sh("git rev-parse HEAD", repo)).trim();
  const clusters = greenClusters();
  if (!clusters.length) { console.error("Nothing green to merge."); process.exit(3); }
  console.error(`Green clusters (${clusters.length}): ${clusters.map((c) => c.task).join(", ")}`);
  console.error(`Base: ${base.slice(0, 12)}`);

  // Staging worktree = the accumulating accepted state; starts at <base>.
  const ts = String(Date.now());
  const stagingDir = join(wtRoot, `merge-phase-${ts}`);
  const stagingBranch = `sp/merge-phase-${ts}`;
  sh(`git worktree add -b ${stagingBranch} "${stagingDir}" ${base}`, repo);
  console.error(`Staging worktree: ${stagingDir} (branch ${stagingBranch})`);

  const ops = realMergeOps({ repo, base, staging: stagingDir, fixturesDir, sh, historyDir });
  const engine = new ClaudeEngine({ port: enginePort, persist: true });
  const session = new Session({ sessionId: `merge-phase-${ts}`, model: resolveModel });

  let report: MergeReport | undefined;
  try {
    report = await engine.execute(session, (s) =>
      mergePhase(s, { clusters, base, staging: stagingDir, fixturesDir, resolveModel, ops }),
    );
  } finally {
    if (!flags.has("--keep-staging")) {
      try { sh(`git worktree remove --force "${stagingDir}"`, repo); } catch { /* */ }
      try { sh(`git branch -D ${stagingBranch}`, repo); } catch { /* */ }
    }
  }

  console.error(`\n================ MERGE PHASE COMPLETE ================`);
  console.error(`accepted (${report!.accepted.length}): ${report!.accepted.join(", ") || "(none)"}`);
  console.error(`rejected (${report!.rejected.length}): ${report!.rejected.map((r) => `${r.task} (${r.reason})${r.demotedSlides.length ? ` → demoted for re-solve: [${r.demotedSlides.join(",")}]` : ""}`).join("; ") || "(none)"}`);
  console.error(`conflicts (${report!.conflicts.length}): ${report!.conflicts.map((c) => `${c.task}[${c.files.join(",")}]=${c.resolved ? "resolved" : "UNRESOLVED"}`).join("; ") || "(none)"}`);
  console.error(`per-slide captures: ${Object.keys(report!.perSlide).length} slide(s)`);
  if (engine.monitorUrl) console.error(`\nInspect the merge graph at ${engine.monitorUrl}`);
  console.error(`=====================================================`);
}

main().catch((e) => fail(`error: ${(e as Error).message}`));
