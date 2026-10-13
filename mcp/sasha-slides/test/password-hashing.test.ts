/**
 * Password hashes: scrypt with a per-password salt and the cost parameters stored beside the
 * hash, so the cost can be raised later and old hashes still verify.
 *
 *   node --test --import tsx mcp/sasha-slides/test/password-hashing.test.ts
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { DEFAULT_SCRYPT_COST, hashPassword, isWeakerThan, verifyPassword, type ScryptCost } from "../http/password-hashing";

const CHEAP: ScryptCost = { logCost: 10, blockSize: 8, parallelization: 1 };

describe("password hashing", () => {
  test("the default cost is scrypt N=2^15, r=8, p=1, and is what production hashes with", async () => {
    assert.deepEqual(DEFAULT_SCRYPT_COST, { logCost: 15, blockSize: 8, parallelization: 1 });
    const encoded = await hashPassword({ password: "correct horse battery staple", cost: DEFAULT_SCRYPT_COST });
    assert.match(encoded, /^\$scrypt\$ln=15,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(await verifyPassword({ password: "correct horse battery staple", encoded }), { kind: "match" });
  });

  test("the same password hashes differently each time (random salt), and both verify", async () => {
    const first = await hashPassword({ password: "same password here", cost: CHEAP });
    const second = await hashPassword({ password: "same password here", cost: CHEAP });
    assert.notEqual(first, second);
    assert.deepEqual(await verifyPassword({ password: "same password here", encoded: first }), { kind: "match" });
    assert.deepEqual(await verifyPassword({ password: "same password here", encoded: second }), { kind: "match" });
  });

  test("a different password does not match", async () => {
    const encoded = await hashPassword({ password: "same password here", cost: CHEAP });
    assert.deepEqual(await verifyPassword({ password: "same password herE", encoded }), { kind: "mismatch" });
  });

  test("unicode passwords are compared after NFC normalisation", async () => {
    const composed = "café password long";
    const decomposed = "café password long";
    const encoded = await hashPassword({ password: composed, cost: CHEAP });
    assert.deepEqual(await verifyPassword({ password: decomposed, encoded }), { kind: "match" });
  });

  test("a hash made at a lower cost still verifies, and reports that it should be redone", async () => {
    const encoded = await hashPassword({ password: "old but valid password", cost: CHEAP });
    assert.equal(isWeakerThan({ encoded, cost: DEFAULT_SCRYPT_COST }), true);
    assert.equal(isWeakerThan({ encoded, cost: CHEAP }), false);
  });

  for (const encoded of ["", "plaintext", "$scrypt$ln=99,r=8,p=1$AAAA$BBBB", "$bcrypt$x", "$scrypt$ln=10,r=8,p=1$!!$??"]) {
    test(`an unreadable stored hash ${JSON.stringify(encoded)} never matches`, async () => {
      assert.deepEqual(await verifyPassword({ password: "anything at all", encoded }), { kind: "unreadable" });
    });
  }
});
