/**
 * The account directory port over the auth store, and the same adapter against the real eraser:
 * erasing an account must leave no link that a later sign-in could land back in.
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
  GOOGLE_PROVIDER,
  linkIdOf,
  type AccountDescription,
  storeAccountDirectory,
  type AccountDirectory,
  type NewPasskey,
} from "../http/account-directory";
import { createAccountEraser } from "../http/account-eraser";
import { googleAccounts } from "../http/accounts";
import type { AccountVault } from "../http/account-vault";
import { fileBackedAuthStore, inMemoryAuthStore } from "../http/oauth-store";

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

/** `describe` without the per-link id and date, which the rows below do not pin. */
function summary(description: AccountDescription | null): readonly Readonly<{ provider: string; emailHint: string | null }>[] | null {
  return description === null ? null : description.links.map((link) => ({ provider: link.provider, emailHint: link.emailHint }));
}

let counter = 0;
const newAccountId = (): string => `account-${String((counter += 1))}`;

function makeDirectory(): AccountDirectory {
  return storeAccountDirectory({ store: inMemoryAuthStore(), vault: fakeVault(), now: () => new Date(0), newAccountId });
}

describe("account directory", () => {
  test("one provider + subject is one account; another subject or provider is another", async () => {
    const directory = makeDirectory();
    const first = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: "ada@example.com" });
    const again = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: null });
    const otherSubject = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u2", email: null });
    // Same address, different provider: never merged on email.
    const otherProvider = await directory.findOrCreateByIdentity({ provider: "github", subject: "u1", email: "ada@example.com" });
    assert.equal(again, first);
    assert.equal(new Set([first, otherSubject, otherProvider]).size, 3);
  });

  test("a Google subject opens ONE account whether the portal or the sealed grant store sees it first", async () => {
    for (const portalFirst of [true, false]) {
      const store = inMemoryAuthStore();
      const vault = fakeVault();
      const directory = storeAccountDirectory({ store, vault, now: () => new Date(0), newAccountId });
      const grants = googleAccounts({ store, vault, now: () => new Date(0), newAccountId });
      const first = portalFirst
        ? await directory.findOrCreateByIdentity({ provider: GOOGLE_PROVIDER, subject: "g-1", email: "ada@example.com" })
        : await grants.ensure({ subject: "g-1", email: "ada@example.com" });
      const second = portalFirst
        ? await grants.ensure({ subject: "g-1", email: null })
        : await directory.findOrCreateByIdentity({ provider: GOOGLE_PROVIDER, subject: "g-1", email: null });
      assert.equal(second, first);
      assert.equal(await grants.find({ subject: "g-1" }), first);
      assert.equal((await store.accounts.keys()).length, 1);
      // The account's Google Slides connection is this subject, and its link carries the sealed address.
      assert.equal((await store.accounts.get({ key: first }))?.googleSubject, "g-1");
      assert.deepEqual(summary(await directory.describe({ accountId: first })), [{ provider: "google", emailHint: "a•••@example.com" }]);
    }
  });

  test("a passkey opens its own account, is found by credential id, and lists as a passkey sign-in", async () => {
    const directory = makeDirectory();
    const opened = await directory.createAccountWithPasskey({ passkey: passkey("cred-1") });
    assert.equal(opened.kind, "linked");
    if (opened.kind !== "linked") return;
    const found = await directory.findPasskey({ credentialId: "cred-1" });
    assert.deepEqual(found, { ...passkey("cred-1"), accountId: opened.accountId });
    assert.deepEqual(summary(await directory.describe({ accountId: opened.accountId })), [{ provider: "passkey", emailHint: null }]);
    assert.deepEqual(await directory.passkeyIds({ accountId: opened.accountId }), ["cred-1"]);
    assert.equal(await directory.findPasskey({ credentialId: "cred-unknown" }), null);
  });

  test("a passkey added to an existing account signs in to that account, beside its other sign-ins", async () => {
    const directory = makeDirectory();
    const accountId = await directory.findOrCreateByIdentity({ provider: "github", subject: "7", email: "octo@example.com" });
    assert.deepEqual(await directory.addPasskey({ accountId, passkey: passkey("cred-2") }), { kind: "linked", accountId });
    assert.equal((await directory.findPasskey({ credentialId: "cred-2" }))?.accountId, accountId);
    assert.deepEqual(summary(await directory.describe({ accountId })), [
      { provider: "github", emailHint: "o•••@example.com" },
      { provider: "passkey", emailHint: null },
    ]);
  });

  test("a credential id registers once; adding to an account that is gone is refused", async () => {
    const directory = makeDirectory();
    const opened = await directory.createAccountWithPasskey({ passkey: passkey("cred-3") });
    assert.equal(opened.kind, "linked");
    assert.deepEqual(await directory.createAccountWithPasskey({ passkey: passkey("cred-3") }), { kind: "already-registered" });
    const other = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u", email: null });
    assert.deepEqual(await directory.addPasskey({ accountId: other, passkey: passkey("cred-3") }), { kind: "already-registered" });
    assert.deepEqual(await directory.addPasskey({ accountId: "nobody", passkey: passkey("cred-4") }), { kind: "account-missing" });
  });

  test("recordPasskeyUse keeps the newest counter", async () => {
    const directory = makeDirectory();
    await directory.createAccountWithPasskey({ passkey: passkey("cred-5") });
    await directory.recordPasskeyUse({ credentialId: "cred-5", signCount: 42 });
    assert.equal((await directory.findPasskey({ credentialId: "cred-5" }))?.signCount, 42);
  });

  test("describe shows the provider and an email hint, never the address; unknown accounts are null", async () => {
    const directory = makeDirectory();
    const accountId = await directory.findOrCreateByIdentity({ provider: "github", subject: "7", email: "octo@example.com" });
    assert.deepEqual(summary(await directory.describe({ accountId })), [{ provider: "github", emailHint: "o•••@example.com" }]);
    assert.equal(await directory.describe({ accountId: "nobody" }), null);
  });

  test("each link is listed with an id that names it without its subject, and when it was added", async () => {
    const directory = makeDirectory();
    const accountId = await directory.findOrCreateByIdentity({ provider: "github", subject: "octocat-subject", email: null });
    const [link] = (await directory.describe({ accountId }))?.links ?? [];
    assert.equal(link?.linkId, linkIdOf("github:octocat-subject"));
    assert.ok(!(link?.linkId ?? "").includes("octocat"), "the id is a hash, not the subject");
    assert.equal(link?.linkedAtMs, 0);
  });

  // Every outcome of linkIdentity, from the same starting account: an okta account, plus a
  // github account that already exists for subject 9.
  const linkRows: readonly Readonly<{
    name: string;
    identity: Readonly<{ provider: string; subject: string }>;
    kind: string;
    providersAfter: readonly string[];
  }>[] = [
    { name: "a new identity of a new provider (control)", identity: { provider: "github", subject: "7" }, kind: "linked", providersAfter: ["okta", "github"] },
    { name: "the identity the account already has", identity: { provider: "okta", subject: "u1" }, kind: "already-linked-here", providersAfter: ["okta"] },
    { name: "an identity that opens another account", identity: { provider: "github", subject: "9" }, kind: "linked-to-another-account", providersAfter: ["okta"] },
    { name: "a second identity of a provider the account has", identity: { provider: "okta", subject: "u2" }, kind: "provider-already-linked", providersAfter: ["okta"] },
  ];
  for (const row of linkRows) {
    test(`linking ${row.name} → ${row.kind}`, async () => {
      const directory = makeDirectory();
      const accountId = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: null });
      const other = await directory.findOrCreateByIdentity({ provider: "github", subject: "9", email: null });
      const outcome = await directory.linkIdentity({ accountId, ...row.identity, email: "octo@example.com" });
      assert.equal(outcome.kind, row.kind);
      assert.deepEqual(summary(await directory.describe({ accountId }))?.map((link) => link.provider), row.providersAfter);
      // Never merged: the other account keeps its sign-in, and the identity still opens it.
      assert.equal(await directory.findOrCreateByIdentity({ provider: "github", subject: "9", email: null }), other);
    });
  }

  test("a linked identity signs in to the account it was linked to, and keeps its address hint", async () => {
    const directory = makeDirectory();
    const accountId = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: null });
    await directory.linkIdentity({ accountId, provider: "github", subject: "7", email: "octo@example.com" });
    assert.equal(await directory.findOrCreateByIdentity({ provider: "github", subject: "7", email: null }), accountId);
    assert.deepEqual(summary(await directory.describe({ accountId })), [
      { provider: "okta", emailHint: null },
      { provider: "github", emailHint: "o•••@example.com" },
    ]);
  });

  test("linking to an account that is gone is refused", async () => {
    const directory = makeDirectory();
    assert.deepEqual(await directory.linkIdentity({ accountId: "nobody", provider: "github", subject: "7", email: null }), { kind: "account-missing" });
  });

  test("unlinking removes one sign-in, which then opens a new account; the last one is never removed", async () => {
    const directory = makeDirectory();
    const accountId = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: null });
    await directory.linkIdentity({ accountId, provider: "github", subject: "7", email: null });
    assert.deepEqual(await directory.unlink({ accountId, linkId: linkIdOf("github:7") }), { kind: "unlinked", provider: "github" });
    assert.deepEqual(summary(await directory.describe({ accountId }))?.map((link) => link.provider), ["okta"]);
    assert.notEqual(await directory.findOrCreateByIdentity({ provider: "github", subject: "7", email: null }), accountId);
    assert.deepEqual(await directory.unlink({ accountId, linkId: linkIdOf("okta:u1") }), { kind: "last-method" });
    assert.equal(await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: null }), accountId, "the last sign-in still works");
  });

  test("unlinking another account's sign-in, or one that is gone, finds nothing", async () => {
    const directory = makeDirectory();
    const accountId = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: null });
    await directory.linkIdentity({ accountId, provider: "github", subject: "7", email: null });
    const other = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u2", email: null });
    await directory.linkIdentity({ accountId: other, provider: "github", subject: "8", email: null });
    assert.deepEqual(await directory.unlink({ accountId, linkId: linkIdOf("github:8") }), { kind: "not-found" });
    assert.deepEqual(await directory.unlink({ accountId, linkId: "no-such-link" }), { kind: "not-found" });
    assert.deepEqual(await directory.unlink({ accountId: "nobody", linkId: linkIdOf("github:7") }), { kind: "account-missing" });
  });

  test("an unlinked passkey no longer signs in", async () => {
    const directory = makeDirectory();
    const accountId = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: null });
    await directory.addPasskey({ accountId, passkey: passkey("cred-u") });
    assert.equal((await directory.unlink({ accountId, linkId: linkIdOf("passkey:cred-u") })).kind, "unlinked");
    assert.equal(await directory.findPasskey({ credentialId: "cred-u" }), null);
  });
});

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
    assert.deepEqual(summary(await directory.describe({ accountId })), [{ provider: "okta", emailHint: null }]);
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

  test("a linked Google becomes the account's Slides connection, and unlinking it releases that", async () => {
    const store = inMemoryAuthStore();
    const directory = storeAccountDirectory({ store, vault: fakeVault(), now: () => new Date(0), newAccountId });
    const accountId = await directory.findOrCreateByIdentity({ provider: "github", subject: "7", email: null });
    await directory.linkIdentity({ accountId, provider: "google", subject: "g-sub", email: null });
    assert.equal((await store.accounts.get({ key: accountId }))?.googleSubject, "g-sub");
    await directory.unlink({ accountId, linkId: linkIdOf("google:g-sub") });
    assert.equal((await store.accounts.get({ key: accountId }))?.googleSubject, null);
  });

  test("unlinking an email sign-in removes its password with it", async () => {
    const store = inMemoryAuthStore();
    const directory = storeAccountDirectory({ store, vault: fakeVault(), now: () => new Date(0), newAccountId });
    const accountId = await directory.findOrCreateByIdentity({ provider: "github", subject: "7", email: null });
    await directory.linkIdentity({ accountId, provider: "email", subject: "hash-of-address", email: "ada@example.com" });
    await store.passwordCredentials.put({ key: "email:hash-of-address", value: { subject: "hash-of-address", passwordHash: "$scrypt$x", updatedAtMs: 0 } });
    await directory.unlink({ accountId, linkId: linkIdOf("email:hash-of-address") });
    assert.equal(await store.passwordCredentials.get({ key: "email:hash-of-address" }), null);
  });

  // Parametric over what was linked: erasing removes every link whichever way it was added.
  const erasedRows: readonly Readonly<{ name: string; linked: readonly Readonly<{ provider: string; subject: string }>[]; recordsRemoved: number }>[] = [
    { name: "nothing linked (control)", linked: [], recordsRemoved: 2 },
    { name: "GitHub linked", linked: [{ provider: "github", subject: "7" }], recordsRemoved: 3 },
    { name: "GitHub and Apple linked", linked: [{ provider: "github", subject: "7" }, { provider: "apple", subject: "a.1" }], recordsRemoved: 4 },
  ];
  for (const row of erasedRows) {
    test(`erasing an account with ${row.name} removes every link, so each opens a new account afterwards`, async () => {
      const store = inMemoryAuthStore();
      const vault = fakeVault();
      const directory = storeAccountDirectory({ store, vault, now: () => new Date(0), newAccountId });
      const accountId = await directory.findOrCreateByIdentity({ provider: "okta", subject: "u1", email: null });
      for (const identity of row.linked) await directory.linkIdentity({ accountId, ...identity, email: null });
      const report = await createAccountEraser({ store, vault, revokeGoogleToken: () => Promise.resolve(false) }).eraseAccount({ accountId });
      assert.equal(report.recordsRemoved, row.recordsRemoved, "each link, plus the first link and the account");
      for (const identity of [{ provider: "okta", subject: "u1" }, ...row.linked]) {
        assert.equal(await store.accountLinks.get({ key: `${identity.provider}:${identity.subject}` }), null);
        assert.notEqual(await directory.findOrCreateByIdentity({ ...identity, email: null }), accountId);
      }
    });
  }

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
