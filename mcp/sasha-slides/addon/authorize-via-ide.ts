#!/usr/bin/env npx tsx
/**
 * Run `showSidebar` in the container-bound Apps Script project and carry its first-run
 * authorization through to Allow, over CDP.
 *
 * Must be ONE uninterrupted run: the "Authorization required" dialog is transient, and the
 * consent window is opened by `window.open` from inside the editor, so it only appears for a
 * TRUSTED gesture. A JS-dispatched click (the technique the Slides menubar needs) is NOT
 * trusted and the popup is silently blocked — every press here therefore goes through
 * Input.dispatchMouseEvent at real coordinates.
 */
import CDPraw from "chrome-remote-interface";
import type { CdpClient, CdpModule } from "../../../types/cdp-types.ts";

// chrome-remote-interface ships no .d.ts; CdpModule is the repo's shared boundary type.
const CDP = CDPraw as CdpModule;

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const SCRIPT_ID = option("--script-id") ?? "1GqibbX21wU_8SMuFAC8nWStv6Y8wfrBNfiK1nQnbiawQXuABRNgr9NFo";
const PORT = Number(option("--port") ?? 9223);
const EMAIL = option("--email") ?? "ante.materija@gmail.com";

type Target = Readonly<{ id: string; type: string; url: string; title: string }>;
type Hit = Readonly<{ x: number; y: number; label: string }>;

const targets = async (): Promise<readonly Target[]> =>
  (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as readonly Target[];

/**
 * A successful grant makes the consent popup close itself, which tears the websocket down
 * mid-command. That is the SUCCESS path, not an error, so it is reported as CLOSED rather
 * than thrown.
 */
async function ev(c: CdpClient, expression: string): Promise<string> {
  try {
    const { result, exceptionDetails } = await c.Runtime.evaluate({ expression, returnByValue: true });
    if (exceptionDetails !== undefined) return `THREW ${exceptionDetails.text}`;
    return typeof result.value === "string" ? result.value : String(result.value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return /WebSocket is not open|Target closed|disconnected/i.test(message) ? "CLOSED" : `THREW ${message}`;
  }
}

async function realClick(c: CdpClient, hit: Hit): Promise<void> {
  await c.Input.dispatchMouseEvent({ type: "mouseMoved", x: hit.x, y: hit.y });
  await c.Input.dispatchMouseEvent({ type: "mousePressed", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: "mouseReleased", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
}

/** Centre of the first visible element whose text matches a pattern, patterns tried in order. */
const FIND = (patterns: readonly string[]): string => `((pats) => {
  const nodes = document.querySelectorAll('li,button,[role=button],[role=link],a,input[type=submit],div[data-identifier],span');
  for (const p of pats) {
    const re = new RegExp(p, 'i');
    for (const n of nodes) {
      const s = (n.innerText || n.value || n.getAttribute('aria-label') || '').trim();
      if (!s || s.length > 120 || !re.test(s)) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight) continue;
      return JSON.stringify({ x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), label: s.replace(/\\s+/g,' ').slice(0,60) });
    }
  }
  return null;
})(${JSON.stringify(patterns)})`;

async function findHit(c: CdpClient, patterns: readonly string[]): Promise<Hit | null> {
  const raw = await ev(c, FIND(patterns));
  return raw === "null" || raw.startsWith("THREW") ? null : (JSON.parse(raw) as Hit);
}

async function main(): Promise<void> {
  const before = await targets();
  const known = new Set(before.map((t) => t.id));
  const editorTarget = before.find((x) => x.type === "page" && x.url.includes(SCRIPT_ID));
  if (editorTarget === undefined) { console.error(`no editor tab containing ${SCRIPT_ID}`); process.exitCode = 1; return; }

  const editor: CdpClient = await CDP({ port: PORT, target: editorTarget.id });
  await editor.Runtime.enable();
  await editor.Page.enable();
  await editor.Page.bringToFront();

  // Pick the function, then press Run with a real gesture.
  await ev(editor, `(() => {
    const o = [...document.querySelectorAll('[role=option],option')].find(x => (x.innerText||x.textContent||'').trim() === 'showSidebar');
    if (o) { o.click(); }
    return 'ok';
  })()`);
  await new Promise((r) => setTimeout(r, 700));
  const run = await findHit(editor, ["^Run$"]);
  const runBtn = run ?? JSON.parse(await ev(editor, `(() => {
    const b = [...document.querySelectorAll('button,[role=button]')].find(x => (x.getAttribute('aria-label')||'').trim() === 'Run the selected function');
    if (!b) return 'null';
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), label: 'Run' });
  })()`)) as Hit;
  await realClick(editor, runBtn);
  console.log("pressed Run");

  // The dialog is transient: poll for it and press it in the same session, real gesture.
  let review: Hit | null = null;
  const dlgDeadline = Date.now() + 20000;
  while (Date.now() < dlgDeadline && review === null) {
    review = await findHit(editor, ["^Review permissions$"]);
    if (review === null) await new Promise((r) => setTimeout(r, 300));
  }
  if (review === null) { console.error("Authorization dialog never appeared"); await editor.close(); process.exitCode = 1; return; }
  await realClick(editor, review);
  console.log("pressed Review permissions");

  let popup: Target | undefined;
  const popDeadline = Date.now() + 18000;
  while (Date.now() < popDeadline && popup === undefined) {
    popup = (await targets()).find((x) => !known.has(x.id) && x.type === "page");
    if (popup === undefined) await new Promise((r) => setTimeout(r, 400));
  }
  await editor.close();
  if (popup === undefined) { console.error("consent window never opened (popup blocked?)"); process.exitCode = 1; return; }
  console.log("consent window:", popup.url.slice(0, 100));

  const c: CdpClient = await CDP({ port: PORT, target: popup.id });
  await c.Runtime.enable();
  await c.Page.enable();
  await c.Page.bringToFront();

  for (let step = 0; step < 18; step++) {
    await new Promise((r) => setTimeout(r, 1500));
    const raw = await ev(c, `JSON.stringify({ url: location.href, text: (document.body?document.body.innerText:'').replace(/\\s+/g,' ').slice(0,220) })`);
    if (raw === "CLOSED") { console.log(`[${step}] consent window closed itself — grant complete`); break; }
    if (raw.startsWith("THREW")) continue;
    let state: { url: string; text: string };
    try { state = JSON.parse(raw) as { url: string; text: string }; } catch { continue; }

    if (/You may close this window|has been granted|authorization is complete|Success/i.test(state.text)) { console.log(`[${step}] GRANTED`); break; }
    if (/signin\/oauth\/error/.test(state.url)) { console.error(`[${step}] consent error: ${state.text.slice(0,140)}`); process.exitCode = 1; break; }

    if (/hasn.t verified|not been verified/i.test(state.text)) {
      const adv = await findHit(c, ["^advanced$"]);
      if (adv !== null) { await realClick(c, adv); console.log(`[${step}] Advanced`); await new Promise((r) => setTimeout(r, 900)); }
      const go = await findHit(c, ["^go to .*unsafe", "^go to "]);
      if (go !== null) { await realClick(c, go); console.log(`[${step}] ${go.label}`); continue; }
    }

    if (/Select what|wants additional access|wants access/i.test(state.text)) {
      const boxRaw = await ev(c, `(() => {
        const b = [...document.querySelectorAll('input[type=checkbox]')].filter(e => e.getBoundingClientRect().top > 0)[0];
        if (!b) return 'null';
        const r = b.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), label: 'select all' });
      })()`);
      if (boxRaw !== "null" && !boxRaw.startsWith("THREW")) {
        await realClick(c, JSON.parse(boxRaw) as Hit);
        await new Promise((r) => setTimeout(r, 900));
      }
      await ev(c, `(window.scrollTo(0, document.documentElement.scrollHeight), 'ok')`);
      await new Promise((r) => setTimeout(r, 600));
    }

    const hit = await findHit(c, ["^(continue|allow|accept)$", EMAIL.replace(/\./g, "\\."), "^(next)$"]);
    if (hit === null) { console.log(`[${step}] nothing to press | ${state.text.slice(0,90)}`); continue; }
    await realClick(c, hit);
    console.log(`[${step}] pressed ${hit.label}`);
  }
  await c.close();
}
void main();
