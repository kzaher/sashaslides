/**
 * The account directory port, both implementations held to the same rules, plus the store
 * adapter against the real eraser: erasing an account must leave no link that a later
 * sign-in could land back in.
 *
 *   cd mcp/sasha-slides && npx tsx --test test/account-directory.test.ts
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emailHint,
  inMemoryAccountDirectory,
  storeAccountDirectory,
  type AccountDirectory,
  type NewPasskey,
} from "../http/account-directory";
import { createAccountEraser } from "../http/account-eraser";
import type { AccountVault } from "../http/account-vault";
import { fileBackedAuthStore, inMemoryAuthStore, type AuthStore } from "../http/oauth-store";

describe("emailHint", () => {
  const rows: readonly Readonly<{ email: string; hint: string }>[] = [
    { email: "ada@example.com", hint: "a•••@example.com" },
    { email: "ö@example.com", hint: "ö•••@example.com" },
    { email: "a@b@example.com", hint: "a•••@example.com" },
    { email: "no-at-sign", hint: "n•••" },
  ];
  for (const row of rows) {
    test(`${row.email} → ${row.hint}`, () => assert.equal(emailHint(row.email), row.hint));
  }
});

function passkey(credentialId: string): NewPasskey {
  return { credentialId, publicKey: `spki-of-${credentialId}`, algorithm: "ES256", signCount: 3, userHandle: `handle-${credentialId}`, createdAtMs: 1000 };
}

/** Seals reversibly until `resetKey`, after which that account's values never open again. */
function fakeVault(): AccountVault {
  const generation = new Map<string, number>();
  const current = (accountId: string): number => generation.get(accountId) ?? 0;
  return {
    seal: ({ accountId, plaintext }) => Promise.resolve(`sealed:${String(current(accountId))}:${plaintext}`),
    open: ({ accountId, sealed }) => {
      const prefix = `sealed:${String(current(accountId))}:`;
      return Promise.resolve(sealed.startsWith(prefix) ? sealed.slice(prefix.length) : null);
    },
    resetKey: ({ accountId }) => {
      generation.set(accountId, current(accountId) + 1);
      return Promise.resolve();
    },
  };
}

type Implementation = Readonly<{ name: string; make: () => Readonly<{ directory: AccountDirectory; store: AuthStore | null }> }>;

let counter = 0;
const newAccountId = (): string => `account-${String((counter += 1))}`;

const IMPLEMENTATIONS: readonly Implementation[] = [
  { name: "in memory", make: () => ({ directory: inMemoryAccountDirectory({ randomToken: newAccountId }), store: null }) },
  {
    name: "over the auth store",
    make: () => {
      const store = inMemoryAuthStore();
      return { store, directory: storeAccountDirectory({ store, vault: fakeVault(), now: () => new Date(0), newAccountId }) };
    },
  },
];

for (const implementation of IMPLEMENTATIONS) {
  describe(`account directory: ${implementation.name}`, () => {
    test("one provider + subject is one account; another subject or provider is another", async () => {
      const { directory } = implementation.make();
      const first = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: "ada@example.com" });
      const again = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: null });
      const otherSubject = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u2", email: null });
      // Same address, different provider: never merged on email.
      const otherProvider = await directory.findOrCreateByIdentity({ provider: "github", subject: "u1", email: "ada@example.com" });
      assert.equal(again, first);
      assert.equal(new Set([first, otherSubject, otherProvider]).size, 3);
    });

    test("a passkey opens its own account, is found by credential id, and lists as a passkey sign-in", async () => {
      const { directory } = implementation.make();
      const opened = await directory.createAccountWithPasskey({ passkey: passkey("cred-1") });
      assert.equal(opened.kind, "linked");
      if (opened.kind !== "linked") return;
      const found = await directory.findPasskey({ credentialId: "cred-1" });
      assert.deepEqual(found, { ...passkey("cred-1"), accountId: opened.accountId });
      assert.deepEqual(await directory.describe({ accountId: opened.accountId }), { links: [{ provider: "passkey", emailHint: null }] });
      assert.deepEqual(await directory.passkeyIds({ accountId: opened.accountId }), ["cred-1"]);
      assert.equal(await directory.findPasskey({ credentialId: "cred-unknown" }), null);
    });

    test("a passkey added to an existing account signs in to that account, beside its other sign-ins", async () => {
      const { directory } = implementation.make();
      const accountId = await directory.findOrCreateByIdentity({ provider: "github", subject: "7", email: "octo@example.com" });
      assert.deepEqual(await directory.addPasskey({ accountId, passkey: passkey("cred-2") }), { kind: "linked", accountId });
      assert.equal((await directory.findPasskey({ credentialId: "cred-2" }))?.accountId, accountId);
      assert.deepEqual(await directory.describe({ accountId }), {
        links: [
          { provider: "github", emailHint: "o•••@example.com" },
          { provider: "passkey", emailHint: null },
        ],
      });
    });

    test("a credential id registers once; adding to an account that is gone is refused", async () => {
      const { directory } = implementation.make();
      const opened = await directory.createAccountWithPasskey({ passkey: passkey("cred-3") });
      assert.equal(opened.kind, "linked");
      assert.deepEqual(await directory.createAccountWithPasskey({ passkey: passkey("cred-3") }), { kind: "already-registered" });
      const other = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u", email: null });
      assert.deepEqual(await directory.addPasskey({ accountId: other, passkey: passkey("cred-3") }), { kind: "already-registered" });
      assert.deepEqual(await directory.addPasskey({ accountId: "nobody", passkey: passkey("cred-4") }), { kind: "account-missing" });
    });

    test("recordPasskeyUse keeps the newest counter", async () => {
      const { directory } = implementation.make();
      await directory.createAccountWithPasskey({ passkey: passkey("cred-5") });
      await directory.recordPasskeyUse({ credentialId: "cred-5", signCount: 42 });
      assert.equal((await directory.findPasskey({ credentialId: "cred-5" }))?.signCount, 42);
    });

    test("describe shows the provider and an email hint, never the address; unknown accounts are null", async () => {
      const { directory } = implementation.make();
      const accountId = await directory.findOrCreateByIdentity({ provider: "github", subject: "7", email: "octo@example.com" });
      assert.deepEqual(await directory.describe({ accountId }), { links: [{ provider: "github", emailHint: "o•••@example.com" }] });
      assert.equal(await directory.describe({ accountId: "nobody" }), null);
    });
  });
}

describe("store directory with the real eraser", () => {
  test("a Google sign-in records the Google subject as the account's Slides connection", async () => {
    const store = inMemoryAuthStore();
    const directory = storeAccountDirectory({ store, vault: fakeVault(), now: () => new Date(0), newAccountId });
    const accountId = await directory.findOrCreateByIdentity({ provider: "google", subject: "g-sub", email: null });
    assert.equal((await store.accounts.get({ key: accountId }))?.googleSubject, "g-sub");
    const github = await directory.findOrCreateByIdentity({ provider: "github", subject: "9", email: null });
    assert.equal((await store.accounts.get({ key: github }))?.googleSubject, null);
  });

  test("after erase the old account is gone and the same sign-in opens a new, empty one", async () => {
    const store = inMemoryAuthStore();
    const vault = fakeVault();
    const directory = storeAccountDirectory({ store, vault, now: () => new Date(0), newAccountId });
    const eraser = createAccountEraser({ store, vault, revokeGoogleToken: () => Promise.resolve(true) });
    const before = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: "ada@example.com" });
    await eraser.eraseAccount({ accountId: before });
    assert.equal(await directory.describe({ accountId: before }), null);
    const after = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: null });
    assert.notEqual(after, before);
  });

  test("an email sealed before a key reset reads as no hint rather than failing", async () => {
    const store = inMemoryAuthStore();
    const vault = fakeVault();
    const directory = storeAccountDirectory({ store, vault, now: () => new Date(0), newAccountId });
    const accountId = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: "ada@example.com" });
    await vault.resetKey({ accountId });
    assert.deepEqual(await directory.describe({ accountId }), { links: [{ provider: "okta", emailHint: null }] });
  });

  test("a passkey's public key is sealed in the store, dies with the key, and erase removes its link", async () => {
    const store = inMemoryAuthStore();
    const vault = fakeVault();
    const directory = storeAccountDirectory({ store, vault, now: () => new Date(0), newAccountId });
    const opened = await directory.createAccountWithPasskey({ passkey: passkey("cred-a") });
    assert.equal(opened.kind, "linked");
    if (opened.kind !== "linked") return;
    const stored = await store.accountLinks.get({ key: "passkey:cred-a" });
    assert.equal(stored?.passkey?.sealedPublicKey, "sealed:0:spki-of-cred-a", "sealed by the vault, not stored in the clear");
    await vault.resetKey({ accountId: opened.accountId });
    assert.equal(await directory.findPasskey({ credentialId: "cred-a" }), null, "a reset key leaves the passkey unusable");

    const second = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u9", email: null });
    await directory.addPasskey({ accountId: second, passkey: passkey("cred-b") });
    const eraser = createAccountEraser({ store, vault, revokeGoogleToken: () => Promise.resolve(false) });
    const report = await eraser.eraseAccount({ accountId: second });
    assert.equal(report.recordsRemoved, 3, "two links and the account");
    assert.equal(await store.accountLinks.get({ key: "passkey:cred-b" }), null);
    assert.equal(await directory.findPasskey({ credentialId: "cred-b" }), null);
  });

  test("a passkey link survives the file-backed store's round trip, sealed", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "passkey-store-")), "store.json");
    const vault = fakeVault();
    const first = storeAccountDirectory({ store: fileBackedAuthStore({ path, warn: () => undefined }), vault, now: () => new Date(0), newAccountId });
    await first.createAccountWithPasskey({ passkey: passkey("cred-file") });
    await first.recordPasskeyUse({ credentialId: "cred-file", signCount: 9 });
    assert.ok(!readFileSync(path, "utf-8").includes('"spki-of-cred-file"'), "the public key is not on disk in the clear");
    const reopened = storeAccountDirectory({ store: fileBackedAuthStore({ path, warn: () => undefined }), vault, now: () => new Date(0), newAccountId });
    const found = await reopened.findPasskey({ credentialId: "cred-file" });
    assert.equal(found?.signCount, 9);
    assert.equal(found?.algorithm, "ES256");
  });
});
