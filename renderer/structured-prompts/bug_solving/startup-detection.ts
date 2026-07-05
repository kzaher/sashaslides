/**
 * startup-detection.ts — PURE, unit-testable startup-state detection + decision
 * for bug_solving's overlay-persistence lifecycle.
 *
 * Because overlays now PERSIST across crashes/exit (no auto-reap — see
 * cow-workspace.ts's PERSISTENCE CONTRACT), a fresh run must REFUSE to start on
 * top of prior overlay state so in-progress work isn't silently clobbered or
 * double-solved. The operator explicitly chooses:
 *   --clean     → discard the prior state and start a FRESH solve.
 *   --continue  → keep the prior state and RESUME-MERGE the persisted overlays.
 *
 * `detectPriorState` reads the two overlay roots; `decideStartup` is a pure
 * function of (state, flags) → action. Neither spawns the scaffolding, so both
 * unit-test directly.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Default on-disk overlay roots (mirror workspace.sh + workspace-setup.ts). */
export const DEFAULT_BRANCHES_ROOT = "/overlays/branches";
export const DEFAULT_SHARED_ROOT = "/overlays/shared";

/** Prior overlay state discovered on disk. */
export interface PriorState {
  /** workspace dir names under the branches root (each = one solve overlay). */
  branches: string[];
  /** run-id dir names under the shared root (each holds per-task markers). */
  shared: string[];
  /** true iff EITHER root is non-empty. */
  hasState: boolean;
}

/** List immediate subdirectory names of `root` (empty if root is absent). */
function subdirs(root: string): string[] {
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root).filter((name) => {
      try { return statSync(join(root, name)).isDirectory(); } catch { return false; }
    }).sort();
  } catch { return []; }
}

/**
 * Detect prior overlay state = any workspace under `branchesRoot` OR any run dir
 * under `sharedRoot`. Pure read; no side-effects.
 */
export function detectPriorState(
  branchesRoot: string = DEFAULT_BRANCHES_ROOT,
  sharedRoot: string = DEFAULT_SHARED_ROOT,
): PriorState {
  const branches = subdirs(branchesRoot);
  const shared = subdirs(sharedRoot);
  return { branches, shared, hasState: branches.length > 0 || shared.length > 0 };
}

/** Operator flags parsed from argv/env. */
export interface StartupFlags {
  clean: boolean;    // --clean / BUG_SOLVING_CLEAN=1
  cont: boolean;     // --continue / BUG_SOLVING_CONTINUE=1
}

/** The decided action the scaffolding must perform. */
export type StartupAction = "fresh" | "clean" | "resume" | "error";

export interface StartupDecision {
  action: StartupAction;
  /** operator-facing message (set for `error`; naming BOTH options). */
  message?: string;
}

/**
 * PURE decision. Precedence:
 *   --continue           → resume-merge the persisted overlays (never wipes).
 *   --clean              → discard prior state, then start FRESH.
 *   prior state, no flag → ERROR (message names both --clean and --continue).
 *   no prior state       → FRESH.
 */
export function decideStartup(state: PriorState, flags: StartupFlags): StartupDecision {
  if (flags.cont) return { action: "resume" };
  if (flags.clean) return { action: "clean" };
  if (state.hasState) {
    const n = state.branches.length;
    const m = state.shared.length;
    return {
      action: "error",
      message:
        `Prior overlay state found at ${DEFAULT_BRANCHES_ROOT} (${n} workspace${n === 1 ? "" : "s"})` +
        (m ? ` and ${DEFAULT_SHARED_ROOT} (${m} run dir${m === 1 ? "" : "s"})` : "") +
        `. Re-run with --clean to discard it or --continue to resume merging.`,
    };
  }
  return { action: "fresh" };
}

/** Parse the two lifecycle flags from argv + env (used by main-scaffolding). */
export function parseStartupFlags(argv: string[], env: NodeJS.ProcessEnv): StartupFlags {
  return {
    clean: argv.includes("--clean") || env.BUG_SOLVING_CLEAN === "1",
    cont: argv.includes("--continue") || env.BUG_SOLVING_CONTINUE === "1",
  };
}
