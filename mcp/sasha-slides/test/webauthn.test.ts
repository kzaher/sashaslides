/**
 * Passkey (WebAuthn) verification on its own, against a software authenticator that builds
 * real authenticator data, client data and signatures. Every rejection the relying party
 * must make has a row; each row changes one thing about an otherwise honest ceremony.
 *
 *   node --test --import tsx mcp/sasha-slides/test/webauthn.test.ts
 */
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { describe, test } from "node:test";
import {
  parseAuthenticationCredential,
  parseRegistrationCredential,
  relyingPartyFor,
  verifyAuthentication,
  verifyRegistration,
  type PasskeyAlgorithm,
  type PasskeyRejection,
  type RelyingParty,
  type VerifiedRegistration,
} from "../http/webauthn";
import { createSoftwareAuthenticator, type CeremonyTamper, type SoftwareAuthenticator } from "./software-authenticator";

const RELYING_PARTY: RelyingParty = relyingPartyFor({ publicUrl: "https://slides.example.test/", requireUserVerification: false });

function challenge(): string {
  return randomBytes(32).toString("base64url");
}

function register(
  authenticator: SoftwareAuthenticator,
  options: Readonly<{ tamper: CeremonyTamper; relyingParty?: RelyingParty }>,
): ReturnType<typeof verifyRegistration> {
  const expectedChallenge = challenge();
  const credential = parseRegistrationCredential(
    authenticator.register({ challenge: expectedChallenge, userHandle: "handle", tamper: options.tamper }),
  );
  assert.ok(credential !== null, "the software authenticator's JSON parses");
  return verifyRegistration({ relyingParty: options.relyingParty ?? RELYING_PARTY, expectedChallenge, credential });
}

function registered(authenticator: SoftwareAuthenticator): VerifiedRegistration {
  const outcome = register(authenticator, { tamper: {} });
  assert.equal(outcome.kind, "ok", JSON.stringify(outcome));
  if (outcome.kind !== "ok") throw new Error("unreachable");
  return outcome.registration;
}

function authenticate(
  authenticator: SoftwareAuthenticator,
  options: Readonly<{
    registration: VerifiedRegistration;
    storedSignCount: number;
    tamper: CeremonyTamper;
    relyingParty?: RelyingParty;
    expectedChallenge?: string;
  }>,
): ReturnType<typeof verifyAuthentication> {
  const issued = challenge();
  const credential = parseAuthenticationCredential(authenticator.assert({ challenge: issued, tamper: options.tamper }));
  assert.ok(credential !== null);
  return verifyAuthentication({
    relyingParty: options.relyingParty ?? RELYING_PARTY,
    expectedChallenge: options.expectedChallenge ?? issued,
    credential,
    publicKey: options.registration.publicKey,
    algorithm: options.registration.algorithm,
    storedSignCount: options.storedSignCount,
  });
}

function rejection(outcome: Readonly<{ kind: string }> & Partial<Readonly<{ reason: PasskeyRejection }>>): PasskeyRejection | "ok" {
  return outcome.kind === "ok" ? "ok" : (outcome.reason ?? "ok");
}

const ALGORITHMS: readonly PasskeyAlgorithm[] = ["ES256", "RS256"];

describe("relyingPartyFor", () => {
  test("the relying party id is the public URL's host and the origin is its origin", () => {
    assert.deepEqual(relyingPartyFor({ publicUrl: "https://sashaslides.com/", requireUserVerification: true }), {
      id: "sashaslides.com",
      origin: "https://sashaslides.com",
      requireUserVerification: true,
    });
    assert.equal(relyingPartyFor({ publicUrl: "http://127.0.0.1:8787", requireUserVerification: false }).id, "127.0.0.1");
  });
});

for (const algorithm of ALGORITHMS) {
  describe(`registration (${algorithm})`, () => {
    const make = (): SoftwareAuthenticator =>
      createSoftwareAuthenticator({ algorithm, rpId: RELYING_PARTY.id, origin: RELYING_PARTY.origin, counting: true });

    test("an honest ceremony yields the credential id, the public key, the algorithm and the counter", () => {
      const authenticator = make();
      const registration = registered(authenticator);
      assert.equal(registration.credentialId, authenticator.credentialId);
      assert.equal(registration.algorithm, algorithm);
      assert.equal(registration.signCount, 1);
      assert.equal(registration.userVerified, true);
      assert.match(registration.publicKey, /^[A-Za-z0-9_-]+$/, "SPKI, base64url");
    });

    const rows: readonly Readonly<{ name: string; tamper: CeremonyTamper; relyingParty?: RelyingParty; reason: PasskeyRejection | "ok" }>[] = [
      { name: "a foreign origin", tamper: { origin: "https://evil.example" }, reason: "origin-mismatch" },
      { name: "a sibling subdomain origin", tamper: { origin: "https://www.slides.example.test" }, reason: "origin-mismatch" },
      { name: "a foreign relying party id", tamper: { rpId: "evil.example" }, reason: "rp-id-mismatch" },
      { name: "a sign-in ceremony type", tamper: { clientDataType: "webauthn.get" }, reason: "wrong-type" },
      { name: "a cross-origin iframe", tamper: { crossOrigin: true }, reason: "cross-origin" },
      { name: "no user presence", tamper: { userPresent: false }, reason: "user-not-present" },
      { name: "no user verification when it is only preferred", tamper: { userVerified: false }, reason: "ok" },
      {
        name: "no user verification when it is required",
        tamper: { userVerified: false },
        relyingParty: { ...RELYING_PARTY, requireUserVerification: true },
        reason: "user-not-verified",
      },
      { name: "a reported id that is not the attested one", tamper: { reportedId: randomBytes(32).toString("base64url") }, reason: "credential-id-mismatch" },
    ];
    for (const row of rows) {
      test(`${row.name} → ${row.reason}`, () => {
        assert.equal(rejection(register(make(), { tamper: row.tamper, ...(row.relyingParty === undefined ? {} : { relyingParty: row.relyingParty }) })), row.reason);
      });
    }

    test("a challenge other than the one issued is refused", () => {
      const authenticator = make();
      const credential = parseRegistrationCredential(authenticator.register({ challenge: challenge(), userHandle: "handle", tamper: {} }));
      assert.ok(credential !== null);
      const outcome = verifyRegistration({ relyingParty: RELYING_PARTY, expectedChallenge: challenge(), credential });
      assert.equal(rejection(outcome), "challenge-mismatch");
    });
  });

  describe(`authentication (${algorithm})`, () => {
    const rows: readonly Readonly<{
      name: string;
      counting: boolean;
      stored: (registration: VerifiedRegistration) => number;
      tamper: CeremonyTamper;
      relyingParty?: RelyingParty;
      reason: PasskeyRejection | "ok";
    }>[] = [
      { name: "honest, counter growing", counting: true, stored: (registration) => registration.signCount, tamper: {}, reason: "ok" },
      { name: "honest, counter always zero", counting: false, stored: () => 0, tamper: {}, reason: "ok" },
      { name: "a tampered signature", counting: true, stored: () => 0, tamper: { flipSignature: true }, reason: "bad-signature" },
      { name: "a foreign origin", counting: true, stored: () => 0, tamper: { origin: "https://evil.example" }, reason: "origin-mismatch" },
      { name: "a foreign relying party id", counting: true, stored: () => 0, tamper: { rpId: "evil.example" }, reason: "rp-id-mismatch" },
      { name: "a registration ceremony type", counting: true, stored: () => 0, tamper: { clientDataType: "webauthn.create" }, reason: "wrong-type" },
      { name: "no user presence", counting: true, stored: () => 0, tamper: { userPresent: false }, reason: "user-not-present" },
      {
        name: "no user verification when required",
        counting: true,
        stored: () => 0,
        tamper: { userVerified: false },
        relyingParty: { ...RELYING_PARTY, requireUserVerification: true },
        reason: "user-not-verified",
      },
      { name: "a counter that went backwards", counting: true, stored: () => 10, tamper: { signCount: 9 }, reason: "counter-regressed" },
      { name: "a counter that did not move", counting: true, stored: () => 10, tamper: { signCount: 10 }, reason: "counter-regressed" },
      { name: "a counter that dropped to zero", counting: true, stored: () => 10, tamper: { signCount: 0 }, reason: "counter-regressed" },
    ];
    for (const row of rows) {
      test(`${row.name} → ${row.reason}`, () => {
        const authenticator = createSoftwareAuthenticator({ algorithm, rpId: RELYING_PARTY.id, origin: RELYING_PARTY.origin, counting: row.counting });
        const registration = registered(authenticator);
        const outcome = authenticate(authenticator, {
          registration,
          storedSignCount: row.stored(registration),
          tamper: row.tamper,
          ...(row.relyingParty === undefined ? {} : { relyingParty: row.relyingParty }),
        });
        assert.equal(rejection(outcome), row.reason, JSON.stringify(outcome));
      });
    }

    test("an honest assertion reports the new counter", () => {
      const authenticator = createSoftwareAuthenticator({ algorithm, rpId: RELYING_PARTY.id, origin: RELYING_PARTY.origin, counting: true });
      const registration = registered(authenticator);
      const outcome = authenticate(authenticator, { registration, storedSignCount: registration.signCount, tamper: {} });
      assert.deepEqual(outcome, { kind: "ok", signCount: 2, userVerified: true });
    });

    test("another credential's public key does not verify the signature", () => {
      const signer = createSoftwareAuthenticator({ algorithm, rpId: RELYING_PARTY.id, origin: RELYING_PARTY.origin, counting: false });
      const other = createSoftwareAuthenticator({ algorithm, rpId: RELYING_PARTY.id, origin: RELYING_PARTY.origin, counting: false });
      registered(signer);
      const outcome = authenticate(signer, { registration: registered(other), storedSignCount: 0, tamper: {} });
      assert.equal(rejection(outcome), "bad-signature");
    });

    test("a challenge other than the one issued is refused", () => {
      const authenticator = createSoftwareAuthenticator({ algorithm, rpId: RELYING_PARTY.id, origin: RELYING_PARTY.origin, counting: false });
      const outcome = authenticate(authenticator, { registration: registered(authenticator), storedSignCount: 0, tamper: {}, expectedChallenge: challenge() });
      assert.equal(rejection(outcome), "challenge-mismatch");
    });
  });
}

describe("parsing the browser's JSON", () => {
  const rows: readonly Readonly<{ name: string; value: unknown }>[] = [
    { name: "not an object", value: "credential" },
    { name: "a wrong type", value: { id: "AA", rawId: "AA", type: "password", response: {} } },
    { name: "a non-base64url field", value: { id: "AA", rawId: "AA", type: "public-key", response: { clientDataJSON: "a+b/", attestationObject: "AA" } } },
    { name: "id and rawId disagree", value: { id: "AA", rawId: "AQ", type: "public-key", response: { clientDataJSON: "AA", attestationObject: "AA" } } },
  ];
  for (const row of rows) {
    test(`${row.name} is refused`, () => {
      assert.equal(parseRegistrationCredential(row.value), null);
      assert.equal(parseAuthenticationCredential(row.value), null);
    });
  }

  test("garbage attestation bytes are a rejection, not a crash", () => {
    const credential = parseRegistrationCredential({
      id: "AA",
      rawId: "AA",
      type: "public-key",
      response: { clientDataJSON: Buffer.from("{}").toString("base64url"), attestationObject: "_____w" },
    });
    assert.ok(credential !== null);
    assert.equal(rejection(verifyRegistration({ relyingParty: RELYING_PARTY, expectedChallenge: challenge(), credential })), "malformed");
  });
});
