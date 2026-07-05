/**
 * IO abstraction for the engine and the CLI wrapper.
 *
 * The production `realIO` implementation wraps Node's `child_process.spawn`
 * and `fs` helpers. Tests replace it with `MockIO`, which records every
 * effect call in `.calls` and supplies return values through matchers.
 *
 * Everything the library does that touches the outside world MUST go through
 * this interface — that is the rule that makes tests deterministic.
 */

import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Buffer as NodeBuffer } from "node:buffer";

/**
 * Absolute path to the overlay-branch runner. When a spawn carries a
 * `branchId`, the command is re-wrapped as
 *   overlay-branch.sh run <branchId> -- <command> <args...>
 * so it executes inside that branch's namespace-local overlayfs mount (cwd =
 * merged working-tree root). Overridable via env for tests / relocations.
 */
const OVERLAY_BRANCH_SH =
  process.env.OVERLAY_BRANCH_SCRIPT ??
  resolve(process.cwd(), "renderer/structured-prompts/bug_solving/scripts/overlay-branch.sh");

// ---------- Shared types ----------------------------------------------------

export interface SpawnCaptureArgs {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** If set, the child is SIGTERM'd after this many ms and `timedOut` becomes true. */
  timeoutMs?: number;
  /** Owning graph node id — used by /api/cancel to SIGKILL the subset of
   *  live children that belong to a given subtree, without killing
   *  unrelated work. Engine populates this on every spawn. */
  nodeId?: string;
  /**
   * Opt-in overlay branch id. When set, the command is re-wrapped to run
   * INSIDE the named overlayfs branch (via overlay-branch.sh) — the branch
   * runner sets cwd = the merged working-tree root, so pass repo-relative
   * commands. Undefined = the command runs normally (byte-identical to the
   * pre-branch spawn). The `setpriv --pdeathsig` guard stays OUTSIDE the
   * branch wrapper so it still fires on engine death.
   */
  branchId?: string;
  /** Live stdout listener. Fires for every chunk as it arrives, BEFORE the
   *  child exits. Used by the scheduler's executeShell handler to surface
   *  `stdoutSoFar` on the graph node so the monitor UI sees output mid-run.
   *  Chunks may split mid-line (Node delivers OS read() buffers verbatim);
   *  callers that need line semantics should accumulate and split. */
  onStdout?: (chunk: string) => void;
  /** Live stderr listener — same contract as `onStdout`. */
  onStderr?: (chunk: string) => void;
}

export interface SpawnCaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  /** Populated when the spawn itself failed (e.g. binary not on PATH). */
  spawnError: string | null;
}

/**
 * Every effect routes through one of these methods. Keep this interface
 * small — new effects should be justified.
 */
export interface IO {
  /** Spawn a child process and collect stdout/stderr. Resolves when it exits. */
  spawnCapture(args: SpawnCaptureArgs): Promise<SpawnCaptureResult>;
  /** Create a unique temp directory with the given prefix. Returns its absolute path. */
  mkdtempSync(prefix: string): string;
  /** Write a buffer or string to `path` (atomically-enough for our purposes). */
  writeFileSync(path: string, data: NodeBuffer | string): void;
  /** Delete a file or directory, recursively if requested. */
  rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  /** Wall-clock time — replaced in tests by a controllable clock. */
  now(): number;
  /** Structured log. Default impl writes to stderr. */
  log(level: "info" | "warn" | "error", ...parts: unknown[]): void;
}

// ---------- realIO: production implementation ------------------------------

/**
 * Live children spawned by realIO. We register every spawn here so the
 * engine's shutdown can reap them — without this, killing the engine
 * (Ctrl-C, SIGTERM, uncaught exception) leaks claude CLI subprocesses
 * which Node has reparented to PID 1, where they keep burning model
 * tokens until they finish on their own.
 *
 * Each entry also carries the graph nodeId that owns the spawn so that
 * /api/cancel can target a specific subtree (e.g. "kill the slide_15
 * branch") without affecting siblings. `kill()` signals the child's
 * whole process group via `process.kill(-pid, …)`, catching any
 * grandchildren the agent itself forks (claude CLI tool-use shells).
 *
 * Exports:
 *   killAllSpawned      — engine.shutdown() and exit/SIGINT/SIGTERM use this.
 *   killSpawnedByNodeId — /api/cancel uses this to kill a specific subtree.
 */
interface LiveChild {
  pid: number;
  nodeId?: string;
  kill: (sig: NodeJS.Signals) => boolean;
}
const liveChildren = new Set<LiveChild>();

export function killAllSpawned(signal: NodeJS.Signals = "SIGTERM"): number {
  let killed = 0;
  for (const child of liveChildren) {
    try { if (child.kill(signal)) killed++; } catch { /* already gone */ }
  }
  liveChildren.clear();
  return killed;
}

/**
 * Kill every live spawn whose owning nodeId is in `nodeIds`. Returns the
 * number of process groups signaled. SIGKILL by default — when the user
 * cancels a branch, they don't want a graceful shutdown, they want the
 * tokens to stop accruing NOW.
 */
export function killSpawnedByNodeId(
  nodeIds: ReadonlySet<string>,
  signal: NodeJS.Signals = "SIGKILL",
): number {
  let killed = 0;
  for (const child of liveChildren) {
    if (child.nodeId && nodeIds.has(child.nodeId)) {
      try { if (child.kill(signal)) killed++; } catch { /* already gone */ }
      liveChildren.delete(child);
    }
  }
  return killed;
}

// Hard kill on hard exit (uncaught exception / process.exit). 'exit' is
// synchronous-only — no async work allowed — so we send SIGKILL to skip
// the SIGTERM grace period.
let exitHandlerInstalled = false;
function ensureExitHandler() {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on("exit", () => {
    for (const child of liveChildren) {
      try { child.kill("SIGKILL"); } catch {}
    }
  });
}

export const realIO: IO = {
  async spawnCapture(args: SpawnCaptureArgs): Promise<SpawnCaptureResult> {
    ensureExitHandler();
    const { command, args: procArgs, cwd, env, timeoutMs, nodeId, branchId } = args;
    // OPT-IN overlay branch: when branchId is set, rewrite (command,args) so the
    // command runs INSIDE that branch's overlayfs mount. This happens BEFORE the
    // setpriv wrap below, so the pdeathsig guard still wraps the whole thing.
    // When branchId is UNSET this is a no-op and the spawn is byte-identical.
    const effCommand = branchId ? "bash" : command;
    const effArgs = branchId
      ? [OVERLAY_BRANCH_SH, "run", branchId, command, ...procArgs]
      : procArgs;
    return new Promise<SpawnCaptureResult>((resolve) => {
      const spawnOpts: SpawnOptions = {
        cwd,
        env: (env ?? process.env) as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        // Detached so the child gets its own process group; we keep stdio
        // attached so the parent still proxies output. This lets us
        // signal the whole group (`process.kill(-pid, ...)`) on shutdown,
        // catching any grandchildren the claude CLI might fork.
        detached: true,
      };
      // Wrap every spawn with `setpriv --pdeathsig SIGKILL --` so the
      // KERNEL guarantees the child dies when this engine process dies,
      // for ANY reason (Ctrl-C, SIGKILL, OOM, segfault). PR_SET_PDEATHSIG
      // is a Linux prctl that fires immediately on parent death — no
      // dependence on JS shutdown handlers running. Without this, killing
      // the engine reparents children to PID 1 where they keep burning
      // model tokens until they finish on their own. setpriv is in
      // util-linux and present on every linux distro we run.
      const wrappedCommand = "setpriv";
      const wrappedArgs = ["--pdeathsig", "SIGKILL", "--", effCommand, ...effArgs];
      const child = spawn(wrappedCommand, wrappedArgs, spawnOpts);
      // child.kill by default signals just the child; we want the whole
      // group so claude's own subprocesses (e.g. tool-use shells) die too.
      const groupKiller: LiveChild = {
        pid: child.pid ?? -1,
        nodeId,
        kill(sig: NodeJS.Signals): boolean {
          if (child.pid == null || child.pid <= 0) return false;
          try {
            process.kill(-child.pid, sig);
            return true;
          } catch {
            try { return child.kill(sig); } catch { return false; }
          }
        },
      };
      liveChildren.add(groupKiller);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let spawnError: string | null = null;
      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs != null && timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try { groupKiller.kill("SIGTERM"); } catch {}
        }, timeoutMs);
      }
      child.stdout?.on("data", (d) => {
        const s = d.toString();
        stdout += s;
        if (args.onStdout) {
          try { args.onStdout(s); } catch { /* listener errors must not abort the spawn */ }
        }
      });
      child.stderr?.on("data", (d) => {
        const s = d.toString();
        stderr += s;
        if (args.onStderr) {
          try { args.onStderr(s); } catch { /* listener errors must not abort the spawn */ }
        }
      });
      child.on("error", (err) => {
        spawnError = err instanceof Error ? err.message : String(err);
        if (timer) clearTimeout(timer);
        liveChildren.delete(groupKiller);
        resolve({ stdout, stderr, exitCode: null, signal: null, timedOut, spawnError });
      });
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        liveChildren.delete(groupKiller);
        resolve({ stdout, stderr, exitCode: code, signal, timedOut, spawnError });
      });
    });
  },
  mkdtempSync(prefix) { return mkdtempSync(prefix); },
  writeFileSync(path, data) { writeFileSync(path, data); },
  rmSync(path, opts) { rmSync(path, opts); },
  now() { return Date.now(); },
  log(level, ...parts) {
    // eslint-disable-next-line no-console
    (level === "error" ? console.error : console.error)(...parts);
  },
};

// ---------- MockIO: matcher-based test double -------------------------------

/** A single recorded effect call. */
export interface EffectCall {
  method: keyof IO;
  args: unknown[];
  /** Wall-clock `Date.now()` at which the call was observed — handy for timing assertions. */
  at: number;
}

/**
 * A matcher binds a predicate on EffectCall to a return value (or a function
 * that produces one). Matchers can be stateful — the same matcher may fire
 * many times, and `returns` sees each call so it can vary its reply by
 * counter, by call args, etc.
 */
export interface Matcher<R = unknown> {
  /** Optional human-readable name for assertExhaustive error messages. */
  name?: string;
  /** Predicate — return true iff this matcher should answer the call. */
  when: (call: EffectCall) => boolean;
  /** Return value, or a function computing it from the call. */
  returns: R | ((call: EffectCall, callIndexForThisMatcher: number) => R);
  /** If true, it's OK if this matcher never fires. Default: false. */
  optional?: boolean;
}

export interface MockIOOptions {
  matchers: Array<Matcher<unknown>>;
}

export class MockIO implements IO {
  /** Every effect call, in order. Push-only. */
  readonly calls: EffectCall[] = [];
  /** Internal: per-matcher counter, parallel to `this.matchers`. */
  private readonly matchers: Array<Matcher<unknown> & { _calls: number }>;

  constructor(opts: MockIOOptions) {
    this.matchers = opts.matchers.map((m) => ({ ...m, _calls: 0 }));
  }

  /** Resolve a call through the matcher list with the single-match invariant. */
  private dispatch(method: keyof IO, args: unknown[]): unknown {
    const call: EffectCall = { method, args, at: Date.now() };
    this.calls.push(call);
    const hits: Array<Matcher<unknown> & { _calls: number }> = [];
    for (const m of this.matchers) {
      if (m.when(call)) hits.push(m);
    }
    if (hits.length === 0) {
      throw new Error(
        `MockIO: no matcher for ${String(method)}(${summarize(args)}). ` +
        `Add a matcher or widen an existing one.`,
      );
    }
    if (hits.length > 1) {
      const names = hits.map((h) => h.name ?? "<anonymous>").join(", ");
      throw new Error(
        `MockIO: ambiguous match for ${String(method)}(${summarize(args)}) — ` +
        `${hits.length} matchers fired: ${names}. Tighten predicates or remove duplicates.`,
      );
    }
    const picked = hits[0]!;
    const index = picked._calls;
    picked._calls++;
    return typeof picked.returns === "function"
      ? (picked.returns as (c: EffectCall, i: number) => unknown)(call, index)
      : picked.returns;
  }

  /**
   * Assert every non-optional matcher was fired at least once. Call this at
   * the end of a test. Matchers reused across multiple calls naturally pass.
   * Mark matchers that may go unused with `optional: true`.
   */
  assertExhaustive(): void {
    const unused = this.matchers.filter((m) => !m.optional && m._calls === 0);
    if (unused.length > 0) {
      const names = unused.map((m) => m.name ?? "<anonymous>").join(", ");
      throw new Error(
        `MockIO: ${unused.length} matcher(s) never fired: ${names}. ` +
        `Either remove them, mark them optional, or fix the code under test.`,
      );
    }
  }

  /** Convenience getter — all calls of a given method. */
  callsOf(method: keyof IO): EffectCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  // --- IO surface: every method delegates to dispatch -----------------------

  spawnCapture(args: SpawnCaptureArgs): Promise<SpawnCaptureResult> {
    return Promise.resolve(this.dispatch("spawnCapture", [args]) as SpawnCaptureResult);
  }
  mkdtempSync(prefix: string): string {
    return this.dispatch("mkdtempSync", [prefix]) as string;
  }
  writeFileSync(path: string, data: NodeBuffer | string): void {
    this.dispatch("writeFileSync", [path, data]);
  }
  rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void {
    this.dispatch("rmSync", [path, opts]);
  }
  now(): number {
    return this.dispatch("now", []) as number;
  }
  log(level: "info" | "warn" | "error", ...parts: unknown[]): void {
    this.dispatch("log", [level, ...parts]);
  }
}

function summarize(args: unknown[]): string {
  try {
    return args.map((a) => {
      if (a && typeof a === "object" && "command" in (a as Record<string, unknown>)) {
        const sa = a as SpawnCaptureArgs;
        return `{command:${JSON.stringify(sa.command)},args:[${sa.args.slice(0, 3).map((x) => JSON.stringify(x)).join(", ")}${sa.args.length > 3 ? ", …" : ""}]}`;
      }
      return JSON.stringify(a);
    }).join(", ");
  } catch {
    return "<unserialisable>";
  }
}
