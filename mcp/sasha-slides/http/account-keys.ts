/**
 * Per-account data keys, and the vault that seals and opens values with them.
 *
 * THE SCHEME: every account has its own random 32-byte data key (DEK). A value is sealed
 * with AES-256-GCM under the DEK, with a fresh 12-byte nonce per seal, and the account id
 * and key id bound in as associated data so a sealed value cannot be replayed into another
 * account. The DEK itself is never stored in the clear: it is wrapped (AES-256-GCM again)
 * under one master key that comes from the environment (`SASHA_MASTER_KEY`), and the
 * wrapped DEKs live in a key store that is SEPARATE from the auth store. Destroying a DEK
 * (`resetKey`) is what "delete my data" means: every copy of a value sealed under it — the
 * auth store file, its backups, a log line that captured it — becomes noise.
 *
 * THE SEALED TEXT FORM, self-describing so a value from a destroyed key is recognisably
 * dead rather than "corrupt":
 *
 *   v1.<keyId>.<nonce>.<ciphertext || tag>          (each part base64url, no padding)
 *
 * `keyId` names the DEK that sealed it. A value whose key id is not the account's current
 * key opens to null, never throws; so does a value whose tag does not verify.
 *
 * THE KEY STORE FILE (`openFileBackedDataKeyStore`), written atomically with mode 0o600:
 *
 *   { "version": 1, "keys": { "<accountId>": { "keyId", "wrapped": "v1.<nonce>.<ct||tag>", "createdAtMs" } } }
 *
 * A key file that cannot be parsed refuses to load rather than starting empty, because the
 * next write would then overwrite every account's key — a silent mass erasure.
 */
import { createCipheriv, createDecipheriv, randomBytes as cryptoRandomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AccountId, AccountVault } from "./account-vault";
import { asNumber, asRecord, asString, parseJson } from "./json-values";

/** The environment variable the master key is read from. */
export const MASTER_KEY_ENV = "SASHA_MASTER_KEY";

/** How an operator makes a master key; quoted in every "missing or malformed" message. */
export const MASTER_KEY_HOWTO = `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;

/** One account's DEK as the key store holds it: wrapped under the master key, never raw. */
export type WrappedDataKey = Readonly<{
  keyId: string;
  /** `v1.<nonce>.<ciphertext || tag>`, base64url parts. */
  wrapped: string;
  createdAtMs: number;
}>;

/** Where wrapped DEKs live. Separate from the auth store so backups of one do not carry the other. */
export type DataKeyStore = Readonly<{
  get(options: Readonly<{ accountId: AccountId }>): Promise<WrappedDataKey | null>;
  put(options: Readonly<{ accountId: AccountId; value: WrappedDataKey }>): Promise<void>;
  /** Persisted before it resolves: once this returns, the key is gone from the backing. */
  remove(options: Readonly<{ accountId: AccountId }>): Promise<void>;
}>;

export type DataKeyStoreLoad =
  | Readonly<{ kind: "ok"; keyStore: DataKeyStore }>
  | Readonly<{ kind: "failed"; message: string }>;

export type MasterKeyLoad =
  | Readonly<{ kind: "ok"; key: Buffer }>
  | Readonly<{ kind: "missing"; message: string }>
  | Readonly<{ kind: "invalid"; message: string }>;

export function createAccountVault(
  options: Readonly<{
    keyStore: DataKeyStore;
    /** 32 bytes, from `loadMasterKey` in production and injected directly in tests. */
    masterKey: Buffer;
    /** Injected so a test can see every DEK the vault generates. */
    randomBytes?: (size: number) => Buffer;
    now?: () => Date;
  }>,
): AccountVault {
  const { keyStore, masterKey } = options;
  const random = options.randomBytes ?? cryptoRandomBytes;
  const now = options.now ?? (() => new Date());
  if (masterKey.length !== KEY_BYTES) {
    throw new Error(`the master key must be ${String(KEY_BYTES)} bytes, got ${String(masterKey.length)}`);
  }
  const serialize = perAccountQueue();

  const existingKey = async (accountId: AccountId): Promise<DataKey | null> => {
    const stored = await keyStore.get({ accountId });
    return stored === null ? null : { keyId: stored.keyId, key: unwrapDataKey({ masterKey, accountId, stored }) };
  };

  const ensureKey = async (accountId: AccountId): Promise<DataKey> => {
    const existing = await existingKey(accountId);
    if (existing !== null) return existing;
    const created: DataKey = { keyId: random(KEY_ID_BYTES).toString("base64url"), key: random(KEY_BYTES) };
    await keyStore.put({
      accountId,
      value: {
        keyId: created.keyId,
        wrapped: wrapDataKey({ masterKey, accountId, dataKey: created, nonce: random(NONCE_BYTES) }),
        createdAtMs: now().getTime(),
      },
    });
    return created;
  };

  return {
    seal: ({ accountId, plaintext }) =>
      serialize(accountId, async () => {
        const dataKey = await ensureKey(accountId);
        const nonce = random(NONCE_BYTES);
        const body = encrypt({
          key: dataKey.key,
          nonce,
          plaintext: Buffer.from(plaintext, "utf-8"),
          associatedData: sealAssociatedData({ accountId, keyId: dataKey.keyId }),
        });
        return [SEALED_VERSION, dataKey.keyId, nonce.toString("base64url"), body.toString("base64url")].join(".");
      }),

    open: ({ accountId, sealed }) =>
      serialize(accountId, async () => {
        const parsed = parseSealed(sealed);
        if (parsed === null) return null;
        const dataKey = await existingKey(accountId);
        if (dataKey === null || dataKey.keyId !== parsed.keyId) return null;
        const opened = decrypt({
          key: dataKey.key,
          nonce: parsed.nonce,
          body: parsed.body,
          associatedData: sealAssociatedData({ accountId, keyId: parsed.keyId }),
        });
        return opened === null ? null : opened.toString("utf-8");
      }),

    resetKey: ({ accountId }) => serialize(accountId, () => keyStore.remove({ accountId })),
  };
}

/** True when `text` has the shape of a sealed value. Says nothing about whether it still opens. */
export function isSealedValue(text: string): boolean {
  return parseSealed(text) !== null;
}

export function inMemoryDataKeyStore(): DataKeyStore {
  const keys = new Map<AccountId, WrappedDataKey>();
  return {
    get: ({ accountId }) => Promise.resolve(keys.get(accountId) ?? null),
    put: ({ accountId, value }) => {
      keys.set(accountId, value);
      return Promise.resolve();
    },
    remove: ({ accountId }) => {
      keys.delete(accountId);
      return Promise.resolve();
    },
  };
}

/**
 * The persistent key store: one JSON file, rewritten atomically (temp file + rename) on
 * every change, so a crash mid-write leaves the previous file rather than half a key.
 */
export function openFileBackedDataKeyStore(
  options: Readonly<{ path: string; warn: (message: string) => void }>,
): DataKeyStoreLoad {
  const { path, warn } = options;
  const loaded = loadKeyFile(path);
  if (loaded.kind === "failed") return loaded;
  const entries = loaded.entries;

  function persist(): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${String(process.pid)}.tmp`;
    const document = { version: KEY_FILE_VERSION, keys: Object.fromEntries(entries) };
    // 0o600 although every DEK in it is wrapped: the file still names every account.
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    renameSync(temporary, path);
  }

  return {
    kind: "ok",
    keyStore: {
      get: ({ accountId }) => {
        if (!entries.has(accountId)) return Promise.resolve(null);
        const decoded = decodeWrappedDataKey(entries.get(accountId));
        if (decoded === null) warn(`${path}: the data key entry for account ${accountId} is unreadable`);
        return Promise.resolve(decoded);
      },
      put: ({ accountId, value }) => {
        entries.set(accountId, value);
        persist();
        return Promise.resolve();
      },
      remove: ({ accountId }) => {
        entries.delete(accountId);
        persist();
        return Promise.resolve();
      },
    },
  };
}

/**
 * Reads the master key from `SASHA_MASTER_KEY`: 64 hex characters, or 32 bytes of base64url
 * (43 characters, or 44 with its `=` padding). Anything else is refused with a message
 * saying what was expected, because a near-miss key would seal everything unrecoverably.
 */
export function loadMasterKey(
  options: Readonly<{ env: Readonly<Record<string, string | undefined>> }>,
): MasterKeyLoad {
  const text = options.env[MASTER_KEY_ENV];
  if (text === undefined) {
    return {
      kind: "missing",
      message: `${MASTER_KEY_ENV} is not set. It encrypts every account's data key; generate one with\n  ${MASTER_KEY_HOWTO}\nand keep it out of the store's backups.`,
    };
  }
  const key = parseMasterKey(text.trim());
  if (key !== null) return { kind: "ok", key };
  return {
    kind: "invalid",
    message:
      `${MASTER_KEY_ENV} is malformed: expected 64 hex characters or a 43-character base64url value ` +
      `(32 bytes), got ${String(text.length)} characters. Generate one with\n  ${MASTER_KEY_HOWTO}`,
  };
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_BYTES = 9;
const SEALED_VERSION = "v1";
const WRAPPED_VERSION = "v1";
const KEY_FILE_VERSION = 1;
const BASE64URL_PART = /^[A-Za-z0-9_-]+$/u;

type DataKey = Readonly<{ keyId: string; key: Buffer }>;

/**
 * Runs each account's operations one at a time, so two concurrent first seals cannot each
 * mint a key and leave one of their values sealed under a key that was then overwritten.
 */
function perAccountQueue(): <TResult>(accountId: AccountId, work: () => Promise<TResult>) => Promise<TResult> {
  const tails = new Map<AccountId, Promise<unknown>>();
  return <TResult>(accountId: AccountId, work: () => Promise<TResult>): Promise<TResult> => {
    const previous = tails.get(accountId) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.catch(() => undefined);
    tails.set(accountId, tail);
    void tail.then(() => {
      if (tails.get(accountId) === tail) tails.delete(accountId);
    });
    return result;
  };
}

function sealAssociatedData(options: Readonly<{ accountId: AccountId; keyId: string }>): Buffer {
  return Buffer.from(`sasha-seal.${SEALED_VERSION}|${options.accountId}|${options.keyId}`, "utf-8");
}

function wrapAssociatedData(options: Readonly<{ accountId: AccountId; keyId: string }>): Buffer {
  return Buffer.from(`sasha-dek.${WRAPPED_VERSION}|${options.accountId}|${options.keyId}`, "utf-8");
}

function wrapDataKey(
  options: Readonly<{ masterKey: Buffer; accountId: AccountId; dataKey: DataKey; nonce: Buffer }>,
): string {
  const { masterKey, accountId, dataKey, nonce } = options;
  const body = encrypt({
    key: masterKey,
    nonce,
    plaintext: dataKey.key,
    associatedData: wrapAssociatedData({ accountId, keyId: dataKey.keyId }),
  });
  return [WRAPPED_VERSION, nonce.toString("base64url"), body.toString("base64url")].join(".");
}

/**
 * Throws, unlike `open`: a wrapped key that will not unwrap means the master key is wrong
 * or the key file was edited, and carrying on would make every value look destroyed.
 */
function unwrapDataKey(
  options: Readonly<{ masterKey: Buffer; accountId: AccountId; stored: WrappedDataKey }>,
): Buffer {
  const { masterKey, accountId, stored } = options;
  const parts = stored.wrapped.split(".");
  const nonce = parts.length === 3 && parts[0] === WRAPPED_VERSION ? decodePart(parts[1]) : null;
  const body = parts.length === 3 ? decodePart(parts[2]) : null;
  const unwrapped =
    nonce === null || body === null || nonce.length !== NONCE_BYTES
      ? null
      : decrypt({
          key: masterKey,
          nonce,
          body,
          associatedData: wrapAssociatedData({ accountId, keyId: stored.keyId }),
        });
  if (unwrapped === null || unwrapped.length !== KEY_BYTES) {
    throw new Error(
      `cannot unwrap the data key of account ${accountId}: the master key (${MASTER_KEY_ENV}) is not the ` +
        "one it was wrapped with, or the key store was modified",
    );
  }
  return unwrapped;
}

function encrypt(
  options: Readonly<{ key: Buffer; nonce: Buffer; plaintext: Buffer; associatedData: Buffer }>,
): Buffer {
  const cipher = createCipheriv("aes-256-gcm", options.key, options.nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(options.associatedData);
  return Buffer.concat([cipher.update(options.plaintext), cipher.final(), cipher.getAuthTag()]);
}

/** Null when the tag does not verify: a tampered value, the wrong key, or the wrong account. */
function decrypt(
  options: Readonly<{ key: Buffer; nonce: Buffer; body: Buffer; associatedData: Buffer }>,
): Buffer | null {
  const { key, nonce, body, associatedData } = options;
  if (body.length < TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(associatedData);
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

type ParsedSealed = Readonly<{ keyId: string; nonce: Buffer; body: Buffer }>;

function parseSealed(text: string): ParsedSealed | null {
  const parts = text.split(".");
  if (parts.length !== 4 || parts[0] !== SEALED_VERSION) return null;
  const keyId = parts[1];
  if (keyId === undefined || !BASE64URL_PART.test(keyId)) return null;
  const nonce = decodePart(parts[2]);
  const body = decodePart(parts[3]);
  if (nonce === null || nonce.length !== NONCE_BYTES || body === null || body.length < TAG_BYTES) return null;
  return { keyId, nonce, body };
}

function decodePart(part: string | undefined): Buffer | null {
  if (part === undefined || !BASE64URL_PART.test(part)) return null;
  return Buffer.from(part, "base64url");
}

type KeyFileLoad =
  | Readonly<{ kind: "ok"; entries: Map<AccountId, unknown> }>
  | Readonly<{ kind: "failed"; message: string }>;

function loadKeyFile(path: string): KeyFileLoad {
  if (!existsSync(path)) return { kind: "ok", entries: new Map() };
  const parsed = parseJson(readFileSync(path, "utf-8"));
  if (parsed.kind === "error") {
    return { kind: "failed", message: `${path} is not valid JSON (${parsed.reason}); refusing to start without its keys` };
  }
  const document = asRecord(parsed.value);
  const keys = document === null ? null : asRecord(document["keys"]);
  if (document === null || keys === null || document["version"] !== KEY_FILE_VERSION) {
    return {
      kind: "failed",
      message: `${path} is not a version ${String(KEY_FILE_VERSION)} key store; refusing to start without its keys`,
    };
  }
  return { kind: "ok", entries: new Map(Object.entries(keys)) };
}

function decodeWrappedDataKey(value: unknown): WrappedDataKey | null {
  const record = asRecord(value);
  if (record === null) return null;
  const keyId = asString(record["keyId"]);
  const wrapped = asString(record["wrapped"]);
  const createdAtMs = asNumber(record["createdAtMs"]);
  if (keyId === null || wrapped === null || createdAtMs === null) return null;
  return { keyId, wrapped, createdAtMs };
}

function parseMasterKey(text: string): Buffer | null {
  if (/^[0-9a-fA-F]{64}$/u.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9_-]{43}=?$/u.test(text)) {
    const key = Buffer.from(text.replace(/=$/u, ""), "base64url");
    // 43 characters carry 258 bits; the last character's low bits must be zero to be 32 bytes exactly.
    return key.length === KEY_BYTES && key.toString("base64url") === text.replace(/=$/u, "") ? key : null;
  }
  return null;
}
