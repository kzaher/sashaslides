// Drive the codex sign-in menu in the browser (opt engine): wait for the sign-in screen, choose
// "Sign in with Device Code", and report what the guest prints + what reached the gateway.
import CDP from "chrome-remote-interface";
const PORT = 8093, CDP_PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const url = `http://localhost:${PORT}/vm.html?engine=opt&image=codex&jit=2:2000&netlog=1` + (process.env.CMD ? "&cmd=" + encodeURIComponent(process.env.CMD) : "");
const tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
const client = await CDP({ target: tab, port: CDP_PORT });
const { Page, Runtime, Log } = client;
await Promise.all([Page.enable(), Runtime.enable(), Log.enable()]);
const lines = [];
Runtime.consoleAPICalled(({ args, type }) => lines.push(`[${type}] ` + args.map((a) => a.value ?? a.description ?? "").join(" ")));
Log.entryAdded(({ entry }) => lines.push(`[${entry.level}] ${entry.text}`));
await Page.navigate({ url }); await Page.loadEventFired();
const ev = async (e) => (await Runtime.evaluate({ expression: e, returnByValue: true })).result.value;
const t0 = Date.now();
while (Date.now() - t0 < 90000) { await sleep(1000); if (await ev("window.nanobox && window.nanobox.signinMs != null")) break; }
console.log("signin at", ((Date.now() - t0) / 1000).toFixed(1), "s");
await ev(`window.nanobox.send("\\x1b[B")`); await sleep(500);   // down arrow -> option 2
await ev(`window.nanobox.send("\\r")`);
for (let i = 0; i < 25; i++) { await sleep(1000); const s = await ev("window.nanobox.screen()"); if (/code|error|failed|http/i.test(s.replace(/Sign in with Device Code/g, ""))) { console.log("--- screen after", i + 1, "s\n" + s.trim().split("\n").filter((l) => l.trim()).slice(-14).join("\n")); break; } }
const interesting = lines.filter((l) => /netlog|error|Error/.test(l) && !/nanobox opt\/codex/.test(l));
console.log("--- console (" + lines.length + " lines, filtered " + interesting.length + "):\n" + interesting.slice(-40).join("\n"));
const counts = {}; for (const l of lines) { const k = l.slice(0, 40); counts[k] = (counts[k] || 0) + 1; }
console.log("--- top console prefixes:\n" + Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => n + "  " + k).join("\n"));
await CDP.Close({ id: tab.id, port: CDP_PORT });
process.exit(0);
