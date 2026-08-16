import CDP from "chrome-remote-interface";
const targets = await CDP.List({ port: 9222 });
const t = targets.find((x) => x.url.includes(process.argv[2] || "vm.html"));
if (!t) { console.log("no tab"); process.exit(0); }
const c = await CDP({ target: t, port: 9222 });
const r = await c.Runtime.evaluate({ expression: process.argv[3] || "window.nanobox ? window.nanobox.screen() : ''", returnByValue: true });
console.log(String(r.result.value).trim().split("\n").filter(l=>l.trim()).slice(-30).join("\n"));
await c.close();
