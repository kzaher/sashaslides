/**
 * in-page-converter.ts — the converter running where it ships: bundled, inside a Chrome tab.
 *
 * The converter needs a DOM, so the calibration scripts (roundtrip.ts, sxs-candidates.ts) bundle
 * `../index.ts` exactly as the add-on does, inject it with the compiled extractor into the static
 * host page on CDP :9222, and call `convertHtmlToSlideRequests` there. This is the one copy of
 * that harness, shared by the calibration scripts and `test/browser.e2e.test.ts`.
 */
import CDPraw from "chrome-remote-interface";
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CdpModule } from "../../../../types/cdp-types.ts";
import { extractorScript as compileExtractorScript } from "../../../../renderer/html2slides/extractor-script.ts";
import type { SlidesApiRequest } from "../slides-api.js";
import type { UnsupportedFeature } from "../unsupported-feature.js";
import type { ConvertedDiagram } from "../emit-requests.js";

// chrome-remote-interface ships no .d.ts; its default export is `unknown` in
// types/ambient.d.ts. Narrowed once here.
const CDP = CDPraw as CdpModule;

const CDP_PORT = 9222;
const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_PAGE = join(HERE, "../test/fixtures/host.html");

export type CdpPage = Awaited<ReturnType<CdpModule>>;

/** The tab, and the converter bundle injected into it (the e2e test checks what it pulled in). */
export type Browser = Readonly<{ page: CdpPage; bundle: string; close: () => Promise<void> }>;

/**
 * What the page hands back, as parsed JSON: the converter's own result fields, plus the
 * conversion time taken in-page (so it measures the conversion rather than the CDP round trip)
 * and the stacked elements' z-indices in paint order.
 */
export type Conversion = Readonly<{
  requests: readonly SlidesApiRequest[];
  unsupported: readonly UnsupportedFeature[];
  elementCount: number;
  malformedCount: number;
  elapsedMs: number;
  stackedZ: readonly number[];
  drawioDiagrams: readonly ConvertedDiagram[];
}>;

/** Bundle the converter as the extension will, inject it, hand back the tab. */
export async function openConverter(): Promise<Browser> {
  const extractorScript = compileExtractorScript();
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
  if (converterBundle.length === 0) throw new Error("converter bundle is empty");
  const tab = await CDP.New({ port: CDP_PORT, url: `file://${HOST_PAGE}` });
  const page = await CDP({ target: tab, port: CDP_PORT });
  await page.Page.enable();
  await page.Runtime.enable();
  await waitForReady(page);
  await evaluate(page, converterBundle, false);
  await evaluate(page, `window.__EXTRACTOR__ = ${JSON.stringify(extractorScript)}; true`, false);
  return {
    page,
    bundle: converterBundle,
    close: async (): Promise<void> => {
      await page.close();
      await CDP.Close({ port: CDP_PORT, id: tab.id });
    },
  };
}

export async function convertInPage(
  options: Readonly<{
    page: CdpPage;
    html: string;
    name: string;
    pageObjectId: string;
    presentationId: string;
    /** Defaults to `name` with everything but letters and digits removed, cut to 16 characters. */
    objectIdPrefix?: string;
    /**
     * Page-side source of the `renderDrawio` option: a JavaScript function expression evaluated in
     * the tab (the real renderer needs the draw.io editor, so tests pass a stand-in).
     */
    renderDrawioSource?: string;
  }>,
): Promise<Conversion> {
  const objectIdPrefix = options.objectIdPrefix ?? options.name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  const expression = `(async () => {
    const started = performance.now();
    const result = await SashaConverter.convertHtmlToSlideRequests({
      html: ${JSON.stringify(options.html)},
      presentationId: ${JSON.stringify(options.presentationId)},
      pageObjectId: ${JSON.stringify(options.pageObjectId)},
      extractorScript: window.__EXTRACTOR__,
      container: document.body,
      objectIdPrefix: ${JSON.stringify(objectIdPrefix)},
      ${options.renderDrawioSource === undefined ? "" : `renderDrawio: (${options.renderDrawioSource}),`}
    });
    return JSON.stringify({
      requests: result.requests,
      unsupported: result.unsupported,
      elementCount: result.elementCount,
      malformedCount: result.malformedCount,
      elapsedMs: performance.now() - started,
      stackedZ: result.stackedElements.map((element) => element.zIndex),
      drawioDiagrams: result.drawioDiagrams,
    });
  })()`;
  const raw = await evaluate(options.page, expression, true);
  if (typeof raw !== "string") throw new Error(`conversion of ${options.name} returned ${typeof raw}`);
  // The page serialised the converter's own result fields (and its timing) just above.
  return JSON.parse(raw) as Conversion;
}

export async function evaluate(page: CdpPage, expression: string, awaitPromise: boolean): Promise<unknown> {
  const response = await page.Runtime.evaluate({ expression, returnByValue: true, awaitPromise });
  const thrown = response.exceptionDetails as
    | Readonly<{ text?: string; exception?: Readonly<{ description?: string }> }>
    | undefined
    | null;
  if (thrown !== undefined && thrown !== null) {
    throw new Error(`page threw: ${thrown.exception?.description ?? thrown.text ?? "<no detail>"}`);
  }
  return response.result.value;
}

/** Poll for the static host page rather than sleeping on it. */
async function waitForReady(page: CdpPage): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await evaluate(page, "document.readyState + '|' + !!document.body", false);
    if (state === "complete|true") return;
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  throw new Error("host page did not become ready within 5s");
}
