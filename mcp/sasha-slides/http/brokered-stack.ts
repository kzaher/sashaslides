/**
 * The one place the remote server's per-user auth machinery is wired together, so the CLI
 * in `server.ts` stays a CLI.
 *
 * Everything here is derived from `.auth/google_oauth.json` — the OAuth *client*, i.e. the
 * application's own identity. No user token is read at startup, and there is no
 * `.auth/tokens.json` on this path at all: each user's Google credentials arrive through
 * the brokered flow and live in the store (`oauth-store.ts`).
 */
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
import { describeAuthFailure, loadClientCredentials } from "../google-auth";

export type BrokeredStack = Readonly<{
  endpoints: Endpoints;
  authorizationServer: AuthorizationServer;
  /** Resolves a verified bearer's Google subject to a Drive client for that user. */
  userDrive: UserDriveFactory;
  store: AuthStore;
  /** Where each user's Google tokens are kept, for the startup banner. */
  storeDescription: string;
}>;

export type BrokeredStackLoad =
  | Readonly<{ kind: "ok"; stack: BrokeredStack }>
  | Readonly<{ kind: "failed"; message: string }>;

export function loadBrokeredStack(
  options: Readonly<{
    publicUrl: string;
    /** Null keeps every user's grant in memory, so a restart forces re-consent. */
    storePath: string | null;
    warn: (message: string) => void;
  }>,
): BrokeredStackLoad {
  const credentials = loadClientCredentials();
  if (credentials.kind !== "ok") return { kind: "failed", message: describeAuthFailure(credentials) };

  const endpoints = endpointsFor({ publicUrl: options.publicUrl });
  const store =
    options.storePath === null
      ? inMemoryAuthStore()
      : fileBackedAuthStore({ path: options.storePath, warn: options.warn });
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
      storeDescription: options.storePath === null ? "in memory (lost on restart)" : options.storePath,
    },
  };
}
