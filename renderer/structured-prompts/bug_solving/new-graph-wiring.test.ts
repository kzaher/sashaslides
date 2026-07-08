/**
 * new-graph-wiring.test.ts — the pure helpers behind this session's graph
 * rewiring:
 *   • stabilityCommand (main.ts) — the shell command for the parallel "stability"
 *     branch node. Edge cases: NO_ACCEPT / SKIP_STABILITY → echo-skip; empty or
 *     unreadable deck → echo-skip; normal → the stability.ts CLI invocation with
 *     the right --slides/--attempts and the ALWAYS-exit-0 `|| echo` tail; the
 *     attempts knob (BUG_SOLVING_STABILITY_ATTEMPTS).
 *   • selectOnlyClusters (workspace-setup.ts) — the `--only` cluster filter.
 *     Edge cases: empty→all (fresh copy); exact task_id; substring; slide id;
 *     no-match→[].
 * Pure (env + fs only) — no engine, no overlays.
 */
import { stabilityCommand } from "./main.js";
import { selectOnlyClusters, type Cluster } from "./workspace-setup.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let passed = 0, failed = 0;
function ok(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
}

/** Run fn with the given env keys set, then restore (delete keys we set). */
function withEnv(keys: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(keys)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(keys)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fn(); }
  finally { for (const k of Object.keys(keys)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

// ---------------------------------------------------------------------------
// stabilityCommand
// ---------------------------------------------------------------------------
console.log("\nstabilityCommand — the parallel stability-branch shell command\n");

const repo = mkdtempSync(join(tmpdir(), "stabcmd-"));
const fxRel = "fx";
const fxAbs = join(repo, fxRel);
mkdirSync(fxAbs, { recursive: true });
writeFileSync(join(fxAbs, "slide_02.html"), "<html></html>");
writeFileSync(join(fxAbs, "slide_01.html"), "<html></html>");
writeFileSync(join(fxAbs, "notes.txt"), "ignored"); // non-fixture must be excluded

// clear both gating envs for the "normal" cases
withEnv({ BUG_SOLVING_NO_ACCEPT: undefined, BUG_SOLVING_SKIP_STABILITY: undefined, BUG_SOLVING_STABILITY_ATTEMPTS: undefined }, () => {
  const cmd = stabilityCommand({ repo, fixturesDirRel: fxRel });
  ok("(1) normal → invokes stability.ts CLI", /npx tsx .*stability\.ts/.test(cmd), cmd);
  ok("(1a) deck sorted + only slide_*.html (slide_01,slide_02; notes.txt excluded)", cmd.includes('--slides "slide_01,slide_02"'), cmd);
  ok("(1b) default --attempts 3", cmd.includes("--attempts 3"), cmd);
  ok("(1c) ALWAYS exit 0 (|| echo tail) so a flaky render can't cancel siblings", /\|\| echo /.test(cmd), cmd);
  ok("(1d) passes --out and --fixtures", cmd.includes("--out ") && cmd.includes(`--fixtures "${fxRel}"`), cmd);
});

withEnv({ BUG_SOLVING_NO_ACCEPT: undefined, BUG_SOLVING_SKIP_STABILITY: undefined, BUG_SOLVING_STABILITY_ATTEMPTS: "5" }, () => {
  const cmd = stabilityCommand({ repo, fixturesDirRel: fxRel });
  ok("(2) BUG_SOLVING_STABILITY_ATTEMPTS=5 honored", cmd.includes("--attempts 5"), cmd);
});

withEnv({ BUG_SOLVING_SKIP_STABILITY: "1" }, () => {
  const cmd = stabilityCommand({ repo, fixturesDirRel: fxRel });
  ok("(3) SKIP_STABILITY=1 → echo-skip, no CLI", /^echo /.test(cmd) && !cmd.includes("stability.ts"), cmd);
});

withEnv({ BUG_SOLVING_SKIP_STABILITY: undefined, BUG_SOLVING_NO_ACCEPT: "1" }, () => {
  const cmd = stabilityCommand({ repo, fixturesDirRel: fxRel });
  ok("(4) NO_ACCEPT=1 (acceptDisabled) → echo-skip, no CLI", /^echo /.test(cmd) && !cmd.includes("stability.ts"), cmd);
});

withEnv({ BUG_SOLVING_NO_ACCEPT: undefined, BUG_SOLVING_SKIP_STABILITY: undefined }, () => {
  const emptyRel = "empty";
  mkdirSync(join(repo, emptyRel), { recursive: true });
  const cmd = stabilityCommand({ repo, fixturesDirRel: emptyRel });
  ok("(5) empty deck → echo-skip (no fixtures)", /^echo .*no slide/.test(cmd), cmd);
  const cmd2 = stabilityCommand({ repo, fixturesDirRel: "does-not-exist" });
  ok("(5b) unreadable fixtures dir → echo-skip (no throw)", /^echo /.test(cmd2), cmd2);
});

// ---------------------------------------------------------------------------
// selectOnlyClusters
// ---------------------------------------------------------------------------
console.log("\nselectOnlyClusters — the --only cluster filter\n");

const mk = (task_id: string, slide_ids: string[]): Cluster => ({ task_id, cluster_description: "d", slide_ids });
const clusters: Cluster[] = [
  mk("slide-03-everything-moved-bit", ["slide_03"]),
  mk("slide-11-list-output-possible", ["slide_11"]),
  mk("slide-14-top-border-style", ["slide_14"]),
];

{
  const all = selectOnlyClusters(clusters, "");
  ok("(6) empty only → ALL clusters", all.length === 3);
  ok("(6a) empty only → a FRESH copy (not the same array ref)", all !== (clusters as unknown));
}
ok("(7) exact task_id match", selectOnlyClusters(clusters, "slide-11-list-output-possible").map((c) => c.task_id).join() === "slide-11-list-output-possible");
{
  const sub = selectOnlyClusters(clusters, "slide-03");
  ok("(8) substring match → the one cluster", sub.length === 1 && sub[0].task_id === "slide-03-everything-moved-bit");
}
{
  const bySlide = selectOnlyClusters(clusters, "slide_14");
  ok("(9) slide-id match", bySlide.length === 1 && bySlide[0].task_id === "slide-14-top-border-style");
}
ok("(10) no match → [] (caller decides to error/exit)", selectOnlyClusters(clusters, "nope-xyz").length === 0);
ok("(10a) whitespace-only only → treated as empty → ALL", selectOnlyClusters(clusters, "   ").length === 3);

rmSync(repo, { recursive: true, force: true });

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed) process.exit(1);
