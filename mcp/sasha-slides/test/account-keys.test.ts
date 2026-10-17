/**
 * Per-account encryption and key destruction ("crypto-shredding"), asserted against the
 * real AES-GCM code and the real file backings in a temporary directory.
 *
 *   cd mcp/sasha-slides && npx tsx --test test/account-keys.test.ts
 *
 * Ordered to follow the implementation: the master key, the vault and its two key stores,
 * Google identities sealed in the auth store, then the eraser.
 */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createAccountEraser, googleTokenRevoker } from "../http/account-eraser";
import {
  createAccountVault,
  inMemoryDataKeyStore,
  isSealedValue,
  loadMasterKey,
  MASTER_KEY_ENV,
  openFileBackedDataKeyStore,
  type DataKeyStore,
} from "../http/account-keys";
import type { AccountVault } from "../http/account-vault";
import { accountLinkKey } from "../http/account-directory";
import { withSealedGoogleIdentities } from "../http/accounts";
import {
  fileBackedAuthStore,
  inMemoryAuthStore,
  type AuthStore,
  type GoogleIdentity,
} from "../http/oauth-store";

const MASTER_KEY = randomBytes(32);

describe("loadMasterKey", () => {
  test("accepts 64 hex characters", () => {
    const key = randomBytes(32);
    const loaded = loadMasterKey({ env: { [MASTER_KEY_ENV]: key.toString("hex") } });
    assert.equal(loaded.kind, "ok");
    assert.ok(loaded.kind === "ok" && loaded.key.equals(key));
  });

  test("accepts a base64url 32-byte value, with or without its padding", () => {
    const key = randomBytes(32);
    const unpadded = key.toString("base64url");
    assert.equal(unpadded.length, 43);
    for (const text of [unpadded, `${unpadded}=`]) {
      const loaded = loadMasterKey({ env: { [MASTER_KEY_ENV]: text } });
      assert.ok(loaded.kind === "ok" && loaded.key.equals(key), text);
    }
  });

  test("says how to generate a key when none is set", () => {
    const loaded = loadMasterKey({ env: {} });
    assert.equal(loaded.kind, "missing");
    const message = loaded.kind === "missing" ? loaded.message : "";
    assert.match(message, /SASHA_MASTER_KEY/);
    assert.match(message, /randomBytes\(32\)/);
  });

  test("rejects anything that is not exactly 32 bytes of hex or base64url, with a clear message", () => {
    const malformed = [
      "",
      "abc",
      randomBytes(31).toString("hex"),
      `${randomBytes(32).toString("hex")}00`,
      "z".repeat(64),
      randomBytes(24).toString("base64url"),
      randomBytes(32).toString("base64").replace(/[A-Za-z0-9]/u, "+").slice(0, 43),
    ];
    for (const text of malformed) {
      const loaded = loadMasterKey({ env: { [MASTER_KEY_ENV]: text } });
      assert.equal(loaded.kind, "invalid", JSON.stringify(text));
      const message = loaded.kind === "invalid" ? loaded.message : "";
      assert.match(message, /SASHA_MASTER_KEY/);
      assert.match(message, /64 hex/);
    }
  });
});

describe("createAccountVault", () => {
  test("seals into the versioned text form and opens back to the plaintext", async () => {
    const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: MASTER_KEY });
    const sealed = await vault.seal({ accountId: "acct-a", plaintext: "1//refresh-token" });
    assert.match(sealed, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/u);
    assert.ok(isSealedValue(sealed));
    assert.ok(!sealed.includes("refresh-token"));
    assert.equal(await vault.open({ accountId: "acct-a", sealed }), "1//refresh-token");
    // A fresh nonce per seal: the same plaintext never seals to the same text twice.
    assert.notEqual(await vault.seal({ accountId: "acct-a", plaintext: "1//refresh-token" }), sealed);
  });

  test("a value sealed before resetKey never opens again, and a new seal uses a new key id", async () => {
    const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: MASTER_KEY });
    const before = await vault.seal({ accountId: "acct-a", plaintext: "old secret" });
    await vault.resetKey({ accountId: "acct-a" });
    assert.equal(await vault.open({ accountId: "acct-a", sealed: before }), null);

    const after = await vault.seal({ accountId: "acct-a", plaintext: "new secret" });
    assert.notEqual(keyIdOf(after), keyIdOf(before));
    assert.equal(await vault.open({ accountId: "acct-a", sealed: after }), "new secret");
    assert.equal(await vault.open({ accountId: "acct-a", sealed: before }), null);
  });

  test("a tampered or malformed value opens to null rather than throwing", async () => {
    const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: MASTER_KEY });
    const sealed = await vault.seal({ accountId: "acct-a", plaintext: "secret" });
    const parts = sealed.split(".");
    const body = parts[3] ?? "";
    const flipped = `${body.startsWith("A") ? "B" : "A"}${body.slice(1)}`;
    const tampered = [parts[0], parts[1], parts[2], flipped].join(".");
    assert.equal(await vault.open({ accountId: "acct-a", sealed: tampered }), null);
    assert.equal(await vault.open({ accountId: "acct-a", sealed: "not a sealed value" }), null);
    assert.equal(await vault.open({ accountId: "acct-a", sealed: `v2${sealed.slice(2)}` }), null);
    assert.equal(await vault.open({ accountId: "acct-never-sealed", sealed }), null);
  });

  test("accounts have independent keys: resetting one leaves the other readable", async () => {
    const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: MASTER_KEY });
    const sealedA = await vault.seal({ accountId: "acct-a", plaintext: "alpha" });
    const sealedB = await vault.seal({ accountId: "acct-b", plaintext: "bravo" });
    assert.equal(await vault.open({ accountId: "acct-b", sealed: sealedA }), null);
    await vault.resetKey({ accountId: "acct-a" });
    assert.equal(await vault.open({ accountId: "acct-a", sealed: sealedA }), null);
    assert.equal(await vault.open({ accountId: "acct-b", sealed: sealedB }), "bravo");
  });

  test("concurrent first seals for one account agree on a single key", async () => {
    const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: MASTER_KEY });
    const sealed = await Promise.all(
      ["one", "two", "three"].map((plaintext) => vault.seal({ accountId: "acct-a", plaintext })),
    );
    assert.equal(new Set(sealed.map(keyIdOf)).size, 1);
    for (const value of sealed) assert.notEqual(await vault.open({ accountId: "acct-a", sealed: value }), null);
  });
});

describe("openFileBackedDataKeyStore", () => {
  test("persists data keys only in wrapped form, in a 0o600 file", async () => {
    const path = join(temporaryDirectory(), "keys.json");
    const generated: Buffer[] = [];
    const recordingRandom = (size: number): Buffer => {
      const bytes = randomBytes(size);
      generated.push(bytes);
      return bytes;
    };
    const vault = createAccountVault({ keyStore: openKeyStore(path), masterKey: MASTER_KEY, randomBytes: recordingRandom });
    await vault.seal({ accountId: "acct-a", plaintext: "secret" });

    const text = readFileSync(path, "utf-8");
    const dataKeys = generated.filter((bytes) => bytes.length === 32);
    assert.ok(dataKeys.length >= 1, "the vault generated a 32-byte data key");
    for (const dataKey of dataKeys) {
      for (const encoding of ["hex", "base64", "base64url"] as const) {
        assert.ok(!text.includes(dataKey.toString(encoding)), `raw data key appears as ${encoding}`);
      }
    }
    const document = JSON.parse(text) as { version: number; keys: Record<string, { keyId: string; wrapped: string }> };
    assert.equal(document.version, 1);
    assert.match(document.keys["acct-a"]?.wrapped ?? "", /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/u);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });

  test("keys survive a reload, and so does their destruction", async () => {
    const path = join(temporaryDirectory(), "keys.json");
    const first = createAccountVault({ keyStore: openKeyStore(path), masterKey: MASTER_KEY });
    const sealedA = await first.seal({ accountId: "acct-a", plaintext: "alpha" });
    const sealedB = await first.seal({ accountId: "acct-b", plaintext: "bravo" });

    const reloaded = createAccountVault({ keyStore: openKeyStore(path), masterKey: MASTER_KEY });
    assert.equal(await reloaded.open({ accountId: "acct-a", sealed: sealedA }), "alpha");
    await reloaded.resetKey({ accountId: "acct-a" });

    const again = createAccountVault({ keyStore: openKeyStore(path), masterKey: MASTER_KEY });
    assert.equal(await again.open({ accountId: "acct-a", sealed: sealedA }), null);
    assert.equal(await again.open({ accountId: "acct-b", sealed: sealedB }), "bravo");
  });

  test("refuses to start from an unreadable key file instead of silently dropping every key", () => {
    const path = join(temporaryDirectory(), "keys.json");
    writeFileSync(path, "{ not json");
    const loaded = openFileBackedDataKeyStore({ path, warn: () => undefined });
    assert.equal(loaded.kind, "failed");
  });

  test("the wrong master key cannot unwrap a stored data key", async () => {
    const path = join(temporaryDirectory(), "keys.json");
    const vault = createAccountVault({ keyStore: openKeyStore(path), masterKey: MASTER_KEY });
    const sealed = await vault.seal({ accountId: "acct-a", plaintext: "alpha" });
    const wrongMaster = createAccountVault({ keyStore: openKeyStore(path), masterKey: randomBytes(32) });
    await assert.rejects(wrongMaster.open({ accountId: "acct-a", sealed }), /master key/u);
  });
});

describe("sealed Google identities", () => {
  test("the store file never holds the Google tokens or email in clear text", async () => {
    const directory = temporaryDirectory();
    const storePath = join(directory, "store.json");
    const vault = createAccountVault({ keyStore: openKeyStore(join(directory, "keys.json")), masterKey: MASTER_KEY });
    const { store, accounts } = withSealedGoogleIdentities({
      store: fileBackedAuthStore({ path: storePath, warn: () => undefined }),
      vault,
    });
    await store.googleIdentities.put({ key: "sub-a", value: identity("sub-a") });

    const text = readFileSync(storePath, "utf-8");
    for (const secret of ["1//refresh-sub-a", "ya29.access-sub-a", "sub-a@example.test"]) {
      assert.ok(!text.includes(secret), `${secret} is in the store file`);
    }
    assert.deepEqual(await store.googleIdentities.get({ key: "sub-a" }), identity("sub-a"));

    const accountId = await accounts.find({ subject: "sub-a" });
    assert.ok(accountId !== null, "signing in created an account");
    const link = await store.accountLinks.get({ key: accountLinkKey({ provider: "google", subject: "sub-a" }) });
    assert.equal(link?.accountId, accountId);
    assert.equal(await vault.open({ accountId, sealed: link?.sealedEmail ?? "" }), "sub-a@example.test");
    const account = await store.accounts.get({ key: accountId });
    assert.deepEqual(account?.linkKeys, ["google:sub-a"]);
    assert.equal(account?.googleSubject, "sub-a");
  });

  test("after resetKey the identity reads as absent, so the user goes back through consent", async () => {
    const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: MASTER_KEY });
    const { store, accounts } = withSealedGoogleIdentities({ store: inMemoryAuthStore(), vault });
    await store.googleIdentities.put({ key: "sub-a", value: identity("sub-a") });
    const accountId = await accounts.find({ subject: "sub-a" });
    assert.ok(accountId !== null);
    await vault.resetKey({ accountId });
    assert.equal(await store.googleIdentities.get({ key: "sub-a" }), null);
    assert.equal(await store.googleIdentities.take({ key: "sub-a" }), null);
  });

  test("a second sign-in for the same subject reuses its account", async () => {
    const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: MASTER_KEY });
    const { store, accounts } = withSealedGoogleIdentities({ store: inMemoryAuthStore(), vault });
    await store.googleIdentities.put({ key: "sub-a", value: identity("sub-a") });
    const first = await accounts.find({ subject: "sub-a" });
    await store.googleIdentities.put({ key: "sub-a", value: { ...identity("sub-a"), accessToken: "ya29.next" } });
    assert.equal(await accounts.find({ subject: "sub-a" }), first);
    assert.equal((await store.googleIdentities.get({ key: "sub-a" }))?.accessToken, "ya29.next");
  });

  test("a store file written before accounts existed still loads, and its clear-text identity still reads", async () => {
    const directory = temporaryDirectory();
    const storePath = join(directory, "store.json");
    const legacy = identity("sub-old");
    writeFileSync(
      storePath,
      JSON.stringify({ version: 1, collections: { clients: {}, googleIdentities: { "sub-old": legacy } } }),
    );
    const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: MASTER_KEY });
    const { store } = withSealedGoogleIdentities({
      store: fileBackedAuthStore({ path: storePath, warn: () => undefined }),
      vault,
    });
    assert.deepEqual(await store.googleIdentities.get({ key: "sub-old" }), legacy);
    assert.equal(await store.accounts.get({ key: "anything" }), null);
    assert.deepEqual(await store.accountLinks.keys(), []);
  });
});

describe("createAccountEraser", () => {
  test("revokes at Google, removes every record of the account, leaves other accounts alone, destroys the key", async () => {
    const fixture = await twoAccounts();
    const revoked: string[] = [];
    const eraser = createAccountEraser({
      store: fixture.store,
      vault: fixture.vault,
      revokeGoogleToken: ({ token }) => {
        revoked.push(token);
        return Promise.resolve(true);
      },
    });

    const report = await eraser.eraseAccount({ accountId: fixture.accountA });

    assert.deepEqual(revoked, ["1//refresh-sub-a"]);
    assert.deepEqual(report, { googleTokenRevoked: true, recordsRemoved: 5, keyDestroyed: true });
    assert.equal(await fixture.store.accounts.get({ key: fixture.accountA }), null);
    assert.equal(await fixture.store.accountLinks.get({ key: "google:sub-a" }), null);
    assert.deepEqual(await fixture.store.googleIdentities.keys(), ["sub-b"]);
    assert.deepEqual(await fixture.store.accessTokens.keys(), ["access-hash-b"]);
    assert.deepEqual(await fixture.store.refreshTokens.keys(), ["refresh-hash-b"]);
    assert.equal(await fixture.vault.open({ accountId: fixture.accountA, sealed: fixture.sealedA }), null);

    assert.deepEqual(await fixture.store.googleIdentities.get({ key: "sub-b" }), identity("sub-b"));
    assert.notEqual(await fixture.store.accounts.get({ key: fixture.accountB }), null);
    assert.notEqual(await fixture.store.accountLinks.get({ key: "google:sub-b" }), null);
  });

  test("the key is destroyed even when Google refuses the revocation", async () => {
    const fixture = await twoAccounts();
    const eraser = createAccountEraser({
      store: fixture.store,
      vault: fixture.vault,
      revokeGoogleToken: () => Promise.resolve(false),
    });
    const report = await eraser.eraseAccount({ accountId: fixture.accountA });
    assert.equal(report.googleTokenRevoked, false);
    assert.equal(report.keyDestroyed, true);
    assert.equal(await fixture.vault.open({ accountId: fixture.accountA, sealed: fixture.sealedA }), null);
  });

  test("the key is destroyed even when removing a record throws", async () => {
    const fixture = await twoAccounts();
    const failing: AuthStore = {
      ...fixture.store,
      accessTokens: { ...fixture.store.accessTokens, remove: () => Promise.reject(new Error("disk full")) },
    };
    const eraser = createAccountEraser({
      store: failing,
      vault: fixture.vault,
      revokeGoogleToken: () => Promise.resolve(true),
    });
    await assert.rejects(eraser.eraseAccount({ accountId: fixture.accountA }), /disk full/u);
    assert.equal(await fixture.vault.open({ accountId: fixture.accountA, sealed: fixture.sealedA }), null);
    assert.notEqual(await fixture.vault.open({ accountId: fixture.accountB, sealed: fixture.sealedB }), null);
  });

  test("an unknown account still has its key destroyed and reports nothing removed", async () => {
    const fixture = await twoAccounts();
    const eraser = createAccountEraser({
      store: fixture.store,
      vault: fixture.vault,
      revokeGoogleToken: () => Promise.reject(new Error("must not be called")),
    });
    assert.deepEqual(await eraser.eraseAccount({ accountId: "acct-unknown" }), {
      googleTokenRevoked: false,
      recordsRemoved: 0,
      keyDestroyed: true,
    });
  });
});

describe("googleTokenRevoker", () => {
  test("posts the token form-encoded to Google's revoke endpoint", async () => {
    const calls: { url: string; body: string }[] = [];
    const revoke = googleTokenRevoker({
      fetch: (input, init) => {
        calls.push({ url: String(input), body: String(init?.body) });
        return Promise.resolve(new Response("", { status: 200 }));
      },
      timeoutMs: 5000,
    });
    assert.equal(await revoke({ token: "1//a+b" }), true);
    assert.deepEqual(calls, [{ url: "https://oauth2.googleapis.com/revoke", body: "token=1%2F%2Fa%2Bb" }]);
  });

  test("never throws: a network failure or a refusal is false", async () => {
    const failing = googleTokenRevoker({ fetch: () => Promise.reject(new Error("offline")), timeoutMs: 5000 });
    assert.equal(await failing({ token: "t" }), false);
    const refusing = googleTokenRevoker({
      fetch: () => Promise.resolve(new Response("{}", { status: 400 })),
      timeoutMs: 5000,
    });
    assert.equal(await refusing({ token: "t" }), false);
  });
});

type TwoAccounts = Readonly<{
  store: AuthStore;
  vault: AccountVault;
  accountA: string;
  accountB: string;
  sealedA: string;
  sealedB: string;
}>;

/** Two signed-in users, each with one issued access token and one issued refresh token. */
async function twoAccounts(): Promise<TwoAccounts> {
  const vault = createAccountVault({ keyStore: inMemoryDataKeyStore(), masterKey: MASTER_KEY });
  const { store, accounts } = withSealedGoogleIdentities({ store: inMemoryAuthStore(), vault });
  for (const subject of ["sub-a", "sub-b"]) {
    await store.googleIdentities.put({ key: subject, value: identity(subject) });
  }
  await issueTokens({ store, googleSubject: "sub-a", suffix: "a" });
  await issueTokens({ store, googleSubject: "sub-b", suffix: "b" });
  const accountA = await accounts.find({ subject: "sub-a" });
  const accountB = await accounts.find({ subject: "sub-b" });
  assert.ok(accountA !== null && accountB !== null);
  return {
    store,
    vault,
    accountA,
    accountB,
    sealedA: await vault.seal({ accountId: accountA, plaintext: "data of a" }),
    sealedB: await vault.seal({ accountId: accountB, plaintext: "data of b" }),
  };
}

async function issueTokens(
  options: Readonly<{ store: AuthStore; googleSubject: string; suffix: string }>,
): Promise<void> {
  const { store, googleSubject, suffix } = options;
  await store.accessTokens.put({
    key: `access-hash-${suffix}`,
    value: { clientId: "client", googleSubject, scopes: [], resource: null, expiresAtMs: Date.now() + 60_000 },
  });
  await store.refreshTokens.put({
    key: `refresh-hash-${suffix}`,
    value: { clientId: "client", googleSubject, scopes: [], resource: null },
  });
}

function identity(subject: string): GoogleIdentity {
  return {
    subject,
    email: `${subject}@example.test`,
    accessToken: `ya29.access-${subject}`,
    refreshToken: `1//refresh-${subject}`,
    accessTokenExpiresAtMs: 1_900_000_000_000,
    grantedScopes: ["https://www.googleapis.com/auth/presentations"],
  };
}

function keyIdOf(sealed: string): string {
  return sealed.split(".")[1] ?? "";
}

function openKeyStore(path: string): DataKeyStore {
  const loaded = openFileBackedDataKeyStore({ path, warn: () => undefined });
  if (loaded.kind === "failed") throw new Error(loaded.message);
  return loaded.keyStore;
}

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "sasha-account-keys-"));
}
