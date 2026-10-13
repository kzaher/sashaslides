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
 *
 * `--mail-sender <file>` adds email and password sign-in, mailing through the Gmail API
 * (`gmail-sender.ts`); like `--identity-providers` it turns the portal on and so needs the
 * session secret. `--trusted-proxy` names the proxies whose `X-Real-IP` is believed when
 * rate limiting by client address (`client-address.ts`); loopback always is.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assertNever, describeAuthFailure, loadClientCredentials } from "../google-auth";
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
import { LOOPBACK_PROXIES, parseTrustedProxies, type TrustedProxies } from "./client-address";
import { createGmailSender, MAIL_SENDER_TIMEOUT_MS, parseMailSenderConfig, type MailSenderConfig } from "./gmail-sender";
import { emailHint, type AccountDirectory } from "./account-directory";
import type { AuthStore } from "./oauth-store";
import { DEFAULT_SCRYPT_COST } from "./password-hashing";
import { createPasswordSignIn, DEFAULT_PASSWORD_LIMITS, type PasswordSignIn } from "./password-sign-in";
import { createThrottle } from "./request-throttle";

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
    /** Null leaves email and password sign-in off; a path is the `--mail-sender` JSON file. */
    mailSenderPath: string | null;
    /** `--trusted-proxy`, comma-separated addresses or subnets; null trusts loopback alone. */
    trustedProxies: string | null;
    store: Pick<AuthStore, "accounts" | "accountLinks" | "passwordCredentials">;
    vault: AccountVault;
    eraser: AccountEraser;
    warn: (message: string) => void;
  }>,
): AccountPortalLoad {
  const { publicUrl, identityProvidersPath } = options;
  const wanted = identityProvidersPath !== null || options.mailSenderPath !== null;
  if (!wanted && (options.sessionSecret === undefined || options.sessionSecret === "")) {
    return { kind: "off", banner: [`account portal: off (set SASHA_SESSION_SECRET to serve ${ACCOUNT_PATH})`] };
  }
  const secret = parseSessionSecret(options.sessionSecret);
  if (secret.kind === "error") return { kind: "failed", message: secret.message };

  const specs = loadSpecs({ identityProvidersPath, googleClientPath: options.googleClientPath });
  if (specs.kind === "failed") return specs;
  const now = (): Date => new Date();
  const directory = storeAccountDirectory({ store: options.store, vault: options.vault, now, newAccountId: randomAccountId });
  const password = loadPasswordSignIn({
    publicUrl,
    mailSenderPath: options.mailSenderPath,
    trustedProxies: options.trustedProxies,
    store: options.store,
    directory,
    now,
    warn: options.warn,
  });
  if (password.kind === "failed") return password;
  const portal = createAccountPortal({
    publicUrl,
    sessionSecret: secret.secret,
    providers: specs.specs.map((spec) =>
      createIdentityProvider({ spec, fetch, now, randomToken: randomSignInToken, timeoutMs: IDENTITY_PROVIDER_TIMEOUT_MS }),
    ),
    directory,
    eraser: options.eraser,
    now,
    randomToken: randomSignInToken,
    warn: options.warn,
    passwordSignIn: password.passwordSignIn,
  });
  return {
    kind: "ok",
    portal,
    banner: [
      `account portal: ${publicUrl.replace(/\/+$/, "")}${ACCOUNT_PATH} (${specs.specs.map((spec) => spec.name).join(", ")})`,
      ...specs.specs.map(
        (spec) => `register this ${spec.displayName} redirect URI: ${accountCallbackUrl({ publicUrl, provider: spec.name })}`,
      ),
      ...password.banner,
    ],
  };
}

type PasswordSignInLoad =
  | Readonly<{
      kind: "ok";
      passwordSignIn: Readonly<{ service: PasswordSignIn; trustedProxies: TrustedProxies }> | null;
      banner: readonly string[];
    }>
  | Readonly<{ kind: "failed"; message: string }>;

function loadPasswordSignIn(
  options: Readonly<{
    publicUrl: string;
    mailSenderPath: string | null;
    trustedProxies: string | null;
    store: Pick<AuthStore, "passwordCredentials">;
    directory: AccountDirectory;
    now: () => Date;
    warn: (message: string) => void;
  }>,
): PasswordSignInLoad {
  const { mailSenderPath, now, warn } = options;
  if (mailSenderPath === null) {
    return { kind: "ok", passwordSignIn: null, banner: ["email sign-in: off (give --mail-sender <file> to offer it)"] };
  }
  const proxies = options.trustedProxies === null ? { kind: "ok" as const, proxies: LOOPBACK_PROXIES } : parseTrustedProxies({ text: options.trustedProxies });
  if (proxies.kind === "error") return { kind: "failed", message: proxies.message };
  // An EMPTY file is the deploy's placeholder for a sender not minted yet (every secret is
  // bind-mounted by name), so it means "off", exactly like leaving the flag out.
  if (isEmptyFile(mailSenderPath)) {
    return { kind: "ok", passwordSignIn: null, banner: [`email sign-in: off (${mailSenderPath} is empty; mint it with mcp/sasha-slides/e2e/gmail-sender-token.ts)`] };
  }
  const config = loadMailSenderConfig(mailSenderPath);
  if (config.kind === "failed") return config;
  const service = createPasswordSignIn({
    publicUrl: options.publicUrl,
    credentials: options.store.passwordCredentials,
    directory: options.directory,
    mailSender: createGmailSender({ config: config.config, fetch, now, randomToken: randomSignInToken, timeoutMs: MAIL_SENDER_TIMEOUT_MS }),
    throttle: createThrottle({ now, maxKeys: THROTTLE_MAX_KEYS }),
    limits: DEFAULT_PASSWORD_LIMITS,
    now,
    randomToken: randomSignInToken,
    scryptCost: DEFAULT_SCRYPT_COST,
    // Mail failures are already turned into warnings inside the work; it never rejects.
    runInBackground: (work) => {
      void work;
    },
    warn,
  });
  return {
    kind: "ok",
    passwordSignIn: { service, trustedProxies: proxies.proxies },
    banner: [
      `email sign-in: on, mailing as ${emailHint(config.config.from.address)} through the Gmail API (${describeMailCredentials(config.config)})`,
      `email sign-in: client addresses from X-Real-IP are believed from ${proxies.proxies.description}`,
    ],
  };
}

/** Bounds the rate limiter's memory; see `request-throttle.ts`. */
const THROTTLE_MAX_KEYS = 100_000;

function loadMailSenderConfig(
  path: string,
): Readonly<{ kind: "ok"; config: MailSenderConfig }> | Readonly<{ kind: "failed"; message: string }> {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (cause) {
    return { kind: "failed", message: `cannot read --mail-sender ${path}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  // A relative service account key path is read from beside the mail-sender file, not the cwd.
  const configDirectory = dirname(path);
  const parsed = parseMailSenderConfig({ text, readKeyFile: (keyPath) => readFileSync(resolve(configDirectory, keyPath), "utf-8") });
  if (parsed.kind === "error") return { kind: "failed", message: `--mail-sender ${path}: ${parsed.message}` };
  return { kind: "ok", config: parsed.config };
}

/** The banner's account of how mail is authorised, with addresses masked like the From. */
function describeMailCredentials(config: MailSenderConfig): string {
  const { credentials } = config;
  switch (credentials.kind) {
    case "refresh-token":
      return "refresh token";
    case "service-account":
      return `service account, acting as ${emailHint(credentials.impersonate)}`;
    default:
      return assertNever(credentials);
  }
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
  // A relative key path (Apple's .p8) is read from beside the providers file, not the cwd.
  const configDirectory = dirname(options.identityProvidersPath);
  const parsed = parseIdentityProvidersConfig({
    text,
    connectorGoogleCredentials,
    readKeyFile: (keyPath) => readFileSync(resolve(configDirectory, keyPath), "utf-8"),
  });
  if (parsed.kind === "error") return { kind: "failed", message: `--identity-providers ${options.identityProvidersPath}: ${parsed.message}` };
  return { kind: "ok", specs: parsed.providers };
}

/** True for an existing file holding only whitespace; a missing file is left to the config loader's error. */
function isEmptyFile(path: string): boolean {
  try {
    return readFileSync(path, "utf8").trim() === "";
  } catch {
    return false;
  }
}
