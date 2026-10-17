/**
 * Verifying a Google identity token (an OpenID Connect ID token, RS256): the add-on's
 * `ScriptApp.getIdentityToken()` on the handoff, and the connect flow's `id_token`.
 *
 * WHAT IS CHECKED, and why each (the checks themselves are http/id-token.ts, shared with the
 * portal's sign-in providers): the SIGNATURE against Google's published keys (anyone can mint a
 * token-shaped string); the ISSUER (Google signs other kinds of tokens with the same keys); the
 * EXPIRY (a leaked token must stop working); and the AUDIENCE, which is what makes the token ours:
 * an identity token Google issued to some other application is equally well signed. The add-on's
 * audience is the auto-created Apps Script project's OAuth client, which this team cannot
 * configure, so it is PINNED from one real token decoded in this project (addon-identity.ts).
 * Expiry is checked with no clock leeway.
 *
 * Keys are fetched through the injected `fetch` and cached until Google's `Cache-Control` says
 * they expire; an unknown key id refetches at most once a minute (Google rotates keys, and a
 * token signed by a brand-new key must not be refused for an hour).
 */
import type { KeyObject } from "node:crypto";
import { decodeJsonSegment, signingKeysOf, verifyIdToken, type KeyLookup } from "../http/id-token.ts";

export const GOOGLE_KEYS_ADDRESS = "https://www.googleapis.com/oauth2/v3/certs";
/** Google issues identity tokens under either spelling (OpenID Connect discovery document). */
export const GOOGLE_ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];

export type IdentityClaims = Readonly<{
  subject: string;
  email: string;
  emailVerified: boolean;
  audience: string;
  expiresAt: number;
}>;

export type IdentityVerdict = Readonly<{ kind: "verified"; claims: IdentityClaims }> | Readonly<{ kind: "rejected"; reason: string }>;

export type IdentityVerifier = Readonly<{
  verify(options: Readonly<{ token: string; audience: string }>): Promise<IdentityVerdict>;
}>;

export function createIdentityVerifier(options: Readonly<{ fetch: typeof fetch; now: () => number }>): IdentityVerifier {
  let keys: ReadonlyMap<string, KeyObject> = new Map();
  let keysExpireAt = 0;
  let lastFetchAt = Number.NEGATIVE_INFINITY;
  const refresh = async (): Promise<void> => {
    lastFetchAt = options.now();
    const fetched = await fetchKeys({ fetch: options.fetch, now: options.now });
    if (fetched === null) return;
    keys = fetched.keys;
    keysExpireAt = fetched.expiresAt;
  };
  const keyFor = async (keyId: string | null): Promise<KeyLookup> => {
    if (keyId === null) return { kind: "failed", reason: "not an RS256 token with a key id" };
    if (options.now() >= keysExpireAt) await refresh();
    const known = keys.get(keyId);
    if (known !== undefined) return { kind: "ok", value: known };
    if (options.now() - lastFetchAt >= UNKNOWN_KEY_REFETCH_MILLISECONDS) await refresh();
    const refetched = keys.get(keyId);
    return refetched === undefined ? { kind: "failed", reason: "signed by a key Google does not publish" } : { kind: "ok", value: refetched };
  };
  return {
    verify: async ({ token, audience }) => {
      const verdict = await verifyIdToken({ token, keyFor, issuers: GOOGLE_ISSUERS, audience, nowMs: options.now(), clockSkewMs: 0 });
      if (verdict.kind === "rejected") return verdict;
      const { claims } = verdict;
      return {
        kind: "verified",
        claims: {
          subject: verdict.subject,
          email: typeof claims["email"] === "string" ? claims["email"] : "",
          emailVerified: claims["email_verified"] === true || claims["email_verified"] === "true",
          audience,
          expiresAt: verdict.expiresAtMs,
        },
      };
    },
  };
}

/** The claims of a token WITHOUT verifying it: only for printing what a real token holds (measurement). */
export function unverifiedClaims(token: string): Readonly<Record<string, unknown>> | null {
  const payload = token.split(".")[1];
  return payload === undefined ? null : decodeJsonSegment(payload);
}

const UNKNOWN_KEY_REFETCH_MILLISECONDS = 60_000;
const DEFAULT_KEY_LIFETIME_MILLISECONDS = 60 * 60 * 1000;

async function fetchKeys(options: Readonly<{ fetch: typeof fetch; now: () => number }>): Promise<Readonly<{ keys: ReadonlyMap<string, KeyObject>; expiresAt: number }> | null> {
  let response: Response;
  try {
    response = await options.fetch(GOOGLE_KEYS_ADDRESS, { signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  const keys = new Map<string, KeyObject>();
  for (const { kid, key } of signingKeysOf(body) ?? []) {
    if (kid !== null) keys.set(kid, key);
  }
  const maximumAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1];
  return { keys, expiresAt: options.now() + (maximumAge === undefined ? DEFAULT_KEY_LIFETIME_MILLISECONDS : Number(maximumAge) * 1000) };
}
