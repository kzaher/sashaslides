/**
 * The deck server over real HTTP and a real `ws` client on loopback (acceptance 8, 9 and 13): the
 * session start and its return paths, CSRF and Origin, membership hidden as 404, invitations,
 * access changes reaching open sockets, uploads, embed tickets and bearer tokens, shutdown and
 * account erasure closing sockets with their codes.
 *
 *   cd mcp/sasha-slides && npx tsx --test decks/deck-http.test.ts
 */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { CommandId, DeckId } from "../engine/src/contracts/ids.ts";
import type { DeckCaller } from "../deck-contracts/deck-service-contract";
import { storeAccountDirectory } from "../http/account-directory";
import { createAccountEraser, withDeckErasure } from "../http/account-eraser";
import { createAccountPortal } from "../http/account-portal";
import { createAccountVault, inMemoryDataKeyStore } from "../http/account-keys";
import { randomAccountId, withSealedGoogleIdentities } from "../http/accounts";
import { inMemoryAuthStore } from "../http/oauth-store";
import { personIdFor } from "./deck-identity";
import { createDeckServer } from "./deck-stack";
import { openFileDeckStorage } from "./deck-storage";
import {
  accountSessionCookie,
  connectSocket,
  manualTimers,
  send,
  setCookieLine,
  startLoopbackServer,
  type Answer,
  type ManualTimers,
} from "./deck-test-support";
import { createMemoryDeckService, type MemoryDeckService } from "./memory-deck-service";

const PUBLIC_URL = "https://decks.example.test";
const ORIGIN = "https://decks.example.test";
const FOREIGN = "https://evil.example";
const PORTAL_SECRET = "a-portal-session-secret-that-is-at-least-thirty-two-bytes";

const cleanups: (() => Promise<void>)[] = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

type Site = Readonly<{
  decks: MemoryDeckService;
  timers: ManualTimers;
  baseUrl: string;
  port: number;
  /** A deck session cookie (`sasha_deck=...`) and its CSRF token for the caller. */
  sessionFor: (caller: DeckCaller) => Promise<Readonly<{ cookie: string; csrf: string }>>;
}>;

async function startSite(): Promise<Site> {
  const timers = manualTimers(Date.parse("2026-10-15T10:00:00Z"));
  const decks = createMemoryDeckService({ now: timers.now, timers, publicUrl: PUBLIC_URL });
  const portal = createAccountPortal({
    publicUrl: PUBLIC_URL,
    sessionSecret: PORTAL_SECRET,
    providers: [],
    directory: decks.directory,
    eraser: withDeckErasure({ eraser: createAccountEraser({ store: decks.store, vault: decks.vault, revokeGoogleToken: () => Promise.resolve(false) }), eraseDecks: decks.server.eraseAccount }),
    now: () => new Date(timers.now()),
    randomToken: () => randomBytes(24).toString("base64url"),
    warn: () => undefined,
    deckSessionStart: decks.server.deckSessionStart,
  });
  const loopback = await startLoopbackServer({ portal, decks: decks.server });
  cleanups.push(async () => {
    await decks[Symbol.asyncDispose]();
    await loopback[Symbol.asyncDispose]();
  });
  const sessionFor = async (caller: DeckCaller): Promise<Readonly<{ cookie: string; csrf: string }>> => {
    const cookie = (await decks.server.deckSessionStart.issueCookie({ accountId: caller.accountId })).split(";")[0] ?? "";
    const session = await send({ baseUrl: loopback.baseUrl, method: "GET", path: "/deck-api/session", headers: { cookie } });
    const body = asObject(session.value());
    return { cookie, csrf: String(body["csrfToken"]) };
  };
  return { decks, timers, baseUrl: loopback.baseUrl, port: loopback.port, sessionFor };
}

async function createDeckOver(site: Site, caller: DeckCaller): Promise<DeckId> {
  const { cookie, csrf } = await site.sessionFor(caller);
  const created = await send({
    baseUrl: site.baseUrl,
    method: "POST",
    path: "/deck-api/decks",
    headers: { cookie, origin: ORIGIN, "x-sasha-csrf": csrf, "content-type": "application/json" },
    body: JSON.stringify({ title: "Over HTTP" }),
  });
  assert.equal(created.status, 201, created.body.toString());
  const deck = asObject(asObject(created.value())["deck"]);
  // The server minted it with `newDeckId`, a valid deck id.
  return String(deck["deckId"]) as DeckId;
}

describe("deck sessions over HTTP", () => {
  test("signed out: GET /deck-api/session answers 401 signedOut with where to sign in", async () => {
    const site = await startSite();
    const answer = await send({ baseUrl: site.baseUrl, method: "GET", path: "/deck-api/session" });
    assert.equal(answer.status, 401);
    const body = asObject(answer.value());
    assert.equal(body["error"], "signedOut");
    assert.match(String(body["signInAddress"]), /^\/account\/deck-session\?return=/u);
  });

  test("signed out: the sign-in address returns to the page that asked (same-origin Referer, else ?return=, else /decks)", async () => {
    const site = await startSite();
    const deckPath = "/deck/dk_AAAAAAAAAAAAAAAAAAAAAA";
    const otherDeckPath = "/deck/dk_BBBBBBBBBBBBBBBBBBBBBB";
    type Row = Readonly<{ name: string; query: string; referer: string | null; expected: string }>;
    const rows: readonly Row[] = [
      { name: "a deck page on our origin", query: "", referer: `${ORIGIN}${deckPath}?embed=addon`, expected: deckPath },
      { name: "control: no Referer", query: "", referer: null, expected: "/decks" },
      { name: "a page on another origin", query: "", referer: `${FOREIGN}${deckPath}`, expected: "/decks" },
      { name: "a page on our origin that is not a deck page", query: "", referer: `${ORIGIN}/account`, expected: "/decks" },
      { name: "the developer page on our origin", query: "", referer: `${ORIGIN}/dev`, expected: "/dev" },
      { name: "an explicit ?return= wins over the Referer", query: `?return=${encodeURIComponent(otherDeckPath)}`, referer: `${ORIGIN}${deckPath}`, expected: otherDeckPath },
    ];
    for (const row of rows) {
      const answer = await send({ baseUrl: site.baseUrl, method: "GET", path: `/deck-api/session${row.query}`, headers: row.referer === null ? {} : { referer: row.referer } });
      assert.equal(answer.status, 401, row.name);
      assert.equal(asObject(answer.value())["signInAddress"], `/account/deck-session?return=${encodeURIComponent(row.expected)}`, row.name);
    }
  });

  test("signing out of /account also removes the deck session cookie", async () => {
    const site = await startSite();
    const out = await send({ baseUrl: site.baseUrl, method: "POST", path: "/account/logout", headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" }, body: "" });
    assert.equal(out.status, 303);
    assert.match(setCookieLine(out.headers, "sasha_deck") ?? "", /Max-Age=0; HttpOnly; Secure; SameSite=Strict/u);
    assert.match(setCookieLine(out.headers, "sasha_deck") ?? "", /Path=\/deck-api/u);
  });

  test("/account/deck-session sets the deck cookie and redirects to a valid return path only", async () => {
    const site = await startSite();
    const alice = await site.decks.signIn({ email: "alice@example.com" });
    const account = accountSessionCookie({ secret: PORTAL_SECRET, accountId: alice.accountId, now: site.timers.now() });
    const deckId = await createDeckOver(site, alice);
    type Row = Readonly<{ returnPath: string; expectedLocation: string }>;
    const rows: readonly Row[] = [
      { returnPath: `/deck/${deckId}`, expectedLocation: `/deck/${deckId}` },
      { returnPath: "//evil.example", expectedLocation: "/decks" },
      { returnPath: "/account", expectedLocation: "/decks" },
      { returnPath: "/dev", expectedLocation: "/dev" },
      { returnPath: "/dev/other", expectedLocation: "/decks" },
      { returnPath: "/developer", expectedLocation: "/decks" },
    ];
    for (const row of rows) {
      const answer = await send({ baseUrl: site.baseUrl, method: "GET", path: `/account/deck-session?return=${encodeURIComponent(row.returnPath)}`, headers: { cookie: account } });
      assert.equal(answer.status, 303, row.returnPath);
      assert.equal(answer.headers.location, row.expectedLocation, row.returnPath);
      const line = setCookieLine(answer.headers, "sasha_deck") ?? "";
      for (const attribute of ["Path=/deck-api", "HttpOnly", "Secure", "SameSite=Strict"]) assert.ok(line.includes(attribute), `${attribute} in ${line}`);
    }
    const signedOut = await send({ baseUrl: site.baseUrl, method: "GET", path: `/account/deck-session?return=${encodeURIComponent(`/deck/${deckId}`)}` });
    assert.equal(signedOut.status, 303);
    assert.equal(signedOut.headers.location, "/account");
    const returnCookie = setCookieLine(signedOut.headers, "sasha_return") ?? "";
    assert.ok(returnCookie.includes("Path=/account") && returnCookie.includes("Max-Age=600"), returnCookie);

    // Whichever sign-in method is used, it lands on /account, which sends the browser back.
    const back = await send({ baseUrl: site.baseUrl, method: "GET", path: "/account", headers: { cookie: `${account}; ${returnCookie.split(";")[0] ?? ""}` } });
    assert.equal(back.status, 303);
    assert.equal(back.headers.location, `/account/deck-session?return=${encodeURIComponent(`/deck/${deckId}`)}`);
    assert.ok((setCookieLine(back.headers, "sasha_return") ?? "").includes("Max-Age=0"), "the return cookie is spent");
  });

  test("a state-changing request needs our Origin and the CSRF header; the socket refuses a foreign Origin", async () => {
    const site = await startSite();
    const alice = await site.decks.signIn({ email: "alice@example.com" });
    const { cookie, csrf } = await site.sessionFor(alice);
    type Row = Readonly<{ name: string; origin: string; csrf: string | null; status: number; error: string | null }>;
    const rows: readonly Row[] = [
      { name: "control: our origin and the token", origin: ORIGIN, csrf, status: 201, error: null },
      { name: "no CSRF header", origin: ORIGIN, csrf: null, status: 403, error: "csrfMismatch" },
      { name: "a foreign Origin", origin: FOREIGN, csrf, status: 403, error: "originRefused" },
    ];
    for (const row of rows) {
      const answer = await send({
        baseUrl: site.baseUrl,
        method: "POST",
        path: "/deck-api/decks",
        headers: { cookie, origin: row.origin, "content-type": "application/json", ...(row.csrf === null ? {} : { "x-sasha-csrf": row.csrf }) },
        body: JSON.stringify({ title: "A deck" }),
      });
      assert.equal(answer.status, row.status, row.name);
      if (row.error !== null) assert.equal(asObject(answer.value())["error"], row.error, row.name);
    }
    const deckId = await createDeckOver(site, alice);
    const foreign = connectSocket({ port: site.port, path: `/deck-api/sync/${deckId}`, origin: FOREIGN, cookie });
    await assert.rejects(foreign.opened, /403/u);
    const ours = connectSocket({ port: site.port, path: `/deck-api/sync/${deckId}`, origin: ORIGIN, cookie });
    await ours.opened;
    await ours.until(() => ours.messages().some((message) => message.kind === "welcome"));
    ours.socket.close();
  });
});

describe("deck access over HTTP", () => {
  test("a non-member gets 404; invitations add an existing account at once and an unknown address at its first sign-in", async () => {
    const site = await startSite();
    const owner = await site.decks.signIn({ email: "owner@example.com" });
    const outsider = await site.decks.signIn({ email: "outsider@example.com" });
    const existing = await site.decks.signIn({ email: "existing@example.com" });
    const deckId = await createDeckOver(site, owner);
    const outsiderSession = await site.sessionFor(outsider);
    const hidden = await send({ baseUrl: site.baseUrl, method: "GET", path: `/deck-api/decks/${deckId}`, headers: { cookie: outsiderSession.cookie } });
    assert.equal(hidden.status, 404);
    assert.equal(asObject(hidden.value())["error"], "notFound");

    const { cookie, csrf } = await site.sessionFor(owner);
    const invite = (email: string): Promise<Answer> =>
      send({
        baseUrl: site.baseUrl,
        method: "POST",
        path: `/deck-api/decks/${deckId}/members`,
        headers: { cookie, origin: ORIGIN, "x-sasha-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ email, role: "commenter" }),
      });
    assert.equal(asObject((await invite("existing@example.com")).value())["outcome"], "added");
    assert.equal(asObject((await invite("Newcomer@Example.com")).value())["outcome"], "invited");
    assert.deepEqual((await site.decks.server.manager.listDecks({ accountId: existing.accountId })).map((deck) => deck.deckId), [deckId]);

    const newcomer = await site.decks.signIn({ email: "newcomer@example.com" });
    const listed = await site.decks.server.manager.listDecks({ accountId: newcomer.accountId });
    assert.deepEqual(listed.map((deck) => [deck.deckId, deck.role]), [[deckId, "commenter"]]);
  });

  test("a role change reaches the member's socket as accessChanged; removal closes it with 4003", async () => {
    const site = await startSite();
    const owner = await site.decks.signIn({ email: "owner@example.com" });
    const member = await site.decks.signIn({ email: "member@example.com" });
    const deckId = await createDeckOver(site, owner);
    const { cookie, csrf } = await site.sessionFor(owner);
    const ownerHeaders = { cookie, origin: ORIGIN, "x-sasha-csrf": csrf, "content-type": "application/json" };
    await send({ baseUrl: site.baseUrl, method: "POST", path: `/deck-api/decks/${deckId}/members`, headers: ownerHeaders, body: JSON.stringify({ email: "member@example.com", role: "editor" }) });
    const memberSession = await site.sessionFor(member);
    const socket = connectSocket({ port: site.port, path: `/deck-api/sync/${deckId}`, origin: ORIGIN, cookie: memberSession.cookie });
    await socket.opened;
    await socket.until(() => socket.messages().some((message) => message.kind === "welcome"));

    const personId = personIdFor({ accountId: member.accountId });
    const changed = await send({ baseUrl: site.baseUrl, method: "PATCH", path: `/deck-api/decks/${deckId}/members/${personId}`, headers: ownerHeaders, body: JSON.stringify({ role: "viewer" }) });
    assert.equal(changed.status, 200, changed.body.toString());
    await socket.until(() => socket.messages().some((message) => message.kind === "accessChanged" && message.role === "viewer"));

    const removed = await send({ baseUrl: site.baseUrl, method: "DELETE", path: `/deck-api/decks/${deckId}/members/${personId}`, headers: ownerHeaders });
    assert.equal(removed.status, 200);
    assert.equal(await socket.closed, 4003);
  });

  test("uploads: a type the bytes contradict is 415, past 25 megabytes is 413, and assets are served sandboxed", async () => {
    const site = await startSite();
    const owner = await site.decks.signIn({ email: "owner@example.com" });
    const deckId = await createDeckOver(site, owner);
    const { cookie, csrf } = await site.sessionFor(owner);
    const put = (contentType: string, body: Uint8Array): Promise<Answer> =>
      send({ baseUrl: site.baseUrl, method: "PUT", path: `/deck-api/decks/${deckId}/assets`, headers: { cookie, origin: ORIGIN, "x-sasha-csrf": csrf, "content-type": contentType }, body });
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    assert.equal((await put("image/png", jpeg)).status, 415);
    const oversized = new Uint8Array(25 * 1024 * 1024 + 1);
    oversized.set(png);
    assert.equal((await put("image/png", oversized)).status, 413);
    const stored = await put("image/png", png);
    assert.equal(stored.status, 200, stored.body.toString());
    const assetId = String(asObject(stored.value())["assetId"]);
    const served = await send({ baseUrl: site.baseUrl, method: "GET", path: `/deck-api/decks/${deckId}/assets/${assetId}`, headers: { cookie } });
    assert.equal(served.status, 200);
    assert.deepEqual(Uint8Array.from(served.body), png);
    assert.equal(served.headers["x-content-type-options"], "nosniff");
    assert.equal(served.headers["content-security-policy"], "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.equal(served.headers["cache-control"], "private, max-age=31536000, immutable");
  });
});

describe("delegation to the Google Slides module", () => {
  test("the developer page's POSTs need our Origin, the CSRF header and the cookie session; a bearer is refused 403", async () => {
    const timers = manualTimers(Date.parse("2026-10-15T10:00:00Z"));
    const seen: string[] = [];
    const decks = createMemoryDeckService({
      now: timers.now,
      timers,
      publicUrl: PUBLIC_URL,
      createGoogleSlidesInterchange: () => ({
        handleRequest: ({ url, caller, response }) => {
          seen.push(`${url.pathname} ${caller === null ? "no caller" : "caller"}`);
          response.writeHead(204).end();
          return Promise.resolve(true);
        },
      }),
    });
    const loopback = await startLoopbackServer({ portal: null, decks: decks.server });
    cleanups.push(async () => {
      await decks[Symbol.asyncDispose]();
      await loopback[Symbol.asyncDispose]();
    });
    const owner = await decks.signIn({ email: "owner@example.com" });
    const cookie = (await decks.server.deckSessionStart.issueCookie({ accountId: owner.accountId })).split(";")[0] ?? "";
    const session = asObject((await send({ baseUrl: loopback.baseUrl, method: "GET", path: "/deck-api/session", headers: { cookie } })).value());
    const csrf = String(session["csrfToken"]);
    for (const path of ["/deck-api/google-slides/insert-html", "/deck-api/google-slides/export-png"]) {
      type Row = Readonly<{ name: string; headers: Readonly<Record<string, string>>; status: number; error: string | null }>;
      const rows: readonly Row[] = [
        { name: "no CSRF header", headers: { cookie, origin: ORIGIN }, status: 403, error: "csrfMismatch" },
        { name: "a wrong CSRF header", headers: { cookie, origin: ORIGIN, "x-sasha-csrf": `${csrf}x` }, status: 403, error: "csrfMismatch" },
        { name: "a foreign Origin", headers: { cookie, origin: FOREIGN, "x-sasha-csrf": csrf }, status: 403, error: "originRefused" },
        { name: "no Origin", headers: { cookie, "x-sasha-csrf": csrf }, status: 403, error: "originRefused" },
        { name: "signed out", headers: { origin: ORIGIN, referer: `${ORIGIN}/dev` }, status: 401, error: "signedOut" },
        { name: "control: the cookie, our Origin and the token", headers: { cookie, origin: ORIGIN, "x-sasha-csrf": csrf }, status: 204, error: null },
      ];
      for (const row of rows) {
        const answer = await send({ baseUrl: loopback.baseUrl, method: "POST", path, headers: { ...row.headers, "content-type": "application/json" }, body: "{}" });
        assert.equal(answer.status, row.status, `${path}: ${row.name}`);
        if (row.error !== null) assert.equal(asObject(answer.value())["error"], row.error, `${path}: ${row.name}`);
        if (row.error === "signedOut") assert.equal(asObject(answer.value())["signInAddress"], `/account/deck-session?return=${encodeURIComponent("/dev")}`, `${path}: back to /dev`);
      }
    }
    assert.deepEqual(seen, ["/deck-api/google-slides/insert-html caller", "/deck-api/google-slides/export-png caller"], "only the control rows reached the module");

    const created = await send({ baseUrl: loopback.baseUrl, method: "POST", path: "/deck-api/decks", headers: { cookie, origin: ORIGIN, "x-sasha-csrf": csrf, "content-type": "application/json" }, body: JSON.stringify({ title: "Embedded" }) });
    const deckId = String(asObject(asObject(created.value())["deck"])["deckId"]) as DeckId;
    const ticket = await decks.server.embeds.issue({ accountId: owner.accountId, deckId });
    const embed = asObject((await send({ baseUrl: loopback.baseUrl, method: "POST", path: "/deck-api/embed/session", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ ticket }) })).value());
    const bearer = { authorization: `Bearer ${String(embed["bearerToken"])}`, origin: ORIGIN, "x-sasha-csrf": String(asObject(embed["session"])["csrfToken"]), "content-type": "application/json" };
    const refused = await send({ baseUrl: loopback.baseUrl, method: "POST", path: "/deck-api/google-slides/insert-html", headers: bearer, body: "{}" });
    assert.equal(refused.status, 403);
    assert.equal(asObject(refused.value())["error"], "notPermitted");
    assert.equal(seen.length, 2, "the bearer never reached the module");
  });

  test("add-on and capability paths reach the module with no caller (and no Origin needed); its session paths with the caller; the shared callback first", async () => {
    const timers = manualTimers(Date.parse("2026-10-15T10:00:00Z"));
    const seen: string[] = [];
    const decks = createMemoryDeckService({
      now: timers.now,
      timers,
      publicUrl: PUBLIC_URL,
      createGoogleSlidesInterchange: () => ({
        handleRequest: ({ url, caller, response }) => {
          seen.push(`${url.pathname} ${caller === null ? "no caller" : "caller"}`);
          if (url.pathname === "/oauth/google/callback") return Promise.resolve(false);
          response.writeHead(204).end();
          return Promise.resolve(true);
        },
      }),
    });
    const loopback = await startLoopbackServer({ portal: null, decks: decks.server });
    cleanups.push(async () => {
      await decks[Symbol.asyncDispose]();
      await loopback[Symbol.asyncDispose]();
    });
    const owner = await decks.signIn({ email: "owner@example.com" });
    const cookie = (await decks.server.deckSessionStart.issueCookie({ accountId: owner.accountId })).split(";")[0] ?? "";
    assert.equal((await send({ baseUrl: loopback.baseUrl, method: "POST", path: "/deck-api/addon/handoff", headers: { "content-type": "application/json" }, body: "{}" })).status, 204);
    assert.equal((await send({ baseUrl: loopback.baseUrl, method: "GET", path: "/deck-api/export-assets/token/abc" })).status, 204);
    assert.equal((await send({ baseUrl: loopback.baseUrl, method: "GET", path: "/deck-api/google-slides/connect?return=/decks", headers: { cookie } })).status, 204);
    assert.equal((await send({ baseUrl: loopback.baseUrl, method: "GET", path: "/oauth/google/callback?state=not-ours" })).status, 404, "declined, so it falls through to the authorization server");
    assert.deepEqual(seen, [
      "/deck-api/addon/handoff no caller",
      "/deck-api/export-assets/token/abc no caller",
      "/deck-api/google-slides/connect caller",
      "/oauth/google/callback no caller",
    ]);
  });
});

describe("the add-on embedding", () => {
  test("a ticket works once and expires after 2 minutes; a bearer opens only its own deck and authenticates the socket", async () => {
    const site = await startSite();
    const owner = await site.decks.signIn({ email: "owner@example.com" });
    const deckId = await createDeckOver(site, owner);
    const otherDeckId = await createDeckOver(site, owner);
    const exchange = (ticket: string): Promise<Answer> =>
      send({ baseUrl: site.baseUrl, method: "POST", path: "/deck-api/embed/session", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ ticket }) });

    const ticket = await site.decks.server.embeds.issue({ accountId: owner.accountId, deckId });
    const first = await exchange(ticket);
    assert.equal(first.status, 200, first.body.toString());
    assert.equal((await exchange(ticket)).status, 401, "single use");
    const late = await site.decks.server.embeds.issue({ accountId: owner.accountId, deckId });
    site.timers.advance(2 * 60 * 1000 + 1);
    assert.equal((await exchange(late)).status, 401, "expired after 2 minutes");

    const body = asObject(first.value());
    const bearer = String(body["bearerToken"]);
    const authorization = { authorization: `Bearer ${bearer}` };
    assert.equal((await send({ baseUrl: site.baseUrl, method: "GET", path: `/deck-api/decks/${deckId}`, headers: authorization })).status, 200);
    assert.equal((await send({ baseUrl: site.baseUrl, method: "GET", path: `/deck-api/decks/${otherDeckId}`, headers: authorization })).status, 404);

    const socket = connectSocket({ port: site.port, path: `/deck-api/sync/${deckId}`, origin: ORIGIN, protocols: ["sasha-deck.1", `sasha-bearer.${bearer}`] });
    await socket.opened;
    assert.equal(socket.protocol(), "sasha-deck.1", "only sasha-deck.1 is echoed, never the bearer");
    await socket.until(() => socket.messages().some((message) => message.kind === "welcome"));
    socket.socket.close();

    const elsewhere = connectSocket({ port: site.port, path: `/deck-api/sync/${otherDeckId}`, origin: ORIGIN, protocols: ["sasha-deck.1", `sasha-bearer.${bearer}`] });
    assert.equal(await elsewhere.closed, 4004, "the bearer opens no other deck");
  });
});

describe("shutdown and erasure", () => {
  test("SIGTERM flushes every room and closes every socket with 4013", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sasha-decks-shutdown-"));
    cleanups.push(() => {
      rmSync(directory, { recursive: true, force: true });
      return Promise.resolve();
    });
    const timers = manualTimers(Date.parse("2026-10-15T10:00:00Z"));
    const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: randomBytes(32) });
    const { store } = withSealedGoogleIdentities({ store: inMemoryAuthStore(), vault });
    const accountDirectory = storeAccountDirectory({ store, vault, now: () => new Date(timers.now()), newAccountId: randomAccountId });
    const opened = openFileDeckStorage({ decksDirectory: join(directory, "decks"), profilesDirectory: join(directory, "deck-profiles"), vault, warn: () => undefined });
    if (opened.kind === "failed") throw new Error(opened.message);
    const server = createDeckServer({
      publicUrl: PUBLIC_URL,
      storage: opened.storage,
      store,
      vault,
      directory: accountDirectory,
      sessionSecret: PORTAL_SECRET,
      webDistributionDirectory: join(directory, "no-build"),
      googleClient: { clientId: "test.apps.googleusercontent.com", clientSecret: "secret" },
      createGoogleSlidesInterchange: () => ({ handleRequest: () => Promise.resolve(false) }),
      timers,
      now: timers.now,
      random: Math.random,
      randomBytes: (size) => randomBytes(size),
      randomToken: () => randomBytes(24).toString("base64url"),
      fetch: () => Promise.reject(new Error("no network")),
      warn: () => undefined,
    });
    const loopback = await startLoopbackServer({ portal: null, decks: server });
    cleanups.push(async () => {
      await loopback[Symbol.asyncDispose]();
    });
    const accountId = await accountDirectory.findOrCreateByIdentity({ provider: "test", subject: "owner", email: "owner@example.com" });
    const caller = await server.people.callerFor({ accountId });
    const created = await server.deckService.createDeck({ caller, title: "Shutdown" });
    assert.equal(created.kind, "opened");
    if (created.kind !== "opened") return;
    const deckId = created.deck.deckId;
    await created.deck[Symbol.asyncDispose]();
    await server.manager.registry.flushAll();
    const cookie = (await server.deckSessionStart.issueCookie({ accountId })).split(";")[0] ?? "";
    const sockets = [0, 1].map(() => connectSocket({ port: loopback.port, path: `/deck-api/sync/${deckId}`, origin: ORIGIN, cookie }));
    for (const socket of sockets) {
      await socket.opened;
      await socket.until(() => socket.messages().some((message) => message.kind === "welcome"));
    }
    const logPath = join(directory, "decks", deckId, "document.log");
    const before = readFileSync(logPath, "utf-8").split("\n").filter((line) => line !== "").length;
    const opening = await server.deckService.openDeck({ caller, deckId });
    assert.equal(opening.kind, "opened");
    if (opening.kind !== "opened") return;
    const applied = await opening.deck.apply({
      envelope: {
        // A valid object id (ids.ts).
        commandId: "cm_shutdownTitle1" as CommandId,
        author: { kind: "person", personId: caller.person.id },
        commands: [{ kind: "setTitle", title: "Before shutdown" }],
        selectionBefore: { kind: "none" },
        selectionAfter: { kind: "none" },
        mergeWithPrevious: false,
      },
      summaryForCollaborators: "",
    });
    assert.equal(applied.kind, "applied");

    await server.shutdown();

    const afterShutdown = readFileSync(logPath, "utf-8").split("\n").filter((line) => line !== "").length;
    assert.ok(afterShutdown > before, `the log grew from ${String(before)} to ${String(afterShutdown)}`);
    for (const socket of sockets) assert.equal(await socket.closed, 4013);
  });

  test("erasing an account closes its sockets: its own deck 4005, someone else's 4003", async () => {
    const site = await startSite();
    const erased = await site.decks.signIn({ email: "erased@example.com" });
    const other = await site.decks.signIn({ email: "other@example.com" });
    const ownDeck = await createDeckOver(site, erased);
    const othersDeck = await createDeckOver(site, other);
    const otherSession = await site.sessionFor(other);
    await send({
      baseUrl: site.baseUrl,
      method: "POST",
      path: `/deck-api/decks/${othersDeck}/members`,
      headers: { cookie: otherSession.cookie, origin: ORIGIN, "x-sasha-csrf": otherSession.csrf, "content-type": "application/json" },
      body: JSON.stringify({ email: "erased@example.com", role: "editor" }),
    });
    const { cookie } = await site.sessionFor(erased);
    const onOwn = connectSocket({ port: site.port, path: `/deck-api/sync/${ownDeck}`, origin: ORIGIN, cookie });
    const onOthers = connectSocket({ port: site.port, path: `/deck-api/sync/${othersDeck}`, origin: ORIGIN, cookie });
    for (const socket of [onOwn, onOthers]) {
      await socket.opened;
      await socket.until(() => socket.messages().some((message) => message.kind === "welcome"));
    }
    const eraser = withDeckErasure({
      eraser: createAccountEraser({ store: site.decks.store, vault: site.decks.vault, revokeGoogleToken: () => Promise.resolve(false) }),
      eraseDecks: site.decks.server.eraseAccount,
    });
    await eraser.eraseAccount({ accountId: erased.accountId });
    assert.equal(await onOwn.closed, 4005);
    assert.equal(await onOthers.closed, 4003);
    const signedOut = await send({ baseUrl: site.baseUrl, method: "GET", path: "/deck-api/session", headers: { cookie } });
    assert.equal(signedOut.status, 401, "the erased account's cookie reads as signed out");
  });
});

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) throw new Error(`not an object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
