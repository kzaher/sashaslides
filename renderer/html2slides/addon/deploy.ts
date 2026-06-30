#!/usr/bin/env npx tsx
/**
 * deploy.ts — overwrite the bound Apps Script project's files in ONE command,
 * with no manual copy-pasting.
 *
 * Why browser automation (not clasp / Apps Script API): Google blocks clasp's
 * default OAuth client, and the Apps Script API is disabled on this account's
 * GCP project (the console is 2SV-gated). Interactive editor actions DO work,
 * so we drive the signed-in Chrome on :9222: open the project editor and set
 * each file's content via the editor's own Monaco API, then save (Ctrl+S).
 *
 * Usage:
 *   npm run build:addon          # regenerate dist/.../addon/{Code.gs,...}
 *   npx tsx renderer/html2slides/addon/deploy.ts
 *   # or, with overrides:
 *   SCRIPT_ID=<id> UIDX=1 npx tsx .../deploy.ts
 *
 * Prereq: headless Chrome signed into the project's Google account on :9222:
 *   google-chrome-stable --headless=new --remote-debugging-port=9222 \
 *     --no-sandbox --user-data-dir=/home/node/chrome-profile
 */
import CDPraw from "chrome-remote-interface";
import { readFileSync } from "fs";
import type { CdpModule } from "../../../types/cdp-types.ts";

const CDP = CDPraw as CdpModule;
const PORT = 9222;
const ADDON = "/workspaces/sashaslides/dist/renderer/html2slides/addon";
const U = process.env.UIDX || "0";
const SCRIPT_ID = process.env.SCRIPT_ID || "1z0Iu55KZcCjkLu74LTrPYWhU7IWueNUWtPV5-iV-cpWMO_WC6X8rmzVH";
const EDITOR_URL = `https://script.google.com/u/${U}/home/projects/${SCRIPT_ID}/edit`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ev = async (R: any, e: string) => (await R.evaluate({ returnByValue: true, expression: e })).result.value;

// Each file is matched to its open Monaco model by a content signature, so we
// never depend on model order. type lets us add files later if needed.
const FILES = [
  { label: "appsscript.json", match: `v => v.trimStart().startsWith('{')`, src: `${ADDON}/appsscript.json` },
  { label: "Code.gs", match: `v => v.includes('insertPptxAfterCurrent')`, src: `${ADDON}/Code.gs` },
  { label: "Sidebar.html", match: `v => /^<!doctype/i.test(v.trimStart())`, src: `${ADDON}/Sidebar.html` },
];

async function main() {
  console.log(`deploy: opening project u/${U} ${SCRIPT_ID.slice(0, 16)}…`);
  // close stale google tabs so we get a clean editor
  for (const t of await (CDP as any).List({ port: PORT })) {
    if (t.type === "page" && /(docs|script)\.google\.com/.test(t.url)) await (CDP as any).Close({ port: PORT, id: t.id }).catch(() => {});
  }
  await sleep(800);
  const tab = await (CDP as any).New({ port: PORT, url: EDITOR_URL });
  const c = await CDP({ target: tab, port: PORT });
  await c.Page.enable(); await c.Runtime.enable(); await c.Target.activateTarget({ targetId: tab.id });
  await c.Emulation.setDeviceMetricsOverride({ width: 1500, height: 950, deviceScaleFactor: 1, mobile: false });

  // wait for Monaco + all file models to load
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (await ev(c.Runtime, `typeof monaco !== 'undefined' && monaco.editor && monaco.editor.getModels().length >= ${FILES.length}`)) { ready = true; break; }
    await sleep(700);
  }
  if (!ready) { console.error("deploy: ✗ editor/Monaco didn't load (is Chrome signed into the right account?)"); process.exit(1); }
  await sleep(2500);

  for (const f of FILES) {
    const src = readFileSync(f.src, "utf-8");
    const res = await ev(c.Runtime, `(() => {
      const want = ${JSON.stringify(src)};
      const ok = (${f.match});
      const m = monaco.editor.getModels().find(x => ok(x.getValue()));
      if (!m) return 'NO_MODEL';
      const old = m.getValue().length;
      if (m.getValue() === want) return 'unchanged (' + old + ')';
      m.setValue(want);
      return old + ' -> ' + m.getValue().length;
    })()`);
    console.log(`deploy: ${f.label.padEnd(16)} ${res}`);
  }

  // save: focus the editor, Ctrl+S (saves the whole project), wait for it to settle
  await c.Input.dispatchMouseEvent({ type: "mousePressed", x: 800, y: 320, button: "left", clickCount: 1 }); await sleep(40);
  await c.Input.dispatchMouseEvent({ type: "mouseReleased", x: 800, y: 320, button: "left", clickCount: 1 }); await sleep(300);
  await c.Runtime.evaluate({ expression: `monaco.editor.getEditors()[0] && monaco.editor.getEditors()[0].focus()` });
  await c.Input.dispatchKeyEvent({ type: "rawKeyDown", key: "s", windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, modifiers: 2 }); await sleep(40);
  await c.Input.dispatchKeyEvent({ type: "keyUp", key: "s", windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83, modifiers: 2 });
  await sleep(8000);
  console.log("deploy: ✓ saved. Reload the presentation to pick up the new code.");
  await c.close();
  process.exit(0);
}
main().catch((e) => { console.error("deploy ERROR:", (e as Error).message); process.exit(1); });
