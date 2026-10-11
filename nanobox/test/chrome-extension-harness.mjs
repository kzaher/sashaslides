// Launching the Chrome that OWNS the nanobox proxy extension, plus the evidence-driven wait every
// test in this directory polls with. Extracted from test/e2e-proxyext.mjs so a second extension E2E
// (test/e2e-proxyext-claude-bin.mjs) cannot drift from the one launch recipe that actually works.
//
// WHY A PIPE AND NOT --load-extension. Google Chrome >= 137 ignores --load-extension, so the
// extension is installed through CDP `Extensions.loadUnpacked` — which is only served over
// --remote-debugging-pipe (fds 3/4). Chrome exits when that pipe closes, which is the property the
// tests want: the browser lives exactly as long as the node process that started it. The TCP
// --remote-debugging-port is still passed, because chrome-remote-interface drives pages over it.
//
// Test support code, so it is plain .mjs run by node like the rest of test/ — the TypeScript gate
// (npm run typecheck / build-proxy-extension.sh) owns extension/ and web/, not this directory.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// Poll `read` until `done(state)`; a state that stops changing for stallMs aborts early with
// evidence, and `deadlineMs` is the absolute cap. Both failures name the last state they saw, so a
// timeout is a diagnosis ("stuck at 48 MB since t=9s") and never a bare "timed out".
export async function waitFor({ what, read, done, deadlineMs, stallMs, pollMs }) {
  const start = Date.now();
  let last = null, lastChangeAt = start;
  for (;;) {
    let state = null;
    try { state = await read(); } catch (error) { state = "read error: " + (error && error.message || error); }
    if (done(state)) return { ok: true, state, ms: Date.now() - start };
    const serialized = JSON.stringify(state);
    if (serialized !== last) { last = serialized; lastChangeAt = Date.now(); }
    const now = Date.now();
    if (now - start >= deadlineMs) return { ok: false, state, ms: now - start, reason: `${what}: deadline ${deadlineMs / 1000}s passed, last state ${String(serialized).slice(0, 220)}` };
    if (now - lastChangeAt >= stallMs) return { ok: false, state, ms: now - start, reason: `${what}: no progress for ${stallMs / 1000}s (waited ${Math.round((now - start) / 1000)}s), last state ${String(serialized).slice(0, 220)}` };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

// A fresh Chrome that owns the extension: fds 3/4 carry the CDP pipe (Extensions.loadUnpacked needs
// it, and Chrome exits when it closes), the port serves chrome-remote-interface as usual.
export async function chromeWithExtension({ cdpPort, userDataDir, extension, binary }) {
  const args = ["--headless=new", "--remote-debugging-pipe", `--remote-debugging-port=${cdpPort}`, "--enable-unsafe-extension-debugging", "--remote-allow-origins=*",
    "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--user-data-dir=${userDataDir}`, "--window-size=1280,900", "about:blank"];
  console.log(`starting ${binary} on :${cdpPort} (pipe) and loading ${extension}`);
  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const pipeOut = child.stdio[3], pipeIn = child.stdio[4];
  const replies = new Map();
  let buffered = "";
  pipeIn.on("data", (chunk) => {
    buffered += chunk.toString();
    for (let end = buffered.indexOf("\0"); end >= 0; end = buffered.indexOf("\0")) {
      const message = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
      const waiter = replies.get(message.id); if (waiter) { replies.delete(message.id); waiter(message); }
    }
  });
  let nextId = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId; replies.set(id, (message) => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
    pipeOut.write(JSON.stringify({ id, method, params }) + "\0");
    setTimeout(() => { if (replies.delete(id)) reject(new Error(`${method}: no reply in 10s`)); }, 10000);
  });
  const close = () => { try { pipeOut.end(); } catch {} try { child.kill(); } catch {} };
  let extensionId = null;
  try {
    const loaded = await call("Extensions.loadUnpacked", { path: extension });
    extensionId = loaded.id;
    console.log(`  extension id ${extensionId}`);
    const up = await waitFor({ what: `chrome on :${cdpPort}`, deadlineMs: 30000, stallMs: 30000, pollMs: 250, read: () => alive(cdpPort), done: (ok) => ok === true });
    if (!up.ok) throw new Error(up.reason);
  } catch (error) { close(); throw error; }
  return { close, extensionId };
}

// The plain Chrome (no extension), started exactly like test/e2e.mjs does; reused when already up.
export async function chromeUp({ cdpPort, userDataDir, binary }) {
  if (await alive(cdpPort)) { console.log(`Chrome already listening on :${cdpPort} (reusing it)`); return; }
  const args = ["--headless=new", `--remote-debugging-port=${cdpPort}`, "--remote-allow-origins=*", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--user-data-dir=${userDataDir}`, "--window-size=1280,900", "about:blank"];
  console.log(`starting ${binary} on :${cdpPort}`);
  const child = spawn(binary, args, { stdio: "ignore", detached: true });
  child.unref();
  const up = await waitFor({ what: `chrome on :${cdpPort}`, deadlineMs: 30000, stallMs: 30000, pollMs: 250, read: () => alive(cdpPort), done: (ok) => ok === true });
  if (!up.ok) throw new Error(up.reason);
}

export function defaultChrome() {
  const binary = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
  if (!binary) throw new Error("no chrome binary found");
  return binary;
}

async function alive(cdpPort) {
  try { return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok; } catch { return false; }
}
