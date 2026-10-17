// CHROME OVER THE DEVTOOLS PROTOCOL for every end-to-end driver (editor, export, presenter, web),
// spoken directly over Node's own WebSocket to the browser endpoint with flattened target sessions,
// so the engine needs no client library. Each tab gets its OWN browser context (its own cookies, as
// two people on two machines would); everything a run opens, disposing the browser closes again.
//
// Project rules this follows (CLAUDE.md): open a BLANK tab and navigate it, subscribe to
// `Page.loadEventFired` BEFORE navigating, poll observable state with second-scale budgets, and
// bring a tab to the front before driving it (`document.hasFocus()`); focus is also emulated, so a
// tab behind another still takes key presses.
//
// Measured 2026-10-15 in the integrated milestone 2 run: each person's context opens its own tab,
// and only the newest one is visible. In a hidden tab `requestAnimationFrame` never fires, so an
// evaluated promise that waits for a frame hangs until the command timeout; race any frame wait
// against a short timer. And a tab that prefers reduced motion (the default here) sees the
// presenter's fade instead of a scripted transition: pass `reducedMotion: false` to see one.
//
// Chrome is at $CHROME_ENDPOINT, http://127.0.0.1:9223 (the container's Chrome) unless set.

import { writeFile } from "node:fs/promises";

export const CHROME_ENDPOINT = process.env["CHROME_ENDPOINT"] ?? "http://127.0.0.1:9223";

type Point = Readonly<{ x: number; y: number }>;
type Pending = Readonly<{ resolve: (value: unknown) => void; reject: (error: Error) => void; method: string }>;

export type TabOptions = Readonly<{
  width: number;
  height: number;
  /** Light unless told otherwise. */
  scheme?: "light" | "dark";
  /** Reduced motion unless false (the presenter then runs scripted transitions instead of a fade). */
  reducedMotion?: boolean;
}>;

export type Browser = AsyncDisposable &
  Readonly<{
    /** A tab in a fresh browser context of its own, brought to the front. */
    openTab: (options: TabOptions) => Promise<Tab>;
  }>;

/** Disposing a tab closes it and its browser context; disposing the browser closes whatever is left. */
export type Tab = AsyncDisposable &
  Readonly<{
    navigate: (address: string) => Promise<void>;
    /** The JSON value `expression` produced (awaited when it is a promise); the caller names its type. */
    evaluate: <TValue = unknown>(expression: string) => Promise<TValue>;
    /** Polls `expression` every 50 ms until it is truthy and returns the milliseconds it took; rejects after `timeoutMilliseconds`. */
    waitFor: (expression: string, timeoutMilliseconds: number) => Promise<number>;
    click: (point: Point) => Promise<void>;
    moveMouse: (point: Point) => Promise<void>;
    /** One raw mouse event, for drags: `buttons` 1 while the left button is held. */
    mouse: (event: Readonly<{ type: "mousePressed" | "mouseMoved" | "mouseReleased"; point: Point; buttons: number }>) => Promise<void>;
    /** One key press; `modifiers` are the DevTools Protocol's bits (Alt 1, Control 2, Meta 4, Shift 8). */
    press: (key: Readonly<{ key: string; code: string; keyCode: number; modifiers?: number; text?: string }>) => Promise<void>;
    insertText: (text: string) => Promise<void>;
    /** The page as a PNG at `path`. */
    screenshot: (path: string) => Promise<void>;
    bringToFront: () => Promise<void>;
    /**
     * Puts a cookie in this tab's browser context, so a run against the real deck server can hand
     * each person a session minted with the server's own secret instead of signing in with Google.
     */
    setCookie: (cookie: Readonly<{ url: string; name: string; value: string }>) => Promise<void>;
  }>;

/** Connects to Chrome at `endpoint` (CHROME_ENDPOINT unless set); every command must answer within `commandTimeoutMilliseconds` (10 s unless set). */
export async function connectBrowser(options: Readonly<{ endpoint?: string; commandTimeoutMilliseconds?: number }> = {}): Promise<Browser> {
  const endpoint = options.endpoint ?? CHROME_ENDPOINT;
  const commandTimeout = options.commandTimeoutMilliseconds ?? 10_000;
  const version = (await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2_000) })).json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof version.webSocketDebuggerUrl !== "string") throw new Error(`Chrome on ${endpoint} named no browser endpoint`);
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
      else waiting.resolve(message.result ?? {});
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
        reject(new Error(`${method} did not answer within ${commandTimeout} ms`));
      }, commandTimeout);
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

  const open = new Map<string, string>(); // target id -> its browser context id
  const close = async (targetId: string): Promise<void> => {
    const browserContextId = open.get(targetId);
    open.delete(targetId);
    await send("Target.closeTarget", { targetId }).catch(() => undefined);
    if (browserContextId !== undefined) await send("Target.disposeBrowserContext", { browserContextId }).catch(() => undefined);
  };

  return {
    openTab: async (tabOptions) => {
      const { browserContextId } = (await send("Target.createBrowserContext", { disposeOnDetach: false })) as { browserContextId: string };
      const { targetId } = (await send("Target.createTarget", { url: "about:blank", browserContextId })) as { targetId: string };
      open.set(targetId, browserContextId);
      const { sessionId } = (await send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
      const command = (method: string, parameters: Readonly<Record<string, unknown>> = {}): Promise<unknown> => send(method, parameters, sessionId);
      await command("Page.enable");
      await command("Runtime.enable");
      await command("Emulation.setDeviceMetricsOverride", { width: tabOptions.width, height: tabOptions.height, deviceScaleFactor: 1, mobile: false });
      await command("Emulation.setFocusEmulationEnabled", { enabled: true });
      // Every content security policy violation the page meets is kept for the run's report.
      await command("Page.addScriptToEvaluateOnNewDocument", { source: `addEventListener("securitypolicyviolation", (event) => { (window.sashaPolicyViolations ||= []).push(event.violatedDirective + " " + event.blockedURI); });` });
      await command("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-reduced-motion", value: tabOptions.reducedMotion === false ? "no-preference" : "reduce" },
          { name: "prefers-color-scheme", value: tabOptions.scheme ?? "light" },
        ],
      });
      await command("Page.bringToFront");
      const evaluate = async <TValue = unknown>(expression: string): Promise<TValue> => {
        const result = (await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
        if (result.exceptionDetails !== undefined) throw new Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`);
        // returnByValue: the protocol hands back the JSON value the expression produced; callers name its type.
        return result.result.value as TValue;
      };
      const mouse = (type: string, point: Point, buttons: number): Promise<unknown> =>
        command("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: type === "mouseMoved" && buttons === 0 ? "none" : "left", buttons, clickCount: 1 });
      return {
        navigate: async (address) => {
          const loaded = once(sessionId, "Page.loadEventFired", 10_000);
          await command("Page.navigate", { url: address });
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
          await command("Input.dispatchKeyEvent", { type: key.text === undefined ? "rawKeyDown" : "keyDown", ...common, ...(key.text === undefined ? {} : { text: key.text }) });
          await command("Input.dispatchKeyEvent", { type: "keyUp", ...common });
        },
        insertText: async (text) => {
          await command("Input.insertText", { text });
        },
        screenshot: async (path) => {
          const { data } = (await command("Page.captureScreenshot", { format: "png" })) as { data: string };
          await writeFile(path, Buffer.from(data, "base64"));
        },
        bringToFront: async () => {
          await command("Page.bringToFront");
        },
        setCookie: async (cookie) => {
          await command("Network.setCookie", { ...cookie, httpOnly: true, secure: true, sameSite: "Strict" });
        },
        [Symbol.asyncDispose]: () => close(targetId),
      };
    },
    [Symbol.asyncDispose]: async () => {
      for (const targetId of [...open.keys()]) await close(targetId);
      socket.close();
    },
  };
}
