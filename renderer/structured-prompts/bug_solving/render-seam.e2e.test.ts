/**
 * render-seam.e2e.test.ts — pins the merge-render PATH HANDSHAKE that the mocked
 * merge-e2e tests structurally cannot see. Those tests obey the 3-mock policy and
 * stub the Google-Slides recording seam (`recordingFromContent`), so the real
 * `renderMergeDeck` shell-out never runs. Two bugs hid there and made EVERY
 * production merge render empty → the gate diffed a full baseline against nothing
 * → every slide "rippled" → nothing ever merged:
 *   (1) `cd renderer && npx tsx renderer/…/record-rendering.ts` doubled to
 *       `renderer/renderer/…` → ERR_MODULE_NOT_FOUND (render never started).
 *   (2) `--out "$PWD/../<abs /tmp path>"` wrote inside the overlay's namespace-
 *       local tree (torn down when runShell returns), NOT where recordFromDir read.
 *
 * (A) is a pure invariant test on `mergeRenderCommand` — always runs, no overlay
 * or Google, and would have caught BOTH bugs. (B) is an overlay + `--mode pptx`
 * render over the real repo (no Google) proving the output actually lands at the
 * host path we read from.
 */
import { strict as assert } from "node:assert";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { mergeRenderCommand } from "./llm-merge.js";
import { createCowWorkspace } from "../../../cow-workspace/cow-workspace.js";
import type { CowWorkspace } from "../../../cow-workspace/cow-workspace.js";

let passed = 0, failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; failures.push({ name, err: e }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`      ${((e as Error)?.message ?? String(e)).split("\n").slice(0, 6).join("\n      ")}`); }
}
function overlayAvailable(): string | null {
  if (!existsSync("/overlays")) return "no /overlays volume";
  try { execSync("unshare -Urm --map-root-user true", { stdio: "ignore" }); } catch { return "user namespaces unavailable (SYS_ADMIN?)"; }
  return null;
}
const REC_REL = "renderer/structured-prompts/bug_solving/scripts/record-rendering.ts";

async function main(): Promise<void> {
  console.log("\nmerge render-seam — path handshake (would have caught the empty-render → total-ripple bug)\n");

  // (A) PURE invariants — no overlay, no Google. This is the regression guard.
  await test("(A) mergeRenderCommand: no doubled renderer/, output read from the overlay UPPER", () => {
    const ws = { upperDir: () => "/overlays/branches/x/upper" } as unknown as CowWorkspace;
    const { cmd, outDir } = mergeRenderCommand(ws, {
      recRel: REC_REL,
      fixturesDir: "/repo/renderer/html2slides/e2e/fixtures",
      slidesCsv: "slide_01,slide_02",
      outRel: ".gate-render-0",
      title: "t",
    });
    // Bug (1): the script path must be relative to renderer/ (no doubling).
    assert.ok(!/renderer\/renderer/.test(cmd), `doubled renderer/ in command: ${cmd}`);
    assert.ok(/\bcd renderer &&/.test(cmd), "runs from the renderer dir");
    assert.ok(cmd.includes('"structured-prompts/bug_solving/scripts/record-rendering.ts"'), "script path relative to renderer/");
    // Bug (2): output goes to the overlay repo-root (→ copies up into UPPER) and
    // is READ from that same UPPER location — never an absolute /tmp path.
    assert.ok(cmd.includes('--out "../.gate-render-0"'), `--out must target the overlay repo root: ${cmd}`);
    assert.ok(!/--out\s+"\$PWD/.test(cmd) && !/--out\s+"\/tmp/.test(cmd), "must NOT write to $PWD/.. or an absolute /tmp path");
    assert.equal(outDir, "/overlays/branches/x/upper/.gate-render-0", "reads from the SAME upper dir the render writes to");
  });

  // (B) REAL overlay render (--mode pptx, no Google) over the real repo → output
  //     must actually appear at the host path we read. Catches both bugs E2E.
  const skip = overlayAvailable();
  await test("(B) real in-overlay render lands host-visible pptx at the read dir (--mode pptx)", async () => {
    if (skip) { console.log(`      ⚠ SKIP — ${skip} (needs SYS_ADMIN + /overlays). Not a failure.`); return; }
    const repo = process.cwd().replace(/\/renderer\/structured-prompts\/bug_solving.*$/, "");
    if (!existsSync(join(repo, REC_REL))) { console.log(`      ⚠ SKIP — record-rendering.ts not found under ${repo}`); return; }
    const id = `render-seam-${process.pid}-${Math.floor(process.hrtime()[1])}`;
    const ws = createCowWorkspace({ base: repo, id });
    try {
      const { cmd, outDir } = mergeRenderCommand(ws, {
        recRel: REC_REL,
        fixturesDir: join(repo, "renderer/html2slides/e2e/fixtures"),
        slidesCsv: "slide_01",
        outRel: ".gate-render-probe",
        title: "render-seam-probe",
        mode: "pptx", // local pptx only — no Google upload, so this stays offline/fast
      });
      const r = ws.runShell(cmd);
      assert.equal(r.code, 0, `render exited non-zero:\n${(r.stderr || "").split("\n").slice(-8).join("\n")}`);
      const pptxDir = join(outDir, "pptx");
      assert.ok(existsSync(pptxDir), `no pptx dir at the read path ${pptxDir} — the render output did not land where recordFromDir reads`);
      assert.ok(readdirSync(pptxDir).some((f) => f.endsWith(".pptx")), `pptx dir ${pptxDir} is empty`);
    } finally {
      try { ws.cleanup(); } catch { /* */ }
      try { rmSync(join("/overlays/branches", id), { recursive: true, force: true }); } catch { /* */ }
    }
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) { for (const f of failures) console.log(`  ✗ ${f.name}\n    ${(f.err as Error)?.stack ?? String(f.err)}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
