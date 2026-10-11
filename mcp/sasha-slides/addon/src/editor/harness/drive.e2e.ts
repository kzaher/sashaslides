// DRIVE THE HARNESS WITH A REAL BROWSER. Chrome on :9222, real mouse and key events, screenshots.
//
//   cd mcp/sasha-slides/addon && node --import tsx src/editor/harness/drive.e2e.ts [--out DIR]
//   (about 10 s; the repo's command budget is 30 s)
//
// NEVER :9223 -- a signed-in session lives there and this must not touch it.
//
// WHAT ONLY THIS CAN CATCH. The unit tests cover the record algebra, the selector rules and the
// refusals, all without a DOM. None of them can see whether a click actually selects anything,
// whether a drag of the selection box moves the element under it, or whether `html()` re-renders
// to the same pixels -- "an automated click that produces no visible handle" is exactly the failure
// this exists to make loud. Every gesture below is a browser-level input event, not a synthetic
// `element.click()`; the one exception is the native `<input type="color">`, which no synthetic
// input can open, so its value is set and its `input`/`change` events dispatched.
//
// It fails loudly: any step that does not reach its observable state is reported and the process
// exits non-zero.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import CDPraw from "chrome-remote-interface";
import type { CdpClient, CdpInput, CdpModule } from "../../../../../../types/cdp-types.ts";

// SAFETY: types/ambient.d.ts declares the module's default export as `unknown` (the package ships
// no .d.ts) and types/cdp-types.ts is this repo's hand-written shape for it. Same single narrowing
// point as e2e/cdp-page.ts and src/smoke.e2e.ts.
const CDP = CDPraw as unknown as CdpModule;

/**
 * `Input.insertText` and `Page.captureScreenshot`'s `fromSurface` are real CDP methods that
 * types/cdp-types.ts does not declare, and that file is outside this module. The structural
 * extension is the narrowing: documented here, local to the driver, and checked by the compiler.
 */
type TypingInput = CdpInput & Readonly<{ insertText(params: Readonly<{ text: string }>): Promise<void> }>;
type HarnessClient = CdpClient & Readonly<{ Input: TypingInput }>;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../../../../e2e/fixtures");
const CDP_PORT = 9222;
const PORT = 7341;
const POLL_MS = 100;
const POLL_BUDGET_MS = 2_000;

type Point = Readonly<{ x: number; y: number }>;

async function main(): Promise<void> {
  const outDir = outDirOf(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });
  const bundle = await bundleHarness();
  const server = await listen(bundle);
  const failures: string[] = [];
  const shots: string[] = [];
  const tab = await CDP.New({ port: CDP_PORT, url: `http://127.0.0.1:${PORT}/harness.html` });
  let client: HarnessClient | null = null;
  try {
    // SAFETY: the connect call returns a CdpClient; `TypingInput` only adds methods the protocol
    // documents on the same domain object, so the structural widening cannot be wrong at runtime.
    client = (await CDP({ target: tab, port: CDP_PORT })) as HarnessClient;
    const { Page, Runtime, Emulation } = client;
    await Page.enable();
    await Runtime.enable();
    await Emulation.setDeviceMetricsOverride({ width: 1420, height: 960, deviceScaleFactor: 1, mobile: false });
    const thrown: string[] = [];
    client.on("Runtime.exceptionThrown", (params: unknown) => thrown.push(JSON.stringify(params).slice(0, 300)));

    await expectTrue({ client, failures, what: "the harness mounted and auto-loaded 01-text", expression: "window.sashaHarness !== undefined && window.sashaHarness.state().attached" });

    // --- 01-text: select, move, resize, recolour, retext, round-trip, undo -------------------
    // The RULE first: once `h1` has been dragged down it covers the rule, and a click would then
    // correctly hit the h1 -- an ordering trap the first run of this driver walked straight into.
    await selectInFrame({ client, failures, selector: "div.rule", expect: "div.rule" });
    shots.push(await shoot({ client, outDir, name: "01-selected-rule" }));
    const seHandle = await handleCentre({ client, edge: "se" });
    await drag({ client, from: seHandle, by: { x: 220 * 0.7, y: 24 * 0.7 } });
    await expectTrue({
      client,
      failures,
      what: "dragging the SE handle records a `resized` that grew the element",
      expression: `(() => { const r = window.sashaHarness.edits().filter((x) => x.kind === "resized").pop(); return r !== undefined && r.to.w > r.from.w + 0.1 && r.to.h > r.from.h; })()`,
    });
    await evaluate({ client, failures, expression: `window.sashaHarness.setColour({ which: "background", value: "#137333" })` });
    await expectTrue({
      client,
      failures,
      what: "the background swatch records one `recoloured`",
      expression: `(() => { const c = window.sashaHarness.edits().filter((x) => x.kind === "recoloured").pop(); return c !== undefined && c.property === "background" && c.to === "#137333"; })()`,
    });
    shots.push(await shoot({ client, outDir, name: "02-resized-recoloured-rule" }));

    await selectInFrame({ client, failures, selector: "h1", expect: "h1" });
    const moveFrom = await handleCentre({ client, edge: null });
    await drag({ client, from: moveFrom, by: { x: 0, y: 80 * 0.7 } });
    await expectTrue({
      client,
      failures,
      what: "dragging the selection box records one `moved` with the measured destination",
      expression: `(() => { const e = window.sashaHarness.edits(); const m = e.find((x) => x.kind === "moved"); return m !== undefined && Math.abs(m.to.y - (m.from.y + 80 / 720)) < 0.004; })()`,
    });
    shots.push(await shoot({ client, outDir, name: "03-moved-h1" }));

    await selectInFrame({ client, failures, selector: "h2", expect: "h2" });
    await doubleClick({ client, at: await handleCentre({ client, edge: null }) });
    await expectTrue({ client, failures, what: "a double click opens in-place text editing", expression: `!!document.querySelector("#slide").contentDocument.querySelector("[data-sasha-editing]")` });
    await client.Input.insertText({ text: "Why the model never reads the slide back AT ALL" });
    await pressEnter({ client });
    await expectTrue({
      client,
      failures,
      what: "typing in place records one `retext` carrying the typed words",
      expression: `(() => { const t = window.sashaHarness.edits().filter((x) => x.kind === "retext").pop(); return t !== undefined && t.to.endsWith("AT ALL"); })()`,
    });
    shots.push(await shoot({ client, outDir, name: "04-retexted-h2" }));

    await expectTrue({
      client,
      failures,
      what: "html() is the candidate's own document, with no trace of the editor in it",
      expression: `(() => {
        const html = window.sashaHarness.html();
        return html.toLowerCase().startsWith("<!doctype html>") && !html.includes("sasha-ed") && !html.includes("data-sasha-editing") && !html.includes("contenteditable");
      })()`,
    });
    process.stdout.write(
      "\nhtml() head: " +
        (await evaluateString({ client, expression: `window.sashaHarness.html().slice(0, 120).split(String.fromCharCode(10)).join(" ")` })) +
        "\nhtml() h1:   " +
        (await evaluateString({ client, expression: `(window.sashaHarness.html().match(/<h1[^>]*>/) ?? [""])[0]` })) +
        "\n\n",
    );
    await roundTrip({ client, failures, label: "01-text" });
    shots.push(await shoot({ client, outDir, name: "05-roundtrip-01" }));

    const before = await evaluateNumber({ client, expression: "window.sashaHarness.edits().length" });
    await expectTrue({ client, failures, what: "undo steps back one record", expression: `window.sashaHarness.undo() === true && window.sashaHarness.edits().length === ${before - 1}` });

    // --- the other three candidates: a table cell, an image, a gradient card ------------------
    for (const probe of OTHER_PROBES) {
      await evaluate({ client, failures, expression: `window.sashaHarness.load("${probe.fixture}")`, awaitPromise: true });
      await expectTrue({ client, failures, what: `${probe.fixture} attached`, expression: "window.sashaHarness.state().attached" });
      await selectInFrame({ client, failures, selector: probe.selector, expect: probe.target });
      await drag({ client, from: await handleCentre({ client, edge: null }), by: { x: 40 * 0.7, y: 30 * 0.7 } });
      await expectTrue({
        client,
        failures,
        what: `${probe.fixture}: the move was recorded`,
        expression: `window.sashaHarness.edits().some((x) => x.kind === "moved")`,
      });
      await roundTrip({ client, failures, label: probe.fixture });
      shots.push(await shoot({ client, outDir, name: `06-${probe.fixture.slice(0, 2)}-moved` }));
    }

    // --- a refusal must be a warning, never an approximation ---------------------------------
    await evaluate({ client, failures, expression: `window.sashaHarness.load("01-text.html")`, awaitPromise: true });
    await selectInFrame({ client, failures, selector: "span.small-caps", expect: "span.small-caps" });
    await drag({ client, from: await handleCentre({ client, edge: null }), by: { x: 60, y: 0 } });
    await expectTrue({
      client,
      failures,
      what: "moving a non-replaced inline element is refused with a warning and records nothing",
      expression: `window.sashaHarness.edits().length === 0 && window.sashaHarness.warnings().some((w) => w.includes("dropped a move"))`,
    });
    shots.push(await shoot({ client, outDir, name: "07-refused-inline-move" }));

    // --- undo puts back markup a retext flattened --------------------------------------------
    await evaluate({ client, failures, expression: `window.sashaHarness.load("01-text.html")`, awaitPromise: true });
    await selectInFrame({ client, failures, selector: "h1", expect: "h1" });
    await doubleClick({ client, at: await handleCentre({ client, edge: null }) });
    await client.Input.insertText({ text: "Paths in, ids out, plainly" });
    await pressEnter({ client });
    await expectTrue({
      client,
      failures,
      what: "retexting a heading flattens the <em> inside it, as the plain-text record implies",
      expression: `document.querySelector("#slide").contentDocument.querySelectorAll("h1 em").length === 0`,
    });
    await expectTrue({
      client,
      failures,
      what: "undo puts the heading's original markup back, <em> and all",
      expression: `(() => {
        const undone = window.sashaHarness.undo();
        const d = document.querySelector("#slide").contentDocument;
        return undone && d.querySelectorAll("h1 em").length === 1 && d.querySelector("h1 em").textContent === "ids out";
      })()`,
    });

    // --- detach leaves the slide edited and the host clean ----------------------------------
    await selectInFrame({ client, failures, selector: "h1", expect: "h1" });
    await drag({ client, from: await handleCentre({ client, edge: null }), by: { x: 0, y: 50 * 0.7 } });
    const movedTo = await evaluateString({
      client,
      expression: `document.querySelector("#slide").contentDocument.querySelector("h1").getAttribute("style")`,
    });
    await evaluate({ client, failures, expression: "window.sashaHarness.detachEditor()" });
    await expectTrue({
      client,
      failures,
      what: "detach removes every overlay and the injected stylesheet from the host document",
      expression: `document.querySelectorAll(".sasha-ed-root").length === 0 && document.getElementById("sasha-ed-styles") === null`,
    });
    await expectTrue({
      client,
      failures,
      what: "detach leaves the user's edit on the slide, and nothing of the editor's inside the frame",
      expression: `(() => {
        const d = document.querySelector("#slide").contentDocument;
        return d.querySelector("h1").getAttribute("style") === ${JSON.stringify(movedTo)} && d.querySelectorAll("[data-sasha-editing], [contenteditable]").length === 0;
      })()`,
    });
    await realClick({ client, at: (await pointInFrame({ client, selector: "h1" })) ?? { x: 0, y: 0 } });
    await expectTrue({
      client,
      failures,
      what: "after detach a click on the candidate selects nothing: the listeners are gone too",
      expression: `document.querySelector(".sasha-ed-select") === null`,
    });
    shots.push(await shoot({ client, outDir, name: "08-detached" }));

    // --- the host handing over an unreachable frame must be said out loud ---------------------
    await evaluate({ client, failures, expression: `document.querySelector("#slide").setAttribute("sandbox", "")` });
    await evaluate({ client, failures, expression: `window.sashaHarness.load("01-text.html")`, awaitPromise: true });
    await expectTrue({
      client,
      failures,
      what: 'a sandbox="" frame cannot be edited, and the editor says so instead of going quiet',
      expression: `window.sashaHarness.warnings().some((w) => w.includes("allow-same-origin"))`,
    });

    if (thrown.length > 0) failures.push(`the page threw: ${thrown.join(" | ")}`);
  } finally {
    await client?.close();
    await CDP.Close({ port: CDP_PORT, id: tab.id }).catch(() => undefined);
    await new Promise<void>((done) => server.close(() => done()));
  }

  process.stdout.write(`\nscreenshots:\n${shots.map((path) => `  ${path}`).join("\n")}\n`);
  if (failures.length > 0) {
    process.stdout.write(`\nFAILED (${failures.length}):\n${failures.map((line) => `  - ${line}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\nall harness checks passed\n");
}

const OTHER_PROBES: readonly Readonly<{ fixture: string; selector: string; target: string }>[] = [
  // `target` is the selector the editor is EXPECTED to invent for the clicked element -- the
  // readability of these three strings is half of what this driver is checking.
  { fixture: "02-table.html", selector: "td.flag", target: "td.flag:nth-of-type(2)" },
  { fixture: "03-image.html", selector: "img", target: "img" },
  { fixture: "04-gradient-shadow.html", selector: ".cards .card:nth-of-type(2) h2", target: "div.card:nth-of-type(2) h2" },
];

/** A real press on the centre of an element INSIDE the candidate frame, then its selected target. */
async function selectInFrame({
  client,
  failures,
  selector,
  expect,
}: {
  client: HarnessClient;
  failures: string[];
  selector: string;
  expect: string;
}): Promise<void> {
  const at = await pointInFrame({ client, selector });
  if (at === null) {
    failures.push(`could not find ${selector} inside the candidate frame`);
    return;
  }
  await realClick({ client, at });
  const selected = await evaluateString({ client, expression: "String(window.sashaHarness.state().selected)" });
  if (selected !== expect) failures.push(`clicking ${selector} selected ${selected}, expected ${expect}`);
}

async function roundTrip({ client, failures, label }: { client: HarnessClient; failures: string[]; label: string }): Promise<void> {
  const report = await evaluateString({
    client,
    expression: `window.sashaHarness.roundTrip().then((r) => JSON.stringify(r.checks))`,
    awaitPromise: true,
  });
  const parsed: unknown = JSON.parse(report);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    failures.push(`${label}: the round-trip check produced nothing`);
    return;
  }
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const check = entry as Readonly<{ what?: unknown; ok?: unknown; detail?: unknown }>;
    const line = `${String(check.what)} (${String(check.detail)})`;
    if (check.ok === true) process.stdout.write(`  ok   ${label}: ${line}\n`);
    else failures.push(`${label} round-trip: ${line}`);
  }
}

/** The centre of the selection box, or of one of its handles: both are HOST elements. */
async function handleCentre({ client, edge }: { client: HarnessClient; edge: string | null }): Promise<Point> {
  const selector = edge === null ? ".sasha-ed-select" : `.sasha-ed-handle[data-edge="${edge}"]`;
  const json = await evaluateString({
    client,
    expression: `(() => { const n = document.querySelector('${selector}'); if (n === null) return "null"; const b = n.getBoundingClientRect(); return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2 }); })()`,
  });
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) throw new Error(`no ${selector} on the page: nothing is selected`);
  const point = parsed as Readonly<{ x?: unknown; y?: unknown }>;
  if (typeof point.x !== "number" || typeof point.y !== "number") throw new Error(`${selector} has no rect`);
  return { x: point.x, y: point.y };
}

/** Viewport point over the centre of an element inside the candidate, via the frame's own rect. */
async function pointInFrame({ client, selector }: { client: HarnessClient; selector: string }): Promise<Point | null> {
  const json = await evaluateString({
    client,
    expression: `(() => {
      const frame = document.querySelector("#slide");
      const inner = frame.contentDocument.querySelector(${JSON.stringify(selector)});
      if (inner === null) return "null";
      const r = frame.getBoundingClientRect();
      const b = inner.getBoundingClientRect();
      return JSON.stringify({ x: r.left + (b.left + b.width / 2) / 1280 * r.width, y: r.top + (b.top + b.height / 2) / 720 * r.height });
    })()`,
  });
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null) return null;
  const point = parsed as Readonly<{ x?: unknown; y?: unknown }>;
  return typeof point.x === "number" && typeof point.y === "number" ? { x: point.x, y: point.y } : null;
}

async function realClick({ client, at }: { client: HarnessClient; at: Point }): Promise<void> {
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: at.x, y: at.y });
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
}

async function doubleClick({ client, at }: { client: HarnessClient; at: Point }): Promise<void> {
  await realClick({ client, at });
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 2 });
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 2 });
}

/** Press, three moves (so `pointermove` previews are exercised), release. */
async function drag({ client, from, by }: { client: HarnessClient; from: Point; by: Point }): Promise<void> {
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: from.x, y: from.y });
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
  for (const step of [0.4, 0.75, 1]) {
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: from.x + by.x * step, y: from.y + by.y * step, button: "left" });
  }
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: from.x + by.x, y: from.y + by.y, button: "left", clickCount: 1 });
}

async function pressEnter({ client }: { client: HarnessClient }): Promise<void> {
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

async function shoot({ client, outDir, name }: { client: HarnessClient; outDir: string; name: string }): Promise<string> {
  const { data } = await client.Page.captureScreenshot({ format: "png" });
  const path = join(outDir, `${name}.png`);
  writeFileSync(path, Buffer.from(data, "base64"));
  return path;
}

/** Poll an expression to true within a short budget: an operation that stalls is a diagnosis. */
async function expectTrue({
  client,
  failures,
  what,
  expression,
}: {
  client: HarnessClient;
  failures: string[];
  what: string;
  expression: string;
}): Promise<void> {
  const deadline = Date.now() + POLL_BUDGET_MS;
  let last = "false";
  while (Date.now() < deadline) {
    last = await evaluateString({ client, expression: `String(${expression})` });
    if (last === "true") {
      process.stdout.write(`  ok   ${what}\n`);
      return;
    }
    await new Promise<void>((done) => setTimeout(done, POLL_MS));
  }
  // The editor's own warnings are the first thing to look at when a gesture produced no record:
  // a refusal is a sentence, and reading it beats guessing at the pointer maths.
  const warnings = await evaluateString({ client, expression: "JSON.stringify(window.sashaHarness.warnings())" });
  const edits = await evaluateString({ client, expression: "JSON.stringify(window.sashaHarness.edits())" });
  failures.push(`${what} (last value: ${last}; warnings ${warnings}; edits ${edits.slice(0, 300)})`);
}

async function evaluate({
  client,
  failures,
  expression,
  awaitPromise,
}: {
  client: HarnessClient;
  failures: string[];
  expression: string;
  awaitPromise?: boolean;
}): Promise<void> {
  const { exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: awaitPromise === true });
  if (exceptionDetails !== undefined && exceptionDetails !== null) {
    failures.push(`${expression.slice(0, 60)} threw: ${JSON.stringify(exceptionDetails).slice(0, 200)}`);
  }
}

async function evaluateString({ client, expression, awaitPromise }: { client: HarnessClient; expression: string; awaitPromise?: boolean }): Promise<string> {
  const { result, exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: awaitPromise === true });
  if (exceptionDetails !== undefined && exceptionDetails !== null) return `THREW ${JSON.stringify(exceptionDetails).slice(0, 200)}`;
  return typeof result.value === "string" ? result.value : String(result.value);
}

async function evaluateNumber({ client, expression }: { client: HarnessClient; expression: string }): Promise<number> {
  const text = await evaluateString({ client, expression: `String(${expression})` });
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : -1;
}

/** esbuild bundles the harness in memory: nothing is written into the repo. */
async function bundleHarness(): Promise<string> {
  const result = await build({
    entryPoints: [join(HERE, "harness.ts")],
    bundle: true,
    write: false,
    format: "iife",
    target: "chrome120",
    sourcemap: false,
    logLevel: "silent",
  });
  const file = result.outputFiles[0];
  if (file === undefined) throw new Error("esbuild produced no output for harness.ts");
  return file.text;
}

function listen(bundle: string): Promise<Server> {
  const page = readFileSync(join(HERE, "harness.html"), "utf-8");
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (path === "/harness.js") return send({ response, type: "text/javascript", body: bundle });
    if (path.startsWith("/fixtures/")) {
      const name = path.slice("/fixtures/".length);
      if (!/^[0-9a-z-]+\.html$/.test(name)) return send({ response, type: "text/plain", body: "no", status: 400 });
      return send({ response, type: "text/html", body: readFileSync(join(FIXTURES, name), "utf-8") });
    }
    return send({ response, type: "text/html", body: page });
  });
  return new Promise((done) => server.listen(PORT, "127.0.0.1", () => done(server)));
}

function send({ response, type, body, status }: { response: ServerResponse; type: string; body: string; status?: number }): void {
  response.writeHead(status ?? 200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  response.end(body);
}

function outDirOf(args: readonly string[]): string {
  const flag = args.indexOf("--out");
  const given = flag === -1 ? undefined : args[flag + 1];
  return given ?? join(tmpdir(), "sasha-editor-harness");
}

await main();
