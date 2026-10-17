/**
 * The Google OAuth calls the Slides interchange makes: the connect consent address, the code
 * exchange on the shared callback, and a stored grant's access token (refreshed by
 * http/google-grants.ts, the one implementation).
 *
 * WHY OVER THE INJECTED `fetch` rather than http/google-broker.ts's `googleapis` client: the
 * interchange's only network dependency is the `fetch` it is given (deck-service-contract.ts), so
 * the route tests can play Google's token endpoint and keys with a table of fake answers. The
 * wire format is three form posts, small enough to own.
 *
 * SCOPES: `presentations` (read and write the decks) and `drive.file` (create new presentations
 * and read the ones the person opens with us) per SPEC.md 21.12, plus `openid` and `email`, without
 * which Google returns no identity token and the grant could not be filed under its Google
 * subject. `include_granted_scopes` keeps whatever the person granted the connector before.
 */
import type { GoogleClientCredentials } from "../google-auth";
import { DRIVE_FILE_SCOPE, GOOGLE_CONSENT_ENDPOINT, GOOGLE_TOKEN_ENDPOINT, SLIDES_SCOPE } from "../google-constants.ts";
import { googleAccessToken } from "../http/google-grants.ts";
import type { GoogleIdentity } from "../http/oauth-store";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

export const GOOGLE_SLIDES_CONNECT_SCOPES: readonly string[] = ["openid", "email", SLIDES_SCOPE, DRIVE_FILE_SCOPE];

export function googleConsentAddress(
  options: Readonly<{ client: GoogleClientCredentials; redirectAddress: string; state: string; scopes: readonly string[] }>,
): string {
  const query = new URLSearchParams({
    client_id: options.client.clientId,
    redirect_uri: options.redirectAddress,
    response_type: "code",
    scope: options.scopes.join(" "),
    state: options.state,
    // offline: a refresh token, so an export can run long after the consent.
    access_type: "offline",
    include_granted_scopes: "true",
    // Without it Google omits the refresh token on a repeat consent (http/google-broker.ts).
    prompt: "consent",
  });
  return `${GOOGLE_CONSENT_ENDPOINT}?${query.toString()}`;
}

export type GoogleTokenAnswer =
  | Readonly<{
      kind: "ok";
      accessToken: string;
      refreshToken: string | null;
      expiresAt: number;
      grantedScopes: readonly string[];
      identityToken: string | null;
    }>
  | Readonly<{ kind: "failed"; message: string }>;

export function exchangeAuthorizationCode(
  options: Readonly<{ fetch: typeof fetch; client: GoogleClientCredentials; code: string; redirectAddress: string; now: () => number }>,
): Promise<GoogleTokenAnswer> {
  return postTokenForm({
    fetch: options.fetch,
    now: options.now,
    form: {
      grant_type: "authorization_code",
      code: options.code,
      redirect_uri: options.redirectAddress,
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
    },
  });
}

export type AccessTokenOutcome =
  | Readonly<{ kind: "ok"; accessToken: string }>
  /** The grant lacks the Slides scope, has no usable token, or Google refused the refresh. */
  | Readonly<{ kind: "notConnected"; message: string }>;

/**
 * A usable access token for a stored grant (http/google-grants.ts: the stored one while it has a
 * minute left, otherwise a refresh). A grant without the Slides scope is "not connected": the
 * connect flow asks for it.
 */
export async function accessTokenForIdentity(
  options: Readonly<{ fetch: typeof fetch; client: GoogleClientCredentials; identity: GoogleIdentity; now: () => number }>,
): Promise<AccessTokenOutcome> {
  const { identity } = options;
  if (!identity.grantedScopes.includes(SLIDES_SCOPE)) {
    return { kind: "notConnected", message: "The Google grant does not include Google Slides." };
  }
  const token = await googleAccessToken({
    grant: identity,
    client: options.client,
    fetch: options.fetch,
    nowMs: options.now(),
    timeoutMs: TOKEN_CALL_TIMEOUT_MILLISECONDS,
    forceRefresh: false,
  });
  switch (token.kind) {
    case "ok":
      return { kind: "ok", accessToken: token.accessToken };
    case "failed":
      return { kind: "notConnected", message: `Google refused to refresh the grant: ${token.reason}` };
    default:
      return assertNever(token);
  }
}

const TOKEN_CALL_TIMEOUT_MILLISECONDS = 15_000;

async function postTokenForm(
  options: Readonly<{ fetch: typeof fetch; form: Readonly<Record<string, string>>; now: () => number }>,
): Promise<GoogleTokenAnswer> {
  let response: Response;
  try {
    response = await options.fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(options.form).toString(),
      signal: AbortSignal.timeout(TOKEN_CALL_TIMEOUT_MILLISECONDS),
    });
  } catch (cause) {
    return { kind: "failed", message: cause instanceof Error ? cause.message : String(cause) };
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok || typeof parsed !== "object" || parsed === null) {
    return { kind: "failed", message: `HTTP ${response.status}: ${text.slice(0, 200)}` };
  }
  const accessToken = "access_token" in parsed ? parsed.access_token : undefined;
  if (typeof accessToken !== "string") return { kind: "failed", message: "Google's token answer carried no access token." };
  const refreshToken = "refresh_token" in parsed && typeof parsed.refresh_token === "string" ? parsed.refresh_token : null;
  const expiresIn = "expires_in" in parsed && typeof parsed.expires_in === "number" ? parsed.expires_in : 3600;
  const scope = "scope" in parsed && typeof parsed.scope === "string" ? parsed.scope : "";
  const identityToken = "id_token" in parsed && typeof parsed.id_token === "string" ? parsed.id_token : null;
  return {
    kind: "ok",
    accessToken,
    refreshToken,
    expiresAt: options.now() + expiresIn * 1000,
    grantedScopes: scope.split(" ").filter((part) => part.length > 0),
    identityToken,
  };
}
