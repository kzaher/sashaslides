// Recording proxies: every property of a stub module / object that Claude Code touches and that we
// do not implement is logged ONCE (name + the first non-runtime stack frame). The list is what tells
// us which Node APIs the startup really needs. `NanoboxRecord.dump()` returns it (the worker posts
// it to the page; the e2e test prints it).
const missing = new Map(); // key -> { key, count, stack, kind }
const calls = new Map();   // key -> count  (stubbed functions that were CALLED)
let onFirst = null;

function firstUserFrame() {
  const st = (new Error().stack || "").split("\n").slice(2);
  for (const l of st) if (!/native\/(runtime|src)|record\.js|runtime\.js/.test(l)) return l.trim();
  return (st[0] || "").trim();
}
export function noteMissing(key, kind = "get") {
  if (kind === "get" && EXPECTED_UNDEFINED.has(key)) return;
  const rec = missing.get(key);
  if (rec) { rec.count++; return; }
  const r = { key, kind, count: 1, stack: firstUserFrame() };
  missing.set(key, r);
  if (onFirst) { try { onFirst(r); } catch {} }
}
export function noteCall(key, args) {
  calls.set(key, (calls.get(key) || 0) + 1);
  if (!missing.has(key)) noteMissing(key, "call");
}
export function setOnFirst(f) { onFirst = f; }
export function dump() {
  return { missing: [...missing.values()].sort((a, b) => b.count - a.count), calls: [...calls.entries()].map(([k, n]) => ({ key: k, count: n })) };
}

// Reads whose CORRECT answer is `undefined` — runtime-detection probes ("am I Electron / NW.js /
// a browser?") and slots a library creates on first use. Recording them as gaps would hide the real
// ones; the list is meant to be short enough to read.
const EXPECTED_UNDEFINED = new Set(["process.type", "process.__nwjs", "process.__signal_exit_emitter__", "process.browser",
  "process.electron", "process.versions.electron", "process.versions.nw", "process.__signal_exit_emitter__v3", "process.resourcesPath"]);
const SKIP = new Set(["then", "catch", "finally", "toJSON", "constructor", "prototype", "__esModule", "default", "inspect", "valueOf", "toString",
  "asymmetricMatch", "nodeType", "$$typeof", "@@__IMMUTABLE_ITERABLE__@@", "@@__IMMUTABLE_RECORD__@@", "_isMockFunction", "length", "name",
  "arguments", "caller", "apply", "call", "bind"]);
// a function stub: calling it is recorded; returns `ret` (default undefined)
export function stubFn(key, ret) {
  const f = function (...args) { noteCall(key, args); return typeof ret === "function" ? ret(...args) : ret; };
  Object.defineProperty(f, "name", { value: key.split(".").pop() });
  return f;
}
// wrap a module (plain object) so unknown property reads are recorded. `mode`:
//   "undefined" (default) — return undefined for unknown props (like a real partial module)
//   "stub"      — return a recording stub function for unknown props (lets code limp on)
export function record(name, target, mode = "undefined") {
  if (target == null || (typeof target !== "object" && typeof target !== "function")) return target;
  return new Proxy(target, {
    get(t, p, r) {
      if (typeof p === "symbol") return Reflect.get(t, p, r);
      if (p in t) return Reflect.get(t, p, r);
      if (SKIP.has(p)) return undefined;
      const key = name + "." + p;
      if (mode === "stub") { noteMissing(key, "get"); const f = stubFn(key); return f; }
      noteMissing(key, "get");
      return undefined;
    },
    has(t, p) { return p in t; },
  });
}
export const NanoboxRecord = { noteMissing, noteCall, dump, record, stubFn, setOnFirst };
