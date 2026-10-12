/**
 * Fake sign-in providers for the account portal tests: an OpenID Connect issuer that signs
 * real RS256 ID tokens and serves discovery and JWKS, and a fake GitHub. Both answer through
 * one injected `fetch`, so nothing leaves the process.
 *
 * The browser leg is simulated by `authorize`: it reads the authorization URL the code under
 * test produced, remembers its PKCE challenge, nonce and redirect URI, and returns the
 * callback parameters a real provider would redirect with. The token endpoint then refuses a
 * verifier that does not match, so a round trip proves PKCE instead of assuming it.
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { assertNever } from "../google-auth";
import type { HttpFetch, HttpFetchInit, HttpFetchResponse } from "../http/identity-providers";
import { GITHUB_AUTHORIZE_URL, GITHUB_EMAILS_URL, GITHUB_TOKEN_URL, GITHUB_USER_URL } from "../http/identity-providers";

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

export type FakeOidcIssuer = Readonly<{
  route: FakeRoute;
  authorize(
    options: Readonly<{
      authorizationUrl: string;
      subject: string;
      email: string | null;
      emailVerified: boolean;
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
    /** Claims every honest token carries in addition, e.g. Microsoft's `tid`. */
    extraClaims: Readonly<Record<string, unknown>>;
  }>,
): FakeOidcIssuer {
  const { discoveryBase, clientId, clientSecret } = options;
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
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
        },
      });
    }
    if (address === endpoints.jwks) {
      const publicJwk = signingKey.publicKey.export({ format: "jwk" });
      return jsonResponse({ status: 200, body: { keys: [{ ...publicJwk, kid, use: "sig", alg: "RS256" }] } });
    }
    if (address !== endpoints.token) return null;
    const form = new URLSearchParams(init.body ?? "");
    if (!clientAuthenticated({ init, form, clientId, clientSecret })) {
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

export function jsonResponse(options: Readonly<{ status: number; body: unknown }>): HttpFetchResponse {
  return { status: options.status, json: () => Promise.resolve(options.body) };
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
