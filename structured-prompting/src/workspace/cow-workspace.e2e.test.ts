/**
 * cow-workspace.e2e.test.ts — REAL overlayfs E2E for the GENERIC CowWorkspace
 * API. Nothing is mocked. Crucially, the base is a throwaway /tmp dir (NOT the
 * repo) — this proves the library carries no project-specific knowledge and
 * works over any tree.
 *
 * Requires CAP_SYS_ADMIN (user namespaces) + an ext4 `upperRoot` (the
 * `/overlays` volume). If absent, the suite SKIPS loudly (exit 0) rather than
 * failing — it only asserts when overlay is actually available.
 */
import { execSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createCowWorkspace } from "./cow-workspace.js";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

function overlayAvailable(): string | null {
  if (!existsSync("/overlays")) return "no /overlays volume";
  try { execSync("unshare -Urm --map-root-user true", { stdio: "ignore" }); }
  catch { return "user namespaces unavailable (SYS_ADMIN?)"; }
  return null;
}

function main() {
  console.log("\ncow-workspace E2E (REAL overlay over a /tmp base; nothing mocked)\n");
  const skip = overlayAvailable();
  if (skip) { console.log(`  ⚠ SKIP — ${skip} (needs SYS_ADMIN + /overlays). Not a failure.`); console.log("\n=== Results: SKIPPED ===\n"); return; }

  // GENERIC base: a throwaway /tmp dir (NOT a git repo, NOT the sashaslides repo).
  const base = mkdtempSync(join(tmpdir(), "cow-base-"));
  const upperRoot = "/overlays/cow-generic-e2e";
  const FILE = "hello.txt";
  const ORIGINAL = "original-content\n";
  writeFileSync(join(base, FILE), ORIGINAL);

  const ws = createCowWorkspace({ base, upperRoot, id: `cow-generic-${process.pid}` });

  try {
    // 1) run a command that EDITS a file inside the workspace.
    const r = ws.run("bash", ["-c", `echo "edited-in-workspace" >> ${FILE}`]);
    ok("(1) run() exits 0", r.code === 0, `code=${r.code} stderr=${r.stderr}`);

    // 2) changed() lists the edited file (non-git base ⇒ all upper files).
    const changed = ws.changed();
    ok("(2) changed() lists the edited file", changed.includes(FILE), `changed=${JSON.stringify(changed)}`);

    // 3) readUpperFile returns the NEW content (base + appended line).
    const upper = ws.readUpperFile(FILE);
    ok("(3) readUpperFile returns new content",
      upper !== null && upper.includes("original-content") && upper.includes("edited-in-workspace"),
      `upper=${JSON.stringify(upper)}`);

    // 4) BASE is UNTOUCHED (the edit stayed in the workspace's upper layer).
    const baseAfterEdit = readFileSync(join(base, FILE), "utf8");
    ok("(4) base tree untouched by the workspace edit", baseAfterEdit === ORIGINAL,
      `base=${JSON.stringify(baseAfterEdit)}`);

    // 5) writeUpperFile places a NEW file into upper without running a command.
    ws.writeUpperFile("placed.txt", "placed-by-merge");
    ok("(5) writeUpperFile lands in upper", ws.readUpperFile("placed.txt") === "placed-by-merge");
    ok("(5b) writeUpperFile did NOT touch base", !existsSync(join(base, "placed.txt")));

    // 6) a SECOND run in the SAME workspace SEES the first edit (upper persists).
    const seen = ws.run("bash", ["-c", `cat ${FILE}`]);
    ok("(6) second run sees the first edit (upper persists)",
      seen.stdout.includes("edited-in-workspace"), `stdout=${JSON.stringify(seen.stdout)}`);

    // 7) promote() copies changed-or-listed files from upper onto base.
    ws.promote();
    const baseAfterPromote = readFileSync(join(base, FILE), "utf8");
    ok("(7) promote() copies the changed file onto base",
      baseAfterPromote.includes("edited-in-workspace"), `base=${JSON.stringify(baseAfterPromote)}`);
    ok("(7b) promote() copies writeUpperFile'd file too",
      existsSync(join(base, "placed.txt")) && readFileSync(join(base, "placed.txt"), "utf8") === "placed-by-merge");

    // 8) cleanup() removes the on-disk workspace.
    ws.cleanup();
    ok("(8) cleanup() removes the workspace upper dir", !existsSync(ws.upperDir()),
      `upperDir=${ws.upperDir()}`);
  } finally {
    try { ws.cleanup(); } catch { /* */ }
    try { rmSync(base, { recursive: true, force: true }); } catch { /* */ }
    try { rmSync(join(upperRoot, ws.id), { recursive: true, force: true }); } catch { /* */ }
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
main();
