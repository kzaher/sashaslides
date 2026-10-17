/**
 * The Google Slides REST calls this module makes, over the injected `fetch`.
 *
 * WHY `fetch` AND NOT `googleapis`: the interchange receives `fetch` from the composition root
 * (deck-service-contract.ts), so every route test runs against fake Google endpoints with no
 * module patching, and the same client serves the live end-to-end scripts. The OAuth2 path is the
 * one that works from this project (CLAUDE.md: the cookie and SAPISIDHASH paths are refused).
 *
 * Every answer is returned as a value: a failed call names its HTTP status and Google's own
 * message, and the caller maps the status to a `DeckApiErrorCode` (`googleFailureCodeOf`). Bodies
 * come back as `unknown`; parsing is the caller's job at its own boundary (slides-presentation.ts).
 */
import type { DeckApiErrorCode } from "../engine/src/contracts/deck-api.ts";

export const SLIDES_API_ORIGIN = "https://slides.googleapis.com";
/** Drive serves the .pptx export (`files.export`); it is a read and changes nothing. */
export const DRIVE_API_ORIGIN = "https://www.googleapis.com";
/** Drive's export media type for a presentation as .pptx. */
export const PPTX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export type SlidesCallOutcome =
  | Readonly<{ kind: "ok"; body: unknown }>
  | Readonly<{ kind: "failed"; status: number; message: string }>;

export type SlidesClient = Readonly<{
  getPresentation(options: Readonly<{ presentationId: string; fields: string | null }>): Promise<SlidesCallOutcome>;
  createPresentation(options: Readonly<{ title: string; widthEnglishMetricUnits: number; heightEnglishMetricUnits: number }>): Promise<SlidesCallOutcome>;
  batchUpdate(options: Readonly<{ presentationId: string; requests: readonly unknown[] }>): Promise<SlidesCallOutcome>;
  getThumbnail(options: Readonly<{ presentationId: string; pageObjectId: string }>): Promise<SlidesCallOutcome>;
  /** The presentation as .pptx, for what `presentations.get` leaves out (import-pptx-supplement.ts). */
  exportPresentationPptx(options: Readonly<{ presentationId: string }>): Promise<PptxExportOutcome>;
}>;

export type PptxExportOutcome = Readonly<{ kind: "exported"; bytes: Uint8Array }> | Readonly<{ kind: "failed"; status: number; message: string }>;

export function createSlidesClient(options: Readonly<{ fetch: typeof fetch; accessToken: string }>): SlidesClient {
  const call = (request: Readonly<{ method: "GET" | "POST"; path: string; body: unknown }>): Promise<SlidesCallOutcome> =>
    callSlides({ fetch: options.fetch, accessToken: options.accessToken, ...request });
  return {
    getPresentation: ({ presentationId, fields }) =>
      call({
        method: "GET",
        path: `/v1/presentations/${encodeURIComponent(presentationId)}${fields === null ? "" : `?fields=${encodeURIComponent(fields)}`}`,
        body: null,
      }),
    createPresentation: ({ title, widthEnglishMetricUnits, heightEnglishMetricUnits }) =>
      call({
        method: "POST",
        path: "/v1/presentations",
        body: {
          title,
          pageSize: {
            width: { magnitude: widthEnglishMetricUnits, unit: "EMU" },
            height: { magnitude: heightEnglishMetricUnits, unit: "EMU" },
          },
        },
      }),
    batchUpdate: ({ presentationId, requests }) =>
      call({ method: "POST", path: `/v1/presentations/${encodeURIComponent(presentationId)}:batchUpdate`, body: { requests } }),
    getThumbnail: ({ presentationId, pageObjectId }) =>
      call({
        method: "GET",
        path: `/v1/presentations/${encodeURIComponent(presentationId)}/pages/${encodeURIComponent(pageObjectId)}/thumbnail?thumbnailProperties.mimeType=PNG&thumbnailProperties.thumbnailSize=LARGE`,
        body: null,
      }),
    exportPresentationPptx: ({ presentationId }) => exportPptx({ fetch: options.fetch, accessToken: options.accessToken, presentationId }),
  };
}

/**
 * Drive's `files.export` of a presentation as .pptx. It needs a Drive scope that reaches the file:
 * `drive.file` reaches only files this app created or the person opened with it, so on other
 * presentations Google answers 403 or 404, which the import reports as lost gradients instead of
 * failing.
 */
async function exportPptx(options: Readonly<{ fetch: typeof fetch; accessToken: string; presentationId: string }>): Promise<PptxExportOutcome> {
  let response: Response;
  try {
    response = await options.fetch(`${DRIVE_API_ORIGIN}/drive/v3/files/${encodeURIComponent(options.presentationId)}/export?mimeType=${encodeURIComponent(PPTX_MEDIA_TYPE)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${options.accessToken}` },
      signal: AbortSignal.timeout(SLIDES_CALL_TIMEOUT_MILLISECONDS),
    });
  } catch (cause) {
    return { kind: "failed", status: 0, message: cause instanceof Error ? cause.message : String(cause) };
  }
  if (!response.ok) {
    const text = await response.text();
    return { kind: "failed", status: response.status, message: googleMessageOf({ parsed: parseBodyText(text), text }) };
  }
  return { kind: "exported", bytes: new Uint8Array(await response.arrayBuffer()) };
}

/**
 * The error code a failed Slides call becomes. 401 means the grant no longer works (revoked, or a
 * refresh that came back without the scope), which the person fixes by connecting again.
 */
export function googleFailureCodeOf(status: number): DeckApiErrorCode {
  if (status === 401) return "googleNotConnected";
  if (status === 403) return "googlePermissionDenied";
  if (status === 404) return "googlePresentationNotFound";
  return "googleFailed";
}

/** The HTTP status a route answers for the error code a failed Google call became. */
export function httpStatusOfGoogleFailure(code: DeckApiErrorCode): number {
  switch (code) {
    case "googleNotConnected":
      return 409;
    case "googlePermissionDenied":
      return 403;
    case "googlePresentationNotFound":
      return 404;
    default:
      return 502;
  }
}

/**
 * The presentation id in whatever the person pasted: an editor address
 * (`/presentation/d/<id>/edit`), the legacy Drive form (`open?id=<id>`, which
 * `SlidesApp.getUrl()` returns, CLAUDE.md), or the bare id. Null when nothing id-shaped is there.
 */
export function presentationIdFrom(text: string): string | null {
  const trimmed = text.trim();
  const editor = /\/presentation\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})/.exec(trimmed);
  if (editor?.[1] !== undefined) return editor[1];
  const legacy = /[?&]id=([A-Za-z0-9_-]{20,})/.exec(trimmed);
  if (legacy?.[1] !== undefined) return legacy[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(trimmed) ? trimmed : null;
}

export function presentationAddressOf(presentationId: string): string {
  return `https://docs.google.com/presentation/d/${presentationId}/edit`;
}

async function callSlides(
  options: Readonly<{ fetch: typeof fetch; accessToken: string; method: "GET" | "POST"; path: string; body: unknown }>,
): Promise<SlidesCallOutcome> {
  let response: Response;
  try {
    response = await options.fetch(`${SLIDES_API_ORIGIN}${options.path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${options.accessToken}`,
        ...(options.method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(options.method === "POST" ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(SLIDES_CALL_TIMEOUT_MILLISECONDS),
    });
  } catch (cause) {
    return { kind: "failed", status: 0, message: cause instanceof Error ? cause.message : String(cause) };
  }
  const text = await response.text();
  const parsed = parseBodyText(text);
  if (!response.ok) return { kind: "failed", status: response.status, message: googleMessageOf({ parsed, text }) };
  return { kind: "ok", body: parsed };
}

/**
 * A batchUpdate of one slide with a few hundred requests takes Google a few seconds; a minute is
 * the ceiling past which the call is stuck rather than slow (CLAUDE.md "fail fast").
 */
const SLIDES_CALL_TIMEOUT_MILLISECONDS = 60_000;

function parseBodyText(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Google's error envelope is `{ error: { code, message, status } }`; fall back to the raw text. */
function googleMessageOf(options: Readonly<{ parsed: unknown; text: string }>): string {
  const parsed = options.parsed;
  if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
    const error: unknown = parsed.error;
    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  }
  return options.text.slice(0, 400);
}
