#!/usr/bin/env npx tsx
/**
 * insert-via-ui.ts — insert html2slides output into an EXISTING Google Slides
 * deck using pure INTERACTIVE browser automation (File ▸ Import slides), driven
 * over CDP against the signed-in Chrome on :9222.
 *
 * Why: the Apps Script add-on's server calls (google.script.run) and onOpen
 * triggers are blocked on this account ("reading from storage PERMISSION_DENIED")
 * — only INTERACTIVE editor/UI actions succeed. So we drive the UI the way a
 * user would: convert → upload the .pptx to Drive → File ▸ Import slides ▸
 * search ▸ pick ▸ Select all slides ▸ Import slides.
 *
 * Usage:
 *   npx tsx insert-via-ui.ts --pid <PRESENTATION_ID> --html <file-or-dir> [--only slide_NN.html]
 *
 * Prereqs: headless Chrome signed into the target Google account on :9222
 *   (google-chrome-stable --headless=new --remote-debugging-port=9222
 *    --no-sandbox --user-data-dir=/home/node/chrome-profile)
 */
import CDP from "chrome-remote-interface";
import { execFileSync } from "child_process";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { basename, resolve } from "path";

const PORT = 9222;
const ROOT = "/workspaces/sashaslides";
function arg(name: string, def = ""): string { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }
const PID = arg("pid", "1If1xjsogouF6tx_O_e0HFHHUYAjf1bfdh8grEB2aTz4");
const HTML = resolve(arg("html", `${ROOT}/renderer/html2slides/e2e/fixtures`));
const ONLY = arg("only", "slide_31.html");
const STAMP = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const NAME = `html2slides_${STAMP}`;
const PPTX = `/tmp/${NAME}.pptx`;
const OUT = "/tmp/insert-ui"; mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let shotN = 0;
const ev = async (R: any, e: string) => (await R.evaluate({ returnByValue: true, expression: e })).result.value;
async function click(I: any, x: number, y: number) { await I.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 }); await sleep(55); await I.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 }); }
async function dbl(I: any, x: number, y: number) { await click(I, x, y); await sleep(80); await I.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 2 }); await sleep(40); await I.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 2 }); }
async function shot(P: any, l: string) { const s = await P.captureScreenshot({ format: "png" }); writeFileSync(`${OUT}/${String(++shotN).padStart(2, "0")}_${l}.png`, Buffer.from(s.data, "base64")); }
async function clickText(R: any, I: any, texts: string[]): Promise<string | null> {
  const r = await ev(R, `(()=>{const ts=${JSON.stringify(texts)};const els=[...document.querySelectorAll('button,[role=button]')].map(e=>({e,t:(e.textContent||'').trim()})).filter(o=>ts.some(x=>o.t===x)).sort((a,b)=>a.t.length-b.t.length);for(const o of els){const b=o.e.getBoundingClientRect();if(b.width>1&&b.height>1){o.e.scrollIntoView({block:'center'});const r=o.e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,t:o.t}}}return null})()`);
  if (r) { await click(I, r.x, r.y); return r.t; } return null;
}
const list = () => (CDP as any).List({ port: PORT });

async function buildPptx() {
  console.log(`[1/3] convert ${ONLY} → ${PPTX}`);
  execFileSync("npx", ["tsx", "convert-pptx.ts", HTML, "--only", ONLY, "--no-upload", "--out", PPTX],
    { cwd: `${ROOT}/renderer/html2slides`, stdio: "inherit" });
  if (!existsSync(PPTX)) throw new Error("pptx not built");
}

async function uploadToDrive() {
  console.log(`[2/3] upload ${basename(PPTX)} to Drive`);
  const tab = await (CDP as any).New({ port: PORT, url: "https://drive.google.com/drive/my-drive" });
  const c = await CDP({ target: tab, port: PORT }); const { Page, Runtime, DOM } = c;
  await Page.enable(); await DOM.enable(); await Page.loadEventFired(); await sleep(4000);
  // inject a file input we control, attach the pptx, drop it on Drive's main pane
  await Runtime.evaluate({ expression: `(()=>{const i=document.createElement('input');i.type='file';i.id='__up__';i.style.cssText='position:fixed;top:0;left:0;z-index:9999';document.body.appendChild(i);})()` });
  const doc = await DOM.getDocument({ depth: -1 });
  const inp = await DOM.querySelector({ nodeId: doc.root.nodeId, selector: "#__up__" });
  await DOM.setFileInputFiles({ files: [PPTX], nodeId: inp.nodeId });
  await Runtime.evaluate({ awaitPromise: true, expression: `(async()=>{const f=document.getElementById('__up__').files[0];const dz=document.querySelector('[role=main]')||document.body;const dt=new DataTransfer();dt.items.add(f);dz.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));dz.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));})()` });
  // wait for the upload toast to report completion
  for (let i = 0; i < 30; i++) { const t = await ev(Runtime, `(document.body.innerText.match(/upload(s)? complete|1 upload/i)||[''])[0]`); if (t) break; await sleep(1000); }
  await sleep(2500); await c.close();
}

async function importIntoDeck(): Promise<boolean> {
  console.log(`[3/3] File ▸ Import slides ▸ ${NAME}`);
  for (const t of await list()) if (t.type === "page" && /docs\.google\.com\/presentation/.test(t.url)) await (CDP as any).Close({ port: PORT, id: t.id }).catch(() => {});
  const tab = await (CDP as any).New({ port: PORT, url: `https://docs.google.com/presentation/d/${PID}/edit` });
  const c = await CDP({ target: tab, port: PORT }); const { Runtime, Input, Page, Target, Emulation } = c;
  await Page.enable(); await Target.activateTarget({ targetId: tab.id });
  await Emulation.setDeviceMetricsOverride({ width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });
  for (let i = 0; i < 40; i++) { if (await ev(Runtime, `!!([...document.querySelectorAll('[role=menubar] [role=menuitem]')].find(m=>m.textContent.trim()==='File'))`)) break; await sleep(500); }
  await sleep(1500);
  await clickText(Runtime, Input, ["No thanks"]); await sleep(500);
  const before = await ev(Runtime, `document.querySelectorAll('.punch-filmstrip-thumbnail').length`);
  // File ▸ Import slides
  const f = await ev(Runtime, `(()=>{for(const i of document.querySelectorAll('[role=menubar] [role=menuitem]'))if(i.textContent.trim()==='File'){const r=i.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}})()`);
  await click(Input, f.x, f.y); await sleep(900);
  const imp = await ev(Runtime, `(()=>{for(const el of document.querySelectorAll('[role=menuitem],span,div')){const t=(el.textContent||'').trim();if(t.startsWith('Import slides')){const r=el.getBoundingClientRect();if(r.width>0)return{x:r.x+r.width/2,y:r.y+r.height/2}}}})()`);
  await click(Input, imp.x, imp.y); await sleep(7000); await shot(Page, "picker");
  // search the picker (iframe → drive via coordinates), Enter to filter
  await click(Input, 760, 192); await sleep(500); await Input.insertText({ text: NAME }); await sleep(800);
  await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "Enter", windowsVirtualKeyCode: 13 }); await Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(4000); await shot(Page, "filtered");
  // first (only) result thumbnail, then Select all slides ▸ Import slides
  await dbl(Input, 237, 310); await sleep(5000); await shot(Page, "slidesel");
  await clickText(Runtime, Input, ["Select all slides"]); await sleep(1200);
  await clickText(Runtime, Input, ["Import slides"]); await sleep(14000); await shot(Page, "after");
  const after = await ev(Runtime, `document.querySelectorAll('.punch-filmstrip-thumbnail').length`);
  console.log(`RESULT: slides ${before} → ${after} — ${after > before ? "PASS ✓ inserted" : "FAIL ✗"}`);
  await c.close();
  return after > before;
}

async function main() {
  await buildPptx();
  await uploadToDrive();
  const ok = await importIntoDeck();
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
