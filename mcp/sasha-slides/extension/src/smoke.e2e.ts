// A real-browser smoke test: Chrome loads the unpacked extension, a fake Google Slides page is
// served by intercepting the network, a fake MCP-server bridge stands in for Drive, and the picker
// is driven and screenshotted. This is the only test that proves the three contexts actually talk
// to each other -- the unit tests substitute every dependency, which cannot catch a manifest
// mistake, a missing permission or a port name that does not match.
//
//   node --import tsx src/smoke.e2e.ts        (about 15 s; the repo's command budget is 30 s)
//
// WHY `Extensions.loadUnpacked` OVER A PIPE. Google Chrome >= 137 ignores --load-extension, and
// loadUnpacked is only served over --remote-debugging-pipe (fds 3/4). Chrome exits when the pipe
// closes, so the browser lives exactly as long as this process. Same recipe as
// nanobox/test/chrome-extension-harness.mjs, which is where it was worked out; it is restated here
// in TypeScript rather than imported across a project boundary.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeDrive, type FakeDrive } from "./fake-drive.ts";

const CHROME = "/usr/bin/google-chrome-stable";
const EXTENSION_PATH = new URL("..", import.meta.url).pathname;
const CDP_PORT = 9333;
const BRIDGE_PORT = 8777;
const PRESENTATION_ID = "1SmokeTestPresentationId";
const SLIDES_URL = `https://docs.google.com/presentation/d/${PRESENTATION_ID}/edit`;
const DEADLINE_MS = 25_000;

async function main(): Promise<void> {
  const startedAt = Date.now();
  const drive = fakeDrive();
  drive.stageProposal({ proposalId: "p_smoke", count: 3, presentationId: PRESENTATION_ID });

  const bridge = startBridge({ drive });
  const chrome = await startChrome();
  try {
    const page = await openPage();
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "https://docs.google.com/*" }] });
    page.on("Fetch.requestPaused", (params) => {
      void page.send("Fetch.fulfillRequest", {
        requestId: params["requestId"],
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body: Buffer.from(FAKE_SLIDES_PAGE, "utf-8").toString("base64"),
      });
    });
    await page.send("Page.enable", {});
    await page.send("Page.navigate", { url: SLIDES_URL });

    const picker = await poll({
      what: "the picker to render inside the Slides page",
      read: () => page.evaluateString(READ_PICKER),
      done: (text) => text.includes("candidate slides"),
      deadlineMs: DEADLINE_MS - (Date.now() - startedAt),
    });
    report("picker rendered", picker);
    expect(picker.includes("3 candidate slides"), "the dialog counts the candidates");
    for (const index of [1, 2, 3]) expect(picker.includes(`#${index}`), `chip ${index} is numbered`);
    expect(picker.includes("HTML (authoritative)|on"), "the HTML pane is selected first");
    expect(picker.includes("iframe:1280x720"), "the raw HTML is in a sandboxed 1280x720 iframe");

    await page.evaluateString(clickScript("Converted slide"));
    const converted = await poll({
      what: "the converted-slide pane",
      read: () => page.evaluateString(READ_PICKER),
      done: (text) => text.includes("Converted slide|on"),
      deadlineMs: DEADLINE_MS - (Date.now() - startedAt),
    });
    report("toggled to the converted slide", converted);
    expect(!converted.includes("iframe:"), "the HTML iframe is gone");
    expect(converted.includes("elements:1"), "the converter's elements are drawn");
    expect(converted.includes("marks:1"), "the unsupported region is pre-marked as an anomaly");

    await page.evaluateString(clickScript("HTML (authoritative)"));
    const back = await poll({
      what: "the toggle back to HTML",
      read: () => page.evaluateString(READ_PICKER),
      done: (text) => text.includes("iframe:1280x720"),
      deadlineMs: DEADLINE_MS - (Date.now() - startedAt),
    });
    report("toggled back to HTML", back);

    const shot = await page.send("Page.captureScreenshot", { format: "png" });
    const shotPath = join(mkdtempSync(join(tmpdir(), "sasha-smoke-")), "picker.png");
    writeFileSync(shotPath, Buffer.from(String(shot["data"]), "base64"));
    console.log(`screenshot   ${shotPath}`);

    console.log(`\nsmoke.e2e.ts: ok in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (error) {
    console.log(`bridge calls: ${JSON.stringify(bridge.calls())}`);
    console.log(await diagnose());
    throw error;
  } finally {
    chrome.close();
    bridge.close();
  }
}

/** Every extension context's console, for when the picker does not appear. */
async function diagnose(): Promise<string> {
  const targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()) as readonly Record<string, string>[];
  const lines: string[] = [];
  for (const target of targets) {
    lines.push(`target ${target["type"]} ${target["url"]}`);
    const wsUrl = target["webSocketDebuggerUrl"];
    if (wsUrl === undefined) continue;
    try {
      lines.push(...(await consoleOf(wsUrl)).map((line) => `   ${line}`));
    } catch (error) {
      lines.push(`   (could not attach: ${error instanceof Error ? error.message : String(error)})`);
    }
  }
  return lines.join("\n");
}

async function consoleOf(wsUrl: string): Promise<readonly string[]> {
  const socket = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("attach failed")), { once: true });
  });
  const lines: string[] = [];
  socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    const method = String(message["method"] ?? "");
    if (method === "Log.entryAdded" || method === "Runtime.consoleAPICalled" || method === "Runtime.exceptionThrown") {
      lines.push(`${method}: ${JSON.stringify(message["params"]).slice(0, 400)}`);
    }
  });
  socket.send(JSON.stringify({ id: 1, method: "Log.enable", params: {} }));
  socket.send(JSON.stringify({ id: 2, method: "Runtime.enable", params: {} }));
  await new Promise((resolve) => setTimeout(resolve, 600));
  socket.close();
  return lines;
}

/** The bridge the offscreen document's `localhost-bridge` channel calls. Stands in for the server. */
function startBridge({ drive }: { drive: FakeDrive }): Readonly<{ close(): void; calls(): readonly string[] }> {
  const bridgeCalls: string[] = [];
  const handlers: Readonly<Record<string, (payload: Record<string, unknown>) => Promise<unknown>>> = {
    listByRoles: async (payload) => unwrap(await drive.api.listByRoles(payload as never)),
    downloadText: async (payload) => unwrap(await drive.api.downloadText(String(payload["fileId"]))),
    createTextFile: async (payload) => unwrap(await drive.api.createTextFile(payload as never)),
    ensureChildFolder: async (payload) => unwrap(await drive.api.ensureChildFolder(payload as never)),
    createBinaryFile: async (payload) =>
      unwrap(
        await drive.api.createBinaryFile({
          name: String(payload["name"]),
          parentFolderId: String(payload["parentFolderId"]),
          mimeType: String(payload["mimeType"]),
          bytes: new Blob([Buffer.from(String(payload["base64"] ?? ""), "base64")], { type: "image/png" }),
          appProperties: (payload["appProperties"] ?? {}) as Readonly<Record<string, string>>,
        }),
      ),
    batchUpdate: async (payload) => unwrap(await drive.slides.batchUpdate(payload as never)),
    pageThumbnailPng: async (payload) => {
      const png = unwrap(await drive.slides.pageThumbnailPng(payload as never)) as Blob;
      return Buffer.from(await png.arrayBuffer()).toString("base64");
    },
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const method = (request.url ?? "").replace("/drive-channel/", "");
    const handler = handlers[method];
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (handler === undefined) {
        response.writeHead(404).end(`no such bridge method: ${method}`);
        return;
      }
      const payload = chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      bridgeCalls.push(method);
      handler(payload).then(
        (value) => {
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
        },
        (error: unknown) => {
          response.writeHead(500).end(error instanceof Error ? error.message : String(error));
        },
      );
    });
  });
  server.listen(BRIDGE_PORT, "127.0.0.1");
  console.log(`bridge       http://127.0.0.1:${BRIDGE_PORT} (fake MCP server, fake Drive)`);
  return { close: () => server.close(), calls: () => bridgeCalls };
}

type Chrome = Readonly<{ close(): void }>;

async function startChrome(): Promise<Chrome> {
  const userDataDir = mkdtempSync(join(tmpdir(), "sasha-smoke-chrome-"));
  const child: ChildProcessWithoutNullStreams = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-pipe",
      `--remote-debugging-port=${CDP_PORT}`,
      "--enable-unsafe-extension-debugging",
      "--remote-allow-origins=*",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  ) as ChildProcessWithoutNullStreams;
  const pipeOut = child.stdio[3] as NodeJS.WritableStream;
  const pipeIn = child.stdio[4] as NodeJS.ReadableStream;

  const replies = new Map<number, (message: Record<string, unknown>) => void>();
  let buffered = "";
  pipeIn.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    for (let end = buffered.indexOf("\0"); end >= 0; end = buffered.indexOf("\0")) {
      const message = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>;
      buffered = buffered.slice(end + 1);
      const waiter = replies.get(Number(message["id"]));
      if (waiter !== undefined) {
        replies.delete(Number(message["id"]));
        waiter(message);
      }
    }
  });
  let nextId = 0;
  const call = (method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      replies.set(id, (message) => {
        const error = message["error"];
        if (error !== undefined) reject(new Error(`${method}: ${JSON.stringify(error)}`));
        else resolve((message["result"] ?? {}) as Record<string, unknown>);
      });
      pipeOut.write(`${JSON.stringify({ id, method, params })}\0`);
      setTimeout(() => {
        if (replies.delete(id)) reject(new Error(`${method}: no reply in 10s`));
      }, 10_000);
    });

  const close = (): void => {
    try {
      pipeOut.end();
    } catch {
      /* already gone */
    }
    child.kill();
  };
  try {
    const loaded = await call("Extensions.loadUnpacked", { path: EXTENSION_PATH });
    console.log(`extension    ${String(loaded["id"])} loaded unpacked from ${EXTENSION_PATH}`);
    await poll({
      what: `chrome on :${CDP_PORT}`,
      read: async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).ok,
      done: (ok) => ok,
      deadlineMs: 15_000,
    });
  } catch (error) {
    close();
    throw error;
  }
  return { close };
}

type Page = Readonly<{
  send(method: string, params: unknown): Promise<Record<string, unknown>>;
  on(event: string, handle: (params: Record<string, unknown>) => void): void;
  evaluateString(expression: string): Promise<string>;
}>;

/** A minimal CDP client over node's global WebSocket, so the test needs no client library. */
async function openPage(): Promise<Page> {
  const created = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" })).json()) as {
    webSocketDebuggerUrl: string;
  };
  const socket = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true });
  });
  const replies = new Map<number, (message: Record<string, unknown>) => void>();
  const listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();
  socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    const id = message["id"];
    if (typeof id === "number") {
      replies.get(id)?.(message);
      replies.delete(id);
      return;
    }
    for (const listen of listeners.get(String(message["method"])) ?? []) {
      listen((message["params"] ?? {}) as Record<string, unknown>);
    }
  });
  let nextId = 0;
  const send = (method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      replies.set(id, (message) => {
        const error = message["error"];
        if (error !== undefined) reject(new Error(`${method}: ${JSON.stringify(error)}`));
        else resolve((message["result"] ?? {}) as Record<string, unknown>);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    on(event, handle) {
      listeners.set(event, [...(listeners.get(event) ?? []), handle]);
    },
    async evaluateString(expression) {
      const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      const value = (result["result"] as Record<string, unknown> | undefined)?.["value"];
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  };
}

/**
 * The picker lives in an OPEN shadow root, so the main world can read it without the extension
 * exposing anything. This summarises it as one line, which is what the assertions match on.
 */
const READ_PICKER = `(() => {
  const host = document.getElementById("sasha-slides-picker-host");
  if (!host) return "no host element";
  const shadow = host.shadowRoot;
  if (!shadow) return "no shadow root";
  const dialog = shadow.querySelector(".sasha-dialog");
  if (!dialog) return "shadow root present, nothing rendered: " + (shadow.textContent || "").slice(0, 120);
  const parts = [dialog.querySelector(".sasha-header strong").textContent];
  for (const chip of shadow.querySelectorAll(".sasha-chip")) {
    parts.push("#" + chip.querySelector(".sasha-chip-number").textContent);
  }
  for (const tab of shadow.querySelectorAll(".sasha-tab")) {
    parts.push(tab.textContent + "|" + (tab.getAttribute("aria-pressed") === "true" ? "on" : "off"));
  }
  const frame = shadow.querySelector("iframe.sasha-frame");
  if (frame) parts.push("iframe:" + frame.width + "x" + frame.height + ":sandbox=" + JSON.stringify(frame.getAttribute("sandbox")));
  const rendered = shadow.querySelector(".sasha-rendered");
  if (rendered) parts.push("elements:" + shadow.querySelectorAll(".sasha-el").length);
  parts.push("marks:" + shadow.querySelectorAll(".sasha-mark").length);
  parts.push("action:" + (shadow.querySelector(".sasha-primary") || {}).textContent);
  return parts.join(" | ");
})()`;

function clickScript(label: string): string {
  return `(() => {
    const shadow = document.getElementById("sasha-slides-picker-host").shadowRoot;
    for (const tab of shadow.querySelectorAll(".sasha-tab")) {
      if (tab.textContent.trim() === ${JSON.stringify(label)}) { tab.click(); return "clicked"; }
    }
    return "not found";
  })()`;
}

/** Google Slides is never reached: this is fulfilled for its URL, so the content script injects. */
const FAKE_SLIDES_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Smoke deck - Google Slides</title></head>
<body style="margin:0;font-family:Roboto,Arial,sans-serif;background:#f8f9fa">
<div style="padding:24px">stand-in for the Google Slides editor</div>
</body></html>`;

async function poll<TValue>({
  what,
  read,
  done,
  deadlineMs,
}: {
  what: string;
  read: () => Promise<TValue>;
  done: (value: TValue) => boolean;
  deadlineMs: number;
}): Promise<TValue> {
  const startedAt = Date.now();
  let last: TValue | null = null;
  // Poll for the observable condition rather than sleeping: a CDP round trip is milliseconds, so a
  // failure here is a diagnosis within a second of the real deadline, not a fixed 30 s wait.
  while (Date.now() - startedAt < deadlineMs) {
    last = await read();
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out after ${Math.round((Date.now() - startedAt) / 1000)}s waiting for ${what}; last saw ${JSON.stringify(last)}`);
}

function unwrap(outcome: Readonly<{ kind: string }>): unknown {
  if (outcome.kind !== "ok") throw new Error(`the fake Drive refused: ${JSON.stringify(outcome)}`);
  return (outcome as unknown as Readonly<{ value: unknown }>).value;
}

function report(what: string, detail: string): void {
  console.log(`${what.padEnd(28)} ${detail}`);
}

function expect(condition: boolean, what: string): void {
  if (!condition) throw new Error(`smoke.e2e.ts: ${what} -- FAILED`);
}

// Invoked last, not first: the module-level `const`s below `main` are evaluated in source order, so
// calling it at the top would read them inside their temporal dead zone.
await main();
