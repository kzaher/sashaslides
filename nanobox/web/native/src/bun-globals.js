// The `Bun` global for Claude Code's NATIVE build (a Bun standalone executable whose JS we extract
// with web/native/bunfs.js and run on the browser's V8 — docs/system-node.md, the same trick as the
// `node` shim, one runtime lower). Everything with a side effect goes through the syscall backend
// (src/backend.js), so files, processes and the terminal stay inside the guest Linux; the rest is
// pure JS the vendor's bundle expects Bun to provide (text width, ANSI wrapping, YAML/TOML, hashing).
//
//   makeBun(ctx) -> the object installed as `globalThis.Bun`
//   ctx: { B (backend), fs, path, os, child_process, proc (process), require (our module loader) }
//
// What the 2.1.233 bundle actually calls (tools/bun-extract.mjs + grep over work/bun/cli-native.js):
// stringWidth, wrapAnsi, stripANSI (every TUI frame), hash, which, spawn, file, Terminal (the
// background pty host), semver.order, deepEquals, YAML.parse/stringify, TOML.parse, gc (once a
// second), version, isStandaloneExecutable, ant.*, JSONL?.parseChunk — and, feature-gated and not on
// the startup path, listen, connect, serve, SQL, WebView, Transpiler, generateHeapSnapshot.
// Members we do not implement are left to the recorder (src/record.js): the read shows up in the
// page's missing-API list and in the server log instead of silently reading as `undefined`.
import { parseAllDocuments as parseYamlDocuments, stringify as stringifyYaml } from "yaml";
import { parse as parseToml } from "smol-toml";
import { noteMissing, record } from "./record.js";
import { stringWidth, wrapAnsi, stripANSI } from "./bun-text.js";
import { bunHash } from "./bun-hash.js";
import { makeSpawn } from "./bun-spawn.js";
import { makeFile } from "./bun-file.js";

export function makeBun(ctx) {
  const { spawn, spawnSync, which, Terminal } = makeSpawn(ctx);
  const { file, write, stdin, stdout, stderr } = makeFile(ctx);
  const bun = {
    version: BUN_VERSION,
    revision: BUN_REVISION,
    isStandaloneExecutable: true,   // we are running the standalone build's own bundle
    main: (ctx.proc && ctx.proc.argv && ctx.proc.argv[1]) || "",
    env: ctx.proc ? ctx.proc.env : {},
    argv: ctx.proc ? ctx.proc.argv : [],

    stringWidth, wrapAnsi, stripANSI,
    hash: record("Bun.hash", bunHash),
    deepEquals,
    semver: record("Bun.semver", { order: semverOrder }),
    YAML: record("Bun.YAML", { parse: parseYamlLikeBun, stringify: (value, replacer, space) => stringifyYaml(value, replacer, space) }),
    TOML: record("Bun.TOML", { parse: (text) => parseToml(String(text)) }),

    which, spawn, spawnSync, Terminal, file, write, stdin, stdout, stderr,

    gc: () => 0,                    // the bundle calls this on a 1 s interval; V8's GC is not ours to drive
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms instanceof Date ? ms.getTime() - Date.now() : Number(ms) || 0)),
    sleepSync,
    nanoseconds: () => Math.round((performance.now() - START_MS) * 1e6),
    escapeHTML,
    fileURLToPath: (url) => decodeURIComponent(new URL(url).pathname),
    pathToFileURL: (path) => new URL("file://" + encodeURI(String(path)).replace(/[?#]/g, encodeURIComponent)),
    inspect: (value, options) => { const util = utilModule(ctx); return util ? util.inspect(value, options) : String(value); },
    peek: PEEK,                     // no promise introspection on the host V8: hand the promise back

    // Anthropic's private namespace. All of it is process hardening / OS telemetry that a Web Worker
    // cannot answer; the bundle wraps every call in try/catch, so throwing is a supported answer.
    ant: record("Bun.ant", {
      memoryPressureLevel: () => null,
      setDumpable: () => true,      // nothing to disable: a worker has no ptrace attach and no core dump
      getPeerUid: refuses("Bun.ant.getPeerUid"),
      getPeerPid: refuses("Bun.ant.getPeerPid"),
    }),

    // Feature-gated, off the startup path, and backed by kernel facilities the backend does not
    // expose (raw sockets, a JS parser, a postgres driver, a heap profiler). A thrower with a clear
    // message beats "undefined is not a function" three frames deeper.
    // `Bun.WebView` is deliberately absent instead: the bundle feature-detects it with
    // `"WebView" in Bun` and degrades gracefully, which a thrower would turn into a crash.
    listen: refuses("Bun.listen"),
    connect: refuses("Bun.connect"),
    serve: refuses("Bun.serve"),
    SQL: refuses("Bun.SQL"),
    Transpiler: refuses("Bun.Transpiler"),
    generateHeapSnapshot: refuses("Bun.generateHeapSnapshot"),
  };
  return record("Bun", bun);
}

export const BUN_VERSION = "1.4.0";
export const BUN_REVISION = "nanobox";

// Bun.deepEquals(a, b, strict?) — structural equality, used for settings/state comparisons. Without
// `strict`, a key whose value is undefined equals a missing key (that is Bun's documented split).
export function deepEquals(a, b, strict) {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) if (!deepEquals(a[index], b[index], strict)) return false;
    return true;
  }
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  if (a instanceof Map || b instanceof Map) return a instanceof Map && b instanceof Map && a.size === b.size && [...a].every(([key, value]) => b.has(key) && deepEquals(value, b.get(key), strict));
  if (a instanceof Set || b instanceof Set) return a instanceof Set && b instanceof Set && a.size === b.size && [...a].every((value) => b.has(value));
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.byteLength !== b.byteLength) return false;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let index = 0; index < x.length; index++) if (x[index] !== y[index]) return false;
    return true;
  }
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keysA = definedKeys(a, strict), keysB = definedKeys(b, strict);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEquals(a[key], b[key], strict)) return false;
  }
  return true;
}

// Bun.YAML.parse gives back the document's value, or an ARRAY of values when the source holds
// several documents — where the `yaml` package's own parse() refuses a multi-document source. Skill
// and agent files are `---`-delimited, so that difference is on the startup path.
function parseYamlLikeBun(text) {
  const documents = parseYamlDocuments(String(text));
  for (const document of documents) if (document.errors.length) throw document.errors[0];
  if (documents.length === 0) return null;
  if (documents.length === 1) return documents[0].toJS();
  return documents.map((document) => document.toJS());
}

function definedKeys(value, strict) {
  const keys = Object.keys(value);
  return strict ? keys : keys.filter((key) => value[key] !== undefined);
}

// Bun.semver.order(a, b) -> -1 | 0 | 1, semver precedence: numeric core, then prerelease (a version
// with a prerelease tag sorts BELOW the same version without one), build metadata ignored.
export function semverOrder(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const one = left.pre[index], other = right.pre[index];
    if (one === undefined) return -1;
    if (other === undefined) return 1;
    const numeric = /^\d+$/.test(one), otherNumeric = /^\d+$/.test(other);
    if (numeric !== otherNumeric) return numeric ? -1 : 1;
    if (numeric) { if (Number(one) !== Number(other)) return Number(one) < Number(other) ? -1 : 1; continue; }
    if (one !== other) return one < other ? -1 : 1;
  }
  return 0;
}

function parseVersion(text) {
  const cleaned = String(text == null ? "" : text).trim().replace(/^[=v]+/, "").split("+")[0];
  const dash = cleaned.indexOf("-");
  const core = (dash < 0 ? cleaned : cleaned.slice(0, dash)).split(".");
  const pre = dash < 0 ? [] : cleaned.slice(dash + 1).split(".").filter(Boolean);
  return { core: [0, 1, 2].map((index) => parseInt(core[index], 10) || 0), pre };
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" })[character]);
}

function sleepSync(ms) {
  const millis = Number(ms) || 0;
  if (millis <= 0) return;
  // block the worker the way Bun blocks the thread; Atomics.wait beats spinning the CPU
  if (typeof SharedArrayBuffer === "function") { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, millis); return; }
  const until = Date.now() + millis;
  while (Date.now() < until) { /* no other way to stall without SharedArrayBuffer */ }
}

const PEEK = Object.assign((value) => value, { status: () => "pending" });
const START_MS = typeof performance !== "undefined" ? performance.now() : 0;

let cachedUtil;
function utilModule(ctx) {
  if (cachedUtil === undefined) { try { cachedUtil = ctx.require ? ctx.require("util") : null; } catch { cachedUtil = null; } }
  return cachedUtil;
}

// an unimplemented member: recorded like a missing one, then thrown with the reason in the message
function refuses(name) {
  const fn = function () { noteMissing(name, "call"); throw new Error(name + " is not available in nanobox's Bun shim (no kernel facility behind it)"); };
  Object.defineProperty(fn, "name", { value: name.split(".").pop() });
  return fn;
}
