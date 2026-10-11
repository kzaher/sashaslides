#!/usr/bin/env npx tsx
/**
 * sxs-candidates.ts — the picker's OWN candidates, through the real converter, side by side.
 *
 *   npx tsx mcp/sasha-slides/converter/calibration/sxs-candidates.ts
 *   npx tsx .../sxs-candidates.ts --out .sxs-candidates --keep
 *
 * Needs Chrome on CDP :9222 and `.auth/tokens.json`.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `roundtrip.ts`. `roundtrip run` proves the API ACCEPTS what
 * the converter emits and that the geometry read back is the geometry asked for. Both can pass
 * while the slide still looks nothing like the HTML -- an accepted request with the right box can
 * carry the wrong fill, the wrong font or no text at all. The only way to see that is to look at
 * the two pictures, so this writes the pair:
 *
 *   <out>/originals/slide_NN.png   the candidate rendered by Chrome at 1280x720 -- the truth
 *   <out>/slides/slide_NN.png      Google's own rasterisation of the converted slide
 *
 * which is exactly the layout `renderer/html2slides/rating-server.ts` reads, so the result drops
 * into the SxS rating UI with no further wiring.
 *
 * THE DECK IS A THROWAWAY and it is deleted on the way out (`--keep` to inspect it). Nothing here
 * touches the user's deck: the whole point of the picker is that a candidate is not in a deck yet.
 */
import CDPraw from "chrome-remote-interface";
import { build, transformSync } from "esbuild";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { slides_v1 } from "googleapis";
import type { CdpModule } from "../../../../types/cdp-types.ts";
import type { SlidesApiRequest } from "../slides-api.js";
import { asApiRequests, describeApiError, googleDrive, kindOf, slidesClient } from "./slides-client.js";
import type { SlidesClient } from "./slides-client.js";
import { STAGED_IMAGE_FIELD, stagedImageOf } from "../slide-image.js";

// chrome-remote-interface ships no .d.ts; its default export is `unknown` in types/ambient.d.ts.
// Narrowed once here, as roundtrip.ts and the browser e2e test do.
const CDP = CDPraw as CdpModule;

const CDP_PORT = 9222;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
/** The four documents the picker actually stages -- `mcp/sasha-slides/e2e/fixtures`. */
const CANDIDATES = join(HERE, "../../e2e/fixtures");
/** `--from <dir>` points the whole run at another folder of slide documents. */
function candidatesDir(): string {
  const given = argAfter("--from");
  return given === null ? CANDIDATES : resolve(REPO_ROOT, given);
}
const HOST_PAGE = join(HERE, "../test/fixtures/host.html");
const SLIDE_WIDTH_PX = 1280;
const SLIDE_HEIGHT_PX = 720;

type Conversion = Readonly<{
  requests: readonly SlidesApiRequest[];
  unsupported: readonly Readonly<Record<string, unknown>>[];
}>;

/**
 * `UnsupportedFeature` is a DISCRIMINATED UNION whose arms carry different fields -- there is no
 * `feature` or `reason` on any of them. Printing those names gave "unsupported ?: ?" for every
 * entry, which looked like the converter reporting nothing useful when it was this line throwing
 * the detail away. Print the discriminant and whatever else the arm carries.
 */
function describeUnsupported(entry: Readonly<Record<string, unknown>>): string {
  const kind = typeof entry["kind"] === "string" ? entry["kind"] : "?";
  const rest = Object.entries(entry)
    .filter(([key]) => key !== "kind")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  return rest === "" ? kind : `${kind}  ${rest}`;
}

type CandidateReport = Readonly<{
  fixture: string;
  pageObjectId: string;
  requestCount: number;
  kinds: Readonly<Record<string, number>>;
  droppedCount: number;
  rejections: readonly Readonly<{ kind: string; message: string }>[];
  unsupported: readonly string[];
}>;

async function main(): Promise<void> {
  const outDir = resolve(REPO_ROOT, argAfter("--out") ?? ".sxs-candidates");
  const keep = process.argv.includes("--keep");
  const from = candidatesDir();
  const names = readdirSync(from)
    .filter((name) => name.endsWith(".html"))
    .sort();
  if (names.length === 0) throw new Error(`no candidates in ${from}`);

  // ONLY THE TWO DIRECTORIES THIS SCRIPT OWNS. It used to wipe the whole results dir, which also
  // takes out the rating server's `annotations/` and `zoom-crops/` -- user-drawn artifacts that
  // cannot be regenerated (CLAUDE.md) -- and any before/after copy kept for comparison.
  for (const half of ["originals", "slides"]) {
    rmSync(join(outDir, half), { recursive: true, force: true });
    mkdirSync(join(outDir, half), { recursive: true });
  }

  // --- THE TRUTH: Chrome's own rendering of each candidate ---------------------------------
  for (const [at, name] of names.entries()) {
    const png = await shootHtml(join(from, name));
    writeFileSync(join(outDir, "originals", slideFile(at)), png);
    process.stdout.write(`original  ${slideFile(at)}  ${name}  ${png.length} bytes\n`);
  }

  // --- WHAT GOOGLE MAKES OF THE CONVERTER'S REQUESTS ----------------------------------------
  const client = slidesClient();
  const created = await client.slides.presentations.create({
    requestBody: { title: `sasha-sxs-candidates-${Date.now()}` },
  });
  const presentationId = created.data.presentationId;
  if (typeof presentationId !== "string") throw new Error("presentations.create returned no id");
  process.stdout.write(`deck      ${presentationId}\n`);

  const reports: CandidateReport[] = [];
  try {
    const browser = await openConverter();
    try {
      for (const [at, name] of names.entries()) {
        reports.push(
          await oneCandidate({
            client,
            presentationId,
            page: browser.page,
            name,
            at,
            html: readFileSync(join(from, name), "utf-8"),
          }),
        );
      }
    } finally {
      await browser.close();
    }

    // THE DECK'S FIRST SLIDE is the one `presentations.create` made, and it is not a candidate --
    // the thumbnails have to be read from the slides this script appended, in append order, or
    // every pair is off by one and the whole comparison is nonsense.
    const deck = await client.slides.presentations.get({ presentationId });
    const byObjectId = new Map((deck.data.slides ?? []).map((slide) => [slide.objectId ?? "", slide]));
    for (const [at, report] of reports.entries()) {
      if (!byObjectId.has(report.pageObjectId)) {
        process.stdout.write(`thumb     ${slideFile(at)}  MISSING -- ${report.pageObjectId} is not in the deck\n`);
        continue;
      }
      const thumb = await client.slides.presentations.pages.getThumbnail({
        presentationId,
        pageObjectId: report.pageObjectId,
        "thumbnailProperties.mimeType": "PNG",
        "thumbnailProperties.thumbnailSize": "LARGE",
      });
      const url = thumb.data.contentUrl;
      if (typeof url !== "string") throw new Error(`no thumbnail url for ${report.pageObjectId}`);
      const png = Buffer.from(await (await fetch(url)).arrayBuffer());
      writeFileSync(join(outDir, "slides", slideFile(at)), png);
      process.stdout.write(`thumb     ${slideFile(at)}  ${report.fixture}  ${png.length} bytes\n`);
    }
  } finally {
    // ON EVERY PATH. A throw halfway through used to leave the throwaway deck in Drive, which is
    // the one side effect this script promises not to have.
    if (keep) {
      process.stdout.write(`kept https://docs.google.com/presentation/d/${presentationId}/edit\n`);
    } else {
      await client.deletePresentation(presentationId);
      process.stdout.write(`deleted ${presentationId}\n`);
    }
  }

  writeFileSync(join(outDir, "candidates.json"), JSON.stringify(reports, null, 2));
  for (const report of reports) printReport(report);
  process.stdout.write(`\nSxS: npx tsx renderer/html2slides/rating-server.ts ${outDir}\n`);
}

/** One candidate: its own blank page, the converter's requests, and whatever the API refused. */
async function oneCandidate(
  options: Readonly<{
    client: SlidesClient;
    presentationId: string;
    page: Awaited<ReturnType<CdpModule>>;
    name: string;
    at: number;
    html: string;
  }>,
): Promise<CandidateReport> {
  const { client, presentationId, page, name, at, html } = options;
  const pageObjectId = `cand${String(at + 1).padStart(2, "0")}`;
  await client.slides.presentations.batchUpdate({
    presentationId,
    requestBody: {
      requests: [{ createSlide: { objectId: pageObjectId, slideLayoutReference: { predefinedLayout: "BLANK" } } }],
    },
  });

  const conversion = await convertInPage({ page, html, name, pageObjectId, presentationId });
  const kinds: Record<string, number> = {};
  for (const request of conversion.requests) kinds[kindOf(request)] = (kinds[kindOf(request)] ?? 0) + 1;

  // THE HOST STAGES THE IMAGE BYTES, and this harness IS the host. `createImage` takes a URL that
  // GOOGLE fetches without the user's credentials, so a self-contained candidate's data: URI has
  // to become a fetchable Drive file first -- exactly what `sashaStageImages_` does in Code.gs
  // (build-addon.ts). Skipping it does not merely lose the picture: the batch is ATOMIC, so the
  // whole slide is refused and the SxS pair compares the HTML against an empty page.
  const staged = await stageImages(conversion.requests);
  let submission;
  try {
    submission = await applyWithDrops({ client, presentationId, requests: staged.requests });
  } finally {
    // Slides COPIES the bytes during the batchUpdate, so the file is dead weight the moment the
    // call returns -- on the failure path too (converter/slide-image.ts).
    await unstage(staged.fileIds);
  }
  return {
    fixture: name,
    pageObjectId,
    requestCount: conversion.requests.length,
    kinds,
    droppedCount: conversion.requests.length - submission.survivors.length,
    rejections: submission.rejections,
    unsupported: conversion.unsupported.map(describeUnsupported),
  };
}

/**
 * Every `sashaStageImage` sidecar turned into a fetchable Drive file, with the request rewritten
 * to point at it and the sidecar removed so the request is wire-legal again. Mirrors
 * `sashaStageImages_` in build-addon.ts; the share is link-only and lasts one batchUpdate.
 */
async function stageImages(
  requests: readonly SlidesApiRequest[],
): Promise<Readonly<{ requests: readonly SlidesApiRequest[]; fileIds: readonly string[] }>> {
  const drive = googleDrive();
  const fileIds: string[] = [];
  const rewritten: SlidesApiRequest[] = [];
  for (const request of requests) {
    const upload = stagedImageOf(request as unknown as Readonly<Record<string, unknown>>);
    if (upload === null) {
      rewritten.push(request);
      continue;
    }
    const created = await drive.files.create({
      requestBody: { name: upload.fileName },
      // A STREAM, not a Buffer: googleapis' multipart path calls `body.pipe`, so a Buffer
      // fails with "part.body.pipe is not a function" rather than any API error.
      media: { mimeType: upload.mimeType, body: Readable.from(Buffer.from(upload.base64, "base64")) },
      fields: "id",
    });
    const fileId = created.data.id;
    if (typeof fileId !== "string") throw new Error(`staging ${upload.fileName} returned no id`);
    fileIds.push(fileId);
    await drive.permissions.create({ fileId, requestBody: { role: "reader", type: "anyone" } });
    const copy = { ...(request as unknown as Record<string, unknown>) };
    delete copy[STAGED_IMAGE_FIELD];
    const createImage = { ...(copy["createImage"] as Record<string, unknown>) };
    createImage["url"] = `https://drive.google.com/uc?id=${fileId}`;
    copy["createImage"] = createImage;
    rewritten.push(copy as unknown as SlidesApiRequest);
  }
  return { requests: rewritten, fileIds };
}

/** Best effort, and never fatal: a leftover staged file must not fail an otherwise good run. */
async function unstage(fileIds: readonly string[]): Promise<void> {
  const drive = googleDrive();
  for (const fileId of fileIds) {
    try {
      await drive.files.delete({ fileId });
    } catch (cause: unknown) {
      process.stdout.write(`  WARNING could not delete staged ${fileId}: ${String(cause).slice(0, 120)}\n`);
    }
  }
}

/**
 * A REJECTED BATCH IS ATOMIC, so one bad request loses the whole slide and the picture would be
 * empty for a reason that has nothing to do with fidelity. The API names the offending index, so
 * drop it, record its own words and retry -- which enumerates every rejection in one pass and
 * still leaves a slide worth photographing.
 */
async function applyWithDrops(
  options: Readonly<{ client: SlidesClient; presentationId: string; requests: readonly SlidesApiRequest[] }>,
): Promise<Readonly<{ survivors: readonly SlidesApiRequest[]; rejections: readonly Readonly<{ kind: string; message: string }>[] }>> {
  const { client, presentationId } = options;
  let survivors = [...options.requests];
  const rejections: Readonly<{ kind: string; message: string }>[] = [];
  // Bounded by the request count: every pass either applies or removes exactly one request.
  for (let attempt = 0; attempt <= options.requests.length; attempt += 1) {
    if (survivors.length === 0) return { survivors, rejections };
    try {
      await client.slides.presentations.batchUpdate({
        presentationId,
        requestBody: { requests: asApiRequests(survivors) },
      });
      return { survivors, rejections };
    } catch (cause: unknown) {
      const failure = describeApiError(cause);
      const at = indexInMessage(failure.message);
      const offender = at === null ? survivors.length - 1 : at;
      const dropped = survivors[offender];
      rejections.push({ kind: dropped === undefined ? "?" : kindOf(dropped), message: failure.message.slice(0, 220) });
      survivors = survivors.filter((_unused, position) => position !== offender);
    }
  }
  return { survivors, rejections };
}

/** `Invalid requests[7].createShape: ...` -- the API points at the request it refused. */
function indexInMessage(message: string): number | null {
  const found = /requests\[(\d+)\]/.exec(message);
  const at = found === null ? Number.NaN : Number(found[1]);
  return Number.isInteger(at) ? at : null;
}

/** Chrome's rendering of one candidate at the slide's own pixel size. */
async function shootHtml(path: string): Promise<Buffer> {
  const tab = await CDP.New({ port: CDP_PORT, url: "about:blank" });
  const page = await CDP({ target: tab, port: CDP_PORT });
  try {
    await page.Page.enable();
    await page.Runtime.enable();
    await page.Emulation.setDeviceMetricsOverride({
      width: SLIDE_WIDTH_PX,
      height: SLIDE_HEIGHT_PX,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // SUBSCRIBE BEFORE NAVIGATING. `Page.loadEventFired()` awaited AFTER the navigation never
    // resolves -- the event has already fired and it does not fire twice (CLAUDE.md).
    const loaded = page.Page.loadEventFired();
    await page.Page.navigate({ url: `file://${path}` });
    await Promise.race([loaded, new Promise<void>((done) => setTimeout(done, 3000))]);
    const shot = await page.Page.captureScreenshot({ format: "png" });
    return Buffer.from(shot.data, "base64");
  } finally {
    await page.close();
    await CDP.Close({ port: CDP_PORT, id: tab.id });
  }
}

type Browser = Readonly<{ page: Awaited<ReturnType<CdpModule>>; close: () => Promise<void> }>;

/** Bundle the converter as the extension will, inject it, hand back the tab. */
async function openConverter(): Promise<Browser> {
  const extractorScript = transformSync(
    readFileSync(join(REPO_ROOT, "renderer/html2slides/extract-dom.ts"), "utf-8"),
    { loader: "ts", target: "es2020" },
  ).code;
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
    close: async (): Promise<void> => {
      await page.close();
      await CDP.Close({ port: CDP_PORT, id: tab.id });
    },
  };
}

async function convertInPage(
  options: Readonly<{
    page: Awaited<ReturnType<CdpModule>>;
    html: string;
    name: string;
    pageObjectId: string;
    presentationId: string;
  }>,
): Promise<Conversion> {
  const expression = `(async () => {
    const result = await SashaConverter.convertHtmlToSlideRequests({
      html: ${JSON.stringify(options.html)},
      presentationId: ${JSON.stringify(options.presentationId)},
      pageObjectId: ${JSON.stringify(options.pageObjectId)},
      extractorScript: window.__EXTRACTOR__,
      container: document.body,
      objectIdPrefix: ${JSON.stringify(options.name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16))},
    });
    return JSON.stringify({ requests: result.requests, unsupported: result.unsupported });
  })()`;
  const raw = await evaluate(options.page, expression, true);
  if (typeof raw !== "string") throw new Error(`conversion of ${options.name} returned ${typeof raw}`);
  return JSON.parse(raw) as Conversion;
}

async function evaluate(
  page: Awaited<ReturnType<CdpModule>>,
  expression: string,
  awaitPromise: boolean,
): Promise<unknown> {
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
async function waitForReady(page: Awaited<ReturnType<CdpModule>>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await evaluate(page, "document.readyState + '|' + !!document.body", false);
    if (state === "complete|true") return;
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  throw new Error("host page did not become ready within 5s");
}

function printReport(report: CandidateReport): void {
  const kinds = Object.entries(report.kinds)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind} x${String(count)}`)
    .join(", ");
  process.stdout.write(`\n${report.fixture}  (${String(report.requestCount)} requests)\n  ${kinds}\n`);
  if (report.droppedCount > 0) process.stdout.write(`  DROPPED ${String(report.droppedCount)}\n`);
  for (const rejection of report.rejections) process.stdout.write(`  rejected ${rejection.kind}: ${rejection.message}\n`);
  for (const entry of report.unsupported) process.stdout.write(`  unsupported ${entry}\n`);
}

function slideFile(at: number): string {
  return `slide_${String(at + 1).padStart(2, "0")}.png`;
}

function argAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return process.argv[index + 1] ?? null;
}

// `slides_v1` is imported for the SDK's own request type through slides-client.ts; referencing it
// here keeps the import honest under `noUnusedLocals`.
export type { slides_v1 };

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
