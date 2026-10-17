/**
 * The one RS256 ID-token verifier (http/id-token.ts) that the portal's OpenID Connect providers and
 * the Google identity verifier share: every rejection a caller relies on, and the JWKS reader.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { signingKeysOf, verifyIdToken, type KeyLookup } from "../http/id-token";

const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const ISSUER = "https://issuer.example";
const CLIENT = "our-client";
const KID = "key-1";

const ours = generateKeyPairSync("rsa", { modulusLength: 2048 });
const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });

function segment(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value), "utf-8").toString("base64url");
}

function token(
  options: Readonly<{ claims?: Readonly<Record<string, unknown>>; header?: Readonly<Record<string, unknown>>; key?: KeyObject }> = {},
): string {
  const header = { alg: "RS256", kid: KID, typ: "JWT", ...options.header };
  const claims = { iss: ISSUER, aud: CLIENT, sub: "subject-1", exp: NOW_SECONDS + 600, nonce: "n-1", email: "ada@example.com", ...options.claims };
  const input = `${segment(header)}.${segment(claims)}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), options.key ?? ours.privateKey).toString("base64url")}`;
}

const keyFor = (kid: string | null): Promise<KeyLookup> =>
  Promise.resolve(kid === KID ? { kind: "ok", value: ours.publicKey } : { kind: "failed", reason: `no key ${String(kid)}` });

function verifyWith(options: Readonly<{ token: string; clockSkewMs?: number; nonce?: string }>): ReturnType<typeof verifyIdToken> {
  return verifyIdToken({
    token: options.token,
    keyFor,
    issuers: [ISSUER],
    audience: CLIENT,
    nowMs: NOW_MS,
    clockSkewMs: options.clockSkewMs ?? 0,
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  });
}

describe("verifyIdToken", () => {
  test("a well-signed token for us verifies, with its subject, claims and expiry", async () => {
    const verdict = await verifyWith({ token: token(), nonce: "n-1" });
    assert.equal(verdict.kind, "verified");
    if (verdict.kind !== "verified") return;
    assert.equal(verdict.subject, "subject-1");
    assert.equal(verdict.claims.email, "ada@example.com");
    assert.equal(verdict.expiresAtMs, (NOW_SECONDS + 600) * 1000);
  });

  const rows: readonly Readonly<{ name: string; token: string; clockSkewMs?: number; nonce?: string; reason: RegExp }>[] = [
    { name: "wrong issuer", token: token({ claims: { iss: "https://evil.example" } }), reason: /unexpected issuer/ },
    { name: "wrong audience", token: token({ claims: { aud: "someone-else" } }), reason: /audience is not this client/ },
    { name: "audience list without us", token: token({ claims: { aud: ["a", "b"] } }), reason: /audience is not this client/ },
    { name: "audience list with us but another azp", token: token({ claims: { aud: [CLIENT, "b"], azp: "b" } }), reason: /authorized party/ },
    { name: "expired a second ago", token: token({ claims: { exp: NOW_SECONDS - 1 } }), reason: /expired/ },
    { name: "expired past the leeway", token: token({ claims: { exp: NOW_SECONDS - 120 } }), clockSkewMs: 60_000, reason: /expired/ },
    { name: "no expiry", token: token({ claims: { exp: undefined } }), reason: /no expiry/ },
    { name: "not yet valid", token: token({ claims: { nbf: NOW_SECONDS + 600 } }), reason: /not yet valid/ },
    { name: "bad signature (another key)", token: token({ key: foreign.privateKey }), reason: /signature does not verify/ },
    { name: "alg none", token: token({ header: { alg: "none" } }), reason: /unsupported alg/ },
    { name: "HS256", token: token({ header: { alg: "HS256" } }), reason: /unsupported alg/ },
    { name: "unknown key id", token: token({ header: { kid: "rotated" } }), reason: /no key rotated/ },
    { name: "nonce of another sign-in", token: token(), nonce: "n-2", reason: /nonce/ },
    { name: "empty subject", token: token({ claims: { sub: "" } }), reason: /no subject/ },
    { name: "not a JWS", token: "a.b", reason: /not a compact JWS/ },
    { name: "payload not JSON", token: `${segment({ alg: "RS256" })}.not*json.sig`, reason: /not base64url JSON/ },
  ];
  for (const row of rows) {
    test(`refuses: ${row.name}`, async () => {
      const verdict = await verifyWith({ token: row.token, ...(row.clockSkewMs === undefined ? {} : { clockSkewMs: row.clockSkewMs }), ...(row.nonce === undefined ? {} : { nonce: row.nonce }) });
      assert.equal(verdict.kind, "rejected", row.name);
      assert.match(verdict.kind === "rejected" ? verdict.reason : "", row.reason, row.name);
    });
  }

  test("the caller's leeway tolerates a token that expired within it, and no nonce is checked when none was sent", async () => {
    assert.equal((await verifyWith({ token: token({ claims: { exp: NOW_SECONDS - 30 } }), clockSkewMs: 60_000 })).kind, "verified");
    assert.equal((await verifyWith({ token: token({ claims: { nonce: undefined } }) })).kind, "verified");
  });
});

describe("signingKeysOf", () => {
  test("keeps RS256 signing keys and skips other types, uses, algorithms and incomplete keys", () => {
    const jwk = ours.publicKey.export({ format: "jwk" });
    const keys = signingKeysOf({
      keys: [
        { ...jwk, kid: "good", use: "sig", alg: "RS256" },
        { ...jwk, kid: "no-kid-fields" },
        { ...jwk, kid: "encryption", use: "enc" },
        { ...jwk, kid: "ps256", alg: "PS256" },
        { kty: "EC", kid: "ec", crv: "P-256", x: "x", y: "y" },
        { kty: "RSA", kid: "no-exponent", n: jwk.n },
      ],
    });
    assert.deepEqual(keys?.map((key) => key.kid), ["good", "no-kid-fields"]);
    assert.equal(signingKeysOf({ nothing: [] }), null);
  });
});
