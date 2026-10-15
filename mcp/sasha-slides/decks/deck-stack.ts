/**
 * Wires the deck server from what the connector already has (SPEC.md 21.1): the auth store and
 * vault, the session secret, and a storage -- the composition root for decks, so `server.ts` stays
 * a CLI and the tests build exactly what production builds.
 *
 * What comes out: the `DeckService` for the Google Slides module and Claude's tools, the HTTP router
 * and the WebSocket upgrade for `http-server.ts`, the session start for `/account/deck-session`,
 * the deck half of "delete my data", the MCP caller resolution, and the SIGTERM shutdown.
 */
import { asapScheduler } from "rxjs";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  CreateGoogleSlidesInterchange,
  DeckCallerResolution,
  DeckService,
  GoogleGrantStore,
  GoogleIdentityAccounts,
} from "../deck-contracts/deck-service-contract";
import type { GoogleClientCredentials } from "../google-auth";
import type { AccountDirectory } from "../http/account-directory";
import type { DeckSessionStart } from "../http/account-portal";
import type { AccountId, AccountVault } from "../http/account-vault";
import type { AuthStore } from "../http/oauth-store";
import {
  createDeckPeople,
  directoryGoogleIdentityAccounts,
  toolCallDeckCallers,
  storeDeckAccounts,
  storeGoogleGrants,
  type DeckAccounts,
  type DeckPeople,
} from "./deck-accounts";
import { invitationEmailHasher } from "./deck-identity";
import { createDeckManager, membersOf, type DeckManager } from "./deck-manager";
import { createDeckRegistry, type DeckTimers } from "./deck-registry";
import { createDeckRouter, validDeckReturnPath, type DeckRouter } from "./deck-router";
import { createDeckService } from "./deck-service";
import { createEmbedSessions, deckSessionCookies, type EmbedSessions } from "./deck-sessions";
import { createDeckSockets, type DeckSockets } from "./deck-socket";
import type { DeckStorage } from "./deck-storage";
import { createWebApplication } from "./web-application";

export type DeckServer = Readonly<{
  manager: DeckManager;
  deckService: DeckService;
  router: DeckRouter;
  sockets: DeckSockets;
  embeds: EmbedSessions;
  people: DeckPeople;
  accounts: DeckAccounts;
  googleIdentityAccounts: GoogleIdentityAccounts;
  googleGrants: GoogleGrantStore;
  deckSessionStart: DeckSessionStart;
  callerFor: (options: Readonly<{ authInfo: AuthInfo | undefined; sessionId: string | undefined }>) => Promise<DeckCallerResolution>;
  /** The deck half of "delete my data" (account-eraser.ts `withDeckErasure`). */
  eraseAccount(options: Readonly<{ accountId: AccountId }>): Promise<void>;
  /** SIGTERM: every socket closed `serverShuttingDown`, every room flushed. */
  shutdown(): Promise<void>;
}>;

export function createDeckServer(
  options: Readonly<{
    publicUrl: string;
    storage: DeckStorage;
    /** The store with sealed Google identities (`withSealedGoogleIdentities`). */
    store: AuthStore;
    vault: AccountVault;
    directory: AccountDirectory;
    sessionSecret: string;
    /** `engine/dist/web` (the manifest and the built files). */
    webDistributionDirectory: string;
    googleClient: GoogleClientCredentials;
    createGoogleSlidesInterchange: CreateGoogleSlidesInterchange;
    timers: DeckTimers;
    now: () => number;
    /** For the model's order-key suffixes (ids.ts `RandomSource`). */
    random: () => number;
    /** For deck ids and invitation ids. */
    randomBytes: (size: number) => Uint8Array;
    randomToken: () => string;
    fetch: typeof fetch;
    warn: (message: string) => void;
  }>,
): DeckServer {
  const { publicUrl, storage, store, vault, timers, now, randomToken, warn } = options;
  const accounts = storeDeckAccounts({ store, vault });
  const people = createDeckPeople({ accounts, storage });
  const registry = createDeckRegistry({
    storage,
    timers,
    now,
    scheduler: asapScheduler,
    random: options.random,
    membersOf: (record) => membersOf({ record, people }),
    warn,
  });
  const manager = createDeckManager({
    registry,
    storage,
    accounts,
    people,
    now,
    random: options.randomBytes,
    invitationEmails: invitationEmailHasher({ secret: options.sessionSecret }),
  });
  const deckService = createDeckService({ manager, timers });
  const embeds = createEmbedSessions({ now, randomToken });
  const cookies = deckSessionCookies({ secret: options.sessionSecret, now, randomToken });
  const googleIdentityAccounts = directoryGoogleIdentityAccounts({ directory: options.directory, people, acceptInvitations: manager.acceptInvitations });
  const googleGrants = storeGoogleGrants({ store, now });
  const interchange = options.createGoogleSlidesInterchange({
    deckService,
    embedTickets: embeds,
    accounts: googleIdentityAccounts,
    googleGrants,
    googleClient: options.googleClient,
    publicUrl,
    fetch: options.fetch,
    now,
    randomToken,
    warn,
  });
  const router = createDeckRouter({
    publicUrl,
    manager,
    people,
    accounts,
    cookies,
    embeds,
    web: createWebApplication({ distributionDirectory: options.webDistributionDirectory, warn }),
    interchange,
    now,
    warn,
  });
  const sockets = createDeckSockets({ publicUrl, manager, accounts, cookies, embeds, timers, now, warn });
  return {
    manager,
    deckService,
    router,
    sockets,
    embeds,
    people,
    accounts,
    googleIdentityAccounts,
    googleGrants,
    deckSessionStart: {
      issueCookie: async ({ accountId }) => {
        await manager.acceptInvitations({ accountId });
        return cookies.issue({ accountId }).setCookie;
      },
      validReturnPath: validDeckReturnPath,
      clearCookie: () => cookies.clear(),
    },
    callerFor: toolCallDeckCallers({ store, people }),
    eraseAccount: async ({ accountId }) => {
      embeds.revokeAccount({ accountId });
      await manager.eraseAccount({ accountId });
    },
    shutdown: async () => {
      await registry.shutdown();
      sockets.close();
    },
  };
}
