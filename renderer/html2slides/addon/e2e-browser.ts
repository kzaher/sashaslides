#!/usr/bin/env npx tsx
/**
 * e2e-browser.ts — pure browser-automation E2E for the html2slides add-on.
 * No API, no clasp. It drives the signed-in Chrome on :9222 to:
 *   1. open the bound Apps Script editor (Extensions → Apps Script),
 *   2. overwrite Code.gs / appsscript.json / Sidebar.html via the Monaco API
 *      with the freshly-built dist files, and save (Ctrl+S),
 *   3. reload the deck, open Extensions → html2slides → the sidebar,
 *   4. queue a demo .html via the sidebar file input and click Insert,
 *   5. scrape console + exceptions, screenshot every step, and report whether
 *      slides were inserted (expectation: deck slide count increases).
 *
 * Artifacts: /tmp/e2e-br/NN_*.png  and  /tmp/e2e-br/console.log
 */
import CDP from "chrome-remote-interface";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const PORT = 9222;
const ROOT = "/workspaces/sashaslides";
const PID = process.env.PID || "1If1xjsogouF6tx_O_e0HFHHUYAjf1bfdh8grEB2aTz4";
const ADDON = `${ROOT}/dist/renderer/html2slides/addon`;
const DEMO_HTML = `${ROOT}/renderer/html2slides/e2e/fixtures/slide_31.html`;
const OUT = "/tmp/e2e-br";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

let shotN = 0;
const log: string[] = [];
function L(s: string) { log.push(s); writeFileSync(`${OUT}/console.log`, log.join("\n")); console.log(s); }
const evalv = async (R: any, e: string) => (await R.evaluate({ returnByValue: true, expression: e })).result.value;
async function clk(I: any, x: number, y: number) {
  await I.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 }); await sleep(60);
  await I.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function clickText(R: any, I: any, texts: string[]): Promise<string | null> {
  const r = await evalv(R, `(()=>{const ts=${JSON.stringify(texts)};for(const el of document.querySelectorAll('button,[role=button],[role=menuitem],span,div')){const t=(el.textContent||'').trim();if(ts.some(x=>t===x)){const b=el.getBoundingClientRect();if(b.width>1&&b.height>1)return{x:b.x+b.width/2,y:b.y+b.height/2,t}}}return null})()`);
  if (r) { await clk(I, r.x, r.y); return r.t; } return null;
}
async function key(I: any, k: string, code: number, mods = 0) {
  await I.dispatchKeyEvent({ type: "rawKeyDown", key: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: mods }); await sleep(40);
  await I.dispatchKeyEvent({ type: "keyUp", key: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: mods });
}
async function shot(client: any, label: string) {
  try { const { data } = await client.Page.captureScreenshot({ format: "png" });
    const p = `${OUT}/${String(++shotN).padStart(2, "0")}_${label}.png`; writeFileSync(p, Buffer.from(data, "base64")); L("  shot → " + p);
  } catch (e) { L("  shot(" + label + ") failed: " + (e as Error).message); }
}
async function instrument(client: any, tag: string) {
  const { Runtime } = client; await Runtime.enable().catch(() => {});
  Runtime.consoleAPICalled((e: any) => L(`[${tag}][${e.type}] ` + (e.args || []).map((a: any) => a.value ?? a.description ?? "").join(" ")));
  Runtime.exceptionThrown((e: any) => L(`[${tag}][EXCEPTION] ` + (e.exceptionDetails?.exception?.description || e.exceptionDetails?.text)));
}
async function wideTab(target: any) {
  const c = await CDP({ target, port: PORT });
  await c.Page.enable(); await c.Runtime.enable();
  await c.Emulation.setDeviceMetricsOverride({ width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });
  return c;
}
const list = () => (CDP as any).List({ port: PORT });
const findPres = async () => (await list()).find((t: any) => t.type === "page" && t.url.includes(PID));
const findEditor = async () => (await list()).find((t: any) => t.type === "page" && /script\.google\.com/.test(t.url));

// --- 1+2: open editor, push files, save -----------------------------------
async function deployViaEditor() {
  L("editor: opening bound Apps Script project…");
  for (const t of await list()) if (t.type === "page" && /(docs|script)\.google\.com/.test(t.url)) await (CDP as any).Close({ port: PORT, id: t.id }).catch(() => {});
  await sleep(800);
  const presTab = await (CDP as any).New({ port: PORT, url: `https://docs.google.com/presentation/d/${PID}/edit` });
  const pc = await wideTab(presTab); await pc.Target.activateTarget({ targetId: presTab.id });
  for (let i = 0; i < 40; i++) { if (await evalv(pc.Runtime, `!!([...document.querySelectorAll('[role=menubar] [role=menuitem]')].find(m=>m.textContent.trim()==='Extensions'))`)) break; await sleep(500); }
  await sleep(1200); await clickText(pc.Runtime, pc.Input, ["No thanks", "Dismiss"]); await sleep(600);
  const ext = await evalv(pc.Runtime, `(()=>{for(const i of document.querySelectorAll('[role=menubar] [role=menuitem]'))if(i.textContent.trim()==='Extensions'){const r=i.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}return null})()`);
  await clk(pc.Input, ext.x, ext.y); await sleep(1800);
  const as = await evalv(pc.Runtime, `(()=>{for(const i of document.querySelectorAll('[role=menuitem]')){const t=(i.textContent||'').trim();if(t.startsWith('Apps Script')){const r=i.getBoundingClientRect();if(r.width>0)return{x:r.x+r.width/2,y:r.y+r.height/2}}}return null})()`);
  if (!as) throw new Error("Apps Script menu item not found");
  await clk(pc.Input, as.x, as.y); await sleep(12000);
  const edTab = await findEditor(); if (!edTab) throw new Error("editor tab did not open");
  L("editor: " + edTab.url.slice(0, 70));
  const ec = await wideTab(edTab); await instrument(ec, "editor"); await sleep(5000); await shot(ec, "editor_open");
  const probe = await evalv(ec.Runtime, `JSON.stringify({monaco:typeof monaco,models:(typeof monaco!=='undefined'&&monaco.editor?monaco.editor.getModels().map(m=>m.getValue().length):[])})`);
  L("editor: " + probe);
  // overwrite each model (match by current-content signature) with the new dist file
  const files = [
    { label: "appsscript.json", match: `v=>v.trimStart().startsWith('{')`, src: readFileSync(`${ADDON}/appsscript.json`, "utf-8") },
    { label: "Code.gs", match: `v=>v.includes('insertPptxAfterCurrent')`, src: readFileSync(`${ADDON}/Code.gs`, "utf-8") },
    { label: "Sidebar.html", match: `v=>/^<!doctype/i.test(v.trimStart())`, src: readFileSync(`${ADDON}/Sidebar.html`, "utf-8") },
  ];
  for (const f of files) {
    const res = await evalv(ec.Runtime, `(()=>{const want=${JSON.stringify(f.src)};const ok=(${f.match});const m=monaco.editor.getModels().find(x=>ok(x.getValue()));if(!m)return 'NO_MODEL';const old=m.getValue().length;m.setValue(want);return 'set '+f_label+' '+old+'->'+m.getValue().length;})()`.replace("f_label", JSON.stringify(f.label)));
    L(`editor: ${f.label} → ${res}`);
  }
  await sleep(800);
  // save: click INTO the editor to focus it, then Ctrl+S (a bare key event
  // with no focus goes nowhere → the "stuck saving / stale code" we saw).
  await clk(ec.Input, 800, 300); await sleep(300);
  await ec.Runtime.evaluate({ expression: `monaco.editor.getEditors()[0] && monaco.editor.getEditors()[0].focus()` });
  await key(ec.Input, "s", 83, 2); await sleep(2000);
  let savedState = "saving";
  for (let i = 0; i < 12; i++) {
    savedState = await evalv(ec.Runtime, `document.body.innerText.includes('Saving')?'saving':'saved'`);
    if (savedState !== "saving") break; await sleep(2000);
  }
  await shot(ec, "editor_saved"); L("editor: save state = " + savedState);
  await sleep(2000);
  await ec.close();
  return pc;
}

// --- 3+4+5: open sidebar, insert, verify ----------------------------------
async function driveSidebar(oldPc: any) {
  // FRESH OPEN (not reload): the onOpen simple trigger fires on document OPEN,
  // so close the tab and open a brand-new one to get the menu created.
  L("ui: fresh-opening deck so onOpen fires…");
  await oldPc.close().catch(() => {});
  for (const t of await list()) if (t.type === "page" && /docs\.google\.com/.test(t.url)) await (CDP as any).Close({ port: PORT, id: t.id }).catch(() => {});
  await sleep(1000);
  const tab = await (CDP as any).New({ port: PORT, url: `https://docs.google.com/presentation/d/${PID}/edit` });
  const pc = await wideTab(tab); await pc.Target.activateTarget({ targetId: tab.id }); await instrument(pc, "slides");
  for (let i = 0; i < 40; i++) { if (await evalv(pc.Runtime, `!!([...document.querySelectorAll('[role=menubar] [role=menuitem]')].find(m=>m.textContent.trim()==='Extensions'))`)) break; await sleep(500); }
  await sleep(4000);
  await clickText(pc.Runtime, pc.Input, ["No thanks", "Dismiss"]); await sleep(600);
  const before = await evalv(pc.Runtime, `document.querySelectorAll('.punch-filmstrip-thumbnail').length`);
  L("ui: slides before = " + before); await shot(pc, "deck_reloaded");
  // Top-level "html2slides" menubar menu (createMenu) → Open html2slides
  const menubar = await evalv(pc.Runtime, `[...document.querySelectorAll('[role=menubar] [role=menuitem]')].map(i=>i.textContent.trim())`);
  L("ui: menubar = " + JSON.stringify(menubar));
  const m = await evalv(pc.Runtime, `(()=>{for(const i of document.querySelectorAll('[role=menubar] [role=menuitem]'))if(i.textContent.trim()==='html2slides'){const r=i.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}return null})()`);
  if (!m) { L("ui: ✗ 'html2slides' menu NOT in menubar — onOpen menu missing"); return { before, after: before }; }
  await clk(pc.Input, m.x, m.y); await sleep(1500); await shot(pc, "addon_menu");
  const opened = await clickText(pc.Runtime, pc.Input, ["Open html2slides", "Open"]); L("ui: open → " + opened); await sleep(7000); await shot(pc, "sidebar");
  // sidebar lives in a googleusercontent iframe target
  const sb = (await list()).find((t: any) => t.type === "iframe" && /googleusercontent|script\.google/.test(t.url));
  if (!sb) { L("ui: sidebar iframe target NOT FOUND"); return { before, after: before }; }
  const sc = await CDP({ target: sb, port: PORT }); await sc.Runtime.enable(); await sc.DOM.enable(); await instrument(sc, "sidebar");
  L("ui: sidebar target = " + sb.url.slice(0, 60));
  // queue demo HTML via the file input, then click Insert
  const doc = await sc.DOM.getDocument({ depth: -1 });
  const pick = await sc.DOM.querySelector({ nodeId: doc.root.nodeId, selector: "#picker" });
  if (!pick.nodeId) { L("ui: #picker not found in sidebar"); return { before, after: before }; }
  await sc.DOM.setFileInputFiles({ files: [DEMO_HTML], nodeId: pick.nodeId });
  await sc.Runtime.evaluate({ expression: `document.getElementById('picker').dispatchEvent(new Event('change',{bubbles:true}))` });
  await sleep(1500); await shot(pc, "queued");
  L("ui: clicking Insert…");
  await sc.Runtime.evaluate({ expression: `document.getElementById('insert-btn').click()` });
  await sleep(22000); await shot(pc, "after_insert");
  // capture the sidebar log text (the add-on's own #log shows insert errors)
  const sidebarLog = await evalv(sc.Runtime, `(document.getElementById('log')||{}).innerText||''`);
  L("ui: sidebar #log:\n" + sidebarLog);
  const after = await evalv(pc.Runtime, `document.querySelectorAll('.punch-filmstrip-thumbnail').length`);
  await sc.close().catch(() => {});
  return { before, after };
}

async function main() {
  L(`=== e2e-browser start (PID=${PID}) ===`);
  try {
    const pc = await deployViaEditor();
    const { before, after } = await driveSidebar(pc);
    L(`RESULT: slides ${before} → ${after} — ${after > before ? "PASS ✓ slides inserted" : "FAIL ✗ no new slides"}`);
    await pc.close();
  } catch (e) { L("E2E ERROR: " + (e as Error).message + "\n" + (e as Error).stack); process.exit(1); }
  L("=== done ===");
}
main();
