#!/usr/bin/env npx tsx
/**
 * browser.e2e.test.ts — the converter running in a real browser, on real HTML.
 *
 * Run (from the repo root, which is where node_modules resolves):
 *   npx tsx mcp/sasha-slides/converter/test/browser.e2e.test.ts
 *   npx tsx mcp/sasha-slides/converter/test/browser.e2e.test.ts --only slide_14_table_basic.html
 *
 * Needs Chrome on CDP :9222:
 *   setsid google-chrome --headless=new --remote-debugging-port=9222 \
 *     --no-sandbox --user-data-dir=/tmp/chrome-cdp > /dev/null 2>&1 < /dev/null &
 *
 * This exercises the ACTUAL browser path end to end: the converter is bundled
 * with esbuild exactly as the extension will bundle it, injected into a page,
 * and asked to convert a slide document — so the staging iframe, the extractor
 * injection and its CSP fallback, the boundary parser and the emitter all run
 * where they will run in production. The only thing it cannot do is call
 * `presentations.batchUpdate`, so instead it validates the request bodies
 * against the structural invariants that call would enforce.
 *
 * Inputs are `renderer/html2slides/e2e/fixtures-basic/` (one feature per slide,
 * read-only; nothing here writes to `renderer/`) plus this directory's own
 * fixtures for features the basic set does not cover.
 */
import CDPraw from "chrome-remote-interface";
import { build, transformSync } from "esbuild";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CdpModule } from "../../../../types/cdp-types.ts";
import { STAGED_IMAGE_URL, stagedImageOf } from "../index.js";
import type { SlideImageUpload } from "../index.js";
import { kindOf, startTestRun } from "./assert.js";

// chrome-remote-interface ships no .d.ts; its default export is declared
// `unknown` in types/ambient.d.ts. Narrow it at this one boundary, as
// dump-table.ts and convert-pptx-io.ts do.
const CDP = CDPraw as CdpModule;

const CDP_PORT = 9222;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const BASIC_FIXTURES = join(REPO_ROOT, "renderer/html2slides/e2e/fixtures-basic");
const OWN_FIXTURES = join(HERE, "fixtures");
const HOST_PAGE = join(OWN_FIXTURES, "host.html");

/** 9144000 EMU / 1280 px. */
const EMU_PER_PX = 7143.75;
const PAGE_WIDTH_EMU = 9144000;
const PAGE_HEIGHT_EMU = 5143500;

const test = startTestRun("browser.e2e");

type ConversionReport = Readonly<{
  requests: readonly Readonly<Record<string, unknown>>[];
  unsupported: readonly Readonly<{ kind: string; region: Readonly<{ x: number; y: number; w: number; h: number }>; fallback: string; elementType: string }>[];
  elementCount: number;
  malformedCount: number;
  elapsedMs: number;
}>;

async function main(): Promise<void> {
  const only = parseOnly(process.argv.slice(2));

  // 1. The extractor, compiled exactly as the renderer compiles it
  //    (convert-pptx-io.ts:67-71) — a bare IIFE source string.
  const extractorScript = transformSync(
    readFileSync(join(REPO_ROOT, "renderer/html2slides/extract-dom.ts"), "utf-8"),
    { loader: "ts", target: "es2020" },
  ).code;

  // 2. The converter, bundled as the extension will bundle it: one IIFE on a
  //    global, no Node builtins. A bundle failure here is a real signal that
  //    something Node-only crept in.
  const bundled = await build({
    entryPoints: [join(HERE, "../index.ts")],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "SashaConverter",
    platform: "browser",
    target: "es2020",
    logLevel: "silent",
  });
  const converterBundle = bundled.outputFiles[0]?.text ?? "";
  test.check("converter bundles for the browser", converterBundle.length > 0);
  test.check(
    "the bundle pulls in no Node builtins",
    !/require\(["']node:/.test(converterBundle),
    "a `node:` require survived bundling",
  );

  const tab = await CDP.New({ port: CDP_PORT, url: `file://${HOST_PAGE}` });
  const client = await CDP({ target: tab, port: CDP_PORT });
  try {
    const { Runtime, Page } = client;
    await Page.enable();
    await Runtime.enable();
    await waitForHostPage(client);

    await evaluate(client, converterBundle, false);
    const installed = await evaluate(client, "typeof SashaConverter.convertHtmlToSlideRequests", false);
    test.equal("the bundle installs the entry point", installed, "function");

    const fixtures = [
      ...listFixtures(BASIC_FIXTURES).map((name) => ({ dir: BASIC_FIXTURES, name, own: false })),
      ...listFixtures(OWN_FIXTURES)
        .filter((name) => name !== "host.html")
        .map((name) => ({ dir: OWN_FIXTURES, name, own: true })),
    ].filter((fixture) => only === null || only.includes(fixture.name));

    test.check("fixtures were found", fixtures.length > 0, `${fixtures.length} fixtures`);

    const timings: { name: string; ms: number; requests: number }[] = [];
    for (const fixture of fixtures) {
      const html = readFileSync(join(fixture.dir, fixture.name), "utf-8");
      const report = await convertInPage(client, { html, extractorScript, name: fixture.name });
      timings.push({ name: fixture.name, ms: report.elapsedMs, requests: report.requests.length });
      checkFixture({ name: fixture.name, report });
    }

    checkExpectedAnomalies(
      await Promise.all(
        EXPECTED_ANOMALIES.filter((expectation) => only === null || only.includes(expectation.fixture)).map(
          async (expectation) => ({
            expectation,
            report: await convertInPage(client, {
              html: readFileSync(join(fixtureDirFor(expectation.fixture), expectation.fixture), "utf-8"),
              extractorScript,
              name: expectation.fixture,
            }),
          }),
        ),
      ),
    );

    reportTimings(timings);
  } finally {
    await client.close();
    await CDP.Close({ port: CDP_PORT, id: tab.id });
  }

  test.finish();
}

/** Structural invariants `presentations.batchUpdate` would enforce. */
function checkFixture(options: Readonly<{ name: string; report: ConversionReport }>): void {
  const { name, report } = options;
  const { requests, unsupported } = report;

  test.check(`${name}: produced requests`, requests.length > 0, `${requests.length} requests`);
  test.check(
    `${name}: extractor produced no malformed elements`,
    report.malformedCount === 0,
    `${report.malformedCount} malformed`,
  );

  const objectIds = new Set<string>();
  for (const request of requests) {
    const kind = kindOf(request);
    // One operation per entry, plus at most the image-staging sidecar -- which is
    // an instruction for the host, not a Slides field, and is stripped before the
    // request is sent (converter/slide-image.ts).
    const staged = stagedImageOf(request);
    test.check(
      `${name}: ${kind} is a single-key request`,
      Object.keys(request).length === (staged === null ? 1 : 2),
      Object.keys(request).join(","),
    );
    if (staged !== null) checkStagedImage({ name, request, staged });

    const payload = request[kind];
    if (typeof payload !== "object" || payload === null) {
      test.check(`${name}: ${kind} has an object payload`, false);
      continue;
    }
    const body = payload as Readonly<Record<string, unknown>>;

    const objectId = body["objectId"];
    test.check(
      `${name}: ${kind} objectId is valid`,
      typeof objectId === "string" && /^[a-zA-Z0-9_-]{5,50}$/.test(objectId),
      String(objectId),
    );
    if (CREATE_KINDS.has(kind) && typeof objectId === "string") {
      test.check(`${name}: ${kind} objectId ${objectId} is unique`, !objectIds.has(objectId));
      objectIds.add(objectId);
    }

    if (CREATE_KINDS.has(kind)) checkElementProperties({ name, kind, body });
    if (kind === "insertText") checkInsertText({ name, body });
    if (typeof body["fields"] === "string") checkFieldMask({ name, kind, body });
    if (body["textRange"] !== undefined) checkTextRange({ name, kind, body });
  }

  // Every update must target something this batch created, or batchUpdate 400s.
  for (const request of requests) {
    const kind = kindOf(request);
    if (CREATE_KINDS.has(kind)) continue;
    const body = Object.values(request)[0] as Readonly<Record<string, unknown>>;
    const objectId = body["objectId"];
    test.check(
      `${name}: ${kind} targets an object this batch creates`,
      typeof objectId === "string" && objectIds.has(objectId),
      String(objectId),
    );
  }

  for (const anomaly of unsupported) {
    const { region } = anomaly;
    const inside =
      region.x >= -0.05 && region.y >= -0.05 && region.w >= 0 && region.h >= 0 &&
      region.x + region.w <= 1.05 && region.y + region.h <= 1.05;
    test.check(
      `${name}: ${anomaly.kind} region is fractional and on-slide`,
      inside,
      JSON.stringify(region),
    );
    test.check(
      `${name}: ${anomaly.kind} declares a known fallback`,
      KNOWN_FALLBACKS.has(anomaly.fallback),
      anomaly.fallback,
    );
  }
}

/**
 * An image whose bytes the host has to put on Drive first. The checks are the
 * ones `sashaInsert` depends on: it uploads these three values blindly and
 * substitutes the result into the URL beside them, so a sidecar that named a
 * media type Slides cannot decode, or sat on something other than a
 * `createImage`, would fail at the API rather than here.
 */
function checkStagedImage(
  options: Readonly<{
    name: string;
    request: Readonly<Record<string, unknown>>;
    staged: SlideImageUpload;
  }>,
): void {
  const { name, request, staged } = options;
  const image = request["createImage"] as Readonly<Record<string, unknown>> | undefined;
  test.check(`${name}: a staged image rides on a createImage`, image !== undefined);
  test.equal(`${name}: a staged image url is the placeholder`, image?.["url"], STAGED_IMAGE_URL);
  test.check(
    `${name}: the staged media type is one Slides decodes`,
    STAGEABLE_MEDIA_TYPES.has(staged.mimeType),
    staged.mimeType,
  );
  test.check(
    `${name}: the staged payload is whitespace-free base64`,
    /^[A-Za-z0-9+/]+={0,2}$/.test(staged.base64),
    `${staged.base64.length} chars`,
  );
  test.check(
    `${name}: the staged file name is a usable Drive name`,
    /^[a-zA-Z0-9_-]{5,50}\.(png|jpg|gif)$/.test(staged.fileName),
    staged.fileName,
  );
}

/** Measured: every other form answers "The URL is invalid" or "unsupported formats". */
const STAGEABLE_MEDIA_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif"]);

const CREATE_KINDS: ReadonlySet<string> = new Set([
  "createShape",
  "createLine",
  "createImage",
  "createTable",
]);

const KNOWN_FALLBACKS: ReadonlySet<string> = new Set([
  "omitted",
  "solid-approximation",
  "preset-approximation",
  "edge-lines",
  "geometry-floor",
  "font-substituted",
  "needs-raster",
]);

function checkElementProperties(
  options: Readonly<{ name: string; kind: string; body: Readonly<Record<string, unknown>> }>,
): void {
  const { name, kind, body } = options;
  const properties = body["elementProperties"] as
    | Readonly<{
        pageObjectId?: unknown;
        size?: { width?: { magnitude?: unknown; unit?: unknown }; height?: { magnitude?: unknown; unit?: unknown } };
        transform?: Readonly<Record<string, unknown>>;
      }>
    | undefined;
  if (properties === undefined) {
    test.check(`${name}: ${kind} has elementProperties`, false);
    return;
  }
  test.equal(`${name}: ${kind} targets the page`, properties.pageObjectId, "p1");

  const width = properties.size?.width?.magnitude;
  const height = properties.size?.height?.magnitude;
  test.check(
    `${name}: ${kind} has a positive integral width`,
    typeof width === "number" && Number.isInteger(width) && width > 0,
    String(width),
  );
  test.check(
    `${name}: ${kind} has a positive integral height`,
    typeof height === "number" && Number.isInteger(height) && height > 0,
    String(height),
  );
  test.equal(`${name}: ${kind} width is EMU`, properties.size?.width?.unit, "EMU");

  const transform = properties.transform;
  const translateX = transform?.["translateX"];
  const translateY = transform?.["translateY"];
  test.check(
    `${name}: ${kind} translateX is a finite integer`,
    typeof translateX === "number" && Number.isInteger(translateX),
    String(translateX),
  );
  test.check(
    `${name}: ${kind} translateY is a finite integer`,
    typeof translateY === "number" && Number.isInteger(translateY),
    String(translateY),
  );
  // A 1280x720 document maps onto the 16:9 page, so nothing should land far
  // outside it. The slack is the text-inset outset — the measured 9 px
  // (DEFAULT_TEXT_INSET_EMU), doubled so an element at the page edge still fits.
  const slack = 2 * 85725;
  test.check(
    `${name}: ${kind} lands on or near the page`,
    typeof translateX === "number" && typeof translateY === "number" &&
      translateX >= -slack && translateY >= -slack &&
      translateX <= PAGE_WIDTH_EMU + slack && translateY <= PAGE_HEIGHT_EMU + slack,
    `(${String(translateX)}, ${String(translateY)})`,
  );
  for (const key of ["scaleX", "scaleY", "shearX", "shearY"]) {
    const value = transform?.[key];
    if (value === undefined) continue;
    test.check(
      `${name}: ${kind} ${key} is finite`,
      typeof value === "number" && Number.isFinite(value),
      String(value),
    );
  }
}

function checkInsertText(options: Readonly<{ name: string; body: Readonly<Record<string, unknown>> }>): void {
  const { name, body } = options;
  test.check(`${name}: insertText has non-empty text`, typeof body["text"] === "string" && body["text"].length > 0);
  test.equal(`${name}: insertText index is 0`, body["insertionIndex"], 0);
  const cell = body["cellLocation"];
  if (cell === undefined) return;
  const location = cell as Readonly<{ rowIndex?: unknown; columnIndex?: unknown }>;
  test.check(
    `${name}: cellLocation indices are non-negative integers`,
    typeof location.rowIndex === "number" && Number.isInteger(location.rowIndex) && location.rowIndex >= 0 &&
      typeof location.columnIndex === "number" && Number.isInteger(location.columnIndex) && location.columnIndex >= 0,
    JSON.stringify(location),
  );
}

/**
 * A field mask that names a path the payload does not set is the classic way a
 * batchUpdate silently clears something, so every path is resolved against the
 * object it accompanies.
 */
function checkFieldMask(
  options: Readonly<{ name: string; kind: string; body: Readonly<Record<string, unknown>> }>,
): void {
  const { name, kind, body } = options;
  const fields = body["fields"];
  if (typeof fields !== "string") return;
  test.check(`${name}: ${kind} field mask is non-empty`, fields.length > 0);

  const payloadKey = MASKED_PAYLOAD_KEYS[kind];
  if (payloadKey === undefined) return;
  const payload = body[payloadKey];
  if (typeof payload !== "object" || payload === null) {
    test.check(`${name}: ${kind} has a ${payloadKey} payload`, false);
    return;
  }
  for (const path of fields.split(",")) {
    test.check(
      `${name}: ${kind} mask path "${path}" is actually set`,
      resolvePath(payload as Readonly<Record<string, unknown>>, path.trim()) !== undefined,
      JSON.stringify(payload),
    );
  }
}

const MASKED_PAYLOAD_KEYS: Readonly<Record<string, string>> = {
  updateShapeProperties: "shapeProperties",
  updateLineProperties: "lineProperties",
  updateTextStyle: "style",
  updateParagraphStyle: "style",
  updateTableRowProperties: "tableRowProperties",
  updateTableColumnProperties: "tableColumnProperties",
  updateTableCellProperties: "tableCellProperties",
  updateTableBorderProperties: "tableBorderProperties",
};

function resolvePath(root: Readonly<Record<string, unknown>>, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
}

function checkTextRange(
  options: Readonly<{ name: string; kind: string; body: Readonly<Record<string, unknown>> }>,
): void {
  const { name, kind, body } = options;
  const range = body["textRange"] as Readonly<{ type?: unknown; startIndex?: unknown; endIndex?: unknown }>;
  if (range.type === "ALL") return;
  test.equal(`${name}: ${kind} range type`, range.type, "FIXED_RANGE");
  const start = range.startIndex;
  const end = range.endIndex;
  test.check(
    `${name}: ${kind} range is a well-ordered non-empty span`,
    typeof start === "number" && typeof end === "number" &&
      Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start,
    JSON.stringify(range),
  );
}

/**
 * Fixtures whose whole point is a specific loss. These are the assertions that
 * make `unsupported` a tested output rather than a best-effort log.
 */
const EXPECTED_ANOMALIES: readonly Readonly<{
  fixture: string;
  mustReport: readonly string[];
  mustNotReport?: readonly string[];
}>[] = [
  { fixture: "slide_05_gradient_bg.html", mustReport: ["gradient-fill"] },
  { fixture: "slide_06_shadow.html", mustReport: ["box-shadow"] },
  { fixture: "slide_02_rounded_rect.html", mustReport: ["corner-radius-approximated"] },
  { fixture: "slide_04_border_partial.html", mustReport: ["non-uniform-border"] },
  // A plain uniform border and plain text are fully expressible.
  { fixture: "slide_03_border_uniform.html", mustReport: [], mustNotReport: ["non-uniform-border"] },
  { fixture: "slide_07_text_styles.html", mustReport: [], mustNotReport: ["font-unavailable", "letter-spacing"] },
  // SVG, in every form, is refused by createImage ("The URL is invalid"), so it stays
  // a reported loss -- which is also what the anonymiser's placeholder relies on.
  { fixture: "img_data_uri.html", mustReport: ["image-source-not-fetchable"] },
  // A raster data: URI is no longer a loss at all: small enough travels as the url,
  // too big to fit it is staged on Drive by the host.
  { fixture: "img_data_uri_png.html", mustReport: [], mustNotReport: ["image-source-not-fetchable"] },
  { fixture: "img_data_uri_icon.html", mustReport: [], mustNotReport: ["image-source-not-fetchable"] },
  { fixture: "svg_inline.html", mustReport: ["rasterised-visual"] },
  { fixture: "letter_spacing.html", mustReport: ["letter-spacing"] },
  { fixture: "table_tight_rows.html", mustReport: ["table-row-height-floor"] },
  // Rotation IS expressible in the affine transform, so it is not a loss.
  { fixture: "rotated_text.html", mustReport: [], mustNotReport: ["unsupported-transform"] },
  { fixture: "img_http.html", mustReport: [], mustNotReport: ["image-source-not-fetchable"] },
];

function checkExpectedAnomalies(
  results: readonly Readonly<{
    expectation: (typeof EXPECTED_ANOMALIES)[number];
    report: ConversionReport;
  }>[],
): void {
  for (const { expectation, report } of results) {
    const kinds = new Set(report.unsupported.map((anomaly) => anomaly.kind));
    for (const required of expectation.mustReport) {
      test.check(
        `${expectation.fixture}: reports ${required}`,
        kinds.has(required),
        `reported: ${[...kinds].join(", ") || "<none>"}`,
      );
    }
    for (const forbidden of expectation.mustNotReport ?? []) {
      test.check(
        `${expectation.fixture}: does NOT report ${forbidden}`,
        !kinds.has(forbidden),
        `reported: ${[...kinds].join(", ")}`,
      );
    }
  }
}

function fixtureDirFor(name: string): string {
  return name.startsWith("slide_") ? BASIC_FIXTURES : OWN_FIXTURES;
}

/**
 * Convert one slide inside the page. The HTML crosses into the browser as a
 * JSON string literal in the evaluated expression, and the timing is taken
 * in-page so it measures the conversion rather than the CDP round-trip.
 */
async function convertInPage(
  client: Awaited<ReturnType<CdpModule>>,
  options: Readonly<{ html: string; extractorScript: string; name: string }>,
): Promise<ConversionReport> {
  const expression = `(async () => {
    const started = performance.now();
    const result = await SashaConverter.convertHtmlToSlideRequests({
      html: ${JSON.stringify(options.html)},
      presentationId: "test-presentation",
      pageObjectId: "p1",
      extractorScript: window.__EXTRACTOR__,
      container: document.body,
      objectIdPrefix: ${JSON.stringify(sanitise(options.name))},
    });
    return JSON.stringify({
      requests: result.requests,
      unsupported: result.unsupported,
      elementCount: result.elementCount,
      malformedCount: result.malformedCount,
      elapsedMs: performance.now() - started,
    });
  })()`;

  // The extractor goes over as a global so it is not re-serialised per fixture
  // (it is ~400 KB of compiled JS).
  await client.Runtime.evaluate({
    expression: `window.__EXTRACTOR__ = ${JSON.stringify(options.extractorScript)}; true`,
    returnByValue: true,
  });
  const raw = await evaluate(client, expression, true);
  if (typeof raw !== "string") throw new Error(`conversion of ${options.name} returned ${typeof raw}`);
  return JSON.parse(raw) as ConversionReport;
}

async function evaluate(
  client: Awaited<ReturnType<CdpModule>>,
  expression: string,
  awaitPromise: boolean,
): Promise<unknown> {
  const response = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
  // `types/cdp-types.ts` types exceptionDetails as `{}` (the protocol shape is
  // large and mostly unused here), so narrow the two fields this needs.
  const thrown = response.exceptionDetails as
    | Readonly<{ text?: string; exception?: Readonly<{ description?: string }> }>
    | undefined
    | null;
  if (thrown !== undefined && thrown !== null) {
    throw new Error(`page threw: ${thrown.exception?.description ?? thrown.text ?? "<no detail>"}`);
  }
  return response.result.value;
}

/**
 * Poll for the host page rather than sleeping: it is a static local file, so it
 * is ready almost immediately and a fixed wait would just be dead time.
 */
async function waitForHostPage(client: Awaited<ReturnType<CdpModule>>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await evaluate(client, "document.readyState + '|' + !!document.body", false);
    if (state === "complete|true") return;
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  throw new Error("host page did not become ready within 5s");
}

function reportTimings(timings: readonly Readonly<{ name: string; ms: number; requests: number }>[]): void {
  const sorted = [...timings].sort((left, right) => right.ms - left.ms);
  const total = timings.reduce((sum, entry) => sum + entry.ms, 0);
  console.log("\nper-fixture conversion time (in-page, excludes CDP round-trip):");
  for (const entry of sorted) {
    console.log(`  ${entry.ms.toFixed(0).padStart(5)} ms  ${String(entry.requests).padStart(4)} req  ${entry.name}`);
  }
  console.log(
    `\n  total ${total.toFixed(0)} ms over ${timings.length} slides; ` +
      `mean ${(total / Math.max(1, timings.length)).toFixed(0)} ms, ` +
      `slowest ${(sorted[0]?.ms ?? 0).toFixed(0)} ms`,
  );
  // The whole point of replacing the pptx -> Drive -> import path is latency.
  test.check(
    "the slowest single slide converts in under 2s",
    (sorted[0]?.ms ?? 0) < 2000,
    `${(sorted[0]?.ms ?? 0).toFixed(0)} ms`,
  );
  // EMU_PER_PX is referenced so the constant stays honest documentation.
  test.near("a 1280px document maps to the 16:9 page width", 1280 * EMU_PER_PX, PAGE_WIDTH_EMU, 1);
}

function listFixtures(dir: string): readonly string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".html"))
    .sort();
}

function parseOnly(argv: readonly string[]): readonly string[] | null {
  const index = argv.indexOf("--only");
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined) throw new Error("--only needs a comma-separated fixture list");
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function sanitise(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 24);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
