/**
 * Turning a verified bearer token's `googleSubject` into a Drive client for **that user**.
 *
 * This is the seam the whole restructure hangs on, and it is the one `drive-channel.ts`
 * already provided: `proposal.ts` only ever sees an injected `DriveChannel`, so swapping
 * "the server's single OAuth2Client" for "a client built from this caller's stored Google
 * refresh token" changes nothing below this file. `proposal.ts` and the Drive protocol are
 * untouched by this work.
 *
 * The factory is an interface so a test can hand out a *different* in-memory Drive per
 * subject; that is what makes "a token issued for user A cannot reach user B's Drive" an
 * assertion about staged files rather than about a code comment.
 */
import { google } from "googleapis";
import type { Credentials, OAuth2Client } from "google-auth-library";
import { googleDriveChannel, type DriveChannel } from "../drive-channel";
import { googleFeedbackChannel, type FeedbackChannel } from "../feedback/feedback-channel";
import { DRIVE_SCOPES, SLIDES_SCOPE, type GoogleClientCredentials } from "../google-auth";
import type { AuthStore, GoogleIdentity } from "./oauth-store";

export type UserDriveFactory = Readonly<{
  forGoogleSubject(options: Readonly<{ subject: string }>): Promise<UserDriveResolution>;
  /**
   * The same user's comment channel, from the same stored grant.
   *
   * It is a second method rather than another field on `UserDriveResolution` so a test can
   * hand out an in-memory Drive without also having to fake a whole FeedbackChannel, and so
   * a factory that genuinely cannot serve comments can say so per call.
   */
  feedbackForGoogleSubject(options: Readonly<{ subject: string }>): Promise<UserFeedbackResolution>;
}>;

export type UserDriveResolution =
  | Readonly<{ kind: "ok"; drive: DriveChannel }>
  | Readonly<{ kind: "unavailable"; message: string }>;

export type UserFeedbackResolution =
  | Readonly<{ kind: "ok"; feedback: FeedbackChannel }>
  | Readonly<{ kind: "unavailable"; message: string }>;

type AuthResolution =
  | Readonly<{ kind: "ok"; auth: OAuth2Client }>
  | Readonly<{ kind: "unavailable"; message: string }>;

export function googleUserDriveFactory(
  options: Readonly<{
    store: AuthStore;
    credentials: GoogleClientCredentials;
    warn: (message: string) => void;
  }>,
): UserDriveFactory {
  const { store, credentials, warn } = options;

  /**
   * One place that turns a stored grant into an authenticated client, so the Drive and the
   * comment channel can never disagree about what "signed in" means.
   */
  const authFor = async (subject: string): Promise<AuthResolution> => {
    const identity = await store.googleIdentities.get({ key: subject });
    if (identity === null) {
      return { kind: "unavailable", message: "no Google grant is stored for this user; sign in again" };
    }
    const missing = missingScopes(identity);
    if (missing !== null) {
      return {
        kind: "unavailable",
        message: `the Google grant for this user is missing a required scope: ${missing}`,
      };
    }
    if (identity.refreshToken === null && identity.accessToken === null) {
      return { kind: "unavailable", message: "the stored Google grant carries no usable token" };
    }

    const auth = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
    auth.setCredentials(asCredentials(identity));
    // googleapis refreshes on demand and emits the new credentials; persisting them keeps
    // the next request from paying for another refresh, and keeps a rotated Google
    // refresh token from being lost.
    auth.on("tokens", (tokens: Credentials) => {
      void store.googleIdentities
        .put({ key: subject, value: mergeCredentials({ identity, tokens }) })
        .catch((cause: unknown) => {
          warn(`could not persist refreshed Google tokens for ${subject}: ${String(cause)}`);
        });
    });
    return { kind: "ok", auth };
  };

  return {
    forGoogleSubject: async ({ subject }) => {
      const resolved = await authFor(subject);
      return resolved.kind === "ok"
        ? { kind: "ok", drive: googleDriveChannel({ auth: resolved.auth }) }
        : resolved;
    },
    feedbackForGoogleSubject: async ({ subject }) => {
      const resolved = await authFor(subject);
      return resolved.kind === "ok"
        ? { kind: "ok", feedback: googleFeedbackChannel({ auth: resolved.auth }) }
        : resolved;
    },
  };
}

function missingScopes(identity: GoogleIdentity): string | null {
  // An empty scope list means Google told us nothing, not that nothing was granted; the
  // API call itself will then be the authority.
  if (identity.grantedScopes.length === 0) return null;
  // The same two requirements `google-auth.ts` checks for the stdio token, so the two
  // modes cannot drift on what "sufficiently granted" means.
  if (!identity.grantedScopes.includes(SLIDES_SCOPE)) return SLIDES_SCOPE;
  if (!DRIVE_SCOPES.some((scope) => identity.grantedScopes.includes(scope))) {
    return DRIVE_SCOPES.join(" or ");
  }
  return null;
}

function asCredentials(identity: GoogleIdentity): Credentials {
  return {
    ...(identity.accessToken === null ? {} : { access_token: identity.accessToken }),
    ...(identity.refreshToken === null ? {} : { refresh_token: identity.refreshToken }),
    ...(identity.accessTokenExpiresAtMs === null ? {} : { expiry_date: identity.accessTokenExpiresAtMs }),
    scope: identity.grantedScopes.join(" "),
  };
}

function mergeCredentials(
  options: Readonly<{ identity: GoogleIdentity; tokens: Credentials }>,
): GoogleIdentity {
  const { identity, tokens } = options;
  return {
    ...identity,
    accessToken: tokens.access_token ?? identity.accessToken,
    refreshToken: tokens.refresh_token ?? identity.refreshToken,
    accessTokenExpiresAtMs: tokens.expiry_date ?? identity.accessTokenExpiresAtMs,
  };
}
