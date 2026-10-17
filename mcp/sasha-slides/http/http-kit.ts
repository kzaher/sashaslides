/**
 * The HTTP edges every route shares: reading a request body under a size limit, the request's
 * media type and bearer token, and writing JSON answers, `DeckApiErrorBody` errors (deck-api.ts:
 * every non-2xx deck answer carries one) and redirects. Also the narrow `fetch` seam the modules
 * that call Google and the sign-in providers are given, so their tests can play the far side.
 *
 * Each caller keeps its own limit and overflow policy, because the difference is observable:
 * `destroy` drops the connection the moment a body passes its limit (nothing more is read, and
 * the answer may never arrive), while `drain` reads to the end so the 413 can still be read.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeckApiErrorBody, DeckApiErrorCode } from "../engine/src/contracts/deck-api.ts";

/** The narrow slice of `fetch` the outbound modules use. The global `fetch` satisfies it. */
export type HttpFetch = (url: string, init: HttpFetchInit) => Promise<HttpFetchResponse>;

export type HttpFetchInit = Readonly<{
  method: "GET" | "POST" | "PATCH";
  headers: Readonly<Record<string, string>>;
  body?: string;
  signal: AbortSignal;
}>;

export type HttpFetchResponse = Readonly<{ status: number; json(): Promise<unknown> }>;

/** A JSON object as one base64url segment, as a signed JWT's header and claims are sent. */
export function jsonSegment(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

export type BodyOverflow = "destroy" | "drain";

export type BodyLimit = Readonly<{ request: IncomingMessage; maximumBytes: number; onOverflow: BodyOverflow }>;

export type BodyBytes = Readonly<{ kind: "ok"; bytes: Buffer }> | Readonly<{ kind: "tooLarge" }>;

export function readBody(options: BodyLimit): Promise<BodyBytes> {
  const { request, maximumBytes, onOverflow } = options;
  return new Promise<BodyBytes>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total <= maximumBytes) {
        chunks.push(chunk);
        return;
      }
      if (onOverflow === "destroy") {
        request.destroy();
        resolve({ kind: "tooLarge" });
      }
    });
    request.on("end", () => resolve(total > maximumBytes ? { kind: "tooLarge" } : { kind: "ok", bytes: Buffer.concat(chunks) }));
    request.on("error", reject);
  });
}

/** The body as UTF-8 text, or null when it exceeds the limit. */
export async function readBodyText(options: BodyLimit): Promise<string | null> {
  const body = await readBody(options);
  return body.kind === "ok" ? body.bytes.toString("utf-8") : null;
}

export type JsonBodyRead = Readonly<{ kind: "parsed"; value: unknown }> | Readonly<{ kind: "tooLarge" }> | Readonly<{ kind: "invalid" }>;

export async function readJsonBody(options: BodyLimit): Promise<JsonBodyRead> {
  const body = await readBody(options);
  if (body.kind === "tooLarge") return body;
  try {
    return { kind: "parsed", value: JSON.parse(body.bytes.toString("utf-8")) };
  } catch {
    return { kind: "invalid" };
  }
}

/** The media type without its parameters, lowercased: `application/json; charset=utf-8` -> `application/json`. */
export function mediaTypeOf(request: IncomingMessage): string | null {
  const header = request.headers["content-type"];
  if (typeof header !== "string") return null;
  return header.split(";")[0]?.trim().toLowerCase() ?? null;
}

export function sendJson(
  options: Readonly<{
    response: ServerResponse;
    status: number;
    body: unknown;
    headers?: Readonly<Record<string, string>>;
    cookies?: readonly string[];
  }>,
): void {
  const text = JSON.stringify(options.body);
  options.response.writeHead(options.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(options.headers ?? {}),
    "content-length": String(Buffer.byteLength(text, "utf-8")),
    ...(options.cookies === undefined || options.cookies.length === 0 ? {} : { "set-cookie": [...options.cookies] }),
  });
  options.response.end(text);
}

export function sendDeckApiError(
  options: Readonly<{
    response: ServerResponse;
    status: number;
    error: DeckApiErrorCode;
    message: string;
    connectAddress?: string;
    signInAddress?: string;
    cookies?: readonly string[];
  }>,
): void {
  const body: DeckApiErrorBody = {
    error: options.error,
    message: options.message,
    signInAddress: options.signInAddress ?? null,
    connectAddress: options.connectAddress ?? null,
    retryAfterSeconds: null,
  };
  sendJson({ response: options.response, status: options.status, body, cookies: options.cookies ?? [] });
}

export function redirect(options: Readonly<{ response: ServerResponse; location: string }>): void {
  options.response.writeHead(303, { location: options.location, "cache-control": "no-store" });
  options.response.end();
}
