import CDP from "chrome-remote-interface";
const url = process.argv[2]; const T = Number(process.argv[3] || 150);
const tab = await CDP.New({ port: 9222, url: "about:blank" });
const client = await CDP({ target: tab, port: 9222 });
const { Page, Runtime } = client; await Page.enable(); await Runtime.enable();
const t0 = Date.now(); await Page.navigate({ url }); await Page.loadEventFired();
let last = "";
while ((Date.now() - t0) / 1000 < T) {
  await new Promise(r => setTimeout(r, 1000));
  const { result } = await Runtime.evaluate({ expression: "window.nanobox ? window.nanobox.screen() : ''", returnByValue: true });
  const s = result.value || "";
  if (s !== last) { last = s; const line = s.trim().split("\n").filter(Boolean).slice(-1)[0] || ""; console.log(`t+${Math.round((Date.now()-t0)/1000)}s ${line.slice(0,80)}`); }
  if (/sign in|chatgpt/i.test(s)) { console.log(`SIGNIN at ${Math.round((Date.now()-t0)/1000)}s`); break; }
}
await CDP.Close({ id: tab.id, port: 9222 }); process.exit(0);
