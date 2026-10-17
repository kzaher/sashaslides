/**
 * THE CONNECTOR-SIDE SEAMS OF MILESTONE 2, owned by the architect (builders ask for changes).
 *
 * Three modules build inside the connector process at once:
 *
 *   collaboration server   decks/**, the HTTP router, server.ts: sessions, access, rooms, storage
 *   Google Slides          google-slides/**, the add-on: import, export, the add-on handoff
 *   assistant deck tools   deck-tools/**: Claude's MCP tools over decks
 *
 * The last two never edit the first one's files. They receive a `DeckService` (implemented by the
 * collaboration server over its live rooms) and are mounted by it through the two factories typed
 * at the bottom (`CreateGoogleSlidesInterchange`, `RegisterDeckTools`), which `server.ts` and
 * `decks/deck-stack.ts` compose.
 *
 * WHY A SERVICE AND NOT THE STORE: every write -- an agent's edit, an import -- must go through the
 * deck's ROOM, the one authoritative replica that broadcasts to connected editors and persists, or
 * collaborators would not see it live and a reload would lose it. A `DeckHandle` is a lease on that
 * room; holding it keeps the room loaded, and disposing it lets the room unload once idle.
 *
 * Engine types come from the DOM-free contract files only (never contracts/index.ts, which pulls in
 * browser types the connector's tsconfig does not have).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AgentRevertOutcome } from "../engine/src/contracts/collaboration.ts";
import type { CommandEnvelope, CommandOutcome } from "../engine/src/contracts/commands.ts";
import type { DeckRole } from "../engine/src/contracts/deck-access.ts";
import type { DeckSummary, GoogleSlidesLink } from "../engine/src/contracts/deck-api.ts";
import type { DiscussionOutcome, DiscussionRequest, DiscussionSnapshot, Person } from "../engine/src/contracts/discussion.ts";
import type { AssetMediaType, DocumentSnapshot } from "../engine/src/contracts/document.ts";
import type { AssetId, DeckId } from "../engine/src/contracts/ids.ts";
import type { GoogleClientCredentials } from "../google-auth";
import type { AccountId } from "../http/account-vault";
import type { GoogleIdentity } from "../http/oauth-store";

/** Who is asking: a signed-in account, with the two persons it can act as. */
export type DeckCaller = Readonly<{
  accountId: AccountId;
  /** The account as collaborators see it (`pr_...`, deck-access.ts). */
  person: Person;
  /** Claude acting for this account (`ag_...`, kind "agent"). */
  agent: Person;
}>;

export interface DeckService {
  /** Decks the account owns or is a member of, most recently updated first. */
  listDecks(options: Readonly<{ caller: DeckCaller }>): Promise<readonly DeckSummary[]>;
  /** A new deck owned by the caller, seeded blank (model `blankDeck`), opened. */
  createDeck(options: Readonly<{ caller: DeckCaller; title: string }>): Promise<DeckOpenOutcome>;
  openDeck(options: Readonly<{ caller: DeckCaller; deckId: DeckId }>): Promise<DeckOpenOutcome>;
  /** The deck bound to an add-on presentation's binding secret (its SHA-256, hexadecimal), if any. */
  findDeckByAddonBinding(options: Readonly<{ bindingSecretHash: string }>): Promise<DeckId | null>;
}

export type DeckOpenOutcome =
  | Readonly<{ kind: "opened"; deck: DeckHandle }>
  | Readonly<{ kind: "notFound" }>
  | Readonly<{ kind: "notPermitted" }>
  /** `COLLABORATION_LIMITS.maximumDecksPerAccount` reached (create only). */
  | Readonly<{ kind: "limitReached"; message: string }>
  /**
   * The deck's saved snapshot does not open or decode: it is refused rather than opened partially
   * (decks/deck-storage.ts), and `message` is a sentence for the person. Routes answer 503
   * `deckUnreadable`; sockets close `deckUnreadable` (4014).
   */
  | Readonly<{ kind: "deckUnreadable"; message: string }>;

/** A lease on a deck's live room. `await using deck = ...`: disposing releases the lease. */
export interface DeckHandle extends AsyncDisposable {
  readonly deckId: DeckId;
  /**
   * The caller's role, checked again on every call (an owner may change it meanwhile); null once
   * the caller is no longer a member at all (removed while holding this handle), which allows nothing.
   */
  role(): DeckRole | null;
  summary(): DeckSummary;
  snapshot(): DocumentSnapshot;
  /**
   * Applies one envelope on the room's replica (`repairAfterTransaction`), broadcasts it to every
   * connected editor and persists it. Needs `editDocument`. An envelope whose author is an agent is
   * recorded under its `agentSessionId` for `revertAgentSession`, and editors receive an `agentEdit`
   * message carrying `summaryForCollaborators` (one sentence, e.g. "added 3 slides about pricing").
   */
  apply(options: Readonly<{ envelope: CommandEnvelope; summaryForCollaborators: string }>): Promise<DeckApplyOutcome>;
  /** Undoes that agent session's steps, newest first, with the collaborator rules of document-store.ts. Needs `revertAgentEdits`. */
  revertAgentSession(options: Readonly<{ agentSessionId: string }>): Promise<AgentRevertOutcome>;
  discussion(): DiscussionSnapshot;
  /** As the caller's person or as its agent; the server stamps actor and time and checks the role. */
  submitDiscussion(options: Readonly<{ as: "person" | "agent"; request: DiscussionRequest }>): Promise<DiscussionOutcome>;
  /**
   * Resolves with the discussion as soon as its sequence passes `afterSequence`, or with the current
   * one when `timeoutMilliseconds` passes or `signal` aborts first. Never rejects.
   */
  waitForDiscussion(options: Readonly<{ afterSequence: number; timeoutMilliseconds: number; signal: AbortSignal }>): Promise<DiscussionSnapshot>;
  /** Stores bytes (sealed, content-addressed); does NOT register the asset in the document. Needs `editDocument`. */
  putAsset(options: Readonly<{ bytes: Uint8Array; mediaType: AssetMediaType }>): Promise<AssetPutOutcome>;
  readAsset(options: Readonly<{ assetId: AssetId }>): Promise<Readonly<{ bytes: Uint8Array; mediaType: AssetMediaType }> | null>;
  googleSlidesLink(): GoogleSlidesLink | null;
  /** Needs `exchangeWithGoogleSlides`. */
  setGoogleSlidesLink(options: Readonly<{ link: GoogleSlidesLink | null }>): Promise<void>;
  /** Binds an add-on presentation to this deck (its binding secret's hash). Needs `exchangeWithGoogleSlides`. */
  bindAddon(options: Readonly<{ bindingSecretHash: string; presentationId: string }>): Promise<void>;
}

export type DeckApplyOutcome =
  | Readonly<{ kind: "applied"; outcome: Extract<CommandOutcome, { kind: "applied" }> }>
  | Readonly<{ kind: "rejected"; outcome: Extract<CommandOutcome, { kind: "rejected" }> }>
  | Readonly<{ kind: "notPermitted" }>
  /** The deck would pass `COLLABORATION_LIMITS.maximumDocumentBytes`; nothing was written. */
  | Readonly<{ kind: "tooLarge"; message: string }>;

export type AssetPutOutcome =
  | Readonly<{ kind: "stored"; assetId: AssetId; byteLength: number }>
  | Readonly<{ kind: "tooLarge"; message: string }>
  | Readonly<{ kind: "notPermitted" }>;

/** Single-use tickets the editor frame exchanges for a bearer token (deck-api.ts). */
export type EmbedTicketIssuer = Readonly<{
  issue(options: Readonly<{ accountId: AccountId; deckId: DeckId }>): Promise<string>;
}>;

/** Find the account a verified Google identity belongs to, or open one (the add-on's first visit). */
export type GoogleIdentityAccounts = Readonly<{
  accountForGoogleIdentity(options: Readonly<{ subject: string; email: string; emailVerified: boolean }>): Promise<DeckCaller>;
}>;

/**
 * The collaboration server's router hands these requests to the Google Slides module, after its
 * own checks: for paths it authenticates (`/deck-api/google-slides/*`,
 * `/deck-api/decks/<id>/google-slides/*`) `caller` is the signed-in caller and the origin and CSRF
 * checks have passed; for the add-on's server-to-server paths (`/deck-api/addon/*`) and the
 * capability paths (`/deck-api/export-assets/*`) `caller` is null and the handler authenticates.
 * Resolves true when it answered.
 */
export type DeckRouteHandler = (
  options: Readonly<{ request: IncomingMessage; response: ServerResponse; url: URL; caller: DeckCaller | null }>,
) => Promise<boolean>;

/** Path prefixes the router delegates to `GoogleSlidesInterchange.handleRequest`. */
export const GOOGLE_SLIDES_ROUTE_PREFIXES: readonly string[] = ["/deck-api/google-slides/", "/deck-api/addon/", "/deck-api/export-assets/"];

/**
 * The router ALSO offers `/oauth/google/callback` (the one redirect address registered with the
 * Google OAuth client, http/oauth-metadata.ts) to `handleRequest` FIRST, with `caller` null: the
 * Google Slides connect flow reuses it, because registering another address needs the Cloud
 * console, which may be unreachable (CLAUDE.md). The handler answers only a `state` it issued
 * and resolves false for every other, which then reaches the authorization server as before.
 */
export const GOOGLE_CALLBACK_SHARED_PATH = "/oauth/google/callback";
/** And this suffix under `/deck-api/decks/<deckId>`. */
export const GOOGLE_SLIDES_DECK_ROUTE_SEGMENT = "/google-slides/";

export type GoogleSlidesInterchange = Readonly<{ handleRequest: DeckRouteHandler }>;

/** google-slides/google-slides-interchange.ts exports `createGoogleSlidesInterchange` of this type. */
export type CreateGoogleSlidesInterchange = (
  options: Readonly<{
    deckService: DeckService;
    embedTickets: EmbedTicketIssuer;
    accounts: GoogleIdentityAccounts;
    /** Each account's Google grant, in the connector's sealed store (http/oauth-store.ts). */
    googleGrants: GoogleGrantStore;
    /** The connector's own Google OAuth client, for the Slides client and the connect consent. */
    googleClient: GoogleClientCredentials;
    publicUrl: string;
    fetch: typeof fetch;
    now: () => number;
    randomToken: () => string;
    warn: (message: string) => void;
  }>,
) => GoogleSlidesInterchange;

/** Implemented by the collaboration server over the existing AuthStore and account directory. */
export type GoogleGrantStore = Readonly<{
  /** The grant behind the account's `googleSubject`, or why there is none. */
  forAccount(options: Readonly<{ accountId: AccountId }>): Promise<GoogleGrantResolution>;
  /**
   * After the connect flow's consent: stores the identity (sealed, merging with any grant the MCP
   * sign-in stored for the same subject, keeping the refresh token Google sent only the first time)
   * and links the account to that subject when it has none. Refuses a subject already linked to a
   * DIFFERENT account (`subjectBelongsToAnotherAccount`).
   */
  save(options: Readonly<{ accountId: AccountId; identity: GoogleIdentity }>): Promise<"saved" | "subjectBelongsToAnotherAccount">;
}>;

export type GoogleGrantResolution =
  | Readonly<{ kind: "ok"; identity: GoogleIdentity }>
  /** No Google grant, or one without the Slides scope: the module's connect flow asks for it. */
  | Readonly<{ kind: "notConnected"; googleSubject: string | null }>;

/** How a tool call becomes a deck caller (the MCP bearer's Google subject -> account). */
export type DeckCallerResolution =
  | Readonly<{ kind: "ok"; caller: DeckCaller; agentSessionId: string }>
  | Readonly<{ kind: "unavailable"; message: string }>;

/** deck-tools/deck-tools.ts exports `registerDeckTools` of this type; server.ts calls it next to registerCommentTools. */
export type RegisterDeckTools = (
  options: Readonly<{
    server: McpServer;
    /** null on stdio or without --store: the tools are listed and answer why they cannot work. */
    deckService: DeckService | null;
    callerFor: (options: Readonly<{ authInfo: AuthInfo | undefined; sessionId: string | undefined }>) => Promise<DeckCallerResolution>;
    publicUrl: string;
    /** For `addImage` sources (https only, size-limited by the tool). */
    fetch: typeof fetch;
    now: () => number;
  }>,
) => void;
