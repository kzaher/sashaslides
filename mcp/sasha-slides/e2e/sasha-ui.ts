#!/usr/bin/env npx tsx
/**
 * Drive the DEPLOYED add-on's own UI from the shell, one action per command.
 *
 * `addon-live.ts` proves the sidebar opens. This drives what is inside it: read the surface,
 * press a button by its visible label, type into a field, send. Every action is addressed by
 * what the user would see, never by a coordinate, because HtmlService nests the bundle two
 * iframes deep and the sandbox moves whenever Slides relayouts.
 *
 * WHY `.click()` IS ENOUGH HERE and `realClick` is not used: the repo rule about synthetic
 * clicks is about GOOGLE's Closure widgets. Everything inside the sandbox is this project's
 * own React, which handles a plain `click` event like any React app.
 *
 * Surfaces: the sidebar lives in `userCodeAppPanel`, the editor in a modeless dialog, and
 * both appear as separate CDP targets whose inner document holds the bundle. They are told
 * apart by CONTENT, never by order -- a re-opened sidebar leaves stale targets behind, and
 * reading one of those once reported a build two deploys old as the live state.
 *
 *   npx tsx e2e/sasha-ui.ts --read
 *   npx tsx e2e/sasha-ui.ts --click "See the slides"
 *   npx tsx e2e/sasha-ui.ts --type "textarea" --text "make the table borders even"
 *   npx tsx e2e/sasha-ui.ts --shot /path/out.png
 */
import CDPraw from "chrome-remote-interface";
import { writeFileSync } from "node:fs";
import type { CdpClient, CdpModule } from "../../../types/cdp-types.ts";
import { evaluateAsyncText, evaluateText } from "./cdp-page.ts";

const CDP = CDPraw as CdpModule;
const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const PORT = Number(option("--port") ?? 9223);
/** Which sandbox to act on: the sidebar, or the editor dialog. Matched on its visible text. */
const SURFACE = option("--surface") ?? "";

type Target = Readonly<{ id: string; type: string; url: string }>;

const targets = async (): Promise<readonly Target[]> =>
  (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as readonly Target[];

/**
 * Run an expression against the bundle's own document, wherever it is.
 *
 * The sandbox is `iframe.contentDocument` of a `userCodeAppPanel` target, EXCEPT when the
 * bundle is served straight into the target (the dialog does that) -- so both are tried and
 * the one that actually holds a rendered body wins.
 */
const INNER = `(() => {
  const frame = document.querySelector('iframe');
  const inner = frame && frame.contentDocument;
  const doc = inner && inner.body && inner.body.children.length > 0 ? inner : document;
  return doc;
})()`;

async function panels(): Promise<readonly Target[]> {
  return (await targets()).filter((t) => t.url.includes("userCodeAppPanel") || t.url.includes("script.googleusercontent.com"));
}

type Surface = Readonly<{ client: CdpClient; target: Target; text: string }>;

/** Every live sandbox, newest-looking first, each with the text it is currently showing. */
async function liveSurfaces(): Promise<readonly Surface[]> {
  const found: Surface[] = [];
  for (const target of await panels()) {
    let client: CdpClient;
    try {
      client = await CDP({ port: PORT, target: target.id });
    } catch {
      continue;
    }
    await client.Runtime.enable();
    const text = await evaluateText(client, `(() => { const d = ${INNER}; return d && d.body ? (d.body.innerText||'').replace(/\\s+/g,' ').trim() : ''; })()`);
    if (text.length > 0 && !text.startsWith("THREW") && text !== "CLOSED") {
      found.push({ client, target, text });
    } else {
      await client.close();
    }
  }
  return found;
}

/**
 * The surface being asked for, with a short retry.
 *
 * HtmlService re-creates the sandbox target whenever the host re-renders the panel, so a target
 * enumerated a moment ago can be gone before it is connected to -- and a dialog that has just
 * been asked for has not rendered its body yet. A few hundred milliseconds covers both; a
 * longer budget would just hide a genuinely missing surface.
 */
async function pick(): Promise<Surface | null> {
  const deadline = Date.now() + 4_000;
  for (;;) {
    const all = await liveSurfaces();
    // THE LAST MATCH, NEVER THE FIRST. Re-opening a sidebar or dialog leaves STALE
    // `userCodeAppPanel` targets behind that still hold buttons and still answer clicks, so
    // driving the first match presses a corpse and nothing on screen changes. The newest target
    // is the live one -- this cost an hour of "the click worked but the editor never opened".
    const matches = SURFACE === "" ? all : all.filter((s) => s.text.toLowerCase().includes(SURFACE.toLowerCase()));
    const wanted = matches[matches.length - 1];
    for (const surface of all) if (surface !== wanted) await surface.client.close();
    if (wanted !== undefined) return wanted;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/** Click the first control whose visible label contains `label`. Reports what it pressed. */
const clickExpression = (label: string): string => `(() => {
  const d = ${INNER};
  const want = ${JSON.stringify(label)}.toLowerCase();
  const nodes = [...d.querySelectorAll('button,[role=button],a,summary,label')];
  const hit = nodes.find(n => (n.innerText||n.textContent||'').trim().toLowerCase().includes(want)
                            && n.getBoundingClientRect().width > 2 && !n.disabled);
  if (!hit) return 'NOTFOUND ' + nodes.map(n => (n.innerText||'').trim().replace(/\\s+/g,' ')).filter(Boolean).slice(0,20).join(' | ');
  hit.scrollIntoView({ block: 'center' });
  hit.click();
  return 'CLICKED ' + (hit.innerText||'').trim().replace(/\\s+/g,' ').slice(0,60);
})()`;

/**
 * Type into a field the way a user does.
 *
 * React tracks the input's value on the DOM node, so assigning `.value` and firing `input`
 * is ignored -- the native setter has to be called so React's own descriptor sees the write.
 */
const typeExpression = (selector: string, text: string): string => `(() => {
  const d = ${INNER};
  const field = d.querySelector(${JSON.stringify(selector)});
  if (!field) return 'NOTFOUND ' + [...d.querySelectorAll('textarea,input')].map(n => n.tagName + '.' + n.className).join(' | ');
  const proto = field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  field.focus();
  setter.call(field, ${JSON.stringify(text)});
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new Event('change', { bubbles: true }));
  return 'TYPED ' + field.value.slice(0, 60);
})()`;


/**
 * Drag a box over one candidate's annotation overlay.
 *
 * SYNTHETIC pointer events, not `Input.dispatchMouseEvent`: the overlay is this project's own
 * React, two iframes deep, so browser-level coordinates would have to be translated through
 * both frames, while `region-overlay.tsx` is written to survive a synthetic pointer on purpose
 * (`capture()` swallows the `NotFoundError` a synthetic pointerId raises). The box is given in
 * FRACTIONS of the pane, which is the coordinate convention the product stores anyway.
 */
const dragExpression = (
  options: Readonly<{ slideIndex: number; from: Readonly<{ x: number; y: number }>; to: Readonly<{ x: number; y: number }> }>,
): string => `(async () => {
  const d = ${INNER};
  const want = 'candidate ' + ${JSON.stringify(String(options.slideIndex))};
  const pane = [...d.querySelectorAll('.sasha-overlay')]
    .find(n => (n.getAttribute('aria-label')||'').includes(want));
  if (!pane) return 'NOTFOUND overlays: ' + [...d.querySelectorAll('.sasha-overlay')].map(n => n.getAttribute('aria-label')).join(' | ');
  if (pane.className.includes('off')) return 'DISABLED the overlay is not accepting marks (wrong tool?)';
  const view = d.defaultView;
  // A TIMER, not requestAnimationFrame. React needs a turn of the event loop between the
  // events (one synchronous task means the move handler still closes over the pre-drag
  // state and is dropped with no error anywhere), but rAF never fires in a background or
  // hidden frame -- it hung this script for the full 28 s command budget.
  const settle = () => new Promise(r => view.setTimeout(r, 60));
  const box = pane.getBoundingClientRect();
  const at = (f) => ({ clientX: box.left + box.width * f.x, clientY: box.top + box.height * f.y });
  const base = { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 };
  const from = at(${JSON.stringify(options.from)});
  const to = at(${JSON.stringify(options.to)});
  pane.dispatchEvent(new PointerEvent('pointerdown', { ...base, ...from }));
  await settle();
  pane.dispatchEvent(new PointerEvent('pointermove', { ...base, clientX: (from.clientX + to.clientX) / 2, clientY: (from.clientY + to.clientY) / 2 }));
  await settle();
  pane.dispatchEvent(new PointerEvent('pointermove', { ...base, ...to }));
  await settle();
  pane.dispatchEvent(new PointerEvent('pointerup', { ...base, ...to, buttons: 0 }));
  await settle();
  return 'DRAGGED on ' + pane.getAttribute('aria-label');
})()`;


/**
 * Fill the one mark-up that has no note yet and press ITS "Send to Sasha".
 *
 * Addressed by `:placeholder-shown` -- the only empty note on the surface is the mark just
 * drawn -- and the button is taken from that row (`li.sasha-anomaly`), never from the page:
 * there is one Send button per mark-up, and pressing the first one would post a DIFFERENT
 * mark-up's note, on a different slide.
 */
const sendNewMarkExpression = (note: string): string => `(() => {
  const d = ${INNER};
  const field = d.querySelector('input.sasha-note:placeholder-shown');
  if (!field) return 'NOTFOUND no un-noted mark-up (draw one first)';
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  field.focus();
  setter.call(field, ${JSON.stringify(note)});
  field.dispatchEvent(new Event('input', { bubbles: true }));
  const row = field.closest('li.sasha-anomaly');
  const send = row && row.querySelector('button.sasha-send-anomaly');
  if (!send) return 'NOTFOUND the row has no Send to Sasha button';
  // Its own row says which slide, which is the only proof the right mark-up was sent.
  const says = (row.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 90);
  if (send.disabled) return 'DISABLED send is still disabled for: ' + says;
  send.click();
  return 'SENT ' + says;
})()`;

async function main(): Promise<void> {
  const surface = await pick();
  if (surface === null) {
    console.error(`no live sandbox${SURFACE === "" ? "" : ` showing ${JSON.stringify(SURFACE)}`}`);
    process.exitCode = 1;
    return;
  }
  const { client } = surface;

  const dragOn = option("--drag");
  if (dragOn !== undefined) {
    const box = (option("--box") ?? "0.1,0.1,0.6,0.3").split(",").map(Number);
    const [x = 0.1, y = 0.1, w = 0.6, h = 0.3] = box;
    console.log(
      await evaluateAsyncText(
        client,
        dragExpression({ slideIndex: Number(dragOn), from: { x, y }, to: { x: x + w, y: y + h } }),
      ),
    );
  }

  const note = option("--send-new-mark");
  if (note !== undefined) console.log(await evaluateText(client, sendNewMarkExpression(note)));

  const label = option("--click");
  if (label !== undefined) console.log(await evaluateText(client, clickExpression(label)));

  const selector = option("--type");
  const text = option("--text");
  if (selector !== undefined && text !== undefined) console.log(await evaluateText(client, typeExpression(selector, text)));

  if (argv.includes("--read") || label !== undefined || selector !== undefined || dragOn !== undefined || note !== undefined) {
    // Re-read AFTER acting, so the printed state is the consequence, not the precondition.
    const after = await evaluateText(client, `(() => { const d = ${INNER}; return (d.body.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 1400); })()`);
    console.log(`--- ${surface.target.url.slice(0, 60)} ---`);
    console.log(after);
  }

  const shot = option("--shot");
  if (shot !== undefined) {
    // Captured from the DECK, not from this surface: both the sidebar and the dialog are
    // out-of-process iframes on a `script.googleusercontent.com` origin, and Chrome answers
    // `Page.captureScreenshot` on one with "Command can only be executed on top-level
    // targets". The page is also the honest picture anyway -- it is what the user sees.
    const page = (await targets()).find((t) => t.type === "page" && t.url.includes("/presentation/d/"));
    if (page === undefined) {
      console.error("no deck tab to screenshot");
      process.exitCode = 1;
    } else {
      const pageClient: CdpClient = await CDP({ port: PORT, target: page.id });
      await pageClient.Page.enable();
      const image = await pageClient.Page.captureScreenshot({ format: "png" });
      writeFileSync(shot, Buffer.from(image.data, "base64"));
      await pageClient.close();
      console.log(`screenshot: ${shot}`);
    }
  }
  await client.close();
}
void main();
