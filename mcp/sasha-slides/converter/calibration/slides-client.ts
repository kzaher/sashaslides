/**
 * slides-client.ts — the one place the calibration scripts touch Google.
 *
 * Auth is loaded exactly as `.auth/check-auth.ts` loads it: the Desktop-client
 * JSON plus the stored token, narrowed by explicit guards because both files are
 * untrusted input. Nothing here is part of the shipped converter — the converter
 * itself never sees a credential; it only ever *builds* request bodies.
 */
import { google } from "googleapis";
import type { drive_v3, slides_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { readFileSync } from "node:fs";
import type { SlidesApiRequest } from "../slides-api.js";

const CLIENT_PATH = "/workspaces/sashaslides/.auth/google_oauth.json";
const TOKENS_PATH = "/workspaces/sashaslides/.auth/tokens.json";

export type SlidesClient = Readonly<{
  slides: slides_v1.Slides;
  deletePresentation: (presentationId: string) => Promise<void>;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readJsonObject(path: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  const record = asRecord(parsed);
  if (record === null) throw new Error(`${path}: top level is not an object`);
  return record;
}

function oauthClient(): OAuth2Client {
  const clientFile = readJsonObject(CLIENT_PATH);
  const section = asRecord(clientFile["installed"]) ?? asRecord(clientFile["web"]);
  if (section === null) throw new Error(`${CLIENT_PATH}: no "installed"/"web" section`);
  const id = section["client_id"];
  const secret = section["client_secret"];
  if (typeof id !== "string" || typeof secret !== "string") {
    throw new Error(`${CLIENT_PATH}: client_id/client_secret missing`);
  }
  const auth = new google.auth.OAuth2(id, secret, "http://localhost:8080");
  auth.setCredentials(readJsonObject(TOKENS_PATH));
  return auth;
}

export function slidesClient(): SlidesClient {
  const auth = oauthClient();
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

/** A Drive handle on the same credentials, for the leftover audit. */
export function googleDrive(): drive_v3.Drive {
  return google.drive({ version: "v3", auth: oauthClient() });
}

/** The single operation name a request carries, e.g. `createShape`. */
export function kindOf(request: SlidesApiRequest): string {
  return Object.keys(request)[0] ?? "<empty>";
}
