/**
 * Everything the brokering authorization server has to remember, and the two backings for
 * it: in-memory (tests, and the default for a single-process deployment) and file-backed
 * (dev, so a restart does not force every user through Google consent again).
 *
 * The shape is six keyed collections behind one uniform `RecordStore`, so the
 * authorization server never learns which backing it got. `take` is the single-use read:
 * a `state`, an authorization code and a refresh token are each valid exactly once, which
 * is what makes replay of any of them a dead request rather than a second grant.
 *
 * WHERE EACH USER'S GOOGLE TOKEN LIVES: `googleIdentities`, keyed by the Google `sub`
 * claim. Nothing else holds a Google credential — in particular the tokens we hand to
 * Claude are opaque strings of our own (`accessTokens` / `refreshTokens`) that carry only
 * a `googleSubject` pointer. There is no shared `.auth/tokens.json` anywhere on this path.
 *
 * ENCRYPT AT REST (out of scope, deliberately): `GoogleIdentity.refreshToken` is the only
 * long-lived secret here and it is written in clear text by `fileBackedAuthStore`. The
 * place to wrap it is `googleIdentityCodec` below — encode/decode is already the one
 * chokepoint every persisted identity passes through, so an AEAD there (key from the
 * environment, nonce per record) would cover the file without touching any caller. The
 * tokens we issue are stored only as SHA-256 hashes, so the store file cannot be replayed
 * as a bearer credential even unencrypted.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { asNumber, asRecord, asString, asStringArray, parseJson } from "./json-values";

export type AuthStore = Readonly<{
  /** DCR-registered MCP clients (Claude), keyed by the `client_id` we minted. */
  clients: RecordStore<RegisteredClient>;
  /** In-flight authorize requests, keyed by the `state` we send to Google. Single use. */
  pendingAuthorizations: RecordStore<PendingAuthorization>;
  /** Our authorization codes, keyed by the code. Single use. */
  authorizationCodes: RecordStore<AuthorizationCodeGrant>;
  /** The users' Google credentials, keyed by Google `sub`. */
  googleIdentities: RecordStore<GoogleIdentity>;
  /** Access tokens we issued, keyed by `sha256(token)`. */
  accessTokens: RecordStore<IssuedAccessToken>;
  /** Refresh tokens we issued, keyed by `sha256(token)`. Single use (rotated). */
  refreshTokens: RecordStore<IssuedRefreshToken>;
}>;

export type RecordStore<TValue> = Readonly<{
  put(options: Readonly<{ key: string; value: TValue }>): Promise<void>;
  get(options: Readonly<{ key: string }>): Promise<TValue | null>;
  /** Reads and removes in one step, so a replayed key finds nothing. */
  take(options: Readonly<{ key: string }>): Promise<TValue | null>;
  remove(options: Readonly<{ key: string }>): Promise<void>;
}>;

/**
 * A public client: PKCE is the proof of possession, so there is no client secret to leak.
 * `tokenEndpointAuthMethod` is a single-member union rather than a string because the AS
 * metadata advertises exactly `["none"]` and anything else here would be a silent lie.
 */
export type RegisteredClient = Readonly<{
  clientId: string;
  clientName: string | null;
  redirectUris: readonly string[];
  tokenEndpointAuthMethod: "none";
  issuedAtSeconds: number;
}>;

export type PendingAuthorization = Readonly<{
  /** Our own `state` toward Google, and this record's key. Never the client's. */
  brokerState: string;
  clientId: string;
  /** The client's `redirect_uri`, already validated; replayed verbatim at callback. */
  clientRedirectUri: string;
  /** The client's own `state`, echoed back untouched. Null when it sent none. */
  clientState: string | null;
  /** The client's PKCE challenge. S256 only; verified at `/token`, not here. */
  codeChallenge: string;
  /** RFC 8707 `resource`, when the client sent one. Already checked against ours. */
  resource: string | null;
  scopes: readonly string[];
  createdAtMs: number;
}>;

export type AuthorizationCodeGrant = Readonly<{
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** The Google identity this code was minted for. The binding, start to finish. */
  googleSubject: string;
  resource: string | null;
  scopes: readonly string[];
  createdAtMs: number;
}>;

export type GoogleIdentity = Readonly<{
  /** Google's `sub` claim: stable per user per OAuth client. Our user key. */
  subject: string;
  email: string | null;
  accessToken: string | null;
  /** Google only returns this on first consent, so it is preserved across refreshes. */
  refreshToken: string | null;
  accessTokenExpiresAtMs: number | null;
  grantedScopes: readonly string[];
}>;

export type IssuedAccessToken = Readonly<{
  clientId: string;
  googleSubject: string;
  scopes: readonly string[];
  resource: string | null;
  expiresAtMs: number;
}>;

export type IssuedRefreshToken = Readonly<{
  clientId: string;
  googleSubject: string;
  scopes: readonly string[];
  resource: string | null;
}>;

export function inMemoryAuthStore(): AuthStore {
  return {
    clients: inMemoryRecordStore<RegisteredClient>(),
    pendingAuthorizations: inMemoryRecordStore<PendingAuthorization>(),
    authorizationCodes: inMemoryRecordStore<AuthorizationCodeGrant>(),
    googleIdentities: inMemoryRecordStore<GoogleIdentity>(),
    accessTokens: inMemoryRecordStore<IssuedAccessToken>(),
    refreshTokens: inMemoryRecordStore<IssuedRefreshToken>(),
  };
}

/**
 * Dev backing: the four collections worth surviving a restart go to one JSON file, the two
 * that live for seconds stay in memory. Losing a `state` or an authorization code across a
 * restart costs the user one click; losing a Google refresh token costs them a consent
 * screen, and losing the client registration costs a re-registration round trip.
 */
export function fileBackedAuthStore(
  options: Readonly<{ path: string; warn: (message: string) => void }>,
): AuthStore {
  const file = openJsonFile(options);
  return {
    clients: file.collection({ name: "clients", codec: registeredClientCodec }),
    pendingAuthorizations: inMemoryRecordStore<PendingAuthorization>(),
    authorizationCodes: inMemoryRecordStore<AuthorizationCodeGrant>(),
    googleIdentities: file.collection({ name: "googleIdentities", codec: googleIdentityCodec }),
    accessTokens: file.collection({ name: "accessTokens", codec: issuedAccessTokenCodec }),
    refreshTokens: file.collection({ name: "refreshTokens", codec: issuedRefreshTokenCodec }),
  };
}

export function inMemoryRecordStore<TValue>(): RecordStore<TValue> {
  const entries = new Map<string, TValue>();
  return {
    put: ({ key, value }) => {
      entries.set(key, value);
      return Promise.resolve();
    },
    get: ({ key }) => Promise.resolve(entries.get(key) ?? null),
    take: ({ key }) => {
      const value = entries.get(key) ?? null;
      entries.delete(key);
      return Promise.resolve(value);
    },
    remove: ({ key }) => {
      entries.delete(key);
      return Promise.resolve();
    },
  };
}

/**
 * The parse boundary for one persisted value type. Encode is where encrypt-at-rest would
 * go (see this file's header); decode is where a hand-edited or stale file is rejected
 * instead of being trusted as a typed value.
 */
export type JsonCodec<TValue> = Readonly<{
  encode(value: TValue): unknown;
  decode(value: unknown): TValue | null;
}>;

type JsonFile = Readonly<{
  collection<TValue>(
    options: Readonly<{ name: string; codec: JsonCodec<TValue> }>,
  ): RecordStore<TValue>;
}>;

function openJsonFile(options: Readonly<{ path: string; warn: (message: string) => void }>): JsonFile {
  const { path, warn } = options;
  const collections = new Map<string, Map<string, unknown>>();
  loadInto({ path, warn, collections });

  function persist(): void {
    const document: Record<string, Record<string, unknown>> = {};
    for (const [name, entries] of collections) document[name] = Object.fromEntries(entries);
    mkdirSync(dirname(path), { recursive: true });
    // 0o600: the file holds every user's Google refresh token in clear text until
    // encrypt-at-rest lands (see this file's header).
    writeFileSync(path, `${JSON.stringify({ version: 1, collections: document }, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
  }

  function entriesFor(name: string): Map<string, unknown> {
    const existing = collections.get(name);
    if (existing !== undefined) return existing;
    const created = new Map<string, unknown>();
    collections.set(name, created);
    return created;
  }

  return {
    collection: <TValue>(collectionOptions: Readonly<{ name: string; codec: JsonCodec<TValue> }>) => {
      const { name, codec } = collectionOptions;
      const entries = entriesFor(name);
      const read = (key: string): TValue | null => {
        if (!entries.has(key)) return null;
        const decoded = codec.decode(entries.get(key));
        if (decoded !== null) return decoded;
        warn(`${path}: dropping unreadable ${name} entry`);
        entries.delete(key);
        return null;
      };
      const store: RecordStore<TValue> = {
        put: ({ key, value }) => {
          entries.set(key, codec.encode(value));
          persist();
          return Promise.resolve();
        },
        get: ({ key }) => Promise.resolve(read(key)),
        take: ({ key }) => {
          const value = read(key);
          entries.delete(key);
          persist();
          return Promise.resolve(value);
        },
        remove: ({ key }) => {
          entries.delete(key);
          persist();
          return Promise.resolve();
        },
      };
      return store;
    },
  };
}

function loadInto(
  options: Readonly<{
    path: string;
    warn: (message: string) => void;
    collections: Map<string, Map<string, unknown>>;
  }>,
): void {
  const { path, warn, collections } = options;
  if (!existsSync(path)) return;
  const parsed = parseJson(readFileSync(path, "utf-8"));
  if (parsed.kind === "error") {
    warn(`${path} is not valid JSON (${parsed.reason}); starting from an empty store`);
    return;
  }
  const document = asRecord(parsed.value);
  const stored = document === null ? null : asRecord(document["collections"]);
  if (stored === null) {
    warn(`${path} has no "collections" object; starting from an empty store`);
    return;
  }
  for (const [name, value] of Object.entries(stored)) {
    const entries = asRecord(value);
    if (entries === null) continue;
    collections.set(name, new Map(Object.entries(entries)));
  }
}

const registeredClientCodec: JsonCodec<RegisteredClient> = {
  encode: (value) => value,
  decode: (value) => {
    const record = asRecord(value);
    if (record === null) return null;
    const clientId = asString(record["clientId"]);
    const redirectUris = asStringArray(record["redirectUris"]);
    const issuedAtSeconds = asNumber(record["issuedAtSeconds"]);
    if (clientId === null || redirectUris === null || issuedAtSeconds === null) return null;
    if (record["tokenEndpointAuthMethod"] !== "none") return null;
    return {
      clientId,
      clientName: asString(record["clientName"]),
      redirectUris,
      tokenEndpointAuthMethod: "none",
      issuedAtSeconds,
    };
  },
};

const googleIdentityCodec: JsonCodec<GoogleIdentity> = {
  encode: (value) => value,
  decode: (value) => {
    const record = asRecord(value);
    if (record === null) return null;
    const subject = asString(record["subject"]);
    const grantedScopes = asStringArray(record["grantedScopes"]);
    if (subject === null || grantedScopes === null) return null;
    return {
      subject,
      email: asString(record["email"]),
      accessToken: asString(record["accessToken"]),
      refreshToken: asString(record["refreshToken"]),
      accessTokenExpiresAtMs: asNumber(record["accessTokenExpiresAtMs"]),
      grantedScopes,
    };
  },
};

const issuedAccessTokenCodec: JsonCodec<IssuedAccessToken> = {
  encode: (value) => value,
  decode: (value) => {
    const record = asRecord(value);
    if (record === null) return null;
    const clientId = asString(record["clientId"]);
    const googleSubject = asString(record["googleSubject"]);
    const scopes = asStringArray(record["scopes"]);
    const expiresAtMs = asNumber(record["expiresAtMs"]);
    if (clientId === null || googleSubject === null || scopes === null || expiresAtMs === null) return null;
    return { clientId, googleSubject, scopes, resource: asString(record["resource"]), expiresAtMs };
  },
};

const issuedRefreshTokenCodec: JsonCodec<IssuedRefreshToken> = {
  encode: (value) => value,
  decode: (value) => {
    const record = asRecord(value);
    if (record === null) return null;
    const clientId = asString(record["clientId"]);
    const googleSubject = asString(record["googleSubject"]);
    const scopes = asStringArray(record["scopes"]);
    if (clientId === null || googleSubject === null || scopes === null) return null;
    return { clientId, googleSubject, scopes, resource: asString(record["resource"]) };
  },
};
