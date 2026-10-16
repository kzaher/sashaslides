/**
 * One Chrome tab (over the DevTools protocol) that screenshots a page at 1280 x 720 CSS pixels and
 * reads back the text it shows, for both sides of the round trip: the Sasha export and the
 * original fixture.
 *
 * Measured rules this follows (CLAUDE.md, "Google Slides / Chrome DevTools Protocol"):
 *   * `Page.loadEventFired()` is subscribed BEFORE `Page.navigate`, or the promise never resolves;
 *   * a blank tab is opened and then navigated (`CDP.New({ url })` truncates at the first `&`);
 *   * `Page.bringToFront()` before capturing: a hidden tab never runs requestAnimationFrame;
 *   * readiness is POLLED (100 ms steps, a few seconds' budget), never slept for.
 *
 * ONE WINDOW PER TAB, ON A HEADLESS CHROME. Parallel bug_solving forks capture in the same Chrome,
 * and bringing one tab to the front hides every other tab of its window, whose two-frame wait then
 * times out ("two animation frames took longer than 2000 ms", measured 2026-10-16 on the reverse
 * run). Each tab is therefore opened in a window of its own. That isolates it on a headless
 * Chrome only: measured the same day, two windows on the headless :9222 both kept rendering, while
 * on the headed container Chrome (:9223) the window behind was occluded and stalled all the same.
 * Hence DEFAULT_CAPTURE_CHROME_PORT. The two render the same pixels: all 64 reverse slides captured
 * on :9222 were byte-identical to the :9223 baseline of the same tree.
 *
 * READINESS. A page from the engine's exporter marks its root `data-sasha-export-ready="true"`
 * once fonts have arrived and shrink-to-fit text has been laid out; any other page (a fixture) is
 * ready when `document.fonts` has finished loading. Two animation frames then let the last layout
 * paint. A page that never becomes ready is still captured, and the capture says so.
 *
 * The device scale factor is a parameter: 1.25 makes a 1600 x 900 PNG, the size of Google's LARGE
 * thumbnail, so the rating UI's side-by-side and its diff overlay line up pixel for pixel.
 */
import CDPDefault from "chrome-remote-interface";

export type Capture = Readonly<{
  png: Uint8Array;
  /** The visible text after the page settled, words kept apart across boxes (VISIBLE_TEXT_EXPRESSION). */
  text: string;
  readiness: "ready" | "timedOut";
}>;

export type ChromeTab = AsyncDisposable &
  Readonly<{
    capture(options: Readonly<{ address: string }>): Promise<Capture>;
  }>;

/** The headless Chrome the round trip captures with (see ONE WINDOW PER TAB above). */
export const DEFAULT_CAPTURE_CHROME_PORT = 9222;
export const PAGE_WIDTH = 1280;
export const PAGE_HEIGHT = 720;
const LOAD_BUDGET_MILLISECONDS = 15_000;
const READY_BUDGET_MILLISECONDS = 8_000;
const POLL_MILLISECONDS = 100;

export async function openChromeTab(options: Readonly<{ port: number; deviceScaleFactor: number }>): Promise<ChromeTab> {
  const target = await openWindow({ port: options.port });
  let client: CdpClient;
  try {
    client = await CDP({ port: options.port, target: target.id });
  } catch (cause) {
    await CDP.Close({ port: options.port, id: target.id });
    throw cause;
  }
  const { Page, Runtime, Emulation } = client;
  await Page.enable();
  await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: PAGE_WIDTH, height: PAGE_HEIGHT, deviceScaleFactor: options.deviceScaleFactor, mobile: false });

  const evaluate = async (expression: string): Promise<unknown> => {
    const answer = await Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (answer.exceptionDetails !== undefined) throw new Error(`page script failed: ${answer.exceptionDetails.text}`);
    return answer.result.value;
  };

  return {
    capture: async ({ address }) => {
      const loaded = Page.loadEventFired();
      await Page.navigate({ url: address });
      await withinBudget({ promise: loaded, milliseconds: LOAD_BUDGET_MILLISECONDS, what: `loading ${address}` });
      await Page.bringToFront();
      let readiness: Capture["readiness"] = "timedOut";
      for (const startedAt = Date.now(); Date.now() - startedAt < READY_BUDGET_MILLISECONDS; ) {
        if ((await evaluate(READINESS_EXPRESSION)) === true) {
          readiness = "ready";
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MILLISECONDS));
      }
      await withinBudget({ promise: evaluate(TWO_FRAMES_EXPRESSION), milliseconds: 2_000, what: "two animation frames" });
      const screenshot = await Page.captureScreenshot({ format: "png", clip: { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, scale: 1 } });
      const text = await evaluate(VISIBLE_TEXT_EXPRESSION);
      return { png: new Uint8Array(Buffer.from(screenshot.data, "base64")), text: typeof text === "string" ? text : "", readiness };
    },
    [Symbol.asyncDispose]: async () => {
      try {
        await client.close();
      } finally {
        await CDP.Close({ port: options.port, id: target.id });
      }
    },
  };
}

const READINESS_EXPRESSION = `(() => {
  const marked = document.querySelector("[data-sasha-export-ready]");
  if (marked !== null) return marked.getAttribute("data-sasha-export-ready") === "true";
  return document.readyState === "complete" && document.fonts.status === "loaded";
})()`;

// WHY NOT innerText: it glues the text of adjacent flex and inline-block items into one word
// ("April" + "2026" -> "April2026"). Text nodes are joined with NOTHING inside one block-level box
// (runs of one paragraph: "footnote" + superscript "1") and with a SPACE across boxes and at a
// <br>. The engine's list glyph spans (text-paragraphs.tsx LIST_MARKER_ATTRIBUTE) are left out,
// as a fixture's ::marker bullets and Google's text runs have none.
const VISIBLE_TEXT_EXPRESSION = `(() => {
  if (document.body === null) return "";
  const boxOf = (element) => {
    for (let current = element; current !== null; current = current.parentElement) {
      const display = getComputedStyle(current).display;
      if (display !== "inline" && display !== "contents") return current;
    }
    return document.body;
  };
  let text = "";
  let previousBox = null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.tagName === "BR") text += " ";
      continue;
    }
    const parent = node.parentElement;
    if (parent === null || parent.closest("script, style, noscript, [data-sasha-list-marker]") !== null) continue;
    if (!parent.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const box = boxOf(parent);
    text += (previousBox === null || box === previousBox ? "" : " ") + node.textContent;
    previousBox = box;
  }
  return text;
})()`;

const TWO_FRAMES_EXPRESSION = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";

/** A blank page in a new window of its own, created over the browser's endpoint (`/json/new`
 *  can only add a tab to an existing window). */
async function openWindow(options: Readonly<{ port: number }>): Promise<CdpTarget> {
  const version = await CDP.Version({ port: options.port });
  const browser = await CDP({ port: options.port, target: version.webSocketDebuggerUrl });
  try {
    const { targetId } = await browser.Target.createTarget({ url: "about:blank", newWindow: true });
    return { id: targetId };
  } finally {
    await browser.close();
  }
}

async function withinBudget<TValue>(options: Readonly<{ promise: Promise<TValue>; milliseconds: number; what: string }>): Promise<TValue> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${options.what} took longer than ${options.milliseconds} ms`)), options.milliseconds);
  });
  try {
    return await Promise.race([options.promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

// chrome-remote-interface ships no types (types/ambient.d.ts declares its default export unknown);
// this is the narrow slice of its documented runtime surface the tab uses.
type CdpTarget = Readonly<{ id: string }>;
type CdpClient = Readonly<{
  Page: Readonly<{
    enable(): Promise<unknown>;
    navigate(parameters: Readonly<{ url: string }>): Promise<unknown>;
    loadEventFired(): Promise<unknown>;
    bringToFront(): Promise<unknown>;
    captureScreenshot(parameters: Readonly<{ format: "png"; clip: Readonly<{ x: number; y: number; width: number; height: number; scale: number }> }>): Promise<Readonly<{ data: string }>>;
  }>;
  Runtime: Readonly<{
    enable(): Promise<unknown>;
    evaluate(parameters: Readonly<{ expression: string; returnByValue: boolean; awaitPromise: boolean }>): Promise<Readonly<{ result: Readonly<{ value?: unknown }>; exceptionDetails?: Readonly<{ text: string }> }>>;
  }>;
  Emulation: Readonly<{
    setDeviceMetricsOverride(parameters: Readonly<{ width: number; height: number; deviceScaleFactor: number; mobile: boolean }>): Promise<unknown>;
  }>;
  Target: Readonly<{
    createTarget(parameters: Readonly<{ url: string; newWindow: boolean }>): Promise<Readonly<{ targetId: string }>>;
  }>;
  close(): Promise<void>;
}>;
type CdpModule = ((options: Readonly<{ port: number; target: string }>) => Promise<CdpClient>) &
  Readonly<{
    Version(options: Readonly<{ port: number }>): Promise<Readonly<{ webSocketDebuggerUrl: string }>>;
    Close(options: Readonly<{ port: number; id: string }>): Promise<void>;
  }>;
// The module's default export is callable with `Version` and `Close` attached, as documented by
// chrome-remote-interface; the ambient declaration only types it `unknown`.
const CDP = CDPDefault as CdpModule;
