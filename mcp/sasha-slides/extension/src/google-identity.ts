// How the extension gets a Google bearer token -- and the one decision in this whole component
// that cannot be undone later, so it is argued here in full.
//
// THE CONSTRAINT. The protocol runs under the non-sensitive `drive.file` scope, whose grant is
// per-FILE and per-APP: "an app sees the files it created". Drive identifies "the app" by the
// OAuth 2.0 client id that minted the token. The MCP server creates the proposal folder, the
// HTML, manifest.json and READY. If this extension authenticated as a DIFFERENT client id, it
// would be a different app, hold no drive.file grant on any of those files, and `files.list` would
// return an empty set forever -- with no error to diagnose, which is the worst possible failure.
//
// WHY `chrome.identity.getAuthToken` IS THEREFORE UNUSABLE. getAuthToken only accepts a client id
// of the Chrome-Extension application type, registered against this extension's own id/key. It is
// by construction a second client id, i.e. a second Drive app. It is also Chrome-only. So the
// convenient API is exactly the one the scope model forbids.
//
// THE CONCLUSION, which the credentials must be created to match: the extension and the MCP server
// SHARE ONE OAuth client id, of the **Web application** type, and the extension obtains its token
// with `chrome.identity.launchWebAuthFlow`. That client carries two redirect URIs:
//   http://localhost:8080                       <- .auth/generate-token.ts (the server's leg)
//   https://<extension-id>.chromiumapp.org/     <- chrome.identity.getRedirectURL() (this leg)
// Both legs then hold a drive.file grant on the same files because they are the same app.
//
// WHY THE IMPLICIT FLOW (`response_type=token`). An extension cannot keep a client_secret, and
// Google still requires one from a Web-application client at the code-exchange endpoint even with
// PKCE. `response_type=token` returns the access token in the redirect fragment with no secret and
// no refresh token -- a one-hour token, renewed silently by re-running the flow with
// `prompt=none` and `interactive:false`, which is the normal pattern for this situation. The user
// has an active Google session in the browser (they are sitting in Google Slides), so the silent
// renewal has everything it needs. UNVERIFIED without credentials: Google documents the
// client-side implicit flow but marks it discouraged, and may refuse it for a newly created Web
// client. If it is refused, the two fallbacks in order are (a) ship the Web client's secret inside
// the extension and use PKCE + code exchange -- not a secret in this threat model, since the user
// runs both halves on their own machine -- or (b) have the user grant the restricted full `drive`
// scope, which makes the app-identity question moot at the cost of app verification plus a
// security assessment.

import type { AccessTokenSource } from "./drive-api.ts";
import type { Parsed } from "./protocol.ts";

/** Non-sensitive: an app sees only the files it created. See the header for what that implies. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** Needed to batchUpdate the open presentation when the user picks a slide. */
export const SLIDES_SCOPE = "https://www.googleapis.com/auth/presentations";
export const REQUIRED_SCOPES = [DRIVE_FILE_SCOPE, SLIDES_SCOPE] as const;

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
/** Renew this long before the stated expiry, so a request never races the boundary. */
const RENEW_MARGIN_MS = 120_000;

export type WebAuthFlow = Readonly<{
  /** `chrome.identity.launchWebAuthFlow`, injected so the token source is testable. */
  launch(spec: Readonly<{ url: string; interactive: boolean }>): Promise<Parsed<string>>;
  redirectUri(): string;
}>;

export type Clock = Readonly<{ nowMs(): number }>;

/**
 * A token source that caches one access token in memory for as long as it is valid. Nothing is
 * persisted: a token is a one-hour bearer credential and `chrome.storage.local` is readable by
 * anything that can read the profile, while a silent re-auth costs one round trip.
 */
export function webAuthFlowTokenSource({
  clientId,
  flow,
  clock,
}: {
  clientId: string;
  flow: WebAuthFlow;
  clock: Clock;
}): AccessTokenSource {
  let cached: Readonly<{ token: string; expiresAtMs: number }> | null = null;

  return {
    async token({ interactive, forceRefresh }) {
      if (clientId === "") {
        return {
          kind: "invalid",
          reason:
            "no OAuth client id configured. Paste the SAME client id the MCP server uses into " +
            "chrome.storage.local key 'oauthClientId' (see src/google-identity.ts for why it must be the same one).",
        };
      }
      const live = cached;
      if (!forceRefresh && live !== null && live.expiresAtMs - RENEW_MARGIN_MS > clock.nowMs()) {
        return { kind: "ok", value: live.token };
      }
      cached = null;
      const launched = await flow.launch({
        url: authorizationUrl({ clientId, redirectUri: flow.redirectUri(), interactive }),
        interactive,
      });
      if (launched.kind !== "ok") return launched;
      const granted = parseRedirectFragment(launched.value);
      if (granted.kind !== "ok") return granted;
      cached = { token: granted.value.accessToken, expiresAtMs: clock.nowMs() + granted.value.expiresInMs };
      return { kind: "ok", value: granted.value.accessToken };
    },
  };
}

export function authorizationUrl({
  clientId,
  redirectUri,
  interactive,
}: {
  clientId: string;
  redirectUri: string;
  interactive: boolean;
}): string {
  const parameters = new URLSearchParams({
    client_id: clientId,
    response_type: "token",
    redirect_uri: redirectUri,
    scope: REQUIRED_SCOPES.join(" "),
    // Keeps whatever the user already granted this client (the server's leg may have asked for
    // more), so a renewal never silently narrows the grant.
    include_granted_scopes: "true",
    // `prompt=none` is what makes a non-interactive renewal fail fast instead of hanging on a
    // consent screen nobody can see.
    prompt: interactive ? "consent" : "none",
  });
  return `${AUTH_ENDPOINT}?${parameters.toString()}`;
}

export function parseRedirectFragment(
  redirectUrl: string,
): Parsed<Readonly<{ accessToken: string; expiresInMs: number }>> {
  const hashAt = redirectUrl.indexOf("#");
  if (hashAt < 0) {
    const errorInQuery = new URL(redirectUrl).searchParams.get("error");
    return { kind: "invalid", reason: errorInQuery ?? "the OAuth redirect carried no fragment" };
  }
  const fragment = new URLSearchParams(redirectUrl.slice(hashAt + 1));
  const error = fragment.get("error");
  if (error !== null) return { kind: "invalid", reason: error };
  const accessToken = fragment.get("access_token");
  if (accessToken === null || accessToken === "") {
    return { kind: "invalid", reason: "the OAuth redirect carried no access_token" };
  }
  const expiresIn = Number(fragment.get("expires_in") ?? "3600");
  const expiresInMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3_600_000;
  return { kind: "ok", value: { accessToken, expiresInMs } };
}

/** The real flow. Only an extension page may call this, which is why it lives in the offscreen document. */
export function chromeWebAuthFlow(): WebAuthFlow {
  return {
    async launch({ url, interactive }) {
      try {
        const redirectUrl = await chrome.identity.launchWebAuthFlow({ url, interactive });
        if (typeof redirectUrl !== "string" || redirectUrl === "") {
          return { kind: "invalid", reason: chrome.runtime.lastError?.message ?? "the auth flow was closed" };
        }
        return { kind: "ok", value: redirectUrl };
      } catch (cause) {
        return { kind: "invalid", reason: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    redirectUri() {
      return chrome.identity.getRedirectURL();
    },
  };
}

export const systemClock: Clock = { nowMs: () => Date.now() };
