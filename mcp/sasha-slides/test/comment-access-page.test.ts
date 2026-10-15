import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ALLOW_SCOPES,
  ALLOW_STATE_COOKIE_NAME,
  createCommentAccessPage,
  PICKER_SCRIPT_PATH,
  projectNumberOf,
  type GoogleSignInResult,
} from "../comment-bot/comment-access-page.ts";
import { DRIVE_FILE_SCOPE, FULL_DRIVE_SCOPE } from "../comment-bot/owner-drive.ts";
import { PICKER_SCRIPT_MODULE, renderPickerScriptModule } from "../comment-bot/access-browser/build.ts";
import { inMemoryAuthStore, type AuthStore, type GoogleIdentity } from "../http/oauth-store.ts";

/**
 * `/comments/allow`: the one page where a Sasha user lets Sasha at ONE deck, through the Google
 * Picker, with their own Google account. Driven over real HTTP with a fake Google sign-in, so
 * each test states what a browser sees: the redirect to Google, the state cookie, the refusal of
 * a stranger, and the picker page carrying that user's token and nothing broader than drive.file.
 */

const PUBLIC_URL = "https://sashaslides.com";
const CALLBACK = `${PUBLIC_URL}/oauth/google/callback`;
const CLIENT = { clientId: "980752129078-abc.apps.googleusercontent.com", clientSecret: "secret" };
const DECK = "deckAAAAAAAAAAAAAAAAAAAAAAAA";
const ALICE = "google-sub-alice";
const PICKER = { apiKey: "AIza-test-key", appId: "980752129078" };

type Page = Readonly<{
  base: string;
  store: AuthStore;
  /** What the fake Google answers the next callback with. */
  answer: { next: GoogleSignInResult };
  close(): Promise<void>;
}>;

async function page(options: Readonly<{ picker?: typeof PICKER | null }> = {}): Promise<Page> {
  const store = inMemoryAuthStore();
  const answer: { next: GoogleSignInResult } = { next: { kind: "failed", reason: "unset" } };
  let counter = 0;
  const accessPage = createCommentAccessPage({
    publicUrl: PUBLIC_URL,
    googleCallbackUrl: CALLBACK,
    googleClient: CLIENT,
    picker: options.picker === undefined ? PICKER : options.picker,
    grants: store.googleIdentities,
    signIn: { finish: () => Promise.resolve(answer.next) },
    now: () => new Date(Date.parse("2026-10-15T09:00:00Z")),
    randomToken: () => `state${String(counter++)}${"x".repeat(30)}`,
    warn: () => undefined,
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://host.invalid");
    void accessPage.handleRequest({ request, response, url }).then((handled) => {
      if (!handled) response.writeHead(599).end("not mine");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(port)}`,
    store,
    answer,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const ALICE_GRANT: GoogleIdentity = {
  subject: ALICE,
  email: "alice@example.com",
  accessToken: null,
  refreshToken: "refresh-alice",
  accessTokenExpiresAtMs: null,
  grantedScopes: ["openid", "email", "https://www.googleapis.com/auth/presentations"],
};

async function start(target: Page): Promise<Readonly<{ state: string; cookie: string; location: URL }>> {
  const response = await fetch(`${target.base}/comments/allow?deck=${DECK}`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location") ?? "");
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { state: location.searchParams.get("state") ?? "", cookie, location };
}

describe("/comments/allow", () => {
  test("sends the browser to Google for identity and drive.file only, never the full drive scope", async () => {
    const target = await page();
    try {
      const { location, state } = await start(target);
      assert.equal(`${location.origin}${location.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
      assert.equal(location.searchParams.get("scope"), ALLOW_SCOPES.join(" "));
      assert.deepEqual(ALLOW_SCOPES, ["openid", "email", DRIVE_FILE_SCOPE]);
      assert.ok(!ALLOW_SCOPES.includes(FULL_DRIVE_SCOPE));
      assert.equal(location.searchParams.get("include_granted_scopes"), "true");
      assert.equal(location.searchParams.get("redirect_uri"), CALLBACK);
      assert.equal(location.searchParams.get("client_id"), CLIENT.clientId);
      assert.equal(location.searchParams.get("prompt"), null, "no forced consent: a silent bounce when drive.file is already granted");
      assert.ok(state.length > 20);
      const response = await fetch(`${target.base}/comments/allow?deck=${DECK}`, { redirect: "manual" });
      assert.match(response.headers.get("set-cookie") ?? "", new RegExp(`^${ALLOW_STATE_COOKIE_NAME}=[^;]+; Path=/oauth/google/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax$`));
    } finally {
      await target.close();
    }
  });

  test("refuses a link without a deck, and says when the picker is not configured", async () => {
    const target = await page({ picker: null });
    try {
      assert.equal((await fetch(`${target.base}/comments/allow?deck=nope`)).status, 400);
      const off = await fetch(`${target.base}/comments/allow?deck=${DECK}`, { redirect: "manual" });
      assert.equal(off.status, 503);
      assert.match(await off.text(), /not set up/);
    } finally {
      await target.close();
    }
  });

  test("the callback answers only its own states: others fall through to the sign-in", async () => {
    const target = await page();
    try {
      assert.equal((await fetch(`${target.base}/oauth/google/callback?state=someone-elses&code=x`)).status, 599);
      assert.equal((await fetch(`${target.base}/oauth/google/callback?code=x`)).status, 599);
    } finally {
      await target.close();
    }
  });

  test("a callback in a browser that did not start it is refused (login CSRF)", async () => {
    const target = await page();
    try {
      const { state } = await start(target);
      target.answer.next = { kind: "ok", subject: ALICE, email: null, accessToken: "fresh", refreshToken: null, accessTokenExpiresAtMs: 1, grantedScopes: [] };
      const response = await fetch(`${target.base}/oauth/google/callback?state=${state}&code=c`);
      assert.equal(response.status, 400);
      assert.match(await response.text(), /different browser/);
    } finally {
      await target.close();
    }
  });

  test("a Google account that never signed in to Sasha Slides is refused, and nothing is stored", async () => {
    const target = await page();
    try {
      const { state, cookie } = await start(target);
      target.answer.next = { kind: "ok", subject: "google-sub-stranger", email: null, accessToken: "fresh", refreshToken: null, accessTokenExpiresAtMs: 1, grantedScopes: [DRIVE_FILE_SCOPE] };
      const response = await fetch(`${target.base}/oauth/google/callback?state=${state}&code=c`, { headers: { cookie } });
      assert.equal(response.status, 403);
      assert.match(await response.text(), /Sign in to Sasha Slides first/);
      assert.equal(await target.store.googleIdentities.get({ key: "google-sub-stranger" }), null);
    } finally {
      await target.close();
    }
  });

  test("a signed-in user's grant gains drive.file, keeps its refresh token, and gets the picker preset to the deck", async () => {
    const target = await page();
    try {
      await target.store.googleIdentities.put({ key: ALICE, value: ALICE_GRANT });
      const { state, cookie } = await start(target);
      const granted = [...ALICE_GRANT.grantedScopes, DRIVE_FILE_SCOPE];
      target.answer.next = { kind: "ok", subject: ALICE, email: "alice@example.com", accessToken: "fresh<token>", refreshToken: null, accessTokenExpiresAtMs: 99, grantedScopes: granted };
      const response = await fetch(`${target.base}/oauth/google/callback?state=${state}&code=c`, { headers: { cookie } });
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, new RegExp(`data-deck="${DECK}"`));
      assert.match(html, /data-token="fresh&lt;token&gt;"/, "the token is escaped");
      assert.match(html, /data-key="AIza-test-key" data-app="980752129078"/);
      assert.match(html, new RegExp(`<script src="${PUBLIC_URL}${PICKER_SCRIPT_PATH}" defer></script>`));
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      const policy = response.headers.get("content-security-policy") ?? "";
      assert.match(policy, new RegExp(`script-src ${PUBLIC_URL}${PICKER_SCRIPT_PATH} https://apis.google.com`));
      assert.match(policy, /frame-ancestors 'none'/);
      assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);

      const stored = await target.store.googleIdentities.get({ key: ALICE });
      assert.deepEqual(
        { access: stored?.accessToken, refresh: stored?.refreshToken, scopes: stored?.grantedScopes },
        { access: "fresh<token>", refresh: "refresh-alice", scopes: granted },
      );

      const replay = await fetch(`${target.base}/oauth/google/callback?state=${state}&code=c`, { headers: { cookie } });
      assert.equal(replay.status, 599, "a state is used once");
    } finally {
      await target.close();
    }
  });

  test("when Google does not grant drive.file, the page says so instead of opening a picker that cannot work", async () => {
    const target = await page();
    try {
      await target.store.googleIdentities.put({ key: ALICE, value: ALICE_GRANT });
      const { state, cookie } = await start(target);
      target.answer.next = { kind: "ok", subject: ALICE, email: null, accessToken: "fresh", refreshToken: null, accessTokenExpiresAtMs: 99, grantedScopes: ALICE_GRANT.grantedScopes };
      const html = await (await fetch(`${target.base}/oauth/google/callback?state=${state}&code=c`, { headers: { cookie } })).text();
      assert.match(html, /Access was not given/);
      assert.doesNotMatch(html, /data-picker/);
    } finally {
      await target.close();
    }
  });

  test("serves the picker script, built from its TypeScript source", async () => {
    const target = await page();
    try {
      const response = await fetch(`${target.base}${PICKER_SCRIPT_PATH}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /^text\/javascript/);
      assert.match(await response.text(), /setFileIds/);
    } finally {
      await target.close();
    }
  });

  test("picker-script.generated.ts is the current build of picker.ts (rebuild: npx tsx mcp/sasha-slides/comment-bot/access-browser/build.ts)", async () => {
    assert.equal(readFileSync(PICKER_SCRIPT_MODULE, "utf-8"), await renderPickerScriptModule());
  });

  test("the picker's app id is the OAuth client's project number", () => {
    assert.equal(projectNumberOf("980752129078-c0ffee.apps.googleusercontent.com"), "980752129078");
    assert.equal(projectNumberOf("not-a-number.apps.googleusercontent.com"), null);
  });
});
