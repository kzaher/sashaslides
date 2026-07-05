/**
 * main-merge-final.test.ts — unit tests for the FINAL merge phase's green
 * selection (main.ts: selectGreenClusters / finalMergePhase). NO real git /
 * Chrome / Google: the marker-reader, the demote, and the merge-runner are all
 * injected.
 *
 * Asserted:
 *   (1) a GREEN marker (green:true) → cluster INCLUDED in the mergePhase clusters,
 *       NOT demoted.
 *   (2) a green:false marker → cluster EXCLUDED + demoteForResolve called with its
 *       slides + a reason.
 *   (3) a MISSING marker (null) → cluster EXCLUDED + demoted (reason mentions no
 *       marker).
 *   (4) BUG_SOLVING_NO_ACCEPT=1 → finalMergePhase is a no-op (no marker read, no
 *       demote, no merge; report is null).
 *   (5) finalMergePhase, run on the REAL engine with an injected runMerge, hands
 *       the merge-runner EXACTLY the green set (and demotes the rest).
 *   (6) main() still returns Array<Result<TaskResult>> (shape check on the graph
 *       result via a mocked engine).
 *
 * Run: cd /workspaces/sashaslides && npx tsx renderer/structured-prompts/bug_solving/main-merge-final.test.ts
 */
import { strict as assert } from "node:assert";
import { ClaudeEngine, Session } from "../../../structured-prompting/src/index.js";
import {
  MockIO,
  type EffectCall,
  type Matcher,
  type SpawnCaptureArgs,
  type SpawnCaptureResult,
} from "../../../structured-prompting/src/server/io.js";
import {
  selectGreenClusters,
  finalMergePhase,
  type Task,
  type RatingOutcomeMarker,
} from "./main.js";
import type { MergeCluster, MergeReport } from "./merge-phase.js";

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------
let passed = 0, failed = 0;
const failures: Array<{ name: string; err: unknown }> = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; failures.push({ name, err: e }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`      ${((e as Error)?.message ?? String(e)).split("\n").slice(0, 8).join("\n      ")}`); }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function mkTask(task_id: string, slideIds: string[]): Task {
  return {
    task_id,
    branch_id: `bs-${task_id}-test`,
    workspace_dir: `/wt/${task_id}`,
    scratch_dir: `/wt/${task_id}/.scratch`,
    analysis_dir: `/wt/${task_id}/.analysis`,
    fixtures_dir: "renderer/html2slides/e2e/fixtures",
    server_port: 4720,
    presentation_title: `bug_solving-${task_id}-1`,
    slides: slideIds.map((slide_id) => ({
      slide_id,
      html_file: `/fx/${slide_id}.html`,
      user_comment: "",
      rendered_png: `/tmp/${slide_id}.png`,
      original_png: `/tmp/${slide_id}.orig.png`,
    })),
    cluster_description: "",
    retry_budget: 1,
  };
}
function greenMarker(task_id: string, slides: string[]): RatingOutcomeMarker {
  return { task_id, rated: true, green: true, good: slides, bad: [], unrated: [], slides };
}
function badMarker(task_id: string, slides: string[], bad: string[]): RatingOutcomeMarker {
  return { task_id, rated: true, green: false, good: slides.filter((s) => !bad.includes(s)), bad, unrated: [], slides };
}

interface DemoteCall { slides: string[]; cluster: string; reason: string; }
function makeSelectionDeps(markers: Record<string, RatingOutcomeMarker | null>) {
  const demotes: DemoteCall[] = [];
  return {
    demotes,
    readMarker: (t: Task) => markers[t.task_id] ?? null,
    demote: (slides: string[], cluster: string, reason: string) => { demotes.push({ slides: [...slides], cluster, reason }); },
    log: () => {},
  };
}

// MockIO reply builders (mirror merge-phase.test.ts)
function bashReply(stdout = ""): SpawnCaptureResult {
  return { stdout, stderr: "", exitCode: 0, signal: null, timedOut: false, spawnError: null };
}
function baseMatchers(): Matcher[] {
  return [
    { name: "now", when: (c) => c.method === "now", returns: (_c: EffectCall, i: number) => 1_700_000_000_000 + i },
    { name: "log", when: (c) => c.method === "log", returns: undefined, optional: true },
    { name: "bash-echo", when: (c) => c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "bash", returns: bashReply(""), optional: true },
    { name: "git-diff-capture", when: (c) => c.method === "spawnCapture" && (c.args[0] as SpawnCaptureArgs).command === "git", returns: bashReply(""), optional: true },
  ];
}
function emptyReport(): MergeReport { return { accepted: [], rejected: [], conflicts: [], perSlide: {} }; }

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------
async function main() {
  console.log("\nmain-merge-final tests (green selection + finalMergePhase, injected marker/demote/merge)\n");

  // (1) green marker → included, not demoted.
  await test("(1) green marker → cluster INCLUDED in green set, not demoted", () => {
    const tasks = [mkTask("clip", ["slide_01", "slide_02"])];
    const deps = makeSelectionDeps({ clip: greenMarker("clip", ["slide_01", "slide_02"]) });
    const { green, classified } = selectGreenClusters(tasks, deps);
    assert.deepEqual(green.map((g) => g.task), ["clip"], "green cluster included");
    assert.deepEqual(green[0].slides, ["slide_01", "slide_02"], "cluster carries its slides");
    assert.equal(classified[0].green, true);
    assert.equal(deps.demotes.length, 0, "green cluster NOT demoted");
  });

  // (2) green:false marker → excluded + demoted.
  await test("(2) green:false (bad) marker → EXCLUDED + demoteForResolve called", () => {
    const tasks = [mkTask("border", ["slide_10", "slide_11"])];
    const deps = makeSelectionDeps({ border: badMarker("border", ["slide_10", "slide_11"], ["slide_11"]) });
    const { green } = selectGreenClusters(tasks, deps);
    assert.deepEqual(green, [], "bad cluster not green");
    assert.equal(deps.demotes.length, 1, "demoted once");
    assert.deepEqual(deps.demotes[0].slides, ["slide_10", "slide_11"], "demote gets whole targeted set");
    assert.ok(/slide_11/.test(deps.demotes[0].reason) && /bad/.test(deps.demotes[0].reason), "reason names the bad slide");
  });

  // (3) missing marker (null) → excluded + demoted (reason mentions no marker).
  await test("(3) missing marker → EXCLUDED + demoted (reason mentions no marker)", () => {
    const tasks = [mkTask("failed", ["slide_20"])];
    const deps = makeSelectionDeps({ failed: null });
    const { green } = selectGreenClusters(tasks, deps);
    assert.deepEqual(green, [], "no-marker cluster excluded");
    assert.equal(deps.demotes.length, 1, "demoted");
    assert.ok(/no rating marker/i.test(deps.demotes[0].reason), "reason mentions the missing marker");
  });

  // (+) mixed set → exactly the green ones survive, the rest demoted.
  await test("(+) mixed → only green survive, rest demoted", () => {
    const tasks = [mkTask("g1", ["s1"]), mkTask("r1", ["s2"]), mkTask("g2", ["s3"]), mkTask("m1", ["s4"])];
    const deps = makeSelectionDeps({
      g1: greenMarker("g1", ["s1"]),
      r1: badMarker("r1", ["s2"], ["s2"]),
      g2: greenMarker("g2", ["s3"]),
      m1: null,
    });
    const { green } = selectGreenClusters(tasks, deps);
    assert.deepEqual(green.map((g) => g.task), ["g1", "g2"], "only the two green survive");
    assert.deepEqual(deps.demotes.map((d) => d.cluster).sort(), ["m1", "r1"], "both non-green demoted");
  });

  // (4) NO_ACCEPT → finalMergePhase is a no-op (null report, no marker read/demote/merge).
  await test("(4) BUG_SOLVING_NO_ACCEPT=1 → finalMergePhase no-op (null report, no read/demote/merge)", async () => {
    const io = new MockIO({ matchers: baseMatchers() });
    const engine = new ClaudeEngine({ io, persist: false, hookSignals: false, log: false, port: 0 });
    const tasks = [mkTask("clip", ["slide_01"])];
    let readCount = 0, demoteCount = 0, mergeCount = 0;
    let report: MergeReport | null = emptyReport();
    try {
      report = await engine.execute(new Session({ sessionId: "mf-noaccept", cwd: "/repo" }), (s) =>
        finalMergePhase(s, {
          repo: "/repo", tasks,
          readMarker: () => { readCount++; return greenMarker("clip", ["slide_01"]); },
          demote: () => { demoteCount++; },
          runMerge: (ss) => { mergeCount++; return ss.executeShell(() => "echo x").combineWith<string, MergeReport>((b) => b.executeShell(() => "echo y"), () => emptyReport()); },
          disabled: () => true, // force NO_ACCEPT regardless of env
          log: () => {},
        }),
      );
    } finally { await engine.shutdown(); }
    assert.equal(report, null, "no-op returns a null report");
    assert.equal(readCount, 0, "no marker read under NO_ACCEPT");
    assert.equal(demoteCount, 0, "no demote under NO_ACCEPT");
    assert.equal(mergeCount, 0, "no merge under NO_ACCEPT");
  });

  // (5) real engine + injected runMerge → merge-runner gets EXACTLY the green set.
  await test("(5) finalMergePhase (engine) → runMerge receives exactly the green set; rest demoted", async () => {
    const io = new MockIO({ matchers: baseMatchers() });
    const engine = new ClaudeEngine({ io, persist: false, hookSignals: false, log: false, port: 0 });
    const tasks = [mkTask("g1", ["s1"]), mkTask("r1", ["s2"]), mkTask("g2", ["s3"])];
    const markers: Record<string, RatingOutcomeMarker | null> = {
      g1: greenMarker("g1", ["s1"]),
      r1: badMarker("r1", ["s2"], ["s2"]),
      g2: greenMarker("g2", ["s3"]),
    };
    const demotes: DemoteCall[] = [];
    let mergeReceived: MergeCluster[] | null = null;
    let report: MergeReport | null = null;
    try {
      report = await engine.execute(new Session({ sessionId: "mf-real", cwd: "/repo" }), (s) =>
        finalMergePhase(s, {
          repo: "/repo", tasks,
          readMarker: (t) => markers[t.task_id] ?? null,
          demote: (slides, cluster, reason) => { demotes.push({ slides: [...slides], cluster, reason }); },
          runMerge: (ss, green) => {
            mergeReceived = green.map((g) => ({ ...g }));
            return ss.executeShell(() => "echo merge").combineWith<string, MergeReport>(
              (b) => b.executeShell(() => "echo done"),
              () => ({ ...emptyReport(), accepted: green.map((g) => g.task) }),
            );
          },
          disabled: () => false,
          log: () => {},
        }),
      );
    } finally { await engine.shutdown(); }
    assert.ok(mergeReceived != null, "runMerge was invoked");
    assert.deepEqual((mergeReceived as MergeCluster[]).map((g) => g.task), ["g1", "g2"], "merge-runner got exactly the green set");
    assert.deepEqual(demotes.map((d) => d.cluster).sort(), ["r1"], "only the red task demoted");
    assert.ok(report != null && report.accepted.sort().join(",") === "g1,g2", "report reflects the accepted green clusters");
  });

  // (6) no green at all → runMerge NOT called, null report, every task demoted.
  await test("(6) no green → runMerge not called, null report, all demoted", async () => {
    const io = new MockIO({ matchers: baseMatchers() });
    const engine = new ClaudeEngine({ io, persist: false, hookSignals: false, log: false, port: 0 });
    const tasks = [mkTask("r1", ["s1"]), mkTask("m1", ["s2"])];
    const demotes: DemoteCall[] = [];
    let mergeCalls = 0;
    let report: MergeReport | null = emptyReport();
    try {
      report = await engine.execute(new Session({ sessionId: "mf-nogreen", cwd: "/repo" }), (s) =>
        finalMergePhase(s, {
          repo: "/repo", tasks,
          readMarker: (t) => (t.task_id === "r1" ? badMarker("r1", ["s1"], ["s1"]) : null),
          demote: (slides, cluster, reason) => { demotes.push({ slides: [...slides], cluster, reason }); },
          runMerge: (ss) => { mergeCalls++; return ss.executeShell(() => "echo x").combineWith<string, MergeReport>((b) => b.executeShell(() => "echo y"), () => emptyReport()); },
          disabled: () => false,
          log: () => {},
        }),
      );
    } finally { await engine.shutdown(); }
    assert.equal(mergeCalls, 0, "runMerge NOT called with no green");
    assert.equal(report, null, "null report when nothing green");
    assert.deepEqual(demotes.map((d) => d.cluster).sort(), ["m1", "r1"], "both non-green demoted");
  });

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed) { for (const f of failures) console.error(`FAIL ${f.name}: ${(f.err as Error)?.message ?? f.err}`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
