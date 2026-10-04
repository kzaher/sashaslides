/**
 * The remote server's authorization layer, asserted against a fake Google and a fake Drive.
 * No Google credentials, no network beyond a loopback listener on an ephemeral port.
 *
 *   cd mcp/sasha-slides && npx tsx --test test/oauth.test.ts
 *
 * Ordered to follow the implementation: redirect matching, the discovery documents, then
 * the brokering chain end to end over real HTTP, then the two properties that matter most
 * — a token issued for one user cannot reach another user's Drive, and a dead refresh token
 * says `invalid_grant`.
 */
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createAuthorizationServer,
  defaultAuthorizationServerConfig,
  randomUrlSafeToken,
} from "../http/authorization-server";
import { createSashaSlidesHttpServer } from "../http/http-server";
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  BROKERED_SCOPES,
  endpointsFor,
  PROTECTED_RESOURCE_METADATA_PATH,
} from "../http/oauth-metadata";
import { inMemoryAuthStore, type AuthStore } from "../http/oauth-store";
import { CLAUDE_HOSTED_REDIRECT_URI, matchRedirectUri } from "../http/redirect-uris";
import type { UserDriveFactory } from "../http/user-drive";
import {
  brokeredEnvironmentResolver,
  brokeredFeedbackEnvironmentResolver,
  createSashaSlidesServer,
} from "../server";
import type { ProposalEnvironment } from "../proposal";
import { createFakeDrive, type FakeDrive } from "./fake-drive";
import { createFakeGoogle, fakeGoogleIdentity, FAKE_GOOGLE_AUTHORIZE_URL, type FakeGoogle } from "./fake-google";

/** Configured, not derived from the Host header: `resource` must match it exactly. */
const PUBLIC_URL = "https://slides.example.test";
const MCP_URL = `${PUBLIC_URL}/mcp`;

describe("matchRedirectUri", () => {
  test("ignores the port for a loopback redirect, and treats localhost as 127.0.0.1", () => {
    const registered = ["http://127.0.0.1:1/oauth/callback"];
    // RFC 8252 section 7.3: Claude Code picks the port at runtime, so it cannot be fixed
    // at registration time.
    assert.equal(
      matchRedirectUri({ registered, requested: "http://127.0.0.1:54321/oauth/callback" }).kind,
      "allowed",
    );
    assert.equal(
      matchRedirectUri({ registered, requested: "http://localhost:7777/oauth/callback" }).kind,
      "allowed",
    );
    assert.equal(
      matchRedirectUri({
        registered: ["http://localhost/cb"],
        requested: "http://127.0.0.1:9/cb",
      }).kind,
      "allowed",
    );
  });

  test("rejects a non-loopback host, a different path and a different scheme", () => {
    const registered = ["http://127.0.0.1:1/oauth/callback"];
    for (const requested of [
      "http://evil.example.com:54321/oauth/callback",
      "http://127.0.0.1.evil.example.com/oauth/callback",
      "http://127.0.0.1:54321/other",
      "https://127.0.0.1:54321/oauth/callback",
      "not-a-uri",
    ]) {
      assert.equal(
        matchRedirectUri({ registered, requested }).kind,
        "rejected",
        `${requested} must not be allowed by ${registered.join(",")}`,
      );
    }
  });

  test("matches Claude's hosted callback exactly", () => {
    assert.equal(
      matchRedirectUri({ registered: [CLAUDE_HOSTED_REDIRECT_URI], requested: CLAUDE_HOSTED_REDIRECT_URI })
        .kind,
      "allowed",
    );
    assert.equal(
      matchRedirectUri({
        registered: [CLAUDE_HOSTED_REDIRECT_URI],
        requested: "https://claude.ai.evil.example.com/api/mcp/auth_callback",
      }).kind,
      "rejected",
    );
  });
});

describe("discovery", () => {
  test("an unauthenticated MCP call is a 401 carrying the resource_metadata challenge", async () => {
    const harness = await startHarness();
    try {
      const response = await fetch(`${harness.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(response.status, 401, "Claude ignores WWW-Authenticate on anything but a 401");
      const challenge = response.headers.get("www-authenticate");
      assert.ok(challenge !== null, "the 401 must carry WWW-Authenticate");
      assert.match(challenge, /^Bearer /);
      assert.ok(
        challenge.includes(`resource_metadata="${PUBLIC_URL}${PROTECTED_RESOURCE_METADATA_PATH}/mcp"`),
        `challenge must point at the metadata document, got: ${challenge}`,
      );
      assert.ok(challenge.includes(`resource="${MCP_URL}"`));
      assert.equal(response.headers.get("access-control-expose-headers"), "WWW-Authenticate, Mcp-Session-Id");
    } finally {
      await harness.dispose();
    }
  });

  test("protected resource metadata names this exact MCP URL and one authorization server", async () => {
    const harness = await startHarness();
    try {
      const response = await fetch(`${harness.baseUrl}${PROTECTED_RESOURCE_METADATA_PATH}/mcp`);
      assert.equal(response.status, 200);
      // A WWW-Authenticate on a 200 is ignored by Claude, so it must not be the carrier.
      assert.equal(response.headers.get("www-authenticate"), null);
      const document = requireRecord(await response.json());
      assert.equal(document["resource"], MCP_URL, "resource must equal the MCP server URL, path included");
      assert.deepEqual(document["authorization_servers"], [PUBLIC_URL], "Claude reads only the first entry");
      assert.deepEqual(document["scopes_supported"], [...BROKERED_SCOPES]);
      assert.deepEqual(document["bearer_methods_supported"], ["header"]);
      assert.equal(typeof document["resource_name"], "string");

      // The bare well-known path answers too, for clients that do not append the path.
      const bare = await fetch(`${harness.baseUrl}${PROTECTED_RESOURCE_METADATA_PATH}`);
      assert.equal(bare.status, 200);
      assert.equal(requireRecord(await bare.json())["resource"], MCP_URL);
    } finally {
      await harness.dispose();
    }
  });

  test("authorization server metadata advertises S256 and pushes Claude onto DCR, not CIMD", async () => {
    const harness = await startHarness();
    try {
      const response = await fetch(`${harness.baseUrl}${AUTHORIZATION_SERVER_METADATA_PATH}`);
      assert.equal(response.status, 200);
      const document = requireRecord(await response.json());
      for (const field of [
        "issuer",
        "authorization_endpoint",
        "token_endpoint",
        "registration_endpoint",
        "response_types_supported",
        "grant_types_supported",
      ]) {
        assert.ok(document[field] !== undefined, `RFC 8414 requires ${field}`);
      }
      assert.equal(document["issuer"], PUBLIC_URL);
      assert.equal(document["authorization_endpoint"], `${PUBLIC_URL}/authorize`);
      assert.equal(document["token_endpoint"], `${PUBLIC_URL}/token`);
      assert.equal(document["registration_endpoint"], `${PUBLIC_URL}/register`);
      assert.deepEqual(document["code_challenge_methods_supported"], ["S256"]);
      assert.deepEqual(document["response_types_supported"], ["code"]);
      assert.deepEqual(document["grant_types_supported"], ["authorization_code", "refresh_token"]);
      // CIMD is chosen only when BOTH of these say yes; "none" is required for our public
      // clients, so the CIMD flag must be the one that says no.
      assert.deepEqual(document["token_endpoint_auth_methods_supported"], ["none"]);
      assert.equal(document["client_id_metadata_document_supported"], false);
    } finally {
      await harness.dispose();
    }
  });
});

describe("registration", () => {
  test("registers a public client over JSON and always accepts Claude's hosted callback", async () => {
    const harness = await startHarness();
    try {
      const response = await fetch(`${harness.baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude",
          redirect_uris: ["http://127.0.0.1:1/oauth/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
        }),
      });
      assert.equal(response.status, 201);
      const document = requireRecord(await response.json());
      assert.equal(typeof document["client_id"], "string");
      assert.equal(document["token_endpoint_auth_method"], "none");
      assert.deepEqual(document["redirect_uris"], [
        "http://127.0.0.1:1/oauth/callback",
        CLAUDE_HOSTED_REDIRECT_URI,
      ]);
      assert.equal(document["client_name"], "Claude");
    } finally {
      await harness.dispose();
    }
  });

  test("rejects a form-encoded registration with 415: /register is JSON, /token is not", async () => {
    const harness = await startHarness();
    try {
      const response = await fetch(`${harness.baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "redirect_uris=http%3A%2F%2F127.0.0.1%3A1%2Fcb",
      });
      assert.equal(response.status, 415);
      assert.equal(response.headers.get("accept"), "application/json");
    } finally {
      await harness.dispose();
    }
  });

  test("rejects a client that wants to authenticate with a secret", async () => {
    const harness = await startHarness();
    try {
      const response = await fetch(`${harness.baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["http://127.0.0.1:1/cb"],
          token_endpoint_auth_method: "client_secret_post",
        }),
      });
      assert.equal(response.status, 400);
      assert.equal(requireRecord(await response.json())["error"], "invalid_request");
    } finally {
      await harness.dispose();
    }
  });
});

describe("authorize", () => {
  test("redirects the user to Google and keeps the client's state out of Google's hands", async () => {
    const harness = await startHarness();
    try {
      const clientId = await registerClient({ harness, redirectUris: ["http://127.0.0.1:1/cb"] });
      const pkce = newPkce();
      const response = await authorize({
        harness,
        parameters: {
          response_type: "code",
          client_id: clientId,
          redirect_uri: "http://localhost:45678/cb",
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
          state: "claude-state-1",
          resource: MCP_URL,
        },
      });
      assert.equal(response.status, 302);
      const location = response.headers.get("location");
      assert.ok(location !== null);
      assert.ok(location.startsWith(FAKE_GOOGLE_AUTHORIZE_URL), `expected a Google redirect, got ${location}`);
      const toGoogle = new URL(location);
      assert.equal(toGoogle.searchParams.get("redirect_uri"), `${PUBLIC_URL}/oauth/google/callback`);
      assert.equal(toGoogle.searchParams.get("access_type"), "offline");
      assert.equal(toGoogle.searchParams.get("scope"), BROKERED_SCOPES.join(" "));
      const stateToGoogle = toGoogle.searchParams.get("state");
      assert.ok(stateToGoogle !== null);
      assert.notEqual(stateToGoogle, "claude-state-1", "our state toward Google is ours, not the client's");
    } finally {
      await harness.dispose();
    }
  });

  test("a redirect_uri the client never registered is a flat 400, never a redirect", async () => {
    const harness = await startHarness();
    try {
      const clientId = await registerClient({ harness, redirectUris: ["http://127.0.0.1:1/cb"] });
      const pkce = newPkce();
      const response = await authorize({
        harness,
        parameters: {
          response_type: "code",
          client_id: clientId,
          redirect_uri: "https://evil.example.com/cb",
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
        },
      });
      // Bouncing this to the requested URI is the confused-deputy hole.
      assert.equal(response.status, 400);
      assert.equal(response.headers.get("location"), null);
      assert.equal(requireRecord(await response.json())["error"], "invalid_request");
    } finally {
      await harness.dispose();
    }
  });

  test("PKCE is mandatory and only S256 is accepted", async () => {
    const harness = await startHarness();
    try {
      const clientId = await registerClient({ harness, redirectUris: ["http://127.0.0.1:1/cb"] });
      const withoutPkce = await authorize({
        harness,
        parameters: {
          response_type: "code",
          client_id: clientId,
          redirect_uri: "http://127.0.0.1:1/cb",
        },
      });
      // The redirect target is registered, so OAuth says report the error there.
      assert.equal(withoutPkce.status, 302);
      const missing = new URL(requireHeader({ response: withoutPkce, name: "location" }));
      assert.equal(missing.searchParams.get("error"), "invalid_request");
      assert.match(missing.searchParams.get("error_description") ?? "", /code_challenge is required/);

      const plain = await authorize({
        harness,
        parameters: {
          response_type: "code",
          client_id: clientId,
          redirect_uri: "http://127.0.0.1:1/cb",
          code_challenge: "abc",
          code_challenge_method: "plain",
        },
      });
      const rejected = new URL(requireHeader({ response: plain, name: "location" }));
      assert.equal(rejected.searchParams.get("error"), "invalid_request");
      assert.match(rejected.searchParams.get("error_description") ?? "", /must be S256/);
    } finally {
      await harness.dispose();
    }
  });

  test("a resource that is not exactly our MCP URL is invalid_target", async () => {
    const harness = await startHarness();
    try {
      const clientId = await registerClient({ harness, redirectUris: ["http://127.0.0.1:1/cb"] });
      const pkce = newPkce();
      const response = await authorize({
        harness,
        parameters: {
          response_type: "code",
          client_id: clientId,
          redirect_uri: "http://127.0.0.1:1/cb",
          code_challenge: pkce.challenge,
          code_challenge_method: "S256",
          resource: PUBLIC_URL,
        },
      });
      const location = new URL(requireHeader({ response, name: "location" }));
      assert.equal(location.searchParams.get("error"), "invalid_target");
    } finally {
      await harness.dispose();
    }
  });

  test("a replayed Google callback finds no state and is refused", async () => {
    const harness = await startHarness();
    try {
      const clientId = await registerClient({ harness, redirectUris: ["http://127.0.0.1:1/cb"] });
      const pkce = newPkce();
      const started = await beginSignIn({
        harness,
        clientId,
        redirectUri: "http://127.0.0.1:1/cb",
        challenge: pkce.challenge,
        clientState: "s",
      });
      harness.google.stageConsent({
        code: "google-code-1",
        identity: fakeGoogleIdentity({ subject: "user-a", email: "a@example.test", refreshToken: "ga" }),
      });
      const first = await callback({ harness, code: "google-code-1", state: started.brokerState });
      assert.equal(first.status, 302);
      const replay = await callback({ harness, code: "google-code-1", state: started.brokerState });
      assert.equal(replay.status, 400);
      assert.match(asString(requireRecord(await replay.json())["error_description"]) ?? "", /already-used state/);
    } finally {
      await harness.dispose();
    }
  });
});

describe("token", () => {
  test("accepts form-urlencoded and rejects a JSON body with 415", async () => {
    const harness = await startHarness();
    try {
      const signedIn = await signIn({ harness, user: userA() });
      assert.equal(typeof signedIn.tokens.access_token, "string");
      assert.equal(signedIn.tokens.token_type, "Bearer");
      assert.equal(typeof signedIn.tokens.refresh_token, "string");
      assert.equal(signedIn.tokens.scope, BROKERED_SCOPES.join(" "));

      const asJson = await fetch(`${harness.baseUrl}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code: "whatever" }),
      });
      assert.equal(asJson.status, 415, "a JSON body must be 415, not a parse error");
      assert.equal(asJson.headers.get("accept"), "application/x-www-form-urlencoded");
    } finally {
      await harness.dispose();
    }
  });

  test("a wrong code_verifier is invalid_grant, and the code is spent either way", async () => {
    const harness = await startHarness();
    try {
      const clientId = await registerClient({ harness, redirectUris: ["http://127.0.0.1:1/cb"] });
      const pkce = newPkce();
      const code = await completeGoogleLeg({
        harness,
        clientId,
        redirectUri: "http://127.0.0.1:1/cb",
        challenge: pkce.challenge,
        user: userA(),
      });
      const wrong = await postForm({
        harness,
        path: "/token",
        fields: {
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: "http://127.0.0.1:1/cb",
          code_verifier: newPkce().verifier,
        },
      });
      assert.equal(wrong.status, 400);
      assert.equal(requireRecord(await wrong.json())["error"], "invalid_grant");

      // Single use: even the correct verifier cannot redeem it now.
      const retry = await postForm({
        harness,
        path: "/token",
        fields: {
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          redirect_uri: "http://127.0.0.1:1/cb",
          code_verifier: pkce.verifier,
        },
      });
      assert.equal(retry.status, 400);
      assert.equal(requireRecord(await retry.json())["error"], "invalid_grant");
    } finally {
      await harness.dispose();
    }
  });

  test("a dead refresh token is invalid_grant, and refresh tokens rotate", async () => {
    const harness = await startHarness();
    try {
      const signedIn = await signIn({ harness, user: userA() });

      const unknown = await refresh({ harness, clientId: signedIn.clientId, refreshToken: "not-a-token" });
      assert.equal(unknown.status, 400);
      assert.equal(requireRecord(await unknown.json())["error"], "invalid_grant", "never invalid_request");

      const rotated = await refresh({
        harness,
        clientId: signedIn.clientId,
        refreshToken: signedIn.tokens.refresh_token,
      });
      assert.equal(rotated.status, 200);
      const refreshedTokens = asTokenResponse(await rotated.json());
      assert.notEqual(refreshedTokens.refresh_token, signedIn.tokens.refresh_token, "public clients rotate");
      assert.equal(rotated.headers.get("cache-control"), "no-store");

      // The rotated-away token is dead.
      const reused = await refresh({
        harness,
        clientId: signedIn.clientId,
        refreshToken: signedIn.tokens.refresh_token,
      });
      assert.equal(reused.status, 400);
      assert.equal(requireRecord(await reused.json())["error"], "invalid_grant");

      // And so is a live token whose Google grant the user revoked.
      harness.google.revoke({ refreshToken: "refresh-user-a" });
      const revoked = await refresh({
        harness,
        clientId: signedIn.clientId,
        refreshToken: refreshedTokens.refresh_token,
      });
      assert.equal(revoked.status, 400);
      assert.equal(requireRecord(await revoked.json())["error"], "invalid_grant");
    } finally {
      await harness.dispose();
    }
  });
});

describe("the protected resource", () => {
  test("acts as the signed-in user, and a token for A cannot reach B's Drive", async () => {
    const harness = await startHarness();
    try {
      const alice = await signIn({ harness, user: userA() });
      const bob = await signIn({ harness, user: userB() });
      assert.notEqual(alice.tokens.access_token, bob.tokens.access_token);

      const staged = requireRecord(
        await callTool({
          harness,
          accessToken: alice.tokens.access_token,
          name: "propose_slides",
          toolArguments: { slides: [{ path: "/slides/candidate-1.html", label: "option 1" }] },
        }),
      );
      const proposalId = asString(staged["proposalId"]);
      assert.ok(proposalId !== null, `propose_slides failed: ${JSON.stringify(staged)}`);

      // The files landed in Alice's Drive — the candidate, its session-log event, then the
      // manifest and READY last.
      const aliceDrive = harness.driveFor({ subject: "user-a" });
      assert.deepEqual(
        aliceDrive
          .calls()
          .filter((call) => call.op === "createFile")
          .map((call) => call.name),
        ["01.html", "1791028800000-aaa111-slides-staged.json", "manifest.json", "READY"],
      );
      // ...and Bob's Drive was never touched.
      assert.deepEqual(harness.driveFor({ subject: "user-b" }).calls(), []);

      // Bob holding his own valid token still cannot see Alice's proposal, even though the
      // test clock and random suffix make both users mint the identical proposalId.
      const seenByBob = requireRecord(
        await callTool({
          harness,
          accessToken: bob.tokens.access_token,
          name: "proposal_state",
          toolArguments: { proposalId },
        }),
      );
      assert.equal(seenByBob["exists"], false);
      assert.equal(seenByBob["ready"], false);
      assert.equal(seenByBob["slideFileCount"], 0);

      const seenByAlice = requireRecord(
        await callTool({
          harness,
          accessToken: alice.tokens.access_token,
          name: "proposal_state",
          toolArguments: { proposalId },
        }),
      );
      assert.equal(seenByAlice["exists"], true);
      assert.equal(seenByAlice["ready"], true);
      assert.equal(seenByAlice["count"], 1);
    } finally {
      await harness.dispose();
    }
  });

  test("refuses a token this server did not issue, including a Google access token", async () => {
    const harness = await startHarness();
    try {
      const alice = await signIn({ harness, user: userA() });
      for (const token of ["fake-access-for-user-a", "refresh-user-a", alice.tokens.refresh_token, "ya29.pretend"]) {
        const response = await fetch(`${harness.baseUrl}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        assert.equal(response.status, 401, `${token} must not be accepted as a bearer`);
        assert.match(requireHeader({ response, name: "www-authenticate" }), /error="invalid_token"/);
      }
      // The access token this AS did mint still works.
      const response = await fetch(`${harness.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${alice.tokens.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.notEqual(response.status, 401);
      await response.body?.cancel();
    } finally {
      await harness.dispose();
    }
  });

  test("a token whose Google grant has been forgotten is rejected, never silently shared", async () => {
    const harness = await startHarness();
    try {
      const alice = await signIn({ harness, user: userA() });
      // As a revocation sweep or a store eviction would leave it.
      await harness.store.googleIdentities.remove({ key: "user-a" });
      const response = await fetch(`${harness.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${alice.tokens.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(response.status, 401);
    } finally {
      await harness.dispose();
    }
  });
});

type Harness = Readonly<{
  baseUrl: string;
  google: FakeGoogle;
  store: AuthStore;
  driveFor(options: Readonly<{ subject: string }>): FakeDrive;
  dispose(): Promise<void>;
}>;

async function startHarness(): Promise<Harness> {
  const google = createFakeGoogle();
  const store = inMemoryAuthStore();
  const endpoints = endpointsFor({ publicUrl: PUBLIC_URL });
  const drives = new Map<string, FakeDrive>();
  const driveFor = (options: Readonly<{ subject: string }>): FakeDrive => {
    const existing = drives.get(options.subject);
    if (existing !== undefined) return existing;
    const created = createFakeDrive();
    drives.set(options.subject, created);
    return created;
  };

  const authorizationServer = createAuthorizationServer({
    config: defaultAuthorizationServerConfig({ endpoints }),
    store,
    google: google.broker,
    now: () => new Date(),
    randomToken: randomUrlSafeToken,
    warn: () => undefined,
  });

  /** One in-memory Drive per Google subject: the whole point of the cross-user test. */
  const userDrive: UserDriveFactory = {
    forGoogleSubject: async ({ subject }) => {
      const identity = await store.googleIdentities.get({ key: subject });
      if (identity === null) {
        return { kind: "unavailable", message: "no Google grant is stored for this user" };
      }
      return { kind: "ok", drive: driveFor({ subject }).channel };
    },
    // This suite asserts cross-user Drive isolation; it stages no comments, so the channel
    // declines rather than pretending. The decline still has to be per-subject, so an
    // unidentified caller cannot reach it either.
    feedbackForGoogleSubject: async ({ subject }) => {
      const identity = await store.googleIdentities.get({ key: subject });
      return identity === null
        ? { kind: "unavailable", message: "no Google grant is stored for this user" }
        : { kind: "unavailable", message: "this fake serves no comment threads" };
    },
  };

  const resolveEnvironment = brokeredEnvironmentResolver({
    userDrive,
    environmentFor: ({ drive }) => frozenEnvironment({ drive }),
  });
  const server = createSashaSlidesHttpServer({
    authorizationServer,
    createMcpServer: () =>
      createSashaSlidesServer({
        resolveEnvironment,
        // This test is about per-user Drive isolation; the comment channel has no brokered
        // resolver yet, so it declines exactly as the HTTP composition root does.
        resolveFeedbackEnvironment: brokeredFeedbackEnvironmentResolver({ userDrive }),
        instructions: "test: the client instructions are asserted in workflow-guidance.test.ts",
      }),
    instrumentTransport: (inner) => inner,
    warn: () => undefined,
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? (address as AddressInfo).port : 0);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    google,
    store,
    driveFor,
    dispose: () =>
      new Promise<void>((resolve, reject) => {
        server.close((cause) => (cause === undefined ? resolve() : reject(cause)));
      }),
  };
}

/**
 * A fixed clock and a fixed random suffix, so both users mint the same `proposalId` — which
 * makes the cross-user test prove isolation rather than id collision avoidance.
 */
function frozenEnvironment(options: Readonly<{ drive: ProposalEnvironment["drive"] }>): ProposalEnvironment {
  return {
    drive: options.drive,
    now: () => new Date("2026-10-03T12:00:00.000Z"),
    randomSuffix: () => "aaa111",
    sleep: () => Promise.resolve(),
    statFile: () => ({ bytes: 2048 }),
    warn: () => undefined,
  };
}

type TestUser = Readonly<{ subject: string; email: string; refreshToken: string; googleCode: string }>;

function userA(): TestUser {
  return { subject: "user-a", email: "a@example.test", refreshToken: "refresh-user-a", googleCode: "code-a" };
}

function userB(): TestUser {
  return { subject: "user-b", email: "b@example.test", refreshToken: "refresh-user-b", googleCode: "code-b" };
}

type SignedIn = Readonly<{ clientId: string; tokens: TokenResponseBody }>;

type TokenResponseBody = Readonly<{
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}>;

/** The whole chain: register, authorize, Google, callback, token. */
async function signIn(options: Readonly<{ harness: Harness; user: TestUser }>): Promise<SignedIn> {
  const { harness, user } = options;
  const redirectUri = "http://127.0.0.1:1/oauth/callback";
  const clientId = await registerClient({ harness, redirectUris: [redirectUri] });
  const pkce = newPkce();
  const code = await completeGoogleLeg({ harness, clientId, redirectUri, challenge: pkce.challenge, user });
  const response = await postForm({
    harness,
    path: "/token",
    fields: {
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier,
    },
  });
  const body = await response.text();
  assert.equal(response.status, 200, `token exchange failed: ${body}`);
  return { clientId, tokens: asTokenResponse(JSON.parse(body) as unknown) };
}

/** Everything up to (not including) `/token`: returns our authorization code. */
async function completeGoogleLeg(
  options: Readonly<{
    harness: Harness;
    clientId: string;
    redirectUri: string;
    challenge: string;
    user: TestUser;
  }>,
): Promise<string> {
  const { harness, clientId, redirectUri, challenge, user } = options;
  const started = await beginSignIn({ harness, clientId, redirectUri, challenge, clientState: "claude-state" });
  harness.google.stageConsent({
    code: user.googleCode,
    identity: fakeGoogleIdentity({
      subject: user.subject,
      email: user.email,
      refreshToken: user.refreshToken,
    }),
  });
  const response = await callback({ harness, code: user.googleCode, state: started.brokerState });
  assert.equal(response.status, 302, `callback failed: ${await response.text()}`);
  const back = new URL(requireHeader({ response, name: "location" }));
  assert.equal(back.searchParams.get("state"), "claude-state", "the client's state is echoed untouched");
  const code = back.searchParams.get("code");
  assert.ok(code !== null, `callback returned no code: ${back.toString()}`);
  return code;
}

async function beginSignIn(
  options: Readonly<{
    harness: Harness;
    clientId: string;
    redirectUri: string;
    challenge: string;
    clientState: string;
  }>,
): Promise<Readonly<{ brokerState: string }>> {
  const response = await authorize({
    harness: options.harness,
    parameters: {
      response_type: "code",
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
      code_challenge: options.challenge,
      code_challenge_method: "S256",
      state: options.clientState,
      resource: MCP_URL,
    },
  });
  assert.equal(response.status, 302, `authorize failed: ${await response.text()}`);
  const toGoogle = new URL(requireHeader({ response, name: "location" }));
  const brokerState = toGoogle.searchParams.get("state");
  assert.ok(brokerState !== null);
  return { brokerState };
}

async function registerClient(
  options: Readonly<{ harness: Harness; redirectUris: readonly string[] }>,
): Promise<string> {
  const response = await fetch(`${options.harness.baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: options.redirectUris }),
  });
  const body = await response.text();
  assert.equal(response.status, 201, `registration failed: ${body}`);
  const clientId = asString(requireRecord(JSON.parse(body) as unknown)["client_id"]);
  assert.ok(clientId !== null);
  return clientId;
}

function authorize(
  options: Readonly<{ harness: Harness; parameters: Readonly<Record<string, string>> }>,
): Promise<Response> {
  const url = new URL(`${options.harness.baseUrl}/authorize`);
  for (const [name, value] of Object.entries(options.parameters)) url.searchParams.set(name, value);
  return fetch(url, { redirect: "manual" });
}

function callback(
  options: Readonly<{ harness: Harness; code: string; state: string }>,
): Promise<Response> {
  const url = new URL(`${options.harness.baseUrl}/oauth/google/callback`);
  url.searchParams.set("code", options.code);
  url.searchParams.set("state", options.state);
  return fetch(url, { redirect: "manual" });
}

function refresh(
  options: Readonly<{ harness: Harness; clientId: string; refreshToken: string }>,
): Promise<Response> {
  return postForm({
    harness: options.harness,
    path: "/token",
    fields: {
      grant_type: "refresh_token",
      refresh_token: options.refreshToken,
      client_id: options.clientId,
    },
  });
}

function postForm(
  options: Readonly<{ harness: Harness; path: string; fields: Readonly<Record<string, string>> }>,
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(options.fields)) body.set(name, value);
  return fetch(`${options.harness.baseUrl}${options.path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
}

/** Calls a tool as a real MCP client would, over the Streamable HTTP transport. */
async function callTool(
  options: Readonly<{
    harness: Harness;
    accessToken: string;
    name: string;
    toolArguments: Readonly<Record<string, unknown>>;
  }>,
): Promise<unknown> {
  const transport = new StreamableHTTPClientTransport(new URL(`${options.harness.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${options.accessToken}` } },
  });
  const client = new Client({ name: "sasha-slides-oauth-test", version: "1.0.0" });
  try {
    // Same exactOptionalPropertyTypes wart as on the server transport: the class exposes
    // `sessionId` as a `string | undefined` accessor while `Transport` declares it as an
    // optional property. The SDK's own client/transport pairing is the authority that the
    // runtime shapes match.
    await client.connect(transport as unknown as Transport);
    const result = await client.callTool({ name: options.name, arguments: options.toolArguments });
    const first = Array.isArray(result.content) ? result.content[0] : undefined;
    const text = asString(requireRecord(first)["text"]);
    assert.ok(text !== null, `tool ${options.name} returned no text content`);
    return JSON.parse(text) as unknown;
  } finally {
    await client.close();
  }
}

function newPkce(): Readonly<{ verifier: string; challenge: string }> {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

function requireHeader(options: Readonly<{ response: Response; name: string }>): string {
  const value = options.response.headers.get(options.name);
  assert.ok(value !== null, `response has no ${options.name} header`);
  return value;
}

function asTokenResponse(value: unknown): TokenResponseBody {
  const record = requireRecord(value);
  const accessToken = asString(record["access_token"]);
  const refreshToken = asString(record["refresh_token"]);
  const tokenType = asString(record["token_type"]);
  const scope = asString(record["scope"]);
  assert.ok(accessToken !== null && refreshToken !== null && tokenType !== null && scope !== null);
  assert.equal(typeof record["expires_in"], "number");
  return {
    access_token: accessToken,
    token_type: tokenType,
    expires_in: Number(record["expires_in"]),
    refresh_token: refreshToken,
    scope,
  };
}

/** Asserting rather than nullable: an unexpected shape is a test failure, not a branch. */
function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `expected a JSON object, got ${JSON.stringify(value)}`,
  );
  return value as Readonly<Record<string, unknown>>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
