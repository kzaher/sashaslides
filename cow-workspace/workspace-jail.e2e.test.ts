/**
 * workspace-jail.e2e.test.ts — REAL test of COW_WORKSPACE_JAIL (no mocks).
 * Proves the "true jail": with jail on, a command inside the workspace can write
 * ONLY to the sandbox (the base overlay + COW_WORKSPACE_OVERLAY_EXTRA paths + a
 * disposable tmpfs /tmp); every other path is read-only and nothing leaks to the
 * real fs. Contrast: with jail OFF a write to an extra path is NOT contained.
 * Skips loudly if SYS_ADMIN / /overlays are unavailable.
 */
import { execSync } from "child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const SH = resolve(dirname(fileURLToPath(import.meta.url)), "workspace.sh");
let passed = 0, failed = 0;
function ok(n: string, c: boolean, e = "") { if (c) { passed++; console.log(`  ✓ ${n}`); } else { failed++; console.log(`  ✗ ${n}${e ? ` — ${e}` : ""}`); } }

function skipReason(): string | null {
  if (!existsSync("/overlays")) return "no /overlays volume";
  try { execSync("unshare -Urm --map-root-user true", { stdio: "ignore" }); } catch { return "no user namespaces (SYS_ADMIN?)"; }
  return null;
}

function main() {
  console.log("\nworkspace jail E2E (REAL userns + overlay + ro-lockdown; nothing mocked)\n");
  const skip = skipReason();
  if (skip) { console.log(`  ⚠ SKIP — ${skip}. Not a failure.`); console.log("\n=== Results: SKIPPED ===\n"); return; }

  const base = mkdtempSync(join("/overlays", "wsjail-base-"));       // real non-repo base
  const stateDir = mkdtempSync(join("/home/node", "wsjail-state-")); // NOT under /tmp (jail tmpfs would hide it)
  writeFileSync(join(base, "file.txt"), "base\n");
  writeFileSync(join(stateDir, "session"), "orig\n");
  const root = `/overlays/wsjail-${process.pid}`;
  const baseEnv = { ...process.env, COW_WORKSPACE_ROOT: root, COW_WORKSPACE_BASE: base } as NodeJS.ProcessEnv;
  const jailEnv = { ...baseEnv, COW_WORKSPACE_JAIL: "1", COW_WORKSPACE_OVERLAY_EXTRA: stateDir };

  // run a single command inside workspace `id`; return true iff it exited 0 (writable).
  const canWrite = (env: NodeJS.ProcessEnv, id: string, cmd: string): boolean => {
    try { execSync(`bash "${SH}" run ${id} bash -c ${JSON.stringify(cmd)}`, { env, stdio: "ignore" }); return true; }
    catch { return false; }
  };

  try {
    ok("(jail) base overlay writable", canWrite(jailEnv, "jail", "echo x >> file.txt"));
    ok("(jail) extra-overlay state dir writable", canWrite(jailEnv, "jail", `echo x > ${stateDir}/session`));
    ok("(jail) /tmp (tmpfs) writable", canWrite(jailEnv, "jail", "echo x > /tmp/__wsjail"));
    ok("(jail) /var is READ-ONLY (denied)", !canWrite(jailEnv, "jail", "echo x > /var/__wsjail_leak"));
    ok("(jail) /usr is READ-ONLY (denied)", !canWrite(jailEnv, "jail", "echo x > /usr/__wsjail_leak"));
    ok("(jail) real state dir UNTOUCHED (write stayed in overlay upper)", readFileSync(join(stateDir, "session"), "utf8") === "orig\n");
    ok("(jail) no leak to /var or /usr", !existsSync("/var/__wsjail_leak") && !existsSync("/usr/__wsjail_leak"));

    // CONTRAST — jail OFF: writing to the extra path DOES hit the real fs.
    canWrite(baseEnv, "nojail", `echo NOJAIL > ${stateDir}/session`);
    ok("(contrast) jail OFF → write to state dir leaks to real fs (jail is what contains it)",
      readFileSync(join(stateDir, "session"), "utf8").startsWith("NOJAIL"));
  } finally {
    try { execSync(`bash "${SH}" cleanup-all`, { env: baseEnv, stdio: "ignore" }); } catch { /* */ }
    for (const p of ["/var/__wsjail_leak", "/usr/__wsjail_leak"]) { try { if (existsSync(p)) execSync(`sudo rm -f ${p}`); } catch { /* */ } }
    rmSync(base, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();
