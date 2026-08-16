// Sandbox error reporting: everything that goes wrong in the runtime worker (errno errors handed to
// the CLI — with the JS stack of the caller —, unimplemented APIs, uncaught errors/rejections,
// console.error) is batched to POST /log on our origin (serve.mjs appends work/client-errors.log
// and echoes to its stdout), so a "Error writing file" in the CLI has a server-side cause line.
// Bounded: dedup by (kind, message) with counts, at most 200 records per minute.
const queue = []; const seen = new Map(); let sent = 0, windowStart = 0, timer = null, page = "";
export function initReport(cfg) { page = (cfg && cfg.page) || (typeof location !== "undefined" ? location.href : ""); }
export function report(kind, data) {
  const key = kind + "|" + (data && (data.message || data.key || data.op) || "");
  const now = Date.now();
  if (now - windowStart > 60000) { windowStart = now; sent = 0; }
  const rec = seen.get(key);
  if (rec) { rec.count++; if (rec.count > 3) return; } else seen.set(key, { count: 1 });
  if (sent++ > 200) return;
  queue.push(Object.assign({ t: now, page, kind }, data));
  if (!timer) timer = setTimeout(flush, 1500);
}
export function flush() {
  timer = null; if (!queue.length) return;
  const body = JSON.stringify(queue.splice(0, queue.length));
  try { fetch(new URL("/log", page || self.location.href), { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {}); } catch {}
}
export function reportError(kind, e, extra) {
  report(kind, Object.assign({ message: String(e && e.message || e), stack: e && e.stack ? String(e.stack).split("\n").slice(0, 12).join("\n") : undefined, code: e && e.code, errno: e && e.errno, syscall: e && e.syscall, path: e && e.path }, extra || {}));
}
export function installGlobalHandlers() {
  self.addEventListener("error", (ev) => reportError("uncaught", ev.error || ev.message, { filename: ev.filename, lineno: ev.lineno }));
  self.addEventListener("unhandledrejection", (ev) => reportError("unhandledrejection", ev.reason));
  const ce = console.error.bind(console); console.error = (...a) => { try { report("console.error", { message: a.map((x) => (x && x.stack) || String(x)).join(" ").slice(0, 2000) }); } catch {} ce(...a); };
  const cw = console.warn.bind(console); console.warn = (...a) => { try { report("console.warn", { message: a.map((x) => String(x)).join(" ").slice(0, 1000) }); } catch {} cw(...a); };
}
