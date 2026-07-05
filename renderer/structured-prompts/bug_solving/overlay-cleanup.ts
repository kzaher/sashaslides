/**
 * overlay-cleanup.ts — thin bug_solving wrapper over the generic COW-workspace
 * lifecycle cleanup in structured-prompting.
 *
 * A bug_solving overlay "branch" is just a CowWorkspace over the repo, so the
 * reaping logic (startup sweep + death handlers) now lives in the library
 * (`registerCowCleanup` / `cleanupAllCowWorkspaces`). This module preserves the
 * historical `registerOverlayCleanup` / `cleanupAllOverlays` names and the
 * OVERLAY_BRANCH_ROOT env passthrough that bug_solving + its e2e tests rely on.
 *
 * Call `registerOverlayCleanup()` ONCE, early in main-scaffolding, before any
 * branch is created.
 */
import {
  registerCowCleanup,
  cleanupAllCowWorkspaces,
} from "../../../structured-prompting/src/workspace/cow-workspace.js";

/** Best-effort, synchronous, never-throws reap of ALL overlay branches. */
export function cleanupAllOverlays(): void {
  // No explicit upperRoot: the runner honors OVERLAY_BRANCH_ROOT (and
  // COW_WORKSPACE_ROOT) from the passed-through process env, so a run/test that
  // sets OVERLAY_BRANCH_ROOT is still respected.
  cleanupAllCowWorkspaces();
}

/** Idempotent. Startup sweep (covers a prior SIGKILL) + death-path handlers. */
export function registerOverlayCleanup(): void {
  registerCowCleanup();
}
