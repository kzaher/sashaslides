/**
 * "Delete my data": revoke the account's grant at Google, remove every record the auth
 * store holds for it (an email sign-in's password included: it is keyed by the same
 * `email:<subject>` as its link), then destroy its data key.
 *
 * The key is destroyed last and unconditionally (try/finally). Revocation can fail (Google
 * down, token already dead) and a removal can throw (disk full); neither may leave the key
 * alive, because the key is the one step that also reaches copies we cannot delete — store
 * backups, a log line that captured a sealed value. A removal failure is rethrown AFTER the
 * key is gone, so the caller learns that records were left behind, all of them unreadable.
 *
 * Issued access/refresh tokens are keyed by hash and carry only a `googleSubject`, so they
 * are found by a scan over `keys()`. Erasure is rare and the collections are small; an
 * index would be one more thing to keep consistent on every token issue.
 *
 * Not touched: in-flight authorization codes (in memory, single use, minutes long). A code
 * redeemed after erasure issues a token whose `verifyBearer` finds no identity, so it is
 * refused as "sign in again".
 */
import type { AccountEraser, AccountVault, EraseReport } from "./account-vault";
import type { AuthStore, RecordStore } from "./oauth-store";

/** Revokes one Google token. Resolves false on any failure; never rejects. */
export type RevokeGoogleToken = (options: Readonly<{ token: string }>) => Promise<boolean>;

export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_REVOKE_TIMEOUT_MS = 5000;

export function createAccountEraser(
  options: Readonly<{
    /** The store with sealed identities (`withSealedGoogleIdentities`), so the token can be read to revoke it. */
    store: AuthStore;
    vault: AccountVault;
    revokeGoogleToken: RevokeGoogleToken;
  }>,
): AccountEraser {
  const { store, vault, revokeGoogleToken } = options;

  const removeRecords = async (accountId: string): Promise<Omit<EraseReport, "keyDestroyed">> => {
    const account = await store.accounts.get({ key: accountId });
    if (account === null) return { googleTokenRevoked: false, recordsRemoved: 0 };
    const subject = account.googleSubject;
    const googleTokenRevoked = subject === null ? false : await revokeGrant(subject);
    let recordsRemoved = 0;
    for (const linkKey of account.linkKeys) {
      recordsRemoved += await removeIfPresent({ collection: store.accountLinks, key: linkKey });
      recordsRemoved += await removeIfPresent({ collection: store.passwordCredentials, key: linkKey });
    }
    if (subject !== null) {
      recordsRemoved += await removeIfPresent({ collection: store.googleIdentities, key: subject });
      recordsRemoved += await removeWhere({ collection: store.accessTokens, matches: (t) => t.googleSubject === subject });
      recordsRemoved += await removeWhere({ collection: store.refreshTokens, matches: (t) => t.googleSubject === subject });
    }
    recordsRemoved += await removeIfPresent({ collection: store.accounts, key: accountId });
    return { googleTokenRevoked, recordsRemoved };
  };

  const revokeGrant = async (subject: string): Promise<boolean> => {
    const identity = await store.googleIdentities.get({ key: subject });
    // A refresh token revokes the whole grant; an access token alone is the fallback.
    const token = identity === null ? null : (identity.refreshToken ?? identity.accessToken);
    if (token === null) return false;
    try {
      return await revokeGoogleToken({ token });
    } catch {
      return false;
    }
  };

  return {
    eraseAccount: async ({ accountId }) => {
      try {
        const removed = await removeRecords(accountId);
        return { ...removed, keyDestroyed: true };
      } finally {
        await vault.resetKey({ accountId });
      }
    },
  };
}

/**
 * "Delete my data" with decks (SPEC.md 21.7 "Erase"): the decks the account owns are deleted, its
 * memberships removed and its open deck sockets closed BEFORE the inner eraser destroys the key --
 * the deck records it must rewrite are sealed under OTHER owners' keys, and the owned decks'
 * directories need no key to delete. The key is still destroyed when the deck step throws (the
 * inner eraser runs in `finally`), and the deck failure is rethrown afterwards, so the caller learns
 * that something was left behind, all of it unreadable.
 */
export function withDeckErasure(
  options: Readonly<{ eraser: AccountEraser; eraseDecks: (options: Readonly<{ accountId: string }>) => Promise<void> }>,
): AccountEraser {
  return {
    eraseAccount: async ({ accountId }) => {
      let deckFailure: unknown = null;
      try {
        await options.eraseDecks({ accountId });
      } catch (cause) {
        deckFailure = cause;
      }
      const report = await options.eraser.eraseAccount({ accountId });
      if (deckFailure !== null) throw deckFailure;
      return report;
    },
  };
}

/**
 * Production revocation: `POST https://oauth2.googleapis.com/revoke` with `token=`, bounded
 * by `timeoutMs`. Google answers 200 on success and 400 for a token it no longer knows.
 */
export function googleTokenRevoker(
  options: Readonly<{ fetch: typeof fetch; timeoutMs: number }>,
): RevokeGoogleToken {
  const { fetch: send, timeoutMs } = options;
  return async ({ token }) => {
    try {
      const response = await send(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}

/** 1 when the key was there and is now removed, 0 when there was nothing to remove. */
async function removeIfPresent<TValue>(
  options: Readonly<{ collection: RecordStore<TValue>; key: string }>,
): Promise<number> {
  const { collection, key } = options;
  if (!(await collection.keys()).includes(key)) return 0;
  await collection.remove({ key });
  return 1;
}

async function removeWhere<TValue>(
  options: Readonly<{ collection: RecordStore<TValue>; matches: (value: TValue) => boolean }>,
): Promise<number> {
  const { collection, matches } = options;
  let removed = 0;
  for (const key of await collection.keys()) {
    const value = await collection.get({ key });
    if (value === null || !matches(value)) continue;
    await collection.remove({ key });
    removed += 1;
  }
  return removed;
}
