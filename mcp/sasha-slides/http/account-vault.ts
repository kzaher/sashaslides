/**
 * The contract between per-account encryption (the vault) and the account portal.
 *
 * Every Sasha account has its own random data key. Anything we keep about the account (its
 * Google tokens, its email, data kept to improve the service) is sealed with that key before
 * it is written. "Reset my key" destroys the key: every copy of the old data, including
 * copies in backups, becomes unreadable, and the account starts again with a fresh key.
 *
 * Implemented in `account-keys.ts`; consumed by `account-portal.ts`.
 */

/** Our own random account id. Never a provider's subject, so it reveals nothing by itself. */
export type AccountId = string;

export type AccountVault = Readonly<{
  /** Seals `plaintext` under the account's current data key, creating the key on first use. */
  seal(options: Readonly<{ accountId: AccountId; plaintext: string }>): Promise<string>;
  /** Opens a sealed value, or null when the key that sealed it has been destroyed or it was tampered with. */
  open(options: Readonly<{ accountId: AccountId; sealed: string }>): Promise<string | null>;
  /** Destroys the account's data key. Values sealed before this call can never be opened again. */
  resetKey(options: Readonly<{ accountId: AccountId }>): Promise<void>;
}>;

/** Everything "delete my data" does, in order: revoke at Google, drop records, destroy the key. */
export type AccountEraser = Readonly<{
  eraseAccount(options: Readonly<{ accountId: AccountId }>): Promise<EraseReport>;
}>;

export type EraseReport = Readonly<{
  /** True when Google accepted the revocation, false when it failed or there was no Google token. */
  googleTokenRevoked: boolean;
  /** Records removed from the store (identities, links, issued tokens). */
  recordsRemoved: number;
  /** Always true on return: the data key is gone even if revocation failed. */
  keyDestroyed: true;
}>;
