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
 *    let any provider that can assert an address (Microsoft's unverified `email` claim, a
 *    self-hosted OpenID Connect issuer) take over the account that owns it.
 *  - **`describe` returns hints, not addresses.** The portal page shows `a•••@example.com`;
 *    the full address never leaves the directory, so a page cannot leak it.
 */
import type { AccountId, AccountVault } from "./account-vault";
import type { AuthStore } from "./oauth-store";

export type AccountDirectory = Readonly<{
  /** The same `provider` + `subject` always yields the same account; a new pair opens one. */
  findOrCreateByIdentity(
    options: Readonly<{ provider: string; subject: string; email: string | null }>,
  ): Promise<AccountId>;
  /** Null when the account no longer exists (erased since the session was issued). */
  describe(options: Readonly<{ accountId: AccountId }>): Promise<AccountDescription | null>;
}>;

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
