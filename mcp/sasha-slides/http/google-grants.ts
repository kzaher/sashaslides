/**
 * A stored Google grant (`GoogleIdentity`, keyed by Google subject in `store.googleIdentities`):
 * the one rule for merging a fresh grant over the stored one, and the one way a stored grant becomes
 * an access token over an injected `fetch`.
 *
 * THE MERGE RULE. Google sends a refresh token only on some consents and never on a refresh, so the
 * stored one is kept when none comes. The scopes are REPLACED by what Google reports, and kept only
 * when Google reported none (an empty list means "Google told us nothing", see `missingGoogleGrant`):
 * every consent this connector starts asks with `include_granted_scopes=true`, so Google's answer
 * already lists everything still granted, and a scope the person revoked must disappear rather than
 * linger as a union would keep it. The access token and its expiry travel as a pair.
 */
import type { GoogleClientCredentials } from "../google-auth";
import { DRIVE_SCOPES, GOOGLE_TOKEN_ENDPOINT, SLIDES_SCOPE } from "../google-constants";
import type { HttpFetch } from "./http-kit";
import { asNumber, asRecord, asString, googleErrorCode } from "./json-values";
import type { GoogleIdentity } from "./oauth-store";

export function mergeGoogleGrant(options: Readonly<{ stored: GoogleIdentity | null; fresh: GoogleIdentity }>): GoogleIdentity {
  const { stored, fresh } = options;
  if (stored === null) return fresh;
  const freshAccess = fresh.accessToken !== null;
  return {
    subject: fresh.subject,
    email: fresh.email ?? stored.email,
    accessToken: freshAccess ? fresh.accessToken : stored.accessToken,
    accessTokenExpiresAtMs: freshAccess ? fresh.accessTokenExpiresAtMs : stored.accessTokenExpiresAtMs,
    refreshToken: fresh.refreshToken ?? stored.refreshToken,
    grantedScopes: fresh.grantedScopes.length > 0 ? fresh.grantedScopes : stored.grantedScopes,
  };
}

/**
 * The scope a Google grant still lacks for the tools to work, or null when it has enough. Shared by
 * the per-call check and the sign-in callback, which refuses a partial grant up front.
 */
export function missingGoogleGrant(options: Readonly<{ grantedScopes: readonly string[] }>): string | null {
  const { grantedScopes } = options;
  // An empty scope list means Google told us nothing, not that nothing was granted; the
  // API call itself will then be the authority.
  if (grantedScopes.length === 0) return null;
  // The same two requirements `google-auth.ts` checks for the stdio token, so the two
  // modes cannot drift on what "sufficiently granted" means.
  if (!grantedScopes.includes(SLIDES_SCOPE)) return SLIDES_SCOPE;
  if (!DRIVE_SCOPES.some((scope) => grantedScopes.includes(scope))) {
    return DRIVE_SCOPES.join(" or ");
  }
  return null;
}

/** A token with less than this left is refreshed first, so it never dies mid-request. */
export const ACCESS_TOKEN_MARGIN_MS = 60_000;

export type GoogleAccessToken =
  | Readonly<{ kind: "ok"; accessToken: string; expiresAtMs: number }>
  /** `status` 401 means the grant is gone (no refresh token, or Google answered `invalid_grant`); 0 means Google was unreachable. */
  | Readonly<{ kind: "failed"; status: number; reason: string }>;

/**
 * A usable access token for a stored grant: its stored one while that has more than a minute left,
 * otherwise a refresh at Google's token endpoint. `forceRefresh` skips the stored token (Google just
 * refused it). Nothing is persisted here; a caller that caches keeps what this returns.
 */
export async function googleAccessToken(
  options: Readonly<{
    grant: Pick<GoogleIdentity, "accessToken" | "accessTokenExpiresAtMs" | "refreshToken">;
    client: GoogleClientCredentials;
    fetch: HttpFetch;
    nowMs: number;
    timeoutMs: number;
    forceRefresh: boolean;
  }>,
): Promise<GoogleAccessToken> {
  const { grant, nowMs } = options;
  const expiresAtMs = grant.accessTokenExpiresAtMs;
  if (!options.forceRefresh && grant.accessToken !== null && expiresAtMs !== null && expiresAtMs - ACCESS_TOKEN_MARGIN_MS > nowMs) {
    return { kind: "ok", accessToken: grant.accessToken, expiresAtMs };
  }
  if (grant.refreshToken === null) return { kind: "failed", status: 401, reason: "the Google grant has expired; sign in to Sasha Slides again" };
  let status: number;
  let body: Readonly<Record<string, unknown>> | null;
  try {
    const response = await options.fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: options.client.clientId,
        client_secret: options.client.clientSecret,
        refresh_token: grant.refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    status = response.status;
    body = asRecord(await response.json().catch(() => null));
  } catch (cause) {
    return { kind: "failed", status: 0, reason: `token refresh cannot reach Google: ${cause instanceof Error ? cause.name : "unknown error"}` };
  }
  const accessToken = asString(body?.access_token);
  const expiresIn = asNumber(body?.expires_in);
  if (status !== 200 || accessToken === null || expiresIn === null) {
    return {
      kind: "failed",
      // `invalid_grant` is Google's answer for a refresh token it no longer honours (revoked, or
      // past the 7 days of a Testing-mode client): the grant is gone, which callers read as 401.
      status: googleErrorCode(body?.error) === "invalid_grant" ? 401 : status,
      reason: `token refresh answered ${String(status)} ${googleErrorCode(body?.error)}; sign in to Sasha Slides again`,
    };
  }
  return { kind: "ok", accessToken, expiresAtMs: nowMs + expiresIn * 1000 };
}
