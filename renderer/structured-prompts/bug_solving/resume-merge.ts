/**
 * resume-merge.ts — RESUME-ONLY-MERGE over persisted bug_solving overlays.
 *
 * Because solve overlays now PERSIST across crashes/exit (no auto-reap — see
 * cow-workspace.ts's PERSISTENCE CONTRACT), a run that solved + rated its
 * clusters but died BEFORE the final merge leaves everything on disk:
 *   - each solve overlay under `/overlays/branches/bs-<task>-<ts>`, and
 *   - its rating-outcome.json under `/overlays/shared/<run>/<task>/`.
 *
 * `resumeMerge` enumerates those, rebuilds the GREEN clusters from the markers
 * (demoting the bad, exactly like main.ts's finalMergePhase/selectGreenClusters),
 * runs the SAME `llmMerge` on a real engine, promotes onto the working tree, and
 * — via llmMerge's cleanup-on-success — reaps every merged cluster's overlay +
 * shared dir. Rejected / unrated / marker-less overlays are LEFT for inspection.
 *
 * Runnable standalone:   npx tsx resume-merge.ts [--engine=claude|codex]
 * And from main-scaffolding's `--continue` path.
 *
 * Testability: `ops` (mock retest) and `io` (MockIO → mock the LLM) are
 * injectable; the overlays, filesystem, promote, and ledger run for real.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClaudeEngine,
  CodexEngine,
  Session,
  type IO,
} from "../../../structured-prompting/src/index.js";
import {
  llmMerge,
  ledgerDemote,
  realLlmMergeOps,
  type GreenCluster,
  type MergeOps,
  type MergeReport,
} from "./llm-merge.js";
import {
  detectPriorState,
  DEFAULT_BRANCHES_ROOT,
  DEFAULT_SHARED_ROOT,
} from "./startup-detection.js";

const HISTORY_DIR = "/workspaces/sashaslides/.bug-solving-history";

/** Minimal rating-outcome marker shape (matches main.ts's RatingOutcomeMarker). */
interface Marker {
  task_id: string;
  green: boolean;
  slides: string[];
  bad: string[];
  unrated: string[];
  shared_dir: string;
}

export interface ResumeMergeArgs {
  /** repo root (base tree every overlay overlays + promotes onto). */
  repo: string;
  /** model backend for the merge sends. Default "claude". */
  engine?: "claude" | "codex";
  /** overlay roots (default the real /overlays paths — overridable for tests). */
  branchesRoot?: string;
  sharedRoot?: string;
  /** ext4 upperRoot the solve overlays live on (= branchesRoot for reaping). */
  upperRoot?: string;
  /** fixture deck for the merge retest (default renderer/html2slides/e2e/fixtures). */
  fixturesDir?: string;
  /** injected side-effects (tests mock `retest`). Default realLlmMergeOps. */
  ops?: MergeOps;
  /** injected IO (tests pass MockIO to mock the LLM). Default: engine's own. */
  io?: IO;
  /** demote a bad/unrated cluster's slides back to the ledger. Default ledgerDemote. */
  demote?: (slides: string[], task: string, reason: string) => void;
  /** monitor port for the standalone engine (avoid 4711/4712). Default 4713. */
  port?: number;
  log?: (m: string) => void;
}

/** What resumeMerge discovered + how the merge landed. */
export interface ResumeMergeResult {
  /** every persisted solve overlay it enumerated. */
  branches: string[];
  /** green clusters it folded. */
  green: GreenCluster[];
  /** tasks demoted (bad/unrated marker) — their overlays were LEFT. */
  demoted: string[];
  /** overlays with NO usable marker — LEFT untouched. */
  skipped: string[];
  /** the merge report (null when nothing green to merge). */
  report: MergeReport | null;
}

/** Read every `<sharedRoot>/<run>/<task>/rating-outcome.json` → task_id → Marker.
 *  When a task has multiple markers (re-runs), the LAST one wins (dirs sorted). */
function readMarkers(sharedRoot: string): Map<string, Marker> {
  const out = new Map<string, Marker>();
  if (!existsSync(sharedRoot)) return out;
  let runs: string[] = [];
  try { runs = readdirSync(sharedRoot).sort(); } catch { return out; }
  for (const run of runs) {
    const runDir = join(sharedRoot, run);
    let tasks: string[] = [];
    try { tasks = readdirSync(runDir); } catch { continue; }
    for (const task of tasks) {
      const shared_dir = join(runDir, task);
      const f = join(shared_dir, "rating-outcome.json");
      if (!existsSync(f)) continue;
      try {
        const o = JSON.parse(readFileSync(f, "utf8")) as Partial<Marker>;
        if (typeof o.green !== "boolean") continue;
        out.set(typeof o.task_id === "string" ? o.task_id : task, {
          task_id: typeof o.task_id === "string" ? o.task_id : task,
          green: o.green,
          slides: Array.isArray(o.slides) ? o.slides.filter((s): s is string => typeof s === "string") : [],
          bad: Array.isArray(o.bad) ? o.bad.filter((s): s is string => typeof s === "string") : [],
          unrated: Array.isArray(o.unrated) ? o.unrated.filter((s): s is string => typeof s === "string") : [],
          shared_dir,
        });
      } catch { /* malformed marker → treated as absent */ }
    }
  }
  return out;
}

/** Parse `bs-<task_id>-<timestamp>` → { task, ts }. Returns null for non-bs ids. */
function parseBranchId(id: string): { task: string; ts: number } | null {
  const m = /^bs-(.+)-(\d+)$/.exec(id);
  if (!m) return null;
  return { task: m[1], ts: Number(m[2]) };
}

/**
 * Enumerate persisted solve overlays + their markers, run llmMerge on the GREEN
 * set, promote, reap the merged ones (via llmMerge), demote the bad. Returns
 * what it found + the merge report.
 */
export async function resumeMerge(args: ResumeMergeArgs): Promise<ResumeMergeResult> {
  const log = args.log ?? ((m: string) => console.error(m));
  const branchesRoot = args.branchesRoot ?? DEFAULT_BRANCHES_ROOT;
  const sharedRoot = args.sharedRoot ?? DEFAULT_SHARED_ROOT;
  const upperRoot = args.upperRoot ?? branchesRoot;
  const demote = args.demote ?? ((slides: string[], task: string, reason: string) => {
    try { ledgerDemote(HISTORY_DIR, slides, task, reason); }
    catch (e) { log(`[resume-merge] demote wiring failure for ${task} (non-fatal): ${(e as Error)?.message ?? String(e)}`); }
  });

  const state = detectPriorState(branchesRoot, sharedRoot);
  const markers = readMarkers(sharedRoot);

  // Newest solve overlay per task (a re-run leaves several bs-<task>-<ts>).
  const bsBranches = state.branches
    .map((id) => ({ id, p: parseBranchId(id) }))
    .filter((b): b is { id: string; p: { task: string; ts: number } } => b.p != null);
  const newestByTask = new Map<string, { id: string; ts: number }>();
  for (const { id, p } of bsBranches) {
    const cur = newestByTask.get(p.task);
    if (!cur || p.ts > cur.ts) newestByTask.set(p.task, { id, ts: p.ts });
  }

  log(`[resume-merge] found ${bsBranches.length} persisted solve overlay(s) → ${newestByTask.size} task(s); ${markers.size} rating marker(s).`);

  const green: GreenCluster[] = [];
  const demoted: string[] = [];
  const skipped: string[] = [];

  for (const [task, { id }] of [...newestByTask.entries()].sort()) {
    const marker = markers.get(task);
    if (!marker) {
      skipped.push(task);
      log(`[resume-merge] ${task} (${id}) → SKIP: no rating marker on disk — overlay LEFT.`);
      continue;
    }
    if (marker.green) {
      green.push({ task, branch_id: id, slides: marker.slides, shared_dir: marker.shared_dir });
      log(`[resume-merge] ${task} (${id}) → GREEN — fold candidate (slides ${marker.slides.join(", ") || "(none)"}).`);
    } else {
      demoted.push(task);
      const reason = marker.bad.length
        ? `user rated ${marker.bad.join(", ")} bad`
        : marker.unrated.length
          ? `rating incomplete — unrated [${marker.unrated.join(", ")}]`
          : "not green";
      log(`[resume-merge] ${task} (${id}) → DEMOTE (${reason}) — overlay LEFT for inspection.`);
      try { demote(marker.slides.length ? marker.slides : marker.bad, task, reason); }
      catch (e) { log(`[resume-merge] demote threw for ${task} (continuing): ${(e as Error)?.message ?? String(e)}`); }
    }
  }

  if (green.length === 0) {
    log("[resume-merge] no GREEN overlays to merge — done.");
    return { branches: state.branches, green, demoted, skipped, report: null };
  }

  // Real engine (or an injected io for tests). One-shot; no persisted monitor.
  const engineKind = args.engine ?? "claude";
  const port = args.port ?? 4713;
  const engineOpts = args.io
    ? { io: args.io, persist: false, hookSignals: false, log: false, port: 0 }
    : { persist: false, port };
  const engine = engineKind === "codex" ? new CodexEngine(engineOpts) : new ClaudeEngine(engineOpts);
  const ops = args.ops ?? realLlmMergeOps({ repo: args.repo, fixturesDir: args.fixturesDir, historyDir: HISTORY_DIR });

  let report: MergeReport | null = null;
  try {
    report = await engine.execute(
      new Session({ sessionId: `resume-merge-${Date.now()}`, cwd: args.repo }),
      (s) => llmMerge(s, { repo: args.repo, greenClusters: green, ops, upperRoot }),
    );
  } finally {
    await engine.shutdown();
  }

  log("\n================ RESUME MERGE COMPLETE ================");
  log(`mode: ${report?.mode ?? "(none)"}`);
  log(`accepted (${report?.accepted.length ?? 0}): ${report?.accepted.join(", ") || "(none)"}`);
  log(`rejected (${report?.rejected.length ?? 0}): ${(report?.rejected ?? []).map((r) => `${r.task} (${r.reason})`).join("; ") || "(none)"}`);
  log(`demoted-before-merge (${demoted.length}): ${demoted.join(", ") || "(none)"}`);
  log(`skipped/no-marker (${skipped.length}): ${skipped.join(", ") || "(none)"}`);
  log(`merged files (${report?.mergedFiles.length ?? 0}): ${report?.mergedFiles.join(", ") || "(none)"}`);
  log("======================================================\n");

  return { branches: state.branches, green, demoted, skipped, report };
}

// ── Standalone entry: `npx tsx resume-merge.ts [--engine=claude|codex]` ───────
const isMain = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();
if (isMain) {
  const engineArg = process.argv.find((a) => a.startsWith("--engine="))?.slice("--engine=".length);
  const engine = (engineArg?.toLowerCase() === "codex") ? "codex" : "claude";
  // JAIL ON for the merge (same as main-scaffolding) — every workspace.sh run
  // jails the merge worker + retest into the sandbox.
  process.env.COW_WORKSPACE_JAIL = "1";
  process.env.COW_WORKSPACE_OVERLAY_EXTRA =
    process.env.COW_WORKSPACE_OVERLAY_EXTRA ?? "/home/node/.claude:/home/node/.codex";
  resumeMerge({ repo: process.cwd(), engine })
    .then((r) => { if ((r.report?.rejected.length ?? 0) > 0) process.exitCode = 0; })
    .catch((e) => { console.error("[resume-merge] crashed:", e); process.exit(1); });
}
