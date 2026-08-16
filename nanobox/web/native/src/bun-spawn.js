// Bun.spawn / Bun.spawnSync / Bun.which / Bun.Terminal — the child-process half of the Bun global.
// Nothing runs in the worker: every child is started by the syscall backend (src/backend.js), which
// in the sandbox means a real process inside the emulated Linux guest, and its output arrives as
// `on("proc", …)` events. What this file adds is Bun's shape on top of that — a Subprocess whose
// `stdout` is a ReadableStream with Bun's `.text()` helper, an `exited` promise, and a Terminal that
// asks the backend for a pty (guest only — a backend without one fails the spawn, which is the
// failure the bundle's bg-pty-host path already handles).
import { Buffer } from "buffer";
import { X_OK } from "./backend.js";
import { errnoError } from "./errors.js";
import { BunFile, concat } from "./bun-file.js";
import { noteMissing } from "./record.js";

export function makeSpawn(ctx) {
  const backend = ctx.B;

  function spawn(first, second) {
    const options = Array.isArray(first) ? Object.assign({}, second, { cmd: first }) : first || {};
    const command = (options.cmd || []).map(String);
    if (!command.length) throw new TypeError("Bun.spawn: cmd must be a non-empty array");
    const stdio = stdioOf(options);
    const spec = { file: command[0], args: command.slice(1), cwd: options.cwd ? String(options.cwd) : ctx.proc.cwd(), env: options.env || ctx.proc.env, stdio, pty: !!options.terminal };
    let started;
    try { started = backend.call("spawn", spec); } catch (e) { started = { error: e.__errno || "ENOENT" }; }
    if (started.error) throw spawnError(started.error, spec);

    const subprocess = new Subprocess(backend, started.pid, stdio, ctx.proc);
    if (options.terminal) options.terminal.attach(subprocess);
    const off = backend.on("proc", (event) => {
      if (event.pid !== subprocess.pid) return;
      if (event.stream) { subprocess.receive(event.stream, event.data); return; }
      if (event.exit === undefined) return;
      off();
      subprocess.finish(event.exit, event.signal || null);
      if (options.onExit) options.onExit(subprocess, subprocess.exitCode, subprocess.signalCode, undefined);
    });
    return subprocess;
  }

  function spawnSync(first, second) {
    const options = Array.isArray(first) ? Object.assign({}, second, { cmd: first }) : first || {};
    const command = (options.cmd || []).map(String);
    if (!command.length) throw new TypeError("Bun.spawnSync: cmd must be a non-empty array");
    const spec = { file: command[0], args: command.slice(1), cwd: options.cwd ? String(options.cwd) : ctx.proc.cwd(), env: options.env || ctx.proc.env, stdio: stdioOf(options) };
    let result;
    try { result = backend.call("spawnSync", spec); } catch (e) { result = { error: e.__errno || "ENOENT" }; }
    if (result.error) throw spawnError(result.error, spec);
    const status = result.status == null ? null : result.status;
    return {
      pid: result.pid || 0, exitCode: status, signalCode: result.signal || null, success: status === 0,
      stdout: Buffer.from(result.stdout || new Uint8Array(0)), stderr: Buffer.from(result.stderr || new Uint8Array(0)),
      resourceUsage: null,
    };
  }

  // Bun.which(cmd, {PATH, cwd}) -> the absolute path of an executable on PATH, or null
  function which(command, options) {
    const name = String(command);
    if (!name) return null;
    const cwd = (options && options.cwd) || ctx.proc.cwd();
    if (name.includes("/")) { const candidate = ctx.path.resolve(cwd, name); return executable(backend, candidate) ? candidate : null; }
    const search = (options && options.PATH) || ctx.proc.env.PATH || "/usr/local/bin:/usr/bin:/bin";
    for (const directory of search.split(":")) {
      if (!directory) continue;
      const candidate = ctx.path.resolve(cwd, directory, name);
      if (executable(backend, candidate)) return candidate;
    }
    return null;
  }

  // `new Bun.Terminal({cols, rows, data})` then `Bun.spawn(cmd, {terminal})`: the child runs on a
  // pty in the guest, so its output is the terminal's `data` callback and `write()` is its keyboard.
  class Terminal {
    constructor(options) {
      this.cols = (options && options.cols) || 80;
      this.rows = (options && options.rows) || 24;
      this.#data = (options && options.data) || (() => {});
    }
    #data;
    #subprocess = null;

    write(chunk) { if (this.#subprocess) this.#subprocess.write(chunk); }
    resize(cols, rows) {
      this.cols = cols; this.rows = rows;
      noteMissing("Bun.Terminal.resize", "call"); // the shim has no TIOCSWINSZ op yet: size is fixed at spawn
    }
    close() { if (this.#subprocess) this.#subprocess.kill("SIGHUP"); }
    // called by spawn() once the pty child exists — the terminal is constructed before it
    attach(subprocess) { this.#subprocess = subprocess; subprocess.onOutput = (chunk) => this.#data(this, chunk); }
  }

  return { spawn, spawnSync, which, Terminal };
}

// Bun's Subprocess: `exited` resolves with the exit code, `stdout`/`stderr` are ReadableStreams
// carrying Bun's `.text()`/`.json()`/`.bytes()` helpers, `stdin` is a FileSink.
class Subprocess {
  constructor(backend, pid, stdio, proc) {
    this.pid = pid;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.onOutput = null; // set when a Bun.Terminal owns this child
    this.#backend = backend;
    this.#proc = proc;
    this.exited = new Promise((resolve) => { this.#settle = resolve; });
    this.stdin = stdio[0] === "pipe" ? sink(backend, pid) : undefined;
    this.#out = stdio[1] === "pipe" ? outputStream() : null;
    this.#err = stdio[2] === "pipe" ? outputStream() : null;
    this.stdout = this.#out ? this.#out.stream : undefined;
    this.stderr = this.#err ? this.#err.stream : undefined;
    this.#stdio = stdio;
  }
  #backend; #proc; #settle; #out; #err; #stdio;

  kill(signal) { this.killed = true; this.#backend.call("procKill", this.pid, signal === undefined ? "SIGTERM" : signal); return true; }
  ref() {} unref() {}
  write(chunk) { this.#backend.call("procInput", this.pid, chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk))); }

  // fed by the backend's "proc" events
  receive(stream, data) {
    if (this.onOutput) { this.onOutput(data); return; }
    const target = stream === "stderr" ? this.#err : this.#out;
    if (target) { target.push(data); return; }
    if (this.#stdio[stream === "stderr" ? 2 : 1] === "inherit") (stream === "stderr" ? this.#proc.stderr : this.#proc.stdout).write(Buffer.from(data));
  }
  finish(exitCode, signal) {
    this.exitCode = exitCode; this.signalCode = signal;
    if (this.#out) this.#out.close();
    if (this.#err) this.#err.close();
    this.#settle(exitCode === null ? 0 : exitCode);
  }
  async [Symbol.asyncDispose]() { if (this.exitCode === null) this.kill(); await this.exited; }
}

// Bun's default stdio for a spawned child: stdin closed, stdout captured, stderr inherited
function stdioOf(options) {
  const given = Array.isArray(options.stdio) ? options.stdio : [options.stdin, options.stdout, options.stderr];
  const fallback = ["ignore", "pipe", "inherit"];
  return given.map((entry, index) => kindOf(entry, fallback[index]));
}

function kindOf(entry, fallback) {
  if (entry === undefined || entry === null) return fallback;
  if (entry === "pipe" || entry === "inherit" || entry === "ignore") return entry;
  if (entry instanceof BunFile || typeof entry === "number") {
    // a file/descriptor as a child's stream: the backend cannot hand a child an fd of ours, so the
    // stream is dropped (the bundle uses this only for a best-effort stderr breadcrumb file)
    noteMissing("Bun.spawn.stdio(file)", "call");
    return "ignore";
  }
  noteMissing("Bun.spawn.stdio(" + typeof entry + ")", "call");
  return fallback;
}

function spawnError(code, spec) {
  const error = errnoError(code, "spawn " + spec.file, spec.file);
  error.spawnargs = spec.args;
  return error;
}

function executable(backend, candidate) {
  try { backend.call("access", candidate, X_OK); return true; } catch { return false; }
}

// a ReadableStream the backend pushes into, plus the consumers Bun puts on it
function outputStream() {
  let controller = null;
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const bytes = async () => {
    const chunks = [];
    const reader = stream.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    return concat(chunks);
  };
  stream.bytes = bytes;
  stream.text = async () => new TextDecoder().decode(await bytes());
  stream.json = async () => JSON.parse(new TextDecoder().decode(await bytes()));
  stream.arrayBuffer = async () => { const all = await bytes(); return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength); };
  return {
    stream,
    push(data) { controller.enqueue(data instanceof Uint8Array ? data : new Uint8Array(data)); },
    close() { try { controller.close(); } catch { /* a consumer may have cancelled it */ } },
  };
}

function sink(backend, pid) {
  return {
    write(chunk) { const bytes = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk)); backend.call("procInput", pid, bytes); return bytes.length; },
    flush() { return 0; },
    end() { backend.call("procInput", pid, null); return 0; },
    start() {}, ref() {}, unref() {},
  };
}
