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
// The bound Apps Script project lives under account index U (here u/1, NOT u/0).
// Running under the wrong account caused "PERMISSION_DENIED reading from storage".
const U = process.env.UIDX || "1";
const SCRIPT_ID = process.env.SCRIPT_ID || "1z0Iu55KZcCjkLu74LTrPYWhU7IWueNUWtPV5-iV-cpWMO_WC6X8rmzVH";
const EDITOR_URL = `https://script.google.com/u/${U}/home/projects/${SCRIPT_ID}/edit`;
const PRES_URL = `https://docs.google.com/presentation/u/${U}/d/${PID}/edit`;
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
  L(`editor: opening project DIRECTLY under u/${U}: ${EDITOR_URL.slice(0, 80)}`);
  for (const t of await list()) if (t.type === "page" && /(docs|script)\.google\.com/.test(t.url)) await (CDP as any).Close({ port: PORT, id: t.id }).catch(() => {});
  await sleep(800);
  const edTab = await (CDP as any).New({ port: PORT, url: EDITOR_URL });
  const ec = await wideTab(edTab); await ec.Target.activateTarget({ targetId: edTab.id }); await instrument(ec, "editor");
  // wait for Monaco to come up
  for (let i = 0; i < 40; i++) { if (await evalv(ec.Runtime, `typeof monaco !== 'undefined' && monaco.editor && monaco.editor.getModels().length >= 3`)) break; await sleep(700); }
  await sleep(3000); await shot(ec, "editor_open");
  L("editor: url=" + (await evalv(ec.Runtime, `location.href`)).slice(0, 70));
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
}

// --- 3+4+5: open sidebar, insert, verify ----------------------------------
async function driveSidebar() {
  // FRESH OPEN under u/${U}: the onOpen trigger fires on document OPEN, and the
  // u/${U} account context is the one that owns the bound script.
  L(`ui: fresh-opening deck under u/${U}: ${PRES_URL.slice(0, 70)}`);
  for (const t of await list()) if (t.type === "page" && /docs\.google\.com/.test(t.url)) await (CDP as any).Close({ port: PORT, id: t.id }).catch(() => {});
  await sleep(1000);
  const tab = await (CDP as any).New({ port: PORT, url: PRES_URL });
  const pc = await wideTab(tab); await pc.Target.activateTarget({ targetId: tab.id }); await instrument(pc, "slides");
  for (let i = 0; i < 40; i++) { if (await evalv(pc.Runtime, `!!([...document.querySelectorAll('[role=menubar] [role=menuitem]')].find(m=>m.textContent.trim()==='Extensions'))`)) break; await sleep(500); }
  await sleep(4000);
  await clickText(pc.Runtime, pc.Input, ["No thanks", "Dismiss"]); await sleep(600);
  const before = await evalv(pc.Runtime, `document.querySelectorAll('.punch-filmstrip-thumbnail').length`);
  L("ui: slides before = " + before); await shot(pc, "deck_reloaded");
  // POLL for the top-level "html2slides" menubar menu — onOpen adds it a few
  // seconds AFTER the menubar itself is ready (checking once was too early).
  // The custom createMenu() menu is NOT a [role=menuitem]; find any clickable
  // leaf with exact text 'html2slides' in the top menubar strip.
  const findMenu = `(()=>{for(const el of document.querySelectorAll('div,span,[role=menuitem],[role=button]')){if(el.children.length>1)continue;if((el.textContent||'').trim()==='html2slides'){const r=el.getBoundingClientRect();if(r.width>1&&r.height>1&&r.y<60)return{x:r.x+r.width/2,y:r.y+r.height/2}}}return null})()`;
  let m: any = null;
  for (let i = 0; i < 25; i++) { m = await evalv(pc.Runtime, findMenu); if (m) break; await sleep(1200); }
  if (!m) {
    L("ui: menubar = " + JSON.stringify(await evalv(pc.Runtime, `[...document.querySelectorAll('[role=menubar] [role=menuitem]')].map(i=>i.textContent.trim())`)));
    L("ui: ✗ 'html2slides' menu never appeared after 30s"); return { before, after: before };
  }
  L("ui: ✓ html2slides menu present");
  await clk(pc.Input, m.x, m.y); await sleep(1500); await shot(pc, "addon_menu");
  const opened = await clickText(pc.Runtime, pc.Input, ["Open html2slides", "Open"]); L("ui: open → " + opened); await sleep(7000); await shot(pc, "sidebar");
  // The sidebar content is a deeply-nested OOPIF that CDP's target list doesn't
  // expose, so drive it by SCREEN COORDINATES (clicks land on the rendered
  // iframe) + the system clipboard. Write the slide HTML to the clipboard from
  // the main page, focus the paste-box, Ctrl+V to queue, then click Insert.
  const demoHtml = readFileSync(DEMO_HTML, "utf-8");
  await pc.Browser.grantPermissions({ origin: "https://docs.google.com", permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
  const wrote = await evalv(pc.Runtime, `(async()=>{try{await navigator.clipboard.writeText(${JSON.stringify(demoHtml)});return 'ok'}catch(e){return 'ERR '+e.message}})()`);
  L("ui: clipboard write = " + wrote);
  // sidebar paste-box ≈ (1245,392); Insert button ≈ (1188,446) at the 1500-wide viewport
  await clk(pc.Input, 1245, 392); await sleep(500);
  await key(pc.Input, "v", 86, 2); await sleep(2500); await shot(pc, "queued");
  L("ui: clicking Insert (by coords)…");
  await clk(pc.Input, 1188, 446); await sleep(25000); await shot(pc, "after_insert");
  const after = await evalv(pc.Runtime, `document.querySelectorAll('.punch-filmstrip-thumbnail').length`);
  return { before, after };
}

async function main() {
  L(`=== e2e-browser start (PID=${PID}, u/${U}) ===`);
  try {
    await deployViaEditor();
    const { before, after } = await driveSidebar();
    L(`RESULT: slides ${before} → ${after} — ${after > before ? "PASS ✓ slides inserted" : "FAIL ✗ no new slides"}`);
  } catch (e) { L("E2E ERROR: " + (e as Error).message + "\n" + (e as Error).stack); }
  L("=== done ===");
  process.exit(0);
}
main();
