/**
 * The deck server's view of accounts, over the connector's existing auth store and vault: whether
 * an account still exists (every request re-reads it, so erasing an account signs it out
 * everywhere at once, SPEC.md 21.3), its sign-in addresses, finding an account by address (an
 * invitation to someone who already has an account becomes a membership at once), the display
 * names collaborators see, the Google grants the Google Slides module uses, and how an MCP call
 * becomes a deck caller.
 *
 * Key decisions:
 *
 *  - ADDRESSES ARE SEALED PER ACCOUNT, so finding one is a scan that opens each link's address.
 *    Invitations are rare (100 per account per day), and an index of addresses in the clear is
 *    exactly what the store was built not to have.
 *  - DISPLAY NAMES ARE CACHED in memory per account and dropped when the profile changes or the
 *    account is erased; a name is the profile's, else the address before "@" (deck-identity.ts).
 *  - A GOOGLE GRANT IS THE ACCOUNT'S `googleSubject` (the same link the brokered MCP sign-in
 *    writes), so connecting Google Slides on the deck site and signing in to the connector with
 *    Google land on one grant. Saving one refuses a subject another account already holds.
 */
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  DeckCaller,
  DeckCallerResolution,
  GoogleGrantResolution,
  GoogleGrantStore,
  GoogleIdentityAccounts,
} from "../deck-contracts/deck-service-contract";
import { SLIDES_SCOPE } from "../google-constants";
import type { AccountDirectory } from "../http/account-directory";
import type { AccountId, AccountVault } from "../http/account-vault";
import { accountLinkKey } from "../http/accounts";
import { googleSubjectOf, hashToken } from "../http/authorization-server";
import type { AuthStore, GoogleIdentity } from "../http/oauth-store";
import { agentSessionIdFor } from "../deck-tools/agent-session";
import { deckCallerFor, displayNameFor, normaliseEmail } from "./deck-identity";
import type { DeckStorage } from "./deck-storage";

export type DeckAccounts = Readonly<{
  /** False once the account is erased. */
  exists(options: Readonly<{ accountId: AccountId }>): Promise<boolean>;
  /** The account's sign-in addresses, opened; empty when it has none or its key was reset. */
  emailsOf(options: Readonly<{ accountId: AccountId }>): Promise<readonly string[]>;
  /** The account one of whose sign-ins has this address, or null. */
  findByEmail(options: Readonly<{ email: string }>): Promise<AccountId | null>;
}>;

export function storeDeckAccounts(options: Readonly<{ store: Pick<AuthStore, "accounts" | "accountLinks">; vault: AccountVault }>): DeckAccounts {
  const { store, vault } = options;
  return {
    exists: async ({ accountId }) => (await store.accounts.get({ key: accountId })) !== null,
    emailsOf: async ({ accountId }) => {
      const account = await store.accounts.get({ key: accountId });
      if (account === null) return [];
      const emails: string[] = [];
      for (const linkKey of account.linkKeys) {
        const link = await store.accountLinks.get({ key: linkKey });
        if (link === null || link.sealedEmail === null) continue;
        const email = await vault.open({ accountId, sealed: link.sealedEmail });
        if (email !== null && !emails.includes(email)) emails.push(email);
      }
      return emails;
    },
    findByEmail: async ({ email }) => {
      const wanted = normaliseEmail(email);
      for (const key of await store.accountLinks.keys()) {
        const link = await store.accountLinks.get({ key });
        if (link === null || link.sealedEmail === null) continue;
        if ((await store.accounts.get({ key: link.accountId })) === null) continue;
        const opened = await vault.open({ accountId: link.accountId, sealed: link.sealedEmail });
        if (opened !== null && normaliseEmail(opened) === wanted) return link.accountId;
      }
      return null;
    },
  };
}

/** Names and callers, with the per-account cache described in the header. */
export type DeckPeople = Readonly<{
  callerFor(options: Readonly<{ accountId: AccountId }>): Promise<DeckCaller>;
  displayNameOf(options: Readonly<{ accountId: AccountId }>): Promise<string>;
  /** The first sign-in address, for the session body and the owner's people list. */
  emailOf(options: Readonly<{ accountId: AccountId }>): Promise<string | null>;
  setDisplayName(options: Readonly<{ accountId: AccountId; displayName: string }>): Promise<void>;
  forget(options: Readonly<{ accountId: AccountId }>): void;
}>;

export function createDeckPeople(options: Readonly<{ accounts: DeckAccounts; storage: DeckStorage }>): DeckPeople {
  const { accounts, storage } = options;
  const names = new Map<AccountId, string>();
  const emailOf = async ({ accountId }: Readonly<{ accountId: AccountId }>): Promise<string | null> => (await accounts.emailsOf({ accountId }))[0] ?? null;
  const displayNameOf = async ({ accountId }: Readonly<{ accountId: AccountId }>): Promise<string> => {
    const cached = names.get(accountId);
    if (cached !== undefined) return cached;
    const name = displayNameFor({ profileName: await storage.readProfile({ accountId }), email: await emailOf({ accountId }) });
    names.set(accountId, name);
    return name;
  };
  return {
    callerFor: async ({ accountId }) => deckCallerFor({ accountId, displayName: await displayNameOf({ accountId }) }),
    displayNameOf,
    emailOf,
    setDisplayName: async ({ accountId, displayName }) => {
      await storage.writeProfile({ accountId, displayName });
      names.set(accountId, displayName);
    },
    forget: ({ accountId }) => void names.delete(accountId),
  };
}

/**
 * The add-on's first visit: the account behind a verified Google identity, opened when there is
 * none, through the same directory the portal signs in with (provider "google").
 */
export function directoryGoogleIdentityAccounts(
  options: Readonly<{
    directory: AccountDirectory;
    people: DeckPeople;
    /** Pending invitations to the account's addresses become memberships (deck-manager.ts). */
    acceptInvitations: (options: Readonly<{ accountId: AccountId }>) => Promise<void>;
  }>,
): GoogleIdentityAccounts {
  return {
    accountForGoogleIdentity: async ({ subject, email, emailVerified }) => {
      const accountId = await options.directory.findOrCreateByIdentity({ provider: "google", subject, email: emailVerified ? email : null });
      await options.acceptInvitations({ accountId });
      return options.people.callerFor({ accountId });
    },
  };
}

export function storeGoogleGrants(options: Readonly<{ store: Pick<AuthStore, "accounts" | "accountLinks" | "googleIdentities">; now: () => number }>): GoogleGrantStore {
  const { store } = options;
  return {
    forAccount: async ({ accountId }): Promise<GoogleGrantResolution> => {
      const account = await store.accounts.get({ key: accountId });
      const subject = account?.googleSubject ?? null;
      if (subject === null) return { kind: "notConnected", googleSubject: null };
      const identity = await store.googleIdentities.get({ key: subject });
      if (identity === null || !identity.grantedScopes.includes(SLIDES_SCOPE)) return { kind: "notConnected", googleSubject: subject };
      return { kind: "ok", identity };
    },
    save: async ({ accountId, identity }) => {
      const linkKey = accountLinkKey({ provider: "google", subject: identity.subject });
      const link = await store.accountLinks.get({ key: linkKey });
      if (link !== null && link.accountId !== accountId) return "subjectBelongsToAnotherAccount";
      const account = await store.accounts.get({ key: accountId });
      if (account === null) return "subjectBelongsToAnotherAccount";
      if (account.googleSubject !== null && account.googleSubject !== identity.subject) {
        const other = await store.accountLinks.get({ key: accountLinkKey({ provider: "google", subject: account.googleSubject }) });
        if (other !== null && other.accountId !== accountId) return "subjectBelongsToAnotherAccount";
      }
      // The link and the account's subject first: the sealed identity store seals under the
      // account it finds through this link (accounts.ts `sealedGoogleIdentities`).
      if (link === null) {
        await store.accounts.put({ key: accountId, value: { ...account, linkKeys: [...account.linkKeys, linkKey], googleSubject: identity.subject } });
        await store.accountLinks.put({
          key: linkKey,
          value: { accountId, provider: "google", subject: identity.subject, sealedEmail: null, linkedAtMs: options.now() },
        });
      } else if (account.googleSubject !== identity.subject) {
        await store.accounts.put({ key: accountId, value: { ...account, googleSubject: identity.subject } });
      }
      const previous = await store.googleIdentities.get({ key: identity.subject });
      await store.googleIdentities.put({ key: identity.subject, value: mergeIdentity({ previous, next: identity }) });
      return "saved";
    },
  };
}

/** How an MCP tool call becomes a deck caller (SPEC.md 21.14): the bearer's Google subject, then its account. */
export function toolCallDeckCallers(
  options: Readonly<{ store: Pick<AuthStore, "accountLinks" | "accounts">; people: DeckPeople }>,
): (options: Readonly<{ authInfo: AuthInfo | undefined; sessionId: string | undefined }>) => Promise<DeckCallerResolution> {
  return async ({ authInfo, sessionId }) => {
    const subject = googleSubjectOf({ authInfo });
    if (subject === null) return { kind: "unavailable", message: "Sign in to the connector with Google to use Sasha decks." };
    const link = await options.store.accountLinks.get({ key: accountLinkKey({ provider: "google", subject }) });
    if (link === null || (await options.store.accounts.get({ key: link.accountId })) === null) {
      return { kind: "unavailable", message: "This Google account has no Sasha account yet; sign in at sashaslides.com/account first." };
    }
    // Stateless HTTP has no MCP session id; the bearer token then names the session (it lives one sign-in).
    const sessionKey = sessionId ?? (authInfo === undefined ? subject : hashToken(authInfo.token));
    return { kind: "ok", caller: await options.people.callerFor({ accountId: link.accountId }), agentSessionId: agentSessionIdFor(sessionKey) };
  };
}

/** Keeps the refresh token Google sent only the first time, and every scope ever granted. */
function mergeIdentity(options: Readonly<{ previous: GoogleIdentity | null; next: GoogleIdentity }>): GoogleIdentity {
  const { previous, next } = options;
  if (previous === null) return next;
  return {
    ...next,
    email: next.email ?? previous.email,
    refreshToken: next.refreshToken ?? previous.refreshToken,
    grantedScopes: [...new Set([...previous.grantedScopes, ...next.grantedScopes])],
  };
}
