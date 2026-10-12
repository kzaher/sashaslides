#!/usr/bin/env npx tsx
/**
 * Measure how long "Open slide N" takes in the DEPLOYED add-on, and where the time goes.
 *
 * It presses the sidebar's "Open slide N" (or "See the slides") button and records, from the
 * press, every network request in every frame -- the deck page and the out-of-process
 * HtmlService iframes it auto-attaches to -- plus the dialog's visible text each time it changes.
 * `google.script.run` calls are named by the function in their POST body, so the output is the
 * real round-trip chain, not a guess about it.
 *
 *   npx tsx mcp/sasha-slides/e2e/open-latency.ts [--button "Open"] [--budget 25000]
 *   npx tsx mcp/sasha-slides/e2e/open-latency.ts --observe 20000   # record traffic only, press nothing
 *
 * Needs the sidebar already open in the deck tab on Chrome :9223.
 */
import CDPraw from "chrome-remote-interface";

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const PORT = Number(option("--port") ?? 9223);
const DECK = option("--deck") ?? "1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U";
const BUTTON = option("--button") ?? "Open slide";
/** Only press in the frame whose text contains this -- stale dialog frames hold similar controls. */
const SURFACE = option("--surface") ?? "Ask Sasha";
const BUDGET_MS = Number(option("--budget") ?? 25_000);
/** Press nothing; just record every frame's traffic for this long (e.g. to catch stale frames polling). */
const OBSERVE_MS = Number(option("--observe") ?? 0);
/** After the dialog is drawn, press this control in it (e.g. "Converted") and time until every candidate is rendered. */
const THEN = option("--then");
/** Open the SIDEBAR from the add-on menu instead of pressing a button, and watch it settle. */
const OPEN_SIDEBAR = argv.includes("--open-sidebar");
/** How long to stay on the first view before pressing `THEN` -- a user looking at the preview first. */
const THEN_DELAY_MS = Number(option("--then-delay") ?? 0);
/** The dialog is done when its text matches this (a rendered candidate grid or editor). */
const DONE = new RegExp(option("--done") ?? "Insert", "i");
/** ...and no longer matches this (a candidate still loading). */
const PENDING = new RegExp(option("--pending") ?? "loading|converting", "i");

type Json = Record<string, unknown>;
type Session = Readonly<{
  send: (method: string, params?: Json, sessionId?: string) => Promise<Json>;
  on: (event: string, listener: (params: Json, sessionId?: string) => void) => void;
  close: () => Promise<void>;
}>;
const CDP = CDPraw as unknown as (options: Json) => Promise<Session>;

type Target = Readonly<{ id: string; type: string; url: string }>;

const started = Date.now();
const since = (): string => `${String(Date.now() - started).padStart(6)}ms`;

/** Find the newest sidebar frame holding the button, and click it. Same rules as sasha-ui.ts. */
const CLICK = `(() => {
  const f = document.querySelector('iframe');
  const d = f && f.contentDocument && f.contentDocument.body ? f.contentDocument : document;
  const want = ${JSON.stringify(BUTTON)}.toLowerCase();
  if (!(d.body && d.body.innerText.includes(${JSON.stringify(SURFACE)}))) return 'NOTFOUND';
  const live = [...d.querySelectorAll('button,[role=button],a')].filter(n => n.getBoundingClientRect().width > 2 && !n.disabled);
  const hit = live.find(n => (n.innerText||'').trim().toLowerCase() === want)
    || live.find(n => (n.getAttribute('aria-label')||'').toLowerCase().startsWith(want));
  if (!hit) return 'NOTFOUND';
  hit.click();
  return 'CLICKED ' + ((hit.innerText||hit.getAttribute('aria-label')||'').trim().slice(0,40));
})()`;

/**
 * Open the sidebar the way a user does -- SashaSlides menu, "Ask Sasha" -- and log every change in
 * what it shows (text summary + document height), so both the time to a settled panel and the
 * number of visible jumps on the way are measured. Settled = unchanged for 3 s.
 */
async function watchSidebarOpen({ page, panels, lines }: { page: Session; panels: readonly Target[]; lines: string[] }): Promise<void> {
  const jsClick = (finder: string): string => `(() => { const el = (${finder})(); if (!el) return 'NOTFOUND'; const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerType: 'mouse', button: 0, pointerId: 1 }; for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o)); return 'OK'; })()`;
  const evaluate = async (expression: string): Promise<string> => {
    const { result } = (await page.send("Runtime.evaluate", { expression, returnByValue: true })) as { result: { value?: unknown } };
    return String(result.value);
  };
  // Slides ignores input while the tab is unfocused (CLAUDE.md), and its menubar wants JS pointer events.
  await page.send("Page.bringToFront", {});
  lines.push(`${since()}  menu ${await evaluate(jsClick(`() => [...document.querySelectorAll('#docs-menubar *')].filter(n => (n.innerText || '').trim() === 'SashaSlides' && n.getBoundingClientRect().width > 4).pop()`))}`);
  const itemFinder = `() => [...document.querySelectorAll('.goog-menu [role=menuitem]')].find(x => x.getBoundingClientRect().width > 4 && (x.innerText || '').trim().startsWith('Ask Sasha'))`;
  let item = "NOTFOUND";
  for (let tries = 0; tries < 20 && item !== "OK"; tries++) {
    item = await evaluate(jsClick(itemFinder));
    if (item !== "OK") await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const openedAt = Date.now();
  lines.push(`${since()}  pressed Ask Sasha: ${item}`);
  let last = "";
  let lastChangeAt = Date.now();
  let changes = 0;
  while (Date.now() - openedAt < BUDGET_MS) {
    const now = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as readonly Target[];
    const fresh = now.filter((t) => t.url.includes("userCodeAppPanel") && !panels.some((p) => p.id === t.id));
    for (const target of fresh) {
      const client = await CDP({ port: PORT, target: target.id }).catch(() => null);
      if (client === null) continue;
      const { result } = (await client
        .send("Runtime.evaluate", {
          returnByValue: true,
          expression: `(() => { const f = document.querySelector('iframe'); const d = f && f.contentDocument && f.contentDocument.body ? f.contentDocument : null; if (!d || !d.body.innerText.includes('Ask Sasha')) return ''; const t = d.body.innerText.replace(/\s+/g, ' '); const parts = []; for (const re of [/\d+ CANDIDATES/, /Nothing has picked this up/, /No open comments/, /Not done \d+/, /Opening Ask Sasha/, /loading/i]) { const m = t.match(re); if (m) parts.push(m[0]); } return parts.join(' | ') + ' | thumbs=' + d.querySelectorAll('iframe').length + ' waiting=' + d.querySelectorAll('.sasha-thumb-wait').length + ' spin=' + (d.querySelector('.sasha-header-spin') ? 1 : 0) + ' h=' + d.documentElement.scrollHeight; })()`,
        })
        .catch(() => ({ result: { value: "" } }))) as { result: { value?: unknown } };
      await client.close();
      const text = String(result.value ?? "");
      if (text !== "" && text !== last) {
        changes += 1;
        lines.push(`${since()}  sidebar: ${text}`);
        last = text;
        lastChangeAt = Date.now();
      }
    }
    if (last !== "" && Date.now() - lastChangeAt > 3_000) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  lines.push(`${since()}  SIDEBAR ${last === "" ? "NEVER RENDERED" : `SETTLED ${lastChangeAt - openedAt}ms after pressing, ${changes} visible changes`}`);
}

/**
 * Press `THEN` in the dialog and wait until every candidate shows Google's rendered picture
 * (`img.sasha-render`), logging each change in how many are rendered.
 */
async function thenRender({ target, lines }: { target: Target; lines: string[] }): Promise<void> {
  const client = await CDP({ port: PORT, target: target.id });
  const inner = `(() => { const f = document.querySelector('iframe'); return f && f.contentDocument && f.contentDocument.body ? f.contentDocument : document; })()`;
  const evaluate = async (expression: string): Promise<string> => {
    const { result } = (await client.send("Runtime.evaluate", { expression, returnByValue: true })) as { result: { value?: unknown } };
    return String(result.value);
  };
  await new Promise((resolve) => setTimeout(resolve, THEN_DELAY_MS));
  const pressedAt = Date.now();
  lines.push(`${since()}  ${await evaluate(`(() => { const d = ${inner}; const hit = [...d.querySelectorAll('button')].find(n => (n.innerText||'').trim() === ${JSON.stringify(THEN)}); if (!hit) return 'NOTFOUND ${THEN}'; hit.click(); return 'CLICKED ${THEN}'; })()`)}`);
  let last = "";
  while (Date.now() - pressedAt < BUDGET_MS) {
    const state = await evaluate(`(() => { const d = ${inner}; const stages = d.querySelectorAll('.sasha-grid [role=listitem], .sasha-grid > *').length; return d.querySelectorAll('img.sasha-render').length + '/' + stages + ' rendered, ' + d.querySelectorAll('.sasha-placeholder').length + ' waiting'; })()`);
    if (state !== last) {
      lines.push(`${since()}  converted view: ${state}`);
      last = state;
    }
    const [rendered, total] = state.split(" ")[0]?.split("/").map(Number) ?? [0, 1];
    if (rendered !== undefined && total !== undefined && total > 0 && rendered >= total) {
      lines.push(`${since()}  CONVERTED DONE: ${Date.now() - pressedAt}ms from pressing ${THEN}`);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await client.close();
}

/** A request body, URL-decoded when it can be; the function names are plain ASCII either way. */
function safeDecode(body: string): string {
  try {
    return decodeURIComponent(body.replace(/\+/g, " "));
  } catch {
    return body;
  }
}

async function main(): Promise<void> {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as readonly Target[];
  const deck = list.find((t) => t.type === "page" && t.url.includes(DECK));
  if (deck === undefined) throw new Error(`no tab for deck ${DECK}`);
  const panels = list.filter((t) => t.url.includes("userCodeAppPanel"));

  // 1. The deck page, auto-attaching to every OOPIF so the dialog's frames are traced from birth.
  const page = await CDP({ port: PORT, target: deck.id });
  const requests = new Map<string, { at: number; url: string; what: string; sentBytes: number; frame: string }>();
  const lines: string[] = [];
  /** Every frame attached during the run, by session, so its script time can be read at the end. */
  const sessions = new Map<string, string>();
  const onSession = async (sessionId?: string): Promise<void> => {
    await page.send("Network.enable", {}, sessionId);
    await page.send("Runtime.enable", {}, sessionId);
    await page.send("Performance.enable", {}, sessionId);
    await page.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    await page.send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  };
  page.on("Target.attachedToTarget", (params) => {
    const sessionId = String(params.sessionId);
    const info = params.targetInfo as Json;
    sessions.set(sessionId, String(info.url));
    lines.push(`${since()}  attach ${String(info.type)} ${String(info.url).slice(0, 90)}`);
    void onSession(sessionId).catch(() => undefined);
  });
  page.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails as Json;
    const exception = details.exception as Json | undefined;
    lines.push(`${since()}  EXCEPTION ${String(exception?.description ?? details.text).split("\n")[0]?.slice(0, 160)}`);
  });
  page.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error" && params.type !== "warning") return;
    const args = (params.args as Json[]).map((arg) => String(arg.value ?? arg.description ?? "")).join(" ");
    lines.push(`${since()}  console.${String(params.type)} ${args.slice(0, 160)}`);
  });
  page.on("Network.requestWillBeSent", (params, sessionId) => {
    const request = params.request as Json;
    const url = String(request.url);
    if (url.startsWith("data:")) return;
    const body = typeof request.postData === "string" ? request.postData : "";
    const fn = [...new Set(safeDecode(body).match(/sasha[A-Za-z_]+/g) ?? [])].join(",");
    if (url.includes("/jserror") && argv.includes("--jserrors")) {
      const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
      lines.push(`${since()}  JSERROR ${safeDecode(query).slice(0, 400)} | ${safeDecode(body).slice(0, 600)}`);
    }
    requests.set(`${sessionId ?? "page"}:${String(params.requestId)}`, { at: Date.now(), url, what: fn, sentBytes: body.length, frame: sessionId ?? "page" });
  });
  page.on("Network.loadingFinished", (params, sessionId) => {
    const key = `${sessionId ?? "page"}:${String(params.requestId)}`;
    const sent = requests.get(key);
    if (sent === undefined) return;
    const bytes = Number(params.encodedDataLength);
    if (sent.what.startsWith("sasha")) {
      // Apps Script reports its own execution time as `["di",<ms>]` in every reply.
      void page
        .send("Network.getResponseBody", { requestId: params.requestId }, sessionId)
        .then((reply) => {
          const di = /"di",(\d+)/.exec(String(reply.body))?.[1];
          if (di !== undefined) lines.push(`${String(sent.at - started).padStart(6)}ms  server ${di}ms  ${sent.what}`);
        })
        .catch(() => undefined);
    }
    const short = sent.url.replace(/^https:\/\//, "").replace(/\?.*$/, "").slice(0, 80);
    lines.push(
      `${String(sent.at - started).padStart(6)}ms +${String(Date.now() - sent.at).padStart(5)}ms ${String(bytes).padStart(8)}B  ${sent.what || short} @${sent.frame.slice(0, 8)}${sent.sentBytes > 2048 ? ` (sent ${sent.sentBytes}B)` : ""}`,
    );
  });
  await onSession(undefined);

  if (OBSERVE_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, OBSERVE_MS));
    await page.close();
    const calls = lines.filter((line) => / sasha[A-Z]/.test(line));
    for (const line of calls) console.log(line);
    console.log(`OBSERVED ${OBSERVE_MS}ms: ${calls.length} Apps Script calls from ${new Set(calls.map((line) => line.split("@")[1])).size} frames`);
    return;
  }

  if (OPEN_SIDEBAR) {
    await watchSidebarOpen({ page, panels, lines });
    await page.close();
    lines.sort((a, b) => Number(a.trim().split("ms")[0]) - Number(b.trim().split("ms")[0]));
    for (const line of lines) console.log(line);
    return;
  }

  // 2. Press the button in the newest sidebar frame that has it.
  let pressed = "NOTFOUND";
  for (const panel of [...panels].reverse()) {
    const client = await CDP({ port: PORT, target: panel.id });
    const { result } = (await client.send("Runtime.evaluate", { expression: CLICK, returnByValue: true })) as {
      result: { value?: unknown };
    };
    await client.close();
    pressed = String(result.value);
    if (pressed.startsWith("CLICKED")) break;
  }
  const pressedAt = Date.now();
  lines.push(`${since()}  ${pressed}`);
  if (!pressed.startsWith("CLICKED")) throw new Error(`no '${BUTTON}' button in any sidebar frame`);

  // 3. Watch the dialog's text until DONE, logging only changes.
  let lastText = "";
  let doneAt: number | null = null;
  let doneTarget: Target | null = null;
  while (Date.now() - pressedAt < BUDGET_MS && doneAt === null) {
    const now = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as readonly Target[];
    const fresh = now.filter((t) => t.url.includes("userCodeAppPanel") && !panels.some((p) => p.id === t.id));
    for (const target of fresh) {
      const client = await CDP({ port: PORT, target: target.id }).catch(() => null);
      if (client === null) continue;
      const { result } = (await client
        .send("Runtime.evaluate", {
          expression: `(() => { const f = document.querySelector('iframe'); const d = f && f.contentDocument && f.contentDocument.body ? f.contentDocument : document; return (d.body ? d.body.innerText : '').replace(/\\s+/g,' ').trim().slice(0, 160); })()`,
          returnByValue: true,
        })
        .catch(() => ({ result: { value: "" } }))) as { result: { value?: unknown } };
      await client.close();
      const text = String(result.value ?? "");
      if (text !== lastText) {
        lines.push(`${since()}  dialog: ${text || "(empty)"}`);
        lastText = text;
      }
      if (DONE.test(text) && !PENDING.test(text)) {
        doneAt = Date.now();
        doneTarget = target;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (THEN !== undefined && doneTarget !== null) await thenRender({ target: doneTarget, lines });

  // Main-thread script time per HtmlService frame born during the run (Performance was enabled
  // while each target was still paused, so nothing it ran is missed).
  for (const [sessionId, url] of sessions) {
    if (!url.includes("googleusercontent.com") && !url.includes("macros")) continue;
    const reply = await page.send("Performance.getMetrics", {}, sessionId).catch(() => null);
    if (reply === null) continue;
    const metric = (name: string): number =>
      Number((reply.metrics as Json[]).find((entry) => entry.name === name)?.value ?? 0) * 1000;
    if (metric("TaskDuration") < 1) continue;
    console.log(
      `frame ${url.replace(/^https:\/\//, "").slice(0, 70)}: script ${Math.round(metric("ScriptDuration"))}ms, compile ${Math.round(metric("V8CompileDuration"))}ms, layout ${Math.round(metric("LayoutDuration"))}ms, tasks ${Math.round(metric("TaskDuration"))}ms`,
    );
  }
  await page.close();
  lines.sort((a, b) => Number(a.trim().split("ms")[0]) - Number(b.trim().split("ms")[0]));
  for (const line of lines) console.log(line);
  console.log(
    doneAt === null
      ? `NOT DONE: dialog never matched ${DONE} within ${BUDGET_MS}ms; last text: ${lastText || "(none)"}`
      : `DONE: ${doneAt - pressedAt}ms from press to ${DONE}`,
  );
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
