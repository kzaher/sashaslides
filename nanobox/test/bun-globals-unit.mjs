#!/usr/bin/env node
// Unit test of the `Bun` global (web/native/src/bun-globals.js + bun-text/bun-hash/bun-spawn/bun-file)
// in node: no browser, no worker — the syscall backend is a fake object implementing the handful of
// operations the shim uses, so every assertion is about OUR code, not about the guest.
//   node test/bun-globals-unit.mjs
import path from "node:path";
import { fileURLToPath } from "node:url";
import stringWidthImpl from "../web/native/node_modules/string-width/index.js";
import wrapAnsiImpl from "../web/native/node_modules/wrap-ansi/index.js";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { makeBun } = await import(path.join(HERE, "../web/native/src/bun-globals.js"));

const ESC = "\u001B";
let bad = 0;
const check = (ok, what, detail) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : "  " + detail}`); if (!ok) bad++; };

// --- the fake backend: files it can read, executables it admits, children it can run -------------
function fakeBackend(setup) {
  const listeners = new Map();
  const emit = (kind, event) => { for (const fn of listeners.get(kind) || []) fn(event); };
  const enc = new TextEncoder();
  const ops = {
    stat(p) { const data = setup.files[p]; if (data === undefined) throw { __errno: "ENOENT", syscall: "stat", path: p }; return { size: enc.encode(data).length, mtimeMs: 1 }; },
    readFile(p) { const data = setup.files[p]; if (data === undefined) throw { __errno: "ENOENT", syscall: "open", path: p }; return enc.encode(data); },
    access(p) { if (!setup.executables.includes(p)) throw { __errno: "ENOENT", syscall: "access", path: p }; },
    spawn(spec) {
      const child = setup.children[spec.file];
      if (!child) return { error: "ENOENT" };
      backend.spawned.push(spec);
      const pid = 100 + backend.spawned.length;
      queueMicrotask(() => {
        if (child.stdout) emit("proc", { pid, stream: "stdout", data: enc.encode(child.stdout) });
        emit("proc", { pid, exit: child.exit, signal: null });
      });
      return { pid };
    },
    spawnSync(spec) {
      const child = setup.children[spec.file];
      if (!child) return { error: "ENOENT" };
      return { pid: 1, status: child.exit, signal: null, stdout: enc.encode(child.stdout || ""), stderr: new Uint8Array(0) };
    },
    procInput(pid, bytes) { backend.written.push(bytes); },
    procKill() { return true; },
  };
  const backend = {
    spawned: [], written: [],
    call(op, ...args) { const fn = ops[op]; if (!fn) throw { __errno: "ENOSYS", syscall: op }; return fn(...args); },
    callAsync(op, ...args) { try { return Promise.resolve(backend.call(op, ...args)); } catch (e) { return Promise.reject(e); } },
    on(kind, fn) { if (!listeners.has(kind)) listeners.set(kind, new Set()); listeners.get(kind).add(fn); return () => listeners.get(kind).delete(fn); },
  };
  return backend;
}

const B = fakeBackend({
  files: { "/etc/hello": "hi there\n", "/root/.claude.json": '{"a":1}' },
  executables: ["/usr/bin/rg", "/bin/echo"],
  children: { "/bin/echo": { stdout: "ripgrep 14.1.0\n", exit: 0 }, "/bin/sh": { stdout: "$ ", exit: 0 } },
});
const proc = {
  cwd: () => "/root",
  env: { PATH: "/usr/bin:/bin", HOME: "/root" },
  argv: ["bun", "/usr/local/bin/claude"],
  stdout: { write: () => true }, stderr: { write: () => true }, stdin: { on: () => {} },
};
const Bun = makeBun({ B, fs: null, path, os: null, child_process: null, proc, require: () => null });

// --- text: stringWidth / wrapAnsi / stripANSI ----------------------------------------------------
check(Bun.stringWidth("hello") === 5, "stringWidth ascii");
check(Bun.stringWidth("古池や蛙飛び込む") === 16, "stringWidth CJK (2 columns each)", Bun.stringWidth("古池や蛙飛び込む"));
check(Bun.stringWidth("a👍b") === 4, "stringWidth emoji", Bun.stringWidth("a👍b"));
check(Bun.stringWidth(`${ESC}[31mred${ESC}[0m`) === 3, "stringWidth ignores ANSI");
check(Bun.stringWidth(undefined) === 0, "stringWidth of a non-string is 0");
const samples = ["", " ", "a", "hello world", "  padded  ", "trailing ", "a-very-long-word-here", "x".repeat(40)];
check(samples.every((s) => Bun.stringWidth(s) === stringWidthImpl(s)), "stringWidth ascii fast path == string-width");
check(samples.every((s) => [1, 5, 11, 80].every((w) => Bun.wrapAnsi(s, w) === wrapAnsiImpl(s, w))), "wrapAnsi ascii fast path == wrap-ansi");
const wrapped = Bun.wrapAnsi(`${ESC}[31mhello world${ESC}[0m`, 5);
check(wrapped.includes("\n") && wrapped.includes(`${ESC}[31m`) && wrapped.includes(`${ESC}[0m`), "wrapAnsi keeps the escape sequences", JSON.stringify(wrapped));
check(Bun.wrapAnsi("hello", 0) === "hello", "wrapAnsi with no width is a no-op");
check(Bun.stripANSI(`${ESC}[1m${ESC}[31mred${ESC}[0m`) === "red", "stripANSI");
check(Bun.stripANSI("plain") === "plain", "stripANSI leaves plain text alone");
// the memo of the slow path must not change an answer, including after its generations have rolled
const unicode = "✻ 古池や — thinking about a rather long line of mixed text";
const cold = stringWidthImpl(unicode), coldWrap = wrapAnsiImpl(unicode, 24);
for (let index = 0; index < 6000; index++) Bun.stringWidth("filler-" + index + "-古");
check(Bun.stringWidth(unicode) === cold && Bun.stringWidth(unicode) === cold, "stringWidth memo answers what string-width answers", cold);
check(Bun.wrapAnsi(unicode, 24) === coldWrap && Bun.wrapAnsi(unicode, 24) === coldWrap, "wrapAnsi memo answers what wrap-ansi answers");

// --- hash ----------------------------------------------------------------------------------------
const h1 = Bun.hash("the quick brown fox");
check(h1 === Bun.hash("the quick brown fox"), "hash is deterministic", h1);
check(Number.isInteger(h1) && h1 >= 0 && h1 <= Number.MAX_SAFE_INTEGER, "hash is a safe integer");
check(Bun.hash("a") !== Bun.hash("b"), "hash separates inputs");
check(Bun.hash("x", 1) !== Bun.hash("x", 2) && Bun.hash("x", 1) === Bun.hash("x", 1), "hash honours the seed");
check(Bun.hash("x", Bun.hash("y")) === Bun.hash("x", Bun.hash("y")), "hash accepts a hash as its seed (the bundle's cache keys)");
check(Bun.hash(new TextEncoder().encode("the quick brown fox")) === h1, "hash of the utf-8 bytes == hash of the string");
check(Bun.hash.crc32("123456789") === 0xcbf43926, "hash.crc32 matches the reference vector", Bun.hash.crc32("123456789").toString(16));
check(Bun.hash.adler32("Wikipedia") === 0x11e60398, "hash.adler32 matches the reference vector", Bun.hash.adler32("Wikipedia").toString(16));

// --- deepEquals ----------------------------------------------------------------------------------
check(Bun.deepEquals({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), "deepEquals nested");
check(!Bun.deepEquals({ a: 1 }, { a: 1, b: 2 }), "deepEquals extra key");
check(Bun.deepEquals({ a: 1, b: undefined }, { a: 1 }), "deepEquals loose: undefined == missing");
check(!Bun.deepEquals({ a: 1, b: undefined }, { a: 1 }, true), "deepEquals strict: undefined != missing");
check(Bun.deepEquals(NaN, NaN) && !Bun.deepEquals(0, -0), "deepEquals NaN/-0 like Object.is");
check(!Bun.deepEquals([1, 2], { 0: 1, 1: 2 }), "deepEquals array != object");
check(Bun.deepEquals(new Date(5), new Date(5)) && !Bun.deepEquals(new Date(5), new Date(6)), "deepEquals dates");
check(Bun.deepEquals(new Map([["a", 1]]), new Map([["a", 1]])) && Bun.deepEquals(new Set([1]), new Set([1])), "deepEquals Map/Set");
check(Bun.deepEquals(new Uint8Array([1, 2]), new Uint8Array([1, 2])) && !Bun.deepEquals(new Uint8Array([1]), new Uint8Array([2])), "deepEquals typed arrays");

// --- semver --------------------------------------------------------------------------------------
check(Bun.semver.order("1.2.3", "1.2.4") === -1, "semver.order patch");
check(Bun.semver.order("2.0.0", "10.0.0") === -1, "semver.order is numeric, not lexicographic");
check(Bun.semver.order("1.2.3", "1.2.3") === 0, "semver.order equal");
check(Bun.semver.order("1.2.3-beta.1", "1.2.3") === -1, "semver.order prerelease sorts below the release");
check(Bun.semver.order("1.2.3-beta.2", "1.2.3-beta.10") === -1, "semver.order numeric prerelease identifiers");
check(Bun.semver.order("v1.2.3+build", "1.2.3") === 0, "semver.order ignores v prefix and build metadata");

// --- YAML / TOML ---------------------------------------------------------------------------------
const doc = { name: "skill", tools: ["read", "write"], meta: { hidden: false, count: 3 } };
check(Bun.deepEquals(Bun.YAML.parse(Bun.YAML.stringify(doc, null, 2)), doc), "YAML round trip");
check(Bun.YAML.parse("a: 1\nb:\n  - x\n  - y\n").b[1] === "y", "YAML.parse block sequences");
check(Bun.YAML.parse("") === null && Bun.deepEquals(Bun.YAML.parse("a: 1\n---\nb: 2\n"), [{ a: 1 }, { b: 2 }]), "YAML.parse of several documents is an array (a skill file is --- delimited)");
let yamlFailed = false;
try { Bun.YAML.parse("a:\n- 1\n  b: [\n"); } catch { yamlFailed = true; }
check(yamlFailed, "YAML.parse throws on a broken document");
const toml = Bun.TOML.parse('title = "x"\n[owner]\nname = "y"\nport = 8093\n');
check(toml.title === "x" && toml.owner.name === "y" && toml.owner.port === 8093, "TOML.parse");

// --- which ---------------------------------------------------------------------------------------
check(Bun.which("rg") === "/usr/bin/rg", "which hit on PATH", Bun.which("rg"));
check(Bun.which("nope") === null, "which miss");
check(Bun.which("/bin/echo") === "/bin/echo", "which of an absolute path");
check(Bun.which("rg", { PATH: "/opt/bin" }) === null, "which honours an explicit PATH");

// --- spawn ---------------------------------------------------------------------------------------
const child = Bun.spawn(["/bin/echo", "--version"], { stdout: "pipe", stderr: "ignore" });
const [text, code] = await Promise.all([child.stdout.text(), child.exited]);
check(text === "ripgrep 14.1.0\n", "spawn captures stdout", JSON.stringify(text));
check(code === 0 && child.exitCode === 0, "spawn resolves the exit code");
check(typeof child.pid === "number" && typeof child.unref === "function", "spawn returns a Subprocess (pid, unref)");
let spawnFailed = null;
try { Bun.spawn(["/bin/nope"]); } catch (e) { spawnFailed = e; }
check(spawnFailed && spawnFailed.code === "ENOENT", "spawn of a missing binary throws ENOENT", spawnFailed && spawnFailed.code);
const sync = Bun.spawnSync(["/bin/echo"]);
check(sync.exitCode === 0 && sync.success && sync.stdout.toString() === "ripgrep 14.1.0\n", "spawnSync returns Buffers + exitCode");
const seen = [];
const terminal = new Bun.Terminal({ cols: 100, rows: 40, data: (self, chunk) => seen.push(new TextDecoder().decode(chunk)) });
const shell = Bun.spawn(["/bin/sh", "-l"], { terminal });
await shell.exited;
terminal.write("ls\n");
check(B.spawned.at(-1).pty === true, "Bun.spawn(terminal) asks the backend for a pty");
check(seen.join("") === "$ ", "Bun.Terminal receives the child's output", JSON.stringify(seen));
check(new TextDecoder().decode(B.written.at(-1)) === "ls\n", "Bun.Terminal.write() reaches the child");

// --- file ----------------------------------------------------------------------------------------
const hello = Bun.file("/etc/hello");
check(await hello.text() === "hi there\n", "file().text()");
check(hello.size === 9 && hello.name === "/etc/hello", "file().size / .name", hello.size);
check(await hello.exists() === true, "file().exists() hit");
check(await Bun.file("/etc/nope").exists() === false, "file().exists() miss");
check(Bun.deepEquals(await Bun.file("/root/.claude.json").json(), { a: 1 }), "file().json()");
check((await hello.bytes()) instanceof Uint8Array && (await hello.arrayBuffer()).byteLength === 9, "file().bytes() / .arrayBuffer()");
const streamed = await new Response(Bun.file("/etc/hello").stream()).text();
check(streamed === "hi there\n", "file().stream()");
let readFailed = null;
try { await Bun.file("/etc/nope").text(); } catch (e) { readFailed = e; }
check(readFailed && readFailed.code === "ENOENT", "file().text() of a missing file throws ENOENT");

// --- the trivial members and the recorder --------------------------------------------------------
check(Bun.version === "1.4.0" && Bun.revision === "nanobox" && Bun.isStandaloneExecutable === true, "version / revision / isStandaloneExecutable");
check(Bun.gc(true) === 0 && Bun.main === "/usr/local/bin/claude" && Bun.env.HOME === "/root", "gc / main / env");
check(Bun.escapeHTML("<a href='x'>&</a>") === "&lt;a href=&#x27;x&#x27;&gt;&amp;&lt;/a&gt;", "escapeHTML");
check(Bun.fileURLToPath("file:///root/a b.txt") === "/root/a b.txt" && Bun.pathToFileURL("/root/a b.txt").href === "file:///root/a%20b.txt", "fileURLToPath / pathToFileURL");
check(Bun.ant.memoryPressureLevel() === null, "ant.memoryPressureLevel() is null (nothing to measure in a worker)");
check(typeof Bun.nanoseconds() === "number" && Bun.sleepSync(0) === undefined, "nanoseconds / sleepSync");
check(!("WebView" in Bun), "WebView stays absent so the bundle's feature detect fails cleanly");
check(Bun.JSONL === undefined && Bun.password === undefined, "unimplemented members read as undefined (and are recorded)");
for (const name of ["listen", "connect", "serve", "SQL", "Transpiler", "generateHeapSnapshot"]) {
  let threw = false;
  try { Bun[name](); } catch (e) { threw = /not available in nanobox/.test(e.message); }
  check(threw, `${name}() throws a nanobox-specific error`);
}

console.log(bad ? `FAILED (${bad})` : "ALL OK");
process.exit(bad ? 1 : 0);
