import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createCommentAccessCheck, COMMENT_ACCESS_RULE } from "../comment-bot/comment-access-check.ts";
import { COMMENT_ACCESS_PATH, parseCommentAccessAnswer, type CommentAccessAnswer } from "../comment-bot/comment-access-contract.ts";
import { allowUrlFor } from "../comment-bot/comment-access-page.ts";
import { googleOwnerDrives } from "../comment-bot/owner-drive.ts";
import { ADDON_IDENTITY_AUDIENCES, verifyAddonIdentityToken } from "../google-slides/addon-identity.ts";
import { createIdentityVerifier, GOOGLE_KEYS_ADDRESS } from "../google-slides/identity-token.ts";
import { createSigningKeys, signedToken } from "../google-slides/testing-google-fakes.ts";
import { inMemoryAuthStore, type AuthStore } from "../http/oauth-store.ts";
import { createFakeOwnerDrive, type FakeOwnerDrive } from "./fake-owner-drive.ts";

/**
 * `POST /comments/access`: the add-on asks whether the user's OWN Google grant already reaches the
 * open deck's comments. Driven over real HTTP with a fake Google (per-user grants, every Drive call
 * recorded with whose token it carried) and real identity-token verification against fake keys,
 * so each row states what the sidebar is told and which grant, if any, was used to find out.
 */

const PUBLIC_URL = "https://sashaslides.com";
const CONNECT_URL = `${PUBLIC_URL}/mcp`;
const DECK = "deckAAAAAAAAAAAAAAAAAAAAAAAA";
const ALICE = "google-sub-alice";
const BOB = "google-sub-bob";
const BINDING_SECRET = "Q2xhdWRlLWJpbmRpbmctc2VjcmV0LXR3by11dWlkcw";
const NOW = Date.parse("2026-10-15T09:00:00Z");
const AUDIENCE = ADDON_IDENTITY_AUDIENCES[0]?.audience ?? "";
const keys = createSigningKeys();

type Harness = Readonly<{ base: string; google: FakeOwnerDrive; store: AuthStore; close(): Promise<void> }>;

async function harness(): Promise<Harness> {
  const store = inMemoryAuthStore();
  const google = createFakeOwnerDrive({ now: () => new Date(NOW) });
  const client = { clientId: "980752129078-abc.apps.googleusercontent.com", clientSecret: "secret" };
  const drives = googleOwnerDrives({ grants: store.googleIdentities, client, fetch: google.fetch, now: () => new Date(NOW), timeoutMs: 1_000 });
  const keysFetch: typeof fetch = (input) =>
    Promise.resolve(String(input) === GOOGLE_KEYS_ADDRESS ? Response.json({ keys: [keys.jwk] }) : new Response("not faked", { status: 599 }));
  const verifier = createIdentityVerifier({ fetch: keysFetch, now: () => NOW });
  const check = createCommentAccessCheck({
    drives,
    verifyIdentity: (identityToken) => verifyAddonIdentityToken({ verifier, identityToken, warn: () => undefined }),
    allowUrlFor: (fileId) => allowUrlFor({ publicUrl: PUBLIC_URL, fileId }),
    connectUrl: CONNECT_URL,
    now: () => new Date(NOW),
    warn: () => undefined,
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://host.invalid");
    void check.handleRequest({ request, response, url }).then((handled) => {
      if (!handled) response.writeHead(599).end("not mine");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // SAFETY: a server listening on a TCP port reports an AddressInfo (node:net), never a pipe name.
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${String(port)}`, google, store, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function identity(options: Readonly<{ subject: string; audience?: string; signingKey?: "ours" | "other" }>): string {
  return signedToken({
    claims: { iss: "https://accounts.google.com", aud: options.audience ?? AUDIENCE, sub: options.subject, email: `${options.subject}@example.com`, email_verified: true, exp: NOW / 1000 + 600 },
    key: options.signingKey === "other" ? keys.otherPrivateKey : keys.privateKey,
  });
}

async function ask(target: Harness, body: Readonly<Record<string, unknown>>): Promise<Readonly<{ status: number; answer: CommentAccessAnswer | null }>> {
  const response = await fetch(`${target.base}${COMMENT_ACCESS_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, answer: parseCommentAccessAnswer(await response.json()) };
}

function askAs(target: Harness, subject: string): Promise<Readonly<{ status: number; answer: CommentAccessAnswer | null }>> {
  return ask(target, { identityToken: identity({ subject }), presentationId: DECK, bindingSecret: BINDING_SECRET });
}

/** Alice (and optionally Bob) signed in to Sasha; the deck shared with them. */
async function seedUsers(target: Harness, options: Readonly<{ aliceRole: "commenter" | "viewer"; aliceScopes?: readonly string[]; aliceGrant: boolean }>): Promise<void> {
  const alice = target.google.addUser({ subject: ALICE, name: "Alice", ...(options.aliceScopes === undefined ? {} : { scopes: options.aliceScopes }) });
  if (options.aliceGrant) await target.store.googleIdentities.put({ key: ALICE, value: alice });
  const bob = target.google.addUser({ subject: BOB, name: "Bob" });
  await target.store.googleIdentities.put({ key: BOB, value: bob });
  target.google.addDeck({ fileId: DECK, name: "Q3 plan", sharedWith: { [ALICE]: options.aliceRole, [BOB]: "commenter" } });
  // Bob already chose the deck in the picker: his grant reaches it. Alice's answer must never come from it.
  target.google.pick({ subject: BOB, fileId: DECK });
  target.google.resetCounts();
}

describe("POST /comments/access", () => {
  test("ready / needsAllow / viewOnly / notConnected, each from Alice's own grant and never Bob's", async () => {
    // Columns: Alice's situation -> what the sidebar is told, and how many files.get calls it cost.
    const rows: readonly Readonly<{
      label: string;
      aliceGrant: boolean;
      aliceRole: "commenter" | "viewer";
      alicePicked: boolean;
      aliceScopes?: readonly string[];
      expected: CommentAccessAnswer;
      fileReads: number;
    }>[] = [
      { label: "picked, commenter", aliceGrant: true, aliceRole: "commenter", alicePicked: true, expected: { access: "ready" }, fileReads: 1 },
      { label: "not picked yet (drive.file 404)", aliceGrant: true, aliceRole: "commenter", alicePicked: false, expected: { access: "needsAllow", allowUrl: `${PUBLIC_URL}/comments/allow?deck=${DECK}` }, fileReads: 1 },
      {
        label: "no Drive scope at all",
        aliceGrant: true,
        aliceRole: "commenter",
        alicePicked: true,
        aliceScopes: ["openid", "email", "https://www.googleapis.com/auth/presentations"],
        expected: { access: "needsAllow", allowUrl: `${PUBLIC_URL}/comments/allow?deck=${DECK}` },
        fileReads: 0,
      },
      { label: "picked, viewer", aliceGrant: true, aliceRole: "viewer", alicePicked: true, expected: { access: "viewOnly" }, fileReads: 1 },
      { label: "no grant stored", aliceGrant: false, aliceRole: "commenter", alicePicked: true, expected: { access: "notConnected", connectUrl: CONNECT_URL, explanation: "" }, fileReads: 0 },
    ];
    for (const row of rows) {
      const target = await harness();
      try {
        await seedUsers(target, { aliceRole: row.aliceRole, aliceGrant: row.aliceGrant, ...(row.aliceScopes === undefined ? {} : { aliceScopes: row.aliceScopes }) });
        if (row.alicePicked) target.google.pick({ subject: ALICE, fileId: DECK });
        const { status, answer } = await askAs(target, ALICE);
        assert.equal(status, 200, row.label);
        if (row.expected.access === "notConnected") {
          assert.equal(answer?.access, "notConnected", row.label);
          assert.equal(answer?.access === "notConnected" ? answer.connectUrl : null, CONNECT_URL, row.label);
        } else {
          assert.deepEqual(answer, row.expected, row.label);
        }
        assert.equal(target.google.counts()["files.get"], row.fileReads, row.label);
        assert.deepEqual(
          target.google.calls().filter((call) => call.caller !== ALICE),
          [],
          `${row.label}: every call carried Alice's own token, none Bob's`,
        );
      } finally {
        await target.close();
      }
    }
  });

  test("an expired grant (Google answers invalid_grant on refresh) is notConnected, not a failure", async () => {
    const target = await harness();
    try {
      await seedUsers(target, { aliceRole: "commenter", aliceGrant: true });
      const stored = await target.store.googleIdentities.get({ key: ALICE });
      assert.ok(stored !== null);
      await target.store.googleIdentities.put({ key: ALICE, value: { ...stored, refreshToken: "revoked-by-google" } });
      const { status, answer } = await askAs(target, ALICE);
      assert.equal(status, 200);
      assert.equal(answer?.access, "notConnected");
    } finally {
      await target.close();
    }
  });

  test("a token Google did not issue to the add-on is refused before any grant is looked at", async () => {
    const target = await harness();
    try {
      await seedUsers(target, { aliceRole: "commenter", aliceGrant: true });
      target.google.pick({ subject: ALICE, fileId: DECK });
      // Columns: what is wrong with the request -> the status it gets.
      const rows = [
        { label: "bad signature", body: { identityToken: identity({ subject: ALICE, signingKey: "other" }), presentationId: DECK, bindingSecret: BINDING_SECRET }, status: 401 },
        { label: "another application's audience", body: { identityToken: identity({ subject: ALICE, audience: "someone-elses-client.apps.googleusercontent.com" }), presentationId: DECK, bindingSecret: BINDING_SECRET }, status: 401 },
        { label: "not a token", body: { identityToken: "nonsense", presentationId: DECK, bindingSecret: BINDING_SECRET }, status: 401 },
        { label: "no binding secret", body: { identityToken: identity({ subject: ALICE }), presentationId: DECK }, status: 400 },
        { label: "a binding secret too short to be one", body: { identityToken: identity({ subject: ALICE }), presentationId: DECK, bindingSecret: "short" }, status: 400 },
        { label: "not a deck id", body: { identityToken: identity({ subject: ALICE }), presentationId: "../etc", bindingSecret: BINDING_SECRET }, status: 400 },
      ];
      for (const row of rows) {
        const { status } = await ask(target, row.body);
        assert.equal(status, row.status, row.label);
      }
      assert.deepEqual(target.google.calls(), [], "no token refresh and no Drive call for any refused request");
      assert.equal((await askAs(target, ALICE)).answer?.access, "ready", "control: the same deck, a valid request");
    } finally {
      await target.close();
    }
  });

  test("rate limited per Google subject: one user's loop does not lock out another", async () => {
    const target = await harness();
    try {
      await seedUsers(target, { aliceRole: "commenter", aliceGrant: true });
      for (let attempt = 0; attempt < COMMENT_ACCESS_RULE.limit; attempt += 1) assert.equal((await askAs(target, ALICE)).status, 200, `attempt ${String(attempt + 1)}`);
      assert.equal((await askAs(target, ALICE)).status, 429, "Alice's next check is refused");
      assert.equal((await askAs(target, BOB)).status, 200, "Bob still gets his");
    } finally {
      await target.close();
    }
  });

  test("answers only POST on its own path", async () => {
    const target = await harness();
    try {
      assert.equal((await fetch(`${target.base}${COMMENT_ACCESS_PATH}`)).status, 405);
      assert.equal((await fetch(`${target.base}/comments/elsewhere`, { method: "POST" })).status, 599);
    } finally {
      await target.close();
    }
  });
});
