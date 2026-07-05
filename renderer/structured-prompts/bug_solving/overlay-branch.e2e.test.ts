/**
 * overlay-branch.e2e.test.ts — REAL overlayfs E2E (no mocks). Exercises the
 * actual zero-copy branch setup: userns (`unshare -Urm --map-root-user`) +
 * overlayfs mount over the working tree on the `/overlays` ext4 volume, plus the
 * death/startup cleanup. NOTHING is mocked — real mounts, real fs, real cleanup.
 *
 * Requires the container caps (`--cap-add=SYS_ADMIN --security-opt
 * apparmor=unconfined`) + the `/overlays` volume. If they're absent, the suite
 * SKIPS loudly (exit 0) rather than failing — it only asserts when overlay is
 * actually available (so it can't false-pass in a plain CI box).
 */
import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync, appendFileSync, readFileSync } from "fs";
import { resolve } from "path";

const REPO = "/workspaces/sashaslides";
const SH = `${REPO}/structured-prompting/src/workspace/workspace.sh`;
const ROOT = "/overlays/e2e-branches"; // isolated root so we never touch a live run's branches
const env = { ...process.env, OVERLAY_BRANCH_ROOT: ROOT };
const CANARY = "renderer/html2slides/convert-pptx.ts"; // a real tracked converter file

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}
function sh(cmd: string): string {
  return execSync(cmd, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
/** run a command inside a branch, return stdout */
function inBranch(id: string, bash: string): string {
  return execSync(`bash "${SH}" run ${id} bash -c ${JSON.stringify(bash)}`, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function overlayAvailable(): string | null {
  if (!existsSync("/overlays")) return "no /overlays volume";
  try { execSync("unshare -Urm --map-root-user true", { stdio: "ignore" }); }
  catch { return "user namespaces unavailable (SYS_ADMIN?)"; }
  return null;
}

function main() {
  console.log("\noverlay-branch E2E (REAL userns + overlayfs; nothing mocked)\n");
  const skip = overlayAvailable();
  if (skip) { console.log(`  ⚠ SKIP — ${skip} (needs SYS_ADMIN + /overlays). Not a failure.`); console.log("\n=== Results: SKIPPED ===\n"); return; }

  // clean slate + ensure base canary content known
  try { sh(`bash "${SH}" cleanup-all`); } catch { /* */ }
  const baseCanary = readFileSync(resolve(REPO, CANARY), "utf8");

  try {
    // 1) CREATE is O(1), zero copy — upper empty right after mount.
    inBranch("b1", "true");
    const upper1 = `${ROOT}/b1/upper`;
    const filesAtCreate = existsSync(upper1) ? sh(`find ${upper1} -type f | wc -l`).trim() : "0";
    ok("(1) create is zero-copy (upper has 0 files after mount)", filesAtCreate === "0", `upper files=${filesAtCreate}`);

    // 2) edit inside a branch is ISOLATED; base untouched.
    inBranch("b2", `echo "// e2e-b2" >> ${CANARY}`);
    const baseNow = readFileSync(resolve(REPO, CANARY), "utf8");
    ok("(2) edit isolated — base working tree unchanged", baseNow === baseCanary, "base canary was modified!");
    const b2sees = inBranch("b2b", `tail -1 ${CANARY}`); // fresh branch: must NOT see b2's edit
    ok("(2b) per-branch isolation — new branch doesn't see another's edit", !b2sees.includes("e2e-b2"));

    // 3) changed lists the TRACKED changed file.
    inBranch("b3", `echo "// e2e-b3" >> ${CANARY}`);
    const changed = sh(`bash "${SH}" changed b3`).trim().split("\n").filter(Boolean);
    ok("(3) changed lists the edited tracked file", changed.includes(CANARY), `changed=${JSON.stringify(changed)}`);

    // 4) gitignore honored — a change to an IGNORED path is NOT reported as changed.
    inBranch("b4", `echo x > node_modules/.e2e-ignored-probe 2>/dev/null || true; echo "// e2e-b4" >> ${CANARY}`);
    const changed4 = sh(`bash "${SH}" changed b4`).trim().split("\n").filter(Boolean);
    ok("(4) gitignore honored — ignored file not in changed set",
      changed4.every(f => !f.includes("node_modules")) && changed4.includes(CANARY), `changed=${JSON.stringify(changed4)}`);

    // 5) copy-up semantics — inspect upper from OUTSIDE after the branch exits
    //    (upper persists on /overlays). READ a 165KB file, MODIFY the canary,
    //    CREATE a new file, all in one branch.
    inBranch("b5", "cat renderer/html2slides/extract-dom.ts > /dev/null"); // READ only
    inBranch("b5", `echo x >> ${CANARY}`);                                  // MODIFY (same branch, same upper)
    inBranch("b5", "echo brand > newfile_e2e.txt");                         // NEW file
    const upFiles = sh(`cd ${ROOT}/b5/upper && find . -type f | sed 's|^\\./||' | sort`).trim().split("\n").filter(Boolean);
    ok("(5) read never copies up (extract-dom.ts NOT in upper despite being read)",
      !upFiles.some(f => f.endsWith("extract-dom.ts")), `upper=${JSON.stringify(upFiles)}`);
    ok("(5b) modify copies up the edited file", upFiles.some(f => f.endsWith("convert-pptx.ts")), `upper=${JSON.stringify(upFiles)}`);
    ok("(5c) new file lands in upper (no copy-up needed)", upFiles.some(f => f.endsWith("newfile_e2e.txt")), `upper=${JSON.stringify(upFiles)}`);

    // 6) cleanup-all reaps every branch + leaves 0 mounts.
    const before = sh(`ls ${ROOT} 2>/dev/null | wc -l`).trim();
    sh(`bash "${SH}" cleanup-all`);
    const after = existsSync(ROOT) ? sh(`ls ${ROOT} 2>/dev/null | wc -l`).trim() : "0";
    const mounts = sh(`mount | grep -c ${ROOT} || true`).trim();
    ok("(6) cleanup-all reaps all branches", Number(before) > 0 && after === "0", `before=${before} after=${after}`);
    ok("(6b) no overlay mounts leaked into host ns", mounts === "0", `mounts=${mounts}`);

    // 7) death-handler + startup-sweep via the real overlay-cleanup module.
    //    (a) startup sweep wipes a stale branch; (b) 'exit' handler reaps on normal exit.
    mkdirSync(`${ROOT}/stale_kill9/upper`, { recursive: true });
    const driver = "/tmp/ov-e2e-driver.mjs";
    writeFileSync(driver, `
      process.env.OVERLAY_BRANCH_ROOT = ${JSON.stringify(ROOT)};
      const { registerOverlayCleanup } = await import(${JSON.stringify(resolve(REPO, "renderer/structured-prompts/bug_solving/overlay-cleanup.ts"))});
      const { execSync } = await import("child_process");
      registerOverlayCleanup();                       // startup sweep runs here
      const afterSweep = execSync("ls ${ROOT} 2>/dev/null | wc -l").toString().trim();
      execSync('bash ${SH} run exitbr bash -c true'); // create a branch
      const created = execSync("ls ${ROOT} 2>/dev/null | wc -l").toString().trim();
      console.log("SWEEP=" + afterSweep + " CREATED=" + created);
      process.exit(0);                                // triggers 'exit' handler → reaps
    `);
    const out = execSync(`npx tsx ${driver}`, { env, encoding: "utf8" });
    const sweep = /SWEEP=(\d+)/.exec(out)?.[1];
    const created = /CREATED=(\d+)/.exec(out)?.[1];
    const afterExit = existsSync(ROOT) ? sh(`ls ${ROOT} 2>/dev/null | wc -l`).trim() : "0";
    ok("(7) startup sweep wipes a stale (kill -9) branch", sweep === "0", `afterSweep=${sweep}`);
    ok("(7b) 'exit' death-handler reaps branches on normal exit", created === "1" && afterExit === "0", `created=${created} afterExit=${afterExit}`);
    rmSync(driver, { force: true });
  } finally {
    try { sh(`bash "${SH}" cleanup-all`); } catch { /* */ }
    // hard-assert we left the base working tree exactly as we found it
    const finalCanary = readFileSync(resolve(REPO, CANARY), "utf8");
    ok("(final) base working tree restored byte-for-byte", finalCanary === baseCanary);
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();
