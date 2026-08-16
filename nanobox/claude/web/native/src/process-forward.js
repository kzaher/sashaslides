// the forwarder object shared by inject-process.js (free `process` references) and process-shim.cjs
// (`require('process')`): everything goes to the real process object the runtime installs on the
// worker global before any polyfill runs
export const processForwarder = new Proxy({}, {
  get: (t, p) => globalThis.process ? globalThis.process[p] : (p === "env" ? {} : p === "nextTick" ? (f, ...a) => queueMicrotask(() => f(...a)) : p === "browser" ? true : undefined),
  has: (t, p) => globalThis.process ? p in globalThis.process : false,
  set: (t, p, v) => { if (globalThis.process) globalThis.process[p] = v; return true; },
});
