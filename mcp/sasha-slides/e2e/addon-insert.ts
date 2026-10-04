#!/usr/bin/env npx tsx
/**
 * The end of the line: pick a candidate in the REAL Apps Script add-on and prove the slide
 * Google serves afterwards is made of native, editable elements.
 *
 * Nothing here is shimmed. The sidebar is the deployed HtmlService bundle, the click is a
 * real click on its button, the insert runs in `Code.gs`, and the readback is a separate
 * `presentations.get` from this process -- so the add-on is never the only witness to its own
 * work.
 */
import CDPraw from "chrome-remote-interface";
import { google } from "googleapis";
import type { CdpClient, CdpModule } from "../../../types/cdp-types.ts";
import { evaluateText, realClick, bringToFront } from "./cdp-page.ts";
import { loadOAuthClient, describeAuthFailure } from "../google-auth.ts";

// chrome-remote-interface ships no .d.ts; CdpModule is the repo's shared boundary type.
const CDP = CDPraw as CdpModule;

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const DECK = option("--deck") ?? "1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U";
const PORT = Number(option("--port") ?? 9223);
const CHOICE = Number(option("--option") ?? 2);

type Point = Readonly<{ x: number; y: number }>;
type PageInfo = Readonly<{ id: string; kinds: readonly string[] }>;

const targets = async (): Promise<readonly { id: string; type: string; url: string }[]> =>
  (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as readonly { id: string; type: string; url: string }[];



const MENU_BUTTON = `(() => {
  const bar = document.querySelector('#docs-menubar');
  if (!bar) return 'null';
  const hits = [...bar.querySelectorAll('*')].filter(n => (n.innerText||'').trim() === 'SashaSlides' && n.getBoundingClientRect().width > 4);
  if (hits.length === 0) return 'null';
  const r = hits[hits.length-1].getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) });
})()`;

const MENU_ITEM = `(() => {
  const vis = [...document.querySelectorAll('.goog-menu')].filter(m => getComputedStyle(m).display !== 'none');
  const n = vis.flatMap(m => [...m.querySelectorAll('[role=menuitem]')]).find(x => (x.innerText||'').trim().startsWith('Open the picker'));
  if (!n) return 'null';
  const r = n.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) });
})()`;

async function pollPoint(c: CdpClient, expression: string, budgetMs: number): Promise<Point | null> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const raw = await evaluateText(c, expression);
    if (raw.startsWith("{")) return JSON.parse(raw) as Point;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function readDeck(): Promise<readonly PageInfo[]> {
  const loaded = await loadOAuthClient();
  if (loaded.kind !== "ok") throw new Error(describeAuthFailure(loaded));
  const slides = google.slides({ version: "v1", auth: loaded.auth });
  const got = await slides.presentations.get({ presentationId: DECK });
  return (got.data.slides ?? []).map((page) => ({
    id: page.objectId ?? "(no id)",
    kinds: (page.pageElements ?? []).map((el) =>
      el.shape !== undefined ? `shape/${el.shape.shapeType ?? "?"}` : el.table !== undefined ? "table" : el.line !== undefined ? "line" : el.image !== undefined ? "IMAGE" : "other",
    ),
  }));
}

/**
 * Evaluate inside the picker document.
 *
 * Re-opening the sidebar leaves STALE `userCodeAppPanel` targets in /json/list whose inner
 * document is empty, so the live one is found by content -- the panel whose nested document
 * actually has the picker in it -- not by being the first match.
 */
async function inPicker(expression: string): Promise<string> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const panels = (await targets()).filter((x) => x.url.includes("userCodeAppPanel"));
    for (const panel of panels) {
      let pc: CdpClient;
      try {
        pc = await CDP({ port: PORT, target: panel.id });
      } catch {
        continue;
      }
      await pc.Runtime.enable();
      const alive = await evaluateText(pc, `(() => {
        const f = document.querySelector('iframe');
        const d = f && f.contentDocument;
        return String(!!(d && d.body && d.body.querySelector('button')));
      })()`);
      if (alive === "true") {
        const out = await evaluateText(pc, expression);
        await pc.close();
        return out;
      }
      await pc.close();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return "no live picker";
}

async function clickInSidebar(label: string): Promise<string> {
  return inPicker(`(() => {
    const d = document.querySelector('iframe').contentDocument;
    const b = [...d.querySelectorAll('button,[role=button]')].find(x => (x.innerText||'').trim().startsWith(${JSON.stringify(label)}));
    if (!b) return 'button not found: ' + [...d.querySelectorAll('button')].map(x => (x.innerText||'').trim().slice(0,22)).join(' / ');
    b.click();
    return 'clicked';
  })()`);
}

async function sidebarText(): Promise<string> {
  const out = await inPicker(`(() => {
    const d = document.querySelector('iframe').contentDocument;
    return d && d.body ? (d.body.innerText||'').replace(/\\s+/g,' ').trim().slice(0,260) : '';
  })()`);
  return out === "no live picker" ? "" : out;
}

/**
 * Leave exactly ONE deck tab, freshly reloaded.
 *
 * Every earlier run left a deck tab behind, each with its own sidebar, and a stale sidebar
 * still has buttons and still renders its old state -- so clicking it looks like it worked and
 * changes nothing. Collapsing to one tab is what makes "the picker" unambiguous.
 */
async function soleDeckTab(): Promise<{ id: string; type: string; url: string } | undefined> {
  const decks = (await targets()).filter((x) => x.type === "page" && x.url.includes(DECK));
  for (const extra of decks.slice(1)) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/close/${extra.id}`);
    } catch {
      // a tab that is already gone is the outcome we wanted
    }
  }
  if (decks.length > 1) console.log(`      closed ${decks.length - 1} duplicate deck tab(s)`);
  return (await targets()).find((x) => x.type === "page" && x.url.includes(DECK));
}

async function main(): Promise<void> {
  const before = await readDeck();
  console.log(`before: ${before.length} slide(s) -> ${before.map((p) => p.id).join(", ")}`);

  const deck = await soleDeckTab();
  if (deck === undefined) { console.error(`FAIL  no tab for deck ${DECK}`); process.exitCode = 1; return; }
  const c: CdpClient = await CDP({ port: PORT, target: deck.id });
  await c.Runtime.enable();
  await c.Page.enable();
  await bringToFront(c, deck.id);
  // Reload so no sidebar from a previous run survives to be clicked by mistake.
  await c.Page.reload({ ignoreCache: true });
  await new Promise((r) => setTimeout(r, 4000));

  const button = await pollPoint(c, MENU_BUTTON, 20000);
  if (button === null) { console.error("FAIL  add-on menu missing"); await c.close(); process.exitCode = 1; return; }
  let item: Point | null = null;
  for (let attempt = 0; attempt < 3 && item === null; attempt++) {
    await realClick(c, button);
    item = await pollPoint(c, MENU_ITEM, 4000);
    if (item === null) await new Promise((r) => setTimeout(r, 700));
  }
  if (item === null) { console.error("FAIL  'Open the picker' missing"); await c.close(); process.exitCode = 1; return; }
  await realClick(c, item);
  console.log("ok    picker opened");

  // Wait for the picker to actually render before clicking anything in it.
  const renderDeadline = Date.now() + 60000;
  while (Date.now() < renderDeadline) {
    const text = await sidebarText();
    if (text.includes("candidate slide")) break;
    await new Promise((r) => setTimeout(r, 1200));
  }
  const gated = (await sidebarText()).includes("not an editable presentation");
  console.log(gated ? "FAIL  picker still reports the deck is not editable" : "ok    picker sees an editable presentation");
  if (gated) { await c.close(); process.exitCode = 1; return; }

  if (CHOICE !== 1) {
    const chip = await clickInSidebar(String(CHOICE));
    console.log(`      select candidate ${CHOICE}: ${chip}`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  // The picker refuses to insert a candidate whose HTML has not arrived ("option N's HTML has
  // not loaded yet"), which is correct behaviour -- the HTML is the authoritative source for
  // the conversion. Wait for the pane instead of racing it.
  const htmlDeadline = Date.now() + 60000;
  let paneReady = false;
  while (Date.now() < htmlDeadline && !paneReady) {
    const got = await inPicker(`(() => {
      const d = document.querySelector('iframe').contentDocument;
      const pane = [...d.querySelectorAll('iframe')].map(f => f.getAttribute('title') || '').filter(Boolean);
      return JSON.stringify(pane);
    })()`);
    paneReady = got.includes("candidate");
    if (!paneReady) await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(paneReady ? "ok    candidate HTML pane loaded" : "warn  HTML pane never reported a title; inserting anyway");

  const clicked = await clickInSidebar(`Insert option`);
  console.log(`ok    pressed Insert: ${clicked}`);

  // Poll Google, not the add-on's own claim.
  let after: readonly PageInfo[] = before;
  const insertDeadline = Date.now() + 90000;
  while (Date.now() < insertDeadline) {
    after = await readDeck();
    if (after.length > before.length) break;
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log(`      sidebar says: ${(await sidebarText()).slice(0, 120)}`);
  await c.close();

  if (after.length <= before.length) {
    console.error(`FAIL  no new slide appeared (still ${after.length})`);
    process.exitCode = 1;
    return;
  }
  const seen = new Set(before.map((p) => p.id));
  const added = after.filter((p) => !seen.has(p.id));
  console.log(`ok    ${added.length} new slide(s) in the deck`);
  for (const page of added) {
    const native = page.kinds.filter((k) => k !== "IMAGE" && k !== "other");
    console.log(`      ${page.id}: ${page.kinds.length} element(s) -> ${page.kinds.join(", ")}`);
    if (page.kinds.length === 0) { console.error("FAIL  the new slide is empty"); process.exitCode = 1; }
    else if (native.length !== page.kinds.length) { console.error("FAIL  the slide contains flattened images, not native elements"); process.exitCode = 1; }
    else console.log(`ok    all ${native.length} element(s) are NATIVE and editable`);
  }
  console.log(`\ndeck: https://docs.google.com/presentation/d/${DECK}/edit`);
}
void main();
