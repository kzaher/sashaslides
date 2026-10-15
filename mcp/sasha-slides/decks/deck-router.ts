/**
 * The deck server's HTTP surface (SPEC.md 21.2): the pages, `/deck-api/*`, and the delegation of
 * the Google Slides prefixes and the shared Google callback to the Google Slides module. The
 * WebSocket upgrade is `deck-socket.ts`.
 *
 * Security choices, each against a named attack:
 *
 *  - CROSS-SITE REQUEST FORGERY. Every state-changing request (POST, PUT, PATCH, DELETE) needs an
 *    `Origin` equal to the public origin (`originRefused` otherwise) and, with a session,
 *    `X-Sasha-Csrf` equal to the session's token (`csrfMismatch`). A custom header forces a CORS
 *    preflight, which this server never answers, and the cookie is SameSite=Strict on top.
 *  - MEMBERSHIP PROBING. A deck the caller cannot read answers exactly like one that does not
 *    exist: 404 `notFound` (deck-manager.ts).
 *  - A STOLEN EMBED TOKEN. A bearer token opens its own deck only; every other deck is 404, and the
 *    deck list and deck creation are refused.
 *  - AN ERASED ACCOUNT'S COOKIE. Every request re-reads the account; one that no longer exists is
 *    signed out and its cookie cleared.
 *  - CONTENT SNIFFING OF UPLOADS. An upload's type is believed only when its bytes agree
 *    (asset-media.ts), and every asset is served `nosniff` under a sandboxing policy, so an SVG
 *    opened directly runs nothing.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import {
  CSRF_HEADER_NAME,
  DECK_API_PATHS,
  DECK_API_PREFIX,
  DECK_LIST_PAGE_PATH,
  DECK_PAGE_PATH_PREFIX,
  DECK_SESSION_LIFETIME_MILLISECONDS,
  DECK_SESSION_START_PATH,
  type AgentRevertBody,
  type AssetUploadBody,
  type CreateDeckBody,
  type DeckApiErrorBody,
  type DeckApiErrorCode,
  type DeckListBody,
  type DeckSessionBody,
  type EmbedSessionBody,
  type ProfileBody,
} from "../engine/src/contracts/deck-api.ts";
import { COLLABORATION_LIMITS, DECK_SYNC_PATH_PREFIX } from "../engine/src/contracts/collaboration.ts";
import { roleAllows } from "../engine/src/contracts/deck-access.ts";
import { parseAssetId, parseDeckId, type AssetId, type DeckId } from "../engine/src/contracts/ids.ts";
import {
  GOOGLE_CALLBACK_SHARED_PATH,
  GOOGLE_SLIDES_DECK_ROUTE_SEGMENT,
  GOOGLE_SLIDES_ROUTE_PREFIXES,
  type GoogleSlidesInterchange,
} from "../deck-contracts/deck-service-contract";
import { bytesMatchMediaType } from "./asset-media";
import type { DeckAccounts, DeckPeople } from "./deck-accounts";
import type { DeckManager, Outcome, Refusal } from "./deck-manager";
import { parseInvitedRole, parseLinkSharing } from "./deck-records";
import type { DeckSession, DeckSessionCookies, EmbedSessions } from "./deck-sessions";
import { constantTimeEqual } from "./deck-sessions";
import { parseMediaType } from "./deck-storage";
import { asRecord } from "./deck-wire-values";
import type { WebApplication } from "./web-application";

export type DeckRouter = Readonly<{
  /** Resolves true when it answered; false for every path it does not own. */
  handleRequest(options: Readonly<{ request: IncomingMessage; response: ServerResponse; url: URL }>): Promise<boolean>;
  /** The session a request carries (bearer first, then the cookie), with the account re-read. */
  authenticate(request: IncomingMessage): Promise<DeckSession | null>;
}>;

export type DeckRouterOptions = Readonly<{
  publicUrl: string;
  manager: DeckManager;
  people: DeckPeople;
  accounts: DeckAccounts;
  cookies: DeckSessionCookies;
  embeds: EmbedSessions;
  web: WebApplication;
  interchange: GoogleSlidesInterchange;
  now: () => number;
  warn: (message: string) => void;
}>;

/** The return paths `/account/deck-session` accepts; anything else becomes `/decks`. */
export function validDeckReturnPath(candidate: string | null): string {
  if (candidate === null) return DECK_LIST_PAGE_PATH;
  if (candidate === DECK_LIST_PAGE_PATH) return candidate;
  if (candidate.startsWith(DECK_PAGE_PATH_PREFIX) && parseDeckId(candidate.slice(DECK_PAGE_PATH_PREFIX.length)) !== null) return candidate;
  return DECK_LIST_PAGE_PATH;
}

/**
 * The page that made a request, from its `Referer`, when that page is on our own origin: a signed
 * out `/deck/<id>` page asks `/deck-api/session` without naming itself, and sending the person back
 * to that deck after sign-in (rather than to `/decks`) needs its path. Browsers send the full
 * same-origin address under the default `strict-origin-when-cross-origin` policy; anything else
 * (no header, another origin, a malformed value) is null, and `validDeckReturnPath` still decides.
 */
export function sameOriginRefererPath(options: Readonly<{ request: IncomingMessage; origin: string }>): string | null {
  const referer = options.request.headers.referer;
  if (typeof referer !== "string") return null;
  try {
    const page = new URL(referer);
    return page.origin === options.origin ? page.pathname : null;
  } catch {
    return null;
  }
}

/** The public origin (`https://sashaslides.com`) of a `--public-url`. */
export function publicOrigin(publicUrl: string): string {
  return new URL(publicUrl).origin;
}

export function createDeckRouter(options: DeckRouterOptions): DeckRouter {
  const { manager, people, accounts, cookies, embeds, interchange, now, warn } = options;
  const origin = publicOrigin(options.publicUrl);

  const authenticate = async (request: IncomingMessage): Promise<DeckSession | null> => {
    const bearer = bearerOf(request);
    const session = bearer === null ? cookies.read(request) : embeds.verify({ bearerToken: bearer });
    if (session === null) return null;
    return (await accounts.exists({ accountId: session.accountId })) ? session : null;
  };

  async function route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (path === GOOGLE_CALLBACK_SHARED_PATH) return interchange.handleRequest({ request, response, url, caller: null });
    if (options.web.handleRequest({ request, response, url })) return true;
    if (path !== DECK_API_PREFIX && !path.startsWith(`${DECK_API_PREFIX}/`)) return false;
    const method = request.method ?? "GET";
    if (GOOGLE_SLIDES_ROUTE_PREFIXES.some((prefix) => path.startsWith(prefix)) && !path.startsWith(GOOGLE_SLIDES_SESSION_PREFIX)) {
      // The add-on's server-to-server calls (Code.gs sends no Origin) and the capability addresses
      // Google fetches authenticate themselves (deck-service-contract.ts `DeckRouteHandler`).
      if (!(await interchange.handleRequest({ request, response, url, caller: null }))) notFound(response);
      return true;
    }
    const changing = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
    if (changing && request.headers.origin !== origin) {
      sendError({ response, status: 403, error: "originRefused", message: "This request did not come from Sasha Slides." });
      return true;
    }
    if (path === DECK_API_PATHS.embedSession && method === "POST") return embedSession(request, response);
    if (path.startsWith(DECK_SYNC_PATH_PREFIX)) {
      sendError({ response, status: 426, error: "invalidRequest", message: "Open this address as a WebSocket." });
      return true;
    }
    const session = await authenticate(request);
    if (session === null) {
      sendError({
        response,
        status: 401,
        error: "signedOut",
        message: "Please sign in.",
        signInAddress: `${DECK_SESSION_START_PATH}?return=${encodeURIComponent(validDeckReturnPath(url.searchParams.get("return") ?? sameOriginRefererPath({ request, origin })))}`,
        cookies: cookies.read(request) === null ? [] : [cookies.clear()],
      });
      return true;
    }
    if (changing) {
      const header = request.headers[CSRF_HEADER_NAME.toLowerCase()];
      if (typeof header !== "string" || !constantTimeEqual(header, session.forgeryToken)) {
        sendError({ response, status: 403, error: "csrfMismatch", message: "Reload the page and try again." });
        return true;
      }
    }
    await authenticatedRoute({ request, response, url, session, method });
    return true;
  }

  async function authenticatedRoute(
    request: Readonly<{ request: IncomingMessage; response: ServerResponse; url: URL; session: DeckSession; method: string }>,
  ): Promise<void> {
    const { response, url, session, method } = request;
    const path = url.pathname;
    const accountId = session.accountId;
    if (path.startsWith(GOOGLE_SLIDES_SESSION_PREFIX)) {
      if (session.kind === "bearer") return notFound(response);
      if (!(await interchange.handleRequest({ request: request.request, response, url, caller: await people.callerFor({ accountId }) }))) notFound(response);
      return;
    }
    if (path === DECK_API_PATHS.session) {
      if (method !== "GET") return methodNotAllowed(response, "GET");
      return sessionBody({ request: request.request, response, session });
    }
    if (path === DECK_API_PATHS.embedRenew) {
      if (method !== "POST") return methodNotAllowed(response, "POST");
      if (session.kind !== "bearer") return sendError({ response, status: 403, error: "notPermitted", message: "Only an embedded editor renews a token." });
      const renewed = embeds.renew({ session });
      return sendValue({ response, status: 200, body: await embedBody({ bearerToken: renewed.bearerToken, session: renewed.session }) });
    }
    if (path === DECK_API_PATHS.profile) return profile({ request: request.request, response, session, method });
    if (path === DECK_API_PATHS.decks) {
      if (session.kind === "bearer") return sendError({ response, status: 403, error: "notPermitted", message: "An embedded editor opens its own deck only." });
      if (method === "GET") {
        const body: DeckListBody = { decks: await manager.listDecks({ accountId }) };
        return sendValue({ response, status: 200, body });
      }
      if (method !== "POST") return methodNotAllowed(response, "GET, POST");
      const parsed = await readRequestValue(request.request);
      if (parsed.kind !== "ok") return sendBodyProblem(response, parsed);
      const fields = asRecord(parsed.value);
      const title = fields === null ? null : fields["title"];
      if (typeof title !== "string" || title.length > 200) return sendError({ response, status: 400, error: "invalidRequest", message: "A deck needs a title of at most 200 characters." });
      const created = await manager.createDeck({ accountId, title });
      if (created.kind !== "ok") return sendRefusal(response, created);
      created.value.lease.release();
      const body: CreateDeckBody = { deck: created.value.summary };
      return sendValue({ response, status: 201, body });
    }
    const deckRoute = parseDeckRoute(path);
    if (deckRoute === null) return notFound(response);
    if (session.kind === "bearer" && session.deckId !== deckRoute.deckId) return notFound(response);
    await deckRequest({ request: request.request, response, url, session, method, deckRoute });
  }

  async function deckRequest(
    options: Readonly<{ request: IncomingMessage; response: ServerResponse; url: URL; session: DeckSession; method: string; deckRoute: DeckRoute }>,
  ): Promise<void> {
    const { request, response, url, session, method, deckRoute } = options;
    const { deckId } = deckRoute;
    const accountId = session.accountId;
    switch (deckRoute.kind) {
      case "deck":
        if (method === "GET") return sendOutcome(response, await manager.details({ accountId, deckId }));
        if (method === "DELETE") return sendOutcome(response, await manager.deleteDeck({ accountId, deckId }), 204);
        if (method === "PATCH") {
          const parsed = await readRequestValue(request);
          if (parsed.kind !== "ok") return sendBodyProblem(response, parsed);
          const fields = asRecord(parsed.value);
          const linkSharing = fields === null ? null : parseLinkSharing(fields["linkSharing"]);
          if (linkSharing === null) return sendError({ response, status: 400, error: "invalidRequest", message: "linkSharing is off, or anyoneSignedIn as viewer or commenter." });
          return sendOutcome(response, await manager.setLinkSharing({ accountId, deckId, linkSharing }));
        }
        return methodNotAllowed(response, "GET, PATCH, DELETE");
      case "members": {
        if (method !== "POST") return methodNotAllowed(response, "POST");
        const parsed = await readRequestValue(request);
        if (parsed.kind !== "ok") return sendBodyProblem(response, parsed);
        const fields = asRecord(parsed.value);
        const email = fields === null ? null : fields["email"];
        const role = fields === null ? null : parseInvitedRole(fields["role"]);
        if (typeof email !== "string" || role === null) return sendError({ response, status: 400, error: "invalidRequest", message: "An invitation needs an email and a role." });
        return sendOutcome(response, await manager.invite({ accountId, deckId, email, role }));
      }
      case "member": {
        if (method === "DELETE") return sendOutcome(response, await manager.removeMember({ accountId, deckId, personId: deckRoute.personId }));
        if (method !== "PATCH") return methodNotAllowed(response, "PATCH, DELETE");
        const parsed = await readRequestValue(request);
        if (parsed.kind !== "ok") return sendBodyProblem(response, parsed);
        const fields = asRecord(parsed.value);
        const role = fields === null ? null : parseInvitedRole(fields["role"]);
        if (role === null) return sendError({ response, status: 400, error: "invalidRequest", message: "A member's role is editor, commenter or viewer." });
        return sendOutcome(response, await manager.changeMember({ accountId, deckId, personId: deckRoute.personId, role }));
      }
      case "invitation":
        if (method !== "DELETE") return methodNotAllowed(response, "DELETE");
        return sendOutcome(response, await manager.removeInvitation({ accountId, deckId, invitationId: deckRoute.invitationId }));
      case "assets":
        if (method !== "PUT") return methodNotAllowed(response, "PUT");
        return uploadAsset({ request, response, accountId, deckId });
      case "asset": {
        if (method !== "GET" && method !== "HEAD") return methodNotAllowed(response, "GET");
        const read = await manager.readAsset({ accountId, deckId, assetId: deckRoute.assetId });
        if (read.kind !== "ok") return sendRefusal(response, read);
        response.writeHead(200, {
          "content-type": read.value.mediaType,
          "content-length": String(read.value.bytes.length),
          "cache-control": "private, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        });
        response.end(method === "HEAD" ? undefined : Buffer.from(read.value.bytes));
        return;
      }
      case "revert": {
        if (method !== "POST") return methodNotAllowed(response, "POST");
        const reverted = await manager.revertAgentSession({ accountId, deckId, agentSessionId: deckRoute.agentSessionId });
        if (reverted.kind !== "ok") return sendRefusal(response, reverted);
        const body: AgentRevertBody = reverted.value;
        return sendValue({ response, status: 200, body });
      }
      case "googleSlides": {
        if (session.kind === "bearer" && session.deckId !== deckId) return notFound(response);
        const access = await manager.access({ accountId, deckId });
        if (access === null) return notFound(response);
        if (!(await interchange.handleRequest({ request, response, url, caller: await people.callerFor({ accountId }) }))) notFound(response);
        return;
      }
      default:
        return assertNever(deckRoute);
    }
  }

  async function sessionBody(options: Readonly<{ request: IncomingMessage; response: ServerResponse; session: DeckSession }>): Promise<void> {
    const { response } = options;
    let session = options.session;
    const renewed: string[] = [];
    // Renewed once half its life has passed, so an editor open all day keeps its session.
    if (session.kind === "cookie" && session.expiresAt - now() < DECK_SESSION_LIFETIME_MILLISECONDS / 2) {
      const issued = cookies.issue({ accountId: session.accountId });
      renewed.push(issued.setCookie);
      session = issued.session;
    }
    await manager.acceptInvitations({ accountId: session.accountId });
    sendValue({ response, status: 200, body: await sessionBodyOf(session), cookies: renewed });
  }

  async function sessionBodyOf(session: DeckSession): Promise<DeckSessionBody> {
    return {
      me: (await people.callerFor({ accountId: session.accountId })).person,
      email: await people.emailOf({ accountId: session.accountId }),
      csrfToken: session.forgeryToken,
      expiresAt: session.expiresAt,
      authentication: session.kind,
    };
  }

  async function embedBody(options: Readonly<{ bearerToken: string; session: Extract<DeckSession, { kind: "bearer" }> }>): Promise<EmbedSessionBody> {
    return { bearerToken: options.bearerToken, expiresAt: options.session.expiresAt, deckId: options.session.deckId, session: await sessionBodyOf(options.session) };
  }

  async function embedSession(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = await readRequestValue(request);
    if (parsed.kind !== "ok") {
      sendBodyProblem(response, parsed);
      return true;
    }
    const fields = asRecord(parsed.value);
    const ticket = fields === null ? null : fields["ticket"];
    const exchanged = typeof ticket === "string" ? embeds.exchange({ ticket }) : null;
    if (exchanged === null || !(await accounts.exists({ accountId: exchanged.session.accountId }))) {
      sendError({ response, status: 401, error: "signedOut", message: "Reopen the editor from the add-on menu." });
      return true;
    }
    sendValue({ response, status: 200, body: await embedBody(exchanged) });
    return true;
  }

  async function profile(options: Readonly<{ request: IncomingMessage; response: ServerResponse; session: DeckSession; method: string }>): Promise<void> {
    const { response, session } = options;
    const accountId = session.accountId;
    if (options.method === "GET") {
      const body: ProfileBody = { displayName: await people.displayNameOf({ accountId }) };
      return sendValue({ response, status: 200, body });
    }
    if (options.method !== "PUT") return methodNotAllowed(response, "GET, PUT");
    const parsed = await readRequestValue(options.request);
    if (parsed.kind !== "ok") return sendBodyProblem(response, parsed);
    const fields = asRecord(parsed.value);
    const name = fields === null ? null : fields["displayName"];
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (trimmed.length < 1 || trimmed.length > 60) return sendError({ response, status: 400, error: "invalidRequest", message: "A name is 1 to 60 characters." });
    await people.setDisplayName({ accountId, displayName: trimmed });
    const body: ProfileBody = { displayName: trimmed };
    sendValue({ response, status: 200, body });
  }

  async function uploadAsset(options: Readonly<{ request: IncomingMessage; response: ServerResponse; accountId: string; deckId: DeckId }>): Promise<void> {
    const { request, response } = options;
    const declared = parseMediaType((request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "");
    // Decided before the body is read: anyone signed in could otherwise make the server hold 25
    // megabytes per request for a deck they cannot even see (putAsset checks again).
    const access = await manager.access({ accountId: options.accountId, deckId: options.deckId });
    if (access === null) return notFound(response);
    if (!roleAllows({ role: access.role, permission: "editDocument" })) return sendRefusal(response, { kind: "notPermitted" });
    const body = await readBytes({ request, maximumBytes: COLLABORATION_LIMITS.maximumAssetBytes });
    if (body.kind === "tooLarge") return sendError({ response, status: 413, error: "tooLarge", message: "An image can be at most 25 megabytes." });
    if (declared === null || !bytesMatchMediaType({ bytes: body.bytes, mediaType: declared })) {
      return sendError({ response, status: 415, error: "unsupportedMediaType", message: "Upload a PNG, JPEG, GIF, WebP or SVG image whose content matches its type." });
    }
    const stored = await manager.putAsset({ accountId: options.accountId, deckId: options.deckId, bytes: body.bytes, mediaType: declared });
    if (stored.kind !== "ok") return sendRefusal(response, stored);
    const answer: AssetUploadBody = { assetId: stored.value.assetId, mediaType: declared, byteLength: stored.value.byteLength };
    sendValue({ response, status: 200, body: answer });
  }

  return {
    authenticate,
    handleRequest: async ({ request, response, url }) => {
      try {
        return await route(request, response, url);
      } catch (cause) {
        warn(`deck router: ${request.method ?? "?"} ${url.pathname} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        if (!response.headersSent) sendError({ response, status: 500, error: "serverError", message: "Something went wrong on our side." });
        else response.end();
        return true;
      }
    },
  };
}

/** The Google Slides paths that run with the caller's session (connect, import); the other prefixes authenticate themselves. */
const GOOGLE_SLIDES_SESSION_PREFIX = "/deck-api/google-slides/";

type DeckRoute =
  | Readonly<{ kind: "deck"; deckId: DeckId }>
  | Readonly<{ kind: "members"; deckId: DeckId }>
  | Readonly<{ kind: "member"; deckId: DeckId; personId: string }>
  | Readonly<{ kind: "invitation"; deckId: DeckId; invitationId: string }>
  | Readonly<{ kind: "assets"; deckId: DeckId }>
  | Readonly<{ kind: "asset"; deckId: DeckId; assetId: AssetId }>
  | Readonly<{ kind: "revert"; deckId: DeckId; agentSessionId: string }>
  | Readonly<{ kind: "googleSlides"; deckId: DeckId }>;

function parseDeckRoute(path: string): DeckRoute | null {
  const prefix = `${DECK_API_PATHS.decks}/`;
  if (!path.startsWith(prefix)) return null;
  const [deckText, section, item, action, extra] = path.slice(prefix.length).split("/");
  const deckId = deckText === undefined ? null : parseDeckId(deckText);
  if (deckId === null) return null;
  if (path.startsWith(`${prefix}${deckId}${GOOGLE_SLIDES_DECK_ROUTE_SEGMENT}`)) return { kind: "googleSlides", deckId };
  if (section === undefined) return { kind: "deck", deckId };
  if (extra !== undefined) return null;
  switch (section) {
    case "members":
      if (item === undefined) return { kind: "members", deckId };
      return action === undefined && item !== "" ? { kind: "member", deckId, personId: item } : null;
    case "invitations":
      return item !== undefined && item !== "" && action === undefined ? { kind: "invitation", deckId, invitationId: item } : null;
    case "assets": {
      if (item === undefined) return { kind: "assets", deckId };
      const assetId = action === undefined ? parseAssetId(item) : null;
      return assetId === null ? null : { kind: "asset", deckId, assetId };
    }
    case "agent-sessions":
      return item !== undefined && action === "revert" ? { kind: "revert", deckId, agentSessionId: decodeURIComponent(item) } : null;
    default:
      return null;
  }
}

function bearerOf(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer[ ]+([A-Za-z0-9_-]+)$/iu.exec(header.trim());
  return match?.[1] ?? null;
}

type RequestValue = Readonly<{ kind: "ok"; value: unknown }> | Readonly<{ kind: "tooLarge" }> | Readonly<{ kind: "notParsable" }> | Readonly<{ kind: "wrongType" }>;

/** A JSON request body, parsed (only `application/json` is read; see the limits beside it). */
async function readRequestValue(request: IncomingMessage): Promise<RequestValue> {
  const type = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    await readBytes({ request, maximumBytes: 0 });
    return { kind: "wrongType" };
  }
  const body = await readBytes({ request, maximumBytes: MAXIMUM_REQUEST_VALUE_BYTES });
  if (body.kind === "tooLarge") return body;
  try {
    return { kind: "ok", value: JSON.parse(Buffer.from(body.bytes).toString("utf-8")) };
  } catch {
    return { kind: "notParsable" };
  }
}

const MAXIMUM_REQUEST_VALUE_BYTES = 1024 * 1024;

/** Reads the body; past `maximumBytes` it keeps draining (so the answer can still be read) and reports `tooLarge`. */
function readBytes(options: Readonly<{ request: IncomingMessage; maximumBytes: number }>): Promise<Readonly<{ kind: "ok"; bytes: Uint8Array }> | Readonly<{ kind: "tooLarge" }>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    options.request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total <= options.maximumBytes) chunks.push(chunk);
    });
    options.request.on("end", () => resolve(total > options.maximumBytes ? { kind: "tooLarge" } : { kind: "ok", bytes: Buffer.concat(chunks) }));
    options.request.on("error", reject);
  });
}

function sendBodyProblem(response: ServerResponse, problem: Exclude<RequestValue, Readonly<{ kind: "ok" }>>): void {
  switch (problem.kind) {
    case "tooLarge":
      return sendError({ response, status: 413, error: "tooLarge", message: "The request is too large." });
    case "notParsable":
      return sendError({ response, status: 400, error: "invalidRequest", message: "The request body is not JSON." });
    case "wrongType":
      return sendError({ response, status: 415, error: "unsupportedMediaType", message: "Send Content-Type: application/json." });
    default:
      return assertNever(problem);
  }
}

function sendOutcome<TValue>(response: ServerResponse, outcome: Outcome<TValue>, status = 200): void {
  if (outcome.kind !== "ok") return sendRefusal(response, outcome);
  if (status === 204) {
    response.writeHead(204, { "cache-control": "no-store" }).end();
    return;
  }
  sendValue({ response, status, body: outcome.value });
}

function sendRefusal(response: ServerResponse, refusal: Refusal): void {
  switch (refusal.kind) {
    case "notFound":
      return notFound(response);
    case "notPermitted":
      return sendError({ response, status: 403, error: "notPermitted", message: "Your role on this deck does not allow that." });
    case "limitReached":
      return sendError({ response, status: 409, error: "limitReached", message: refusal.message });
    case "invalidRequest":
      return sendError({ response, status: 400, error: "invalidRequest", message: refusal.message });
    case "tooLarge":
      return sendError({ response, status: 413, error: "tooLarge", message: refusal.message });
    case "deckUnreadable":
      return sendError({ response, status: 503, error: "deckUnreadable", message: refusal.message });
    default:
      return assertNever(refusal);
  }
}

function notFound(response: ServerResponse): void {
  sendError({ response, status: 404, error: "notFound", message: "There is no such deck, or you cannot open it." });
}

function methodNotAllowed(response: ServerResponse, allow: string): void {
  response.setHeader("allow", allow);
  sendError({ response, status: 405, error: "invalidRequest", message: "This address does not accept that method." });
}

function sendError(
  options: Readonly<{
    response: ServerResponse;
    status: number;
    error: DeckApiErrorCode;
    message: string;
    signInAddress?: string;
    cookies?: readonly string[];
  }>,
): void {
  const body: DeckApiErrorBody = {
    error: options.error,
    message: options.message,
    signInAddress: options.signInAddress ?? null,
    connectAddress: null,
    retryAfterSeconds: null,
  };
  sendValue({ response: options.response, status: options.status, body, cookies: options.cookies ?? [] });
}

function sendValue(options: Readonly<{ response: ServerResponse; status: number; body: unknown; cookies?: readonly string[] }>): void {
  const text = JSON.stringify(options.body);
  options.response.writeHead(options.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(text, "utf-8")),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(options.cookies === undefined || options.cookies.length === 0 ? {} : { "set-cookie": [...options.cookies] }),
  });
  options.response.end(text);
}
