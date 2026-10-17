/**
 * The one grant-merge rule and the one stored-grant-to-access-token path (http/google-grants.ts).
 * Every place that stores a fresh Google grant (MCP sign-in, MCP refresh, googleapis refresh,
 * /comments/allow, the Slides connect flow) merges through `mergeGoogleGrant`, so its rule is pinned here.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { DRIVE_FILE_SCOPE, GOOGLE_TOKEN_ENDPOINT, SLIDES_SCOPE } from "../google-constants";
import { googleAccessToken, mergeGoogleGrant, missingGoogleGrant } from "../http/google-grants";
import type { HttpFetch, HttpFetchInit } from "../http/http-kit";
import type { GoogleIdentity } from "../http/oauth-store";

const STORED: GoogleIdentity = {
  subject: "sub-1",
  email: "ada@example.com",
  accessToken: "old-access",
  refreshToken: "old-refresh",
  accessTokenExpiresAtMs: 1_000,
  grantedScopes: ["openid", SLIDES_SCOPE, DRIVE_FILE_SCOPE],
};

const FRESH: GoogleIdentity = {
  subject: "sub-1",
  email: null,
  accessToken: "new-access",
  refreshToken: null,
  accessTokenExpiresAtMs: 2_000,
  grantedScopes: ["openid", SLIDES_SCOPE],
};

describe("mergeGoogleGrant", () => {
  test("with nothing stored, the fresh grant is stored as it came", () => {
    assert.deepEqual(mergeGoogleGrant({ stored: null, fresh: FRESH }), FRESH);
  });

  test("keeps the stored refresh token and address when Google sent none, and takes the fresh access token with its expiry", () => {
    assert.deepEqual(mergeGoogleGrant({ stored: STORED, fresh: FRESH }), {
      subject: "sub-1",
      email: "ada@example.com",
      accessToken: "new-access",
      refreshToken: "old-refresh",
      accessTokenExpiresAtMs: 2_000,
      grantedScopes: ["openid", SLIDES_SCOPE],
    });
  });

  test("scopes are REPLACED by Google's report, so a revoked scope disappears (never a union)", () => {
    const merged = mergeGoogleGrant({ stored: STORED, fresh: FRESH });
    assert.equal(merged.grantedScopes.includes(DRIVE_FILE_SCOPE), false);
  });

  test("an empty scope report means Google told us nothing: the stored scopes stay", () => {
    assert.deepEqual(mergeGoogleGrant({ stored: STORED, fresh: { ...FRESH, grantedScopes: [] } }).grantedScopes, STORED.grantedScopes);
  });

  test("a rotated refresh token replaces the stored one", () => {
    assert.equal(mergeGoogleGrant({ stored: STORED, fresh: { ...FRESH, refreshToken: "rotated" } }).refreshToken, "rotated");
  });

  test("a fresh grant without an access token keeps the stored token AND its expiry, as a pair", () => {
    const merged = mergeGoogleGrant({ stored: STORED, fresh: { ...FRESH, accessToken: null, accessTokenExpiresAtMs: 9_999 } });
    assert.deepEqual([merged.accessToken, merged.accessTokenExpiresAtMs], ["old-access", 1_000]);
  });
});

describe("missingGoogleGrant", () => {
  test("names the Slides scope, then the Drive scopes, and trusts an empty report", () => {
    assert.equal(missingGoogleGrant({ grantedScopes: [] }), null);
    assert.equal(missingGoogleGrant({ grantedScopes: [DRIVE_FILE_SCOPE] }), SLIDES_SCOPE);
    assert.match(missingGoogleGrant({ grantedScopes: [SLIDES_SCOPE] }) ?? "", /drive/);
    assert.equal(missingGoogleGrant({ grantedScopes: [SLIDES_SCOPE, DRIVE_FILE_SCOPE] }), null);
  });
});

type TokenCall = Readonly<{ url: string; init: HttpFetchInit }>;

function tokenEndpoint(answer: Readonly<{ status: number; body: unknown }> | "unreachable"): Readonly<{ fetch: HttpFetch; calls: TokenCall[] }> {
  const calls: TokenCall[] = [];
  const fetch: HttpFetch = (url, init) => {
    calls.push({ url, init });
    if (answer === "unreachable") return Promise.reject(new TypeError("fetch failed"));
    return Promise.resolve({ status: answer.status, json: () => Promise.resolve(answer.body) });
  };
  return { fetch, calls };
}

const CLIENT = { clientId: "client-id", clientSecret: "client-secret" };
const NOW_MS = 1_000_000;
const GRANT = { accessToken: "stored-access", accessTokenExpiresAtMs: NOW_MS + 120_000, refreshToken: "the-refresh" };

describe("googleAccessToken", () => {
  test("uses the stored token while it has more than a minute left, without calling Google", async () => {
    const google = tokenEndpoint({ status: 500, body: null });
    const token = await googleAccessToken({ grant: GRANT, client: CLIENT, fetch: google.fetch, nowMs: NOW_MS, timeoutMs: 1000, forceRefresh: false });
    assert.deepEqual(token, { kind: "ok", accessToken: "stored-access", expiresAtMs: NOW_MS + 120_000 });
    assert.equal(google.calls.length, 0);
  });

  test("refreshes a token inside the margin, posting the refresh token and our client", async () => {
    const google = tokenEndpoint({ status: 200, body: { access_token: "refreshed", expires_in: 3599 } });
    const grant = { ...GRANT, accessTokenExpiresAtMs: NOW_MS + 30_000 };
    const token = await googleAccessToken({ grant, client: CLIENT, fetch: google.fetch, nowMs: NOW_MS, timeoutMs: 1000, forceRefresh: false });
    assert.deepEqual(token, { kind: "ok", accessToken: "refreshed", expiresAtMs: NOW_MS + 3_599_000 });
    assert.equal(google.calls[0]?.url, GOOGLE_TOKEN_ENDPOINT);
    const form = new URLSearchParams(google.calls[0]?.init.body ?? "");
    assert.deepEqual([form.get("grant_type"), form.get("refresh_token"), form.get("client_id")], ["refresh_token", "the-refresh", "client-id"]);
  });

  test("forceRefresh skips a stored token Google just refused", async () => {
    const google = tokenEndpoint({ status: 200, body: { access_token: "refreshed", expires_in: 60 } });
    const token = await googleAccessToken({ grant: GRANT, client: CLIENT, fetch: google.fetch, nowMs: NOW_MS, timeoutMs: 1000, forceRefresh: true });
    assert.equal(token.kind === "ok" ? token.accessToken : null, "refreshed");
  });

  type Grant = Pick<GoogleIdentity, "accessToken" | "accessTokenExpiresAtMs" | "refreshToken">;
  const failures: readonly Readonly<{ name: string; grant?: Grant; answer: Parameters<typeof tokenEndpoint>[0]; status: number }>[] = [
    { name: "no refresh token: the grant is gone", grant: { accessToken: null, accessTokenExpiresAtMs: null, refreshToken: null }, answer: { status: 200, body: {} }, status: 401 },
    { name: "invalid_grant: the grant is gone", answer: { status: 400, body: { error: "invalid_grant" } }, status: 401 },
    { name: "another error keeps Google's status", answer: { status: 503, body: { error: "backend_error" } }, status: 503 },
    { name: "an answer without expires_in", answer: { status: 200, body: { access_token: "x" } }, status: 200 },
    { name: "Google unreachable", answer: "unreachable", status: 0 },
  ];
  for (const row of failures) {
    test(`fails: ${row.name}`, async () => {
      const google = tokenEndpoint(row.answer);
      const token = await googleAccessToken({ grant: row.grant ?? GRANT, client: CLIENT, fetch: google.fetch, nowMs: NOW_MS, timeoutMs: 1000, forceRefresh: true });
      assert.equal(token.kind, "failed");
      assert.equal(token.kind === "failed" ? token.status : null, row.status);
      // A reason never carries a token.
      assert.doesNotMatch(token.kind === "failed" ? token.reason : "", /the-refresh|stored-access/);
    });
  }
});
