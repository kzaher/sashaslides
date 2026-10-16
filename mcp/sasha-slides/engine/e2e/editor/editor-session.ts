// THE EDITOR'S END-TO-END PLUMBING: bundle the chrome harness, serve it on an ephemeral port, and
// drive Chrome over the DevTools Protocol on 127.0.0.1:9223 -- one fresh tab per scenario, closed
// afterwards. Timeouts are seconds and every wait polls observable page state (the project's rules):
// a step that does not answer in a couple of seconds is reported, never waited out.
//
// CDP gotchas this follows (CLAUDE.md): open a BLANK tab and navigate it (`CDP.New({ url })` cuts
// the address at the first "&"), and subscribe to `Page.loadEventFired` BEFORE navigating.

import CDP, { type Client } from "chrome-remote-interface";
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { editorPageMarkup, editorStylesheet } from "../../src/view/application/editor-page.ts";

export const CHROME = { host: "127.0.0.1", port: 9223 } as const;
export const VIEWPORT = { width: 1440, height: 900 } as const;

const ENGINE_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));

/** Bundles the harness into `directory` (index.html, editor.css, harness.js). */
export async function buildHarness(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await build({
    entryPoints: [join(ENGINE_DIRECTORY, "e2e/editor/harness-entry.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: join(directory, "harness.js"),
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  await writeFile(join(directory, "editor.css"), editorStylesheet());
  await writeFile(join(directory, "index.html"), editorPageMarkup({ title: "Sasha editor harness", stylesheetPath: "editor.css", scriptPath: "harness.js", configuration: {} }));
}

export type StaticServer = AsyncDisposable & Readonly<{ address: string }>;

/** Serves `directory` on 127.0.0.1 at an ephemeral port until disposed. */
export async function serveDirectory(directory: string): Promise<StaticServer> {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/")).replace(/^(\.\.[/\\])+/, "");
    const file = join(directory, path === "/" ? "index.html" : path);
    readFile(file).then(
      (bytes) => {
        response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
        response.end(bytes);
      },
      () => {
        response.writeHead(404);
        response.end();
      },
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    address: `http://127.0.0.1:${port}/`,
    // Chrome keeps its connections alive, and `close` waits for them: drop them first, or the driver never exits.
    [Symbol.asyncDispose]: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export type PageOptions = Readonly<{ address: string; scheme: "light" | "dark"; reducedMotion: boolean; viewport?: Readonly<{ width: number; height: number }> }>;

/** Opens `address` in a fresh tab (1440 x 900 unless told otherwise) with the given media, runs `body`, closes the tab. */
export async function withPage<TResult>(options: PageOptions, body: (client: Client) => Promise<TResult>): Promise<TResult> {
  const target = await CDP.New({ ...CHROME });
  const client = await CDP({ ...CHROME, target: target.id });
  try {
    await client.Page.enable();
    await client.Runtime.enable();
    const viewport = options.viewport ?? VIEWPORT;
    await client.Emulation.setDeviceMetricsOverride({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false });
    await client.Emulation.setEmulatedMedia({
      features: [
        { name: "prefers-color-scheme", value: options.scheme },
        { name: "prefers-reduced-motion", value: options.reducedMotion ? "reduce" : "no-preference" },
      ],
    });
    const loaded = client.Page.loadEventFired();
    await client.Page.navigate({ url: options.address });
    await withTimeout({ promise: loaded, milliseconds: 8000, label: `load ${options.address}` });
    await client.Page.bringToFront();
    return await body(client);
  } finally {
    await client.close().catch(() => undefined);
    await CDP.Close({ ...CHROME, id: target.id }).catch(() => undefined);
  }
}

/** Evaluates `expression` in the page and returns its value (JSON-serialisable). */
export async function evaluate(client: Client, expression: string): Promise<unknown> {
  const outcome = await client.Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  if (outcome.exceptionDetails !== undefined) throw new Error(`Page threw: ${outcome.exceptionDetails.exception?.description ?? outcome.exceptionDetails.text}`);
  return outcome.result.value;
}

/** Polls `expression` every 100 milliseconds until it is truthy; fails after `milliseconds`. */
export async function waitFor(client: Client, expression: string, milliseconds = 4000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if ((await evaluate(client, `Boolean(${expression})`)) === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${milliseconds} milliseconds waiting for ${expression}`);
}

/** The page as a PNG at `path`. */
export async function screenshot(client: Client, path: string): Promise<void> {
  const shot = await client.Page.captureScreenshot({ format: "png" });
  await writeFile(path, Buffer.from(shot.data, "base64"));
}

/** Ready: the slide is drawn and the fonts have loaded (or two seconds passed). */
export const READY_EXPRESSION = `document.querySelector("[data-sasha-slide-id]") !== null && window.sashaHarness !== undefined`;

export async function settle(client: Client): Promise<void> {
  await waitFor(client, READY_EXPRESSION);
  await evaluate(client, `Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]).then(() => true)`);
  // Finite animations (a menu popping in) finish before the shot; the calm wash runs forever.
  await evaluate(client, `Promise.race([Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))), new Promise((resolve) => setTimeout(resolve, 1500))]).then(() => true)`);
  await evaluate(client, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
}

function withTimeout<TValue>(options: Readonly<{ promise: Promise<TValue>; milliseconds: number; label: string }>): Promise<TValue> {
  return new Promise<TValue>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${options.label}`)), options.milliseconds);
    options.promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
