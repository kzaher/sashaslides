/**
 * The network half of an import: every image address fetched (within the 30 minutes Google's
 * `contentUrl`s stay valid), its media type confirmed by its first bytes, stored through
 * `DeckHandle.putAsset`, and described as the `AssetRecord` the import registers.
 *
 * A failed fetch is not a failed import (SPEC.md 21.16): it becomes `{ kind: "failed" }`, and
 * `planImport` draws a placeholder and reports a loss. The fetches run a few at a time, each with
 * its own timeout, because a deck with 80 pictures must not open 80 connections at once nor wait
 * forever on one.
 */
import type { AssetMediaType, AssetRecord } from "../engine/src/contracts/document.ts";
import type { DeckHandle } from "../deck-contracts/deck-service-contract.ts";
import type { ImportedImage } from "./import-presentation.ts";

export async function fetchImportImages(
  options: Readonly<{ addresses: readonly string[]; fetch: typeof fetch; deck: DeckHandle; accessToken: string | null }>,
): Promise<ReadonlyMap<string, ImportedImage>> {
  const results = new Map<string, ImportedImage>();
  const queue = [...options.addresses];
  const worker = async (): Promise<void> => {
    for (let address = queue.shift(); address !== undefined; address = queue.shift()) {
      results.set(address, await fetchOne({ ...options, address }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, queue.length) }, worker));
  return results;
}

/** The media type and pixel size a picture's first bytes declare; null when it is none of the five. */
export function sniffImage(bytes: Uint8Array): Readonly<{ mediaType: AssetMediaType; pixelWidth: number; pixelHeight: number }> | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]) && bytes.length >= 24) {
    return { mediaType: "image/png", pixelWidth: bigEndian32(bytes, 16), pixelHeight: bigEndian32(bytes, 20) };
  }
  if (startsWith(bytes, [0xff, 0xd8])) return { mediaType: "image/jpeg", ...jpegSize(bytes) };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && bytes.length >= 10) {
    return { mediaType: "image/gif", pixelWidth: littleEndian16(bytes, 6), pixelHeight: littleEndian16(bytes, 8) };
  }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === "WEBP") return { mediaType: "image/webp", ...webpSize(bytes) };
  const head = ascii(bytes, 0, Math.min(bytes.length, 512)).trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return { mediaType: "image/svg+xml", pixelWidth: 1, pixelHeight: 1 };
  return null;
}

const IMAGE_FETCH_CONCURRENCY = 4;
const IMAGE_FETCH_TIMEOUT_MILLISECONDS = 20_000;

async function fetchOne(
  options: Readonly<{ address: string; fetch: typeof fetch; deck: DeckHandle; accessToken: string | null }>,
): Promise<ImportedImage> {
  let bytes: Uint8Array;
  try {
    // Google's content addresses are signed and need no credential; sending the grant's token to
    // them anyway is what a private Drive picture needs, and it never leaves googleusercontent.
    const authorised = options.accessToken !== null && isGoogleContentAddress(options.address);
    const response = await options.fetch(options.address, {
      ...(authorised ? { headers: { authorization: `Bearer ${options.accessToken}` } } : {}),
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MILLISECONDS),
    });
    if (!response.ok) return { kind: "failed", message: `HTTP ${response.status}` };
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    return { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) };
  }
  const sniffed = sniffImage(bytes);
  if (sniffed === null) return { kind: "failed", message: "not a PNG, JPEG, GIF, WebP or SVG picture" };
  const stored = await options.deck.putAsset({ bytes, mediaType: sniffed.mediaType });
  switch (stored.kind) {
    case "stored": {
      const asset: AssetRecord = {
        id: stored.assetId,
        mediaType: sniffed.mediaType,
        pixelWidth: Math.max(1, sniffed.pixelWidth),
        pixelHeight: Math.max(1, sniffed.pixelHeight),
        name: nameOf(options.address),
        byteLength: stored.byteLength,
      };
      return { kind: "stored", asset };
    }
    case "tooLarge":
      return { kind: "failed", message: stored.message };
    case "notPermitted":
      return { kind: "failed", message: "the deck refused the picture" };
    default:
      return assertNever(stored);
  }
}

function isGoogleContentAddress(address: string): boolean {
  try {
    return new URL(address).hostname.endsWith(".googleusercontent.com");
  } catch {
    return false;
  }
}

function nameOf(address: string): string {
  try {
    const path = new URL(address).pathname;
    const last = path.split("/").filter((part) => part.length > 0).pop();
    return last !== undefined && last.length <= 80 && /\.[a-z0-9]{2,4}$/i.test(last) ? last : "Imported picture";
  } catch {
    return "Imported picture";
  }
}

function jpegSize(bytes: Uint8Array): Readonly<{ pixelWidth: number; pixelHeight: number }> {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return { pixelWidth: 1, pixelHeight: 1 };
    const marker = bytes[offset + 1] ?? 0;
    const length = (bytes[offset + 2] ?? 0) * 256 + (bytes[offset + 3] ?? 0);
    // SOF0 to SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { pixelHeight: (bytes[offset + 5] ?? 0) * 256 + (bytes[offset + 6] ?? 0), pixelWidth: (bytes[offset + 7] ?? 0) * 256 + (bytes[offset + 8] ?? 0) };
    }
    offset += 2 + length;
  }
  return { pixelWidth: 1, pixelHeight: 1 };
}

function webpSize(bytes: Uint8Array): Readonly<{ pixelWidth: number; pixelHeight: number }> {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return { pixelWidth: 1 + littleEndian24(bytes, 24), pixelHeight: 1 + littleEndian24(bytes, 27) };
  }
  if (chunk === "VP8 " && bytes.length >= 30) {
    return { pixelWidth: littleEndian16(bytes, 26) & 0x3fff, pixelHeight: littleEndian16(bytes, 28) & 0x3fff };
  }
  if (chunk === "VP8L" && bytes.length >= 25) {
    const bits = (bytes[21] ?? 0) | ((bytes[22] ?? 0) << 8) | ((bytes[23] ?? 0) << 16) | ((bytes[24] ?? 0) << 24);
    return { pixelWidth: (bits & 0x3fff) + 1, pixelHeight: ((bits >> 14) & 0x3fff) + 1 };
  }
  return { pixelWidth: 1, pixelHeight: 1 };
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function bigEndian32(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)) >>> 0;
}

function littleEndian16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function littleEndian24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
