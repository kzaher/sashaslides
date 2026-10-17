/**
 * Fake sign-in providers for the account portal tests: an OpenID Connect issuer that signs
 * real RS256 ID tokens and serves discovery and JWKS, a fake Sign in with Apple, and a fake
 * GitHub. All answer through one injected `fetch`, so nothing leaves the process.
 *
 * The browser leg is simulated by `authorize`: it reads the authorization URL the code under
 * test produced, remembers its PKCE challenge, nonce and redirect URI, and returns the
 * callback parameters a real provider would redirect (or, for Apple, POST) with. The token
 * endpoint then refuses a verifier that does not match, so a round trip proves PKCE instead
 * of assuming it.
 *
 * The fake Apple's token endpoint authenticates the client the way Apple does: the
 * `client_secret` must be an ES256 JWT whose signature verifies against the public half of
 * the test's .p8 key, with the right `kid`, `iss` (team), `sub` (Services ID), `aud` and an
 * unexpired `exp` at most six months after `iat`. Its authorize step refuses a request for
 * the `name` or `email` scope that does not ask for `response_mode=form_post`, as Apple does.
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import type { HttpFetch, HttpFetchInit, HttpFetchResponse } from "../http/http-kit";
import { APPLE_ISSUER, GITHUB_AUTHORIZE_URL, GITHUB_EMAILS_URL, GITHUB_TOKEN_URL, GITHUB_USER_URL } from "../http/identity-providers";
import { asRecord, parseJson } from "../http/json-values";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

/** Answers a request it owns, or returns null so the next route can try. */
export type FakeRoute = (url: URL, init: HttpFetchInit) => HttpFetchResponse | null;

export type RecordingFetch = Readonly<{ fetch: HttpFetch; requestedUrls: () => readonly string[] }>;

export function fakeFetch(options: Readonly<{ routes: readonly FakeRoute[] }>): RecordingFetch {
  const requestedUrls: string[] = [];
  return {
    fetch: (url, init) => {
      requestedUrls.push(url);
      const parsed = new URL(url);
      for (const route of options.routes) {
        const answer = route(parsed, init);
        if (answer !== null) return Promise.resolve(answer);
      }
      return Promise.resolve(jsonResponse({ status: 404, body: { error: "no fake route", url } }));
    },
    requestedUrls: () => requestedUrls,
  };
}

/** The browser arriving back at our callback: the query a provider would redirect with. */
export type CallbackParameters = Readonly<{ code: string; state: string }>;

/** How a fake issuer should spoil the ID token it mints, to drive one rejection each. */
export type IdTokenTamper = Readonly<{
  /** Claims merged over the honest ones (`undefined` deletes a claim). */
  claims?: Readonly<Record<string, unknown>>;
  signing?: "valid" | "foreign-key" | "alg-none" | "hs256";
}>;

/** Apple sends `email_verified` as a string; other issuers send a boolean. */
export type FakeEmailVerified = boolean | "true" | "false";

export type FakeOidcIssuer = Readonly<{
  route: FakeRoute;
  authorize(
    options: Readonly<{
      authorizationUrl: string;
      subject: string;
      email: string | null;
      emailVerified: FakeEmailVerified;
      tamper: IdTokenTamper;
    }>,
  ): CallbackParameters;
}>;

export function createFakeOidcIssuer(
  options: Readonly<{
    /** Discovery lives at `${discoveryBase}/.well-known/openid-configuration`. */
    discoveryBase: string;
    /** The `issuer` the discovery document advertises. */
    advertisedIssuer: string;
    /** The `iss` claim the honest ID token carries. */
    tokenIssuer: string;
    clientId: string;
    clientSecret: string;
    now: () => Date;
    /** Claims every honest token carries in addition. */
    extraClaims: Readonly<Record<string, unknown>>;
  }>,
): FakeOidcIssuer {
  const { clientId, clientSecret } = options;
  return fakeIssuer({
    ...options,
    authMethods: ["client_secret_basic", "client_secret_post"],
    authenticateClient: ({ init, form }) => clientAuthenticated({ init, form, clientId, clientSecret }),
  });
}

/** Apple's callback is a form POST, which carries `user` (JSON with the name) on first consent. */
export type AppleCallbackParameters = CallbackParameters & Readonly<{ user: string }>;

export type FakeApple = Readonly<{
  route: FakeRoute;
  authorize(
    options: Readonly<{
      authorizationUrl: string;
      subject: string;
      email: string | null;
      emailVerified: FakeEmailVerified;
      tamper: IdTokenTamper;
    }>,
  ): AppleCallbackParameters;
}>;

export function createFakeApple(
  options: Readonly<{
    /** The Services ID. */
    clientId: string;
    teamId: string;
    keyId: string;
    /** The public half of the .p8 key the code under test signs its client secret with. */
    clientPublicKey: KeyObject;
    now: () => Date;
  }>,
): FakeApple {
  const issuer = fakeIssuer({
    discoveryBase: APPLE_ISSUER,
    advertisedIssuer: APPLE_ISSUER,
    tokenIssuer: APPLE_ISSUER,
    clientId: options.clientId,
    now: options.now,
    extraClaims: { nonce_supported: true, auth_time: Math.floor(options.now().getTime() / 1000) },
    // What Apple's real discovery document advertises.
    authMethods: ["client_secret_post"],
    authenticateClient: ({ form }) =>
      form.get("client_id") === options.clientId &&
      appleClientSecretValid({
        secret: form.get("client_secret") ?? "",
        clientId: options.clientId,
        teamId: options.teamId,
        keyId: options.keyId,
        publicKey: options.clientPublicKey,
        nowMs: options.now().getTime(),
      }),
  });
  return {
    route: issuer.route,
    authorize: (authorization) => {
      const query = new URL(authorization.authorizationUrl).searchParams;
      const scopes = (query.get("scope") ?? "").split(" ");
      // Apple: "if you requested any scopes, you must use form_post".
      if ((scopes.includes("name") || scopes.includes("email")) && query.get("response_mode") !== "form_post") {
        throw new Error("fake Apple: invalid_request, name or email scope without response_mode=form_post");
      }
      if (query.get("client_id") !== options.clientId) throw new Error("fake Apple: invalid_client");
      const callback = issuer.authorize(authorization);
      return { ...callback, user: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" }, email: authorization.email }) };
    },
  };
}

export type FakeGitHubEmail = Readonly<{ email: string; primary: boolean; verified: boolean }>;

export type FakeGitHub = Readonly<{
  route: FakeRoute;
  authorize(options: Readonly<{ authorizationUrl: string }>): CallbackParameters;
}>;

export function createFakeGitHub(
  options: Readonly<{
    clientId: string;
    clientSecret: string;
    userId: number;
    emails: readonly FakeGitHubEmail[];
  }>,
): FakeGitHub {
  const grants = new Map<string, Readonly<{ challenge: string; redirectUri: string }>>();
  const issuedTokens = new Set<string>();

  const route: FakeRoute = (url, init) => {
    const address = `${url.origin}${url.pathname}`;
    if (address === GITHUB_TOKEN_URL) {
      // GitHub answers form-encoded unless asked for JSON, which a JSON parser then chokes on.
      if (init.headers.accept !== "application/json") return textResponse({ status: 200, text: "access_token=x" });
      const form = new URLSearchParams(init.body ?? "");
      if (form.get("client_id") !== options.clientId || form.get("client_secret") !== options.clientSecret) {
        return jsonResponse({ status: 200, body: { error: "incorrect_client_credentials" } });
      }
      const code = form.get("code") ?? "";
      const grant = grants.get(code);
      grants.delete(code);
      if (grant === undefined) return jsonResponse({ status: 200, body: { error: "bad_verification_code" } });
      if (form.get("redirect_uri") !== grant.redirectUri || s256(form.get("code_verifier") ?? "") !== grant.challenge) {
        return jsonResponse({ status: 200, body: { error: "bad_verification_code" } });
      }
      const token = `gho_${randomBytes(8).toString("hex")}`;
      issuedTokens.add(token);
      return jsonResponse({ status: 200, body: { access_token: token, token_type: "bearer", scope: "read:user,user:email" } });
    }
    if (address !== GITHUB_USER_URL && address !== GITHUB_EMAILS_URL) return null;
    const bearer = /^Bearer (.+)$/.exec(init.headers.authorization ?? "")?.[1] ?? "";
    // The real API rejects a request without a User-Agent outright.
    if (!issuedTokens.has(bearer) || (init.headers["user-agent"] ?? "") === "") {
      return jsonResponse({ status: 401, body: { message: "Bad credentials" } });
    }
    if (address === GITHUB_USER_URL) {
      return jsonResponse({ status: 200, body: { id: options.userId, login: "octo", email: null } });
    }
    return jsonResponse({ status: 200, body: options.emails.map((entry) => ({ ...entry, visibility: null })) });
  };

  return {
    route,
    authorize: ({ authorizationUrl }) => {
      const parsed = new URL(authorizationUrl);
      if (`${parsed.origin}${parsed.pathname}` !== GITHUB_AUTHORIZE_URL) throw new Error(`not GitHub: ${authorizationUrl}`);
      const code = randomBytes(12).toString("hex");
      grants.set(code, {
        challenge: parsed.searchParams.get("code_challenge") ?? "",
        redirectUri: parsed.searchParams.get("redirect_uri") ?? "",
      });
      return { code, state: parsed.searchParams.get("state") ?? "" };
    },
  };
}

/** A fresh EC P-256 key pair, as Apple issues for Sign in with Apple, with the private half as .p8 PEM. */
export function generateAppleKey(): Readonly<{ privateKeyPem: string; privateKey: KeyObject; publicKey: KeyObject }> {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  };
}

export function jsonResponse(options: Readonly<{ status: number; body: unknown }>): HttpFetchResponse {
  return { status: options.status, json: () => Promise.resolve(options.body) };
}

// ---------------------------------------------------------------- shared issuer

type ClientCheck = (request: Readonly<{ init: HttpFetchInit; form: URLSearchParams }>) => boolean;

function fakeIssuer(
  options: Readonly<{
    discoveryBase: string;
    advertisedIssuer: string;
    tokenIssuer: string;
    clientId: string;
    now: () => Date;
    extraClaims: Readonly<Record<string, unknown>>;
    authMethods: readonly string[];
    authenticateClient: ClientCheck;
  }>,
): FakeOidcIssuer {
  const { discoveryBase, clientId } = options;
  const signingKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const foreignKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "fake-key-1";
  const endpoints = {
    authorization: `${discoveryBase}/fake-authorize`,
    token: `${discoveryBase}/fake-token`,
    jwks: `${discoveryBase}/fake-jwks`,
  };
  const grants = new Map<string, Readonly<{ challenge: string; redirectUri: string; idToken: string }>>();

  const route: FakeRoute = (url, init) => {
    const address = `${url.origin}${url.pathname}`;
    if (address === `${discoveryBase}/.well-known/openid-configuration`) {
      return jsonResponse({
        status: 200,
        body: {
          issuer: options.advertisedIssuer,
          authorization_endpoint: endpoints.authorization,
          token_endpoint: endpoints.token,
          jwks_uri: endpoints.jwks,
          response_types_supported: ["code"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: options.authMethods,
        },
      });
    }
    if (address === endpoints.jwks) {
      const publicJwk = signingKey.publicKey.export({ format: "jwk" });
      return jsonResponse({ status: 200, body: { keys: [{ ...publicJwk, kid, use: "sig", alg: "RS256" }] } });
    }
    if (address !== endpoints.token) return null;
    const form = new URLSearchParams(init.body ?? "");
    if (!options.authenticateClient({ init, form })) {
      return jsonResponse({ status: 401, body: { error: "invalid_client" } });
    }
    const code = form.get("code") ?? "";
    const grant = grants.get(code);
    grants.delete(code);
    if (grant === undefined || form.get("grant_type") !== "authorization_code") {
      return jsonResponse({ status: 400, body: { error: "invalid_grant" } });
    }
    if (form.get("redirect_uri") !== grant.redirectUri) {
      return jsonResponse({ status: 400, body: { error: "invalid_grant", error_description: "redirect_uri" } });
    }
    if (s256(form.get("code_verifier") ?? "") !== grant.challenge) {
      return jsonResponse({ status: 400, body: { error: "invalid_grant", error_description: "pkce" } });
    }
    return jsonResponse({
      status: 200,
      body: { access_token: "fake-access", token_type: "Bearer", expires_in: 3600, id_token: grant.idToken },
    });
  };

  return {
    route,
    authorize: ({ authorizationUrl, subject, email, emailVerified, tamper }) => {
      const query = new URL(authorizationUrl).searchParams;
      const nowSeconds = Math.floor(options.now().getTime() / 1000);
      const honest: Record<string, unknown> = {
        iss: options.tokenIssuer,
        aud: clientId,
        sub: subject,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
        nonce: query.get("nonce"),
        ...(email === null ? {} : { email, email_verified: emailVerified }),
        ...options.extraClaims,
      };
      const claims = Object.fromEntries(
        Object.entries({ ...honest, ...(tamper.claims ?? {}) }).filter(([, value]) => value !== undefined),
      );
      const code = randomBytes(12).toString("base64url");
      grants.set(code, {
        challenge: query.get("code_challenge") ?? "",
        redirectUri: query.get("redirect_uri") ?? "",
        idToken: mintIdToken({ claims, kid, signing: tamper.signing ?? "valid", signingKey: signingKey.privateKey, foreignKey: foreignKey.privateKey }),
      });
      return { code, state: query.get("state") ?? "" };
    },
  };
}

function textResponse(options: Readonly<{ status: number; text: string }>): HttpFetchResponse {
  return { status: options.status, json: () => Promise.reject(new SyntaxError(`not JSON: ${options.text}`)) };
}

function clientAuthenticated(
  options: Readonly<{ init: HttpFetchInit; form: URLSearchParams; clientId: string; clientSecret: string }>,
): boolean {
  const basic = /^Basic (.+)$/.exec(options.init.headers.authorization ?? "")?.[1];
  if (basic !== undefined) {
    const [id, secret] = Buffer.from(basic, "base64").toString("utf-8").split(":").map(decodeURIComponent);
    return id === options.clientId && secret === options.clientSecret;
  }
  return options.form.get("client_id") === options.clientId && options.form.get("client_secret") === options.clientSecret;
}

/** Apple's own limit on a client secret's lifetime: 15777000 seconds, six months. */
const APPLE_MAX_CLIENT_SECRET_SECONDS = 15_777_000;

function appleClientSecretValid(
  options: Readonly<{ secret: string; clientId: string; teamId: string; keyId: string; publicKey: KeyObject; nowMs: number }>,
): boolean {
  const [encodedHeader, encodedClaims, encodedSignature, extra] = options.secret.split(".");
  if (encodedHeader === undefined || encodedClaims === undefined || encodedSignature === undefined || extra !== undefined) return false;
  const header = decodeSegment(encodedHeader);
  const claims = decodeSegment(encodedClaims);
  if (header === null || claims === null) return false;
  if (header.alg !== "ES256" || header.kid !== options.keyId) return false;
  // A raw 64-byte r||s signature; a DER one (what node:crypto emits by default) is refused.
  const signature = Buffer.from(encodedSignature, "base64url");
  if (signature.length !== 64) return false;
  const signedInput = Buffer.from(`${encodedHeader}.${encodedClaims}`, "utf-8");
  if (!verify("sha256", signedInput, { key: options.publicKey, dsaEncoding: "ieee-p1363" }, signature)) return false;
  const { iss, sub, aud, iat, exp } = claims;
  if (iss !== options.teamId || sub !== options.clientId || aud !== APPLE_ISSUER) return false;
  if (typeof iat !== "number" || typeof exp !== "number") return false;
  return exp * 1000 > options.nowMs && exp - iat <= APPLE_MAX_CLIENT_SECRET_SECONDS;
}

function decodeSegment(segment: string): Readonly<Record<string, unknown>> | null {
  const parsed = parseJson(Buffer.from(segment, "base64url").toString("utf-8"));
  return parsed.kind === "ok" ? asRecord(parsed.value) : null;
}

function mintIdToken(
  options: Readonly<{
    claims: Readonly<Record<string, unknown>>;
    kid: string;
    signing: NonNullable<IdTokenTamper["signing"]>;
    signingKey: KeyObject;
    foreignKey: KeyObject;
  }>,
): string {
  const { claims, kid, signing } = options;
  const alg = signing === "alg-none" ? "none" : signing === "hs256" ? "HS256" : "RS256";
  const input = `${base64url(JSON.stringify({ alg, typ: "JWT", kid }))}.${base64url(JSON.stringify(claims))}`;
  switch (signing) {
    case "valid":
      return `${input}.${sign("RSA-SHA256", Buffer.from(input), options.signingKey).toString("base64url")}`;
    case "foreign-key":
      return `${input}.${sign("RSA-SHA256", Buffer.from(input), options.foreignKey).toString("base64url")}`;
    case "alg-none":
      return `${input}.`;
    case "hs256":
      return `${input}.${createHmac("sha256", "public-key-as-secret").update(input).digest("base64url")}`;
    default:
      return assertNever(signing);
  }
}

function base64url(text: string): string {
  return Buffer.from(text, "utf-8").toString("base64url");
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
