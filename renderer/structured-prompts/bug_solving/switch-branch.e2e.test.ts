/**
 * switch-branch.e2e.test.ts — REAL end-to-end proof that the engine's
 * `switchBranch` capability runs a graph's commands INSIDE an isolated overlay
 * branch (nothing mocked but the absence of an LLM — this test uses only
 * `executeShell`, so no model call happens at all).
 *
 * It builds a real graph on the real `ClaudeEngine`:
 *   session.switchBranch(<id>)
 *     .executeShell(() => 'echo <marker> >> renderer/html2slides/convert-pptx.ts')
 *     .executeShell(() => 'tail -1 renderer/html2slides/convert-pptx.ts')
 * and asserts:
 *   (a) the edit shows up in `overlay-branch.sh changed <id>` (it landed in the
 *       branch's upper layer, gitignore-honored);
 *   (b) the BASE working-tree convert-pptx.ts is byte-for-byte UNCHANGED (the
 *       edit was isolated to the branch);
 *   (c) a SECOND executeShell in the SAME branch SEES the first edit (the branch
 *       upper persists across the two namespace-local `run` invocations).
 *
 * Requires the container caps (`--cap-add=SYS_ADMIN --security-opt
 * apparmor=unconfined`) + the `/overlays` volume; if absent, the suite SKIPS
 * loudly (exit 0) rather than failing — matching overlay-branch.e2e.test.ts.
 * Uses its OWN OVERLAY_BRANCH_ROOT so it never touches a live run's branches,
 * and an ephemeral monitor port (0) so it can't collide with :4711/:9222.
 */
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { ClaudeEngine, Session } from "../../../structured-prompting/src/index.js";

const REPO = "/workspaces/sashaslides";
const SH = `${REPO}/structured-prompting/src/workspace/workspace.sh`;
const ROOT = "/overlays/switch-branch-e2e"; // isolated root — never touches a live run
const CANARY = "renderer/html2slides/convert-pptx.ts"; // a real tracked converter file
const BRANCH = `sb-e2e-${process.pid}`;
const MARKER = `switch-branch-e2e-marker-${process.pid}`;

// overlay-branch.sh reads OVERLAY_BRANCH_ROOT from the environment; setting it on
// this process means both our direct `sh(...)` calls AND the engine-spawned
// branch runs (realIO forwards process.env to the child) use the isolated root.
process.env.OVERLAY_BRANCH_ROOT = ROOT;
const env = { ...process.env, OVERLAY_BRANCH_ROOT: ROOT };

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}
function sh(cmd: string): string {
  return execSync(cmd, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function overlayAvailable(): string | null {
  if (!existsSync("/overlays")) return "no /overlays volume";
  try { execSync("unshare -Urm --map-root-user true", { stdio: "ignore" }); }
  catch { return "user namespaces unavailable (SYS_ADMIN?)"; }
  return null;
}

async function main() {
  console.log("\nswitch-branch E2E (REAL ClaudeEngine + overlay branch; only the LLM is absent)\n");
  const skip = overlayAvailable();
  if (skip) { console.log(`  ⚠ SKIP — ${skip} (needs SYS_ADMIN + /overlays). Not a failure.`); console.log("\n=== Results: SKIPPED ===\n"); return; }

  // clean slate + capture the exact base content of the canary.
  try { sh(`bash "${SH}" cleanup-all`); } catch { /* */ }
  const baseCanary = readFileSync(resolve(REPO, CANARY), "utf8");

  // Ephemeral monitor port (0 → OS-assigned) so we never bind :4711. No persist
  // (execute shuts the monitor down on return), no signal hooks, no banner.
  const engine = new ClaudeEngine({ port: 0, persist: false, hookSignals: false, log: false });

  try {
    // The graph: switchBranch, then two executeShell nodes in that branch. The
    // engine wraps EACH command via overlay-branch.sh because ctx.branchId is
    // set. The tip value is the second shell's stdout (the `tail -1`).
    const tail = await engine.execute(
      new Session({ sessionId: "sb-e2e-session" }),
      (s) =>
        s
          .switchBranch(BRANCH)
          // (edit) append a marker to a real tracked converter file, in-branch.
          .executeShell(() => `echo "// ${MARKER}" >> ${CANARY}`)
          // (read-back) a SECOND shell in the SAME branch — must see the edit.
          .executeShell(() => `tail -1 ${CANARY}`),
    );

    // (c) upper persists across the two `run` invocations of the same branch.
    ok("(c) second executeShell in the same branch SEES the first edit (upper persists)",
      tail.includes(MARKER), `tail=${JSON.stringify(tail.trim())}`);

    // (a) the edit is a real tracked change in the branch's upper layer.
    const changed = sh(`bash "${SH}" changed ${BRANCH}`).trim().split("\n").filter(Boolean);
    ok("(a) switchBranch edit shows in `overlay-branch.sh changed`",
      changed.includes(CANARY), `changed=${JSON.stringify(changed)}`);

    // (b) the BASE working tree is untouched — the edit stayed in the branch.
    const baseNow = readFileSync(resolve(REPO, CANARY), "utf8");
    ok("(b) BASE working-tree convert-pptx.ts is byte-for-byte UNCHANGED",
      baseNow === baseCanary, "base canary was modified!");
  } catch (e) {
    ok("(engine) switchBranch graph ran to completion", false, (e as Error)?.message ?? String(e));
  } finally {
    try { await engine.shutdown(); } catch { /* */ }
    try { sh(`bash "${SH}" cleanup-all`); } catch { /* */ }
    // hard-assert we left the base working tree exactly as we found it.
    const finalCanary = readFileSync(resolve(REPO, CANARY), "utf8");
    ok("(final) base working tree restored byte-for-byte", finalCanary === baseCanary);
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();
