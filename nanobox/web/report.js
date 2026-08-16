// Page-side error reporting to POST /log (see web/native/src/report.js for the runtime worker):
// uncaught page errors, unhandled rejections, and explicit NanoboxReport.event(kind, data) calls
// (the VM worker's "error" events are relayed by the pages).
(function () {
  const q = []; let t = null;
  const flush = () => { t = null; if (!q.length) return; const body = JSON.stringify(q.splice(0)); try { navigator.sendBeacon ? navigator.sendBeacon("/log", new Blob([body], { type: "application/json" })) : fetch("/log", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }); } catch {} };
  const event = (kind, data) => { q.push(Object.assign({ t: Date.now(), page: location.href, kind }, data || {})); if (q.length > 50) flush(); else if (!t) t = setTimeout(flush, 1500); };
  window.addEventListener("error", (e) => event("page-error", { message: String(e.message), filename: e.filename, lineno: e.lineno, stack: e.error && e.error.stack }));
  window.addEventListener("unhandledrejection", (e) => event("page-unhandledrejection", { message: String(e.reason && e.reason.message || e.reason), stack: e.reason && e.reason.stack }));
  window.addEventListener("pagehide", flush);
  window.NanoboxReport = { event, flush };
})();
