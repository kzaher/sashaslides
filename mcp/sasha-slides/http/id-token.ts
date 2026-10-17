/**
 * Verifying an RS256 ID token (a compact JWS): the one set of checks behind every sign-in that hands
 * us one — the portal's OpenID Connect providers (identity-providers.ts) and Google identity tokens
 * from the add-on handoff and the connect flows (google-slides/identity-token.ts).
 *
 * The caller owns its keys (discovery plus JWKS, or Google's published certificates cached by
 * `Cache-Control`) and passes a lookup by `kid`; this module owns which claims are checked and in
 * what order, so the verifiers cannot drift:
 *   1. the algorithm is pinned to RS256, which keeps `none` and RS/HS confusion out;
 *   2. the signature verifies against the key the lookup returns;
 *   3. the issuer is one of the caller's;
 *   4. the audience holds the caller's client id, and with several audiences `azp` names it
 *      (OpenID Connect Core 3.1.3.7);
 *   5. the token has an expiry that has not passed, and no `nbf` still in the future, both within
 *      the caller's clock leeway;
 *   6. the nonce matches, when the caller sent one;
 *   7. the subject is a non-empty string.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { asRecord, asString, asStringArray, parseJson } from "./json-values.ts";

/** An RSA public key from a JWKS, by `kid` (null when the published key has none). */
export type SigningKey = Readonly<{ kid: string | null; key: KeyObject }>;

export type KeyLookup = Readonly<{ kind: "ok"; value: KeyObject }> | Readonly<{ kind: "failed"; reason: string }>;

export type IdTokenVerdict =
  | Readonly<{ kind: "verified"; subject: string; claims: Readonly<Record<string, unknown>>; expiresAtMs: number }>
  | Readonly<{ kind: "rejected"; reason: string }>;

export async function verifyIdToken(
  options: Readonly<{
    token: string;
    /** The signing key for the header's `kid` (null when the header names none). */
    keyFor: (kid: string | null) => Promise<KeyLookup>;
    issuers: readonly string[];
    /** Our client id: the token must be issued to it. */
    audience: string;
    nowMs: number;
    /** Tolerated clock difference with the issuer, for `exp` and `nbf`. */
    clockSkewMs: number;
    /** The nonce this sign-in sent; absent when the flow sends none. */
    nonce?: string;
  }>,
): Promise<IdTokenVerdict> {
  const { audience, nowMs, clockSkewMs } = options;
  const rejected = (reason: string): IdTokenVerdict => ({ kind: "rejected", reason });
  const parts = options.token.split(".");
  const [encodedHeader, encodedClaims, encodedSignature] = parts;
  if (parts.length !== 3 || encodedHeader === undefined || encodedClaims === undefined || encodedSignature === undefined) {
    return rejected("not a compact JWS");
  }
  const header = decodeJsonSegment(encodedHeader);
  const claims = decodeJsonSegment(encodedClaims);
  if (header === null || claims === null) return rejected("header or payload is not base64url JSON");
  if (header.alg !== "RS256") return rejected(`unsupported alg ${JSON.stringify(header.alg)}`);

  const key = await options.keyFor(asString(header.kid));
  if (key.kind === "failed") return rejected(key.reason);
  const signedInput = Buffer.from(`${encodedHeader}.${encodedClaims}`, "utf-8");
  if (!verify("RSA-SHA256", signedInput, key.value, Buffer.from(encodedSignature, "base64url"))) return rejected("signature does not verify");

  const issuer = asString(claims.iss);
  if (issuer === null || !options.issuers.includes(issuer)) return rejected(`unexpected issuer ${JSON.stringify(claims.iss)}`);
  const audiences = typeof claims.aud === "string" ? [claims.aud] : asStringArray(claims.aud);
  if (audiences === null || !audiences.includes(audience)) return rejected("audience is not this client");
  if (audiences.length > 1 && claims.azp !== audience) return rejected("authorized party is not this client");
  if (typeof claims.exp !== "number") return rejected("no expiry");
  if (claims.exp * 1000 + clockSkewMs <= nowMs) return rejected("expired");
  if (typeof claims.nbf === "number" && claims.nbf * 1000 - clockSkewMs > nowMs) return rejected("not yet valid");
  if (options.nonce !== undefined && claims.nonce !== options.nonce) return rejected("nonce does not match this sign-in");
  const subject = asString(claims.sub);
  if (subject === null || subject === "") return rejected("no subject");
  return { kind: "verified", subject, claims, expiresAtMs: claims.exp * 1000 };
}

/**
 * The RS256 signing keys of a JWKS body, or null when it holds no key list. Keys of another type,
 * use or algorithm are skipped, and so is a malformed one: only the token's own key has to be valid.
 */
export function signingKeysOf(body: unknown): readonly SigningKey[] | null {
  const keys = asRecord(body)?.keys;
  if (!Array.isArray(keys)) return null;
  const signingKeys: SigningKey[] = [];
  for (const candidate of keys) {
    const jwk = asRecord(candidate);
    if (jwk === null || jwk.kty !== "RSA") continue;
    if (jwk.use !== undefined && jwk.use !== "sig") continue;
    if (jwk.alg !== undefined && jwk.alg !== "RS256") continue;
    const modulus = asString(jwk.n);
    const exponent = asString(jwk.e);
    if (modulus === null || exponent === null) continue;
    try {
      signingKeys.push({ kid: asString(jwk.kid), key: createPublicKey({ key: { kty: "RSA", n: modulus, e: exponent }, format: "jwk" }) });
    } catch {
      // Skipped, as above.
    }
  }
  return signingKeys;
}

/** One base64url JSON object segment of a JWT, or null when it is not one. Does not verify anything. */
export function decodeJsonSegment(segment: string): Readonly<Record<string, unknown>> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) return null;
  const parsed = parseJson(Buffer.from(segment, "base64url").toString("utf-8"));
  return parsed.kind === "ok" ? asRecord(parsed.value) : null;
}
