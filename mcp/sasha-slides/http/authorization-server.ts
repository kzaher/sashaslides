/**
 * The brokering authorization server: an OAuth 2.1 AS toward Claude, an OAuth *client*
 * toward Google, with the two legs stitched together so that the token Claude ends up
 * holding is bound to one Google identity and no other.
 *
 * The chain, as implemented (the numbers are the ones in the spec summary):
 *
 *   1-2. `http-server.ts` answers an unauthenticated MCP call with 401 +
 *        `WWW-Authenticate: Bearer resource_metadata=...`, and serves
 *        `/.well-known/oauth-protected-resource/mcp` from `oauth-metadata.ts`.
 *   3.   `register` mints a public `client_id` for Claude (DCR, RFC 7591). No secret:
 *        PKCE S256 is the proof of possession.
 *   4.   `authorize` validates `client_id`, `redirect_uri`, `code_challenge` and
 *        `resource`, stores a `PendingAuthorization` under a fresh random `brokerState`,
 *        and redirects the user to **Google** with that state. Claude's own `state` is
 *        carried in our store, never handed to Google.
 *   5.   `googleCallback` consumes the state single-use, exchanges Google's code for
 *        *that user's* access + refresh token, and stores them under the Google `sub`.
 *   6.   It then mints OUR authorization code, bound to {client, redirect_uri,
 *        code_challenge, googleSubject}, and redirects back to Claude.
 *   7.   `token` verifies PKCE against the stored challenge and issues OUR opaque access
 *        and refresh tokens, which carry only a `googleSubject` pointer. `verifyBearer`
 *        resolves them back to that subject, and `user-drive.ts` turns the subject into a
 *        Drive client for that user alone.
 *
 * Against the two attacks the spec's security considerations name:
 *
 *  - **Confused deputy.** `redirect_uri` is matched against the client's registration
 *    (`redirect-uris.ts`) *before* the user is sent anywhere, and an invalid one is a flat
 *    400 rather than a redirect, so this endpoint cannot be used to bounce a code to an
 *    attacker. The authorization code is single-use and bound to the client that asked for
 *    it, so a leaked code is not redeemable elsewhere.
 *  - **Mix-up.** Our `state` toward Google is ours alone, single-use, and carries the
 *    client's identity; a callback whose state we do not hold is rejected outright. Tokens
 *    are looked up only in our own store, so a Google access token (or any other issuer's)
 *    presented as a bearer is simply unknown — "MUST NOT accept or transit tokens other
 *    than ones our own AS issued" is satisfied by construction, not by a check.
 *  - And the invariant underneath both: an `IssuedAccessToken` names exactly one
 *    `googleSubject`, written when the code was minted and never rewritten — not by a
 *    refresh (a Google refresh carries no identity, see `google-broker.ts`), not by a
 *    second authorize.
 */
import { createHash, randomBytes } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { assertNever } from "../google-auth";
import { asRecord, asString, asStringArray } from "./json-values";
import {
  authorizationServerMetadata,
  BROKERED_SCOPES,
  protectedResourceMetadata,
  type AuthorizationServerMetadata,
  type Endpoints,
  type ProtectedResourceMetadata,
} from "./oauth-metadata";
import { CLAUDE_HOSTED_REDIRECT_URI, matchRedirectUri } from "./redirect-uris";
import type { AuthStore, GoogleIdentity, RegisteredClient } from "./oauth-store";
import type { GoogleBroker } from "./google-broker";

export type AuthorizationServer = Readonly<{
  endpoints: Endpoints;
  protectedResourceMetadata: ProtectedResourceMetadata;
  authorizationServerMetadata: AuthorizationServerMetadata;
  /** RFC 7591 dynamic client registration. Body is the already-parsed JSON. */
  register(options: Readonly<{ body: unknown }>): Promise<RegisterOutcome>;
  authorize(options: Readonly<{ parameters: OAuthParameters }>): Promise<AuthorizeOutcome>;
  googleCallback(options: Readonly<{ parameters: OAuthParameters }>): Promise<GoogleCallbackOutcome>;
  token(options: Readonly<{ parameters: OAuthParameters }>): Promise<TokenOutcome>;
  verifyBearer(options: Readonly<{ token: string | null }>): Promise<BearerOutcome>;
}>;

/**
 * A query string or a form body, read by name. `URLSearchParams` satisfies this
 * structurally, which is how `http-server.ts` passes either one without a conversion.
 */
export type OAuthParameters = Readonly<{ get(name: string): string | null }>;

/** The RFC 6749 / 6750 / 8707 codes this server actually emits. */
export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "invalid_scope"
  | "invalid_target"
  | "access_denied"
  | "server_error";

export type RegisterOutcome =
  | Readonly<{ kind: "registered"; response: ClientRegistrationResponse }>
  | Readonly<{ kind: "error"; error: OAuthErrorCode; description: string }>;

export type ClientRegistrationResponse = Readonly<{
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: readonly string[];
  token_endpoint_auth_method: "none";
  grant_types: readonly string[];
  response_types: readonly string[];
  client_name?: string;
}>;

export type AuthorizeOutcome =
  /** Leg two begins: send the user's browser to Google. */
  | Readonly<{ kind: "redirect"; location: string }>
  /**
   * Bad in a way that must NOT be bounced to a `redirect_uri` — an unknown client or an
   * unregistered redirect target. Reporting these by redirect is the confused-deputy hole.
   */
  | Readonly<{ kind: "invalid"; error: OAuthErrorCode; description: string }>;

export type GoogleCallbackOutcome =
  | Readonly<{ kind: "redirect"; location: string }>
  | Readonly<{ kind: "invalid"; error: OAuthErrorCode; description: string }>;

export type TokenOutcome =
  | Readonly<{ kind: "issued"; response: TokenResponse }>
  | Readonly<{ kind: "error"; error: OAuthErrorCode; description: string }>;

export type TokenResponse = Readonly<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}>;

export type BearerOutcome =
  | Readonly<{ kind: "authorized"; authInfo: AuthInfo }>
  /** `missing-token` gets a bare challenge; `invalid_token` gets the RFC 6750 error. */
  | Readonly<{ kind: "unauthorized"; error: "missing-token" | "invalid_token"; description: string }>;

export type AuthorizationServerConfig = Readonly<{
  endpoints: Endpoints;
  resourceName: string;
  accessTokenLifetimeSeconds: number;
  /** Inside Claude's 10 s token/registration budget. */
  googleExchangeTimeoutMs: number;
  /** Inside Claude's 30 s refresh budget. */
  googleRefreshTimeoutMs: number;
  pendingAuthorizationLifetimeMs: number;
  authorizationCodeLifetimeMs: number;
}>;

export function defaultAuthorizationServerConfig(
  options: Readonly<{ endpoints: Endpoints }>,
): AuthorizationServerConfig {
  return {
    endpoints: options.endpoints,
    resourceName: "Sasha Slides",
    accessTokenLifetimeSeconds: 3600,
    // Claude allows 10 s end to end for /token; the Google call is the only slow part of
    // the authorize leg, and it happens in the callback, not in /token.
    googleExchangeTimeoutMs: 8000,
    googleRefreshTimeoutMs: 25000,
    pendingAuthorizationLifetimeMs: 10 * 60 * 1000,
    authorizationCodeLifetimeMs: 60 * 1000,
  };
}

export function createAuthorizationServer(
  options: Readonly<{
    config: AuthorizationServerConfig;
    store: AuthStore;
    google: GoogleBroker;
    now: () => Date;
    /** Opaque, unguessable, URL-safe. Injected so tests get deterministic values. */
    randomToken: () => string;
    warn: (message: string) => void;
  }>,
): AuthorizationServer {
  const { config, store, google, now, randomToken, warn } = options;
  const { endpoints } = config;

  async function clientFor(clientId: string | null): Promise<RegisteredClient | null> {
    if (clientId === null) return null;
    return await store.clients.get({ key: clientId });
  }

  return {
    endpoints,
    protectedResourceMetadata: protectedResourceMetadata({ endpoints, resourceName: config.resourceName }),
    authorizationServerMetadata: authorizationServerMetadata({ endpoints }),

    register: async ({ body }) => {
      const request = parseRegistration(body);
      if (request.kind === "invalid") {
        return { kind: "error", error: "invalid_request", description: request.reason };
      }
      const issuedAtSeconds = Math.floor(now().getTime() / 1000);
      const client: RegisteredClient = {
        clientId: `sasha_${randomToken()}`,
        clientName: request.clientName,
        // Claude's hosted surfaces always come back to the one fixed callback, so it is
        // accepted for every registration even when the client lists only a loopback URI.
        redirectUris: withClaudeHostedRedirect(request.redirectUris),
        tokenEndpointAuthMethod: "none",
        issuedAtSeconds,
      };
      await store.clients.put({ key: client.clientId, value: client });
      return {
        kind: "registered",
        response: {
          client_id: client.clientId,
          client_id_issued_at: issuedAtSeconds,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          ...(client.clientName === null ? {} : { client_name: client.clientName }),
        },
      };
    },

    authorize: async ({ parameters }) => {
      const client = await clientFor(parameters.get("client_id"));
      if (client === null) {
        return { kind: "invalid", error: "invalid_client", description: "unknown client_id" };
      }
      const requestedRedirect = parameters.get("redirect_uri");
      if (requestedRedirect === null) {
        return { kind: "invalid", error: "invalid_request", description: "redirect_uri is required" };
      }
      const matched = matchRedirectUri({ registered: client.redirectUris, requested: requestedRedirect });
      if (matched.kind === "rejected") {
        return { kind: "invalid", error: "invalid_request", description: matched.reason };
      }

      // Past this point the redirect target is trusted, so OAuth says report errors there.
      const clientState = parameters.get("state");
      const failTo = (error: OAuthErrorCode, description: string): AuthorizeOutcome => ({
        kind: "redirect",
        location: redirectWith({
          base: requestedRedirect,
          parameters: { error, error_description: description, state: clientState },
        }),
      });

      if (parameters.get("response_type") !== "code") {
        return failTo("unsupported_response_type", "only response_type=code is supported");
      }
      const codeChallenge = parameters.get("code_challenge");
      const challengeMethod = parameters.get("code_challenge_method");
      if (codeChallenge === null) {
        return failTo("invalid_request", "code_challenge is required: PKCE is mandatory");
      }
      if (challengeMethod !== "S256") {
        return failTo("invalid_request", "code_challenge_method must be S256");
      }
      const resource = parameters.get("resource");
      if (resource !== null && resource !== endpoints.mcpUrl) {
        return failTo("invalid_target", `resource must be exactly ${endpoints.mcpUrl}`);
      }

      const brokerState = randomToken();
      await store.pendingAuthorizations.put({
        key: brokerState,
        value: {
          brokerState,
          clientId: client.clientId,
          clientRedirectUri: requestedRedirect,
          clientState,
          codeChallenge,
          resource,
          scopes: [...BROKERED_SCOPES],
          createdAtMs: now().getTime(),
        },
      });
      return {
        kind: "redirect",
        location: google.authorizationUrl({
          brokerState,
          redirectUri: endpoints.googleCallbackUrl,
          scopes: BROKERED_SCOPES,
        }),
      };
    },

    googleCallback: async ({ parameters }) => {
      const brokerState = parameters.get("state");
      if (brokerState === null) {
        return { kind: "invalid", error: "invalid_request", description: "state is required" };
      }
      // Single use: a replayed callback finds nothing, which is the mix-up defence.
      const pending = await store.pendingAuthorizations.take({ key: brokerState });
      if (pending === null) {
        return {
          kind: "invalid",
          error: "invalid_request",
          description: "unknown or already-used state; start the authorization again",
        };
      }
      if (now().getTime() - pending.createdAtMs > config.pendingAuthorizationLifetimeMs) {
        return { kind: "invalid", error: "invalid_request", description: "the authorization request expired" };
      }

      const bounce = (error: OAuthErrorCode, description: string): GoogleCallbackOutcome => ({
        kind: "redirect",
        location: redirectWith({
          base: pending.clientRedirectUri,
          parameters: { error, error_description: description, state: pending.clientState },
        }),
      });

      const googleError = parameters.get("error");
      if (googleError !== null) return bounce("access_denied", `Google reported: ${googleError}`);
      const googleCode = parameters.get("code");
      if (googleCode === null) return bounce("invalid_request", "Google returned no code");

      const exchanged = await google.exchangeCode({
        code: googleCode,
        redirectUri: endpoints.googleCallbackUrl,
        timeoutMs: config.googleExchangeTimeoutMs,
      });
      if (exchanged.kind === "failed") {
        warn(`google code exchange failed: ${exchanged.reason}`);
        return bounce("access_denied", "Google did not grant access");
      }

      await rememberIdentity({ store, identity: exchanged.identity });

      const code = randomToken();
      await store.authorizationCodes.put({
        key: code,
        value: {
          code,
          clientId: pending.clientId,
          redirectUri: pending.clientRedirectUri,
          codeChallenge: pending.codeChallenge,
          googleSubject: exchanged.identity.subject,
          resource: pending.resource,
          scopes:
            exchanged.identity.grantedScopes.length > 0
              ? exchanged.identity.grantedScopes
              : pending.scopes,
          createdAtMs: now().getTime(),
        },
      });
      return {
        kind: "redirect",
        location: redirectWith({
          base: pending.clientRedirectUri,
          parameters: { code, state: pending.clientState },
        }),
      };
    },

    token: async ({ parameters }) => {
      const grantType = asGrantType(parameters.get("grant_type"));
      if (grantType === null) {
        return {
          kind: "error",
          error: "unsupported_grant_type",
          description: "grant_type must be authorization_code or refresh_token",
        };
      }
      switch (grantType) {
        case "authorization_code":
          return await redeemAuthorizationCode({
            config,
            store,
            now,
            randomToken,
            parameters,
          });
        case "refresh_token":
          return await redeemRefreshToken({
            config,
            store,
            google,
            now,
            randomToken,
            warn,
            parameters,
          });
        default:
          return assertNever(grantType);
      }
    },

    verifyBearer: async ({ token }) => {
      if (token === null || token === "") {
        return { kind: "unauthorized", error: "missing-token", description: "no bearer token" };
      }
      const key = hashToken(token);
      const issued = await store.accessTokens.get({ key });
      if (issued === null) {
        // Includes every token this AS did not mint — a Google access token presented
        // here is simply not in the store.
        return { kind: "unauthorized", error: "invalid_token", description: "unknown access token" };
      }
      if (issued.expiresAtMs <= now().getTime()) {
        await store.accessTokens.remove({ key });
        return { kind: "unauthorized", error: "invalid_token", description: "the access token expired" };
      }
      if (issued.resource !== null && issued.resource !== endpoints.mcpUrl) {
        return {
          kind: "unauthorized",
          error: "invalid_token",
          description: "the access token was issued for a different resource",
        };
      }
      const identity = await store.googleIdentities.get({ key: issued.googleSubject });
      if (identity === null) {
        return {
          kind: "unauthorized",
          error: "invalid_token",
          description: "the Google grant behind this token is gone; sign in again",
        };
      }
      return {
        kind: "authorized",
        authInfo: {
          token,
          clientId: issued.clientId,
          scopes: [...issued.scopes],
          expiresAt: Math.floor(issued.expiresAtMs / 1000),
          resource: new URL(endpoints.mcpUrl),
          // The binding every tool call reads. `user-drive.ts` resolves nothing else.
          extra: { googleSubject: issued.googleSubject },
        },
      };
    },
  };
}

/** The `googleSubject` a verified bearer stands for, or null if the shape is unexpected. */
export function googleSubjectOf(options: Readonly<{ authInfo: AuthInfo | undefined }>): string | null {
  const extra = options.authInfo?.extra;
  if (extra === undefined) return null;
  return asString(extra["googleSubject"]);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 32 bytes, base64url: unguessable, and safe in a query string without escaping. */
export function randomUrlSafeToken(): string {
  return randomBytes(32).toString("base64url");
}

type GrantType = "authorization_code" | "refresh_token";

async function redeemAuthorizationCode(
  options: Readonly<{
    config: AuthorizationServerConfig;
    store: AuthStore;
    now: () => Date;
    randomToken: () => string;
    parameters: OAuthParameters;
  }>,
): Promise<TokenOutcome> {
  const { config, store, now, randomToken, parameters } = options;
  const code = parameters.get("code");
  if (code === null) return { kind: "error", error: "invalid_request", description: "code is required" };
  // Single use: `take`, so a replayed code is indistinguishable from an unknown one.
  const grant = await store.authorizationCodes.take({ key: code });
  if (grant === null) {
    return { kind: "error", error: "invalid_grant", description: "unknown or already-redeemed code" };
  }
  if (now().getTime() - grant.createdAtMs > config.authorizationCodeLifetimeMs) {
    return { kind: "error", error: "invalid_grant", description: "the authorization code expired" };
  }
  const clientId = parameters.get("client_id");
  if (clientId !== grant.clientId) {
    return { kind: "error", error: "invalid_grant", description: "the code was issued to another client" };
  }
  const redirectUri = parameters.get("redirect_uri");
  if (redirectUri !== null && redirectUri !== grant.redirectUri) {
    return {
      kind: "error",
      error: "invalid_grant",
      description: "redirect_uri does not match the authorization request",
    };
  }
  const verifier = parameters.get("code_verifier");
  if (verifier === null) {
    return { kind: "error", error: "invalid_request", description: "code_verifier is required" };
  }
  if (challengeFor(verifier) !== grant.codeChallenge) {
    return { kind: "error", error: "invalid_grant", description: "code_verifier does not match code_challenge" };
  }
  return {
    kind: "issued",
    response: await issueTokens({
      config,
      store,
      now,
      randomToken,
      clientId: grant.clientId,
      googleSubject: grant.googleSubject,
      scopes: grant.scopes,
      resource: grant.resource,
    }),
  };
}

/**
 * Rotates: the presented refresh token is consumed and a new one issued, as OAuth 2.1
 * requires for public clients. A dead token — unknown, already rotated, or backed by a
 * Google grant the user revoked — is `invalid_grant`, never `invalid_request`, because
 * that is the code Claude reads as "re-authorize this user".
 */
async function redeemRefreshToken(
  options: Readonly<{
    config: AuthorizationServerConfig;
    store: AuthStore;
    google: GoogleBroker;
    now: () => Date;
    randomToken: () => string;
    warn: (message: string) => void;
    parameters: OAuthParameters;
  }>,
): Promise<TokenOutcome> {
  const { config, store, google, now, randomToken, warn, parameters } = options;
  const presented = parameters.get("refresh_token");
  if (presented === null) {
    return { kind: "error", error: "invalid_request", description: "refresh_token is required" };
  }
  const issued = await store.refreshTokens.take({ key: hashToken(presented) });
  if (issued === null) {
    return { kind: "error", error: "invalid_grant", description: "unknown or already-used refresh token" };
  }
  const clientId = parameters.get("client_id");
  if (clientId !== null && clientId !== issued.clientId) {
    return { kind: "error", error: "invalid_grant", description: "the refresh token was issued to another client" };
  }
  const identity = await store.googleIdentities.get({ key: issued.googleSubject });
  if (identity === null || identity.refreshToken === null) {
    return { kind: "error", error: "invalid_grant", description: "no Google grant remains for this user" };
  }
  const refreshed = await google.refresh({
    refreshToken: identity.refreshToken,
    timeoutMs: config.googleRefreshTimeoutMs,
  });
  if (refreshed.kind === "failed") {
    warn(`google refresh failed for ${issued.googleSubject}: ${refreshed.reason}`);
    return { kind: "error", error: "invalid_grant", description: "the Google grant is no longer valid" };
  }
  await store.googleIdentities.put({
    key: identity.subject,
    value: {
      ...identity,
      accessToken: refreshed.accessToken,
      // Google omits the refresh token unless it rotated it; keeping the stored one is
      // what makes a long-lived grant survive.
      refreshToken: refreshed.refreshToken ?? identity.refreshToken,
      accessTokenExpiresAtMs: refreshed.accessTokenExpiresAtMs,
      grantedScopes: refreshed.grantedScopes.length > 0 ? refreshed.grantedScopes : identity.grantedScopes,
    },
  });
  return {
    kind: "issued",
    response: await issueTokens({
      config,
      store,
      now,
      randomToken,
      clientId: issued.clientId,
      googleSubject: issued.googleSubject,
      scopes: issued.scopes,
      resource: issued.resource,
    }),
  };
}

async function issueTokens(
  options: Readonly<{
    config: AuthorizationServerConfig;
    store: AuthStore;
    now: () => Date;
    randomToken: () => string;
    clientId: string;
    googleSubject: string;
    scopes: readonly string[];
    resource: string | null;
  }>,
): Promise<TokenResponse> {
  const { config, store, now, randomToken, clientId, googleSubject, scopes, resource } = options;
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const expiresAtMs = now().getTime() + config.accessTokenLifetimeSeconds * 1000;
  // Only the hash is stored, so the store file is not a pile of live bearer credentials.
  await store.accessTokens.put({
    key: hashToken(accessToken),
    value: { clientId, googleSubject, scopes, resource, expiresAtMs },
  });
  await store.refreshTokens.put({
    key: hashToken(refreshToken),
    value: { clientId, googleSubject, scopes, resource },
  });
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: config.accessTokenLifetimeSeconds,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  };
}

/** Merges a fresh Google grant over the stored one, never losing a refresh token. */
async function rememberIdentity(
  options: Readonly<{ store: AuthStore; identity: GoogleIdentity }>,
): Promise<void> {
  const { store, identity } = options;
  const existing = await store.googleIdentities.get({ key: identity.subject });
  await store.googleIdentities.put({
    key: identity.subject,
    value:
      existing === null
        ? identity
        : { ...identity, refreshToken: identity.refreshToken ?? existing.refreshToken },
  });
}

/** PKCE S256: `BASE64URL(SHA256(ASCII(verifier)))`, RFC 7636 section 4.6. */
function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function withClaudeHostedRedirect(redirectUris: readonly string[]): readonly string[] {
  return redirectUris.includes(CLAUDE_HOSTED_REDIRECT_URI)
    ? redirectUris
    : [...redirectUris, CLAUDE_HOSTED_REDIRECT_URI];
}

/**
 * Appends OAuth response parameters to a redirect target, preserving any query the client
 * registered. Null values are omitted, which is how an absent `state` stays absent.
 */
function redirectWith(
  options: Readonly<{ base: string; parameters: Readonly<Record<string, string | null>> }>,
): string {
  const url = new URL(options.base);
  for (const [name, value] of Object.entries(options.parameters)) {
    if (value !== null) url.searchParams.append(name, value);
  }
  return url.toString();
}

type ParsedRegistration =
  | Readonly<{ kind: "ok"; redirectUris: readonly string[]; clientName: string | null }>
  | Readonly<{ kind: "invalid"; reason: string }>;

/**
 * Parse boundary for the DCR body. Not an exhaustive switch anywhere: the input is
 * arbitrary JSON, so it has no `never` position.
 */
function parseRegistration(body: unknown): ParsedRegistration {
  const record = asRecord(body);
  if (record === null) return { kind: "invalid", reason: "the registration body must be a JSON object" };
  const redirectUris = asStringArray(record["redirect_uris"]);
  if (redirectUris === null || redirectUris.length === 0) {
    return { kind: "invalid", reason: "redirect_uris must be a non-empty array of strings" };
  }
  for (const candidate of redirectUris) {
    try {
      new URL(candidate);
    } catch {
      return { kind: "invalid", reason: `redirect_uris contains a non-absolute URI: ${candidate}` };
    }
  }
  const authMethod = record["token_endpoint_auth_method"];
  if (authMethod !== undefined && authMethod !== "none") {
    return {
      kind: "invalid",
      reason: 'token_endpoint_auth_method must be "none": clients are public and authenticate with PKCE',
    };
  }
  const grantTypes = record["grant_types"];
  if (grantTypes !== undefined) {
    const requested = asStringArray(grantTypes);
    if (requested === null || requested.some((grant) => asGrantType(grant) === null)) {
      return {
        kind: "invalid",
        reason: "grant_types may only contain authorization_code and refresh_token",
      };
    }
  }
  return { kind: "ok", redirectUris, clientName: asString(record["client_name"]) };
}

/** Parse-boundary guard over a wire string, so it is a comparison chain, not a switch. */
function asGrantType(value: string | null): GrantType | null {
  switch (value) {
    case "authorization_code":
    case "refresh_token":
      return value;
    default:
      return null;
  }
}
