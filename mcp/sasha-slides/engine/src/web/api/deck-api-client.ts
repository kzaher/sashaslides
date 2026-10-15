// THE DECK API, CALLED FROM THE PAGES (deck-api.ts, SPEC.md 21.2). A root client for what is not
// about one deck (the session, the list, a new deck, an import, the embedded ticket) and, from it,
// a deck-scoped client that carries the deck id so no call site repeats or mis-pairs it.
//
// Key decisions:
//
//  * TWO WAYS TO BE SIGNED IN, ONE CLIENT. The web application sends the `sasha_deck` cookie
//    (`credentials: "same-origin"`); the editor embedded in the add-on has no cookies (a third-party
//    frame) and sends `Authorization: Bearer` from memory instead (`credentials: "omit"`). Every
//    state-changing request carries `X-Sasha-Csrf` from the session either way (SPEC.md 21.2).
//    `SessionCredentials` holds the current token and CSRF value, refreshed in place after a
//    session read or a bearer renewal, so a long-open page never sends a stale one.
//  * EVERY ANSWER IS A VALUE (`ApiResult`), NEVER A THROW: `ok` with the parsed body, `failed` with
//    the server's `DeckApiErrorBody` (or a synthesised `serverError` when the body did not parse),
//    or `unreachable` when no answer came. The pages switch on it exhaustively.
//  * BODIES ARE PARSED HERE, at the boundary (parsing/deck-api-bodies.ts).

import type { AgentRevertOutcome } from "../../contracts/collaboration.ts";
import { assertNever } from "../../contracts/assert-never.ts";
import {
  CSRF_HEADER_NAME,
  DECK_API_PATHS,
  type AssetUploadBody,
  type ChangeMemberRequest,
  type CreateDeckBody,
  type CreateDeckRequest,
  type DeckApiErrorBody,
  type DeckDetailsBody,
  type DeckListBody,
  type DeckSessionBody,
  type EmbedSessionBody,
  type EmbedSessionRequest,
  type GoogleSlidesExportBody,
  type GoogleSlidesExportRequest,
  type GoogleSlidesImportBody,
  type GoogleSlidesImportRequest,
  type InviteBody,
  type InviteRequest,
  type UpdateDeckRequest,
} from "../../contracts/deck-api.ts";
import type { AssetMediaType } from "../../contracts/document.ts";
import type { AssetId, DeckId } from "../../contracts/ids.ts";
import {
  readAgentRevertOutcome,
  readAssetUploadBody,
  readCreateDeckBody,
  readDeckApiError,
  readDeckDetailsBody,
  readDeckListBody,
  readDeckSessionBody,
  readEmbedSessionBody,
  readGoogleSlidesExportBody,
  readGoogleSlidesImportBody,
  readInviteBody,
} from "../parsing/deck-api-bodies.ts";
import { keysOf, parseOrNull, parseStructuredText } from "../parsing/untrusted-values.ts";

export type ApiResult<TBody> =
  | Readonly<{ kind: "ok"; body: TBody }>
  | Readonly<{ kind: "failed"; status: number; error: DeckApiErrorBody }>
  | Readonly<{ kind: "unreachable"; message: string }>;

/** `window.fetch`, injected so tests answer with `Response`s they build. */
export type Fetch = (address: string, init: RequestInit) => Promise<Response>;

/** How this page is signed in, and the values the API needs from that session. */
export type SessionCredentials = Readonly<{
  mode: "cookie" | "bearer";
  csrfToken: () => string | null;
  bearerToken: () => string | null;
  /** After GET /deck-api/session or a bearer renewal. */
  update: (options: Readonly<{ csrfToken: string; bearerToken: string | null }>) => void;
}>;

export function sessionCredentials(mode: SessionCredentials["mode"]): SessionCredentials {
  let csrfToken: string | null = null;
  let bearerToken: string | null = null;
  return {
    mode,
    csrfToken: () => csrfToken,
    bearerToken: () => bearerToken,
    update: (options) => {
      csrfToken = options.csrfToken;
      bearerToken = options.bearerToken;
    },
  };
}

export type DeckApiClient = Readonly<{
  /** GET /deck-api/session; a 200 also refreshes the CSRF token held in `credentials`. */
  session: () => Promise<ApiResult<DeckSessionBody>>;
  listDecks: () => Promise<ApiResult<DeckListBody>>;
  createDeck: (request: CreateDeckRequest) => Promise<ApiResult<CreateDeckBody>>;
  importFromGoogleSlides: (request: GoogleSlidesImportRequest) => Promise<ApiResult<GoogleSlidesImportBody>>;
  /** POST /deck-api/embed/session with the fragment's ticket; a 200 holds the bearer in `credentials`. */
  exchangeTicket: (request: EmbedSessionRequest) => Promise<ApiResult<EmbedSessionBody>>;
  /** POST /deck-api/embed/renew; a 200 holds the fresh bearer. */
  renewBearer: () => Promise<ApiResult<EmbedSessionBody>>;
  deck: (deckId: DeckId) => DeckClient;
  credentials: SessionCredentials;
}>;

/** An asset's bytes and the media type the server sent them with (null when it is not an image type). */
export type FetchedAsset = Readonly<{ bytes: ArrayBuffer; mediaType: AssetMediaType | null }>;

/** Calls about one deck; the id is carried, never repeated. */
export type DeckClient = Readonly<{
  deckId: DeckId;
  details: () => Promise<ApiResult<DeckDetailsBody>>;
  updateSharing: (request: UpdateDeckRequest) => Promise<ApiResult<DeckDetailsBody>>;
  invite: (request: InviteRequest) => Promise<ApiResult<InviteBody>>;
  changeMember: (options: Readonly<{ personId: string; request: ChangeMemberRequest }>) => Promise<ApiResult<DeckDetailsBody>>;
  removeMember: (personId: string) => Promise<ApiResult<DeckDetailsBody>>;
  cancelInvitation: (invitationId: string) => Promise<ApiResult<DeckDetailsBody>>;
  remove: () => Promise<ApiResult<null>>;
  putAsset: (options: Readonly<{ bytes: ArrayBuffer; mediaType: AssetMediaType }>) => Promise<ApiResult<AssetUploadBody>>;
  fetchAsset: (assetId: AssetId) => Promise<ApiResult<FetchedAsset>>;
  revertAgentSession: (agentSessionId: string) => Promise<ApiResult<AgentRevertOutcome>>;
  exportToGoogleSlides: (request: GoogleSlidesExportRequest) => Promise<ApiResult<GoogleSlidesExportBody>>;
}>;

export function createDeckApiClient(options: Readonly<{ origin: string; fetch: Fetch; credentials: SessionCredentials }>): DeckApiClient {
  const { credentials } = options;
  const call = <TBody>(request: ApiRequest<TBody>): Promise<ApiResult<TBody>> => send({ origin: options.origin, fetch: options.fetch, credentials, request });
  const holdSession = (result: ApiResult<DeckSessionBody>): ApiResult<DeckSessionBody> => {
    const body = okBodyOf(result);
    if (body !== null) credentials.update({ csrfToken: body.csrfToken, bearerToken: credentials.bearerToken() });
    return result;
  };
  const holdBearer = (result: ApiResult<EmbedSessionBody>): ApiResult<EmbedSessionBody> => {
    const body = okBodyOf(result);
    if (body !== null) credentials.update({ csrfToken: body.session.csrfToken, bearerToken: body.bearerToken });
    return result;
  };
  return {
    session: () => call({ method: "GET", path: DECK_API_PATHS.session, body: null, read: readDeckSessionBody }).then(holdSession),
    listDecks: () => call({ method: "GET", path: DECK_API_PATHS.decks, body: null, read: readDeckListBody }),
    createDeck: (request) => call({ method: "POST", path: DECK_API_PATHS.decks, body: structured(request), read: readCreateDeckBody }),
    importFromGoogleSlides: (request) => call({ method: "POST", path: DECK_API_PATHS.googleSlidesImport, body: structured(request), read: readGoogleSlidesImportBody }),
    exchangeTicket: (request) => call({ method: "POST", path: DECK_API_PATHS.embedSession, body: structured(request), read: readEmbedSessionBody }).then(holdBearer),
    renewBearer: () => call({ method: "POST", path: DECK_API_PATHS.embedRenew, body: structured({}), read: readEmbedSessionBody }).then(holdBearer),
    deck: (deckId) => deckClient({ deckId, call }),
    credentials,
  };
}

/** The parsed body of an `ok` result, else null. */
export function okBodyOf<TBody>(result: ApiResult<TBody>): TBody | null {
  switch (result.kind) {
    case "ok":
      return result.body;
    case "failed":
    case "unreachable":
      return null;
    default:
      return assertNever(result);
  }
}

/** Where a signed-out answer sends the browser (`DeckApiErrorBody.signInAddress`), else null. */
export function signInAddressOf(result: ApiResult<unknown>): string | null {
  switch (result.kind) {
    case "failed":
      return result.error.signInAddress;
    case "ok":
    case "unreachable":
      return null;
    default:
      return assertNever(result);
  }
}

/** A sentence for the person about a result that is not `ok`; null for `ok`. */
export function problemOf(result: ApiResult<unknown>): string | null {
  switch (result.kind) {
    case "ok":
      return null;
    case "failed":
      return result.error.message;
    case "unreachable":
      return "Sasha Slides could not be reached. Check the connection and try again.";
    default:
      return assertNever(result);
  }
}

type RequestBody = Readonly<{ kind: "structured"; text: string }> | Readonly<{ kind: "bytes"; bytes: ArrayBuffer; mediaType: string }>;

type ApiRequest<TBody> = Readonly<{
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body: RequestBody | null;
  /** Parses a 2xx body (throws `MalformedValue` when it does not fit); `asset` reads raw bytes. */
  read: ((value: unknown) => TBody) | Readonly<{ kind: "asset" }> | Readonly<{ kind: "empty" }>;
}>;

function structured(value: unknown): RequestBody {
  return { kind: "structured", text: JSON.stringify(value) };
}

function deckClient(options: Readonly<{ deckId: DeckId; call: <TBody>(request: ApiRequest<TBody>) => Promise<ApiResult<TBody>> }>): DeckClient {
  const { deckId, call } = options;
  return {
    deckId,
    details: () => call({ method: "GET", path: DECK_API_PATHS.deck(deckId), body: null, read: readDeckDetailsBody }),
    updateSharing: (request) => call({ method: "PATCH", path: DECK_API_PATHS.deck(deckId), body: structured(request), read: readDeckDetailsBody }),
    invite: (request) => call({ method: "POST", path: DECK_API_PATHS.members(deckId), body: structured(request), read: readInviteBody }),
    changeMember: (change) => call({ method: "PATCH", path: DECK_API_PATHS.member(deckId, change.personId), body: structured(change.request), read: readDeckDetailsBody }),
    removeMember: (personId) => call({ method: "DELETE", path: DECK_API_PATHS.member(deckId, personId), body: null, read: readDeckDetailsBody }),
    cancelInvitation: (invitationId) => call({ method: "DELETE", path: DECK_API_PATHS.invitation(deckId, invitationId), body: null, read: readDeckDetailsBody }),
    remove: () => call<null>({ method: "DELETE", path: DECK_API_PATHS.deck(deckId), body: null, read: { kind: "empty" } }),
    putAsset: (asset) => call({ method: "PUT", path: DECK_API_PATHS.assets(deckId), body: { kind: "bytes", bytes: asset.bytes, mediaType: asset.mediaType }, read: readAssetUploadBody }),
    fetchAsset: (assetId) => call<FetchedAsset>({ method: "GET", path: DECK_API_PATHS.asset(deckId, assetId), body: null, read: { kind: "asset" } }),
    revertAgentSession: (agentSessionId) => call({ method: "POST", path: DECK_API_PATHS.agentSessionRevert(deckId, agentSessionId), body: structured({}), read: readAgentRevertOutcome }),
    exportToGoogleSlides: (request) => call({ method: "POST", path: DECK_API_PATHS.googleSlidesExport(deckId), body: structured(request), read: readGoogleSlidesExportBody }),
  };
}

async function send<TBody>(options: Readonly<{ origin: string; fetch: Fetch; credentials: SessionCredentials; request: ApiRequest<TBody> }>): Promise<ApiResult<TBody>> {
  const { request, credentials } = options;
  let response: Response;
  try {
    response = await options.fetch(`${options.origin}${request.path}`, requestInit({ request, credentials }));
  } catch (error) {
    return { kind: "unreachable", message: error instanceof Error ? error.message : String(error) };
  }
  try {
    if (!response.ok) return { kind: "failed", status: response.status, error: errorOf({ status: response.status, text: await response.text() }) };
    return await bodyOf({ response, read: request.read });
  } catch (error) {
    return { kind: "unreachable", message: error instanceof Error ? error.message : String(error) };
  }
}

function requestInit<TBody>(options: Readonly<{ request: ApiRequest<TBody>; credentials: SessionCredentials }>): RequestInit {
  const { request, credentials } = options;
  const headers = new Headers({ Accept: "application/json" });
  const csrfToken = credentials.csrfToken();
  if (changesState(request.method) && csrfToken !== null) headers.set(CSRF_HEADER_NAME, csrfToken);
  const bearerToken = credentials.bearerToken();
  // Only the embedded editor holds a bearer; with the cookie, `bearerToken()` is always null.
  if (bearerToken !== null) headers.set("Authorization", `Bearer ${bearerToken}`);
  const payload = request.body === null ? null : payloadOf(request.body);
  if (payload !== null) headers.set("Content-Type", payload.contentType);
  return {
    method: request.method,
    headers,
    credentials: credentialsModeOf(credentials.mode),
    ...(payload === null ? {} : { body: payload.content }),
  };
}

/** Every request but a read must carry the CSRF header (SPEC.md 21.2). */
function changesState(method: ApiRequest<unknown>["method"]): boolean {
  switch (method) {
    case "GET":
      return false;
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
      return true;
    default:
      return assertNever(method);
  }
}

function payloadOf(body: RequestBody): Readonly<{ contentType: string; content: string | ArrayBuffer }> {
  switch (body.kind) {
    case "structured":
      return { contentType: "application/json", content: body.text };
    case "bytes":
      return { contentType: body.mediaType, content: body.bytes };
    default:
      return assertNever(body);
  }
}

/** The cookie rides only on our own origin; the embedded editor sends none (see the header). */
function credentialsModeOf(mode: SessionCredentials["mode"]): RequestCredentials {
  switch (mode) {
    case "cookie":
      return "same-origin";
    case "bearer":
      return "omit";
    default:
      return assertNever(mode);
  }
}

async function bodyOf<TBody>(options: Readonly<{ response: Response; read: ApiRequest<TBody>["read"] }>): Promise<ApiResult<TBody>> {
  const { response, read } = options;
  if (typeof read === "function") {
    const text = await response.text();
    const body = parseOrNull(() => read(parseStructuredText(text)));
    return body === null ? malformed(response.status) : { kind: "ok", body };
  }
  switch (read.kind) {
    case "asset": {
      const asset: FetchedAsset = { bytes: await response.arrayBuffer(), mediaType: assetMediaTypeOf(response.headers.get("Content-Type")) };
      // The request asked for an asset, so TBody is FetchedAsset (`fetchAsset` is the only caller).
      return { kind: "ok", body: asset as TBody };
    }
    case "empty":
      // The request expects no body, so TBody is null (`remove` is the only caller).
      return { kind: "ok", body: null as TBody };
    default:
      return assertNever(read);
  }
}

function assetMediaTypeOf(contentType: string | null): AssetMediaType | null {
  const essence = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return ASSET_MEDIA_TYPES.find((mediaType) => mediaType === essence) ?? null;
}

const ASSET_MEDIA_TYPES = keysOf<AssetMediaType>({ "image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true, "image/svg+xml": true });

function malformed(status: number): ApiResult<never> {
  return { kind: "failed", status, error: { error: "serverError", message: "The server answered with something this page does not understand.", signInAddress: null, connectAddress: null, retryAfterSeconds: null } };
}

function errorOf(options: Readonly<{ status: number; text: string }>): DeckApiErrorBody {
  const parsed = parseOrNull(() => readDeckApiError(parseStructuredText(options.text)));
  if (parsed !== null) return parsed;
  return { error: "serverError", message: `The server answered ${options.status}.`, signInAddress: null, connectAddress: null, retryAfterSeconds: null };
}

