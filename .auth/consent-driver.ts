#!/usr/bin/env npx tsx
/**
 * Drive a Google OAuth consent screen to completion in the headful, already-signed-in
 * Chrome on CDP :9223 (the one behind the VNC session).
 *
 *   npx tsx .auth/generate-token.ts --with-apps-script > /tmp/token.log 2>&1 &
 *   npx tsx .auth/consent-driver.ts --url-file /tmp/sasha-vnc/auth-url.txt
 *
 * Exists because the consent screen is several pages and none of them can be skipped:
 * account chooser -> unverified-app warning -> per-scope checkboxes -> Continue.
 *
 * Two hard-won details, both of which look like Google bugs and are not:
 *
 *  1. `CDP.New({ url })` does NOT url-encode, so it passes the URL straight into
 *     /json/new?url=... and everything after the first `&` is discarded. An auth URL
 *     then arrives carrying only its first parameter and Google replies "Required
 *     parameter is missing: response_type". Always open a blank tab and Page.navigate.
 *
 *  2. Google's account chooser and consent buttons ignore a synthetic
 *     `element.click()`. They need a real browser-level click, so every press here goes
 *     through Input.dispatchMouseEvent at the element's centre.
 *
 * The scope checkboxes must be ticked before Continue appears usable, and Continue is
 * below the fold on a 1600x1000 display, hence the explicit scroll.
 */
import CDPraw from "chrome-remote-interface";
import type { CdpClient, CdpModule } from "../types/cdp-types.ts";
import { readFileSync } from "node:fs";

// chrome-remote-interface ships no .d.ts and types/ambient.d.ts declares its default
// export `unknown`. CdpModule is the repo's shared boundary type for the callable
// connect-fn plus the runtime-attached New / Close / List statics — same narrowing as
// renderer/html2slides/convert-pptx-io.ts:62.
const CDP = CDPraw as CdpModule;

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

const PORT = Number(option("--port") ?? 9223);
const STEP_MS = 2000;
const MAX_STEPS = 14;

type Hit = Readonly<{ x: number; y: number; label: string }>;

function readUrl(): string {
  const direct = option("--url");
  if (direct !== undefined && direct.length > 0) return direct;
  const file = option("--url-file") ?? "/tmp/sasha-vnc/auth-url.txt";
  const text = readFileSync(file, "utf-8").trim();
  if (text.length === 0) throw new Error(`${file} is empty — did generate-token print a URL yet?`);
  return text;
}

async function realClick(client: CdpClient, hit: Hit): Promise<void> {
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: hit.x, y: hit.y });
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: hit.x, y: hit.y, button: "left", clickCount: 1 });
}

async function evaluateJson<T>(client: CdpClient, expression: string): Promise<T | null> {
  const { result } = await client.Runtime.evaluate({ expression, returnByValue: true });
  const raw = result.value;
  return typeof raw === "string" ? (JSON.parse(raw) as T) : null;
}

/** Centre of the first visible element whose text matches one of the patterns, in order. */
const findHit = (patterns: readonly string[]): string => `((pats) => {
  const nodes = document.querySelectorAll('li,button,[role=button],[role=link],a,input[type=submit],div[data-identifier]');
  for (const p of pats) {
    const re = new RegExp(p, 'i');
    for (const n of nodes) {
      const s = (n.innerText || n.value || n.getAttribute('aria-label') || '').trim();
      if (!s || s.length > 140 || !re.test(s)) continue;
      const r = n.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > innerHeight) continue;
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: s.replace(/\\s+/g, ' | ').slice(0, 60) });
    }
  }
  return null;
})(${JSON.stringify(patterns)})`;

const PAGE_STATE = `JSON.stringify({ url: location.href, text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 140) })`;

async function tickEveryScope(client: CdpClient): Promise<number> {
  const boxes = await evaluateJson<readonly Hit[]>(
    client,
    `JSON.stringify([...document.querySelectorAll('input[type=checkbox]')]
      .map(e => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), label: e.checked ? 'checked' : 'unchecked' }; })
      .filter(h => h.y > 0))`,
  );
  const first = boxes?.[0];
  if (first === undefined) return 0;
  // The first checkbox is "Select all"; ticking it ticks the per-scope ones.
  await realClick(client, first);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const checked = await evaluateJson<number>(
    client,
    `JSON.stringify([...document.querySelectorAll('input[type=checkbox]')].filter(e => e.checked).length)`,
  );
  return checked ?? 0;
}

async function main(): Promise<void> {
  const url = readUrl();
  const tab = await CDP.New({ port: PORT });
  const client = await CDP({ port: PORT, target: tab.id });
  await client.Page.enable();
  await client.Runtime.enable();
  await client.Page.navigate({ url });

  let done = false;
  for (let step = 0; step < MAX_STEPS && !done; step++) {
    await new Promise((resolve) => setTimeout(resolve, STEP_MS));
    const state = await evaluateJson<{ url: string; text: string }>(client, PAGE_STATE);
    if (state === null) continue;

    if (/localhost:\d+/.test(state.url) || /Auth successful/i.test(state.text)) {
      console.log(`[${step}] redirect captured — tokens written`);
      done = true;
      break;
    }
    if (/signin\/oauth\/error/.test(state.url)) {
      console.error(`[${step}] consent error: ${state.text.slice(0, 160)}`);
      process.exitCode = 1;
      return;
    }

    if (/Select what|wants additional access|wants access/i.test(state.text)) {
      const checked = await tickEveryScope(client);
      if (checked > 0) console.log(`[${step}] ticked ${checked} scope checkbox(es)`);
      // Continue sits below the fold on a 1600x1000 display.
      await client.Runtime.evaluate({ expression: `window.scrollTo(0, document.documentElement.scrollHeight)` });
      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    const hit = await evaluateJson<Hit>(client, findHit(["^(continue|allow|accept)$", "@", "^(advanced|go to|next)"]));
    if (hit === null) {
      console.log(`[${step}] nothing to press | ${state.text.slice(0, 90)}`);
      continue;
    }
    await realClick(client, hit);
    console.log(`[${step}] pressed ${hit.label}`);
  }

  await client.close();
  if (!done) {
    console.error("consent did not complete within the step budget");
    process.exitCode = 1;
  }
}

void main();
