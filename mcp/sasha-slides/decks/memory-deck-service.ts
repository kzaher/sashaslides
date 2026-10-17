/**
 * A REAL `DeckService` over real rooms, entirely in memory: the Google Slides module and Claude's
 * deck tools test against it instead of a fake (SPEC.md 21.17 "ships memory-deck-service.ts
 * first"). Everything is the production code -- the registry, the rooms with their guard and
 * discussion authority, the access rules, the router and the sockets -- over an in-memory auth
 * store, a vault with a random master key, and `memoryDeckStorage`.
 *
 *   await using decks = createMemoryDeckService({ now: () => clock, timers: manualTimers });
 *   const alice = await decks.signIn({ email: "alice@example.com" });
 *   const opened = await decks.deckService.createDeck({ caller: alice, title: "Pricing" });
 *
 * `signIn` opens (or finds) an account for an address, as a sign-in would, and returns its caller.
 */
import { randomBytes } from "node:crypto";
import type { CreateGoogleSlidesInterchange, DeckCaller, DeckService } from "../deck-contracts/deck-service-contract";
import { storeAccountDirectory, type AccountDirectory } from "../http/account-directory";
import { createAccountVault, inMemoryDataKeyStore } from "../http/account-keys";
import type { AccountVault } from "../http/account-vault";
import { randomAccountId, withSealedGoogleIdentities } from "../http/accounts";
import { randomUrlSafeToken } from "../http/authorization-server";
import { inMemoryAuthStore, type AuthStore } from "../http/oauth-store";
import { createDeckServer, type DeckServer } from "./deck-stack";
import type { DeckTimers } from "./deck-registry";
import { memoryDeckStorage } from "./deck-storage";

export type MemoryDeckService = AsyncDisposable &
  Readonly<{
    deckService: DeckService;
    /** The whole deck server, for tests that also want the router or the sockets. */
    server: DeckServer;
    store: AuthStore;
    vault: AccountVault;
    directory: AccountDirectory;
    /** The account for this address (opened on first use) as a deck caller. */
    signIn(options: Readonly<{ email: string }>): Promise<DeckCaller>;
  }>;

export function createMemoryDeckService(
  options: Readonly<{
    now: () => number;
    timers: DeckTimers;
    /** Defaults to an origin no browser can reach. */
    publicUrl?: string;
    /** Defaults to the architect's stub, which answers nothing. */
    createGoogleSlidesInterchange?: CreateGoogleSlidesInterchange;
    /** Where a test looks for a web build; defaults to a directory that has none (pages answer 503). */
    webDistributionDirectory?: string;
  }>,
): MemoryDeckService {
  const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: randomBytes(32) });
  const { store } = withSealedGoogleIdentities({ store: inMemoryAuthStore(), vault });
  const directory = storeAccountDirectory({ store, vault, now: () => new Date(options.now()), newAccountId: randomAccountId });
  const server = createDeckServer({
    publicUrl: options.publicUrl ?? "https://decks.invalid",
    storage: memoryDeckStorage(),
    store,
    vault,
    directory,
    sessionSecret: randomBytes(32).toString("hex"),
    webDistributionDirectory: options.webDistributionDirectory ?? "/nonexistent/sasha-web-build",
    googleClient: { clientId: "memory-deck-service.apps.googleusercontent.com", clientSecret: "unused" },
    createGoogleSlidesInterchange: options.createGoogleSlidesInterchange ?? (() => ({ handleRequest: () => Promise.resolve(false) })),
    timers: options.timers,
    now: options.now,
    random: Math.random,
    randomBytes: (size) => randomBytes(size),
    randomToken: randomUrlSafeToken,
    fetch: () => Promise.reject(new Error("the memory deck service makes no network requests")),
    warn: () => undefined,
  });
  return {
    deckService: server.deckService,
    server,
    store,
    vault,
    directory,
    signIn: async ({ email }) => {
      const accountId = await directory.findOrCreateByIdentity({ provider: "test", subject: email.toLowerCase(), email });
      await server.manager.acceptInvitations({ accountId });
      return server.people.callerFor({ accountId });
    },
    [Symbol.asyncDispose]: () => server.shutdown(),
  };
}
