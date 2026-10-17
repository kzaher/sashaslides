// THE DEVELOPER PAGE IN A REAL BROWSER (no Google): starts this site on a free port, opens /dev in
// a NEW WINDOW of the headless Chrome on :9222, and checks what a person sees:
//
//   1. the page renders, and with the connector answering 401 for GET /deck-api/session (answered
//      by CDP's Fetch domain, as the connector would) it shows "Sign in" to /account/deck-session?return=/dev
//   2. pasting the draw.io demo slide queues it, previews it in a sandboxed 1280x720 frame, and the
//      product converter reports requests, elements and warnings
//   3. further fixtures convert one after another, and the warnings view lists the converter's
//      sentences with numbered overlay boxes on the preview
//   4. "Download .pptx" loads the offline bundle (our pptxgenjs fork) and saves a real .pptx (a zip)
//
//   npm run smoke [-- --shots <directory>]      (from addon-server; needs `npm run build` first)
//
// Total runtime is under 90 s; each wait polls observable state with its own short budget.

import CDPDefault from "chrome-remote-interface";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CDP_PORT = 9222;
const SITE_DIR = resolve(import.meta.dirname, "..");
const REPOSITORY_ROOT = resolve(SITE_DIR, "../../..");
const DRAWIO_DEMO = join(REPOSITORY_ROOT, "renderer/html2slides/e2e/drawio-demo/safety-pipeline.html");
const FIXTURES = ["page_gradient.html", "table_row_fill.html", "svg_inline.html"].map((name) => join(REPOSITORY_ROOT, "mcp/sasha-slides/converter/test/fixtures", name));
const SIGNED_OUT_BODY = JSON.stringify({ error: "signedOut", message: "Sign in to continue.", signInAddress: "/account/deck-session?return=%2Fdecks", connectAddress: null, retryAfterSeconds: null });

type Check = Readonly<{ name: string; passed: boolean; detail: string }>;

async function main(): Promise<void> {
  const shotsDirectory = argumentAfter("--shots");
  if (shotsDirectory !== null) mkdirSync(shotsDirectory, { recursive: true });
  for (const built of ["dev.js", "dev-pptx.js"]) {
    if (!existsSync(join(SITE_DIR, "public", built))) throw new Error(`public/${built} is missing: run npm run build first`);
  }
  const port = await freePort();
  const site = startSite(port);
  const checks: Check[] = [];
  const check = (name: string, passed: boolean, detail: string): void => {
    checks.push({ name, passed, detail });
    process.stdout.write(`${passed ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `: ${detail}`}\n`);
  };
  const browser = await CDP({ port: CDP_PORT, target: (await CDP.Version({ port: CDP_PORT })).webSocketDebuggerUrl });
  const downloads = mkdtempSync(join(tmpdir(), "dev-page-smoke-"));
  let targetId: string | null = null;
  try {
    await waitFor({ what: "the site to answer /healthz", budgetMilliseconds: 8000, probe: async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.ok === true });
    await browser.Browser.setDownloadBehavior({ behavior: "allow", downloadPath: downloads });
    targetId = (await browser.Target.createTarget({ url: "about:blank", newWindow: true })).targetId;
    const page = await CDP({ port: CDP_PORT, target: targetId });
    try {
      await runPage({ page, port, check, shotsDirectory, downloads });
    } finally {
      await page.close();
    }
  } finally {
    if (targetId !== null) await browser.Target.closeTarget({ targetId }).catch(() => undefined);
    await browser.close();
    site.kill();
  }
  const failed = checks.filter((entry) => !entry.passed);
  process.stdout.write(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILURE(S)`} (${checks.length} checks)\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

async function runPage(
  options: Readonly<{ page: CdpClient; port: number; check: (name: string, passed: boolean, detail: string) => void; shotsDirectory: string | null; downloads: string }>,
): Promise<void> {
  const { page, check } = options;
  await page.Page.enable();
  await page.Runtime.enable();
  await page.Emulation.setDeviceMetricsOverride({ width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  // The local site has no connector: answer GET /deck-api/session as the connector does when signed out.
  await page.Fetch.enable({ patterns: [{ urlPattern: "*/deck-api/*", requestStage: "Request" }] });
  page.on("Fetch.requestPaused", (event) => {
    const { requestId } = event as Readonly<{ requestId: string }>;
    void page.Fetch.fulfillRequest({
      requestId,
      responseCode: 401,
      responseHeaders: [{ name: "Content-Type", value: "application/json" }],
      body: Buffer.from(SIGNED_OUT_BODY).toString("base64"),
    });
  });

  const loaded = page.Page.loadEventFired();
  await page.Page.navigate({ url: `http://127.0.0.1:${options.port}/dev` });
  await loaded;

  const session = await waitForValue({
    what: "the session badge",
    budgetMilliseconds: 5000,
    probe: () => evaluate(page, `(() => { const badge = document.querySelector("[data-session]"); return badge && badge.dataset.session !== "checking" ? badge.dataset.session + "|" + (badge.querySelector("a")?.getAttribute("href") ?? "") : null; })()`),
  });
  check("signed out: the page offers Sign in that returns to /dev", session === "signed-out|/account/deck-session?return=%2Fdev", String(session));
  const disabled = await evaluate(page, `[document.querySelector("#insert")?.disabled, document.querySelector("#export")?.disabled].join(",")`);
  check("signed out: insert and export are disabled", disabled === "true,true", String(disabled));
  await screenshot({ page, shotsDirectory: options.shotsDirectory, name: "01-empty.png" });

  await pasteDocument({ page, html: readFileSync(DRAWIO_DEMO, "utf8") });
  const demo = await waitForConversion({ page, itemId: "item-1" });
  check("the draw.io demo is previewed in a sandboxed 1280x720 frame", demo.frame === "|1280|720|true", demo.frame);
  check("the draw.io demo converts: requests and elements counted", demo.requests > 0 && demo.elements > 0, `${demo.requests} requests from ${demo.elements} elements, ${demo.warnings} warnings, ${demo.overlays} overlay boxes`);
  check("each warning is listed and drawn over the preview", demo.warnings === demo.overlays, `${demo.warnings} listed, ${demo.overlays} drawn`);
  await screenshot({ page, shotsDirectory: options.shotsDirectory, name: "02-drawio-demo.png" });

  for (const fixture of FIXTURES) await pasteDocument({ page, html: readFileSync(fixture, "utf8") });
  const results = [];
  for (let index = 0; index < FIXTURES.length; index++) results.push(await waitForConversion({ page, itemId: `item-${index + 2}` }));
  check(
    "the fixtures queue and convert one after another",
    results.every((result) => result.requests > 0),
    results.map((result, index) => `${FIXTURES[index]?.split("/").pop()}: ${result.requests} requests, ${result.warnings} warnings`).join("; "),
  );
  const withWarnings = results.findIndex((result) => result.warnings > 0);
  if (withWarnings >= 0) {
    await evaluate(page, `document.querySelector('[data-item="item-${withWarnings + 2}"] .queue-name').click(); true`);
    const shown = await waitForConversion({ page, itemId: `item-${withWarnings + 2}` });
    const sentence = await evaluate(page, `document.querySelector("#warnings li")?.textContent ?? ""`);
    check("the warnings view shows the converter's sentence for the selected item", shown.warnings > 0 && String(sentence).length > 20, String(sentence).slice(0, 120));
    await evaluate(page, `document.querySelector(".preview-card").scrollIntoView({ block: "start" }); true`);
    await screenshot({ page, shotsDirectory: options.shotsDirectory, name: "03-warnings.png" });
  } else {
    check("a fixture with warnings exists for the warnings view", false, "no fixture produced a warning");
  }
  const summary = await evaluate(page, `document.querySelector("#queue-summary")?.textContent ?? ""`);
  check("the queue summary counts every item", String(summary).startsWith(`${FIXTURES.length + 1} in the queue: ${FIXTURES.length + 1} converted`), String(summary));

  await evaluate(page, `document.querySelector("#download-pptx").click(); true`);
  const saved = await waitForValue({
    what: "the .pptx download",
    budgetMilliseconds: 30000,
    probe: async () => {
      const failure = await evaluate(page, `document.querySelector(".card[aria-label='Download .pptx'] .error")?.textContent ?? ""`);
      if (String(failure) !== "") return `failed: ${String(failure)}`;
      const file = readdirSync(options.downloads).find((name) => name.endsWith(".pptx"));
      return file === undefined ? null : file;
    },
  });
  const pptxPath = join(options.downloads, String(saved));
  const isZip = existsSync(pptxPath) && readFileSync(pptxPath).subarray(0, 2).toString("latin1") === "PK";
  check("Download .pptx saves a real .pptx (a zip) through the fork bundle", isZip, `${String(saved)}${isZip ? `, ${readFileSync(pptxPath).byteLength.toLocaleString()} bytes` : ""}`);

  // A pasted document must not run on this origin (inert-html.ts): its script, its handler and its
  // nested frame all try to set a flag on the page.
  const hostile = [
    '<!doctype html><html><body><div id="slide" style="width:1280px;height:720px">',
    '<script>parent.__devPagePwned = "script";</script>',
    `<img src="data:," onerror="parent.__devPagePwned = 'handler'">`,
    `<iframe srcdoc="<script>parent.parent.__devPagePwned = 'frame'</script>"></iframe>`,
    "<p>inert</p></div></body></html>",
  ].join("");
  await pasteDocument({ page, html: hostile });
  await waitForConversion({ page, itemId: `item-${FIXTURES.length + 2}` });
  const pwned = String(await evaluate(page, `String(window.__devPagePwned ?? "")`));
  check("a pasted document's scripts, handlers and frames do not run on this origin", pwned === "", pwned === "" ? "flag unset" : `flag set by ${pwned}`);
}

type ConversionView = Readonly<{ requests: number; elements: number; warnings: number; overlays: number; frame: string }>;

async function waitForConversion(options: Readonly<{ page: CdpClient; itemId: string }>): Promise<ConversionView> {
  const raw = await waitForValue({
    what: `the conversion of ${options.itemId}`,
    budgetMilliseconds: 25000,
    probe: () =>
      evaluate(
        options.page,
        `(() => {
          const item = document.querySelector('[data-item="${options.itemId}"]');
          if (!item) return null;
          const status = item.querySelector(".status");
          if (status && status.classList.contains("status-failed")) return JSON.stringify({ failed: document.querySelector(".preview-card .error")?.textContent ?? "failed" });
          if (!item.classList.contains("selected")) item.querySelector(".queue-name").click();
          const conversion = document.querySelector("#conversion");
          if (!item.classList.contains("selected") || !conversion || !status.classList.contains("status-converted")) return null;
          const frame = document.querySelector(".preview iframe");
          return JSON.stringify({
            requests: Number(conversion.querySelector('[data-count="requests"]').textContent),
            elements: Number(conversion.querySelector('[data-count="elements"]').textContent),
            warnings: document.querySelectorAll("#warnings li").length,
            overlays: document.querySelectorAll(".preview .mark").length,
            frame: [frame.getAttribute("sandbox"), frame.getAttribute("width"), frame.getAttribute("height"), frame.hasAttribute("srcdoc")].join("|"),
          });
        })()`,
      ),
  });
  // The page serialised exactly these fields just above.
  const parsed = JSON.parse(String(raw)) as ConversionView & Readonly<{ failed?: string }>;
  if (parsed.failed !== undefined) throw new Error(`${options.itemId} failed to convert: ${parsed.failed}`);
  return parsed;
}

/** Types into the paste box the way a person does (an input event Preact hears), then adds it. */
async function pasteDocument(options: Readonly<{ page: CdpClient; html: string }>): Promise<void> {
  await evaluate(
    options.page,
    `(() => {
      const box = document.querySelector("#paste-html");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, ${JSON.stringify(options.html)});
      box.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
  );
  await waitFor({ what: "the Add button to enable", budgetMilliseconds: 2000, probe: async () => (await evaluate(options.page, `document.querySelector("#add-pasted").disabled === false`)) === true });
  await evaluate(options.page, `document.querySelector("#add-pasted").click(); true`);
}

async function screenshot(options: Readonly<{ page: CdpClient; shotsDirectory: string | null; name: string }>): Promise<void> {
  if (options.shotsDirectory === null) return;
  // Two frames, so the last render is painted before the capture.
  await evaluate(options.page, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  const { data } = await options.page.Page.captureScreenshot({ format: "png" });
  writeFileSync(join(options.shotsDirectory, options.name), Buffer.from(data, "base64"));
}

async function evaluate(page: CdpClient, expression: string): Promise<unknown> {
  const response = await page.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails !== undefined) throw new Error(`page threw: ${response.exceptionDetails.text} ${response.exceptionDetails.exception?.description ?? ""}`);
  return response.result.value;
}

async function waitFor(options: Readonly<{ what: string; budgetMilliseconds: number; probe: () => Promise<boolean> }>): Promise<void> {
  await waitForValue({ what: options.what, budgetMilliseconds: options.budgetMilliseconds, probe: async () => ((await options.probe()) ? true : null) });
}

/** Polls every 100 ms until the probe returns something other than null, or fails at the budget. */
async function waitForValue(options: Readonly<{ what: string; budgetMilliseconds: number; probe: () => Promise<unknown> }>): Promise<unknown> {
  const deadline = Date.now() + options.budgetMilliseconds;
  for (;;) {
    const value = await options.probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${options.budgetMilliseconds} ms waiting for ${options.what}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

function startSite(port: number): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], { cwd: SITE_DIR, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[site] ${chunk.toString()}`));
  return child;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

function argumentAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

// chrome-remote-interface ships no types (types/ambient.d.ts declares its default export unknown);
// this is the narrow slice of its documented runtime surface the smoke test uses.
type CdpClient = Readonly<{
  Page: Readonly<{
    enable(): Promise<unknown>;
    navigate(parameters: Readonly<{ url: string }>): Promise<unknown>;
    loadEventFired(): Promise<unknown>;
    captureScreenshot(parameters: Readonly<{ format: "png" }>): Promise<Readonly<{ data: string }>>;
  }>;
  Runtime: Readonly<{
    enable(): Promise<unknown>;
    evaluate(
      parameters: Readonly<{ expression: string; returnByValue: boolean; awaitPromise: boolean }>,
    ): Promise<Readonly<{ result: Readonly<{ value?: unknown }>; exceptionDetails?: Readonly<{ text: string; exception?: Readonly<{ description?: string }> }> }>>;
  }>;
  Emulation: Readonly<{ setDeviceMetricsOverride(parameters: Readonly<{ width: number; height: number; deviceScaleFactor: number; mobile: boolean }>): Promise<unknown> }>;
  Fetch: Readonly<{
    enable(parameters: Readonly<{ patterns: readonly Readonly<{ urlPattern: string; requestStage: "Request" }>[] }>): Promise<unknown>;
    fulfillRequest(
      parameters: Readonly<{ requestId: string; responseCode: number; responseHeaders: readonly Readonly<{ name: string; value: string }>[]; body: string }>,
    ): Promise<unknown>;
  }>;
  Browser: Readonly<{ setDownloadBehavior(parameters: Readonly<{ behavior: "allow"; downloadPath: string }>): Promise<unknown> }>;
  Target: Readonly<{
    createTarget(parameters: Readonly<{ url: string; newWindow: boolean }>): Promise<Readonly<{ targetId: string }>>;
    closeTarget(parameters: Readonly<{ targetId: string }>): Promise<unknown>;
  }>;
  on(event: string, listener: (parameters: unknown) => void): void;
  close(): Promise<void>;
}>;
type CdpModule = ((options: Readonly<{ port: number; target: string }>) => Promise<CdpClient>) &
  Readonly<{ Version(options: Readonly<{ port: number }>): Promise<Readonly<{ webSocketDebuggerUrl: string }>> }>;
// The module's default export is callable with `Version` attached, as documented by
// chrome-remote-interface; the ambient declaration only types it `unknown`.
const CDP = CDPDefault as CdpModule;

main().catch((error: unknown) => {
  process.stderr.write(`FATAL: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
