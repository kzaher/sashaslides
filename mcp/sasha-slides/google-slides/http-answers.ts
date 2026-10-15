/**
 * The HTTP edges of the Google Slides routes: reading a JSON body under a size limit, and writing
 * JSON answers and `DeckApiErrorBody` errors (deck-api.ts: every non-2xx answer carries one).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeckApiErrorBody, DeckApiErrorCode } from "../engine/src/contracts/deck-api.ts";

export type BodyRead = Readonly<{ kind: "parsed"; value: unknown }> | Readonly<{ kind: "tooLarge" }> | Readonly<{ kind: "invalid" }>;

export async function readRequestBody(options: Readonly<{ request: IncomingMessage; maximumBytes: number }>): Promise<BodyRead> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of options.request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > options.maximumBytes) return { kind: "tooLarge" };
    chunks.push(buffer);
  }
  try {
    return { kind: "parsed", value: JSON.parse(Buffer.concat(chunks).toString("utf-8")) };
  } catch {
    return { kind: "invalid" };
  }
}

export function answerWithBody(options: Readonly<{ response: ServerResponse; status: number; body: unknown }>): void {
  options.response.writeHead(options.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  options.response.end(JSON.stringify(options.body));
}

export function answerError(
  options: Readonly<{ response: ServerResponse; status: number; error: DeckApiErrorCode; message: string; connectAddress?: string; signInAddress?: string }>,
): void {
  const body: DeckApiErrorBody = {
    error: options.error,
    message: options.message,
    signInAddress: options.signInAddress ?? null,
    connectAddress: options.connectAddress ?? null,
    retryAfterSeconds: null,
  };
  answerWithBody({ response: options.response, status: options.status, body });
}

export function redirect(options: Readonly<{ response: ServerResponse; location: string }>): void {
  options.response.writeHead(303, { location: options.location, "cache-control": "no-store" });
  options.response.end();
}

/** A string field of a parsed JSON object, or null. */
export function stringFieldOf(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof field === "string" ? field : null;
}

/** A field of a parsed JSON object as `unknown`, or undefined. */
export function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
