/**
 * runCli — small wrapper around child_process.spawn that BOTH streams output
 * live AND captures it. When the child exits non-zero, throws a
 * CliCommandError carrying full stdout + stderr so error messages aren't
 * truncated to whatever the parent saw before the buffer rolled over.
 *
 * Why: `execSync` with `stdio: "inherit"` shows logs but discards them
 * once a command fails — by the time you read the error you've lost the
 * actual reason. `execSync` with `stdio: "pipe"` keeps the stderr but
 * surfaces it as a Buffer with no newline handling and no chance to
 * watch the command live. runCli does both: every chunk hits the parent
 * process's stdout/stderr (tee) AND lands in a string buffer (capture);
 * the error thrown on non-zero exit carries the full captured output.
 *
 * Used by every shell-out in renderer/structured-prompts/bug_solving so a
 * failing record-pptx / upload-and-scrape / pixel-diff surfaces with the
 * actual stderr in its `data` field — which the engine then propagates
 * up the graph and into the monitor.
 *
 *   const stdout = await runCli("npx", ["tsx", "x.ts"]);     // ok → stdout
 *   const stdout = await runCli("false", []);                // throws
 */
import { spawn, type SpawnOptions } from "node:child_process";

export interface RunCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional total time budget — child gets SIGTERM, then SIGKILL if it
   *  ignores SIGTERM. Default: no timeout (caller's responsibility). */
  timeoutMs?: number;
  /** Suppress live tee to the parent's stdio. Capture still happens. */
  silent?: boolean;
}

/**
 * Thrown by runCli when a child exits non-zero, fails to spawn, or
 * times out. Carries the full captured stdout + stderr alongside the
 * standard Error fields so log-only-on-error patterns work.
 */
export class CliCommandError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly cwd: string | undefined;
  constructor(opts: {
    command: string;
    args: readonly string[];
    cwd?: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    spawnError?: string;
  }) {
    const reason = opts.spawnError
      ? `spawn failed: ${opts.spawnError}`
      : opts.timedOut
        ? `timed out`
        : opts.signal != null
          ? `killed by ${opts.signal}`
          : `exited with code ${opts.exitCode}`;
    const cmdLine = [opts.command, ...opts.args].join(" ");
    super(
      `${reason}: ${cmdLine}\n` +
      (opts.stderr ? `stderr (last 800 chars):\n${opts.stderr.slice(-800)}\n` : "") +
      (opts.stdout ? `stdout (last 400 chars):\n${opts.stdout.slice(-400)}` : ""),
    );
    this.name = "CliCommandError";
    this.command = opts.command;
    this.args = opts.args;
    this.cwd = opts.cwd;
    this.exitCode = opts.exitCode;
    this.signal = opts.signal;
    this.timedOut = opts.timedOut;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
  }
}

/**
 * Spawn a command, tee each chunk to the parent's stdout/stderr in real
 * time, AND capture into string buffers. Resolves to stdout on success;
 * rejects with CliCommandError on any failure.
 */
export async function runCli(
  command: string,
  args: readonly string[],
  opts: RunCliOptions = {},
): Promise<string> {
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  };
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], spawnOpts);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError: string | undefined;
    let timer: NodeJS.Timeout | null = null;

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* already exited */ }
        // hard-kill if it doesn't respond within 1 s
        setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 1000).unref();
      }, opts.timeoutMs).unref();
    }

    child.stdout?.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (!opts.silent) process.stdout.write(s);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      if (!opts.silent) process.stderr.write(s);
    });
    child.on("error", (err) => {
      spawnError = err instanceof Error ? err.message : String(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const failed = spawnError != null || timedOut || code !== 0;
      if (!failed) {
        resolve(stdout);
        return;
      }
      reject(new CliCommandError({
        command, args, cwd: opts.cwd,
        exitCode: code, signal,
        timedOut, stdout, stderr, spawnError,
      }));
    });
  });
}
