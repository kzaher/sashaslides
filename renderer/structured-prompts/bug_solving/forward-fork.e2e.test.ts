/**
 * forward-fork.e2e.test.ts — REAL proof that the host reads what a forward fork writes
 * (BUG-1 / BUG-3: the off-target gate and the rating UI's manifest used to be written to the
 * repo-relative scratch INSIDE the branch, where the host process could never see them).
 *
 * A real ClaudeEngine graph switches into an overlay branch and, from INSIDE it, writes
 *   - <shared>/forward/offtarget-gate.json = {"regressions":["slide_09"]}   (step 4d's output)
 *   - <shared>/forward/thumbnails/thumbs/manifest.json                      (step 4c's output)
 *   - the same gate file under the repo-relative scratch (the old location, as a control).
 * Then, from the HOST, it asserts:
 *   (a) step 6b's read (offTargetRegressions) returns slide_09, so the attempt fails;
 *   (b) writeSxsMeta (host, step 7) sees the fork's manifest → presentation_url;
 *   (c) control: the old repo-relative path is NOT visible on the host.
 * Only the LLM is absent (executeShell only). Skips loudly without SYS_ADMIN + /overlays.
 */
import { execSync } from "child_process";
import { existsSync, readFileSync, rmdirSync, rmSync } from "fs";
import { join } from "path";
import { ClaudeEngine, Session } from "../../../structured-prompting/src/index.js";
import { cleanupAllCowWorkspaces } from "../../../cow-workspace/cow-workspace.ts";
import { forwardForkPaths, offTargetRegressions, writeSxsMeta } from "./forward-fork.js";
import type { SlideTask } from "./main.js";
import { ok, summary } from "./test-harness.js";

const REPO = "/workspaces/sashaslides";
const ROOT = "/overlays/forward-fork-e2e";
const SHARED = `/overlays/forward-fork-e2e-shared/${process.pid}/task-a`;
const BRANCH = `ff-e2e-${process.pid}`;
const OLD_SCRATCH = `.bug-solving-scratch/forward-fork-e2e-${process.pid}`;

process.env.OVERLAY_BRANCH_ROOT = ROOT;
process.env.COW_WORKSPACE_ROOT = ROOT; // wins over OVERLAY_BRANCH_ROOT; a cow.mjs shell exports it
process.env.COW_WORKSPACE_PROVIDER = "overlayfs";


function overlayAvailable(): string | null {
  if (!existsSync("/overlays")) return "no /overlays volume";
  try { execSync("unshare -Urm --map-root-user true", { stdio: "ignore" }); }
  catch { return "user namespaces unavailable (SYS_ADMIN?)"; }
  return null;
}

async function main(): Promise<void> {
  console.log("\nforward-fork E2E (REAL ClaudeEngine + overlay branch; host reads the fork's shared dir)\n");
  const skip = overlayAvailable();
  if (skip) { console.log(`  ⚠ SKIP — ${skip} (needs SYS_ADMIN + /overlays). Not a failure.`); console.log("\n=== Results: SKIPPED ===\n"); return; }
  try { cleanupAllCowWorkspaces(ROOT); } catch { /* clean slate */ }
  const fork = forwardForkPaths(SHARED);
  const gate = JSON.stringify({ regressions: ["slide_09"] });
  const engine = new ClaudeEngine({ port: 0, persist: false, hookSignals: false, log: false });
  try {
    await engine.execute(
      new Session({ sessionId: "ff-e2e-session" }),
      (s) => s
        .switchBranch(BRANCH)
        .executeShell(() => `mkdir -p "${fork.root}" "${fork.thumbnails}/thumbs" "${OLD_SCRATCH}" && ` +
          `echo '${gate}' > "${fork.offtargetGate}" && echo '${gate}' > "${OLD_SCRATCH}/offtarget-gate.json" && ` +
          `echo '{"presentation_id":"PRES-E2E"}' > "${fork.thumbnails}/thumbs/manifest.json"`)
        .executeShell(() => `cat "${OLD_SCRATCH}/offtarget-gate.json"`),
    );

    // (a) step 6b's read from the host
    const regressions = offTargetRegressions(fork, ["slide_07"]);
    ok("(a) host reads the fork's off-target gate → slide_09 fails the attempt", JSON.stringify(regressions) === '["slide_09"]', JSON.stringify(regressions));

    // (b) writeSxsMeta from the host sees the manifest the fork wrote
    const slide = { slide_id: "slide_07", html_file: "/nonexistent.html", user_comment: "c", rendered_png: "/x", original_png: "/y" } as SlideTask;
    writeSxsMeta(fork.thumbnails, [slide]);
    const meta = JSON.parse(readFileSync(join(fork.thumbnails, "sxs-meta.json"), "utf-8"));
    ok("(b) host writeSxsMeta gets the fork's presentation_url", meta.slide_07?.presentation_url === "https://docs.google.com/presentation/d/PRES-E2E/edit", JSON.stringify(meta));

    // (c) control: the old repo-relative location stayed inside the branch
    ok("(c) the repo-relative scratch write is invisible to the host (why the old gate never failed)", !existsSync(join(REPO, OLD_SCRATCH, "offtarget-gate.json")));
  } catch (e) {
    ok("(engine) branch graph ran to completion", false, (e as Error)?.message ?? String(e));
  } finally {
    try { await engine.shutdown(); } catch { /* */ }
    try { cleanupAllCowWorkspaces(ROOT); } catch { /* */ }
    rmSync(`/overlays/forward-fork-e2e-shared/${process.pid}`, { recursive: true, force: true });
    try { rmdirSync("/overlays/forward-fork-e2e-shared"); } catch { /* another run still uses it */ }
  }
  summary();
}
main();
