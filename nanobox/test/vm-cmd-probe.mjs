// Run a command in the opt VM in the browser and print the screen after it settles.
//   node test/vm-cmd-probe.mjs <image> "<cmd>" [seconds]
import CDP from "chrome-remote-interface";
const [image, cmd, secs] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = `http://localhost:8093/vm.html?engine=opt&image=${image}&jit=2:2000&auto=0&netlog=1&cmd=${encodeURIComponent(cmd)}`;
const tab = await CDP.New({ port: 9222, url: "about:blank" });
const client = await CDP({ target: tab, port: 9222 });
const { Page, Runtime } = client; await Promise.all([Page.enable(), Runtime.enable()]);
const nl = []; Runtime.consoleAPICalled(({ args }) => { const t = args.map((a) => a.value ?? "").join(" "); if (/netlog\] http|netlog\] (?!recv|nanobox)/.test(t)) nl.push(t); });
await Page.navigate({ url }); await Page.loadEventFired();
const ev = async (e) => (await Runtime.evaluate({ expression: e, returnByValue: true })).result.value;
let last = "", stable = 0; const t0 = Date.now();
while (Date.now() - t0 < Number(secs || 40) * 1000) { await sleep(1000); const s = (await ev("window.nanobox ? window.nanobox.screen() : ''")) || ""; if (s === last && s.trim()) { if (++stable >= 4) break; } else stable = 0; last = s; }
if (nl.length) console.log(nl.slice(0, 12).join("\n"));
console.log(last.trim().split("\n").filter((l) => l.trim()).slice(-25).join("\n"));
await CDP.Close({ id: tab.id, port: 9222 }); process.exit(0);
