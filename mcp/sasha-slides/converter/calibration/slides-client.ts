/**
 * slides-client.ts — the one place the calibration scripts touch Google.
 *
 * Auth is the developer grant every devcontainer harness shares
 * (`renderer/html2slides/dev-google-auth.ts`). Nothing here is part of the shipped converter —
 * the converter itself never sees a credential; it only ever *builds* request bodies.
 */
import { google } from "googleapis";
import type { drive_v3, slides_v1 } from "googleapis";
import { loadDevOAuthClient } from "../../../../renderer/html2slides/dev-google-auth.ts";
import type { SlidesApiRequest } from "../slides-api.js";

export type SlidesClient = Readonly<{
  slides: slides_v1.Slides;
  deletePresentation: (presentationId: string) => Promise<void>;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export function slidesClient(): SlidesClient {
  const auth = loadDevOAuthClient({ persistRefreshedTokens: false });
  const slides = google.slides({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });
  return {
    slides,
    deletePresentation: async (presentationId: string): Promise<void> => {
      await drive.files.delete({ fileId: presentationId });
    },
  };
}

/**
 * The converter's `SlidesApiRequest` is a hand-written mirror of the wire format
 * (see slides-api.ts for why it cannot import googleapis' types). googleapis'
 * `Schema$Request` declares every field optional and nullable, so the two are
 * structurally compatible on the wire but not assignable to each other. This is
 * the single boundary where the converter's view is handed to the SDK; the
 * requests go out as JSON either way, so the cast asserts nothing about runtime
 * behaviour beyond "these field names are the REST field names", which is the
 * documented contract of slides-api.ts.
 */
export function asApiRequests(requests: readonly SlidesApiRequest[]): slides_v1.Schema$Request[] {
  return requests as unknown as slides_v1.Schema$Request[];
}

export type ApiFailure = Readonly<{
  /** The index inside the submitted array, when the API named one. */
  requestIndex: number | null;
  /** The API's own message, verbatim. */
  message: string;
  status: number | null;
}>;

/** Pull the API's own words out of a thrown Gaxios error. */
export function describeApiError(cause: unknown): ApiFailure {
  const record = asRecord(cause);
  const response = record === null ? null : asRecord(record["response"]);
  const data = response === null ? null : asRecord(response["data"]);
  const error = data === null ? null : asRecord(data["error"]);
  const apiMessage = error === null ? undefined : error["message"];
  const apiStatus = error === null ? undefined : error["code"];
  const fallback = cause instanceof Error ? cause.message : String(cause);
  const message = typeof apiMessage === "string" ? apiMessage : fallback;
  const match = /requests\[(\d+)\]/.exec(message);
  return {
    requestIndex: match === null ? null : Number(match[1]),
    message,
    status: typeof apiStatus === "number" ? apiStatus : null,
  };
}

/** `presentations.batchUpdate`, with the API's error text surfaced instead of a stack. */
export async function applyBatch(
  options: Readonly<{
    client: SlidesClient;
    presentationId: string;
    requests: readonly SlidesApiRequest[];
  }>,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; failure: ApiFailure }>> {
  try {
    await options.client.slides.presentations.batchUpdate({
      presentationId: options.presentationId,
      requestBody: { requests: asApiRequests(options.requests) },
    });
    return { ok: true };
  } catch (cause) {
    return { ok: false, failure: describeApiError(cause) };
  }
}

export type Rejection = Readonly<{
  /** The refused request's operation name, or `<whole batch>` when the API named no index. */
  kind: string;
  /** The refused request's field mask, when it carries one. */
  fields: string | null;
  message: string;
  status: number | null;
}>;

/**
 * What to do when the API refuses a batch without naming a request index:
 * `stop` reports the whole batch as refused (roundtrip: an honest "BATCH FAILED");
 * `dropLast` drops the last request and goes on (sxs-candidates: a partial slide is still
 * worth photographing).
 */
export type UnnamedRejection = "stop" | "dropLast";

/**
 * `batchUpdate` is atomic, so a single bad request hides every other verdict in
 * the batch. The API names the offending index, so dropping it and resubmitting
 * walks the whole batch and ends with the maximal accepted subset plus one
 * recorded rejection per failure. Bounded by the request count: every pass either
 * applies or removes exactly one request.
 */
export async function applyWithDrops(
  options: Readonly<{
    client: SlidesClient;
    presentationId: string;
    requests: readonly SlidesApiRequest[];
    onUnnamedRejection: UnnamedRejection;
  }>,
): Promise<Readonly<{ applied: boolean; survivors: readonly SlidesApiRequest[]; rejections: readonly Rejection[] }>> {
  const { client, presentationId } = options;
  let survivors = [...options.requests];
  const rejections: Rejection[] = [];
  for (let attempt = 0; attempt <= options.requests.length; attempt++) {
    if (survivors.length === 0) return { applied: true, survivors, rejections };
    const outcome = await applyBatch({ client, presentationId, requests: survivors });
    if (outcome.ok) return { applied: true, survivors, rejections };
    const { failure } = outcome;
    const named = failure.requestIndex;
    const inRange = named !== null && named >= 0 && named < survivors.length;
    if (!inRange && options.onUnnamedRejection === "stop") {
      rejections.push({ kind: "<whole batch>", fields: null, message: failure.message, status: failure.status });
      return { applied: false, survivors, rejections };
    }
    const index = inRange ? named : survivors.length - 1;
    // SAFETY: index is either bounds-checked above or the last element of a non-empty array.
    const offender = survivors[index]!;
    rejections.push({ kind: kindOf(offender), fields: fieldMaskOf(offender), message: failure.message, status: failure.status });
    survivors = [...survivors.slice(0, index), ...survivors.slice(index + 1)];
  }
  return { applied: false, survivors, rejections };
}

function fieldMaskOf(request: SlidesApiRequest): string | null {
  const body = asRecord(Object.values(request)[0]);
  const fields = body === null ? undefined : body["fields"];
  return typeof fields === "string" ? fields : null;
}

/** A Drive handle on the same credentials, for the leftover audit. */
export function googleDrive(): drive_v3.Drive {
  return google.drive({ version: "v3", auth: loadDevOAuthClient({ persistRefreshedTokens: false }) });
}

/** The single operation name a request carries, e.g. `createShape`. */
export function kindOf(request: SlidesApiRequest): string {
  return Object.keys(request)[0] ?? "<empty>";
}
