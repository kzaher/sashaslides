/**
 * claude-in-jail.e2e.test.ts — proves the REAL claude CLI can FUNCTION inside the
 * COW jail: it runs claude -p on a natural edit task inside a jailed overlay and
 * asserts the file was actually mutated IN THE OVERLAY (proof it ran + could write)
 * while the real base stayed untouched (proof the write was contained).
 *
 * This is the ONE test that spends a real (cheap, haiku) model call, so it is
 * OPT-IN: it runs only with RUN_CLAUDE_JAIL=1 (and real overlays + a claude CLI);
 * otherwise it SKIPS loudly. Run it with:  npm run test:jail-claude
 *
 * The jail runs the worker as root-in-userns, so claude refuses
 * --dangerously-skip-permissions unless IS_SANDBOX=1 (accurate: it IS sandboxed);
 * main-scaffolding sets IS_SANDBOX=1, and so does this test.
 */
import { execSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const SH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../structured-prompting/src/workspace/workspace.sh");
let passed = 0, failed = 0;
const ok = (n: string, c: boolean, e = "") => { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.log(`  ✗ ${n}${e ? ` — ${e}` : ""}`); } };

function skipReason(): string | null {
  if (process.env.RUN_CLAUDE_JAIL !== "1") return "opt-in only — set RUN_CLAUDE_JAIL=1 (makes one real haiku call)";
  if (!existsSync("/overlays")) return "no /overlays volume";
  try { execSync("unshare -Urm --map-root-user true", { stdio: "ignore" }); } catch { return "no user namespaces (SYS_ADMIN?)"; }
  try { execSync("command -v claude", { stdio: "ignore" }); } catch { return "no claude CLI on PATH"; }
  return null;
}

function main() {
  console.log("\nclaude-in-jail E2E — real claude mutates a file inside the jail (proof)\n");
  const skip = skipReason();
  if (skip) { console.log(`  ⚠ SKIP — ${skip}.`); console.log("\n=== Results: SKIPPED ===\n"); return; }

  const base = mkdtempSync("/overlays/cij-base-");
  writeFileSync(join(base, "NOTES.md"), "# Notes\n\nStatus: pending\n");
  const root = `/overlays/cij-${process.pid}`;
  const env = {
    ...process.env,
    COW_WORKSPACE_ROOT: root, COW_WORKSPACE_BASE: base,
    COW_WORKSPACE_JAIL: "1", COW_WORKSPACE_OVERLAY_EXTRA: "/home/node/.claude",
    IS_SANDBOX: "1",
  } as NodeJS.ProcessEnv;
  const id = "cij";
  try {
    execSync(`bash "${SH}" cleanup-all`, { env, stdio: "ignore" });
    // Run claude on a plain editing task INSIDE the jail. `env IS_SANDBOX=1` is
    // belt-and-suspenders (also set in the parent env).
    const cmd = `bash "${SH}" run ${id} env IS_SANDBOX=1 claude -p --model haiku --dangerously-skip-permissions ` +
      JSON.stringify("In NOTES.md, change the Status line from 'pending' to 'done'. Just make that one edit.");
    let ran = true;
    try { execSync(cmd, { env, stdio: "ignore", timeout: 180_000 }); } catch { ran = false; }

    const upperNotes = `${root}/${id}/upper/NOTES.md`;
    const upper = existsSync(upperNotes) ? readFileSync(upperNotes, "utf8") : "";
    const baseNotes = readFileSync(join(base, "NOTES.md"), "utf8");

    ok("claude ran + wrote inside the jail (upper NOTES.md exists)", ran && existsSync(upperNotes), `ran=${ran}`);
    ok("claude MUTATED the file (Status → done) — proof it functioned in the jail", /status:\s*done/i.test(upper), upper.slice(0, 80));
    ok("the mutation was CONTAINED (real base still 'pending')", /status:\s*pending/i.test(baseNotes));
  } finally {
    try { execSync(`bash "${SH}" cleanup-all`, { env, stdio: "ignore" }); } catch { /* */ }
    rmSync(base, { recursive: true, force: true });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();
