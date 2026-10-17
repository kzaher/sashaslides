// THE DECK API AS THE DEVELOPER PAGE CALLS IT: who is signed in (GET /deck-api/session), insert
// converted slides into the person's own presentation, and export a presentation's slides as PNGs.
// Both writes run on the person's OWN Google grant on the server (insert-html-contract.ts), never on
// developer tokens.
//
// Key decisions:
//
//  * THE SAME SESSION AS THE DECK WEB APPLICATION (engine/src/contracts/deck-api.ts). /dev and
//    /deck-api share the sashaslides.com origin, so the `sasha_deck` cookie (Path=/deck-api,
//    SameSite=Strict) rides along with `credentials: "same-origin"`, and every POST carries the
//    session's CSRF token in `X-Sasha-Csrf`. Signed out, the person goes to
//    `/account/deck-session?return=/dev`, which signs in, sets the cookie and comes back here.
//  * EVERY ANSWER IS A VALUE, NEVER A THROW. The page switches on `DeckCallOutcome` exhaustively:
//    401 is "sign in", 409 `googleNotConnected` is "connect Google Slides" with the server's
//    `connectAddress`, every other refusal shows the server's sentence.
//  * BODIES ARE PARSED HERE, at the boundary, with the deck web application's own readers.
//  * `fetch` IS INJECTED, so the tests answer with `Response`s they build.

import { assertNever } from "../../../../mcp/sasha-slides/engine/src/contracts/assert-never.ts";
import {
  CSRF_HEADER_NAME,
  DECK_API_PATHS,
  DECK_SESSION_START_PATH,
  type DeckApiErrorBody,
  type DeckApiErrorCode,
} from "../../../../mcp/sasha-slides/engine/src/contracts/deck-api.ts";
import { readDeckApiError, readDeckSessionBody } from "../../../../mcp/sasha-slides/engine/src/web/parsing/deck-api-bodies.ts";
import { listAt, parseOrNull, parseStructuredText, recordOf, stringAt, stringOf } from "../../../../mcp/sasha-slides/engine/src/shared/untrusted-values.ts";
import {
  DEV_PAGE_PATH,
  EXPORT_PNG_MEDIA_TYPE,
  GOOGLE_SLIDES_EXPORT_PNG_PATH,
  GOOGLE_SLIDES_INSERT_HTML_PATH,
  type ExportPngRequestBody,
  type InsertHtmlResponseBody,
} from "../../../../mcp/sasha-slides/google-slides/insert-html-contract.ts";

/** `window.fetch`, injected. */
export type Fetch = (address: string, init: RequestInit) => Promise<Response>;

export type SessionState =
  | Readonly<{ kind: "signedIn"; csrfToken: string; displayName: string; email: string | null }>
  | Readonly<{ kind: "signedOut"; signInAddress: string }>
  /** No deck service answered (a local site without the connector, or the network is down). */
  | Readonly<{ kind: "unavailable"; message: string }>;

export type DeckCallOutcome<TValue> =
  | Readonly<{ kind: "ok"; value: TValue }>
  | Readonly<{ kind: "signedOut"; signInAddress: string }>
  | Readonly<{ kind: "googleNotConnected"; connectAddress: string; message: string }>
  /** The server refused for a reason the person reads: a bad request, a missing deck, a limit. */
  | Readonly<{ kind: "refused"; status: number; code: DeckApiErrorCode; message: string }>
  | Readonly<{ kind: "unreachable"; message: string }>;

/** The exported zip and the name to save it under. */
export type ExportedZip = Readonly<{ zip: Blob; fileName: string | null }>;

/** Where a signed-out person signs in; it comes back to /dev with the deck session cookie set. */
export const DEV_SIGN_IN_ADDRESS = `${DECK_SESSION_START_PATH}?return=${encodeURIComponent(DEV_PAGE_PATH)}`;

/** Where a person without a Google grant connects, when the server's answer names no address. */
export const DEV_CONNECT_ADDRESS = `${DECK_API_PATHS.googleSlidesConnect}?return=${encodeURIComponent(DEV_PAGE_PATH)}`;

export async function readSession(options: Readonly<{ fetch: Fetch }>): Promise<SessionState> {
  let response: Response;
  try {
    response = await options.fetch(DECK_API_PATHS.session, { method: "GET", headers: { Accept: "application/json" }, credentials: "same-origin" });
  } catch (error) {
    return { kind: "unavailable", message: `The deck service could not be reached (${messageOf(error)}).` };
  }
  const text = await textOf(response);
  if (response.status === 401) return { kind: "signedOut", signInAddress: DEV_SIGN_IN_ADDRESS };
  if (!response.ok) return { kind: "unavailable", message: `The deck service is not available here (it answered ${response.status}).` };
  const session = parseOrNull(() => readDeckSessionBody(parseStructuredText(text)));
  if (session === null) return { kind: "unavailable", message: "The deck service answered with a session this page does not understand." };
  return { kind: "signedIn", csrfToken: session.csrfToken, displayName: session.me.displayName, email: session.email };
}

/** POST /deck-api/google-slides/insert-html with a body built by insert-request.ts. */
export async function insertHtml(options: Readonly<{ fetch: Fetch; csrfToken: string; bodyText: string }>): Promise<DeckCallOutcome<InsertHtmlResponseBody>> {
  const answered = await post({ fetch: options.fetch, path: GOOGLE_SLIDES_INSERT_HTML_PATH, csrfToken: options.csrfToken, bodyText: options.bodyText });
  if (answered.kind === "unreachable") return answered;
  const { response } = answered;
  const text = await textOf(response);
  if (!response.ok) return failureOutcome({ status: response.status, text });
  const body = parseOrNull(() => readInsertHtmlResponse(parseStructuredText(text)));
  if (body === null) return { kind: "unreachable", message: "The insert finished, but its answer was not understood. Open the presentation to check it." };
  return { kind: "ok", value: body };
}

/** POST /deck-api/google-slides/export-png; a 200 is the zip itself. */
export async function exportPng(options: Readonly<{ fetch: Fetch; csrfToken: string; body: ExportPngRequestBody }>): Promise<DeckCallOutcome<ExportedZip>> {
  const answered = await post({ fetch: options.fetch, path: GOOGLE_SLIDES_EXPORT_PNG_PATH, csrfToken: options.csrfToken, bodyText: JSON.stringify(options.body) });
  if (answered.kind === "unreachable") return answered;
  const { response } = answered;
  if (!response.ok) return failureOutcome({ status: response.status, text: await textOf(response) });
  const mediaType = (response.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== EXPORT_PNG_MEDIA_TYPE) return { kind: "unreachable", message: `The export answered ${mediaType === "" ? "without a media type" : mediaType}, not a zip.` };
  try {
    return { kind: "ok", value: { zip: await response.blob(), fileName: attachmentNameOf(response.headers.get("Content-Disposition")) } };
  } catch (error) {
    return { kind: "unreachable", message: `The zip did not arrive completely (${messageOf(error)}).` };
  }
}

/** The value of an `ok` outcome, else null. */
export function okValueOf<TValue>(outcome: DeckCallOutcome<TValue>): TValue | null {
  switch (outcome.kind) {
    case "ok":
      return outcome.value;
    case "signedOut":
    case "googleNotConnected":
    case "refused":
    case "unreachable":
      return null;
    default:
      return assertNever(outcome);
  }
}

/** Where a signed-out answer sends the person, else null: a 401 mid-session signs the whole page out. */
export function signInAddressOf(outcome: DeckCallOutcome<unknown>): string | null {
  switch (outcome.kind) {
    case "signedOut":
      return outcome.signInAddress;
    case "ok":
    case "googleNotConnected":
    case "refused":
    case "unreachable":
      return null;
    default:
      return assertNever(outcome);
  }
}

/** The answer to a non-2xx response: its parsed error body, or a sentence made from the status. */
export function failureOutcome(options: Readonly<{ status: number; text: string }>): DeckCallOutcome<never> {
  const error = parseOrNull(() => readDeckApiError(parseStructuredText(options.text))) ?? fallbackError(options.status);
  const kind = outcomeKindOf(error.error);
  switch (kind) {
    case "signedOut":
      return { kind: "signedOut", signInAddress: DEV_SIGN_IN_ADDRESS };
    case "googleNotConnected":
      return { kind: "googleNotConnected", connectAddress: connectAddressOf(error.connectAddress), message: error.message };
    case "refused":
      return { kind: "refused", status: options.status, code: error.error, message: error.message };
    default:
      return assertNever(kind);
  }
}

/** Parses the insert route's 200 body (insert-html-contract.ts `InsertHtmlResponseBody`). */
export function readInsertHtmlResponse(value: unknown): InsertHtmlResponseBody {
  const record = recordOf(value, "insert answer");
  return {
    presentationId: stringAt(record, "presentationId"),
    presentationAddress: safeAddress(stringAt(record, "presentationAddress")),
    pageObjectIds: listAt(record, "pageObjectIds", (entry) => stringOf(entry, "page object id")),
    diagrams: listAt(record, "diagrams", (entry) => {
      const diagram = recordOf(entry, "diagram");
      return { diagramId: stringAt(diagram, "diagramId"), fileId: stringAt(diagram, "fileId") };
    }),
    warnings: listAt(record, "warnings", (entry) => stringOf(entry, "warning")),
  };
}

/** The file name of a `Content-Disposition: attachment; filename="…"` header, else null. */
export function attachmentNameOf(header: string | null): string | null {
  if (header === null) return null;
  const match = /filename="?([^";]+)"?/i.exec(header);
  const name = match?.[1]?.trim() ?? "";
  // Only a plain file name: the page saves it, and a path or a control character has no place there.
  return /^[\w.() -]{1,120}$/.test(name) ? name : null;
}

type OutcomeKind = "signedOut" | "googleNotConnected" | "refused";

function outcomeKindOf(code: DeckApiErrorCode): OutcomeKind {
  switch (code) {
    case "signedOut":
      return "signedOut";
    case "googleNotConnected":
      return "googleNotConnected";
    case "csrfMismatch":
    case "originRefused":
    case "notFound":
    case "notPermitted":
    case "invalidRequest":
    case "tooLarge":
    case "unsupportedMediaType":
    case "rateLimited":
    case "limitReached":
    case "googlePermissionDenied":
    case "googlePresentationNotFound":
    case "googleFailed":
    case "addonIdentityRejected":
    case "deckUnreadable":
    case "serverError":
      return "refused";
    default:
      return assertNever(code);
  }
}

type Posted = Readonly<{ kind: "answered"; response: Response }> | Readonly<{ kind: "unreachable"; message: string }>;

async function post(options: Readonly<{ fetch: Fetch; path: string; csrfToken: string; bodyText: string }>): Promise<Posted> {
  try {
    const response = await options.fetch(options.path, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", [CSRF_HEADER_NAME]: options.csrfToken },
      credentials: "same-origin",
      body: options.bodyText,
    });
    return { kind: "answered", response };
  } catch (error) {
    return { kind: "unreachable", message: `Sasha Slides could not be reached (${messageOf(error)}).` };
  }
}

/** The server's consent address when it is one of ours (a path under /deck-api/), else the default. */
function connectAddressOf(address: string | null): string {
  return address !== null && address.startsWith(`${DECK_API_PATHS.googleSlidesConnect}?`) ? address : DEV_CONNECT_ADDRESS;
}

/** A 401 with no readable body is still "signed out"; anything else reads as a server error. */
function fallbackError(status: number): DeckApiErrorBody {
  return {
    error: status === 401 ? "signedOut" : "serverError",
    message: `The server answered ${status}.`,
    signInAddress: null,
    connectAddress: null,
    retryAfterSeconds: null,
  };
}

/** The presentation link is shown as a link: only an https Google address is kept. */
function safeAddress(address: string): string {
  return /^https:\/\/docs\.google\.com\//.test(address) ? address : "";
}

async function textOf(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
