// Bun.file / Bun.write / Bun.stdin / Bun.stdout / Bun.stderr — Bun's blob-shaped file API. Every
// byte still travels through the syscall backend (src/backend.js), so a BunFile is nothing but a
// lazy path: no read happens until .text()/.bytes()/.stream() is awaited, which is exactly what the
// bundle relies on when it hands `Bun.file(sock)` to Bun.spawn as a stderr breadcrumb without ever
// checking whether the file exists.
import { O } from "./backend.js";
import { rethrow } from "./errors.js";
import { noteMissing } from "./record.js";

export function makeFile(ctx) {
  const backend = ctx.B;
  const file = (target, options) => new BunFile(backend, target, options);
  const write = async (destination, data) => {
    const target = destination instanceof BunFile ? destination.name : String(destination);
    const bytes = toBytes(data);
    await backend.callAsync("writeFile", target, bytes, "w", 0o666).catch((e) => rethrow(e, "writeFile", target));
    return bytes.length;
  };
  return { file, write, stdin: standardIn(ctx), stdout: standardOut(ctx, 1), stderr: standardOut(ctx, 2) };
}

export class BunFile {
  #backend;
  #target; // an absolute path, or a file descriptor when Bun.file(fd) was used
  #type;

  constructor(backend, target, options) {
    this.#backend = backend;
    this.#target = typeof target === "number" ? target : pathOf(target);
    this.name = typeof this.#target === "number" ? "" : this.#target;
    this.#type = (options && options.type) || null;
  }

  get size() { const stat = this.#stat(); return stat ? stat.size : 0; }
  get lastModified() { const stat = this.#stat(); return stat ? stat.mtimeMs : 0; }
  get type() { return this.#type || mimeOf(this.name); }

  async exists() {
    try { await this.#backend.callAsync("stat", this.#target, true); return true; } catch { return false; }
  }
  async bytes() {
    try { return new Uint8Array(await this.#backend.callAsync("readFile", this.#target)); }
    catch (e) { return rethrow(e, "open", this.name); }
  }
  async text() { return new TextDecoder().decode(await this.bytes()); }
  async json() { return JSON.parse(await this.text()); }
  async arrayBuffer() { const bytes = await this.bytes(); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
  stream() {
    const read = () => this.bytes();
    return new ReadableStream({
      async pull(controller) { controller.enqueue(await read()); controller.close(); },
    });
  }
  async delete() { await this.#backend.callAsync("unlink", this.#target).catch((e) => rethrow(e, "unlink", this.name)); }
  unlink() { return this.delete(); }

  // Bun.file(x).writer() -> a FileSink: buffered writes against one open descriptor
  writer(options) {
    const backend = this.#backend, path = this.name;
    const flags = options && options.append ? O.WRONLY | O.CREAT | O.APPEND : O.WRONLY | O.CREAT | O.TRUNC;
    let fd = null, written = 0;
    const open = () => { if (fd === null) { try { fd = backend.call("open", path, flags, 0o666); } catch (e) { rethrow(e, "open", path); } } return fd; };
    return {
      write(chunk) { const bytes = toBytes(chunk); backend.call("write", open(), bytes, null); written += bytes.length; return bytes.length; },
      flush() { if (fd !== null) { try { backend.call("fsync", fd); } catch { /* fsync is advisory here */ } } return written; },
      end() { if (fd !== null) { backend.call("close", fd); fd = null; } return written; },
      start() {}, ref() {}, unref() {},
    };
  }

  #stat() {
    try { return this.#backend.call("stat", this.#target, true); } catch { return null; }
  }
}

function pathOf(target) {
  if (typeof target === "string") return target.startsWith("file://") ? decodeURIComponent(new URL(target).pathname) : target;
  if (target instanceof URL) return decodeURIComponent(target.pathname);
  if (Array.isArray(target)) return target.join("/");
  return String(target);
}

function toBytes(data) {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data));
}

const MIME = { json: "application/json;charset=utf-8", js: "text/javascript;charset=utf-8", md: "text/markdown;charset=utf-8", txt: "text/plain;charset=utf-8", html: "text/html;charset=utf-8", css: "text/css;charset=utf-8", toml: "application/toml;charset=utf-8", yaml: "text/yaml;charset=utf-8", yml: "text/yaml;charset=utf-8" };
function mimeOf(name) {
  const dot = name.lastIndexOf(".");
  return (dot > 0 && MIME[name.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
}

// Bun.stdout/Bun.stderr are BunFile-shaped sinks; the bytes go where the shims' process.stdout sends
// them (the page's terminal through the backend), so writing here and writing there stay in order.
function standardOut(ctx, fd) {
  // resolved per write: process.stdout/stderr are wired up around the same time this object is built
  const target = () => (fd === 2 ? ctx.proc.stderr : ctx.proc.stdout);
  const sink = { write(chunk) { const bytes = toBytes(chunk); target().write(bytes); return bytes.length; }, flush() { return 0; }, end() { return 0; }, start() {}, ref() {}, unref() {} };
  return { fd, name: fd === 2 ? "/dev/stderr" : "/dev/stdout", size: 0, type: "text/plain;charset=utf-8", writer: () => sink, write: sink.write, flush: sink.flush, end: sink.end, exists: async () => true };
}

function standardIn(ctx) {
  const readable = () => new ReadableStream({
    start(controller) {
      ctx.proc.stdin.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
      ctx.proc.stdin.on("end", () => { try { controller.close(); } catch { /* already closed */ } });
    },
  });
  const collect = async () => {
    const chunks = [];
    const reader = readable().getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    return concat(chunks);
  };
  return {
    fd: 0, name: "/dev/stdin", size: 0, type: "text/plain;charset=utf-8",
    stream: readable, bytes: collect,
    async text() { return new TextDecoder().decode(await collect()); },
    async json() { return JSON.parse(new TextDecoder().decode(await collect())); },
    async arrayBuffer() { const bytes = await collect(); return bytes.buffer; },
    async exists() { return true; },
    writer() { noteMissing("Bun.stdin.writer", "call"); throw new Error("Bun.stdin is not writable"); },
  };
}

export function concat(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}
