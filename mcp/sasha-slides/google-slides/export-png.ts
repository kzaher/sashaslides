/**
 * export-png.ts — the person's presentation as one PNG per slide, zipped, with their own grant.
 *
 *   presentations.get (page ids and "Skip slide" only) -> the selected pages ->
 *   per page: pages.getThumbnail (LARGE, PNG) -> fetch its short-lived `contentUrl` ->
 *   a stored zip of `slide-NN.png`, NN being the slide's number in the presentation.
 *
 * PACING. `getThumbnail` counts against Google's "expensive read requests per minute" quota
 * (CLAUDE.md: about 60 a minute before it throttles), so the calls are spaced about one second
 * apart through an injected `sleep` (tests pass one that only advances a virtual clock). A 429 is
 * retried after a short backoff, twice; any other failure ends the export at once.
 */
import type { DeckApiErrorCode } from "../engine/src/contracts/deck-api.ts";
import { EXPORT_PNG_LIMITS, type ExportPngRequestBody } from "./insert-html-contract.ts";
import { googleFailureCodeOf, httpStatusOfGoogleFailure, presentationIdFrom, type SlidesClient } from "./slides-client.ts";
import type { StoredZipEntry } from "./stored-zip.ts";

export type ParsedExportPng = Readonly<{ presentationId: string; from: number | null; to: number | null; skipHidden: boolean }>;

export type ExportPngParse = Readonly<{ kind: "ok"; request: ParsedExportPng }> | Readonly<{ kind: "invalid"; message: string }>;

export type ExportPngOutcome =
  | Readonly<{ kind: "exported"; entries: readonly StoredZipEntry[] }>
  /** `status` is the HTTP status to answer with. */
  | Readonly<{ kind: "failed"; status: number; code: DeckApiErrorCode; message: string }>;

/** Spacing between thumbnail calls, and the backoff schedule after a 429. */
export const EXPORT_PNG_PACING = { intervalMilliseconds: 1_000, backoffMilliseconds: [2_000, 4_000] } as const;

/** The body the page sent (ExportPngRequestBody), re-validated. */
export function parseExportPngBody(body: unknown): ExportPngParse {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { kind: "invalid", message: "The request is not a JSON export request." };
  // A JSON.parse result that is a non-null, non-array object: its own keys are its fields.
  const record = body as Readonly<Record<string, unknown>>;
  const allowed: readonly (keyof ExportPngRequestBody)[] = ["presentation", "from", "to", "skipHidden"];
  const unknownKey = Object.keys(record).find((key) => !allowed.some((name) => name === key));
  if (unknownKey !== undefined) return { kind: "invalid", message: `The field \`${unknownKey.slice(0, 60)}\` is not allowed.` };
  const presentation = record["presentation"];
  const presentationId = typeof presentation === "string" && presentation.length <= 2048 ? presentationIdFrom(presentation) : null;
  if (presentationId === null) return { kind: "invalid", message: "That is not a Google Slides address or presentation id." };
  const from = slideNumberOf(record["from"]);
  const to = slideNumberOf(record["to"]);
  if (from === undefined || to === undefined) return { kind: "invalid", message: "`from` and `to` must be slide numbers from 1, or null." };
  if (from !== null && to !== null && from > to) return { kind: "invalid", message: "`from` must not be after `to`." };
  const skipHidden = record["skipHidden"];
  if (typeof skipHidden !== "boolean") return { kind: "invalid", message: "`skipHidden` must be true or false." };
  return { kind: "ok", request: { presentationId, from, to, skipHidden } };
}

/** The pages to export, by slide number, from a `presentations.get` answer. */
export function selectExportPages(
  options: Readonly<{ presentation: unknown; request: ParsedExportPng }>,
): Readonly<{ kind: "ok"; pages: readonly Readonly<{ slideNumber: number; pageObjectId: string }>[] }> | Readonly<{ kind: "invalid"; message: string }> {
  const { request } = options;
  const slides = fieldOf(options.presentation, "slides");
  const all = Array.isArray(slides) ? slides : [];
  const first = request.from ?? 1;
  const last = request.to ?? all.length;
  if (all.length === 0) return { kind: "invalid", message: "The presentation has no slides." };
  if (first > all.length || last > all.length) return { kind: "invalid", message: `The presentation has ${all.length} slides.` };
  const pages: Readonly<{ slideNumber: number; pageObjectId: string }>[] = [];
  for (let slideNumber = first; slideNumber <= last; slideNumber++) {
    const slide: unknown = all[slideNumber - 1];
    const pageObjectId = fieldOf(slide, "objectId");
    if (typeof pageObjectId !== "string") return { kind: "invalid", message: `Slide ${slideNumber} has no page id.` };
    if (request.skipHidden && fieldOf(fieldOf(slide, "slideProperties"), "isSkipped") === true) continue;
    pages.push({ slideNumber, pageObjectId });
  }
  if (pages.length === 0) return { kind: "invalid", message: "No slide is left to export." };
  if (pages.length > EXPORT_PNG_LIMITS.maximumSlides) return { kind: "invalid", message: `At most ${EXPORT_PNG_LIMITS.maximumSlides} slides can be exported at once; choose a range.` };
  return { kind: "ok", pages };
}

export async function runExportPng(
  options: Readonly<{ slides: SlidesClient; fetch: typeof fetch; request: ParsedExportPng; now: () => number; sleep: (milliseconds: number) => Promise<void> }>,
): Promise<ExportPngOutcome> {
  const { slides, request } = options;
  const read = await slides.getPresentation({ presentationId: request.presentationId, fields: "slides(objectId,slideProperties(isSkipped))" });
  if (read.kind === "failed") return googleFailure(read);
  const selected = selectExportPages({ presentation: read.body, request });
  if (selected.kind === "invalid") return { kind: "failed", status: 400, code: "invalidRequest", message: selected.message };
  const width = Math.max(2, String(selected.pages.at(-1)?.slideNumber ?? 0).length);
  const pace = pacer({ now: options.now, sleep: options.sleep });
  const entries: StoredZipEntry[] = [];
  for (const page of selected.pages) {
    const thumbnail = await thumbnailWithBackoff({ slides, presentationId: request.presentationId, pageObjectId: page.pageObjectId, pace, sleep: options.sleep });
    if (thumbnail.kind === "failed") return { ...thumbnail, message: `Slide ${page.slideNumber}: ${thumbnail.message}` };
    const contentUrl = fieldOf(thumbnail.body, "contentUrl");
    if (typeof contentUrl !== "string" || !contentUrl.startsWith("https://")) return { kind: "failed", status: 502, code: "googleFailed", message: `Slide ${page.slideNumber}: Google answered without a picture address.` };
    const picture = await downloadPng({ fetch: options.fetch, address: contentUrl });
    if (picture.kind === "failed") return { kind: "failed", status: 502, code: "googleFailed", message: `Slide ${page.slideNumber}: ${picture.message}` };
    entries.push({ name: `slide-${String(page.slideNumber).padStart(width, "0")}.png`, bytes: picture.bytes });
  }
  return { kind: "exported", entries };
}

function slideNumberOf(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100_000 ? value : undefined;
}

function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

type Failed = Readonly<{ kind: "failed"; status: number; code: DeckApiErrorCode; message: string }>;

function googleFailure(answer: Readonly<{ status: number; message: string }>): Failed {
  const code = googleFailureCodeOf(answer.status);
  return { kind: "failed", status: httpStatusOfGoogleFailure(code), code, message: answer.message };
}

/** Waits until at least one interval has passed since the previous call it let through. */
function pacer(options: Readonly<{ now: () => number; sleep: (milliseconds: number) => Promise<void> }>): () => Promise<void> {
  let previous: number | null = null;
  return async () => {
    if (previous !== null) {
      const wait = previous + EXPORT_PNG_PACING.intervalMilliseconds - options.now();
      if (wait > 0) await options.sleep(wait);
    }
    previous = options.now();
  };
}

async function thumbnailWithBackoff(
  options: Readonly<{ slides: SlidesClient; presentationId: string; pageObjectId: string; pace: () => Promise<void>; sleep: (milliseconds: number) => Promise<void> }>,
): Promise<Readonly<{ kind: "ok"; body: unknown }> | Failed> {
  for (let attempt = 0; ; attempt++) {
    await options.pace();
    const answer = await options.slides.getThumbnail({ presentationId: options.presentationId, pageObjectId: options.pageObjectId });
    if (answer.kind === "ok") return answer;
    if (answer.status !== 429) return googleFailure(answer);
    const backoff = EXPORT_PNG_PACING.backoffMilliseconds[attempt];
    if (backoff === undefined) return { kind: "failed", status: 429, code: "rateLimited", message: "Google is limiting thumbnail requests; try again in a minute." };
    await options.sleep(backoff);
  }
}

/** A thumbnail is a few hundred kilobytes; this is far past any real one. */
const MAXIMUM_THUMBNAIL_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MILLISECONDS = 30_000;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** The `contentUrl` is short-lived and unauthenticated: no Authorization header goes with it. */
async function downloadPng(options: Readonly<{ fetch: typeof fetch; address: string }>): Promise<Readonly<{ kind: "ok"; bytes: Uint8Array }> | Readonly<{ kind: "failed"; message: string }>> {
  let response: Response;
  try {
    response = await options.fetch(options.address, { method: "GET", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MILLISECONDS) });
  } catch (cause) {
    return { kind: "failed", message: `the picture could not be downloaded: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (!response.ok) return { kind: "failed", message: `the picture could not be downloaded (HTTP ${response.status}).` };
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAXIMUM_THUMBNAIL_BYTES) return { kind: "failed", message: "the picture is unexpectedly large." };
  if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return { kind: "failed", message: "the picture is not a PNG." };
  return { kind: "ok", bytes };
}
