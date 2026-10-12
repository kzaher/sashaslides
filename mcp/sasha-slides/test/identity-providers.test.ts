/**
 * The sign-in provider registry: config parsing, then each protocol's sign-in end to end
 * against fakes that sign real tokens. No network.
 *
 *   cd mcp/sasha-slides && npx tsx --test test/identity-providers.test.ts
 *
 * Ordered like the implementation: parsing, OpenID Connect (honest token, then one row per
 * rejection with an honest control row), Microsoft's per-tenant issuer, then GitHub.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  createIdentityProvider,
  defaultIdentityProviders,
  parseIdentityProvidersConfig,
  type IdentityProvider,
  type IdentityProviderSpec,
  type SignInOutcome,
} from "../http/identity-providers";
import {
  createFakeGitHub,
  createFakeOidcIssuer,
  fakeFetch,
  type FakeGitHubEmail,
  type IdTokenTamper,
} from "./fake-identity-providers";

const CONNECTOR_GOOGLE = { clientId: "connector-google-id", clientSecret: "connector-google-secret" };
const REDIRECT_URI = "https://slides.example.test/account/callback/okta";
const NOW = new Date("2026-10-11T12:00:00Z");
const MICROSOFT_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
let tokenCounter = 0;
const randomToken = (): string => `token-${String((tokenCounter += 1))}-padding-padding-padding`;

describe("parseIdentityProvidersConfig", () => {
  test("presets need only a name and credentials; display names and protocols come from the preset", () => {
    const parsed = parseIdentityProvidersConfig({
      text: JSON.stringify({
        providers: [
          { name: "microsoft", clientId: "ms-id", clientSecret: "ms-secret" },
          { name: "github", clientId: "gh-id", clientSecret: "gh-secret" },
        ],
      }),
      connectorGoogleCredentials: CONNECTOR_GOOGLE,
    });
    assert.equal(parsed.kind, "ok", parsed.kind === "error" ? parsed.message : "");
    if (parsed.kind !== "ok") return;
    assert.deepEqual(
      parsed.providers.map((spec) => [spec.name, spec.displayName, spec.protocol]),
      [
        ["microsoft", "Microsoft", "oidc"],
        ["github", "GitHub", "github"],
      ],
    );
  });

  test("a generic OpenID Connect provider takes its issuer and display name from the file", () => {
    const parsed = parseIdentityProvidersConfig({
      text: JSON.stringify({
        providers: [
          { name: "okta", displayName: "Okta", issuer: "https://acme.okta.example", clientId: "o", clientSecret: "s" },
        ],
      }),
      connectorGoogleCredentials: null,
    });
    assert.equal(parsed.kind, "ok", parsed.kind === "error" ? parsed.message : "");
    if (parsed.kind !== "ok") return;
    const [okta] = parsed.providers;
    assert.equal(okta?.protocol, "oidc");
    assert.equal(okta?.displayName, "Okta");
    assert.equal(okta?.protocol === "oidc" ? okta.issuer : null, "https://acme.okta.example");
    assert.deepEqual(okta?.scopes, ["openid", "email"]);
  });

  test("google without credentials reuses the connector's Google client", () => {
    const parsed = parseIdentityProvidersConfig({
      text: JSON.stringify({ providers: [{ name: "google" }] }),
      connectorGoogleCredentials: CONNECTOR_GOOGLE,
    });
    assert.equal(parsed.kind, "ok", parsed.kind === "error" ? parsed.message : "");
    if (parsed.kind !== "ok") return;
    assert.equal(parsed.providers[0]?.clientId, CONNECTOR_GOOGLE.clientId);
    assert.equal(parsed.providers[0]?.clientSecret, CONNECTOR_GOOGLE.clientSecret);
  });

  test("no file at all means Google alone, on the connector's client", () => {
    const providers = defaultIdentityProviders({ connectorGoogleCredentials: CONNECTOR_GOOGLE });
    assert.deepEqual(
      providers.map((spec) => [spec.name, spec.clientId]),
      [["google", CONNECTOR_GOOGLE.clientId]],
    );
  });

  const SECRET = "super-secret-value-123";
  const rejected: readonly Readonly<{ name: string; config: unknown; connector: typeof CONNECTOR_GOOGLE | null; mentions: string }>[] = [
    { name: "not an object", config: [], connector: null, mentions: "\"providers\"" },
    { name: "providers is not a list", config: { providers: {} }, connector: null, mentions: "providers must be a non-empty list" },
    { name: "empty list", config: { providers: [] }, connector: null, mentions: "providers must be a non-empty list" },
    { name: "unknown top-level key", config: { providers: [{ name: "google" }], extra: 1 }, connector: CONNECTOR_GOOGLE, mentions: "unknown key \"extra\"" },
    {
      name: "unknown provider key",
      config: { providers: [{ name: "github", clientId: "x", clientSecret: SECRET, tenant: "y" }] },
      connector: null,
      mentions: "providers[0]: unknown key \"tenant\"",
    },
    { name: "bad name", config: { providers: [{ name: "Has Space", clientId: "x", clientSecret: SECRET }] }, connector: null, mentions: "providers[0].name" },
    {
      name: "duplicate name",
      config: { providers: [{ name: "github", clientId: "a", clientSecret: SECRET }, { name: "github", clientId: "b", clientSecret: SECRET }] },
      connector: null,
      mentions: "providers[1].name: \"github\" is configured twice",
    },
    {
      name: "generic provider without an issuer",
      config: { providers: [{ name: "okta", displayName: "Okta", clientId: "x", clientSecret: SECRET }] },
      connector: null,
      mentions: "providers[0].issuer",
    },
    {
      name: "generic provider without a display name",
      config: { providers: [{ name: "okta", issuer: "https://okta.example", clientId: "x", clientSecret: SECRET }] },
      connector: null,
      mentions: "providers[0].displayName",
    },
    {
      name: "plain-http issuer",
      config: { providers: [{ name: "okta", displayName: "Okta", issuer: "http://okta.example", clientId: "x", clientSecret: SECRET }] },
      connector: null,
      mentions: "providers[0].issuer must be an https URL",
    },
    {
      name: "a preset's issuer cannot be overridden",
      config: { providers: [{ name: "microsoft", issuer: "https://evil.example", clientId: "x", clientSecret: SECRET }] },
      connector: null,
      mentions: "providers[0].issuer is fixed for the microsoft preset",
    },
    { name: "missing secret", config: { providers: [{ name: "github", clientId: "x" }] }, connector: null, mentions: "providers[0].clientSecret" },
    {
      name: "client id of the wrong type, next to a secret",
      config: { providers: [{ name: "github", clientId: 42, clientSecret: SECRET }] },
      connector: null,
      mentions: "providers[0].clientId must be a non-empty string",
    },
    {
      name: "google with only half its credentials",
      config: { providers: [{ name: "google", clientSecret: SECRET }] },
      connector: CONNECTOR_GOOGLE,
      mentions: "providers[0]: give both clientId and clientSecret, or neither",
    },
    {
      name: "google without credentials and no connector client",
      config: { providers: [{ name: "google" }] },
      connector: null,
      mentions: "providers[0]: google has no clientId",
    },
    {
      name: "scopes that are not strings",
      config: { providers: [{ name: "github", clientId: "x", clientSecret: SECRET, scopes: [1] }] },
      connector: null,
      mentions: "providers[0].scopes",
    },
  ];
  for (const row of rejected) {
    test(`rejects ${row.name}, says where, and never echoes a secret`, () => {
      const parsed = parseIdentityProvidersConfig({ text: JSON.stringify(row.config), connectorGoogleCredentials: row.connector });
      assert.equal(parsed.kind, "error");
      if (parsed.kind !== "error") return;
      assert.ok(parsed.message.includes(row.mentions), `${parsed.message} should mention ${row.mentions}`);
      assert.ok(!parsed.message.includes(SECRET), parsed.message);
    });
  }

  test("text that is not JSON is rejected with the parser's reason", () => {
    const parsed = parseIdentityProvidersConfig({ text: "{ nope", connectorGoogleCredentials: null });
    assert.equal(parsed.kind, "error");
    assert.match(parsed.kind === "error" ? parsed.message : "", /not JSON/);
  });
});

describe("OpenID Connect sign-in", () => {
  const OKTA: IdentityProviderSpec = {
    protocol: "oidc",
    name: "okta",
    displayName: "Okta",
    issuer: "https://acme.okta.example",
    issuerRule: { kind: "exact", issuers: ["https://acme.okta.example"] },
    clientId: "okta-client",
    clientSecret: "okta-secret",
    scopes: ["openid", "email"],
  };

  function oktaHarness(): Readonly<{ provider: IdentityProvider; signIn: (tamper: IdTokenTamper) => Promise<SignInOutcome>; requestedUrls: () => readonly string[] }> {
    const issuer = createFakeOidcIssuer({
      discoveryBase: "https://acme.okta.example",
      advertisedIssuer: "https://acme.okta.example",
      tokenIssuer: "https://acme.okta.example",
      clientId: OKTA.clientId,
      clientSecret: OKTA.clientSecret,
      now: () => NOW,
      extraClaims: {},
    });
    const network = fakeFetch({ routes: [issuer.route] });
    const provider = createIdentityProvider({ spec: OKTA, fetch: network.fetch, now: () => NOW, randomToken, timeoutMs: 5000 });
    return {
      provider,
      requestedUrls: network.requestedUrls,
      signIn: async (tamper) => {
        const begun = await provider.begin({ redirectUri: REDIRECT_URI });
        assert.equal(begun.kind, "redirect", begun.kind === "failed" ? begun.reason : "");
        if (begun.kind !== "redirect") throw new Error("unreachable");
        const callback = issuer.authorize({ authorizationUrl: begun.location, subject: "user-1", email: "ada@example.com", emailVerified: true, tamper });
        return provider.complete({ pending: begun.pending, parameters: new URLSearchParams(callback), redirectUri: REDIRECT_URI });
      },
    };
  }

  test("the authorization URL asks for a code with PKCE S256, state and nonce", async () => {
    const { provider } = oktaHarness();
    const begun = await provider.begin({ redirectUri: REDIRECT_URI });
    assert.equal(begun.kind, "redirect");
    if (begun.kind !== "redirect") return;
    const query = new URL(begun.location).searchParams;
    assert.equal(query.get("response_type"), "code");
    assert.equal(query.get("client_id"), "okta-client");
    assert.equal(query.get("redirect_uri"), REDIRECT_URI);
    assert.equal(query.get("scope"), "openid email");
    assert.equal(query.get("code_challenge_method"), "S256");
    assert.equal(query.get("state"), begun.pending.state);
    assert.equal(query.get("nonce"), begun.pending.nonce);
    assert.notEqual(query.get("code_challenge"), begun.pending.codeVerifier);
  });

  test("an honest token signs the user in, and discovery is fetched once across sign-ins", async () => {
    const harness = oktaHarness();
    const first = await harness.signIn({});
    assert.deepEqual(first, {
      kind: "signed-in",
      identity: { provider: "okta", subject: "user-1", email: "ada@example.com", emailVerified: true },
    });
    assert.equal((await harness.signIn({})).kind, "signed-in");
    const discoveries = harness.requestedUrls().filter((url) => url.endsWith("/.well-known/openid-configuration"));
    assert.equal(discoveries.length, 1);
  });

  const nowSeconds = Math.floor(NOW.getTime() / 1000);
  const rows: readonly Readonly<{ name: string; tamper: IdTokenTamper; accepted: boolean }>[] = [
    { name: "control: honest token", tamper: {}, accepted: true },
    { name: "audience is another client", tamper: { claims: { aud: "someone-else" } }, accepted: false },
    { name: "audience list without our client", tamper: { claims: { aud: ["a", "b"] } }, accepted: false },
    { name: "audience list with us but another azp", tamper: { claims: { aud: ["okta-client", "b"], azp: "b" } }, accepted: false },
    { name: "issuer is another server", tamper: { claims: { iss: "https://evil.example" } }, accepted: false },
    { name: "expired an hour ago", tamper: { claims: { exp: nowSeconds - 3600 } }, accepted: false },
    { name: "no expiry", tamper: { claims: { exp: undefined } }, accepted: false },
    { name: "nonce from another sign-in", tamper: { claims: { nonce: "stolen-nonce" } }, accepted: false },
    { name: "signed by a key not in the JWKS", tamper: { signing: "foreign-key" }, accepted: false },
    { name: "alg none", tamper: { signing: "alg-none" }, accepted: false },
    { name: "HS256 with the public key as secret", tamper: { signing: "hs256" }, accepted: false },
    { name: "empty subject", tamper: { claims: { sub: "" } }, accepted: false },
  ];
  for (const row of rows) {
    test(`ID token check: ${row.name} → ${row.accepted ? "accepted" : "rejected"}`, async () => {
      const outcome = await oktaHarness().signIn(row.tamper);
      assert.equal(outcome.kind, row.accepted ? "signed-in" : "failed", JSON.stringify(outcome));
    });
  }

  test("email_verified is reported as given, and absent email is null", async () => {
    const issuer = createFakeOidcIssuer({
      discoveryBase: "https://acme.okta.example",
      advertisedIssuer: "https://acme.okta.example",
      tokenIssuer: "https://acme.okta.example",
      clientId: OKTA.clientId,
      clientSecret: OKTA.clientSecret,
      now: () => NOW,
      extraClaims: {},
    });
    const provider = createIdentityProvider({ spec: OKTA, fetch: fakeFetch({ routes: [issuer.route] }).fetch, now: () => NOW, randomToken, timeoutMs: 5000 });
    for (const row of [
      { email: "u@example.com", emailVerified: false, expected: { email: "u@example.com", emailVerified: false } },
      { email: null, emailVerified: false, expected: { email: null, emailVerified: false } },
    ]) {
      const begun = await provider.begin({ redirectUri: REDIRECT_URI });
      if (begun.kind !== "redirect") throw new Error(begun.reason);
      const callback = issuer.authorize({ authorizationUrl: begun.location, subject: "s", email: row.email, emailVerified: row.emailVerified, tamper: {} });
      const outcome = await provider.complete({ pending: begun.pending, parameters: new URLSearchParams(callback), redirectUri: REDIRECT_URI });
      assert.equal(outcome.kind, "signed-in");
      if (outcome.kind !== "signed-in") return;
      assert.deepEqual({ email: outcome.identity.email, emailVerified: outcome.identity.emailVerified }, row.expected);
    }
  });

  test("a callback whose state is not the pending one, or that carries an error, fails", async () => {
    const { provider } = oktaHarness();
    const begun = await provider.begin({ redirectUri: REDIRECT_URI });
    if (begun.kind !== "redirect") throw new Error(begun.reason);
    const mismatched = await provider.complete({
      pending: begun.pending,
      parameters: new URLSearchParams({ code: "x", state: "other" }),
      redirectUri: REDIRECT_URI,
    });
    assert.equal(mismatched.kind, "failed");
    const denied = await provider.complete({
      pending: begun.pending,
      parameters: new URLSearchParams({ error: "access_denied", state: begun.pending.state }),
      redirectUri: REDIRECT_URI,
    });
    assert.equal(denied.kind, "failed");
    assert.match(denied.kind === "failed" ? denied.reason : "", /access_denied/);
  });
});

describe("Microsoft's common endpoint", () => {
  function microsoftSignIn(claims: Readonly<Record<string, unknown>>): Promise<SignInOutcome> {
    const parsed = parseIdentityProvidersConfig({
      text: JSON.stringify({ providers: [{ name: "microsoft", clientId: "ms-client", clientSecret: "ms-secret" }] }),
      connectorGoogleCredentials: null,
    });
    if (parsed.kind !== "ok" || parsed.providers[0] === undefined) throw new Error("config");
    const issuer = createFakeOidcIssuer({
      discoveryBase: "https://login.microsoftonline.com/common/v2.0",
      // What the real common-tenant document advertises: a template, not an issuer.
      advertisedIssuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
      tokenIssuer: `https://login.microsoftonline.com/${MICROSOFT_TENANT}/v2.0`,
      clientId: "ms-client",
      clientSecret: "ms-secret",
      now: () => NOW,
      extraClaims: { tid: MICROSOFT_TENANT },
    });
    const provider = createIdentityProvider({ spec: parsed.providers[0], fetch: fakeFetch({ routes: [issuer.route] }).fetch, now: () => NOW, randomToken, timeoutMs: 5000 });
    return (async () => {
      const begun = await provider.begin({ redirectUri: REDIRECT_URI });
      if (begun.kind !== "redirect") throw new Error(begun.reason);
      const callback = issuer.authorize({ authorizationUrl: begun.location, subject: "ms-user", email: "m@contoso.example", emailVerified: false, tamper: { claims } });
      return provider.complete({ pending: begun.pending, parameters: new URLSearchParams(callback), redirectUri: REDIRECT_URI });
    })();
  }

  const OTHER_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
  const rows: readonly Readonly<{ name: string; claims: Readonly<Record<string, unknown>>; accepted: boolean }>[] = [
    { name: "control: the user's tenant issuer, matching tid", claims: {}, accepted: true },
    { name: "issuer of another tenant than tid", claims: { iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }, accepted: false },
    { name: "the literal template as issuer", claims: { iss: "https://login.microsoftonline.com/{tid}/v2.0" }, accepted: false },
    { name: "issuer on another host", claims: { iss: `https://evil.example/${MICROSOFT_TENANT}/v2.0` }, accepted: false },
    { name: "tid that is not a tenant id", claims: { tid: "../evil", iss: "https://login.microsoftonline.com/../evil/v2.0" }, accepted: false },
    { name: "no tid", claims: { tid: undefined }, accepted: false },
  ];
  for (const row of rows) {
    test(`tenant issuer: ${row.name} → ${row.accepted ? "accepted" : "rejected"}`, async () => {
      const outcome = await microsoftSignIn(row.claims);
      assert.equal(outcome.kind, row.accepted ? "signed-in" : "failed", JSON.stringify(outcome));
      if (outcome.kind === "signed-in") {
        // Microsoft's email claim is not verified by Microsoft, so it must never read as verified.
        assert.deepEqual(outcome.identity, { provider: "microsoft", subject: "ms-user", email: "m@contoso.example", emailVerified: false });
      }
    });
  }
});

describe("GitHub sign-in", () => {
  const GITHUB: IdentityProviderSpec = {
    protocol: "github",
    name: "github",
    displayName: "GitHub",
    clientId: "gh-client",
    clientSecret: "gh-secret",
    scopes: ["read:user", "user:email"],
  };

  async function gitHubSignIn(emails: readonly FakeGitHubEmail[]): Promise<Readonly<{ outcome: SignInOutcome; location: string }>> {
    const github = createFakeGitHub({ clientId: "gh-client", clientSecret: "gh-secret", userId: 583231, emails });
    const provider = createIdentityProvider({ spec: GITHUB, fetch: fakeFetch({ routes: [github.route] }).fetch, now: () => NOW, randomToken, timeoutMs: 5000 });
    const begun = await provider.begin({ redirectUri: REDIRECT_URI });
    if (begun.kind !== "redirect") throw new Error(begun.reason);
    const callback = github.authorize({ authorizationUrl: begun.location });
    return {
      location: begun.location,
      outcome: await provider.complete({ pending: begun.pending, parameters: new URLSearchParams(callback), redirectUri: REDIRECT_URI }),
    };
  }

  test("asks for read:user and user:email with PKCE and no nonce", async () => {
    const { location } = await gitHubSignIn([]);
    const query = new URL(location).searchParams;
    assert.equal(query.get("scope"), "read:user user:email");
    assert.equal(query.get("code_challenge_method"), "S256");
    assert.equal(query.get("nonce"), null);
  });

  const rows: readonly Readonly<{ name: string; emails: readonly FakeGitHubEmail[]; email: string | null; verified: boolean }>[] = [
    {
      name: "the primary verified address wins over an earlier verified one",
      emails: [
        { email: "old@example.com", primary: false, verified: true },
        { email: "main@example.com", primary: true, verified: true },
      ],
      email: "main@example.com",
      verified: true,
    },
    {
      name: "an unverified primary is not used",
      emails: [
        { email: "main@example.com", primary: true, verified: false },
        { email: "other@example.com", primary: false, verified: true },
      ],
      email: null,
      verified: false,
    },
    { name: "no addresses", emails: [], email: null, verified: false },
  ];
  for (const row of rows) {
    test(`subject is the numeric id as a string; ${row.name}`, async () => {
      const { outcome } = await gitHubSignIn(row.emails);
      assert.deepEqual(outcome, {
        kind: "signed-in",
        identity: { provider: "github", subject: "583231", email: row.email, emailVerified: row.verified },
      });
    });
  }
});
