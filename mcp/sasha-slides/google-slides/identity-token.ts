/**
 * Verifying a Google identity token (an OpenID Connect ID token, RS256): the add-on's
 * `ScriptApp.getIdentityToken()` on the handoff, and the connect flow's `id_token`.
 *
 * WHAT IS CHECKED, and why each: the SIGNATURE against Google's published keys (anyone can mint a
 * token-shaped string); the ISSUER (Google signs other kinds of tokens with the same keys); the
 * EXPIRY (a leaked token must stop working); and the AUDIENCE, which is what makes the token ours:
 * an identity token Google issued to some other application is equally well signed. The add-on's
 * audience is the auto-created Apps Script project's OAuth client, which this team cannot
 * configure, so it is PINNED from one real token decoded in this project (addon-identity.ts).
 *
 * Keys are fetched through the injected `fetch` and cached until Google's `Cache-Control` says
 * they expire; an unknown key id refetches at most once a minute (Google rotates keys, and a
 * token signed by a brand-new key must not be refused for an hour).
 */
import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

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
  let keys: ReadonlyMap<string, JsonWebKey> = new Map();
  let keysExpireAt = 0;
  let lastFetchAt = Number.NEGATIVE_INFINITY;
  const refresh = async (): Promise<void> => {
    lastFetchAt = options.now();
    const fetched = await fetchKeys({ fetch: options.fetch, now: options.now });
    if (fetched === null) return;
    keys = fetched.keys;
    keysExpireAt = fetched.expiresAt;
  };
  const keyFor = async (keyId: string): Promise<JsonWebKey | null> => {
    if (options.now() >= keysExpireAt) await refresh();
    const known = keys.get(keyId);
    if (known !== undefined) return known;
    if (options.now() - lastFetchAt < UNKNOWN_KEY_REFETCH_MILLISECONDS) return null;
    await refresh();
    return keys.get(keyId) ?? null;
  };
  return {
    verify: async ({ token, audience }) => {
      const parts = token.split(".");
      const [encodedHeader, encodedPayload, encodedSignature] = parts;
      if (parts.length !== 3 || encodedHeader === undefined || encodedPayload === undefined || encodedSignature === undefined) {
        return { kind: "rejected", reason: "not a JSON web token" };
      }
      const header = decodeTokenPart(encodedHeader);
      const payload = decodeTokenPart(encodedPayload);
      if (header === null || payload === null) return { kind: "rejected", reason: "the token does not decode" };
      if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") return { kind: "rejected", reason: "not an RS256 token with a key id" };
      const key = await keyFor(header["kid"]);
      if (key === null) return { kind: "rejected", reason: "signed by a key Google does not publish" };
      const signed = verify("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), createPublicKey({ key, format: "jwk" }), Buffer.from(encodedSignature, "base64url"));
      if (!signed) return { kind: "rejected", reason: "bad signature" };
      if (typeof payload["iss"] !== "string" || !GOOGLE_ISSUERS.includes(payload["iss"])) return { kind: "rejected", reason: "wrong issuer" };
      const expiresAt = typeof payload["exp"] === "number" ? payload["exp"] * 1000 : 0;
      if (expiresAt <= options.now()) return { kind: "rejected", reason: "expired" };
      const audiences = Array.isArray(payload["aud"]) ? payload["aud"] : [payload["aud"]];
      if (!audiences.includes(audience)) return { kind: "rejected", reason: "wrong audience" };
      const subject = payload["sub"];
      if (typeof subject !== "string" || subject.length === 0) return { kind: "rejected", reason: "no subject" };
      return {
        kind: "verified",
        claims: {
          subject,
          email: typeof payload["email"] === "string" ? payload["email"] : "",
          emailVerified: payload["email_verified"] === true || payload["email_verified"] === "true",
          audience,
          expiresAt,
        },
      };
    },
  };
}

/** The claims of a token WITHOUT verifying it: only for printing what a real token holds (measurement). */
export function unverifiedClaims(token: string): Readonly<Record<string, unknown>> | null {
  const payload = token.split(".")[1];
  return payload === undefined ? null : decodeTokenPart(payload);
}

const UNKNOWN_KEY_REFETCH_MILLISECONDS = 60_000;
const DEFAULT_KEY_LIFETIME_MILLISECONDS = 60 * 60 * 1000;

async function fetchKeys(options: Readonly<{ fetch: typeof fetch; now: () => number }>): Promise<Readonly<{ keys: ReadonlyMap<string, JsonWebKey>; expiresAt: number }> | null> {
  let response: Response;
  try {
    response = await options.fetch(GOOGLE_KEYS_ADDRESS, { signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  const list = typeof body === "object" && body !== null && "keys" in body && Array.isArray(body.keys) ? body.keys : [];
  const keys = new Map<string, JsonWebKey>();
  for (const candidate of list) {
    if (typeof candidate !== "object" || candidate === null) continue;
    // A non-null object (checked above); each field is narrowed on the next line before use.
    const { kid, kty, n, e } = candidate as Readonly<Record<string, unknown>>;
    if (typeof kid === "string" && kty === "RSA" && typeof n === "string" && typeof e === "string") keys.set(kid, { kty, n, e });
  }
  const maximumAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "")?.[1];
  return { keys, expiresAt: options.now() + (maximumAge === undefined ? DEFAULT_KEY_LIFETIME_MILLISECONDS : Number(maximumAge) * 1000) };
}

function decodeTokenPart(part: string): Readonly<Record<string, unknown>> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
    // A JSON object (checked): its keys are read one at a time and each narrowed where used.
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}
