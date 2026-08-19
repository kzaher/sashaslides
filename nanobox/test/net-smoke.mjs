#!/usr/bin/env node
// Network smoke test for the guest's egress path — every check is a command run INSIDE the guest.
//
//   node test/net-smoke.mjs [--port 8093] [--cdp 9222] [--echo-port 8099] [--host 172.17.0.2]
//                           [--page vm|sandbox] [--timeout 180] [--keep] [--out web/results]
//                           [--no-vendor]   (skip the two checks that leave this machine)
//
// Why this exists. A guest TCP connection leaves the browser like this:
//   guest  --HTTP(S)_PROXY=192.168.127.253--> c2w netstack + MITM proxy (imagemounter.wasm)
//          --http_send/http_writebody/http_readbody--> public/c2w/dist/runcontainer.js
//          --window.fetch--> web/proxyext.js workerFetch
//          --> browser direct | proxy extension | POST /net/fetch --> serve.mjs netFetch
// Every hop is a place the response body can be BUFFERED instead of streamed. Buffering is
// invisible for ordinary request/response traffic and fatal for anything long-lived: MCP's
// "streamable HTTP" transport holds a GET open and pushes SSE events over it for the life of the
// session, so a hop that waits for the body to END delivers the first event only when the stream
// closes — i.e. never. serve.mjs's `await r.arrayBuffer()` did exactly that until it was fixed;
// this test is the regression gate that says whether any hop still does.
//
// Checks (all measured from inside the guest):
//   dns       the guest resolves a name
//   get       a small GET over the egress path returns the exact expected body
//   https     the same over TLS, against a real vendor (the MITM path)          [--no-vendor skips]
//   bulk      a >1 MB body arrives complete — byte count must match exactly
//   sse       a FINITE SSE stream (event 0 at once, the rest 1 s apart): the first event must
//             arrive promptly, not together with the last one
//   open      an SSE stream that NEVER ends — the shape MCP uses for its server->client channel.
//             A buffering hop delivers nothing at all here, however long you wait.
//   relay     a GET at a relayed vendor host, so the same request is visible in the server's log
//             (`[net] GET … -> status`) — evidence about what the guest can put on the wire.
//
// The endpoints for get/bulk/sse/open are served by a throwaway HTTP server this test starts itself
// (CORS wide open, bound on --host so the BROWSER can reach it — the guest's own loopback is not the
// container's). Nothing is added to serve.mjs and the running server is never restarted.
//
// Timing. busybox `date` has no %N, so the guest's own clock is 1-second granular — enough, because
// the finite stream is spread over 5 s (streamed: first event at +0 s; buffered: first event at
// +5 s). For a millisecond number the guest also pings /mark on the test server at the start of the
// stream, on the first event and at the end; the SERVER timestamps those, so first-event latency is
// measured with the server's clock and is independent of the guest's.
//
// The page. --page vm (default) drives web/vm.html, the minimal VM page: it takes the whole probe
// as `?cmd=/bin/sh -c '…'`, so nothing is typed into a tty and there is no prompt to synchronise
// with. --page sandbox drives sandbox.html?cli=sh and types the same script into its shell instead.
// Both run the same guest image on the same engine with the same network stack.
import CDP from "chrome-remote-interface";
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt("--port", 8093)), CDP_PORT = Number(opt("--cdp", 9222));
const ECHO_PORT = Number(opt("--echo-port", 8099));
const ECHO_HOST = opt("--host", "172.17.0.2");     // an address the BROWSER can reach; not the guest's loopback
const TIMEOUT_S = Number(opt("--timeout", 180));
const PAGE = opt("--page", "vm");
const OUT = opt("--out", join(HERE, "../web/results"));
const VENDOR = !argv.includes("--no-vendor");
const BULK = Number(opt("--bulk", 2_000_000));
const SSE_N = Number(opt("--sse-events", 6)), SSE_GAP = Number(opt("--sse-gap", 1000));
const OPEN_S = Number(opt("--open-seconds", 8));   // WALL seconds; converted to the guest's fast seconds in the probe
const OPEN_GAP = Number(opt("--open-gap", 1000));
const IMAGE = opt("--image", "linux-base");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------- the throwaway endpoint server -----
const hits = [];                                    // {t, method, path} — the server's own clock
const T_ORIGIN = Date.now();
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-expose-headers": "*" };
const echo = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  hits.push({ t: Date.now() - T_ORIGIN, method: req.method, path: u.pathname + u.search });
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); res.end(); return; }
  if (u.pathname === "/echo" || u.pathname === "/mark") { res.writeHead(200, { ...CORS, "content-type": "text/plain" }); res.end("nanobox-echo-ok\n"); return; }
  if (u.pathname === "/probe.sh") { res.writeHead(200, { ...CORS, "content-type": "text/plain" }); res.end(script); return; }
  if (u.pathname === "/bulk") {
    const n = Number(u.searchParams.get("bytes") || BULK), chunk = Buffer.alloc(64 * 1024, 0x61);
    res.writeHead(200, { ...CORS, "content-type": "application/octet-stream", "content-length": String(n) });
    let sent = 0;
    const pump = () => { while (sent < n) { const c = chunk.subarray(0, Math.min(chunk.length, n - sent)); sent += c.length; if (!res.write(c)) { res.once("drain", pump); return; } } res.end(); };
    pump(); return;
  }
  if (u.pathname === "/sse") {
    // event 0 immediately, then one every `ms`; n=0 means never stop (the MCP server->client shape)
    const n = Number(u.searchParams.get("n") || 0), gap = Number(u.searchParams.get("ms") || SSE_GAP);
    const pad = Number(u.searchParams.get("pad") || 0) ? "x".repeat(Number(u.searchParams.get("pad"))) + " " : "";
    res.writeHead(200, { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
    let i = 0, timer = null;
    const emit = () => { res.write(`data: ${pad}ev${i} ${Date.now() - T_ORIGIN}\n\n`); if (typeof res.flush === "function") res.flush(); i++; if (n && i >= n) { res.end(); return; } timer = setTimeout(emit, gap); };
    emit();
    res.on("close", () => clearTimeout(timer));
    return;
  }
  res.writeHead(404, CORS); res.end("no");
});
await new Promise((r) => echo.listen(ECHO_PORT, "0.0.0.0", r));
const BASE = `http://${ECHO_HOST}:${ECHO_PORT}`;
console.log(`endpoints on ${BASE}   (/echo /mark /bulk?bytes=N /sse?n=N&ms=M)`);

// ---------------------------------------------------------------- the probe, as one sh script ----
// The guest's entrypoint buffer holds 1024 bytes ("too many write (1025 > 1024)"), so the probe is
// NOT passed as argv: the entrypoint is a one-liner that wgets this script from the test server and
// runs it. That first wget is itself the smallest possible egress check — if it fails nothing is
// printed at all and the run is graded "bootstrap".
const SPAN = (SSE_N - 1) * SSE_GAP;
const script = [
  `B=${BASE}`,
  `echo NBSTART`,
  `D=$(nslookup registry.npmjs.org 2>/dev/null | grep -c Address)`,
  `echo "NB dns lines=$D"`,
  `G=$(wget -q -O - $B/echo 2>&1 | head -1)`,
  `echo "NB get body=$G"`,
  ...(VENDOR ? [
    `H=$(wget -q -O - https://registry.npmjs.org/lodash/4.17.21 2>/dev/null | wc -c)`,
    `echo "NB https bytes=$H"`,
  ] : []),
  `K=$(wget -q -O - "$B/bulk?bytes=${BULK}" 2>/dev/null | wc -c)`,
  `echo "NB bulk bytes=$K"`,
  // finite SSE: guest-clock deltas + server-clock marks
  `rm -f /tmp/s /tmp/first`,
  `wget -q -O /dev/null "$B/mark?t=sse-begin" 2>/dev/null`,
  `T0=$(date +%s)`,
  `wget -q -O - "$B/sse?n=${SSE_N}&ms=${SSE_GAP}" 2>/dev/null | while IFS= read -r L; do case "$L" in data:*) if [ ! -f /tmp/first ]; then : > /tmp/first; wget -q -O /dev/null "$B/mark?t=sse-first" 2>/dev/null; fi; echo "$(date +%s) $L" >> /tmp/s;; esac; done`,
  `wget -q -O /dev/null "$B/mark?t=sse-end" 2>/dev/null`,
  `T1=$(date +%s)`,
  `F=$(head -1 /tmp/s | cut -d" " -f1); E=$(tail -1 /tmp/s | cut -d" " -f1); C=$(grep -c . /tmp/s)`,
  `echo "NB sse first=$((F-T0)) last=$((E-T0)) total=$((T1-T0)) events=$C"`,
  // The guest clock runs FAST (measured ~15x: 8 guest-seconds elapsed in 549 ms of wall time), so a
  // literal `timeout 8` below would hold the never-ending stream open for about half a second and
  // could not observe more than the one event the endpoint emits immediately -- which is exactly how
  // a working stream got mis-graded BUFFERED. The sse stage above just measured a window the SERVER
  // knows the true length of (SPAN ms), so use it to convert wall-seconds into guest-seconds.
  `GS=$((T1-T0)); SPS=$((${SPAN} / 1000))`,
  `[ "$SPS" -lt 1 ] && SPS=1`,
  `[ "$GS" -lt 1 ] && GS=$SPS`,
  `OT=$((GS * ${OPEN_S} / SPS)); [ "$OT" -lt ${OPEN_S} ] && OT=${OPEN_S}`,
  `echo "NB clock guestsec=$GS wallsec=$SPS opentimeout=$OT"`,
  // same again with 8 KB events: any hop that only buffers small writes (a bufio that is never
  // flushed) is forced to hand them on, so a pass here + a fail above pins the buffering to a
  // small-write buffer rather than to a whole-body buffer.
  `rm -f /tmp/sb /tmp/firstb`,
  `wget -q -O /dev/null "$B/mark?t=big-begin" 2>/dev/null`,
  `wget -q -O - "$B/sse?n=${SSE_N}&ms=${SSE_GAP}&pad=8192" 2>/dev/null | while IFS= read -r L; do case "$L" in data:*) if [ ! -f /tmp/firstb ]; then : > /tmp/firstb; wget -q -O /dev/null "$B/mark?t=big-first" 2>/dev/null; fi; echo x >> /tmp/sb;; esac; done`,
  `wget -q -O /dev/null "$B/mark?t=big-end" 2>/dev/null`,
  `echo "NB big events=$(grep -c . /tmp/sb)"`,
  // never-ending SSE: the MCP shape
  `rm -f /tmp/o /tmp/ofirst`,
  `wget -q -O /dev/null "$B/mark?t=open-begin" 2>/dev/null`,
  `timeout $OT wget -q -O - "$B/sse?n=0&ms=${OPEN_GAP}" 2>/dev/null | while IFS= read -r L; do case "$L" in data:*) if [ ! -f /tmp/ofirst ]; then : > /tmp/ofirst; wget -q -O /dev/null "$B/mark?t=open-first" 2>/dev/null; fi; echo "$L" >> /tmp/o;; esac; done`,
  `wget -q -O /dev/null "$B/mark?t=open-end" 2>/dev/null`,
  `echo "NB open events=$(grep -c data: /tmp/o) bytes=$(wc -c < /tmp/o) waited=$OT"`,
  ...(VENDOR ? [
    `R=$(wget -S -O /dev/null https://api.anthropic.com/api/hello 2>&1 | grep -c "HTTP/")`,
    `echo "NB relay status_lines=$R"`,
  ] : []),
  `echo NBDONE`,
].join("\n");
// vm.html tokenises ?cmd= with /"([^"]*)"|'([^']*)'|(\S+)/ -> the entrypoint travels single-quoted.
const ENTRY = `/bin/sh -c 'wget -q -O /tmp/p ${BASE}/probe.sh; echo NBBOOT rc=$?; sh /tmp/p'`;
if (ENTRY.length > 900) throw new Error("entrypoint too long for the guest's 1024-byte buffer");

// --------------------------------------------------------------------------- drive the browser ---
const results = [];
const fail = (name, detail, extra) => { results.push({ name, ok: false, detail, ...extra }); };
const pass = (name, detail, extra) => { results.push({ name, ok: true, detail, ...extra }); };
const url = PAGE === "sandbox"
  ? `http://localhost:${PORT}/sandbox.html?cli=sh&image=${IMAGE}`
  : `http://localhost:${PORT}/vm.html?engine=opt&image=${IMAGE}&jit=2:2000&auto=0&netlog=1&cmd=${encodeURIComponent(ENTRY)}`;
console.log(`→ ${PAGE}.html (${IMAGE})`);
const tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
const client = await CDP({ target: tab, port: CDP_PORT });
const { Page, Runtime, Emulation } = client;
let out = "", routes = null, pageNet = null, ranMs = null;
try {
  await Promise.all([Page.enable(), Runtime.enable(), client.Network.enable()]);
  await client.Network.setCacheDisabled({ cacheDisabled: true });   // never grade a cached runcontainer.js
  await Emulation.setDeviceMetricsOverride({ width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await Page.bringToFront().catch(() => {});   // a background tab throttles the timers the tty pump rides on
  await Page.navigate({ url });
  await Page.loadEventFired();
  const ev = async (e) => (await Runtime.evaluate({ expression: e, returnByValue: true, awaitPromise: true })).result.value;
  const screen = async () => String((await ev(`window.nanobox && window.nanobox.screen ? window.nanobox.screen() : ""`)) || "");
  const t0 = Date.now();
  if (PAGE === "sandbox") {                    // type the probe into the guest shell instead
    while (Date.now() - t0 < TIMEOUT_S * 1000 && !(await ev(`window.nanobox && window.nanobox.phases.bootMs != null`))) await sleep(1000);
    await ev(`window.nanobox.send(${JSON.stringify(`wget -q -O /tmp/p ${BASE}/probe.sh; echo NBBOOT rc=$?; sh /tmp/p` + "\r")})`);
  }
  for (;;) {
    out = await screen();
    if (/^NBDONE$/m.test(out)) break;
    if (Date.now() - t0 > TIMEOUT_S * 1000) { fail("run", `no NBDONE within ${TIMEOUT_S}s`); break; }
    await sleep(1000);
  }
  ranMs = Date.now() - t0;
  routes = JSON.parse((await ev(`JSON.stringify(window.nanoboxNetRoutes ? {extension:window.nanoboxNetRoutes.extension,relay:window.nanoboxNetRoutes.relay,direct:window.nanoboxNetRoutes.direct,blocked:window.nanoboxNetRoutes.blocked,log:window.nanoboxNetRoutes.log.slice(-40)} : (window.nanoboxNet ? {requests:window.nanoboxNet.requests.slice(-40),routes:window.nanoboxNet.routes} : null))`)) || "null");
  pageNet = routes;
  try { const s = await Page.captureScreenshot({ format: "png" }); writeFileSync(join(OUT, "net-smoke.png"), Buffer.from(s.data, "base64")); } catch {}
} catch (e) {
  fail("run", String((e && e.message) || e));
} finally {
  if (!argv.includes("--keep")) await CDP.Close({ id: tab.id, port: CDP_PORT }).catch(() => {});
  await client.close().catch(() => {});
}

// ------------------------------------------------------------------------------ grade the run ----
const line = (name) => { const m = new RegExp(`^NB ${name} (.*)$`, "m").exec(out); return m ? m[1].trim() : null; };
const kv = (s) => Object.fromEntries((s || "").split(/\s+/).map((p) => p.split("=")).filter((p) => p.length === 2));
const markT = (t) => { const h = hits.find((h) => h.path.includes(`t=${t}`)); return h ? h.t : null; };

if (!/NBSTART/.test(out)) fail("bootstrap", `the guest never fetched ${BASE}/probe.sh — nothing ran (screen: ${JSON.stringify(out.slice(-200))})`);
else pass("bootstrap", `the guest wget'd the probe script from ${BASE}/probe.sh and ran it`);
{ const v = kv(line("dns")); Number(v.lines) >= 1 ? pass("dns", `nslookup registry.npmjs.org -> ${v.lines} Address lines`) : fail("dns", `nslookup gave ${JSON.stringify(line("dns"))}`); }
{ const v = kv(line("get")); v.body === "nanobox-echo-ok" ? pass("get", `GET ${BASE}/echo -> "${v.body}"`) : fail("get", `GET ${BASE}/echo -> ${JSON.stringify(line("get"))}`); }
if (VENDOR) { const v = kv(line("https")); Number(v.bytes) > 500 ? pass("https", `GET https://registry.npmjs.org/lodash/4.17.21 -> ${v.bytes} bytes over the MITM`) : fail("https", `TLS GET -> ${JSON.stringify(line("https"))}`); }
{ const v = kv(line("bulk")); Number(v.bytes) === BULK ? pass("bulk", `${Number(v.bytes).toLocaleString()} bytes == ${BULK.toLocaleString()} requested`, { got: Number(v.bytes), want: BULK })
                                                       : fail("bulk", `got ${v.bytes} bytes, wanted ${BULK}`, { got: Number(v.bytes), want: BULK }); }
{
  const v = kv(line("sse")), first = Number(v.first), last = Number(v.last), events = Number(v.events);
  const srvFirst = markT("sse-first") != null && markT("sse-begin") != null ? markT("sse-first") - markT("sse-begin") : null;
  const srvEnd = markT("sse-end") != null && markT("sse-begin") != null ? markT("sse-end") - markT("sse-begin") : null;
  const detail = `first event +${first}s (server clock ${srvFirst} ms), last +${last}s (server clock ${srvEnd} ms), ${events} events spread over ${SPAN} ms by the endpoint`;
  const budget = Math.round(SPAN * 0.4);
  if (!(events >= 1)) fail("sse", `nothing arrived — ${JSON.stringify(line("sse"))}`);
  else if (events < SSE_N) fail("sse", `only ${events}/${SSE_N} events arrived — ${detail}`, { first, last, events, srvFirst, srvEnd, span: SPAN });
  else if (srvFirst != null ? srvFirst > budget : first * 1000 > budget) fail("sse", `BUFFERED: the first event only showed up after ${srvFirst != null ? srvFirst + " ms" : first + " s"} (budget ${budget} ms) — ${detail}`, { first, last, events, srvFirst, srvEnd, span: SPAN });
  else pass("sse", detail, { first, last, events, srvFirst, srvEnd, span: SPAN });
}
{
  const v = kv(line("big")), events = Number(v.events);
  const f = markT("big-first") != null && markT("big-begin") != null ? markT("big-first") - markT("big-begin") : null;
  const e = markT("big-end") != null && markT("big-begin") != null ? markT("big-end") - markT("big-begin") : null;
  const detail = `8 KB events: first +${f} ms, last +${e} ms, ${events} events over ${SPAN} ms`;
  if (events < SSE_N) fail("big", `only ${events}/${SSE_N} of the 8 KB events arrived — ${detail}`, { events, first: f, last: e });
  else if (f == null || f > Math.round(SPAN * 0.4)) fail("big", `BUFFERED: ${detail}`, { events, first: f, last: e });
  else pass("big", detail, { events, first: f, last: e });
}
{
  // Everything here is on the SERVER's clock; the guest's runs ~15x fast and is only used to size
  // its own `timeout` (see the calibration in the probe). A buffering hop scores 0 events, because a
  // response that never ends never reaches the point where a whole-body buffer would be handed on.
  const v = kv(line("open")), events = Number(v.events), bytes = Number(v.bytes), waited = Number(v.waited);
  const first = markT("open-first") != null && markT("open-begin") != null ? markT("open-first") - markT("open-begin") : null;
  const win = markT("open-end") != null && markT("open-begin") != null ? markT("open-end") - markT("open-begin") : null;
  const detail = `${events} events / ${bytes} bytes off a never-ending stream, first at +${first} ms, stream held open ${win} ms (wanted ~${OPEN_S * 1000} ms; the guest's own timeout was ${waited} of ITS fast seconds)`;
  const extra = { events, bytes, waited, srvFirst: first, srvWindow: win };
  if (win != null && win < OPEN_S * 1000 * 0.5)
    fail("open", `INCONCLUSIVE: the guest only held the stream open ${win} ms of the intended ${OPEN_S * 1000} ms, so too few events could arrive to judge — its clock calibration is off, not the transport. ${detail}`, extra);
  else if (events < 2)
    fail("open", `BUFFERED: ${detail} — a stream that never closes hands the guest nothing (this is the MCP server->client channel)`, extra);
  else if (first != null && first > Math.max(2000, OPEN_GAP * 2))
    fail("open", `BUFFERED: the first event off the never-ending stream only showed up after ${first} ms — ${detail}`, extra);
  else pass("open", detail, extra);
}
if (VENDOR) { const v = kv(line("relay")); Number(v.status_lines) >= 1 ? pass("relay", `GET https://api.anthropic.com/api/hello came back with ${v.status_lines} status line(s) — see work/prof/j2-serve.log`) : fail("relay", `relayed GET -> ${JSON.stringify(line("relay"))}`); }

echo.close();
const ok = results.length > 0 && results.every((r) => r.ok);
writeFileSync(join(OUT, "net-smoke.json"), JSON.stringify({ at: new Date().toISOString(), page: PAGE, url, base: BASE, ranMs, results, hits, routes, screen: out.split("\n").filter((l) => l.trim()).slice(-40) }, null, 1));
console.log(`\n=== net smoke (${PAGE}.html, ${(ranMs / 1000).toFixed(1)}s) ===`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(6)} ${r.detail}`);
console.log(`\n${ok ? "PASS" : "FAIL"}  (${OUT}/net-smoke.json)`);
process.exit(ok ? 0 : 1);
