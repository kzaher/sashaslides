/**
 * placeholder-image.ts — the replacement for every image, and the header reader that sizes it.
 *
 * An image is never passed through, re-encoded, downscaled or blurred: it is DISCARDED and a
 * drawing is generated in its place. A photograph can carry a face, a whiteboard, a monitor, an
 * EXIF location or a thumbnail of a different photograph, and no amount of processing makes it
 * safe to send, so the only defensible rule is that the original bytes never reach the output.
 *
 * What has to survive is the GEOMETRY, because that is what reproduces a layout defect: an image's
 * intrinsic size drives `object-fit`, `aspect-ratio`, an `auto` width or height, and the row height
 * of the table cell it sits in. So `intrinsicImageSize` reads the size out of the original's own
 * header bytes and the placeholder is generated at exactly that size.
 *
 * The placeholder is an SVG rather than a raster for a reason that matters at this scale: an SVG
 * carries an exact intrinsic width and height in a few hundred bytes, where a losslessly encoded
 * 1200x800 raster would need a deflate implementation and a megabyte of base64 inside a document
 * that has to stay small enough to preview. It is left in the `data:` scheme the original used, so
 * the converter still reports the same `image-source-not-fetchable` loss. What it does NOT preserve
 * is the codec — see the residual-risk list: a defect specific to how Slides handles a JPEG will
 * not reproduce on an anonymised copy.
 */
import type { KeyStream } from "./key-stream.ts";

export type PixelSize = Readonly<{ widthPx: number; heightPx: number }>;

/** A `data:` URI for a generated placeholder of exactly `size`. */
export function placeholderImageDataUri({ size, stream }: { size: PixelSize; stream: KeyStream }): string {
  const width = Math.max(1, Math.round(size.widthPx));
  const height = Math.max(1, Math.round(size.heightPx));
  const step = Math.max(12, Math.round(Math.min(width, height) / 6));
  const tint = TINTS[stream.nextBelow(TINTS.length)] ?? { fill: "#d7dae0", ink: "#aeb4c0" };

  const hatch: string[] = [];
  for (let offset = -height; offset < width; offset += step) {
    hatch.push(`M${offset} ${height}L${offset + height} 0`);
  }
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'>` +
    `<rect width='${width}' height='${height}' fill='${tint.fill}'/>` +
    `<path d='${hatch.join("")}' stroke='${tint.ink}' stroke-width='2' fill='none'/>` +
    `<rect x='1' y='1' width='${Math.max(0, width - 2)}' height='${Math.max(0, height - 2)}' fill='none' stroke='${tint.ink}' stroke-width='2'/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The intrinsic size encoded in an image's own header, or `null` when it cannot be read.
 *
 * `null` is a real answer, not a failure to handle: an external `https://` source cannot be
 * measured without a network fetch, and this module never makes one. The caller falls back to the
 * element's own `width`/`height` and records that it had to.
 */
export function intrinsicImageSize(source: string): PixelSize | null {
  const payload = dataUriPayload(source);
  if (payload === null) return null;
  if (payload.mediaType === "image/svg+xml") return svgSize(payload.text());
  return sizeFromHeader(payload.bytes());
}

/** A plausible intrinsic size, so a placeholder can still be generated when the header is unreadable. */
export const FALLBACK_IMAGE_SIZE: PixelSize = { widthPx: 320, heightPx: 240 };

const TINTS: readonly Readonly<{ fill: string; ink: string }>[] = [
  { fill: "#d7dae0", ink: "#aeb4c0" },
  { fill: "#dcd9d2", ink: "#b8b2a7" },
  { fill: "#d2dcdb", ink: "#a9bab8" },
  { fill: "#dad6e0", ink: "#b3acc2" },
];

type DataUriPayload = Readonly<{
  mediaType: string;
  /** Decoded as text, for an SVG. */
  text: () => string;
  /** The first `HEADER_BYTES` decoded bytes, for a raster header. */
  bytes: () => readonly number[];
}>;

/** Enough for a PNG IHDR, a GIF screen descriptor, a WebP chunk header and a JPEG's first SOF. */
const HEADER_BYTES = 1024;

function dataUriPayload(source: string): DataUriPayload | null {
  const head = /^data:([^,;]*)((?:;[^,]*)*),/i.exec(source.trim());
  if (head === null) return null;
  const mediaType = (head[1] ?? "").toLowerCase();
  const isBase64 = /;base64/i.test(head[2] ?? "");
  const body = source.trim().slice(head[0].length);
  return {
    mediaType,
    text: () => (isBase64 ? bytesToText(decodeBase64({ text: body, limit: Number.MAX_SAFE_INTEGER })) : decodePercent(body)),
    bytes: () =>
      isBase64 ? decodeBase64({ text: body, limit: HEADER_BYTES }) : textToBytes(decodePercent(body.slice(0, HEADER_BYTES * 3))),
  };
}

function sizeFromHeader(bytes: readonly number[]): PixelSize | null {
  const at = (index: number): number => bytes[index] ?? 0;
  const big16 = (index: number): number => (at(index) << 8) | at(index + 1);
  const big32 = (index: number): number => (at(index) << 24) | (at(index + 1) << 16) | (at(index + 2) << 8) | at(index + 3);
  const little16 = (index: number): number => at(index) | (at(index + 1) << 8);
  const little32 = (index: number): number =>
    at(index) | (at(index + 1) << 8) | (at(index + 2) << 16) | (at(index + 3) << 24);
  const ascii = (index: number, length: number): string =>
    bytes.slice(index, index + length).map((byte) => String.fromCharCode(byte)).join("");

  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return { widthPx: big32(16), heightPx: big32(20) };
  if (ascii(0, 3) === "GIF") return { widthPx: little16(6), heightPx: little16(8) };
  if (ascii(0, 2) === "BM") return { widthPx: Math.abs(little32(18)), heightPx: Math.abs(little32(22)) };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return webpSize({ ascii, little16, at });
  if (at(0) === 0xff && at(1) === 0xd8) {
    // Walk the marker chain to the first start-of-frame; every other segment carries its length.
    let cursor = 2;
    while (cursor + 9 < bytes.length) {
      if (at(cursor) !== 0xff) {
        cursor += 1;
        continue;
      }
      const marker = at(cursor + 1);
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        cursor += 2;
        continue;
      }
      if (START_OF_FRAME.has(marker)) return { widthPx: big16(cursor + 7), heightPx: big16(cursor + 5) };
      cursor += 2 + big16(cursor + 2);
    }
    return null;
  }
  return null;
}

/** SOF0..SOF15, minus the four markers in that range that are not frame headers. */
const START_OF_FRAME: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function webpSize({
  ascii,
  little16,
  at,
}: {
  ascii: (index: number, length: number) => string;
  little16: (index: number) => number;
  at: (index: number) => number;
}): PixelSize | null {
  const chunk = ascii(12, 4);
  if (chunk === "VP8X") {
    const width = 1 + (at(24) | (at(25) << 8) | (at(26) << 16));
    const height = 1 + (at(27) | (at(28) << 8) | (at(29) << 16));
    return { widthPx: width, heightPx: height };
  }
  if (chunk === "VP8 ") return { widthPx: little16(26) & 0x3fff, heightPx: little16(28) & 0x3fff };
  if (chunk === "VP8L") {
    const packed = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
    return { widthPx: 1 + (packed & 0x3fff), heightPx: 1 + ((packed >>> 14) & 0x3fff) };
  }
  return null;
}

function svgSize(text: string): PixelSize | null {
  const openTag = /<svg\b[^>]*>/i.exec(text);
  if (openTag === null) return null;
  const attributes = openTag[0];
  const width = cssPixels(attributeOf({ attributes, name: "width" }));
  const height = cssPixels(attributeOf({ attributes, name: "height" }));
  if (width !== null && height !== null) return { widthPx: width, heightPx: height };
  const viewBox = attributeOf({ attributes, name: "viewBox" });
  const numbers = viewBox === null ? [] : viewBox.trim().split(/[\s,]+/).map(Number);
  if (numbers.length !== 4) return null;
  const [, , boxWidth, boxHeight] = numbers;
  if (boxWidth === undefined || boxHeight === undefined || !Number.isFinite(boxWidth) || !Number.isFinite(boxHeight)) return null;
  return { widthPx: width ?? boxWidth, heightPx: height ?? boxHeight };
}

function attributeOf({ attributes, name }: { attributes: string; name: string }): string | null {
  const found = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(attributes);
  return found === null ? null : found[2] ?? found[3] ?? null;
}

function cssPixels(value: string | null): number | null {
  if (value === null) return null;
  const number = /^\s*(-?\d+(?:\.\d+)?)(px)?\s*$/.exec(value);
  if (number === null) return null;
  const parsed = Number(number[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Base64, by hand. `atob` exists in the sidebar but not in plain node, and `Buffer` exists in node
 * but not in the sidebar; this module has to behave identically in both, and `limit` keeps it from
 * decoding a megabyte of photograph to read twenty header bytes.
 */
function decodeBase64({ text, limit }: { text: string; limit: number }): readonly number[] {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of text) {
    const value = BASE64_ALPHABET.indexOf(character);
    if (value < 0) continue;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits < 8) continue;
    bits -= 8;
    bytes.push((accumulator >> bits) & 0xff);
    if (bytes.length >= limit) break;
  }
  return bytes;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodePercent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // A truncated `%` escape: the raw text is still good enough to read an `<svg>` tag out of.
    return text;
  }
}

/** The payload's bytes read as Latin-1 then as UTF-8 text; enough to find `<svg ...>`. */
function bytesToText(bytes: readonly number[]): string {
  return bytes.map((byte) => String.fromCharCode(byte)).join("");
}

function textToBytes(text: string): readonly number[] {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) bytes.push(text.charCodeAt(index) & 0xff);
  return bytes;
}
