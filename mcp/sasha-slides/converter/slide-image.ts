/**
 * slide-image.ts — how an image's BYTES reach a server that only fetches URLs.
 *
 * `createImage` takes a `url` and GOOGLE fetches it, from Google's own servers,
 * without the signed-in user's credentials. A candidate slide is a
 * self-contained document (PROTOCOL.md), so its pictures are `data:` URIs and
 * there is nothing for that fetcher to reach. This module decides what to do
 * about it; the host (`sashaInsert` in build-addon.ts) only executes the
 * decision.
 *
 * EVERYTHING BELOW WAS MEASURED against the live API, not read off the
 * documentation. Each quoted string is the error `batchUpdate` actually
 * returned:
 *
 *   - A `data:` URI IS accepted and the bytes are copied into the deck — but
 *     the whole URL is capped. Above 2048 bytes it answers "The URL must be 2K
 *     bytes or less", which is about 1.5 KB of image. So the inline route is
 *     real, and it is only ever big enough for an icon.
 *   - Only PNG / JPEG / GIF decode. Both `data:image/svg+xml,…` and
 *     `data:image/svg+xml;base64,…` answer "The URL is invalid", and an SVG
 *     served from Drive answers "…should be publicly accessible, within size
 *     limit, and in supported formats". That is what keeps the anonymiser's SVG
 *     placeholder reporting the same loss it always has
 *     (addon/src/anonymise/placeholder-image.ts).
 *   - A PRIVATE Drive file is not fetchable in any URL shape. `uc?id=`,
 *     `uc?export=download|view`, `thumbnail?id=` and `file/d/<id>/view` answer
 *     "There was a problem retrieving the image"; `lh3.googleusercontent.com/d/
 *     <id>`, `drive/v3/files/<id>?alt=media` and the file's own `thumbnailLink`
 *     answer "Access to the provided image was forbidden".
 *   - With `anyone-with-link` reader on the file, `uc?id=` works first time,
 *     with no propagation delay to wait out.
 *   - Slides COPIES the bytes during the batchUpdate. Revoking the share and
 *     deleting the Drive file immediately afterwards leaves the rendered slide
 *     intact — verified by exporting the page thumbnail after the delete. That
 *     is what lets the host stage a file for the length of ONE API call rather
 *     than keep a shared copy around for the lifetime of the proposal.
 *
 * The staging instruction rides on the `createImage` request itself, as a
 * `sashaStageImage` sidecar, rather than as a second top-level field of the
 * conversion result. That is deliberate: `InsertRequestSpec.requests` already
 * crosses `google.script.run` untouched, so the bytes reach Apps Script without
 * any intermediate layer growing a new field, and — the thing that matters —
 * without ever being a tool argument. The host strips the sidecar before the
 * request reaches Google.
 */

/** The media types `createImage` can decode. Everything else is a loss. */
export type StagedImageMediaType = "image/png" | "image/jpeg" | "image/gif";

/**
 * One image's bytes, as the host is told to stage them. Every field is computed
 * here so Code.gs is a straight-line upload with no decisions of its own — the
 * same discipline `RenderRequest` already follows.
 */
export type SlideImageUpload = Readonly<{
  /** Drive file name. Carries the element's object id, so a leftover is traceable. */
  fileName: string;
  mimeType: StagedImageMediaType;
  /** The `data:` URI's payload, whitespace stripped, ready for `Utilities.base64Decode`. */
  base64: string;
}>;

/** What `createImage.url` should be, and whether the host has work to do first. */
export type SlideImageSource =
  /** An `http(s)` source the fetcher can already reach. Nothing to stage. */
  | Readonly<{ kind: "fetchable"; url: string }>
  /** Small enough to travel as the URL itself, so nothing touches Drive at all. */
  | Readonly<{ kind: "inline"; url: string }>
  /** Too big for the URL cap: the host uploads, shares, substitutes and deletes. */
  | Readonly<{ kind: "staged"; url: string; upload: SlideImageUpload }>
  /** Nothing can carry it. `scheme` is what the anomaly reports to the user. */
  | Readonly<{ kind: "unusable"; scheme: string }>
  /** Decodable, but past what `createImage` will accept however it is delivered. */
  | Readonly<{ kind: "too-large"; bytes: number; limitBytes: number }>;

/**
 * Measured: `batchUpdate` answers "The URL must be 2K bytes or less" above this.
 * It bounds the WHOLE url, scheme and media type included, not the payload.
 */
export const SLIDES_MAX_IMAGE_URL_BYTES = 2048;

/**
 * Google's documented ceiling for `createImage`: "Images must be less than
 * 50MB". Refusing above it turns a guaranteed server-side rejection — and a
 * pointless 50 MB trip through `google.script.run` — into a reportable loss.
 */
export const SLIDES_MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/**
 * The placeholder `createImage.url` carries until the host substitutes the
 * staged file's URL. `.invalid` is reserved by RFC 2606 and can never resolve,
 * so a host that does not know about staging fails loudly on a URL nobody could
 * have meant, instead of quietly fetching something.
 */
export const STAGED_IMAGE_URL = "https://staged.sasha-slides.invalid/image";

/**
 * The URL the host builds once the bytes are on Drive. `uc?id=` rather than
 * `lh3.googleusercontent.com/d/<id>`: it is the form Drive itself advertises as
 * `webContentLink`, and it serves the stored bytes rather than an image CDN's
 * re-encoding. Both were measured working; only this one is documented.
 *
 * Exported because the host builds the same string in Code.gs and a test here
 * is the only place that can check the two agree.
 */
export function stagedImageUrl(fileId: string): string {
  return `https://drive.google.com/uc?id=${fileId}`;
}

/**
 * One `<img>`'s `src`, as the emitter should treat it.
 *
 * `objectId` is folded in rather than returned to the caller for naming,
 * because a staged file's name is the only thread back from a leftover Drive
 * file to the element that asked for it.
 */
export function slideImageSourceFor(
  options: Readonly<{ src: string; objectId: string }>,
): SlideImageSource {
  const src = options.src.trim();
  const scheme = schemeOf(src);
  if (scheme === "http" || scheme === "https") return { kind: "fetchable", url: src };
  if (scheme !== "data") return { kind: "unusable", scheme };

  const payload = base64DataUriPayload(src);
  // A `data:` URI that is not base64 raster bytes — the anonymiser's
  // percent-encoded SVG placeholder is the one this product actually produces.
  if (payload === null) return { kind: "unusable", scheme };

  const bytes = base64ByteLength(payload.base64);
  if (bytes > SLIDES_MAX_IMAGE_BYTES) {
    return { kind: "too-large", bytes, limitBytes: SLIDES_MAX_IMAGE_BYTES };
  }

  const inlineUrl = `data:${payload.mimeType};base64,${payload.base64}`;
  if (inlineUrl.length <= SLIDES_MAX_IMAGE_URL_BYTES) return { kind: "inline", url: inlineUrl };

  return {
    kind: "staged",
    url: STAGED_IMAGE_URL,
    upload: {
      fileName: `${options.objectId}${EXTENSIONS[payload.mimeType]}`,
      mimeType: payload.mimeType,
      base64: payload.base64,
    },
  };
}

/**
 * The sidecar on a request, or null. The host's contract in TypeScript: a test
 * can assert exactly which requests Code.gs will stage without reaching into an
 * un-runnable `.gs` file.
 */
export function stagedImageOf(request: Readonly<Record<string, unknown>>): SlideImageUpload | null {
  const sidecar = request[STAGED_IMAGE_FIELD];
  if (typeof sidecar !== "object" || sidecar === null) return null;
  const record = sidecar as Readonly<Record<string, unknown>>;
  const fileName = record["fileName"];
  const mimeType = record["mimeType"];
  const base64 = record["base64"];
  if (typeof fileName !== "string" || typeof base64 !== "string") return null;
  if (!isStagedImageMediaType(mimeType)) return null;
  return { fileName, mimeType, base64 };
}

/** The key the host reads and strips. One constant, so the two sides cannot drift. */
export const STAGED_IMAGE_FIELD = "sashaStageImage";

/**
 * The scheme of a source, or `empty` / `relative` for the two shapes that have
 * none. The label reaches the user through `image-source-not-fetchable`, so it
 * names what they wrote rather than what the parser did.
 */
export function schemeOf(src: string): string {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(src.trim());
  if (match === null) return src.trim().length === 0 ? "empty" : "relative";
  // SAFETY: the regex has exactly one capture group and it just matched.
  return match[1]!.toLowerCase();
}

const EXTENSIONS: Readonly<Record<StagedImageMediaType, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
};

/**
 * The base64 body and media type of a `data:` URI, or null when it is not a
 * base64-encoded image `createImage` can decode.
 *
 * Non-base64 (`;charset=`, percent-encoded) bodies are refused rather than
 * re-encoded: the only one this product emits is the anonymiser's SVG
 * placeholder, which Slides rejects anyway, so re-encoding would buy a code
 * path with no caller.
 */
function base64DataUriPayload(
  src: string,
): Readonly<{ mimeType: StagedImageMediaType; base64: string }> | null {
  const head = /^data:([^,;]*)((?:;[^,]*)*),/i.exec(src);
  if (head === null) return null;
  const mimeType = (head[1] ?? "").trim().toLowerCase();
  if (!isStagedImageMediaType(mimeType)) return null;
  if (!/(^|;)base64$/i.test((head[2] ?? "").trim())) return null;
  // Browsers wrap long `src` attributes; Drive and Slides both reject the
  // whitespace, so it is removed once, here, rather than in the host.
  const base64 = src.slice(head[0].length).replace(/\s+/g, "");
  return base64.length === 0 ? null : { mimeType, base64 };
}

/**
 * Bytes a base64 payload decodes to. A parse-boundary guard, so it counts
 * padding rather than trusting a length formula on a malformed body.
 */
function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/**
 * A parse-boundary guard over an untrusted media-type string, so it cannot be
 * written as an exhaustive switch — the input is not the union. A fourth
 * supported format is added here by hand, and `EXTENSIONS` stops compiling
 * until it has one.
 */
function isStagedImageMediaType(value: unknown): value is StagedImageMediaType {
  return value === "image/png" || value === "image/jpeg" || value === "image/gif";
}
