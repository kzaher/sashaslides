/**
 * Invitation email hashes (SPEC.md 21.7): `index.json` names no address in the clear, and the hash
 * is KEYED with a server secret, so a copy of the index cannot be checked against a list of
 * addresses by anyone without that secret.
 *
 *   cd mcp/sasha-slides && npx tsx --test decks/deck-identity.test.ts
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";
import { invitationEmailHasher, legacyInvitationEmailHash } from "./deck-identity";

describe("invitation email hashes", () => {
  test("the same address hashes differently under two secrets, and never as a plain SHA-256", () => {
    const first = invitationEmailHasher({ secret: "first-server-secret-that-is-long-enough-000" });
    const second = invitationEmailHasher({ secret: "second-server-secret-that-is-long-enough-00" });
    const email = "Person@Example.com";
    assert.notEqual(first.hash(email), second.hash(email));
    assert.equal(first.hash(email), first.hash(" person@example.com "), "addresses are normalised before hashing");
    assert.notEqual(first.hash(email), createHash("sha256").update("person@example.com", "utf-8").digest("hex"));
    assert.notEqual(first.hash(email), legacyInvitationEmailHash(email), "not the old unkeyed form either");
    assert.match(first.hash(email), /^[0-9a-f]{64}$/u);
  });

  test("an address matches its keyed hash and its old unkeyed hash, and nothing else", () => {
    const hasher = invitationEmailHasher({ secret: "a-server-secret-that-is-long-enough-0000000" });
    const accepted = hasher.acceptedHashes("person@example.com");
    assert.ok(accepted.includes(hasher.hash("person@example.com")));
    assert.ok(accepted.includes(legacyInvitationEmailHash("person@example.com")));
    assert.equal(accepted.includes(hasher.hash("someone.else@example.com")), false);
  });
});
