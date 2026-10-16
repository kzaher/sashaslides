#!/usr/bin/env npx tsx
/**
 * LIVE round trip with the DEVELOPMENT account's OAuth tokens (never production):
 *
 *   1. `presentations.get` of a real presentation -> `importIntoDeck` -> a deck on the real engine
 *      model (the test deck service), pictures fetched from their live `contentUrl`s;
 *   2. `runExport` of that deck to a NEW presentation through the live Slides programming interface;
 *   3. `presentations.get` of both: slide counts, element counts, and the frame of every natively
 *      mapped element (kept id on both sides) within 1 unit;
 *   4. `getThumbnail` of every slide of both, saved for a person to look at.
 *
 * Pictures: Google fetches an exported picture from an address it can reach. In production that is
 * the 30-minute export-asset capability (tested in the route tests); here, with no public server,
 * the picture's own original `contentUrl` (also valid 30 minutes) stands in.
 *
 *   npx tsx mcp/sasha-slides/e2e/google-slides-round-trip.ts <presentationId>
 *   npx tsx mcp/sasha-slides/e2e/google-slides-round-trip.ts --measure-reuse
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssetId } from "../engine/src/contracts/ids.ts";
import { importIntoDeck } from "../google-slides/import-into-deck.ts";
import { frameForTransform, pageScaleFor, composeTransforms } from "../google-slides/interchange-geometry.ts";
import { runExport } from "../google-slides/export-run.ts";
import { createSlidesClient, type SlidesClient } from "../google-slides/slides-client.ts";
import { IDENTITY_TRANSFORM, parsePresentation, type SlidesPageElement, type SlidesPresentation } from "../google-slides/slides-presentation.ts";
import { createTestDeckService, testCaller } from "../google-slides/testing-deck-service.ts";
import { developmentGrant } from "./google-slides-development-grant.ts";

const SHOTS = "/home/node/.claude/jobs/940e4929/tmp/engine-m2/google-slides";

async function main(): Promise<void> {
  const [argument] = process.argv.slice(2);
  const grant = await developmentGrant();
  const slides = createSlidesClient({ fetch, accessToken: grant.accessToken });
  if (argument === "--measure-reuse") {
    await measureReuse({ slides });
    return;
  }
  if (argument === "--get") {
    // A field-masked presentations.get, for looking at what an export wrote.
    const [, presentationId, fields] = process.argv.slice(2);
    if (presentationId === undefined) throw new Error("usage: --get <presentationId> [fields]");
    const answer = await slides.getPresentation({ presentationId, fields: fields ?? null });
    process.stdout.write(`${JSON.stringify(answer.kind === "ok" ? answer.body : answer)}\n`);
    return;
  }
  if (argument === undefined) throw new Error("usage: google-slides-round-trip.ts <presentationId> | --measure-reuse | --get <presentationId> [fields]");
  await roundTrip({ slides, presentationId: argument, accessToken: grant.accessToken });
}

/**
 * Can an object id be reused right after `deleteObject` in the SAME batch? One presentation, a
 * slide with a shape, then one batch deleting the slide and recreating slide and shape under the
 * same ids. Prints the answer for OBJECT_ID_REUSE_AFTER_DELETE (export-deck.ts).
 */
async function measureReuse(options: Readonly<{ slides: SlidesClient }>): Promise<void> {
  const { slides } = options;
  const created = await slides.createPresentation({ title: "Sasha object id reuse probe", widthEnglishMetricUnits: 9_144_000, heightEnglishMetricUnits: 5_143_500 });
  if (created.kind !== "ok") throw new Error(created.message);
  const presentationId = stringOf({ body: created.body, key: "presentationId" });
  const shape = (objectId: string): unknown => ({
    createShape: {
      objectId,
      shapeType: "RECTANGLE",
      elementProperties: { pageObjectId: "sl_reuseProbe1", size: { width: { magnitude: 1_000_000, unit: "EMU" }, height: { magnitude: 500_000, unit: "EMU" } }, transform: { scaleX: 1, scaleY: 1, translateX: 100_000, translateY: 100_000, unit: "EMU" } },
    },
  });
  const first = await slides.batchUpdate({ presentationId, requests: [{ createSlide: { objectId: "sl_reuseProbe1", slideLayoutReference: { predefinedLayout: "BLANK" } } }, shape("el_reuseProbe1")] });
  if (first.kind !== "ok") throw new Error(`setup failed: ${first.message}`);
  const reuse = await slides.batchUpdate({
    presentationId,
    requests: [{ deleteObject: { objectId: "sl_reuseProbe1" } }, { createSlide: { objectId: "sl_reuseProbe1", insertionIndex: 0, slideLayoutReference: { predefinedLayout: "BLANK" } } }, shape("el_reuseProbe1")],
  });
  const answer = reuse.kind === "ok" ? "REUSABLE in one batch" : `NOT reusable in one batch: HTTP ${reuse.status} ${reuse.message}`;
  process.stdout.write(`object id reuse after deleteObject (presentation ${presentationId}): ${answer}\n`);
}

async function roundTrip(options: Readonly<{ slides: SlidesClient; presentationId: string; accessToken: string }>): Promise<void> {
  const { slides } = options;
  const original = await slides.getPresentation({ presentationId: options.presentationId, fields: null });
  if (original.kind !== "ok") throw new Error(`get failed: ${original.message}`);
  const service = await createTestDeckService();
  const caller = testCaller("round-trip");
  const opened = await service.createDeck({ caller, title: "" });
  if (opened.kind !== "opened") throw new Error(opened.kind);
  const deck = opened.deck;
  const imported = await importIntoDeck({
    presentationAnswer: original.body,
    deck,
    author: { kind: "person", personId: caller.person.id },
    fetch,
    accessToken: options.accessToken,
    pptxExport: await pptxExportOf({ slides: options.slides, presentationId: options.presentationId }),
    idSeed: { sessionPrefix: "RoundTr1", counter: 0 },
    now: Date.now,
  });
  if (imported.kind !== "imported") throw new Error(`import: ${JSON.stringify(imported)}`);
  process.stdout.write(`imported ${imported.report.slideCount} slides, ${imported.report.elementCount} elements, ${imported.report.losses.length} losses\n`);

  // The original contentUrl of every stored picture (see the header).
  const sourceAddresses = await originalAddresses({ presentationAnswer: original.body, deckAssets: service.decks.get(deck.deckId)?.assets ?? new Map() });
  const exported = await runExport({ slides, snapshot: deck.snapshot(), target: { kind: "newPresentation" }, assetAddress: (assetId: AssetId) => sourceAddresses.get(assetId) ?? "https://invalid.example/missing.png" });
  if (exported.kind !== "exported") throw new Error(`export: ${JSON.stringify(exported)}`);
  process.stdout.write(`exported to ${exported.report.presentationAddress} with ${exported.report.requestCount} requests, ${exported.report.losses.length} losses\n`);
  for (const loss of exported.report.losses) process.stdout.write(`  loss ${loss.feature} ${loss.slideId ?? ""} ${loss.elementId ?? ""}\n`);

  const copy = await slides.getPresentation({ presentationId: exported.report.presentationId, fields: null });
  if (copy.kind !== "ok") throw new Error(`get copy failed: ${copy.message}`);
  compare({ original: parsed(original.body), copy: parsed(copy.body) });
  await thumbnails({ slides, presentation: parsed(original.body), label: "original" });
  await thumbnails({ slides, presentation: parsed(copy.body), label: "export" });
}

/** The presentation's .pptx export for the import's gradient stops, or null (then they are reported as lost). */
async function pptxExportOf(options: Readonly<{ slides: SlidesClient; presentationId: string }>): Promise<Uint8Array | null> {
  const exported = await options.slides.exportPresentationPptx({ presentationId: options.presentationId });
  if (exported.kind === "exported") return exported.bytes;
  process.stdout.write(`the .pptx export failed (HTTP ${exported.status}): ${exported.message}\n`);
  return null;
}

function parsed(body: unknown): SlidesPresentation {
  const result = parsePresentation(body);
  if (result.kind !== "ok") throw new Error(result.message);
  return result.presentation;
}

/** Slide and element counts, and frames of elements kept under the same id, within 1 unit. */
function compare(options: Readonly<{ original: SlidesPresentation; copy: SlidesPresentation }>): void {
  const { original, copy } = options;
  const scale = pageScaleFor({ widthEnglishMetricUnits: original.pageSize.widthEnglishMetricUnits, heightEnglishMetricUnits: original.pageSize.heightEnglishMetricUnits });
  process.stdout.write(`slides: original ${original.slides.length}, export ${copy.slides.length} ${original.slides.length === copy.slides.length ? "EQUAL" : "DIFFERENT"}\n`);
  let compared = 0;
  let worst = 0;
  let failures = 0;
  original.slides.forEach((slide, index) => {
    const exportedSlide = copy.slides[index];
    if (exportedSlide === undefined) return;
    const originalElements = flatten(slide.elements, IDENTITY_TRANSFORM);
    const exportedElements = new Map(flatten(exportedSlide.elements, IDENTITY_TRANSFORM).map((entry) => [entry.element.objectId, entry]));
    const countLine = `slide ${index + 1}: elements original ${slide.elements.length}, export ${exportedSlide.elements.length}`;
    process.stdout.write(`${countLine} ${slide.elements.length === exportedSlide.elements.length ? "EQUAL" : "DIFFERENT"}\n`);
    for (const entry of originalElements) {
      const twin = exportedElements.get(entry.element.objectId);
      if (twin === undefined || entry.element.content.kind === "group" || entry.element.content.kind === "line") continue;
      const before = frameForTransform({ transform: entry.transform, widthEnglishMetricUnits: entry.element.widthEnglishMetricUnits, heightEnglishMetricUnits: entry.element.heightEnglishMetricUnits, scale, minimumSize: 0 });
      const after = frameForTransform({ transform: twin.transform, widthEnglishMetricUnits: twin.element.widthEnglishMetricUnits, heightEnglishMetricUnits: twin.element.heightEnglishMetricUnits, scale, minimumSize: 0 });
      const difference = Math.max(Math.abs(before.x - after.x), Math.abs(before.y - after.y), Math.abs(before.width - after.width), Math.abs(before.height - after.height));
      compared += 1;
      worst = Math.max(worst, difference);
      if (difference > 1) {
        failures += 1;
        process.stdout.write(`  FRAME ${entry.element.objectId}: ${JSON.stringify(before)} vs ${JSON.stringify(after)}\n`);
      }
    }
  });
  process.stdout.write(`frames: ${compared} kept elements compared, worst difference ${worst.toFixed(4)} units, ${failures} over 1 unit\n`);
}

function flatten(elements: readonly SlidesPageElement[], parent: typeof IDENTITY_TRANSFORM): readonly Readonly<{ element: SlidesPageElement; transform: typeof IDENTITY_TRANSFORM }>[] {
  return elements.flatMap((element) => {
    const transform = composeTransforms({ parent, child: element.transform });
    const own = { element, transform };
    return element.content.kind === "group" ? [own, ...flatten(element.content.children, transform)] : [own];
  });
}

async function thumbnails(options: Readonly<{ slides: SlidesClient; presentation: SlidesPresentation; label: string }>): Promise<void> {
  for (const [index, slide] of options.presentation.slides.entries()) {
    const answer = await options.slides.getThumbnail({ presentationId: options.presentation.presentationId, pageObjectId: slide.objectId });
    if (answer.kind !== "ok") {
      process.stdout.write(`thumbnail ${options.label} ${index + 1} failed: ${answer.message}\n`);
      continue;
    }
    const address = stringOf({ body: answer.body, key: "contentUrl" });
    if (address.length === 0) continue;
    const image = await fetch(address);
    const path = join(SHOTS, `round-trip-${options.label}-${String(index + 1).padStart(2, "0")}.png`);
    writeFileSync(path, Buffer.from(await image.arrayBuffer()));
    process.stdout.write(`saved ${path}\n`);
  }
}

async function originalAddresses(
  options: Readonly<{ presentationAnswer: unknown; deckAssets: ReadonlyMap<string, Readonly<{ bytes: Uint8Array }>> }>,
): Promise<ReadonlyMap<AssetId, string>> {
  const addresses = new Map<AssetId, string>();
  const text = JSON.stringify(options.presentationAnswer);
  for (const match of text.matchAll(/"contentUrl":"([^"]+)"/g)) {
    const address = match[1];
    if (address === undefined) continue;
    const response = await fetch(address);
    if (!response.ok) continue;
    const digest = createHash("sha256").update(new Uint8Array(await response.arrayBuffer())).digest("hex");
    // A SHA-256 in hexadecimal is the asset id the deck stored these bytes under (testing-deck-service.ts).
    if (options.deckAssets.has(digest)) addresses.set(digest as AssetId, address);
  }
  return addresses;
}

function stringOf(options: Readonly<{ body: unknown; key: string }>): string {
  const { body, key } = options;
  if (typeof body !== "object" || body === null || !(key in body)) return "";
  const value: unknown = Object.getOwnPropertyDescriptor(body, key)?.value;
  return typeof value === "string" ? value : "";
}

main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exit(1);
});
