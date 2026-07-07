/**
 * overlay-cleanup.ts — thin bug_solving wrapper over the generic COW-workspace
 * lifecycle helpers in structured-prompting.
 *
 * A bug_solving overlay "branch" is just a CowWorkspace over the repo. The
 * PERSISTENCE contract now lives in the library: overlays SURVIVE crashes/exit
 * (no auto-reap) and are removed only on an EXPLICIT trigger:
 *   - success  → `cleanupOverlay(id)` reaps one merged+promoted cluster,
 *   - --clean  → `cleanupAllOverlays()` discards ALL prior state,
 *   - manual   → `workspace.sh cleanup-all`.
 *
 * This module preserves the historical bug_solving names + the OVERLAY_BRANCH_ROOT
 * env passthrough the e2e tests rely on.
 */
import {
  registerCowCleanup,
  cleanupAllCowWorkspaces,
  cleanupCowWorkspace,
} from "../../../cow-workspace/cow-workspace.js";

/** Best-effort, synchronous, never-throws reap of ALL overlay branches
 *  (used by --clean). No explicit upperRoot: the runner honors
 *  OVERLAY_BRANCH_ROOT / COW_WORKSPACE_ROOT from the passed-through env. */
export function cleanupAllOverlays(): void {
  cleanupAllCowWorkspaces();
}

/** Best-effort reap of exactly ONE overlay branch by id (used on a successful
 *  merge+promote). */
export function cleanupOverlay(id: string): void {
  cleanupCowWorkspace(id);
}

/**
 * ⚠ Now a DELIBERATE NO-OP. Overlays persist across crashes/exit (so work can be
 * resumed); nothing auto-reaps on death anymore. Kept as an exported no-op so
 * existing callers still compile. See cow-workspace.ts's PERSISTENCE CONTRACT.
 */
export function registerOverlayCleanup(): void {
  registerCowCleanup();
}
