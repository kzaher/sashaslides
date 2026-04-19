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
import type { Buffer as NodeBuffer } from "node:buffer";

// ---------- Shared types ----------------------------------------------------

export interface SpawnCaptureArgs {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** If set, the child is SIGTERM'd after this many ms and `timedOut` becomes true. */
  timeoutMs?: number;
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

export const realIO: IO = {
  async spawnCapture(args: SpawnCaptureArgs): Promise<SpawnCaptureResult> {
    const { command, args: procArgs, cwd, env, timeoutMs } = args;
    return new Promise<SpawnCaptureResult>((resolve) => {
      const spawnOpts: SpawnOptions = {
        cwd,
        env: (env ?? process.env) as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      };
      const child = spawn(command, procArgs, spawnOpts);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let spawnError: string | null = null;
      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs != null && timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try { child.kill("SIGTERM"); } catch {}
        }, timeoutMs);
      }
      child.stdout?.on("data", (d) => { stdout += d.toString(); });
      child.stderr?.on("data", (d) => { stderr += d.toString(); });
      child.on("error", (err) => {
        spawnError = err instanceof Error ? err.message : String(err);
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: null, signal: null, timedOut, spawnError });
      });
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
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
  matchers: Array<Matcher<any>>;
}

export class MockIO implements IO {
  /** Every effect call, in order. Push-only. */
  readonly calls: EffectCall[] = [];
  /** Internal: per-matcher counter, parallel to `this.matchers`. */
  private readonly matchers: Array<Matcher<any> & { _calls: number }>;

  constructor(opts: MockIOOptions) {
    this.matchers = opts.matchers.map((m) => ({ ...m, _calls: 0 }));
  }

  /** Resolve a call through the matcher list with the single-match invariant. */
  private dispatch(method: keyof IO, args: unknown[]): unknown {
    const call: EffectCall = { method, args, at: Date.now() };
    this.calls.push(call);
    const hits: Array<Matcher<any> & { _calls: number }> = [];
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
      if (a && typeof a === "object" && "command" in (a as any)) {
        const sa = a as SpawnCaptureArgs;
        return `{command:${JSON.stringify(sa.command)},args:[${sa.args.slice(0, 3).map((x) => JSON.stringify(x)).join(", ")}${sa.args.length > 3 ? ", …" : ""}]}`;
      }
      return JSON.stringify(a);
    }).join(", ");
  } catch {
    return "<unserialisable>";
  }
}
