// CHROME OVER THE DEVTOOLS PROTOCOL for the web application's end-to-end run, spoken directly over
// Node's own WebSocket to the browser endpoint with flattened target sessions. Each person in the
// run gets their OWN browser context (their own cookies, as two people on two machines would), and
// a blank tab in it; everything this run opens it closes again.
//
// Project rules this follows (CLAUDE.md): open a BLANK tab and navigate it, subscribe to
// `Page.loadEventFired` BEFORE navigating, poll observable state with second-scale budgets, and
// bring a tab to the front before driving it (`document.hasFocus()`).
//
// Measured 2026-10-15 in the integrated milestone 2 run: each person's context opens its own tab,
// and only the newest one is visible. In a hidden tab `requestAnimationFrame` never fires, so an
// evaluated promise that waits for a frame hangs until this file's 10 s command timeout; race any
// frame wait against a short timer. And a person that prefers reduced motion (the default here)
// sees the presenter's fade instead of a scripted transition: pass `reducedMotion: false` to see one.

import { writeFile } from "node:fs/promises";

export const CHROME_ENDPOINT = "http://127.0.0.1:9223";

type Pending = Readonly<{ resolve: (value: unknown) => void; reject: (error: Error) => void; method: string }>;

export type Browser = AsyncDisposable &
  Readonly<{
    /**
     * A tab in a fresh browser context of its own. It prefers reduced motion unless
     * `reducedMotion` is false (the presenter then runs scripted transitions instead of a fade).
     */
    openPerson: (options: Readonly<{ width: number; height: number; reducedMotion?: boolean }>) => Promise<Tab>;
  }>;

export type Tab = Readonly<{
  navigate: (address: string) => Promise<void>;
  evaluate: (expression: string) => Promise<unknown>;
  /** Polls `expression` every 50 ms until it is truthy; rejects after `timeoutMilliseconds`. */
  waitFor: (expression: string, timeoutMilliseconds: number) => Promise<number>;
  click: (point: Readonly<{ x: number; y: number }>) => Promise<void>;
  moveMouse: (point: Readonly<{ x: number; y: number }>) => Promise<void>;
  /** One raw mouse event, for drags: `buttons` 1 while the left button is held. */
  mouse: (event: Readonly<{ type: "mousePressed" | "mouseMoved" | "mouseReleased"; point: Readonly<{ x: number; y: number }>; buttons: number }>) => Promise<void>;
  /** One key press; `modifiers` are the DevTools Protocol's bits (Alt 1, Control 2, Meta 4, Shift 8). */
  press: (key: Readonly<{ key: string; code: string; keyCode: number; modifiers?: number; text?: string }>) => Promise<void>;
  insertText: (text: string) => Promise<void>;
  screenshot: (path: string) => Promise<void>;
  bringToFront: () => Promise<void>;
  /**
   * Puts a cookie in this person's browser context, so a run against the real deck server can hand
   * each person a session minted with the server's own secret instead of signing in with Google.
   */
  setCookie: (cookie: Readonly<{ url: string; name: string; value: string }>) => Promise<void>;
}>;

export async function connectBrowser(): Promise<Browser> {
  const version = (await (await fetch(`${CHROME_ENDPOINT}/json/version`, { signal: AbortSignal.timeout(2_000) })).json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof version.webSocketDebuggerUrl !== "string") throw new Error("Chrome on 127.0.0.1:9223 named no browser endpoint");
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("could not connect to Chrome")), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, ((parameters: unknown) => void)[]>();
  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: unknown; sessionId?: string };
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (waiting === undefined) return;
      if (message.error !== undefined) waiting.reject(new Error(`${waiting.method}: ${message.error.message}`));
      else waiting.resolve(message.result);
      return;
    }
    if (message.method === undefined) return;
    for (const listener of listeners.get(`${message.sessionId ?? ""} ${message.method}`) ?? []) listener(message.params);
  });

  const send = (method: string, parameters: Readonly<Record<string, unknown>>, sessionId?: string): Promise<unknown> => {
    const commandNumber = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(commandNumber);
        reject(new Error(`${method} did not answer within 10 s`));
      }, 10_000);
      pending.set(commandNumber, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id: commandNumber, method, params: parameters, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  };

  const once = (sessionId: string, method: string, timeoutMilliseconds: number): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const key = `${sessionId} ${method}`;
      const timer = setTimeout(() => reject(new Error(`${method} did not arrive within ${timeoutMilliseconds} ms`)), timeoutMilliseconds);
      const listener = (parameters: unknown): void => {
        clearTimeout(timer);
        listeners.set(key, (listeners.get(key) ?? []).filter((candidate) => candidate !== listener));
        resolve(parameters);
      };
      listeners.set(key, [...(listeners.get(key) ?? []), listener]);
    });

  const contexts: string[] = [];
  const targets: string[] = [];

  return {
    openPerson: async (size) => {
      const { browserContextId } = (await send("Target.createBrowserContext", { disposeOnDetach: false })) as { browserContextId: string };
      contexts.push(browserContextId);
      const { targetId } = (await send("Target.createTarget", { url: "about:blank", browserContextId })) as { targetId: string };
      targets.push(targetId);
      const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
      await send("Page.enable", {}, sessionId);
      await send("Runtime.enable", {}, sessionId);
      await send("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false }, sessionId);
      // Every content security policy violation the page meets is kept for the run's report.
      await send("Page.addScriptToEvaluateOnNewDocument", { source: `addEventListener("securitypolicyviolation", (event) => { (window.sashaPolicyViolations ||= []).push(event.violatedDirective + " " + event.blockedURI); });` }, sessionId);
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: size.reducedMotion === false ? "no-preference" : "reduce" }, { name: "prefers-color-scheme", value: "light" }] }, sessionId);
      const evaluate = async (expression: string): Promise<unknown> => {
        const result = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)) as { result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
        if (result.exceptionDetails !== undefined) throw new Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`);
        return result.result.value;
      };
      const mouse = (type: string, point: Readonly<{ x: number; y: number }>, buttons: number): Promise<unknown> =>
        send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: type === "mouseMoved" && buttons === 0 ? "none" : "left", buttons, clickCount: 1 }, sessionId);
      return {
        navigate: async (address) => {
          const loaded = once(sessionId, "Page.loadEventFired", 10_000);
          await send("Page.navigate", { url: address }, sessionId);
          await loaded;
        },
        evaluate,
        waitFor: async (expression, timeoutMilliseconds) => {
          const started = Date.now();
          for (;;) {
            if (await evaluate(`Boolean(${expression})`).catch(() => false)) return Date.now() - started;
            if (Date.now() - started > timeoutMilliseconds) throw new Error(`timed out after ${timeoutMilliseconds} ms waiting for ${expression}`);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        },
        click: async (point) => {
          await mouse("mouseMoved", point, 0);
          await mouse("mousePressed", point, 1);
          await mouse("mouseReleased", point, 0);
        },
        moveMouse: async (point) => {
          await mouse("mouseMoved", point, 0);
        },
        mouse: async (event) => {
          await mouse(event.type, event.point, event.buttons);
        },
        press: async (key) => {
          const common = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers: key.modifiers ?? 0 };
          await send("Input.dispatchKeyEvent", { type: key.text === undefined ? "rawKeyDown" : "keyDown", ...common, ...(key.text === undefined ? {} : { text: key.text }) }, sessionId);
          await send("Input.dispatchKeyEvent", { type: "keyUp", ...common }, sessionId);
        },
        insertText: async (text) => {
          await send("Input.insertText", { text }, sessionId);
        },
        screenshot: async (path) => {
          const { data } = (await send("Page.captureScreenshot", { format: "png" }, sessionId)) as { data: string };
          await writeFile(path, Buffer.from(data, "base64"));
        },
        bringToFront: async () => {
          await send("Page.bringToFront", {}, sessionId);
        },
        setCookie: async (cookie) => {
          await send("Network.setCookie", { ...cookie, httpOnly: true, secure: true, sameSite: "Strict" }, sessionId);
        },
      };
    },
    [Symbol.asyncDispose]: async () => {
      for (const targetId of targets) await send("Target.closeTarget", { targetId }).catch(() => undefined);
      for (const browserContextId of contexts) await send("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined);
      socket.close();
    },
  };
}
