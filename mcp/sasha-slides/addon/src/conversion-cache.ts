// THE HTML -> REQUESTS CONVERSION, REMEMBERED.
//
// Converting one candidate stages a real offscreen 1280x720 iframe and waits for its fonts and
// images, on the main thread -- seconds per slide, one slide at a time. Nothing about the result
// changes while the HTML and the converter do not, so re-paying it on every window open is pure
// latency: the user reported "Converted" just waiting for the conversion, every time.
//
// KEYED BY EVERYTHING THE RESULT IS A FUNCTION OF: the candidate's HTML, the ids the converter was
// told to use (deterministic for the preview -- slide-insert.ts `previewConversionSpec`), and the
// BUILD. The converter is compiled into the bundle, so a new deploy may convert differently; the
// build stamp in the key makes a deploy miss rather than serve the old converter's output. A
// revised candidate is different HTML, so it misses too -- no invalidation to forget.
//
// SAME DEFENSIVE STYLE AS render-cache.ts, for the same reasons: localStorage is per-origin,
// survives the window, is capped, and throws on access in a private window or with blocked site
// data. Every path is guarded, and a miss is always a legal answer -- it just means converting.

import type { ConversionResult, SlidesApiRequest, UnsupportedFeature } from "./converter-contract.ts";
import { browserShelf, evictOldest, textHashOf } from "./render-cache.ts";

/** What one conversion was asked: the converter's own spec, plus the build that ran it. */
export type ConversionCacheInput = Readonly<{
  build: string;
  html: string;
  presentationId: string;
  pageObjectId: string;
  objectIdPrefix: string;
}>;

const PREFIX = "sashaSlides.conversion.";
/**
 * How many conversions to keep. A proposal is up to eight candidates and a user revisits a few;
 * the pictures in render-cache.ts share the same origin quota, so this stays modest.
 */
export const CONVERSION_CACHE_LIMIT = 24;
/**
 * The largest serialised conversion worth keeping. A candidate whose images are inlined as big
 * data: URIs can serialise to megabytes, and one of those would evict every rendered picture from
 * the shared quota; converting that one again is the cheaper loss.
 */
export const CONVERSION_ENTRY_MAX_CHARS = 512 * 1024;

/** A stable key for one conversion. The separators keep `a|bc` and `ab|c` apart. */
export function conversionKeyOf(input: ConversionCacheInput): string {
  const text = [input.build, input.presentationId, input.pageObjectId, input.objectIdPrefix, input.html].join("\u0000");
  return `${PREFIX}${textHashOf(text)}`;
}

/** The remembered conversion for this key, or null. Never throws. */
export function cachedConversion(key: string, store?: Storage): ConversionResult | null {
  const shelf = browserShelf(store);
  if (shelf === null) return null;
  try {
    const raw = shelf.getItem(key);
    if (raw === null) return null;
    return conversionOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Remember one conversion, evicting the oldest when the shelf is full.
 *
 * A FAILED WRITE IS NOT A FAILED CONVERSION: the result is already in the state tree; all that is
 * lost is the next open being instant. A full quota sheds HALF of our entries and tries once more
 * rather than everything, so one big candidate cannot wipe the whole shelf.
 */
export function rememberConversion(key: string, result: ConversionResult, store?: Storage): void {
  const shelf = browserShelf(store);
  if (shelf === null) return;
  let serialised: string;
  try {
    serialised = JSON.stringify({ requests: result.requests, unsupported: result.unsupported, at: Date.now() });
  } catch {
    return;
  }
  if (serialised.length > CONVERSION_ENTRY_MAX_CHARS) return;
  try {
    evictOldest({ shelf, prefix: PREFIX, keep: CONVERSION_CACHE_LIMIT - 1 });
    shelf.setItem(key, serialised);
  } catch {
    try {
      evictOldest({ shelf, prefix: PREFIX, keep: Math.floor(CONVERSION_CACHE_LIMIT / 2) });
      shelf.setItem(key, serialised);
    } catch {
      // Nothing further to try; the conversion still happened.
    }
  }
}

/** PARSE AT THE BOUNDARY: storage is untrusted, so anything not shaped like a conversion misses. */
function conversionOf(parsed: unknown): ConversionResult | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Readonly<{ requests?: unknown; unsupported?: unknown }>;
  if (!Array.isArray(record.requests) || !Array.isArray(record.unsupported)) return null;
  const requests: SlidesApiRequest[] = [];
  for (const request of record.requests as readonly unknown[]) {
    if (typeof request !== "object" || request === null || Array.isArray(request)) return null;
    // A non-null, non-array object is exactly the picker's (deliberately loose) request shape.
    requests.push(request as SlidesApiRequest);
  }
  const unsupported: UnsupportedFeature[] = [];
  for (const entry of record.unsupported as readonly unknown[]) {
    const feature = unsupportedOf(entry);
    if (feature === null) return null;
    unsupported.push(feature);
  }
  return { requests, unsupported };
}

function unsupportedOf(entry: unknown): UnsupportedFeature | null {
  if (typeof entry !== "object" || entry === null) return null;
  const record = entry as Readonly<{ feature?: unknown; note?: unknown; region?: unknown }>;
  if (typeof record.feature !== "string" || typeof record.note !== "string") return null;
  const region = record.region;
  if (typeof region !== "object" || region === null) return null;
  const box = region as Readonly<{ x?: unknown; y?: unknown; w?: unknown; h?: unknown }>;
  if (typeof box.x !== "number" || typeof box.y !== "number" || typeof box.w !== "number" || typeof box.h !== "number") {
    return null;
  }
  return { feature: record.feature, note: record.note, region: { x: box.x, y: box.y, w: box.w, h: box.h } };
}
