// Driving one page in the headful, Google-logged-in Chrome on CDP :9223 — the only browser surface
// the product E2E touches. Everything the harness does to the picker goes through `PageSession`,
// so a step never holds a raw CDP client and never has to remember to close one.
//
// TWO GOTCHAS ARE ENCODED HERE, both paid for already:
//   * `CDP.New({ url })` does NOT url-encode, so a query string is truncated at the first `&`.
//     A tab is therefore created blank and then navigated with `Page.navigate`.
//   * Google's React widgets ignore a synthetic `element.click()` in places, so `click` dispatches
//     a real `Input.dispatchMouseEvent` triple (mouseMoved -> mousePressed -> mouseReleased) at the
//     element's centre. The picker's own buttons are plain React and would accept either, but using
//     the real path everywhere means the harness proves the same thing a user's mouse does.
import { writeFileSync } from "node:fs";
import CDPraw from "chrome-remote-interface";
import type { CdpClient, CdpModule, CdpTarget } from "../../../types/cdp-types.ts";

// SAFETY: types/ambient.d.ts declares the module's default export as `unknown` because the package
// ships no .d.ts; types/cdp-types.ts is this repo's hand-written shape for it, and this is the one
// narrowing point the style guide asks for (same cast as addon/src/smoke.e2e.ts).
const CDP = CDPraw as unknown as CdpModule;

/** One live page, with every operation the harness needs and no CDP leaking out. */
export type PageSession = Readonly<{
  targetId: string;
  url: string;
  /** Brings the tab to the front, so `document.visibilityState` is "visible" and the poll is fast. */
  activate(): Promise<void>;
  navigate(spec: Readonly<{ url: string }>): Promise<void>;
  value(expression: string): Promise<unknown>;
  text(expression: string): Promise<string>;
  count(expression: string): Promise<number>;
  /** Polls an expression that must become `true`; returns how long it took, or null on timeout. */
  waitFor(spec: Readonly<{ expression: string; budgetMs: number }>): Promise<number | null>;
  click(spec: Readonly<{ selector: string }>): Promise<ClickOutcome>;
  screenshot(spec: Readonly<{ path: string }>): Promise<void>;
  /** Uncaught page exceptions seen since the session opened. A non-empty list is a failure. */
  pageErrors(): readonly string[];
}>;

export type ClickOutcome =
  | Readonly<{ kind: "clicked"; x: number; y: number }>
  | Readonly<{ kind: "absent"; selector: string }>;

/** How often `waitFor` re-asks. CDP round trips are sub-millisecond; this is a budget, not a sleep. */
const POLL_EVERY_MS = 100;

/**
 * Opens a NEW tab, runs `body` against it, and leaves the tab open — the picker's state lives in
 * the page, so the next step reattaches to it with `withExistingPage` rather than reloading and
 * losing the offer. Only the CDP connection is scope-bound.
 */
export async function withNewPage<TResult>(
  spec: Readonly<{ port: number; url: string }>,
  body: (page: PageSession) => Promise<TResult>,
): Promise<TResult> {
  // Created blank on purpose: CDP.New does not url-encode what it is given.
  const target = await CDP.New({ port: spec.port });
  return withTarget({ port: spec.port, target }, async (page) => {
    await page.navigate({ url: spec.url });
    return body(page);
  });
}

/** Reattaches to the tab already serving `urlNeedle`, so cross-step page state survives. */
export async function withExistingPage<TResult>(
  spec: Readonly<{ port: number; urlNeedle: string }>,
  body: (page: PageSession) => Promise<TResult>,
): Promise<TResult> {
  const targets = await CDP.List({ port: spec.port });
  const found = targets.filter((candidate) => candidate.type === "page" && candidate.url.includes(spec.urlNeedle));
  const target = found[0];
  if (target === undefined) {
    throw new Error(
      `no open tab on :${spec.port} whose url contains "${spec.urlNeedle}" — run the "open" step first ` +
        `(tabs: ${targets.filter((candidate) => candidate.type === "page").map((candidate) => candidate.url.slice(0, 60)).join(" | ")})`,
    );
  }
  if (found.length > 1) {
    throw new Error(`${found.length} tabs match "${spec.urlNeedle}" on :${spec.port}; close the extras so the step cannot pick a stale one`);
  }
  return withTarget({ port: spec.port, target }, body);
}

/** Closes every tab serving `urlNeedle`. Used by cleanup so a re-run starts from a known state. */
export async function closePages(spec: Readonly<{ port: number; urlNeedle: string }>): Promise<readonly string[]> {
  const targets = await CDP.List({ port: spec.port });
  const closed: string[] = [];
  for (const target of targets) {
    if (target.type !== "page" || !target.url.includes(spec.urlNeedle)) continue;
    await CDP.Close({ port: spec.port, id: target.id });
    closed.push(target.id);
  }
  return closed;
}

async function withTarget<TResult>(
  spec: Readonly<{ port: number; target: CdpTarget }>,
  body: (page: PageSession) => Promise<TResult>,
): Promise<TResult> {
  const client = await CDP({ target: spec.target, port: spec.port });
  try {
    return await body(await sessionOver({ client, target: spec.target }));
  } finally {
    // Only the socket is released. The tab stays open by design.
    await client.close();
  }
}

async function sessionOver({ client, target }: { client: CdpClient; target: CdpTarget }): Promise<PageSession> {
  await client.Page.enable();
  await client.Runtime.enable();
  await client.Target.setDiscoverTargets({ discover: true });
  const errors: string[] = [];
  client.Runtime.exceptionThrown((event) => {
    errors.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text);
  });

  return {
    targetId: target.id,
    url: target.url,

    async activate() {
      await client.Target.activateTarget({ targetId: target.id });
    },

    async navigate({ url }) {
      await client.Page.navigate({ url });
    },

    value(expression) {
      return evaluated({ client, expression });
    },

    async text(expression) {
      const value = await evaluated({ client, expression });
      return typeof value === "string" ? value : JSON.stringify(value ?? null);
    },

    async count(expression) {
      const value = await evaluated({ client, expression });
      return typeof value === "number" ? value : -1;
    },

    async waitFor({ expression, budgetMs }) {
      const startedAt = Date.now();
      const deadline = startedAt + budgetMs;
      for (;;) {
        if ((await evaluated({ client, expression })) === true) return Date.now() - startedAt;
        if (Date.now() >= deadline) return null;
        await after(POLL_EVERY_MS);
      }
    },

    async click({ selector }) {
      const box = await centreOf({ client, selector });
      if (box === null) return { kind: "absent", selector };
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
        await client.Input.dispatchMouseEvent({ type, x: box.x, y: box.y, button: "left", clickCount: 1 });
      }
      return { kind: "clicked", x: box.x, y: box.y };
    },

    async screenshot({ path }) {
      const shot = await client.Page.captureScreenshot({ format: "png" });
      writeFileSync(path, Buffer.from(shot.data, "base64"));
    },

    pageErrors() {
      return [...errors];
    },
  };
}

async function centreOf({
  client,
  selector,
}: {
  client: CdpClient;
  selector: string;
}): Promise<Readonly<{ x: number; y: number }> | null> {
  const measured = await evaluated({
    client,
    expression:
      `(() => { const element = document.querySelector(${JSON.stringify(selector)});` +
      " if (element === null) return null;" +
      " element.scrollIntoView({ block: 'center' });" +
      " const box = element.getBoundingClientRect();" +
      " return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()",
  });
  if (typeof measured !== "object" || measured === null) return null;
  const record = measured as Readonly<Record<string, unknown>>;
  const x = record["x"];
  const y = record["y"];
  return typeof x === "number" && typeof y === "number" ? { x, y } : null;
}

async function evaluated({ client, expression }: { client: CdpClient; expression: string }): Promise<unknown> {
  const evaluation = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  return evaluation.result.value;
}

function after(delayMs: number): Promise<void> {
  return new Promise<void>((done) => setTimeout(done, delayMs));
}
