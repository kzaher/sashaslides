/**
 * FETCHING AN IMAGE FOR `addImage`. The connector fetches a model-chosen address on the user's
 * behalf, so the fetch is the dangerous part of `deck_edit`:
 *
 *  - HTTPS ONLY, to a public host. A model can be talked into any address by text it reads, so a
 *    plain-http address, an IP literal in a private, loopback or link-local range and `localhost`
 *    are refused before anything is sent (a redirect is checked the same way, by refusing to follow
 *    one: `redirect: "error"`). This is not a defence against DNS that resolves a public name to a
 *    private address; the connector runs in a container with no other service reachable over
 *    https, which is what keeps that case harmless.
 *  - AT MOST `COLLABORATION_LIMITS.maximumAssetBytes`: a declared length over it is refused without
 *    reading, and the body is read in chunks and abandoned the moment it passes the limit, so a
 *    lying or absent `Content-Length` cannot make the server buffer more.
 *  - THE MEDIA TYPE COMES FROM THE BYTES (magic numbers), never from the response header: a PNG
 *    served as `image/jpeg` is a PNG, and an HTML page served as `image/png` is refused.
 *
 * The intrinsic pixel size is read from the header bytes too, for the element's default frame and
 * the `AssetRecord`.
 */
import { COLLABORATION_LIMITS } from "../engine/src/contracts/collaboration.ts";
import type { AssetMediaType } from "../engine/src/contracts/document.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

export type FetchedImage =
  | Readonly<{ kind: "fetched"; bytes: Uint8Array; mediaType: AssetMediaType; pixelWidth: number; pixelHeight: number; name: string }>
  | Readonly<{ kind: "refused"; reason: string }>;

export async function fetchImageSource(options: Readonly<{ source: string; fetch: typeof fetch }>): Promise<FetchedImage> {
  const maximumBytes = COLLABORATION_LIMITS.maximumAssetBytes;
  const address = parseAddress(options.source);
  if (address === null) return { kind: "refused", reason: `not an address: ${JSON.stringify(options.source)}` };
  if (address.protocol !== "https:") return { kind: "refused", reason: `images are fetched over https only, not ${address.protocol.replace(/:$/u, "")}` };
  if (isPrivateHost(address.hostname)) return { kind: "refused", reason: `${address.hostname} is not a public host` };
  let response: Response;
  try {
    response = await options.fetch(address.href, { redirect: "error", headers: { accept: "image/*" } });
  } catch (cause: unknown) {
    return { kind: "refused", reason: `the image could not be fetched: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  if (!response.ok) return discard({ response, reason: `the image address answered ${String(response.status)}` });
  const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) return discard({ response, reason: tooLargeReason(maximumBytes) });
  const bytes = await readAtMost({ response, maximumBytes });
  if (bytes === null) return { kind: "refused", reason: tooLargeReason(maximumBytes) };
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === null) return { kind: "refused", reason: "the address did not return a PNG, JPEG, GIF, WebP or SVG image" };
  const size = imagePixelSize({ bytes, mediaType }) ?? FALLBACK_PIXEL_SIZE;
  return { kind: "fetched", bytes, mediaType, pixelWidth: size.width, pixelHeight: size.height, name: nameOf(address) };
}

/** The media type the bytes ARE, by their first bytes; null for anything else. */
export function sniffImageMediaType(bytes: Uint8Array): AssetMediaType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes.subarray(8), ascii("WEBP"))) return "image/webp";
  if (looksLikeVectorGraphics(bytes)) return "image/svg+xml";
  return null;
}

/** Intrinsic size from the image header; null when the header does not say. */
export function imagePixelSize(options: Readonly<{ bytes: Uint8Array; mediaType: AssetMediaType }>): Readonly<{ width: number; height: number }> | null {
  const { bytes } = options;
  switch (options.mediaType) {
    case "image/png":
      return positive({ width: readUint32BigEndian(bytes, 16), height: readUint32BigEndian(bytes, 20) });
    case "image/gif":
      return positive({ width: readUint16LittleEndian(bytes, 6), height: readUint16LittleEndian(bytes, 8) });
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    case "image/svg+xml":
      return vectorGraphicsSize(bytes);
    default:
      return assertNever(options.mediaType);
  }
}

/** When a header does not say (an SVG with only percentages), a 4:3 box the frame fit can scale. */
const FALLBACK_PIXEL_SIZE = { width: 800, height: 600 } as const;

const PNG_SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function parseAddress(source: string): URL | null {
  try {
    return new URL(source);
  } catch {
    // An unparseable address is a refusal the caller reports, not an error.
    return null;
  }
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return true;
  const octets = host.split(".");
  if (octets.length === 4 && octets.every((octet) => /^\d{1,3}$/u.test(octet))) {
    const [first = 0, second = 0] = octets.map(Number);
    return first === 10 || first === 127 || first === 0 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127);
  }
  if (host.includes(":")) return host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host.startsWith("::ffff:");
  return false;
}

/** A refusal that also releases the unread body, so its connection is not left open. */
function discard(options: Readonly<{ response: Response; reason: string }>): FetchedImage {
  void options.response.body?.cancel().catch(() => undefined);
  return { kind: "refused", reason: options.reason };
}

function tooLargeReason(maximumBytes: number): string {
  return `the image is larger than ${String(Math.round(maximumBytes / (1024 * 1024)))} megabytes`;
}

/** The body, or null as soon as it passes `maximumBytes` (the rest is never read). */
async function readAtMost(options: Readonly<{ response: Response; maximumBytes: number }>): Promise<Uint8Array | null> {
  const body = options.response.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > options.maximumBytes) return null;
      chunks.push(next.value);
    }
  } finally {
    // Releases the connection on every path, including the early return past the limit.
    void reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function nameOf(address: URL): string {
  const last = address.pathname.split("/").filter((segment) => segment !== "").at(-1);
  if (last === undefined) return address.hostname;
  try {
    return decodeURIComponent(last).slice(0, 200);
  } catch {
    // A malformed escape in a file name: keep it as written.
    return last.slice(0, 200);
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((value, index) => bytes[index] === value);
}

function ascii(text: string): readonly number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

/** An XML or SVG document whose first element is `<svg`, after a byte-order mark, declarations and comments. */
function looksLikeVectorGraphics(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096)).replace(/^﻿/u, "");
  const withoutPreamble = head.replace(/^(\s*(<\?xml[^>]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>))*\s*/iu, "");
  return /^<svg[\s>]/iu.test(withoutPreamble);
}

function positive(size: Readonly<{ width: number | null; height: number | null }>): Readonly<{ width: number; height: number }> | null {
  if (size.width === null || size.height === null || size.width <= 0 || size.height <= 0) return null;
  return { width: size.width, height: size.height };
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, false);
}

function readUint16LittleEndian(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

/** Walks the JPEG segments to the first start-of-frame marker, which holds height then width. */
function jpegSize(bytes: Uint8Array): Readonly<{ width: number; height: number }> | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    const segmentLength = readUint16BigEndian(bytes, offset + 2);
    if (segmentLength === null) return null;
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) return positive({ height: readUint16BigEndian(bytes, offset + 5), width: readUint16BigEndian(bytes, offset + 7) });
    offset += 2 + segmentLength;
  }
  return null;
}

/** The three WebP flavours keep their size in different places. */
function webpSize(bytes: Uint8Array): Readonly<{ width: number; height: number }> | null {
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  switch (chunk) {
    case "VP8 ": {
      const width = readUint16LittleEndian(bytes, 26);
      const height = readUint16LittleEndian(bytes, 28);
      return positive({ width: width === null ? null : width & 0x3fff, height: height === null ? null : height & 0x3fff });
    }
    case "VP8L": {
      if (bytes.length < 25) return null;
      const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24);
      return positive({ width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 });
    }
    case "VP8X": {
      if (bytes.length < 30) return null;
      const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
      const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
      return positive({ width, height });
    }
    default:
      return null;
  }
}

/** `width`/`height` attributes in plain numbers or px, else the `viewBox`. */
function vectorGraphicsSize(bytes: Uint8Array): Readonly<{ width: number; height: number }> | null {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
  const tag = /<svg\b[^>]*>/iu.exec(head)?.[0] ?? "";
  const attribute = (name: string): number | null => {
    const match = new RegExp(`\\s${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, "iu").exec(tag);
    return match?.[1] === undefined ? null : Number(match[1]);
  };
  const fromAttributes = positive({ width: attribute("width"), height: attribute("height") });
  if (fromAttributes !== null) return fromAttributes;
  const viewBox = /\sviewBox\s*=\s*["']\s*[-0-9.]+[\s,]+[-0-9.]+[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/iu.exec(tag);
  return viewBox === null ? null : positive({ width: Number(viewBox[1]), height: Number(viewBox[2]) });
}
