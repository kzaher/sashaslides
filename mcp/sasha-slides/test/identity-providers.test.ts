/**
 * The sign-in provider registry: config parsing, then each protocol's sign-in end to end
 * against fakes that sign real tokens. No network.
 *
 *   cd mcp/sasha-slides && npx tsx --test test/identity-providers.test.ts
 *
 * Ordered like the implementation: parsing (Apple's .p8 key included), OpenID Connect (honest
 * token, then one row per rejection with an honest control row), Sign in with Apple's
 * client secret and sign-in, then GitHub.
 */
import { strict as assert } from "node:assert";
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, test } from "node:test";
import {
  APPLE_ISSUER,
  appleClientSecret,
  createIdentityProvider,
  defaultIdentityProviders,
  parseIdentityProvidersConfig,
  type IdentityProvider,
  type IdentityProviderSpec,
  type SignInOutcome,
} from "../http/identity-providers";
import {
  createFakeApple,
  createFakeGitHub,
  createFakeOidcIssuer,
  fakeFetch,
  generateAppleKey,
  type FakeEmailVerified,
  type FakeGitHubEmail,
  type IdTokenTamper,
} from "./fake-identity-providers";

const CONNECTOR_GOOGLE = { clientId: "connector-google-id", clientSecret: "connector-google-secret" };
const REDIRECT_URI = "https://slides.example.test/account/callback/okta";
const NOW = new Date("2026-10-11T12:00:00Z");
const APPLE_KEY = generateAppleKey();
const APPLE_KEY_PATH = "/secrets/apple/AuthKey_ABC123DEFG.p8";
const APPLE_ENTRY = { name: "apple", clientId: "com.sashaslides.signin", teamId: "TEAM123456", keyId: "ABC123DEFG", privateKeyPath: APPLE_KEY_PATH };
/** A fake filesystem: `readKeyFile` throws like `readFileSync` for a path it does not hold. */
function keyFiles(files: Readonly<Record<string, string>>): (path: string) => string {
  return (path) => {
    const text = files[path];
    if (text === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
    return text;
  };
}
const NO_FILES = keyFiles({});
let tokenCounter = 0;
const randomToken = (): string => `token-${String((tokenCounter += 1))}-padding-padding-padding`;

describe("parseIdentityProvidersConfig", () => {
  test("presets need only a name and credentials; display names and protocols come from the preset", () => {
    const parsed = parseIdentityProvidersConfig({
      text: JSON.stringify({
        providers: [
          { name: "github", clientId: "gh-id", clientSecret: "gh-secret" },
          APPLE_ENTRY,
        ],
      }),
      connectorGoogleCredentials: CONNECTOR_GOOGLE,
      readKeyFile: keyFiles({ [APPLE_KEY_PATH]: APPLE_KEY.privateKeyPem }),
    });
    assert.equal(parsed.kind, "ok", parsed.kind === "error" ? parsed.message : "");
    if (parsed.kind !== "ok") return;
    assert.deepEqual(
      parsed.providers.map((spec) => [spec.name, spec.displayName, spec.protocol]),
      [
        ["github", "GitHub", "github"],
        ["apple", "Apple", "apple"],
      ],
    );
  });

  test("apple reads its .p8 key at parse time and asks for the name and email scopes", () => {
    const parsed = parseIdentityProvidersConfig({
      text: JSON.stringify({ providers: [APPLE_ENTRY] }),
      connectorGoogleCredentials: null,
      readKeyFile: keyFiles({ [APPLE_KEY_PATH]: APPLE_KEY.privateKeyPem }),
    });
    assert.equal(parsed.kind, "ok", parsed.kind === "error" ? parsed.message : "");
    const [apple] = parsed.kind === "ok" ? parsed.providers : [];
    assert.equal(apple?.protocol, "apple");
    if (apple?.protocol !== "apple") return;
    assert.deepEqual(
      { clientId: apple.clientId, teamId: apple.teamId, keyId: apple.keyId, scopes: apple.scopes, curve: apple.privateKey.asymmetricKeyDetails?.namedCurve },
      { clientId: "com.sashaslides.signin", teamId: "TEAM123456", keyId: "ABC123DEFG", scopes: ["name", "email"], curve: "prime256v1" },
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
      readKeyFile: NO_FILES,
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
      readKeyFile: NO_FILES,
    });
    assert.equal(parsed.kind, "ok", parsed.kind === "error" ? parsed.message : "");
    const [google] = parsed.kind === "ok" ? parsed.providers : [];
    assert.equal(google?.protocol, "oidc");
    if (google?.protocol !== "oidc") return;
    assert.equal(google.clientId, CONNECTOR_GOOGLE.clientId);
    assert.equal(google.clientSecret, CONNECTOR_GOOGLE.clientSecret);
  });

  test("no file at all means Google alone, on the connector's client", () => {
    const providers = defaultIdentityProviders({ connectorGoogleCredentials: CONNECTOR_GOOGLE });
    assert.deepEqual(
      providers.map((spec) => [spec.name, spec.clientId]),
      [["google", CONNECTOR_GOOGLE.clientId]],
    );
  });

  const SECRET = "super-secret-value-123";
  const rsaPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const p384Pem = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicPem = APPLE_KEY.publicKey.export({ format: "pem", type: "spki" }).toString();
  const keyFileRows: Readonly<Record<string, string>> = {
    "/keys/rsa.p8": rsaPem,
    "/keys/p384.p8": p384Pem,
    "/keys/public.pem": publicPem,
    "/keys/garbage.p8": `-----BEGIN PRIVATE KEY-----\n${SECRET}\n-----END PRIVATE KEY-----\n`,
  };
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
      config: { providers: [{ name: "github", issuer: "https://evil.example", clientId: "x", clientSecret: SECRET }] },
      connector: null,
      mentions: "providers[0].issuer is fixed for the github preset",
    },
    {
      name: "microsoft, which is no longer a preset",
      config: { providers: [{ name: "microsoft", clientId: "x", clientSecret: SECRET }] },
      connector: null,
      mentions: "providers[0]: \"microsoft\" is no longer a built-in sign-in option",
    },
    {
      name: "a bare microsoft entry",
      config: { providers: [{ name: "microsoft" }] },
      connector: null,
      mentions: "providers[0]: \"microsoft\" is no longer a built-in sign-in option",
    },
    {
      name: "apple's issuer cannot be overridden",
      config: { providers: [{ ...APPLE_ENTRY, issuer: "https://evil.example" }] },
      connector: null,
      mentions: "providers[0].issuer is fixed for the apple preset",
    },
    {
      name: "apple with a client secret",
      config: { providers: [{ ...APPLE_ENTRY, clientSecret: SECRET }] },
      connector: null,
      mentions: "providers[0].clientSecret is not used by apple",
    },
    { name: "apple without a Services ID", config: { providers: [{ ...APPLE_ENTRY, clientId: undefined }] }, connector: null, mentions: "providers[0].clientId" },
    { name: "apple with a malformed team id", config: { providers: [{ ...APPLE_ENTRY, teamId: SECRET }] }, connector: null, mentions: "providers[0].teamId" },
    { name: "apple without a key id", config: { providers: [{ ...APPLE_ENTRY, keyId: undefined }] }, connector: null, mentions: "providers[0].keyId" },
    { name: "apple without a key file", config: { providers: [{ ...APPLE_ENTRY, privateKeyPath: undefined }] }, connector: null, mentions: "providers[0].privateKeyPath" },
    {
      name: "apple with a key file that cannot be read",
      config: { providers: [{ ...APPLE_ENTRY, privateKeyPath: "/keys/missing.p8" }] },
      connector: null,
      mentions: "providers[0].privateKeyPath: cannot read the key file (ENOENT)",
    },
    {
      name: "apple with a key file that is not a private key",
      config: { providers: [{ ...APPLE_ENTRY, privateKeyPath: "/keys/garbage.p8" }] },
      connector: null,
      mentions: "providers[0].privateKeyPath: the file is not a PEM private key",
    },
    {
      name: "apple with a public key",
      config: { providers: [{ ...APPLE_ENTRY, privateKeyPath: "/keys/public.pem" }] },
      connector: null,
      mentions: "providers[0].privateKeyPath: the file is not a PEM private key",
    },
    {
      name: "apple with an RSA key",
      config: { providers: [{ ...APPLE_ENTRY, privateKeyPath: "/keys/rsa.p8" }] },
      connector: null,
      mentions: "providers[0].privateKeyPath must hold an elliptic-curve P-256 key",
    },
    {
      name: "apple with a P-384 key",
      config: { providers: [{ ...APPLE_ENTRY, privateKeyPath: "/keys/p384.p8" }] },
      connector: null,
      mentions: "providers[0].privateKeyPath must hold an elliptic-curve P-256 key",
    },
    {
      name: "an apple-only key on another provider",
      config: { providers: [{ name: "github", clientId: "x", clientSecret: SECRET, teamId: "TEAM123456" }] },
      connector: null,
      mentions: "providers[0].teamId is only for the apple preset",
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
      name: "a provider named like the built-in passkey sign-in",
      config: { providers: [{ name: "passkey", displayName: "Passkey", issuer: "https://idp.example", clientId: "x", clientSecret: SECRET }] },
      connector: null,
      mentions: 'providers[0].name "passkey" is reserved',
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
      const parsed = parseIdentityProvidersConfig({ text: JSON.stringify(row.config), connectorGoogleCredentials: row.connector, readKeyFile: keyFiles(keyFileRows) });
      assert.equal(parsed.kind, "error");
      if (parsed.kind !== "error") return;
      assert.ok(parsed.message.includes(row.mentions), `${parsed.message} should mention ${row.mentions}`);
      assert.ok(!parsed.message.includes(SECRET), parsed.message);
      assert.ok(!parsed.message.includes("BEGIN"), "no key material in the message");
    });
  }

  test("text that is not JSON is rejected with the parser's reason", () => {
    const parsed = parseIdentityProvidersConfig({ text: "{ nope", connectorGoogleCredentials: null, readKeyFile: NO_FILES });
    assert.equal(parsed.kind, "error");
    assert.match(parsed.kind === "error" ? parsed.message : "", /not JSON/);
  });
});

describe("OpenID Connect sign-in", () => {
  const OKTA: Extract<IdentityProviderSpec, Readonly<{ protocol: "oidc" }>> = {
    protocol: "oidc",
    name: "okta",
    displayName: "Okta",
    issuer: "https://acme.okta.example",
    issuers: ["https://acme.okta.example"],
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

describe("Sign in with Apple", () => {
  const APPLE: Extract<IdentityProviderSpec, Readonly<{ protocol: "apple" }>> = {
    protocol: "apple",
    name: "apple",
    displayName: "Apple",
    clientId: "com.sashaslides.signin",
    teamId: "TEAM123456",
    keyId: "ABC123DEFG",
    privateKey: APPLE_KEY.privateKey,
    scopes: ["name", "email"],
  };
  const RELAY = "x7k2q9@privaterelay.appleid.com";

  function appleHarness(
    options: Readonly<{ signingKey: typeof APPLE_KEY }>,
  ): Readonly<{ provider: IdentityProvider; signIn: (row: Readonly<{ emailVerified: FakeEmailVerified; email: string | null; tamper: IdTokenTamper }>) => Promise<SignInOutcome>; requestedUrls: () => readonly string[] }> {
    const apple = createFakeApple({ clientId: APPLE.clientId, teamId: "TEAM123456", keyId: "ABC123DEFG", clientPublicKey: APPLE_KEY.publicKey, now: () => NOW });
    const network = fakeFetch({ routes: [apple.route] });
    const spec: IdentityProviderSpec = { ...APPLE, privateKey: options.signingKey.privateKey };
    const provider = createIdentityProvider({ spec, fetch: network.fetch, now: () => NOW, randomToken, timeoutMs: 5000 });
    return {
      provider,
      requestedUrls: network.requestedUrls,
      signIn: async ({ emailVerified, email, tamper }) => {
        const begun = await provider.begin({ redirectUri: REDIRECT_URI });
        if (begun.kind !== "redirect") throw new Error(begun.reason);
        const callback = apple.authorize({ authorizationUrl: begun.location, subject: "001234.abcdef.0987", email, emailVerified, tamper });
        return provider.complete({ pending: begun.pending, parameters: new URLSearchParams(callback), redirectUri: REDIRECT_URI });
      },
    };
  }

  test("the authorization URL asks for name and email by form POST, with PKCE S256, state and nonce", async () => {
    const { provider, requestedUrls } = appleHarness({ signingKey: APPLE_KEY });
    assert.equal(provider.responseMode, "form_post");
    const begun = await provider.begin({ redirectUri: REDIRECT_URI });
    assert.equal(begun.kind, "redirect");
    if (begun.kind !== "redirect") return;
    const query = new URL(begun.location).searchParams;
    assert.deepEqual(
      Object.fromEntries(["response_type", "response_mode", "client_id", "redirect_uri", "scope", "code_challenge_method", "state", "nonce"].map((key) => [key, query.get(key)])),
      {
        response_type: "code",
        response_mode: "form_post",
        client_id: "com.sashaslides.signin",
        redirect_uri: REDIRECT_URI,
        scope: "name email",
        code_challenge_method: "S256",
        state: begun.pending.state,
        nonce: begun.pending.nonce,
      },
    );
    assert.deepEqual(requestedUrls(), [`${APPLE_ISSUER}/.well-known/openid-configuration`]);
  });

  test("the client secret is an ES256 JWT in raw r||s form, signed by the .p8 key, valid for minutes", () => {
    const secret = appleClientSecret({ clientId: APPLE.clientId, teamId: "TEAM123456", keyId: "ABC123DEFG", privateKey: APPLE_KEY.privateKey, nowMs: NOW.getTime() });
    const [header, claims, signature] = secret.split(".").map((part) => Buffer.from(part, "base64url"));
    assert.deepEqual(JSON.parse(header?.toString("utf-8") ?? ""), { alg: "ES256", kid: "ABC123DEFG" });
    const nowSeconds = Math.floor(NOW.getTime() / 1000);
    assert.deepEqual(JSON.parse(claims?.toString("utf-8") ?? ""), {
      iss: "TEAM123456",
      iat: nowSeconds,
      exp: nowSeconds + 300,
      aud: "https://appleid.apple.com",
      sub: "com.sashaslides.signin",
    });
    assert.equal(signature?.length, 64, "IEEE P1363, not DER");
    const signedInput = Buffer.from(secret.split(".").slice(0, 2).join("."), "utf-8");
    assert.ok(verify("sha256", signedInput, { key: APPLE_KEY.publicKey, dsaEncoding: "ieee-p1363" }, signature ?? Buffer.alloc(0)));
  });

  test("an honest sign-in yields apple + Apple's subject, with the relay address as the hint", async () => {
    const outcome = await appleHarness({ signingKey: APPLE_KEY }).signIn({ email: RELAY, emailVerified: "true", tamper: { claims: { is_private_email: "true" } } });
    assert.deepEqual(outcome, {
      kind: "signed-in",
      identity: { provider: "apple", subject: "001234.abcdef.0987", email: RELAY, emailVerified: true },
    });
  });

  const nowSeconds = Math.floor(NOW.getTime() / 1000);
  const rows: readonly Readonly<{ name: string; tamper: IdTokenTamper; accepted: boolean }>[] = [
    { name: "control: honest token", tamper: {}, accepted: true },
    { name: "audience is another Services ID", tamper: { claims: { aud: "com.example.other" } }, accepted: false },
    { name: "issuer is not Apple", tamper: { claims: { iss: "https://appleid.apple.com.evil.example" } }, accepted: false },
    { name: "expired an hour ago", tamper: { claims: { exp: nowSeconds - 3600 } }, accepted: false },
    { name: "nonce from another sign-in", tamper: { claims: { nonce: "stolen-nonce" } }, accepted: false },
    { name: "signed by a key not in Apple's JWKS", tamper: { signing: "foreign-key" }, accepted: false },
  ];
  for (const row of rows) {
    test(`Apple ID token check: ${row.name} → ${row.accepted ? "accepted" : "rejected"}`, async () => {
      const outcome = await appleHarness({ signingKey: APPLE_KEY }).signIn({ email: RELAY, emailVerified: "true", tamper: row.tamper });
      assert.equal(outcome.kind, row.accepted ? "signed-in" : "failed", JSON.stringify(outcome));
    });
  }

  const emailRows: readonly Readonly<{ emailVerified: FakeEmailVerified; email: string | null; expected: Readonly<{ email: string | null; emailVerified: boolean }> }>[] = [
    { emailVerified: "true", email: RELAY, expected: { email: RELAY, emailVerified: true } },
    { emailVerified: true, email: "ada@example.com", expected: { email: "ada@example.com", emailVerified: true } },
    { emailVerified: "false", email: "ada@example.com", expected: { email: "ada@example.com", emailVerified: false } },
    { emailVerified: false, email: "ada@example.com", expected: { email: "ada@example.com", emailVerified: false } },
    { emailVerified: "true", email: null, expected: { email: null, emailVerified: false } },
  ];
  for (const row of emailRows) {
    test(`email_verified ${JSON.stringify(row.emailVerified)} with ${row.email ?? "no email"} → verified ${String(row.expected.emailVerified)}`, async () => {
      const outcome = await appleHarness({ signingKey: APPLE_KEY }).signIn({ email: row.email, emailVerified: row.emailVerified, tamper: {} });
      assert.equal(outcome.kind, "signed-in", JSON.stringify(outcome));
      if (outcome.kind !== "signed-in") return;
      assert.deepEqual({ email: outcome.identity.email, emailVerified: outcome.identity.emailVerified }, row.expected);
    });
  }

  const keyRows: readonly Readonly<{ name: string; signingKey: typeof APPLE_KEY; accepted: boolean }>[] = [
    { name: "control: the key Apple holds", signingKey: APPLE_KEY, accepted: true },
    { name: "another P-256 key", signingKey: generateAppleKey(), accepted: false },
  ];
  for (const row of keyRows) {
    test(`client secret signed with ${row.name} → token exchange ${row.accepted ? "accepted" : "refused"}`, async () => {
      const outcome = await appleHarness({ signingKey: row.signingKey }).signIn({ email: RELAY, emailVerified: "true", tamper: {} });
      assert.equal(outcome.kind, row.accepted ? "signed-in" : "failed", JSON.stringify(outcome));
      if (outcome.kind === "failed") assert.match(outcome.reason, /invalid_client/);
    });
  }

  test("the user cancelling at Apple fails the sign-in and names Apple's error", async () => {
    const { provider } = appleHarness({ signingKey: APPLE_KEY });
    const begun = await provider.begin({ redirectUri: REDIRECT_URI });
    if (begun.kind !== "redirect") throw new Error(begun.reason);
    const outcome = await provider.complete({
      pending: begun.pending,
      parameters: new URLSearchParams({ error: "user_cancelled_authorize", state: begun.pending.state }),
      redirectUri: REDIRECT_URI,
    });
    assert.equal(outcome.kind, "failed");
    assert.match(outcome.kind === "failed" ? outcome.reason : "", /user_cancelled_authorize/);
  });
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
