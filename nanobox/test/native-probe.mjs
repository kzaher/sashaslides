// node test/native-probe.mjs "<keys>" [secs]  — open claude-native.html, wait for the sign-in screen, send keys, print the screen
import CDP from "chrome-remote-interface";
const [keys, secs] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tab = await CDP.New({ port: 9222, url: "about:blank" });
const c = await CDP({ target: tab, port: 9222 });
await Promise.all([c.Page.enable(), c.Runtime.enable()]);
await c.Emulation.setDeviceMetricsOverride({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await c.Page.navigate({ url: "http://localhost:8093/claude-native.html" }); await c.Page.loadEventFired();
const ev = async (e) => (await c.Runtime.evaluate({ expression: e, returnByValue: true, awaitPromise: true })).result.value;
for (let i = 0; i < 80; i++) { await sleep(250); if (await ev("window.nanobox && window.nanobox.signinMs != null")) break; }
if (keys) await ev(`window.nanobox.send(${JSON.stringify(JSON.parse('"' + keys + '"'))})`);
await sleep(Number(secs || 4) * 1000);
console.log((await ev("window.nanobox.screen()")).trim().split("\n").filter((l) => l.trim()).slice(-22).join("\n"));
const d = await ev("window.nanobox.dump()");
console.log("\nspawns:", JSON.stringify(d.spawns.slice(-5)), "\nmissing:", d.missing.map((m) => m.key).join(", "));
const { data } = await c.Page.captureScreenshot({ format: "png" }); (await import("node:fs")).writeFileSync("web/results/claude-native-probe.png", Buffer.from(data, "base64"));
await CDP.Close({ id: tab.id, port: 9222 }); process.exit(0);
