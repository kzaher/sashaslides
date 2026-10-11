#!/usr/bin/env npx tsx
/**
 * Verify the picker inside the REAL Apps Script add-on, not a local host with a shim.
 *
 * Opens the deck, drives SashaSlides -> "Open the picker" from the add-on menu, and reads
 * the rendered picker out of HtmlService's sandbox.
 *
 * Two traps this encodes:
 *  - The add-on menu is a Closure `menu-button` DIV inside `#docs-menubar`, NOT a
 *    `[role=menuitem]`, and the string "SashaSlides" also appears as the sidebar's own
 *    title, so the search is scoped to the menubar or it clicks the wrong element.
 *  - HtmlService nests the page one iframe deeper than `userCodeAppPanel`; the outer frame
 *    is a ~900 byte shell and the bundle lives in `iframe.contentDocument`.
 */
import CDPraw from "chrome-remote-interface";
import type { CdpClient, CdpModule } from "../../../types/cdp-types.ts";
import { evaluateText, realClick, bringToFront } from "./cdp-page.ts";
import { writeFileSync } from "node:fs";

// chrome-remote-interface ships no .d.ts; CdpModule is the repo's shared boundary type.
const CDP = CDPraw as CdpModule;

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const DECK = option("--deck") ?? "1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U";
const PORT = Number(option("--port") ?? 9223);
const SHOT = option("--out") ?? "/tmp/claude-1000/-workspaces-sashaslides/d3311559-3f2a-424e-b301-c486b6eb8ec6/scratchpad/addon-picker.png";
/**
 * The add-on menu holds exactly ONE item, and the UI redesign renamed it: "Open the picker"
 * became "Ask Sasha", because there is no longer a separate picker surface to open - the
 * conversation IS the entry point. Kept as an option so a rename is a flag, not an edit.
 */
const ITEM = option("--item") ?? "Ask Sasha";

type Point = Readonly<{ x: number; y: number }>;
type Rendered = Readonly<{ text: string; chips: readonly string[]; bytes: number }>;

const targets = async (): Promise<readonly { id: string; type: string; url: string }[]> =>
  (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as readonly { id: string; type: string; url: string }[];



/** The add-on menu button, scoped to the menubar so the sidebar title can't match. */
const MENU_BUTTON = `(() => {
  const bar = document.querySelector('#docs-menubar');
  if (!bar) return 'null';
  const hits = [...bar.querySelectorAll('*')].filter(n => (n.innerText||'').trim() === 'SashaSlides' && n.getBoundingClientRect().width > 4);
  if (hits.length === 0) return 'null';
  const r = hits[hits.length-1].getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) });
})()`;

const MENU_ITEM: string = `(() => {
  const vis = [...document.querySelectorAll('.goog-menu')].filter(m => getComputedStyle(m).display !== 'none');
  const n = vis.flatMap(m => [...m.querySelectorAll('[role=menuitem]')]).find(x => (x.innerText||'').trim().startsWith(${JSON.stringify(ITEM)}));
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

/**
 * Read the picker out of the HtmlService sandbox (one iframe below `userCodeAppPanel`).
 *
 * Re-opening the sidebar leaves STALE `userCodeAppPanel` targets in the target list whose
 * inner document is empty or belongs to a previous instance. Taking the first match can
 * therefore report on a corpse -- it once reported the byte count of a build two deploys old,
 * which would have hidden a failed deploy. So the live panel is found by CONTENT.
 */
async function readSandbox(): Promise<Rendered | null> {
  const panels = (await targets()).filter((x) => x.url.includes("userCodeAppPanel"));
  for (const panel of panels) {
    let pc: CdpClient;
    try {
      pc = await CDP({ port: PORT, target: panel.id });
    } catch {
      continue;
    }
    await pc.Runtime.enable();
    const raw = await evaluateText(pc, `(() => {
      const f = document.querySelector('iframe');
      try {
        const d = f && f.contentDocument;
        if (!d || !d.body || !d.body.querySelector('button')) return 'null';
        const chips = [...d.querySelectorAll('button,[role=tab],[role=button],li')].map(n => (n.innerText||'').trim()).filter(Boolean);
        return JSON.stringify({
          text: (d.body.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 300),
          chips: chips.slice(0, 14),
          bytes: d.documentElement.outerHTML.length
        });
      } catch { return 'null'; }
    })()`);
    await pc.close();
    if (raw.startsWith("{")) return JSON.parse(raw) as Rendered;
  }
  return null;
}

async function main(): Promise<void> {
  const deck = (await targets()).find((x) => x.type === "page" && x.url.includes(DECK));
  if (deck === undefined) { console.error(`no tab for deck ${DECK}`); process.exitCode = 1; return; }
  const c: CdpClient = await CDP({ port: PORT, target: deck.id });
  await c.Runtime.enable();
  await c.Page.enable();
  await bringToFront(c, deck.id);
  await new Promise((r) => setTimeout(r, 1200));

  const button = await pollPoint(c, MENU_BUTTON, 20000);
  if (button === null) { console.error("FAIL  the SashaSlides add-on menu is not in the menubar"); await c.close(); process.exitCode = 1; return; }
  console.log("ok    add-on menu present in the Slides menubar");
  // The menu button toggles, so a stale-open menu closes on the first press. Retry.
  let item: Point | null = null;
  for (let attempt = 0; attempt < 3 && item === null; attempt++) {
    await realClick(c, button);
    item = await pollPoint(c, MENU_ITEM, 4000);
    if (item === null) await new Promise((r) => setTimeout(r, 700));
  }
  if (item === null) { console.error(`FAIL  '${ITEM}' did not appear in the menu`); await c.close(); process.exitCode = 1; return; }
  await realClick(c, item);
  console.log(`ok    pressed '${ITEM}'`);

  // Wait for the PROPOSAL, not merely for any text. The picker renders its idle panel first
  // and only offers candidates after the observer's first poll returns, so breaking on the
  // first non-empty body reports the idle frame as the result -- which once made a working
  // picker look broken.
  let rendered: Rendered | null = null;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const seen = await readSandbox();
    if (seen !== null) {
      rendered = seen;
      if (/candidate slide/i.test(seen.text)) break;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (rendered !== null && !/candidate slide/i.test(rendered.text)) {
    console.log("note  no proposal was offered within 60s; the panel is still idle");
  }

  if (rendered === null) {
    console.error("FAIL  the sidebar sandbox never appeared");
    process.exitCode = 1;
  } else {
    console.log(`ok    HtmlService served ${rendered.bytes} bytes into the sandbox`);
    console.log(`      text:  ${rendered.text.slice(0, 180)}`);
    console.log(`      chips: ${JSON.stringify(rendered.chips)}`);
    if (rendered.text.length === 0) { console.error("FAIL  picker rendered nothing"); process.exitCode = 1; }
  }

  const shot = await c.Page.captureScreenshot({ format: "png" });
  writeFileSync(SHOT, Buffer.from(shot.data, "base64"));
  console.log(`      screenshot: ${SHOT}`);
  await c.close();
}
void main();
