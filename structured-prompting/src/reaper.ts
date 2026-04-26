/**
 * reaper.ts — engine supervisor that survives engine death and culls every
 * surviving descendant.
 *
 * WHY: setpriv --pdeathsig SIGKILL on each spawn protects ONE generation
 * (immediate children of the engine). Grandchildren — e.g. tool-use shells
 * spawned by the claude CLI itself — would orphan to PID 1 when the engine
 * dies and keep burning model tokens until they finish on their own.
 *
 * HOW: the engine spawns this script as a *detached* child (own session,
 * no setpriv wrap, stdio:ignore). It polls the engine PID. When the engine
 * vanishes, the reaper walks /proc to build a PPID map, BFSs the engine
 * PID's transitive descendant set, and SIGKILLs every PID in it. Then it
 * exits cleanly.
 *
 * SAFETY: the reaper never kills:
 *   * itself (process.pid is excluded from the kill list)
 *   * PID 1 / kthreadd / non-descendants of the engine
 *   * PIDs whose ancestor chain doesn't transitively reach engine PID
 *
 * Usage (called by engine.ts, not by humans):
 *   node /path/to/reaper.js <engine-pid> [--poll-ms N] [--max-depth N]
 *
 * Exit codes: 0 = clean reap, 2 = bad arguments.
 */
import { readdirSync, readFileSync } from "node:fs";

interface ReaperOptions {
  enginePid: number;
  pollMs: number;
  maxDepth: number;
  /** Test hook: callback invoked once the engine PID is observed dead. */
  onEngineDeath?: (descendantsKilled: number[]) => void;
  /** Test hook: callback invoked at every poll. */
  onPoll?: (engineAlive: boolean) => void;
}

/**
 * Walk every /proc/PID/stat once and return a PID → PPID map. Reads the
 * stat line's fields-after-comm-paren format so process names containing
 * spaces or parentheses don't confuse parsing.
 */
export function readProcessTree(): Map<number, number> {
  const out = new Map<number, number>();
  let entries: string[] = [];
  try { entries = readdirSync("/proc"); } catch { return out; }
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue;
    const pid = Number(ent);
    let stat: string;
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf-8"); }
    catch { continue; } // proc may have exited between readdir and now
    // Format: "PID (COMM with arbitrary chars) STATE PPID ...". COMM can
    // contain spaces and parens, so locate the LAST ')' as the boundary.
    const lastParen = stat.lastIndexOf(")");
    if (lastParen < 0) continue;
    const tail = stat.slice(lastParen + 2).split(" ");
    if (tail.length < 2) continue;
    const ppid = Number(tail[1]);
    if (Number.isFinite(ppid)) out.set(pid, ppid);
  }
  return out;
}

/**
 * Pure logic: given a PPID map and a root engine PID, return all PIDs whose
 * transitive parent chain reaches `enginePid`. The walk is iterative with a
 * depth cap so a malformed map (cycle or absurd depth) terminates.
 */
export function descendantsOf(
  procTree: Map<number, number>,
  enginePid: number,
  maxDepth: number,
  excludePid?: number,
): number[] {
  const out: number[] = [];
  for (const pid of procTree.keys()) {
    if (pid === enginePid) continue;
    if (excludePid != null && pid === excludePid) continue;
    let cur = pid;
    for (let depth = 0; depth < maxDepth; depth++) {
      const ppid = procTree.get(cur);
      if (ppid == null || ppid <= 1 || ppid === cur) break;
      if (ppid === enginePid) { out.push(pid); break; }
      cur = ppid;
    }
  }
  return out;
}

/** True iff a process with this PID currently exists (signal 0 = no-op). */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // exists, we just can't signal
    throw e;
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Main reaper loop. Exported for tests; the script entry point at the
 *  bottom of this file calls it with parsed argv.
 *
 *  Critical invariant: descendants must be tracked WHILE the engine is
 *  alive. The kernel reparents an engine's direct children to PID 1 as
 *  soon as the engine exits, so by the time we observe the death, /proc
 *  no longer remembers the engine→child link. We refresh a "known
 *  descendants" set every poll and use that frozen set to issue SIGKILLs
 *  after death. */
export async function runReaper(opts: ReaperOptions): Promise<number[]> {
  const knownDescendants = new Set<number>();
  for (;;) {
    const alive = isAlive(opts.enginePid);
    opts.onPoll?.(alive);
    if (!alive) break;
    // Refresh: every PID currently descended from engine is added to the
    // tracked set (we never REMOVE from the set — once a PID was a
    // descendant, it remains a target until it actually exits, which the
    // post-death loop handles via ESRCH).
    const tree = readProcessTree();
    for (const pid of descendantsOf(tree, opts.enginePid, opts.maxDepth, process.pid)) {
      knownDescendants.add(pid);
    }
    await sleep(opts.pollMs);
  }
  // Engine is dead. Issue SIGKILL to every PID we ever tracked. ESRCH is
  // fine — the process exited on its own between poll and now. We do
  // NOT do a fresh /proc walk here because the engine-→children edges
  // are already gone (kernel has reparented to PID 1).
  const victims = [...knownDescendants];
  for (const pid of victims) {
    try { process.kill(pid, "SIGKILL"); } catch { /* ESRCH = already gone */ }
  }
  opts.onEngineDeath?.(victims);
  return victims;
}

// ---- script entry point ----------------------------------------------------
// Only run when invoked as `node reaper.js <pid>` — `import` from tests is
// a no-op. We detect "is this the entrypoint?" via import.meta.url ===
// process.argv[1] resolved to a file URL.
const isEntry = (() => {
  try {
    const argvPath = process.argv[1];
    if (!argvPath) return false;
    return import.meta.url.endsWith(argvPath.split("/").pop() ?? "");
  } catch { return false; }
})();

if (isEntry) {
  const argv = process.argv.slice(2);
  let enginePid = -1;
  let pollMs = 500;
  let maxDepth = 200;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--poll-ms") pollMs = Number(argv[++i]);
    else if (argv[i] === "--max-depth") maxDepth = Number(argv[++i]);
    else if (enginePid < 0) enginePid = Number(argv[i]);
  }
  if (!Number.isFinite(enginePid) || enginePid <= 0) {
    process.stderr.write("usage: node reaper.js <engine-pid> [--poll-ms N] [--max-depth N]\n");
    process.exit(2);
  }
  runReaper({ enginePid, pollMs, maxDepth }).catch((e: unknown) => {
    process.stderr.write(`[reaper] crash: ${(e as Error)?.stack ?? String(e)}\n`);
    process.exit(1);
  });
}
