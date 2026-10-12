/**
 * The sign-in providers a Sasha account can be opened with: Google, Microsoft, GitHub, or any
 * standard OpenID Connect issuer. Signing in here establishes WHO is at the account portal,
 * nothing more. Google Slides access is a separate grant made through the brokered flow in
 * `authorization-server.ts`, and nothing in this file can produce one.
 *
 * Every flow is authorization code + PKCE (S256) + `state`, plus a `nonce` for OpenID
 * Connect. The ID token is verified here rather than trusted because it arrived over TLS from
 * the token endpoint: signature against the issuer's JWKS (RS256 only, so neither `none` nor
 * an HS256 token keyed with the public key can pass), then `iss`, `aud`/`azp`, `exp` and
 * `nonce`. GitHub is plain OAuth 2.0 with no ID token, so its identity is read from its API
 * with the access token the exchange just returned.
 *
 * Two provider quirks that shape the code:
 *
 *  - **Microsoft's `common` endpoint** advertises the issuer as a template,
 *    `https://login.microsoftonline.com/{tenantid}/v2.0`, and each token's `iss` names the
 *    user's own tenant. The check substitutes the token's `tid` claim (which must look like a
 *    tenant id) into the template and requires an exact match, as Microsoft documents for
 *    multi-tenant apps. Microsoft's `email` claim is not verified by Microsoft, so it is
 *    never reported as verified.
 *  - **GitHub's token endpoint** answers form-encoded unless asked for JSON, and reports a
 *    bad code as a 200 with an `error` field. Its API refuses a request without a
 *    User-Agent.
 *
 * Accounts are keyed by `provider:subject`, never by email. An email address is a hint for
 * the person reading the portal; merging accounts on it would let anyone who can make a
 * provider assert an address (Microsoft's unverified claim, a self-hosted issuer) take over
 * the account that owns it.
 *
 * The config file (`--identity-providers`) is parsed here at the boundary. Error messages
 * name the offending path (`providers[1].clientSecret`) and never echo a value, so a typo
 * next to a secret cannot leak the secret into a log.
 *
 * All network traffic goes through an injected `HttpFetch`, so the tests drive real token
 * signing and verification against fakes.
 */
import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from "node:crypto";
import { assertNever, type GoogleClientCredentials } from "../google-auth";
import type { OAuthParameters } from "./authorization-server";
import { asRecord, asString, asStringArray, parseJson } from "./json-values";

/** The narrow slice of `fetch` this module uses. The global `fetch` satisfies it. */
export type HttpFetch = (url: string, init: HttpFetchInit) => Promise<HttpFetchResponse>;

export type HttpFetchInit = Readonly<{
  method: "GET" | "POST";
  headers: Readonly<Record<string, string>>;
  body?: string;
  signal: AbortSignal;
}>;

export type HttpFetchResponse = Readonly<{ status: number; json(): Promise<unknown> }>;

/** A configured provider: the parsed config entry, credentials included. Never logged. */
export type IdentityProviderSpec =
  | Readonly<{
      protocol: "oidc";
      /** Lowercase, URL-safe: it appears in `/account/login/<name>`. */
      name: string;
      displayName: string;
      /** Discovery is fetched from `${issuer}/.well-known/openid-configuration`. */
      issuer: string;
      issuerRule: IssuerRule;
      clientId: string;
      clientSecret: string;
      scopes: readonly string[];
    }>
  | Readonly<{
      protocol: "github";
      name: string;
      displayName: string;
      clientId: string;
      clientSecret: string;
      scopes: readonly string[];
    }>;

/** How an ID token's `iss` is checked. */
export type IssuerRule =
  /** `iss` must be one of these, verbatim. Google's tokens use either of two spellings. */
  | Readonly<{ kind: "exact"; issuers: readonly string[] }>
  /** `iss` must equal `template` with `{tid}` replaced by the token's own tenant id claim. */
  | Readonly<{ kind: "tenant"; template: string }>;

export type IdentityProvidersParse =
  | Readonly<{ kind: "ok"; providers: readonly IdentityProviderSpec[] }>
  | Readonly<{ kind: "error"; message: string }>;

/** A sign-in that left for the provider and has not come back yet. Single use. */
export type PendingSignIn = Readonly<{
  provider: string;
  state: string;
  codeVerifier: string;
  /** Null for plain OAuth 2.0 (GitHub), which has no ID token to carry it. */
  nonce: string | null;
}>;

export type BeginOutcome =
  | Readonly<{ kind: "redirect"; location: string; pending: PendingSignIn }>
  | Readonly<{ kind: "failed"; reason: string }>;

/** Who signed in. `email` is a display hint only; the account key is provider + subject. */
export type VerifiedIdentity = Readonly<{
  provider: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
}>;

export type SignInOutcome =
  | Readonly<{ kind: "signed-in"; identity: VerifiedIdentity }>
  /** `reason` is for the server log; it holds no secret but may name the provider's error. */
  | Readonly<{ kind: "failed"; reason: string }>;

export type IdentityProvider = Readonly<{
  name: string;
  displayName: string;
  /** Step one: where to send the browser, and what to remember until it comes back. */
  begin(options: Readonly<{ redirectUri: string }>): Promise<BeginOutcome>;
  /** Step two: the browser is back at the callback with `parameters` from the provider. */
  complete(
    options: Readonly<{ pending: PendingSignIn; parameters: OAuthParameters; redirectUri: string }>,
  ): Promise<SignInOutcome>;
}>;

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";
export const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";
/** Every outbound call's budget, discovery included. */
export const IDENTITY_PROVIDER_TIMEOUT_MS = 5000;

/**
 * Parses the `--identity-providers` file. `connectorGoogleCredentials` is the connector's own
 * Google client, which a `google` entry without credentials reuses; null when it has none.
 */
export function parseIdentityProvidersConfig(
  options: Readonly<{ text: string; connectorGoogleCredentials: GoogleClientCredentials | null }>,
): IdentityProvidersParse {
  const parsed = parseJson(options.text);
  if (parsed.kind === "error") return { kind: "error", message: `identity providers file is not JSON: ${parsed.reason}` };
  const root = asRecord(parsed.value);
  if (root === null) return { kind: "error", message: `identity providers file must be an object with a "providers" list` };
  const unknownRootKey = Object.keys(root).find((key) => key !== "providers");
  if (unknownRootKey !== undefined) return { kind: "error", message: `unknown key ${JSON.stringify(unknownRootKey)} (only "providers" is allowed)` };
  const entries = root.providers;
  if (!Array.isArray(entries) || entries.length === 0) {
    return { kind: "error", message: "providers must be a non-empty list" };
  }
  const providers: IdentityProviderSpec[] = [];
  for (const [index, entry] of entries.entries()) {
    const spec = parseProviderEntry({ entry, path: `providers[${String(index)}]`, connectorGoogleCredentials: options.connectorGoogleCredentials });
    if (spec.kind === "error") return spec;
    if (providers.some((existing) => existing.name === spec.spec.name)) {
      return { kind: "error", message: `providers[${String(index)}].name: ${JSON.stringify(spec.spec.name)} is configured twice` };
    }
    providers.push(spec.spec);
  }
  return { kind: "ok", providers };
}

/** No `--identity-providers` file: Google alone, on the connector's own client. */
export function defaultIdentityProviders(
  options: Readonly<{ connectorGoogleCredentials: GoogleClientCredentials }>,
): readonly IdentityProviderSpec[] {
  return [presetSpec({ preset: "google", credentials: options.connectorGoogleCredentials, displayName: null, scopes: null })];
}

export function createIdentityProvider(
  options: Readonly<{
    spec: IdentityProviderSpec;
    fetch: HttpFetch;
    now: () => Date;
    /** URL-safe, at least 128 bits: `state`, PKCE verifier and nonce are drawn from it. */
    randomToken: () => string;
    timeoutMs: number;
  }>,
): IdentityProvider {
  const { spec } = options;
  switch (spec.protocol) {
    case "oidc":
      return oidcProvider({ ...options, spec });
    case "github":
      return gitHubProvider({ ...options, spec });
    default:
      return assertNever(spec);
  }
}

/** 32 random bytes, base64url: the default `randomToken`. */
export function randomSignInToken(): string {
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------- config parsing

type PresetName = "google" | "microsoft" | "github";

type EntryParse = Readonly<{ kind: "ok"; spec: IdentityProviderSpec }> | Readonly<{ kind: "error"; message: string }>;

const ENTRY_KEYS: readonly string[] = ["name", "displayName", "issuer", "clientId", "clientSecret", "scopes"];
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const DEFAULT_OIDC_SCOPES: readonly string[] = ["openid", "email"];

function parseProviderEntry(
  options: Readonly<{ entry: unknown; path: string; connectorGoogleCredentials: GoogleClientCredentials | null }>,
): EntryParse {
  const { path } = options;
  const entry = asRecord(options.entry);
  if (entry === null) return { kind: "error", message: `${path} must be an object` };
  const unknownKey = Object.keys(entry).find((key) => !ENTRY_KEYS.includes(key));
  if (unknownKey !== undefined) {
    return { kind: "error", message: `${path}: unknown key ${JSON.stringify(unknownKey)} (allowed: ${ENTRY_KEYS.join(", ")})` };
  }
  const name = asString(entry.name);
  if (name === null || !NAME_PATTERN.test(name)) {
    return { kind: "error", message: `${path}.name must be lowercase letters, digits and dashes, starting with a letter` };
  }
  const displayName = optionalNonEmptyString({ value: entry.displayName, path: `${path}.displayName` });
  if (displayName.kind === "error") return displayName;
  const scopes = parseScopes({ value: entry.scopes, path: `${path}.scopes` });
  if (scopes.kind === "error") return scopes;
  const credentials = parseCredentials({ entry, path, name, connectorGoogleCredentials: options.connectorGoogleCredentials });
  if (credentials.kind === "error") return credentials;

  if (isPresetName(name)) {
    if (entry.issuer !== undefined) return { kind: "error", message: `${path}.issuer is fixed for the ${name} preset; remove it` };
    return {
      kind: "ok",
      spec: presetSpec({ preset: name, credentials: credentials.credentials, displayName: displayName.value, scopes: scopes.value }),
    };
  }
  if (displayName.value === null) return { kind: "error", message: `${path}.displayName is required for a provider that is not a preset` };
  const issuer = asString(entry.issuer);
  if (issuer === null) return { kind: "error", message: `${path}.issuer is required for a provider that is not a preset` };
  if (!isHttpsUrl(issuer)) return { kind: "error", message: `${path}.issuer must be an https URL without query or fragment` };
  return {
    kind: "ok",
    spec: {
      protocol: "oidc",
      name,
      displayName: displayName.value,
      issuer,
      issuerRule: { kind: "exact", issuers: [issuer] },
      clientId: credentials.credentials.clientId,
      clientSecret: credentials.credentials.clientSecret,
      scopes: scopes.value ?? DEFAULT_OIDC_SCOPES,
    },
  };
}

/**
 * The parse-boundary guard for the closed preset set. Its input is any configured name, so it
 * cannot be exhaustive over `PresetName`; a new preset is added here by hand.
 */
function isPresetName(candidate: string): candidate is PresetName {
  return candidate === "google" || candidate === "microsoft" || candidate === "github";
}

function presetSpec(
  options: Readonly<{
    preset: PresetName;
    credentials: GoogleClientCredentials;
    displayName: string | null;
    scopes: readonly string[] | null;
  }>,
): IdentityProviderSpec {
  const { preset, credentials, displayName, scopes } = options;
  switch (preset) {
    case "google":
      return {
        protocol: "oidc",
        name: "google",
        displayName: displayName ?? "Google",
        issuer: "https://accounts.google.com",
        // Google documents both spellings as valid `iss` values.
        issuerRule: { kind: "exact", issuers: ["https://accounts.google.com", "accounts.google.com"] },
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        scopes: scopes ?? DEFAULT_OIDC_SCOPES,
      };
    case "microsoft":
      return {
        protocol: "oidc",
        name: "microsoft",
        displayName: displayName ?? "Microsoft",
        issuer: "https://login.microsoftonline.com/common/v2.0",
        issuerRule: { kind: "tenant", template: "https://login.microsoftonline.com/{tid}/v2.0" },
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        scopes: scopes ?? DEFAULT_OIDC_SCOPES,
      };
    case "github":
      return {
        protocol: "github",
        name: "github",
        displayName: displayName ?? "GitHub",
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        scopes: scopes ?? ["read:user", "user:email"],
      };
    default:
      return assertNever(preset);
  }
}

type FieldParse<TValue> = Readonly<{ kind: "ok"; value: TValue }> | Readonly<{ kind: "error"; message: string }>;

function optionalNonEmptyString(options: Readonly<{ value: unknown; path: string }>): FieldParse<string | null> {
  if (options.value === undefined) return { kind: "ok", value: null };
  const text = asString(options.value);
  if (text === null || text.trim() === "") return { kind: "error", message: `${options.path} must be a non-empty string` };
  return { kind: "ok", value: text };
}

function parseScopes(options: Readonly<{ value: unknown; path: string }>): FieldParse<readonly string[] | null> {
  if (options.value === undefined) return { kind: "ok", value: null };
  const scopes = asStringArray(options.value);
  if (scopes === null || scopes.length === 0 || scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))) {
    return { kind: "error", message: `${options.path} must be a non-empty list of scope strings` };
  }
  return { kind: "ok", value: scopes };
}

function parseCredentials(
  options: Readonly<{
    entry: Readonly<Record<string, unknown>>;
    path: string;
    name: string;
    connectorGoogleCredentials: GoogleClientCredentials | null;
  }>,
): Readonly<{ kind: "ok"; credentials: GoogleClientCredentials }> | Readonly<{ kind: "error"; message: string }> {
  const { entry, path, name } = options;
  if (name === "google" && entry.clientId === undefined && entry.clientSecret === undefined) {
    if (options.connectorGoogleCredentials === null) {
      return { kind: "error", message: `${path}: google has no clientId/clientSecret and the connector has no Google client to reuse` };
    }
    return { kind: "ok", credentials: options.connectorGoogleCredentials };
  }
  if (name === "google" && (entry.clientId === undefined) !== (entry.clientSecret === undefined)) {
    return { kind: "error", message: `${path}: give both clientId and clientSecret, or neither to reuse the connector's Google client` };
  }
  // The values are deliberately absent from every message below.
  const clientId = asString(entry.clientId);
  if (clientId === null || clientId === "") return { kind: "error", message: `${path}.clientId must be a non-empty string` };
  const clientSecret = asString(entry.clientSecret);
  if (clientSecret === null || clientSecret === "") return { kind: "error", message: `${path}.clientSecret must be a non-empty string` };
  return { kind: "ok", credentials: { clientId, clientSecret } };
}

function isHttpsUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" && url.search === "" && url.hash === "" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- OpenID Connect

type OidcSpec = Extract<IdentityProviderSpec, Readonly<{ protocol: "oidc" }>>;

type ProviderDependencies = Readonly<{
  fetch: HttpFetch;
  now: () => Date;
  randomToken: () => string;
  timeoutMs: number;
}>;

type OidcDiscovery = Readonly<{
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  clientAuthentication: "basic" | "post";
}>;

type Loaded<TValue> = Readonly<{ kind: "ok"; value: TValue }> | Readonly<{ kind: "failed"; reason: string }>;

/** RSA public keys from the JWKS, by `kid` (null when the key has none). */
type SigningKey = Readonly<{ kid: string | null; key: KeyObject }>;

/** Tolerated clock difference between us and the issuer, for `exp` and `nbf`. */
const CLOCK_SKEW_MS = 60_000;
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function oidcProvider(options: ProviderDependencies & Readonly<{ spec: OidcSpec }>): IdentityProvider {
  const { spec, fetch, now, randomToken, timeoutMs } = options;
  // Cached for the process lifetime once it succeeds; a failure is not cached, so the next
  // sign-in retries instead of the portal staying broken until a restart.
  let discovery: Promise<Loaded<OidcDiscovery>> | null = null;
  let signingKeys: readonly SigningKey[] | null = null;

  const discover = (): Promise<Loaded<OidcDiscovery>> => {
    if (discovery === null) {
      discovery = fetchDiscovery({ spec, fetch, timeoutMs }).then((loaded) => {
        if (loaded.kind === "failed") discovery = null;
        return loaded;
      });
    }
    return discovery;
  };

  /** `refresh` refetches the JWKS: the issuer may have rotated to a key we have not seen. */
  const keys = async (refresh: boolean): Promise<Loaded<readonly SigningKey[]>> => {
    if (signingKeys !== null && !refresh) return { kind: "ok", value: signingKeys };
    const found = await discover();
    if (found.kind === "failed") return found;
    const loaded = await fetchSigningKeys({ jwksUri: found.value.jwksUri, fetch, timeoutMs });
    if (loaded.kind === "ok") signingKeys = loaded.value;
    return loaded;
  };

  return {
    name: spec.name,
    displayName: spec.displayName,
    begin: async ({ redirectUri }) => {
      const found = await discover();
      if (found.kind === "failed") return found;
      const pending: PendingSignIn = { provider: spec.name, state: randomToken(), codeVerifier: randomToken(), nonce: randomToken() };
      const url = new URL(found.value.authorizationEndpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", spec.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", spec.scopes.join(" "));
      url.searchParams.set("state", pending.state);
      url.searchParams.set("nonce", pending.nonce ?? "");
      url.searchParams.set("code_challenge", s256Challenge(pending.codeVerifier));
      url.searchParams.set("code_challenge_method", "S256");
      return { kind: "redirect", location: url.toString(), pending };
    },
    complete: async ({ pending, parameters, redirectUri }) => {
      const code = callbackCode({ pending, parameters });
      if (code.kind === "failed") return code;
      const found = await discover();
      if (found.kind === "failed") return found;
      const exchanged = await exchangeCode({
        tokenEndpoint: found.value.tokenEndpoint,
        clientAuthentication: found.value.clientAuthentication,
        clientId: spec.clientId,
        clientSecret: spec.clientSecret,
        code: code.value,
        redirectUri,
        codeVerifier: pending.codeVerifier,
        fetch,
        timeoutMs,
      });
      if (exchanged.kind === "failed") return exchanged;
      const idToken = asString(exchanged.value.id_token);
      if (idToken === null) return { kind: "failed", reason: `${spec.name}: the token response has no id_token` };
      return verifyIdToken({ idToken, spec, expectedNonce: pending.nonce, keys, nowMs: now().getTime() });
    },
  };
}

async function fetchDiscovery(
  options: Readonly<{ spec: OidcSpec; fetch: HttpFetch; timeoutMs: number }>,
): Promise<Loaded<OidcDiscovery>> {
  const { spec } = options;
  const url = `${spec.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const fetched = await fetchJson({ fetch: options.fetch, url, init: { method: "GET", headers: { accept: "application/json" } }, timeoutMs: options.timeoutMs });
  if (fetched.kind === "failed") return { kind: "failed", reason: `${spec.name} discovery: ${fetched.reason}` };
  const document = asRecord(fetched.value.body);
  if (fetched.value.status !== 200 || document === null) {
    return { kind: "failed", reason: `${spec.name} discovery: HTTP ${String(fetched.value.status)} from ${url}` };
  }
  const advertisedIssuer = asString(document.issuer);
  const authorizationEndpoint = asString(document.authorization_endpoint);
  const tokenEndpoint = asString(document.token_endpoint);
  const jwksUri = asString(document.jwks_uri);
  if (authorizationEndpoint === null || tokenEndpoint === null || jwksUri === null || advertisedIssuer === null) {
    return { kind: "failed", reason: `${spec.name} discovery: document lacks issuer, authorization_endpoint, token_endpoint or jwks_uri` };
  }
  if (![authorizationEndpoint, tokenEndpoint, jwksUri].every((endpoint) => endpoint.startsWith("https://"))) {
    return { kind: "failed", reason: `${spec.name} discovery: an endpoint is not https` };
  }
  // OpenID Connect Discovery 4.3: the document must name the issuer it was fetched for. A
  // tenant template (Microsoft's `{tenantid}`) is checked per token instead.
  if (!discoveredIssuerMatches({ rule: spec.issuerRule, advertisedIssuer })) {
    return { kind: "failed", reason: `${spec.name} discovery: document is for issuer ${advertisedIssuer}, not ${spec.issuer}` };
  }
  const methods = asStringArray(document.token_endpoint_auth_methods_supported);
  const clientAuthentication = chooseClientAuthentication(methods);
  if (clientAuthentication === null) {
    return { kind: "failed", reason: `${spec.name} discovery: supports neither client_secret_basic nor client_secret_post` };
  }
  return { kind: "ok", value: { authorizationEndpoint, tokenEndpoint, jwksUri, clientAuthentication } };
}

function discoveredIssuerMatches(options: Readonly<{ rule: IssuerRule; advertisedIssuer: string }>): boolean {
  const { rule } = options;
  switch (rule.kind) {
    case "exact":
      return rule.issuers.includes(options.advertisedIssuer);
    case "tenant":
      return true;
    default:
      return assertNever(rule);
  }
}

/** Absent means `client_secret_basic`, the OpenID Connect default. */
function chooseClientAuthentication(methods: readonly string[] | null): "basic" | "post" | null {
  if (methods === null || methods.includes("client_secret_basic")) return "basic";
  if (methods.includes("client_secret_post")) return "post";
  return null;
}

async function fetchSigningKeys(
  options: Readonly<{ jwksUri: string; fetch: HttpFetch; timeoutMs: number }>,
): Promise<Loaded<readonly SigningKey[]>> {
  const fetched = await fetchJson({ fetch: options.fetch, url: options.jwksUri, init: { method: "GET", headers: { accept: "application/json" } }, timeoutMs: options.timeoutMs });
  if (fetched.kind === "failed") return { kind: "failed", reason: `JWKS: ${fetched.reason}` };
  const keys = asRecord(fetched.value.body)?.keys;
  if (fetched.value.status !== 200 || !Array.isArray(keys)) return { kind: "failed", reason: `JWKS: no key list at ${options.jwksUri}` };
  const signingKeys: SigningKey[] = [];
  for (const candidate of keys) {
    const jwk = asRecord(candidate);
    if (jwk === null || jwk.kty !== "RSA") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
    const modulus = asString(jwk.n);
    const exponent = asString(jwk.e);
    if (modulus === null || exponent === null) continue;
    try {
      signingKeys.push({ kid: asString(jwk.kid), key: createPublicKey({ key: { kty: "RSA", n: modulus, e: exponent }, format: "jwk" }) });
    } catch {
      // A malformed key in the set is skipped; the token's own key is what has to be valid.
    }
  }
  return { kind: "ok", value: signingKeys };
}

async function verifyIdToken(
  options: Readonly<{
    idToken: string;
    spec: OidcSpec;
    expectedNonce: string | null;
    keys: (refresh: boolean) => Promise<Loaded<readonly SigningKey[]>>;
    nowMs: number;
  }>,
): Promise<SignInOutcome> {
  const { spec, nowMs } = options;
  const fail = (reason: string): SignInOutcome => ({ kind: "failed", reason: `${spec.name} ID token: ${reason}` });
  const parts = options.idToken.split(".");
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (parts.length !== 3 || encodedHeader === undefined || encodedClaims === undefined || encodedSignature === undefined) {
    return fail("not a compact JWS");
  }
  const header = decodeJsonSegment(encodedHeader);
  const claims = decodeJsonSegment(encodedClaims);
  if (header === null || claims === null) return fail("header or payload is not base64url JSON");
  // Pinning the algorithm is what keeps `none` and RS/HS confusion out.
  if (header.alg !== "RS256") return fail(`unsupported alg ${JSON.stringify(header.alg)}`);

  const kid = asString(header.kid);
  const key = await findSigningKey({ kid, keys: options.keys });
  if (key.kind === "failed") return fail(key.reason);
  const signedInput = Buffer.from(`${encodedHeader}.${encodedClaims}`, "utf-8");
  const signature = Buffer.from(encodedSignature, "base64url");
  if (!verify("RSA-SHA256", signedInput, key.value, signature)) return fail("signature does not verify");

  if (!issuerMatches({ rule: spec.issuerRule, claims })) return fail(`unexpected issuer ${JSON.stringify(claims.iss)}`);
  const audience = typeof claims.aud === "string" ? [claims.aud] : asStringArray(claims.aud);
  if (audience === null || !audience.includes(spec.clientId)) return fail("audience is not this client");
  // OpenID Connect Core 3.1.3.7: with several audiences, `azp` must name us.
  if (audience.length > 1 && claims.azp !== spec.clientId) return fail("authorized party is not this client");
  if (typeof claims.exp !== "number") return fail("no expiry");
  if (claims.exp * 1000 + CLOCK_SKEW_MS <= nowMs) return fail("expired");
  if (typeof claims.nbf === "number" && claims.nbf * 1000 - CLOCK_SKEW_MS > nowMs) return fail("not yet valid");
  if (options.expectedNonce === null || claims.nonce !== options.expectedNonce) return fail("nonce does not match this sign-in");
  const subject = asString(claims.sub);
  if (subject === null || subject === "") return fail("no subject");

  const email = asString(claims.email);
  return {
    kind: "signed-in",
    identity: {
      provider: spec.name,
      subject,
      email: email === "" ? null : email,
      // Some issuers send the boolean as a string.
      emailVerified: email !== null && email !== "" && (claims.email_verified === true || claims.email_verified === "true"),
    },
  };
}

async function findSigningKey(
  options: Readonly<{ kid: string | null; keys: (refresh: boolean) => Promise<Loaded<readonly SigningKey[]>> }>,
): Promise<Loaded<KeyObject>> {
  for (const refresh of [false, true]) {
    const loaded = await options.keys(refresh);
    if (loaded.kind === "failed") return loaded;
    const matches = loaded.value.filter((candidate) => options.kid === null || candidate.kid === options.kid);
    // Without a `kid` the key is only unambiguous when the set holds exactly one.
    const [only] = matches;
    if (only !== undefined && (options.kid !== null || matches.length === 1)) return { kind: "ok", value: only.key };
  }
  return { kind: "failed", reason: `no signing key ${options.kid === null ? "(no kid)" : JSON.stringify(options.kid)} in the JWKS` };
}

function issuerMatches(options: Readonly<{ rule: IssuerRule; claims: Readonly<Record<string, unknown>> }>): boolean {
  const { rule, claims } = options;
  const issuer = asString(claims.iss);
  if (issuer === null) return false;
  switch (rule.kind) {
    case "exact":
      return rule.issuers.includes(issuer);
    case "tenant": {
      const tenant = asString(claims.tid);
      if (tenant === null || !TENANT_ID_PATTERN.test(tenant)) return false;
      return issuer === rule.template.replace("{tid}", tenant);
    }
    default:
      return assertNever(rule);
  }
}

function decodeJsonSegment(segment: string): Readonly<Record<string, unknown>> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return null;
  const parsed = parseJson(Buffer.from(segment, "base64url").toString("utf-8"));
  return parsed.kind === "ok" ? asRecord(parsed.value) : null;
}

// ---------------------------------------------------------------- GitHub

type GitHubSpec = Extract<IdentityProviderSpec, Readonly<{ protocol: "github" }>>;

const GITHUB_API_HEADERS: Readonly<Record<string, string>> = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  // GitHub's API rejects a request without a User-Agent.
  "user-agent": "sasha-slides-account-portal",
};

function gitHubProvider(options: ProviderDependencies & Readonly<{ spec: GitHubSpec }>): IdentityProvider {
  const { spec, fetch, randomToken, timeoutMs } = options;
  return {
    name: spec.name,
    displayName: spec.displayName,
    begin: ({ redirectUri }) => {
      const pending: PendingSignIn = { provider: spec.name, state: randomToken(), codeVerifier: randomToken(), nonce: null };
      const url = new URL(GITHUB_AUTHORIZE_URL);
      url.searchParams.set("client_id", spec.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", spec.scopes.join(" "));
      url.searchParams.set("state", pending.state);
      url.searchParams.set("code_challenge", s256Challenge(pending.codeVerifier));
      url.searchParams.set("code_challenge_method", "S256");
      return Promise.resolve({ kind: "redirect", location: url.toString(), pending });
    },
    complete: async ({ pending, parameters, redirectUri }) => {
      const code = callbackCode({ pending, parameters });
      if (code.kind === "failed") return code;
      const exchanged = await exchangeCode({
        tokenEndpoint: GITHUB_TOKEN_URL,
        clientAuthentication: "post",
        clientId: spec.clientId,
        clientSecret: spec.clientSecret,
        code: code.value,
        redirectUri,
        codeVerifier: pending.codeVerifier,
        fetch,
        timeoutMs,
      });
      if (exchanged.kind === "failed") return exchanged;
      const accessToken = asString(exchanged.value.access_token);
      if (accessToken === null) return { kind: "failed", reason: "github: the token response has no access_token" };
      const headers = { ...GITHUB_API_HEADERS, authorization: `Bearer ${accessToken}` };

      const user = await fetchJson({ fetch, url: GITHUB_USER_URL, init: { method: "GET", headers }, timeoutMs });
      if (user.kind === "failed") return { kind: "failed", reason: `github user: ${user.reason}` };
      const id = asRecord(user.value.body)?.id;
      if (user.value.status !== 200 || typeof id !== "number" || !Number.isSafeInteger(id)) {
        return { kind: "failed", reason: `github user: HTTP ${String(user.value.status)} without a numeric id` };
      }
      // The address is a display hint, so a failure to read it degrades to null instead of
      // failing a sign-in whose identity is already established.
      const emails = await fetchJson({ fetch, url: GITHUB_EMAILS_URL, init: { method: "GET", headers }, timeoutMs });
      const email = emails.kind === "ok" && emails.value.status === 200 ? primaryVerifiedEmail(emails.value.body) : null;
      return {
        kind: "signed-in",
        identity: { provider: spec.name, subject: String(id), email, emailVerified: email !== null },
      };
    },
  };
}

function primaryVerifiedEmail(body: unknown): string | null {
  if (!Array.isArray(body)) return null;
  for (const candidate of body) {
    const entry = asRecord(candidate);
    const email = asString(entry?.email);
    if (entry !== null && email !== null && entry.primary === true && entry.verified === true) return email;
  }
  return null;
}

// ---------------------------------------------------------------- shared OAuth 2.0 legs

function callbackCode(options: Readonly<{ pending: PendingSignIn; parameters: OAuthParameters }>): Loaded<string> {
  const { pending, parameters } = options;
  if (parameters.get("state") !== pending.state) return { kind: "failed", reason: `${pending.provider}: state does not match the pending sign-in` };
  const error = parameters.get("error");
  if (error !== null) return { kind: "failed", reason: `${pending.provider} returned error ${JSON.stringify(error)}` };
  const code = parameters.get("code");
  if (code === null || code === "") return { kind: "failed", reason: `${pending.provider}: callback has no code` };
  return { kind: "ok", value: code };
}

async function exchangeCode(
  options: Readonly<{
    tokenEndpoint: string;
    clientAuthentication: "basic" | "post";
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    fetch: HttpFetch;
    timeoutMs: number;
  }>,
): Promise<Loaded<Readonly<Record<string, unknown>>>> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    redirect_uri: options.redirectUri,
    code_verifier: options.codeVerifier,
  });
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  switch (options.clientAuthentication) {
    case "basic":
      // RFC 6749 section 2.3.1: each half is form-encoded before joining.
      headers.authorization = `Basic ${Buffer.from(`${formEncode(options.clientId)}:${formEncode(options.clientSecret)}`).toString("base64")}`;
      break;
    case "post":
      form.set("client_id", options.clientId);
      form.set("client_secret", options.clientSecret);
      break;
    default:
      assertNever(options.clientAuthentication);
  }
  const fetched = await fetchJson({
    fetch: options.fetch,
    url: options.tokenEndpoint,
    init: { method: "POST", headers, body: form.toString() },
    timeoutMs: options.timeoutMs,
  });
  if (fetched.kind === "failed") return { kind: "failed", reason: `token exchange: ${fetched.reason}` };
  const body = asRecord(fetched.value.body);
  // GitHub reports a bad code as HTTP 200 with an `error` field.
  const error = asString(body?.error);
  if (fetched.value.status !== 200 || body === null || error !== null) {
    return { kind: "failed", reason: `token exchange: HTTP ${String(fetched.value.status)}${error === null ? "" : ` ${error}`}` };
  }
  return { kind: "ok", value: body };
}

function formEncode(text: string): string {
  return encodeURIComponent(text).replace(/%20/g, "+");
}

async function fetchJson(
  options: Readonly<{
    fetch: HttpFetch;
    url: string;
    init: Readonly<{ method: "GET" | "POST"; headers: Readonly<Record<string, string>>; body?: string }>;
    timeoutMs: number;
  }>,
): Promise<Loaded<Readonly<{ status: number; body: unknown }>>> {
  try {
    const response = await options.fetch(options.url, { ...options.init, signal: AbortSignal.timeout(options.timeoutMs) });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { kind: "ok", value: { status: response.status, body } };
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
    return {
      kind: "failed",
      reason: timedOut ? `${options.url} timed out after ${String(options.timeoutMs)} ms` : `${options.url}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

function s256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
