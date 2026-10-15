/**
 * An uploaded image's media type is believed only when its bytes agree (SPEC.md 21.5 "Uploads"):
 * the declared `Content-Type` must be one of `AssetMediaType` AND the file must start with that
 * format's signature. A PNG label on JPEG bytes is refused (415), so a stored asset's type is
 * always the type its bytes are -- which is what the `nosniff` header on the way out relies on.
 */
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import type { AssetMediaType } from "../engine/src/contracts/document.ts";

/** True when `bytes` begin the way a file of `mediaType` does. */
export function bytesMatchMediaType(options: Readonly<{ bytes: Uint8Array; mediaType: AssetMediaType }>): boolean {
  const { bytes, mediaType } = options;
  switch (mediaType) {
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(bytes, characterCodes("GIF87a")) || startsWith(bytes, characterCodes("GIF89a"));
    case "image/webp":
      return startsWith(bytes, characterCodes("RIFF")) && characterCodes("WEBP").every((byte, index) => bytes[8 + index] === byte);
    case "image/svg+xml":
      return looksLikeVectorGraphics(bytes);
    default:
      return assertNever(mediaType);
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function characterCodes(text: string): readonly number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

/** Text (no NUL in the head), opening with markup, with an `<svg` element near the start. */
function looksLikeVectorGraphics(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, VECTOR_GRAPHICS_HEAD_BYTES);
  if (head.includes(0)) return false;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head).replace(/^\uFEFF/u, "").trimStart();
  return text.startsWith("<") && /<svg[\s>]/iu.test(text);
}

const VECTOR_GRAPHICS_HEAD_BYTES = 4096;
