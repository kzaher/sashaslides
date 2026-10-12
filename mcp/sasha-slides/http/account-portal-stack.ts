/**
 * Wires the `/account` portal from the CLI's inputs, so `server.ts` stays a CLI (the same
 * split as `brokered-stack.ts`).
 *
 * When it is on: `SASHA_SESSION_SECRET` set, or `--identity-providers` given. The flag
 * without the secret is a startup error, because a portal that cannot sign its session
 * cookies cannot let anyone in. Neither one leaves the portal off with a banner line saying
 * how to turn it on, so an existing deployment keeps starting exactly as before.
 *
 * Without `--identity-providers` the portal offers Google alone, on the connector's own
 * Google client, which the brokered stack has already proved loads.
 */
import { readFileSync } from "node:fs";
import { describeAuthFailure, loadClientCredentials } from "../google-auth";
import { storeAccountDirectory } from "./account-directory";
import { accountCallbackUrl, createAccountPortal, parseSessionSecret, ACCOUNT_PATH, type AccountPortal } from "./account-portal";
import type { AccountEraser, AccountVault } from "./account-vault";
import { randomAccountId } from "./accounts";
import {
  createIdentityProvider,
  defaultIdentityProviders,
  IDENTITY_PROVIDER_TIMEOUT_MS,
  parseIdentityProvidersConfig,
  randomSignInToken,
  type IdentityProviderSpec,
} from "./identity-providers";
import type { AuthStore } from "./oauth-store";

export type AccountPortalLoad =
  | Readonly<{ kind: "ok"; portal: AccountPortal; banner: readonly string[] }>
  | Readonly<{ kind: "off"; banner: readonly string[] }>
  | Readonly<{ kind: "failed"; message: string }>;

export function loadAccountPortal(
  options: Readonly<{
    publicUrl: string;
    /** Null offers Google alone, on the connector's client. */
    identityProvidersPath: string | null;
    /** The connector's Google OAuth client file, reused when the providers file omits Google credentials. */
    googleClientPath: string;
    /** `process.env.SASHA_SESSION_SECRET`, read by the caller. */
    sessionSecret: string | undefined;
    store: Pick<AuthStore, "accounts" | "accountLinks">;
    vault: AccountVault;
    eraser: AccountEraser;
    warn: (message: string) => void;
  }>,
): AccountPortalLoad {
  const { publicUrl, identityProvidersPath } = options;
  if (identityProvidersPath === null && (options.sessionSecret === undefined || options.sessionSecret === "")) {
    return { kind: "off", banner: [`account portal: off (set SASHA_SESSION_SECRET to serve ${ACCOUNT_PATH})`] };
  }
  const secret = parseSessionSecret(options.sessionSecret);
  if (secret.kind === "error") return { kind: "failed", message: secret.message };

  const specs = loadSpecs({ identityProvidersPath, googleClientPath: options.googleClientPath });
  if (specs.kind === "failed") return specs;
  const now = (): Date => new Date();
  const portal = createAccountPortal({
    publicUrl,
    sessionSecret: secret.secret,
    providers: specs.specs.map((spec) =>
      createIdentityProvider({ spec, fetch, now, randomToken: randomSignInToken, timeoutMs: IDENTITY_PROVIDER_TIMEOUT_MS }),
    ),
    directory: storeAccountDirectory({ store: options.store, vault: options.vault, now, newAccountId: randomAccountId }),
    eraser: options.eraser,
    now,
    randomToken: randomSignInToken,
    warn: options.warn,
  });
  return {
    kind: "ok",
    portal,
    banner: [
      `account portal: ${publicUrl.replace(/\/+$/, "")}${ACCOUNT_PATH} (${specs.specs.map((spec) => spec.name).join(", ")})`,
      ...specs.specs.map(
        (spec) => `register this ${spec.displayName} redirect URI: ${accountCallbackUrl({ publicUrl, provider: spec.name })}`,
      ),
    ],
  };
}

function loadSpecs(
  options: Readonly<{ identityProvidersPath: string | null; googleClientPath: string }>,
): Readonly<{ kind: "ok"; specs: readonly IdentityProviderSpec[] }> | Readonly<{ kind: "failed"; message: string }> {
  const credentials = loadClientCredentials({ path: options.googleClientPath });
  const connectorGoogleCredentials = credentials.kind === "ok" ? credentials.credentials : null;
  if (options.identityProvidersPath === null) {
    if (credentials.kind !== "ok") {
      return { kind: "failed", message: `account portal: no --identity-providers and no Google client: ${describeAuthFailure(credentials)}` };
    }
    return { kind: "ok", specs: defaultIdentityProviders({ connectorGoogleCredentials: credentials.credentials }) };
  }
  let text: string;
  try {
    text = readFileSync(options.identityProvidersPath, "utf-8");
  } catch (cause) {
    return { kind: "failed", message: `cannot read --identity-providers ${options.identityProvidersPath}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  const parsed = parseIdentityProvidersConfig({ text, connectorGoogleCredentials });
  if (parsed.kind === "error") return { kind: "failed", message: `--identity-providers ${options.identityProvidersPath}: ${parsed.message}` };
  return { kind: "ok", specs: parsed.providers };
}
