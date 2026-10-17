/**
 * Accounts in the auth store, and the Google identities sealed under each account's key.
 *
 * An account is ours: a random id, the sign-in identities linked to it (`accountLinks`,
 * keyed `<provider>:<subject>`), and at most one Google Slides connection (the Google
 * `sub` whose grant `googleIdentities` holds). The first Google sign-in for a subject
 * creates its account and links `google:<sub>`.
 *
 * WHY A WRAPPER, NOT A CODEC: sealing needs the account's key, which is async and keyed by
 * account, while `JsonCodec` is synchronous and sees one record. So `sealedGoogleIdentities`
 * is a `RecordStore<GoogleIdentity>` over the plain one: it seals `accessToken`,
 * `refreshToken` and `email` on `put` and opens them on `get` / `take`. The authorization
 * server and `user-drive.ts` receive it in place of the plain collection and never see a
 * sealed string or a key. The underlying store holds the same `GoogleIdentity` shape with
 * those three fields replaced by sealed text (`account-keys.ts` describes the form).
 *
 * A DESTROYED KEY READS AS "NO IDENTITY": when a sealed field no longer opens, `get` returns
 * null, which every caller already treats as "not signed in" — the user is sent back
 * through Google consent and a fresh grant is sealed under the account's new key.
 *
 * A clear-text identity written before sealing existed is passed through unchanged until
 * the next `put` for that subject seals it.
 */
import { randomBytes } from "node:crypto";
import { accountLinkKey, findOrCreateAccountForIdentity, GOOGLE_PROVIDER } from "./account-directory";
import type { AccountId, AccountVault } from "./account-vault";
import { isSealedValue } from "./account-keys";
import type { AuthStore, GoogleIdentity, RecordStore } from "./oauth-store";

/** Finds, or on first sign-in creates, the account behind a Google subject. */
export type GoogleAccounts = Readonly<{
  find(options: Readonly<{ subject: string }>): Promise<AccountId | null>;
  ensure(options: Readonly<{ subject: string; email: string | null }>): Promise<AccountId>;
}>;

/**
 * The brokered stack's one call: the same store with `googleIdentities` sealed, plus the
 * account directory it uses. Every reader and writer of identities should get `store`.
 */
export function withSealedGoogleIdentities(
  options: Readonly<{
    store: AuthStore;
    vault: AccountVault;
    now?: () => Date;
    newAccountId?: () => AccountId;
  }>,
): Readonly<{ store: AuthStore; accounts: GoogleAccounts }> {
  const { store, vault } = options;
  const accounts = googleAccounts({
    store,
    vault,
    now: options.now ?? (() => new Date()),
    newAccountId: options.newAccountId ?? randomAccountId,
  });
  return {
    store: { ...store, googleIdentities: sealedGoogleIdentities({ store: store.googleIdentities, vault, accountOf: accounts }) },
    accounts,
  };
}

export function googleAccounts(
  options: Readonly<{
    store: Pick<AuthStore, "accounts" | "accountLinks">;
    vault: AccountVault;
    now: () => Date;
    newAccountId: () => AccountId;
  }>,
): GoogleAccounts {
  const { store } = options;
  return {
    find: async ({ subject }) => {
      const link = await store.accountLinks.get({ key: accountLinkKey({ provider: GOOGLE_PROVIDER, subject }) });
      return link === null ? null : link.accountId;
    },
    ensure: ({ subject, email }) => findOrCreateAccountForIdentity({ ...options, provider: GOOGLE_PROVIDER, subject, email }),
  };
}

export function sealedGoogleIdentities(
  options: Readonly<{
    store: RecordStore<GoogleIdentity>;
    vault: AccountVault;
    accountOf: GoogleAccounts;
  }>,
): RecordStore<GoogleIdentity> {
  const { store, vault, accountOf } = options;

  const sealField = (accountId: AccountId, value: string | null): Promise<string | null> =>
    value === null ? Promise.resolve(null) : vault.seal({ accountId, plaintext: value });

  const opened = async (key: string, stored: GoogleIdentity | null): Promise<GoogleIdentity | null> => {
    if (stored === null) return null;
    const fields = [stored.email, stored.accessToken, stored.refreshToken];
    if (!fields.some((field) => field !== null && isSealedValue(field))) return stored;
    const accountId = await accountOf.find({ subject: key });
    if (accountId === null) return null;
    // Null is "this field's key is gone"; a field that was null to begin with is `{ value: null }`.
    const openField = async (value: string | null): Promise<Readonly<{ value: string | null }> | null> => {
      if (value === null || !isSealedValue(value)) return { value };
      const plaintext = await vault.open({ accountId, sealed: value });
      return plaintext === null ? null : { value: plaintext };
    };
    const email = await openField(stored.email);
    const accessToken = await openField(stored.accessToken);
    const refreshToken = await openField(stored.refreshToken);
    if (email === null || accessToken === null || refreshToken === null) return null;
    return { ...stored, email: email.value, accessToken: accessToken.value, refreshToken: refreshToken.value };
  };

  return {
    put: async ({ key, value }) => {
      const accountId = await accountOf.ensure({ subject: key, email: value.email });
      await store.put({
        key,
        value: {
          ...value,
          email: await sealField(accountId, value.email),
          accessToken: await sealField(accountId, value.accessToken),
          refreshToken: await sealField(accountId, value.refreshToken),
        },
      });
    },
    get: async ({ key }) => opened(key, await store.get({ key })),
    take: async ({ key }) => opened(key, await store.take({ key })),
    remove: (removeOptions) => store.remove(removeOptions),
    keys: () => store.keys(),
  };
}

/** 16 random bytes, base64url: unguessable, and unrelated to any provider's subject. */
export function randomAccountId(): AccountId {
  return randomBytes(16).toString("base64url");
}
