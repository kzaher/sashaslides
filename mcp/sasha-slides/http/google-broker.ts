/**
 * Our side of the *second* OAuth leg: this server is a Google OAuth **client**, and this
 * is the whole of its contact with Google's authorization server.
 *
 * It is an injected interface for one reason: no Google credentials exist for this project
 * yet, so the entire brokering chain has to be testable against a fake Google
 * (`test/fake-google.ts`). The real implementation needs nothing but the client id/secret
 * from `.auth/google_oauth.json` — never `.auth/tokens.json`, which is one developer's
 * personal grant and is exactly what this work exists to remove from the request path.
 *
 * Latency: Claude's connector budget is 10 s for discovery/registration/token and 30 s for
 * refresh, so every outbound call takes an explicit `timeoutMs` from its caller rather than
 * inheriting whatever gaxios defaults to. A hung Google call becomes a `failed` value, and
 * `authorization-server.ts` turns that into `invalid_grant` / `access_denied`.
 */
import { google } from "googleapis";
import type { GoogleClientCredentials } from "../google-auth";
import type { GoogleIdentity } from "./oauth-store";

export type GoogleBroker = Readonly<{
  /** Where to send the user's browser so Google can authenticate *them*. */
  authorizationUrl(
    options: Readonly<{ brokerState: string; redirectUri: string; scopes: readonly string[] }>,
  ): string;

  /** Step 5 of the chain: Google hands us *that user's* tokens plus their identity. */
  exchangeCode(
    options: Readonly<{ code: string; redirectUri: string; timeoutMs: number }>,
  ): Promise<GoogleCodeExchange>;

  /** Confirms a stored grant is still alive and returns a fresh access token. */
  refresh(options: Readonly<{ refreshToken: string; timeoutMs: number }>): Promise<GoogleRefresh>;
}>;

export type GoogleCodeExchange =
  | Readonly<{ kind: "ok"; identity: GoogleIdentity }>
  | Readonly<{ kind: "failed"; reason: string }>;

/**
 * A refresh carries no `id_token`, so it cannot establish *who* the user is — only that
 * the grant we already attributed to them still works. The subject stays whatever the code
 * exchange recorded, which is what keeps a refresh from ever re-pointing a token at
 * another user.
 */
export type GoogleRefresh =
  | Readonly<{
      kind: "ok";
      accessToken: string | null;
      /** Google omits this unless it rotated; the caller keeps the stored one when null. */
      refreshToken: string | null;
      accessTokenExpiresAtMs: number | null;
      grantedScopes: readonly string[];
    }>
  | Readonly<{ kind: "failed"; reason: string }>;

export function googleBroker(
  options: Readonly<{ credentials: GoogleClientCredentials }>,
): GoogleBroker {
  const { clientId, clientSecret } = options.credentials;
  // A fresh client per call: `setCredentials` mutates, and two users' refreshes must never
  // share one object.
  const clientFor = (redirectUri: string | undefined): InstanceType<typeof google.auth.OAuth2> =>
    new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  return {
    authorizationUrl: ({ brokerState, redirectUri, scopes }) =>
      clientFor(redirectUri).generateAuthUrl({
        // `offline` is what makes Google return a refresh token, which is the only way we
        // can act as this user later without them present.
        access_type: "offline",
        scope: [...scopes],
        state: brokerState,
        redirect_uri: redirectUri,
        include_granted_scopes: true,
        // Without this Google silently omits the refresh token on a repeat consent, and
        // the user's grant would then die at the first access-token expiry.
        prompt: "consent",
      }),

    exchangeCode: async ({ code, redirectUri, timeoutMs }) => {
      const client = clientFor(redirectUri);
      const exchanged = await attempt({
        work: client.getToken({ code, redirect_uri: redirectUri }),
        timeoutMs,
        label: "google token exchange",
      });
      if (exchanged.kind === "failed") return exchanged;
      const credentials = exchanged.value.tokens;
      const idToken = credentials.id_token;
      if (typeof idToken !== "string") {
        return { kind: "failed", reason: "Google returned no id_token; the 'openid' scope is required" };
      }
      const verified = await attempt({
        work: client.verifyIdToken({ idToken, audience: clientId }),
        timeoutMs,
        label: "google id_token verification",
      });
      if (verified.kind === "failed") return verified;
      const payload = verified.value.getPayload();
      if (payload === undefined) {
        return { kind: "failed", reason: "Google's id_token carried no payload" };
      }
      return {
        kind: "ok",
        identity: {
          subject: payload.sub,
          email: payload.email ?? null,
          accessToken: credentials.access_token ?? null,
          refreshToken: credentials.refresh_token ?? null,
          accessTokenExpiresAtMs: credentials.expiry_date ?? null,
          grantedScopes: splitScopes(credentials.scope),
        },
      };
    },

    refresh: async ({ refreshToken, timeoutMs }) => {
      const client = clientFor(undefined);
      client.setCredentials({ refresh_token: refreshToken });
      const refreshed = await attempt({
        work: client.refreshAccessToken(),
        timeoutMs,
        label: "google token refresh",
      });
      if (refreshed.kind === "failed") return refreshed;
      const credentials = refreshed.value.credentials;
      return {
        kind: "ok",
        accessToken: credentials.access_token ?? null,
        refreshToken: credentials.refresh_token ?? null,
        accessTokenExpiresAtMs: credentials.expiry_date ?? null,
        grantedScopes: splitScopes(credentials.scope),
      };
    },
  };
}

type Attempt<TValue> =
  | Readonly<{ kind: "ok"; value: TValue }>
  | Readonly<{ kind: "failed"; reason: string }>;

/**
 * One outbound Google call, bounded. A rejection and a timeout collapse to the same
 * `failed` value because the caller's recovery is identical either way: tell the client the
 * grant did not happen.
 */
async function attempt<TValue>(
  options: Readonly<{ work: Promise<TValue>; timeoutMs: number; label: string }>,
): Promise<Attempt<TValue>> {
  const { work, timeoutMs, label } = options;
  let timer: NodeJS.Timeout | undefined = undefined;
  const expiry = new Promise<Attempt<TValue>>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "failed", reason: `${label} did not answer within ${String(timeoutMs)}ms` }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      work.then((value): Attempt<TValue> => ({ kind: "ok", value })),
      expiry,
    ]);
  } catch (cause) {
    return { kind: "failed", reason: `${label} failed: ${cause instanceof Error ? cause.message : String(cause)}` };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function splitScopes(scope: string | undefined): readonly string[] {
  return typeof scope === "string" ? scope.split(" ").filter((entry) => entry !== "") : [];
}
