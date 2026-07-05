/**
 * overlay-cleanup.ts — guarantee overlay branches are reaped when the engine dies.
 *
 * Overlay branches live on the `/overlays` volume and their mounts are
 * namespace-local (they vanish when the branch's `unshare` process exits). What
 * survives a crash is the on-disk `upper`/`work` data — which would accumulate
 * across runs. So we clean up on EVERY death path:
 *   - normal exit / Ctrl-C / SIGTERM / SIGHUP / uncaughtException → run cleanup
 *     synchronously via the death handlers below;
 *   - `kill -9` (SIGKILL — cannot be trapped) → the STARTUP SWEEP on the next run
 *     wipes anything the previous run leaked.
 * Also unmounts any merged mount that leaked into the host namespace (defensive).
 *
 * Call `registerOverlayCleanup()` ONCE, early in main-scaffolding, before any
 * branch is created.
 */
import { execSync } from "child_process";
import { resolve } from "path";

const SCRIPT = resolve(
  process.env.OVERLAY_BRANCH_SCRIPT ??
    resolve(process.cwd(), "renderer/structured-prompts/bug_solving/scripts/overlay-branch.sh"),
);

/** Best-effort, synchronous, never-throws reap of ALL overlay branches. Safe to
 *  call from a `process.on('exit')` handler (must be sync — execSync is). */
export function cleanupAllOverlays(): void {
  try {
    execSync(`bash "${SCRIPT}" cleanup-all`, { stdio: "ignore", timeout: 30_000 });
  } catch {
    /* best-effort: a cleanup failure must never mask the real exit reason */
  }
}

let registered = false;
/** Idempotent. Runs a startup sweep (covers a prior SIGKILL) and wires cleanup
 *  into every trappable death path. */
export function registerOverlayCleanup(): void {
  if (registered) return;
  registered = true;

  // 1) STARTUP SWEEP — reap branches leaked by a previous crashed/-9'd run.
  cleanupAllOverlays();

  // 2) DEATH HANDLERS.
  //    'exit' handlers must be synchronous — cleanupAllOverlays is (execSync).
  process.on("exit", cleanupAllOverlays);
  //    Signals: clean up, then re-exit with the conventional code so the parent
  //    still sees a signal-terminated child. (SIGKILL is unlistable — handled by
  //    the next run's startup sweep above.)
  const sigExit: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  for (const sig of Object.keys(sigExit)) {
    process.on(sig as NodeJS.Signals, () => {
      cleanupAllOverlays();
      process.exit(sigExit[sig]);
    });
  }
  process.on("uncaughtException", (err) => {
    console.error("[overlay-cleanup] uncaughtException — reaping overlays before exit:", err);
    cleanupAllOverlays();
    process.exit(1);
  });
}
