/**
 * The account portal's one view of the account store: find (or open) the account a verified
 * sign-in belongs to, and describe an account's linked sign-ins for the portal page.
 *
 * It is a port so the portal does not learn how accounts are stored. The production adapter
 * (`storeAccountDirectory`) sits over `oauth-store.ts`'s `accountLinks` (keyed
 * `<provider>:<subject>`) and `accounts` collections, sealing the email with the account's
 * vault key; `inMemoryAccountDirectory` is the reference behaviour, and the tests hold both
 * to the same rules.
 *
 * A Google sign-in records its subject as the account's `googleSubject`, the same link the
 * brokered Slides flow (`accounts.ts`) writes: Google's `sub` is one per Google account, so
 * signing in here and connecting Slides there land in one account, and erasing it reaches
 * the Google grant.
 *
 * Two rules every implementation must keep:
 *
 *  - **The key is provider + subject, never the email.** Two sign-ins that report the same
 *    address are two accounts unless something stronger links them. Merging on email would
 *    let any provider that can assert an address (one that does not verify `email`, a
 *    self-hosted OpenID Connect issuer) take over the account that owns it.
 *  - **`describe` returns hints, not addresses.** The portal page shows `a•••@example.com`;
 *    the full address never leaves the directory, so a page cannot leak it.
 *
 * PASSKEYS are links like any other, under provider `passkey`, and their SUBJECT IS THE
 * CREDENTIAL ID. The other candidate, the WebAuthn user handle, names the user rather than
 * the key: an account with three passkeys has three credential ids, and a link per
 * credential is what lets each be listed, removed or erased on its own. The credential id
 * is also what a sign-in hands back first (`PublicKeyCredential.id`), so finding the
 * account is one keyed read with no index. It is random bytes chosen by the authenticator,
 * so it reveals nothing about the person. The user handle is still stored (a fresh random
 * value per passkey, never the account id) and checked when an authenticator returns it.
 */
import type { AccountId, AccountVault } from "./account-vault";
import type { AccountLink, AuthStore, StoredPasskey } from "./oauth-store";
import type { PasskeyAlgorithm } from "./webauthn";

export type AccountDirectory = Readonly<{
  /** The same `provider` + `subject` always yields the same account; a new pair opens one. */
  findOrCreateByIdentity(
    options: Readonly<{ provider: string; subject: string; email: string | null }>,
  ): Promise<AccountId>;
  /** Null when the account no longer exists (erased since the session was issued). */
  describe(options: Readonly<{ accountId: AccountId }>): Promise<AccountDescription | null>;
  /** Opens a new account whose only sign-in is this passkey. */
  createAccountWithPasskey(options: Readonly<{ passkey: NewPasskey }>): Promise<PasskeyLinkOutcome>;
  /** Adds a passkey to an account that already exists. */
  addPasskey(options: Readonly<{ accountId: AccountId; passkey: NewPasskey }>): Promise<PasskeyLinkOutcome>;
  /** Null when no account holds this credential, or its key was reset so it cannot be opened. */
  findPasskey(options: Readonly<{ credentialId: string }>): Promise<PasskeyCredential | null>;
  /** Records the counter of a sign-in that just verified. */
  recordPasskeyUse(options: Readonly<{ credentialId: string; signCount: number }>): Promise<void>;
  /** The account's passkey credential ids, so registering one the authenticator already holds is refused there. */
  passkeyIds(options: Readonly<{ accountId: AccountId }>): Promise<readonly string[]>;
}>;

/** The provider name every passkey link carries; reserved, so no configured provider can take it. */
export const PASSKEY_PROVIDER = "passkey";

export type PasskeyCredential = Readonly<{
  /** base64url; the link's subject. */
  credentialId: string;
  accountId: AccountId;
  /** SPKI DER, base64url, opened. */
  publicKey: string;
  algorithm: PasskeyAlgorithm;
  signCount: number;
  /** base64url. */
  userHandle: string;
  createdAtMs: number;
}>;

export type NewPasskey = Omit<PasskeyCredential, "accountId">;

export type PasskeyLinkOutcome =
  | Readonly<{ kind: "linked"; accountId: AccountId }>
  /** The credential id already belongs to an account (this one or another). */
  | Readonly<{ kind: "already-registered" }>
  /** `addPasskey` only: the account was erased since the session was issued. */
  | Readonly<{ kind: "account-missing" }>;

export type AccountDescription = Readonly<{ links: readonly LinkedSignIn[] }>;

export type LinkedSignIn = Readonly<{
  /** The configured provider name, e.g. `google`, `github`, `okta`. */
  provider: string;
  /** `emailHint(email)`, or null when the provider gave no address. */
  emailHint: string | null;
}>;

/** `ada@example.com` → `a•••@example.com`. Enough to recognise, not enough to reuse. */
export function emailHint(email: string): string {
  const at = email.lastIndexOf("@");
  const local = at < 0 ? email : email.slice(0, at);
  const first = Array.from(local)[0] ?? "";
  return at < 0 ? `${first}•••` : `${first}•••${email.slice(at)}`;
}

/** Tests and a single-process deployment without a store: lost on restart. */
export function inMemoryAccountDirectory(options: Readonly<{ randomToken: () => string }>): AccountDirectory {
  const accountByLink = new Map<string, AccountId>();
  const linksByAccount = new Map<AccountId, LinkedSignIn[]>();
  const passkeys = new Map<string, PasskeyCredential>();

  const linkPasskey = (accountId: AccountId, passkey: NewPasskey): PasskeyLinkOutcome => {
    const linkKey = `${PASSKEY_PROVIDER}:${passkey.credentialId}`;
    if (accountByLink.has(linkKey)) return { kind: "already-registered" };
    accountByLink.set(linkKey, accountId);
    linksByAccount.set(accountId, [...(linksByAccount.get(accountId) ?? []), { provider: PASSKEY_PROVIDER, emailHint: null }]);
    passkeys.set(passkey.credentialId, { ...passkey, accountId });
    return { kind: "linked", accountId };
  };

  return {
    findOrCreateByIdentity: ({ provider, subject, email }) => {
      const linkKey = `${provider}:${subject}`;
      const existing = accountByLink.get(linkKey);
      if (existing !== undefined) return Promise.resolve(existing);
      const accountId = options.randomToken();
      accountByLink.set(linkKey, accountId);
      linksByAccount.set(accountId, [{ provider, emailHint: email === null ? null : emailHint(email) }]);
      return Promise.resolve(accountId);
    },
    describe: ({ accountId }) => {
      const links = linksByAccount.get(accountId);
      return Promise.resolve(links === undefined ? null : { links: [...links] });
    },
    createAccountWithPasskey: ({ passkey }) => {
      if (passkeys.has(passkey.credentialId)) return Promise.resolve({ kind: "already-registered" });
      return Promise.resolve(linkPasskey(options.randomToken(), passkey));
    },
    addPasskey: ({ accountId, passkey }) => {
      if (!linksByAccount.has(accountId)) return Promise.resolve({ kind: "account-missing" });
      return Promise.resolve(linkPasskey(accountId, passkey));
    },
    findPasskey: ({ credentialId }) => Promise.resolve(passkeys.get(credentialId) ?? null),
    recordPasskeyUse: ({ credentialId, signCount }) => {
      const existing = passkeys.get(credentialId);
      if (existing !== undefined) passkeys.set(credentialId, { ...existing, signCount });
      return Promise.resolve();
    },
    passkeyIds: ({ accountId }) =>
      Promise.resolve([...passkeys.values()].filter((passkey) => passkey.accountId === accountId).map((passkey) => passkey.credentialId)),
  };
}

/**
 * Production: accounts in the auth store. Writes the account record before the link, as
 * `accounts.ts` does, so a crash between the two leaves an unlinked account (re-created on
 * the next sign-in), never a link pointing at nothing.
 */
export function storeAccountDirectory(
  options: Readonly<{
    store: Pick<AuthStore, "accounts" | "accountLinks">;
    vault: AccountVault;
    now: () => Date;
    newAccountId: () => AccountId;
  }>,
): AccountDirectory {
  const { store, vault, now, newAccountId } = options;

  const sealPasskey = async (accountId: AccountId, passkey: NewPasskey): Promise<StoredPasskey> => ({
    sealedPublicKey: await vault.seal({ accountId, plaintext: passkey.publicKey }),
    algorithm: passkey.algorithm,
    signCount: passkey.signCount,
    userHandle: passkey.userHandle,
    createdAtMs: passkey.createdAtMs,
  });

  return {
    findOrCreateByIdentity: async ({ provider, subject, email }) => {
      const linkKey = `${provider}:${subject}`;
      const existing = await store.accountLinks.get({ key: linkKey });
      if (existing !== null) return existing.accountId;
      const accountId = newAccountId();
      const createdAtMs = now().getTime();
      await store.accounts.put({
        key: accountId,
        value: { accountId, createdAtMs, linkKeys: [linkKey], googleSubject: provider === GOOGLE_PROVIDER ? subject : null },
      });
      await store.accountLinks.put({
        key: linkKey,
        value: {
          accountId,
          provider,
          subject,
          sealedEmail: email === null ? null : await vault.seal({ accountId, plaintext: email }),
          linkedAtMs: createdAtMs,
        },
      });
      return accountId;
    },
    createAccountWithPasskey: async ({ passkey }) => {
      const linkKey = passkeyLinkKey(passkey.credentialId);
      if ((await store.accountLinks.get({ key: linkKey })) !== null) return { kind: "already-registered" };
      const accountId = newAccountId();
      const createdAtMs = now().getTime();
      // The account first, as above: a crash leaves an unlinked account, never a dangling link.
      await store.accounts.put({ key: accountId, value: { accountId, createdAtMs, linkKeys: [linkKey], googleSubject: null } });
      await store.accountLinks.put({ key: linkKey, value: passkeyLink({ accountId, passkey, stored: await sealPasskey(accountId, passkey), linkedAtMs: createdAtMs }) });
      return { kind: "linked", accountId };
    },
    addPasskey: async ({ accountId, passkey }) => {
      const account = await store.accounts.get({ key: accountId });
      if (account === null) return { kind: "account-missing" };
      const linkKey = passkeyLinkKey(passkey.credentialId);
      if ((await store.accountLinks.get({ key: linkKey })) !== null) return { kind: "already-registered" };
      // The account's link list first: a crash between the two writes leaves a key naming no
      // link (skipped by `describe`, ignored by the eraser), never a link the eraser cannot find.
      await store.accounts.put({ key: accountId, value: { ...account, linkKeys: [...account.linkKeys, linkKey] } });
      await store.accountLinks.put({
        key: linkKey,
        value: passkeyLink({ accountId, passkey, stored: await sealPasskey(accountId, passkey), linkedAtMs: now().getTime() }),
      });
      return { kind: "linked", accountId };
    },
    findPasskey: async ({ credentialId }) => {
      const link = await store.accountLinks.get({ key: passkeyLinkKey(credentialId) });
      if (link?.passkey === undefined) return null;
      const { accountId, passkey } = link;
      // A reset key opens to null: the passkey cannot sign in to anything any more.
      const publicKey = await vault.open({ accountId, sealed: passkey.sealedPublicKey });
      if (publicKey === null) return null;
      return {
        credentialId,
        accountId,
        publicKey,
        algorithm: passkey.algorithm,
        signCount: passkey.signCount,
        userHandle: passkey.userHandle,
        createdAtMs: passkey.createdAtMs,
      };
    },
    recordPasskeyUse: async ({ credentialId, signCount }) => {
      const key = passkeyLinkKey(credentialId);
      const link = await store.accountLinks.get({ key });
      if (link?.passkey === undefined) return;
      await store.accountLinks.put({ key, value: { ...link, passkey: { ...link.passkey, signCount } } });
    },
    passkeyIds: async ({ accountId }) => {
      const account = await store.accounts.get({ key: accountId });
      if (account === null) return [];
      const prefix = `${PASSKEY_PROVIDER}:`;
      return account.linkKeys.filter((linkKey) => linkKey.startsWith(prefix)).map((linkKey) => linkKey.slice(prefix.length));
    },
    describe: async ({ accountId }) => {
      const account = await store.accounts.get({ key: accountId });
      if (account === null) return null;
      const links: LinkedSignIn[] = [];
      for (const linkKey of account.linkKeys) {
        const link = await store.accountLinks.get({ key: linkKey });
        if (link === null) continue;
        // A destroyed key opens to null: the hint is simply gone, which is the point of it.
        const email = link.sealedEmail === null ? null : await vault.open({ accountId, sealed: link.sealedEmail });
        links.push({ provider: link.provider, emailHint: email === null ? null : emailHint(email) });
      }
      return { links };
    },
  };
}

/** The provider name whose subject is also the account's Google Slides connection. */
const GOOGLE_PROVIDER = "google";

function passkeyLinkKey(credentialId: string): string {
  return `${PASSKEY_PROVIDER}:${credentialId}`;
}

function passkeyLink(
  options: Readonly<{ accountId: AccountId; passkey: NewPasskey; stored: StoredPasskey; linkedAtMs: number }>,
): AccountLink {
  return {
    accountId: options.accountId,
    provider: PASSKEY_PROVIDER,
    subject: options.passkey.credentialId,
    sealedEmail: null,
    linkedAtMs: options.linkedAtMs,
    passkey: options.stored,
  };
}
