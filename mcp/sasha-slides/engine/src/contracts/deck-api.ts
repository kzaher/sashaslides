// THE DECK WEB APPLICATION'S HTTP SURFACE (milestone 2): page routes, the JSON API under
// `/deck-api`, the session, the add-on handoff and the Google Slides import and export bodies.
// Served by the connector (module "collaboration server" routes everything; the Google Slides and
// add-on routes are module "Google Slides" handlers mounted by it), consumed by the web module's
// pages and by the add-on's Code.gs. SPEC.md "Milestone 2" has the endpoint table with methods,
// permissions and status codes.
//
// Key decisions:
//
//  * ONE COOKIE, SCOPED TO THE API. The pages (`/decks`, `/deck/<id>`) are static shells that ask
//    `GET /deck-api/session` who is signed in, so only `/deck-api/*` (the API and the WebSocket)
//    needs the session. The deck session cookie is `sasha_deck; Path=/deck-api; HttpOnly; Secure;
//    SameSite=Strict`, an HMAC-signed `{accountId, exp, csrf}` like the account portal's but under
//    its own label, living 12 hours and renewed by `GET /deck-api/session` once half has passed.
//    Strict is safe because only our own pages call the API. It is MINTED by the account portal
//    at `GET /account/deck-session?return=<path>` (where the `/account` cookie is sent), which
//    signs the visitor in first when needed and then redirects to the validated return path.
//
//  * EVERY STATE-CHANGING REQUEST NEEDS THE CSRF HEADER AND OUR ORIGIN. `X-Sasha-Csrf` must equal
//    the session's token (a custom header forces a CORS preflight, which the server never
//    answers), and `Origin` must be the public origin; the WebSocket upgrade checks `Origin` too
//    (cross-site WebSocket hijacking).
//
//  * EMBEDDED IN THE ADD-ON THERE ARE NO COOKIES (third-party context), so the editor frame
//    exchanges a single-use TICKET from its address fragment for a 15-minute BEARER token kept in
//    memory (`POST /deck-api/embed/session`), sent as `Authorization: Bearer` and as the
//    WebSocket's second subprotocol (collaboration.ts). The fragment never reaches a server log.

import type { DeckInvitation, DeckMember, DeckRole, LinkSharing } from "./deck-access.ts";
import type { AgentRevertOutcome } from "./collaboration.ts";
import type { Person } from "./discussion.ts";
import type { AssetMediaType } from "./document.ts";
import type { AssetId, DeckId, ElementId, SlideId } from "./ids.ts";

// --- paths --------------------------------------------------------------------------------------

export const DECK_LIST_PAGE_PATH = "/decks";
/** `/deck/<deckId>`; `?embed=addon#ticket=<ticket>` inside the add-on dialog. */
export const DECK_PAGE_PATH_PREFIX = "/deck/";
/** The web module's built files (`dist/web/assets/*`), served immutable under this prefix. */
export const DECK_APPLICATION_ASSETS_PREFIX = "/deck-app/";
export const DECK_API_PREFIX = "/deck-api";
/** Signs in when needed, sets the deck session cookie, then redirects to `return` (validated). */
export const DECK_SESSION_START_PATH = "/account/deck-session";
export const DECK_SESSION_COOKIE_NAME = "sasha_deck";
export const DECK_SESSION_COOKIE_PATH = "/deck-api";
export const DECK_SESSION_LIFETIME_MILLISECONDS = 12 * 60 * 60 * 1000;
export const EMBED_BEARER_LIFETIME_MILLISECONDS = 15 * 60 * 1000;
export const EMBED_TICKET_LIFETIME_MILLISECONDS = 2 * 60 * 1000;
export const CSRF_HEADER_NAME = "X-Sasha-Csrf";

/** The origins allowed to frame `/deck/<id>?embed=addon` (`Content-Security-Policy: frame-ancestors`). */
export const ADDON_FRAME_ANCESTORS: readonly string[] = ["https://docs.google.com", "https://*.googleusercontent.com"];

/** Every API path, built in one place so the server's router and the client agree by construction. */
/**
 * The query parameter of a deck address that opens one transition script's review in the editor:
 * `deck_write_transition` answers with `/deck/<id>?reviewTransitionScript=<scriptId>`, the address
 * Claude hands the person who must approve the script (agent scripts always land unapproved).
 */
export const TRANSITION_REVIEW_QUERY = "reviewTransitionScript";

/**
 * Headers Code.gs sends on GET `/deck-api/addon/export/<id>` and on its `/result` (21.13): the
 * add-on's identity token and the presentation's binding secret authenticate the call (there is no
 * session; the router skips its Origin and CSRF checks for `/deck-api/addon/*`), and the
 * presentation's current page ids, comma separated, tell the plan which pages it replaces.
 */
export const ADDON_REQUEST_HEADERS = {
  identityToken: "x-sasha-identity-token",
  bindingSecret: "x-sasha-binding-secret",
  presentationPageIds: "x-sasha-presentation-pages",
} as const;

export const DECK_API_PATHS = {
  session: `${DECK_API_PREFIX}/session`,
  profile: `${DECK_API_PREFIX}/profile`,
  decks: `${DECK_API_PREFIX}/decks`,
  deck: (deckId: DeckId): string => `${DECK_API_PREFIX}/decks/${deckId}`,
  members: (deckId: DeckId): string => `${DECK_API_PREFIX}/decks/${deckId}/members`,
  member: (deckId: DeckId, personId: string): string => `${DECK_API_PREFIX}/decks/${deckId}/members/${personId}`,
  invitation: (deckId: DeckId, invitationId: string): string => `${DECK_API_PREFIX}/decks/${deckId}/invitations/${invitationId}`,
  assets: (deckId: DeckId): string => `${DECK_API_PREFIX}/decks/${deckId}/assets`,
  asset: (deckId: DeckId, assetId: AssetId): string => `${DECK_API_PREFIX}/decks/${deckId}/assets/${assetId}`,
  agentSessionRevert: (deckId: DeckId, agentSessionId: string): string =>
    `${DECK_API_PREFIX}/decks/${deckId}/agent-sessions/${encodeURIComponent(agentSessionId)}/revert`,
  googleSlidesImport: `${DECK_API_PREFIX}/google-slides/import`,
  /** GET, a top-level navigation: Google consent for the Slides scope, then back to `?return=`. */
  googleSlidesConnect: `${DECK_API_PREFIX}/google-slides/connect`,
  /** A 30-minute capability address Google fetches an exported image from (`createImage`). */
  exportAsset: (token: string, assetId: AssetId): string => `${DECK_API_PREFIX}/export-assets/${token}/${assetId}`,
  googleSlidesExport: (deckId: DeckId): string => `${DECK_API_PREFIX}/decks/${deckId}/google-slides/export`,
  embedSession: `${DECK_API_PREFIX}/embed/session`,
  embedRenew: `${DECK_API_PREFIX}/embed/renew`,
  addonHandoff: `${DECK_API_PREFIX}/addon/handoff`,
  addonImport: `${DECK_API_PREFIX}/addon/import`,
  addonExport: (exportId: string): string => `${DECK_API_PREFIX}/addon/export/${exportId}`,
  addonExportResult: (exportId: string): string => `${DECK_API_PREFIX}/addon/export/${exportId}/result`,
} as const;

// --- errors -------------------------------------------------------------------------------------

export type DeckApiErrorCode =
  | "signedOut"
  | "csrfMismatch"
  | "originRefused"
  | "notFound"
  | "notPermitted"
  | "invalidRequest"
  | "tooLarge"
  | "unsupportedMediaType"
  | "rateLimited"
  | "limitReached"
  | "googleNotConnected"
  | "googlePermissionDenied"
  | "googlePresentationNotFound"
  | "googleFailed"
  | "addonIdentityRejected"
  /** 503: the deck's saved snapshot does not open or decode; it is refused, not loaded partially. */
  | "deckUnreadable"
  | "serverError";

/** The body of every non-2xx JSON answer. */
export type DeckApiErrorBody = Readonly<{
  error: DeckApiErrorCode;
  /** A sentence for the person, never a stack. */
  message: string;
  /** `signedOut`: where to send the browser (DECK_SESSION_START_PATH with the return path). */
  signInAddress: string | null;
  /** `googleNotConnected`: where the person grants Google Slides access to Sasha. */
  connectAddress: string | null;
  retryAfterSeconds: number | null;
}>;

// --- session and profile ------------------------------------------------------------------------

/** GET /deck-api/session (200), or 401 `signedOut` with `signInAddress`. */
export type DeckSessionBody = Readonly<{
  me: Person;
  /** The account's sign-in address, for the account menu; null when it has none. */
  email: string | null;
  csrfToken: string;
  expiresAt: number;
  authentication: "cookie" | "bearer";
}>;

/** GET and PUT /deck-api/profile: the name collaborators see. 1 to 60 characters, trimmed. */
export type ProfileBody = Readonly<{ displayName: string }>;

// --- decks --------------------------------------------------------------------------------------

export type GoogleSlidesLink = Readonly<{
  presentationId: string;
  presentationAddress: string;
  /** Title of the presentation when last imported or exported. */
  title: string;
  lastImportedAt: number | null;
  lastExportedAt: number | null;
  /** `revisionId` of the presentation the last import read; the add-on compares it to offer a re-import. */
  importedRevisionId: string | null;
  /**
   * Every page id the last import read. A linked export deletes these when the deck no longer
   * holds them -- including pages whose Google id was too short to keep, which the import renamed
   * (measured 2026-10-15: page "p" survived beside its renamed copy). Empty for links made before.
   */
  importedPageIds: readonly string[];
}>;

export type DeckSummary = Readonly<{
  deckId: DeckId;
  /** The document's `meta.title` as the server last saw it. */
  title: string;
  /** The caller's role. */
  role: DeckRole;
  owner: Person;
  createdAt: number;
  updatedAt: number;
  googleSlides: GoogleSlidesLink | null;
}>;

/** GET /deck-api/decks: decks the caller owns or is a member of, most recently updated first. */
export type DeckListBody = Readonly<{ decks: readonly DeckSummary[] }>;

/** POST /deck-api/decks. The server mints the deck id and seeds a blank deck (model `blankDeck`). */
export type CreateDeckRequest = Readonly<{ title: string }>;
export type CreateDeckBody = Readonly<{ deck: DeckSummary }>;

/** GET /deck-api/decks/<id>. `invitations` is empty unless the caller may share. */
export type DeckDetailsBody = Readonly<{
  deck: DeckSummary;
  members: readonly DeckMember[];
  invitations: readonly DeckInvitation[];
  linkSharing: LinkSharing;
  /** Agent sessions with revertible edits, newest first, for "Undo Claude's edit" after a reload. */
  agentSessions: readonly AgentSessionSummary[];
}>;

export type AgentSessionSummary = Readonly<{ agentSessionId: string; agentName: string; editCount: number; lastEditAt: number }>;

/** PATCH /deck-api/decks/<id> (owner). Title changes go through the document, never here. */
export type UpdateDeckRequest = Readonly<{ linkSharing: LinkSharing }>;

/** POST /deck-api/decks/<id>/members (owner). */
export type InviteRequest = Readonly<{ email: string; role: Exclude<DeckRole, "owner"> }>;
export type InviteBody = Readonly<{
  /** `added`: the address belongs to an account, now a member. `invited`: pending until that address signs in. */
  outcome: "added" | "invited" | "alreadyMember";
  details: DeckDetailsBody;
}>;

/** PATCH /deck-api/decks/<id>/members/<personId> (owner). DELETE removes (owner, or the member themself). */
export type ChangeMemberRequest = Readonly<{ role: Exclude<DeckRole, "owner"> }>;

/** PUT /deck-api/decks/<id>/assets with the raw bytes as the body and `Content-Type` one of `AssetMediaType`. */
export type AssetUploadBody = Readonly<{ assetId: AssetId; mediaType: AssetMediaType; byteLength: number }>;

/** POST /deck-api/decks/<id>/agent-sessions/<agentSessionId>/revert. */
export type AgentRevertBody = AgentRevertOutcome;

// --- Google Slides --------------------------------------------------------------------------------

/** Something the engine and Slides express differently, and what was done about it. */
export type InterchangeLoss = Readonly<{
  slideId: SlideId | null;
  elementId: ElementId | null;
  /** A short stable name, e.g. "radialGradient", "perSideBorder", "scriptedTransition", "video". */
  feature: string;
  /** What the person sees instead, in a sentence. */
  detail: string;
}>;

export type GoogleSlidesImportReport = Readonly<{
  presentationId: string;
  title: string;
  slideCount: number;
  elementCount: number;
  losses: readonly InterchangeLoss[];
}>;

export type GoogleSlidesExportReport = Readonly<{
  presentationId: string;
  presentationAddress: string;
  slideCount: number;
  requestCount: number;
  losses: readonly InterchangeLoss[];
}>;

/** POST /deck-api/google-slides/import: a presentation id or its address. Creates a new deck. */
export type GoogleSlidesImportRequest = Readonly<{ presentation: string }>;
export type GoogleSlidesImportBody = Readonly<{ deck: DeckSummary; report: GoogleSlidesImportReport }>;

/** POST /deck-api/decks/<id>/google-slides/export. */
export type GoogleSlidesExportRequest = Readonly<{
  target: Readonly<{ kind: "newPresentation" }> | Readonly<{ kind: "linkedPresentation" }>;
}>;

export type GoogleSlidesExportBody =
  /** The server wrote the presentation with the caller's own Google grant. */
  | Readonly<{ kind: "exported"; report: GoogleSlidesExportReport }>
  /**
   * Embedded in the add-on without a Google grant on the server: the add-on writes it with its own
   * authorization. The editor frame posts `exportRequested` to the shell (AddonShellMessage).
   */
  | Readonly<{ kind: "runInAddon"; exportId: string }>;

// --- the add-on (server to server from Code.gs, and the editor frame inside its dialog) -----------

/**
 * The answer to POST /deck-api/addon/handoff from Code.gs (UrlFetchApp), which sends
 * `identityToken` (`ScriptApp.getIdentityToken()`), `presentationId`, `bindingSecret` (the
 * presentation's 32 random bytes from `PropertiesService.getDocumentProperties()`, base64url, which
 * only editors of that presentation can read) and the presentation's current `revisionId`.
 * SPEC.md "Milestone 2", "Add-on embedding".
 */
export type AddonHandoffBody =
  /** A deck is bound and current: open it. */
  | Readonly<{ kind: "open"; deckId: DeckId; ticket: string }>
  /** A deck is bound but the presentation changed since: the dialog offers "Open" or "Import again". */
  | Readonly<{ kind: "changedSinceImport"; deckId: DeckId; ticket: string; importToken: string }>
  /** No deck yet: Code.gs reads the presentation and posts it to `addonImport` with this token. */
  | Readonly<{ kind: "needsImport"; importToken: string }>;

/**
 * The answer to POST /deck-api/addon/import, which sends the `importToken`, the Slides API
 * `Presentation` JSON (parsed by the server) and the bound deck whose slides it replaces after
 * `changedSinceImport`, if any.
 */
export type AddonImportBody = Readonly<{ deckId: DeckId; ticket: string; report: GoogleSlidesImportReport }>;

/** GET /deck-api/addon/export/<exportId> from Code.gs, with the same identity token and binding secret as headers. */
export type AddonExportPlanBody = Readonly<{
  presentationId: string;
  /** Slides API batchUpdate requests, in order; Code.gs sends them in chunks of at most 500. */
  requests: readonly unknown[];
}>;

/** POST /deck-api/embed/session: the ticket from the frame's `#ticket=` fragment, single use. */
export type EmbedSessionRequest = Readonly<{ ticket: string }>;
/** Also the answer of POST /deck-api/embed/renew (bearer in, fresh bearer out). */
export type EmbedSessionBody = Readonly<{ bearerToken: string; expiresAt: number; deckId: DeckId; session: DeckSessionBody }>;

/**
 * `window.postMessage` between the editor frame (origin https://sashaslides.com) and the add-on's
 * HtmlService shell (origin `*.googleusercontent.com`). Each side checks `event.origin` and
 * `source` before reading anything else.
 */
export type AddonShellMessage =
  | Readonly<{ source: "sasha-editor"; kind: "ready" }>
  | Readonly<{ source: "sasha-editor"; kind: "exportRequested"; exportId: string }>
  | Readonly<{ source: "sasha-editor"; kind: "closeRequested" }>
  | Readonly<{ source: "sasha-addon-shell"; kind: "exportFinished"; exportId: string; outcome: "applied" | "failed"; message: string }>;

// --- the built web application ----------------------------------------------------------------------

/**
 * `dist/web/manifest.json`, written by the web module's build-web.ts and read by the connector
 * at startup, so the server never guesses a file name or a policy.
 */
export type WebBuildManifest = Readonly<{
  /** File under dist/web/ served at DECK_LIST_PAGE_PATH. */
  listPage: string;
  /** File under dist/web/ served at DECK_PAGE_PATH_PREFIX + <deckId>. */
  deckPage: string;
  /** Files under dist/web/assets/, served at DECK_APPLICATION_ASSETS_PREFIX + name (content-hashed names). */
  assets: readonly string[];
  /** `Content-Security-Policy` for both pages (frame-ancestors 'none'). */
  contentSecurityPolicy: string;
  /** The same policy with `frame-ancestors` set to ADDON_FRAME_ANCESTORS, for `?embed=addon`. */
  embeddedContentSecurityPolicy: string;
  /**
   * The scripted-transition runner page (presenter `buildPresenterAssets` into dist/web/runner/),
   * served at DECK_APPLICATION_ASSETS_PREFIX + "runner/" + this name with `runnerContentSecurityPolicy`.
   * Same site as the editor until a second registrable domain exists (SPEC.md section 11). The
   * page loads files beside it (runner-bootstrap.js), so the connector serves every plain file name
   * under `runner/`, and only this page with the runner's policy.
   */
  runnerPage: string;
  runnerContentSecurityPolicy: string;
  builtAt: string;
}>;
