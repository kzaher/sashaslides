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
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGoogleSlidesSource, developerSourceDependencies } from "../../../../renderer/html2slides/reverse/google-slides-source.ts";
import { openChromeTab } from "../../../../renderer/html2slides/reverse/chrome-capture.ts";
import type { SlidesApiRequest } from "../slides-api.js";
import { argAfter } from "./args.js";
import { convertInPage, openConverter } from "./in-page-converter.js";
import type { CdpPage } from "./in-page-converter.js";
import { applyWithDrops, googleDrive, kindOf, slidesClient } from "./slides-client.js";
import type { SlidesClient } from "./slides-client.js";
import { STAGED_IMAGE_FIELD, stagedImageOf } from "../slide-image.js";

/** The CDP port and scale the originals were always shot at: 1 makes a 1280x720 PNG. */
const CDP_PORT = 9222;
const ORIGINAL_DEVICE_SCALE_FACTOR = 1;
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
/** The four documents the picker actually stages -- `mcp/sasha-slides/e2e/fixtures`. */
const CANDIDATES = join(HERE, "../../e2e/fixtures");
/** `--from <dir>` points the whole run at another folder of slide documents. */
function candidatesDir(): string {
  const given = argAfter("--from");
  return given === null ? CANDIDATES : resolve(REPO_ROOT, given);
}

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
  {
    await using tab = await openChromeTab({ port: CDP_PORT, deviceScaleFactor: ORIGINAL_DEVICE_SCALE_FACTOR });
    for (const [at, name] of names.entries()) {
      const { png } = await tab.capture({ address: `file://${join(from, name)}` });
      writeFileSync(join(outDir, "originals", slideFile(at)), png);
      process.stdout.write(`original  ${slideFile(at)}  ${name}  ${png.length} bytes\n`);
    }
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
    const thumbnails = createGoogleSlidesSource(developerSourceDependencies((line) => process.stdout.write(`${line}\n`)));
    const byObjectId = new Map((deck.data.slides ?? []).map((slide) => [slide.objectId ?? "", slide]));
    for (const [at, report] of reports.entries()) {
      if (!byObjectId.has(report.pageObjectId)) {
        process.stdout.write(`thumb     ${slideFile(at)}  MISSING -- ${report.pageObjectId} is not in the deck\n`);
        continue;
      }
      const png = await thumbnails.downloadThumbnail({ presentationId, pageObjectId: report.pageObjectId });
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
    page: CdpPage;
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
    submission = await applyWithDrops({ client, presentationId, requests: staged.requests, onUnnamedRejection: "dropLast" });
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
    rejections: submission.rejections.map((rejection) => ({ kind: rejection.kind, message: rejection.message.slice(0, 220) })),
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

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
