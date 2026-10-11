#!/usr/bin/env node
// Probe the sandbox guest: open sandbox.html?cli=sh (a busybox shell in the guest, persistent tree
// mounted), wait for the prompt, type commands, print the screen after each. Nothing is saved.
//   node test/sandbox-probe.mjs [--q "install=claude"] 'ls -la /usr/local/bin' 'echo hi > /root/x; cat /root/x'
import CDP from "chrome-remote-interface";
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt("--port", 8093)), CDP_PORT = Number(opt("--cdp", 9222));
const cmds = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--q" && argv[i - 1] !== "--port" && argv[i - 1] !== "--cdp" && argv[i - 1] !== "--wait");
const WAIT = Number(opt("--wait", 3000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = `http://localhost:${PORT}/sandbox.html?cli=sh${opt("--q", "") ? "&" + opt("--q", "") : ""}`;
const tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
const client = await CDP({ target: tab, port: CDP_PORT });
const { Page, Runtime } = client;
await Promise.all([Page.enable(), Runtime.enable()]);
const consoleLines = [];
Runtime.consoleAPICalled(({ args, type }) => consoleLines.push(`[${type}] ` + args.map((a) => a.value ?? a.description ?? "").join(" ")));
console.log("→ " + url);
await Page.navigate({ url }); await Page.loadEventFired();
const ev = async (e) => (await Runtime.evaluate({ expression: e, returnByValue: true, awaitPromise: true })).result.value;
const t0 = Date.now();
while (Date.now() - t0 < 120000) { await sleep(300); const st = await ev("window.nanobox ? {s: window.nanobox.signinMs, f: window.nanobox.failed} : null"); if (st && (st.s != null || st.f)) { console.log(st.f ? "FAILED" : `shell prompt after ${((Date.now() - t0) / 1000).toFixed(1)} s`); break; } }
const screenTail = async (n) => ((await ev("window.nanobox.screen()")) || "").split("\n").filter((l) => l.trim()).slice(-n).join("\n");
for (const c of cmds) {
  await ev(`window.nanobox.send(${JSON.stringify(c + "\r")})`);
  await sleep(WAIT);
  console.log(`\n$ ${c}\n` + await screenTail(25));
}
if (argv.includes("--console")) console.log(consoleLines.slice(-40).join("\n"));
await CDP.Close({ id: tab.id, port: CDP_PORT });
