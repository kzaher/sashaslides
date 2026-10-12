/**
 * The one place the remote server's per-user auth machinery is wired together, so the CLI
 * in `server.ts` stays a CLI.
 *
 * Everything here is derived from `.auth/google_oauth.json` — the OAuth *client*, i.e. the
 * application's own identity. No user token is read at startup, and there is no
 * `.auth/tokens.json` on this path at all: each user's Google credentials arrive through
 * the brokered flow and live in the store (`oauth-store.ts`), sealed with the user's own
 * account key (`accounts.ts`, `account-keys.ts`).
 *
 * KEYS NEXT TO THE STORE: a persistent store needs a persistent key store (`keyStorePath`)
 * and a master key (`SASHA_MASTER_KEY`), or a restart would leave every sealed grant
 * unreadable. With neither path given everything is in memory, and a master key is
 * generated per process when the environment has none — it dies with the data it guards.
 */
import { randomBytes } from "node:crypto";
import { createAccountEraser, googleTokenRevoker, GOOGLE_REVOKE_TIMEOUT_MS } from "./account-eraser";
import {
  createAccountVault,
  inMemoryDataKeyStore,
  loadMasterKey,
  openFileBackedDataKeyStore,
  type DataKeyStore,
} from "./account-keys";
import type { AccountEraser, AccountVault } from "./account-vault";
import { withSealedGoogleIdentities } from "./accounts";
import {
  createAuthorizationServer,
  defaultAuthorizationServerConfig,
  randomUrlSafeToken,
  type AuthorizationServer,
} from "./authorization-server";
import { googleBroker } from "./google-broker";
import { endpointsFor, type Endpoints } from "./oauth-metadata";
import { fileBackedAuthStore, inMemoryAuthStore, type AuthStore } from "./oauth-store";
import { googleUserDriveFactory, type UserDriveFactory } from "./user-drive";
import { assertNever, describeAuthFailure, loadClientCredentials } from "../google-auth";

export type BrokeredStack = Readonly<{
  endpoints: Endpoints;
  authorizationServer: AuthorizationServer;
  /** Resolves a verified bearer's Google subject to a Drive client for that user. */
  userDrive: UserDriveFactory;
  /** The store with `googleIdentities` sealed: reads and writes plain identities. */
  store: AuthStore;
  /** Seals and opens values under each account's own key; `resetKey` destroys one. */
  vault: AccountVault;
  /** "Delete my data": revoke at Google, remove the account's records, destroy its key. */
  eraser: AccountEraser;
  /** Where each user's Google tokens are kept, for the startup banner. */
  storeDescription: string;
  /** Where the per-account data keys are kept, for the startup banner. */
  keyStoreDescription: string;
}>;

export type BrokeredStackLoad =
  | Readonly<{ kind: "ok"; stack: BrokeredStack }>
  | Readonly<{ kind: "failed"; message: string }>;

export function loadBrokeredStack(
  options: Readonly<{
    publicUrl: string;
    /** Null keeps every user's grant in memory, so a restart forces re-consent. */
    storePath: string | null;
    /** Required exactly when `storePath` is given: the separate file of wrapped data keys. */
    keyStorePath: string | null;
    /** Where `SASHA_MASTER_KEY` is read from; `process.env` in production. */
    env: Readonly<Record<string, string | undefined>>;
    /** Null derives Google's redirect from `publicUrl`; a URL overrides it (see `endpointsFor`). */
    googleCallbackUrl: string | null;
    /** The Google OAuth client file (a Web client in production). */
    googleClientPath: string;
    warn: (message: string) => void;
  }>,
): BrokeredStackLoad {
  const credentials = loadClientCredentials({ path: options.googleClientPath });
  if (credentials.kind !== "ok") return { kind: "failed", message: describeAuthFailure(credentials) };
  const keys = loadKeys(options);
  if (keys.kind === "failed") return keys;

  const endpoints = endpointsFor({
    publicUrl: options.publicUrl,
    ...(options.googleCallbackUrl === null ? {} : { googleCallbackUrl: options.googleCallbackUrl }),
  });
  const plainStore =
    options.storePath === null
      ? inMemoryAuthStore()
      : fileBackedAuthStore({ path: options.storePath, warn: options.warn });
  const vault = createAccountVault({ keyStore: keys.keyStore, masterKey: keys.masterKey });
  const { store } = withSealedGoogleIdentities({ store: plainStore, vault });
  return {
    kind: "ok",
    stack: {
      endpoints,
      authorizationServer: createAuthorizationServer({
        config: defaultAuthorizationServerConfig({ endpoints }),
        store,
        google: googleBroker({ credentials: credentials.credentials }),
        now: () => new Date(),
        randomToken: randomUrlSafeToken,
        warn: options.warn,
      }),
      userDrive: googleUserDriveFactory({
        store,
        credentials: credentials.credentials,
        warn: options.warn,
      }),
      store,
      vault,
      eraser: createAccountEraser({
        store,
        vault,
        revokeGoogleToken: googleTokenRevoker({ fetch, timeoutMs: GOOGLE_REVOKE_TIMEOUT_MS }),
      }),
      storeDescription: options.storePath === null ? "in memory (lost on restart)" : options.storePath,
      keyStoreDescription: options.keyStorePath === null ? "in memory (lost on restart)" : options.keyStorePath,
    },
  };
}

type KeysLoad =
  | Readonly<{ kind: "ok"; keyStore: DataKeyStore; masterKey: Buffer }>
  | Readonly<{ kind: "failed"; message: string }>;

function loadKeys(
  options: Readonly<{
    storePath: string | null;
    keyStorePath: string | null;
    env: Readonly<Record<string, string | undefined>>;
    warn: (message: string) => void;
  }>,
): KeysLoad {
  const { storePath, keyStorePath, env, warn } = options;
  if ((storePath === null) !== (keyStorePath === null)) {
    return { kind: "failed", message: "--store and --key-store must be given together" };
  }
  const master = loadMasterKey({ env });
  switch (master.kind) {
    case "ok":
      break;
    case "missing":
      // In memory, nothing outlives the process, so neither need the key.
      if (keyStorePath === null) return { kind: "ok", keyStore: inMemoryDataKeyStore(), masterKey: randomBytes(32) };
      return { kind: "failed", message: master.message };
    case "invalid":
      return { kind: "failed", message: master.message };
    default:
      return assertNever(master);
  }
  if (keyStorePath === null) return { kind: "ok", keyStore: inMemoryDataKeyStore(), masterKey: master.key };
  const loaded = openFileBackedDataKeyStore({ path: keyStorePath, warn });
  if (loaded.kind === "failed") return loaded;
  return { kind: "ok", keyStore: loaded.keyStore, masterKey: master.key };
}
