/**
 * Behavioral tests for the engine reaper.
 *
 * Three flavors:
 *   1. Pure logic — descendantsOf() against a fabricated PPID map.
 *   2. /proc — readProcessTree() returns this test's own PID with the
 *      correct PPID (sanity that the parser handles real proc output).
 *   3. End-to-end — spawn a fake "engine" Node process that itself
 *      spawns N children; start the reaper pointing at the fake engine;
 *      kill the fake engine; verify the reaper SIGKILLs every descendant
 *      and exits cleanly. Non-descendants stay alive.
 *
 * Run:
 *   npx tsx src/reaper.test.ts
 */
import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdtempSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  descendantsOf,
  isAlive,
  readProcessTree,
} from "./reaper.js";

let passed = 0;
let failed = 0;
const failures: Array<{ name: string; error: unknown }> = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    // eslint-disable-next-line no-console
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (e: unknown) {
    failed++;
    failures.push({ name, error: e });
    // eslint-disable-next-line no-console
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (e instanceof Error) {
      // eslint-disable-next-line no-console
      console.log(`      ${e.message.split("\n").slice(0, 8).join("\n      ")}`);
    }
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const HERE = dirname(fileURLToPath(import.meta.url));
const REAPER_SRC = resolve(HERE, "reaper.ts");

/**
 * Build a fake "engine" process tree:
 *   engine
 *   ├── child A
 *   │   └── grandchild AA  (depth 2)
 *   ├── child B
 *   └── child C
 * plus a peer process that's NOT a descendant of engine.
 *
 * Returns the engine PID + every descendant PID + the peer PID. Engine and
 * descendants run a `setsid sleep 600` so they sit idle waiting to be killed.
 */
async function spawnFakeTree(): Promise<{
  enginePid: number;
  descendants: number[];
  peerPid: number;
  cleanup: () => void;
}> {
  // The fake engine is a small bash script. It needs setsid so children get
  // their own session — closer to real-world (where setpriv with detached
  // does the same). The script writes its descendants' PIDs to a tmp file
  // so the test can read them back.
  const tmpDir = mkdtempSync(`${tmpdir()}/reaper-test-`);
  const pidFile = `${tmpDir}/pids`;
  const fakeEngine = `${tmpDir}/engine.sh`;
  writeFileSync(fakeEngine,
    `#!/bin/bash
# child A → grandchild AA
( sleep 600 & echo "AA $!" >> "${pidFile}"; sleep 600 ) &
echo "A $!" >> "${pidFile}"
# child B
sleep 600 &
echo "B $!" >> "${pidFile}"
# child C
sleep 600 &
echo "C $!" >> "${pidFile}"
sleep 600
`);
  spawnSync("chmod", ["+x", fakeEngine]);

  const engineProc = spawn(fakeEngine, [], { detached: true, stdio: "ignore" });
  engineProc.unref();
  const enginePid = engineProc.pid!;
  // The peer is an UNRELATED sleep — not a descendant of engine.
  const peerProc = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  peerProc.unref();
  const peerPid = peerProc.pid!;
  // Wait for the script to record its 4 descendants.
  let pids: string[] = [];
  for (let i = 0; i < 30; i++) {
    await sleep(100);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = await import("node:fs");
      const buf = fs.readFileSync(pidFile, "utf-8").trim();
      pids = buf.split("\n").filter(Boolean);
      if (pids.length >= 3) break;  // A, B, C; AA is a grandchild
    } catch { /* file not yet written */ }
  }
  // Parse "<label> <pid>" lines.
  const descendants: number[] = pids.map(l => Number(l.split(" ")[1])).filter(n => Number.isFinite(n));
  // Plus all transitive descendants (via /proc) — picks up AA the
  // grandchild that the script's subshell forked.
  await sleep(300);
  const tree = readProcessTree();
  const allDescendants = new Set<number>(descendants);
  for (const pid of tree.keys()) {
    let cur = pid;
    for (let d = 0; d < 100; d++) {
      const p = tree.get(cur);
      if (p == null || p <= 1) break;
      if (p === enginePid || allDescendants.has(p)) {
        allDescendants.add(pid); break;
      }
      cur = p;
    }
  }
  return {
    enginePid,
    descendants: [...allDescendants],
    peerPid,
    cleanup: () => {
      try { unlinkSync(pidFile); } catch {}
      try { unlinkSync(fakeEngine); } catch {}
      // Best-effort: kill anything we spawned that's still around.
      for (const pid of [enginePid, peerPid, ...allDescendants]) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    },
  };
}

/** Spawn the reaper script pointed at `enginePid`. */
function spawnReaper(enginePid: number): ChildProcess {
  return spawn("npx", ["tsx", REAPER_SRC, String(enginePid), "--poll-ms", "100"], {
    detached: true,
    stdio: "ignore",
  });
}

async function waitForExit(pid: number, maxMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (!isAlive(pid)) return true;
    await sleep(50);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async () => {
  // eslint-disable-next-line no-console
  console.log("\nreaper.test.ts");

  await test("descendantsOf: linear chain root→A→B→C", () => {
    const tree = new Map<number, number>([
      [100, 1],   // root engine
      [101, 100], // A
      [102, 101], // B
      [103, 102], // C
    ]);
    const got = descendantsOf(tree, 100, 200).sort();
    assert.deepEqual(got, [101, 102, 103]);
  });

  await test("descendantsOf: branching tree", () => {
    const tree = new Map<number, number>([
      [50, 1],
      [51, 50], [52, 50], [53, 50],
      [54, 51], [55, 51],
      [56, 53],
    ]);
    const got = descendantsOf(tree, 50, 200).sort((a, b) => a - b);
    assert.deepEqual(got, [51, 52, 53, 54, 55, 56]);
  });

  await test("descendantsOf: excludes peers (sibling subtree)", () => {
    const tree = new Map<number, number>([
      [10, 1],   // engine
      [11, 10],  // engine child
      [20, 1],   // peer (sibling of engine, NOT a descendant)
      [21, 20],  // peer's child
    ]);
    const got = descendantsOf(tree, 10, 200);
    assert.deepEqual(got, [11]);
  });

  await test("descendantsOf: respects depth cap (cycle defense)", () => {
    // PIDs 201 ↔ 202 form a cycle whose chain never reaches engine 200.
    // The depth cap must terminate the walk and the cycle pair must NOT
    // be classified as descendants. (200 itself has parent 1 — a normal
    // root — so its own subtree is empty.)
    const tree = new Map<number, number>([
      [200, 1],
      [201, 202],
      [202, 201],
    ]);
    const got = descendantsOf(tree, 200, 5);
    assert.deepEqual(got, []);
  });

  await test("descendantsOf: does not include the engine itself", () => {
    const tree = new Map<number, number>([[300, 1], [301, 300]]);
    const got = descendantsOf(tree, 300, 200);
    assert.equal(got.includes(300), false);
    assert.deepEqual(got, [301]);
  });

  await test("descendantsOf: excludePid skips the reaper itself", () => {
    const tree = new Map<number, number>([[400, 1], [401, 400], [402, 400]]);
    const got = descendantsOf(tree, 400, 200, /*excludePid=*/401).sort();
    assert.deepEqual(got, [402]);
  });

  await test("readProcessTree returns this test's own PID with correct PPID", () => {
    const tree = readProcessTree();
    const pid = process.pid;
    const ppid = tree.get(pid);
    assert.equal(typeof ppid, "number", `our pid ${pid} should appear in /proc`);
    assert.equal(ppid, process.ppid, `PPID for ${pid} should match process.ppid`);
  });

  await test("isAlive: this process is alive", () => {
    assert.equal(isAlive(process.pid), true);
  });

  await test("isAlive: PID 99999999 is dead", () => {
    assert.equal(isAlive(99999999), false);
  });

  // ---- end-to-end --------------------------------------------------------
  await test("end-to-end: reaper kills entire descendant tree on engine death", async () => {
    const tree = await spawnFakeTree();
    try {
      // Sanity: every reported descendant is alive before we kill engine.
      for (const pid of tree.descendants) {
        assert.equal(isAlive(pid), true, `descendant ${pid} should be alive`);
      }
      assert.equal(isAlive(tree.peerPid), true, "peer should be alive");

      // Start the reaper. `npx tsx` adds ~1-2s of cold-start so we wait
      // up to 5s for it to enter the poll loop before killing the engine.
      const reaper = spawnReaper(tree.enginePid);
      for (let i = 0; i < 50 && !isAlive(reaper.pid!); i++) await sleep(100);
      await sleep(2000);  // give the loaded reaper time to enter polling

      // Kill the engine — should trigger reaping of the descendants.
      process.kill(tree.enginePid, "SIGKILL");

      // Reaper should:
      //   (a) Notice engine is dead (within ≤ poll-ms + epsilon)
      //   (b) Walk /proc, kill each descendant
      //   (c) Exit cleanly
      // 5s budget covers slow CI.
      await sleep(5000);

      for (const pid of tree.descendants) {
        const alive = isAlive(pid);
        assert.equal(alive, false, `descendant ${pid} should have been reaped, but is still alive`);
      }
      // Peer (non-descendant) MUST survive.
      assert.equal(isAlive(tree.peerPid), true, "peer should NOT have been killed by reaper");

      // Reaper should have terminated.
      const reaperExited = await waitForExit(reaper.pid!, 3000);
      assert.equal(reaperExited, true, "reaper process should have exited after culling");
    } finally {
      tree.cleanup();
    }
  });

  await test("end-to-end: reaper does NOT kill non-descendants of the engine", async () => {
    const tree = await spawnFakeTree();
    try {
      // Spawn a SECOND independent tree; its root is NOT a descendant of
      // the engine the reaper is watching, so it must survive untouched.
      const otherRoot = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
      otherRoot.unref();
      const otherPid = otherRoot.pid!;

      const reaper = spawnReaper(tree.enginePid);
      for (let i = 0; i < 50 && !isAlive(reaper.pid!); i++) await sleep(100);
      await sleep(2000);
      process.kill(tree.enginePid, "SIGKILL");
      await sleep(5000);

      assert.equal(isAlive(otherPid), true, "unrelated process should not be killed");
      assert.equal(isAlive(tree.peerPid), true, "peer should not be killed");
      // Cleanup the unrelated sleep.
      try { process.kill(otherPid, "SIGKILL"); } catch {}
      // Wait for reaper.
      await waitForExit(reaper.pid!, 3000);
    } finally {
      tree.cleanup();
    }
  });

  // ---- summary ------------------------------------------------------------
  // eslint-disable-next-line no-console
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) {
      // eslint-disable-next-line no-console
      console.log(`\n[fail] ${f.name}`);
      // eslint-disable-next-line no-console
      console.log(f.error);
    }
    process.exit(1);
  }
})().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
