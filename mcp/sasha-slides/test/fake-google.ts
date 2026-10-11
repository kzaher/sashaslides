/**
 * A fake Google authorization server, so the whole brokering chain is testable with no
 * Google credentials — which is the situation this project is actually in.
 *
 * It implements the three things `GoogleBroker` promises and nothing else: hand out an
 * authorize URL, turn a code into one user's identity + tokens, and refresh (or refuse to
 * refresh) a grant. `stageConsent` stands in for the user actually consenting, and
 * `revoke` for them removing the app in their Google account settings — the only way a
 * refresh token dies in production, and the case that must surface as `invalid_grant`.
 */
import { BROKERED_SCOPES } from "../http/oauth-metadata";
import type { GoogleBroker } from "../http/google-broker";
import type { GoogleIdentity } from "../http/oauth-store";

export type FakeGoogle = Readonly<{
  broker: GoogleBroker;
  /** The identity Google will return for `code`, as a completed consent screen would. */
  stageConsent(options: Readonly<{ code: string; identity: GoogleIdentity }>): void;
  /** The user removed the app: every later refresh of this token fails. */
  revoke(options: Readonly<{ refreshToken: string }>): void;
  /** Makes the next refresh hang past its deadline, to exercise the latency budget. */
  stall(options: Readonly<{ refreshToken: string }>): void;
  authorizationUrls(): readonly string[];
  exchangedCodes(): readonly string[];
  refreshedTokens(): readonly string[];
}>;

export const FAKE_GOOGLE_AUTHORIZE_URL = "https://accounts.google.test/o/oauth2/v2/auth";

export function createFakeGoogle(): FakeGoogle {
  const consents = new Map<string, GoogleIdentity>();
  const revoked = new Set<string>();
  const stalled = new Set<string>();
  const authorizationUrls: string[] = [];
  const exchangedCodes: string[] = [];
  const refreshedTokens: string[] = [];
  let refreshCount = 0;

  const broker: GoogleBroker = {
    authorizationUrl: ({ brokerState, redirectUri, scopes }) => {
      const url = new URL(FAKE_GOOGLE_AUTHORIZE_URL);
      url.searchParams.set("state", brokerState);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("access_type", "offline");
      const built = url.toString();
      authorizationUrls.push(built);
      return built;
    },

    exchangeCode: ({ code }) => {
      exchangedCodes.push(code);
      const identity = consents.get(code);
      if (identity === undefined) {
        return Promise.resolve({ kind: "failed", reason: `no staged consent for code ${code}` });
      }
      // Google's codes are single use, and so are the fake's.
      consents.delete(code);
      return Promise.resolve({ kind: "ok", identity });
    },

    refresh: ({ refreshToken, timeoutMs }) => {
      refreshedTokens.push(refreshToken);
      if (revoked.has(refreshToken)) {
        return Promise.resolve({ kind: "failed", reason: "the user revoked this grant" });
      }
      if (stalled.has(refreshToken)) {
        return Promise.resolve({
          kind: "failed",
          reason: `google token refresh did not answer within ${String(timeoutMs)}ms`,
        });
      }
      refreshCount += 1;
      return Promise.resolve({
        kind: "ok",
        accessToken: `fake-access-${String(refreshCount)}`,
        // Google omits the refresh token unless it rotated it.
        refreshToken: null,
        accessTokenExpiresAtMs: Date.now() + 3600_000,
        grantedScopes: [...BROKERED_SCOPES],
      });
    },
  };

  return {
    broker,
    stageConsent: ({ code, identity }) => void consents.set(code, identity),
    revoke: ({ refreshToken }) => void revoked.add(refreshToken),
    stall: ({ refreshToken }) => void stalled.add(refreshToken),
    authorizationUrls: () => [...authorizationUrls],
    exchangedCodes: () => [...exchangedCodes],
    refreshedTokens: () => [...refreshedTokens],
  };
}

/** A consenting user, with every scope the server asks Google for. */
export function fakeGoogleIdentity(
  options: Readonly<{ subject: string; email: string; refreshToken: string }>,
): GoogleIdentity {
  return {
    subject: options.subject,
    email: options.email,
    accessToken: `fake-access-for-${options.subject}`,
    refreshToken: options.refreshToken,
    accessTokenExpiresAtMs: Date.now() + 3600_000,
    grantedScopes: [...BROKERED_SCOPES],
  };
}
