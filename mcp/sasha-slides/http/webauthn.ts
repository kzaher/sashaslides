/**
 * Passkey (WebAuthn) verification for the account portal: a registration ("create a
 * passkey") and an authentication ("sign in with it"), each checked against the challenge
 * this server issued.
 *
 * WRITTEN HERE, NOT TAKEN FROM A LIBRARY. `@simplewebauthn/server` would also do it, but the
 * portal needs only the part of WebAuthn that has no trust decisions in it: we request
 * attestation "none" (we do not care which authenticator model holds the key), so what is
 * left is two signature algorithms (ES256, RS256) that node:crypto verifies natively from a
 * JSON Web Key, and a CBOR decoder for the three small structures an authenticator sends.
 * Together that is a few hundred lines a reviewer can read end to end, against a dependency
 * that would have to be pinned in two package.json files (the repo root and the connector
 * image's) and would bring its own CBOR, ASN.1 and certificate-chain code into the server
 * that holds every user's sealed Google grant. Algorithms beyond these two are refused, so
 * the browser is offered only these two (`PASSKEY_ALGORITHM_IDS`).
 *
 * What is verified, each against a named attack:
 *
 *  - **Phishing.** The client data's `origin` must be exactly the public origin, and the
 *    authenticator data's relying party id hash must be SHA-256 of the public host. A page
 *    on another site cannot obtain an assertion that passes either check.
 *  - **Replay.** The client data's `challenge` must equal the one the caller issued. The
 *    caller (`account-portal.ts`) issues each challenge once, binds it to the browser with a
 *    cookie and forgets it on first use, so an old assertion verifies against nothing.
 *  - **Framing.** `crossOrigin: true` (a ceremony run inside someone else's iframe) is
 *    refused, as is the other ceremony's `type`.
 *  - **Silent use.** The user-present flag is required. The user-verified flag (a PIN or a
 *    biometric) is required only when the relying party says so; the portal asks for it as
 *    "preferred", because a security key without a PIN is still a phishing-proof second
 *    possession factor.
 *  - **Forgery.** The signature over `authenticatorData ‖ SHA-256(clientDataJSON)` must
 *    verify under the public key stored at registration.
 *  - **A cloned authenticator.** When either the stored or the new signature counter is
 *    non-zero, the new one must be strictly greater. Synced passkeys report 0 forever and
 *    pass; a counter that stalls or goes backwards means two copies of the key exist.
 *
 * Attestation statements are not verified, whatever their format: with conveyance "none" a
 * browser sends format "none", but it may pass a self-attestation ("packed" without a
 * certificate) through unchanged, and neither one says anything we would act on. The
 * credential's public key comes from the authenticator data, which the first signature in
 * an authentication then proves the authenticator holds.
 *
 * Every function here is pure: no clock, no store, no network. Malformed input of any kind
 * is a `rejected` outcome with reason `malformed`, never an exception.
 */
import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { constantTimeEqual } from "./cookies";
import { asRecord, asString, parseJson } from "./json-values";
import { assertNever } from "../engine/src/contracts/assert-never.ts";

/** The two signature algorithms the portal offers and accepts. */
export type PasskeyAlgorithm = "ES256" | "RS256";

/** The COSE algorithm numbers the browser is offered, in order of preference. */
export const PASSKEY_ALGORITHM_IDS: Readonly<Record<PasskeyAlgorithm, number>> = { ES256: -7, RS256: -257 };

/** Every accepted algorithm, in the order the browser is offered them. */
export const PASSKEY_ALGORITHMS: readonly PasskeyAlgorithm[] = ["ES256", "RS256"];

export type RelyingParty = Readonly<{
  /** The public host, e.g. `sashaslides.com`. */
  id: string;
  /** The public origin, e.g. `https://sashaslides.com`. */
  origin: string;
  /** True: the user-verified flag (PIN or biometric) is required, not just preferred. */
  requireUserVerification: boolean;
}>;

/** The relying party is the public URL: its host is the id, its origin the only accepted origin. */
export function relyingPartyFor(options: Readonly<{ publicUrl: string; requireUserVerification: boolean }>): RelyingParty {
  const url = new URL(options.publicUrl);
  return { id: url.hostname, origin: url.origin, requireUserVerification: options.requireUserVerification };
}

/** What `PublicKeyCredential.toJSON()` sends after `navigator.credentials.create`, decoded. */
export type RegistrationCredential = Readonly<{ id: string; clientDataJSON: Buffer; attestationObject: Buffer }>;

/** What `PublicKeyCredential.toJSON()` sends after `navigator.credentials.get`, decoded. */
export type AuthenticationCredential = Readonly<{
  id: string;
  clientDataJSON: Buffer;
  authenticatorData: Buffer;
  signature: Buffer;
  /** base64url, as the browser sent it; null when the authenticator returned none. */
  userHandle: string | null;
}>;

/** The parse boundary for a registration from the page's script; null when anything is off. */
export function parseRegistrationCredential(value: unknown): RegistrationCredential | null {
  const envelope = parseEnvelope(value);
  if (envelope === null) return null;
  const clientDataJSON = base64UrlBytes(envelope.response["clientDataJSON"]);
  const attestationObject = base64UrlBytes(envelope.response["attestationObject"]);
  if (clientDataJSON === null || attestationObject === null) return null;
  return { id: envelope.id, clientDataJSON, attestationObject };
}

/** The parse boundary for an authentication from the page's script; null when anything is off. */
export function parseAuthenticationCredential(value: unknown): AuthenticationCredential | null {
  const envelope = parseEnvelope(value);
  if (envelope === null) return null;
  const clientDataJSON = base64UrlBytes(envelope.response["clientDataJSON"]);
  const authenticatorData = base64UrlBytes(envelope.response["authenticatorData"]);
  const signature = base64UrlBytes(envelope.response["signature"]);
  if (clientDataJSON === null || authenticatorData === null || signature === null) return null;
  const rawUserHandle = envelope.response["userHandle"];
  const userHandle = rawUserHandle === undefined || rawUserHandle === null ? null : asString(rawUserHandle);
  if (userHandle !== null && !isBase64Url(userHandle)) return null;
  if (rawUserHandle !== undefined && rawUserHandle !== null && userHandle === null) return null;
  return { id: envelope.id, clientDataJSON, authenticatorData, signature, userHandle };
}

export type PasskeyRejection =
  | "malformed"
  | "wrong-type"
  | "challenge-mismatch"
  | "origin-mismatch"
  | "cross-origin"
  | "rp-id-mismatch"
  | "user-not-present"
  | "user-not-verified"
  | "no-credential-data"
  | "credential-id-mismatch"
  | "unsupported-algorithm"
  | "bad-signature"
  | "counter-regressed";

export type VerifiedRegistration = Readonly<{
  /** base64url; the passkey's subject in the account directory. */
  credentialId: string;
  /** The public key as SPKI DER, base64url. */
  publicKey: string;
  algorithm: PasskeyAlgorithm;
  signCount: number;
  userVerified: boolean;
}>;

export type RegistrationVerification =
  | Readonly<{ kind: "ok"; registration: VerifiedRegistration }>
  | Readonly<{ kind: "rejected"; reason: PasskeyRejection; detail: string }>;

export function verifyRegistration(
  options: Readonly<{ relyingParty: RelyingParty; expectedChallenge: string; credential: RegistrationCredential }>,
): RegistrationVerification {
  const { relyingParty, credential } = options;
  const clientData = checkClientData({
    bytes: credential.clientDataJSON,
    type: "webauthn.create",
    expectedChallenge: options.expectedChallenge,
    origin: relyingParty.origin,
  });
  if (clientData !== null) return clientData;

  const attestation = decodeCborWhole(credential.attestationObject);
  const authData = attestation instanceof Map ? attestation.get("authData") : undefined;
  if (!(authData instanceof Uint8Array)) return rejected("malformed", "attestation object has no authData");
  const parsed = parseAuthenticatorData(Buffer.from(authData));
  if (parsed === null) return rejected("malformed", "authenticator data does not parse");
  const flagsProblem = checkAuthenticatorFlags({ authenticatorData: parsed, relyingParty });
  if (flagsProblem !== null) return flagsProblem;
  if (parsed.attested === null) return rejected("no-credential-data", "registration carries no attested credential");

  const credentialId = parsed.attested.credentialId.toString("base64url");
  if (credentialId !== credential.id) return rejected("credential-id-mismatch", "the reported id is not the attested credential");
  if (parsed.attested.credentialId.length > MAX_CREDENTIAL_ID_BYTES) return rejected("malformed", "credential id is too long");
  const key = publicKeyFromCose(parsed.attested.coseKey);
  if (key.kind === "rejected") return key;
  return {
    kind: "ok",
    registration: {
      credentialId,
      publicKey: key.key.export({ format: "der", type: "spki" }).toString("base64url"),
      algorithm: key.algorithm,
      signCount: parsed.signCount,
      userVerified: parsed.userVerified,
    },
  };
}

export type AuthenticationVerification =
  | Readonly<{ kind: "ok"; signCount: number; userVerified: boolean }>
  | Readonly<{ kind: "rejected"; reason: PasskeyRejection; detail: string }>;

export function verifyAuthentication(
  options: Readonly<{
    relyingParty: RelyingParty;
    expectedChallenge: string;
    credential: AuthenticationCredential;
    /** As stored from `VerifiedRegistration.publicKey`. */
    publicKey: string;
    algorithm: PasskeyAlgorithm;
    storedSignCount: number;
  }>,
): AuthenticationVerification {
  const { relyingParty, credential } = options;
  const clientData = checkClientData({
    bytes: credential.clientDataJSON,
    type: "webauthn.get",
    expectedChallenge: options.expectedChallenge,
    origin: relyingParty.origin,
  });
  if (clientData !== null) return clientData;

  const parsed = parseAuthenticatorData(credential.authenticatorData);
  if (parsed === null) return rejected("malformed", "authenticator data does not parse");
  const flagsProblem = checkAuthenticatorFlags({ authenticatorData: parsed, relyingParty });
  if (flagsProblem !== null) return flagsProblem;

  let key: KeyObject;
  try {
    key = createPublicKey({ key: Buffer.from(options.publicKey, "base64url"), format: "der", type: "spki" });
  } catch {
    return rejected("malformed", "the stored public key does not load");
  }
  const signed = Buffer.concat([credential.authenticatorData, createHash("sha256").update(credential.clientDataJSON).digest()]);
  if (!verifySignature({ algorithm: options.algorithm, key, signed, signature: credential.signature })) {
    return rejected("bad-signature", "the signature does not verify under the stored public key");
  }
  const { storedSignCount } = options;
  if ((storedSignCount !== 0 || parsed.signCount !== 0) && parsed.signCount <= storedSignCount) {
    return rejected(
      "counter-regressed",
      `signature counter ${String(parsed.signCount)} is not above the stored ${String(storedSignCount)}: the passkey may have been cloned`,
    );
  }
  return { kind: "ok", signCount: parsed.signCount, userVerified: parsed.userVerified };
}

// ---------------------------------------------------------------- parsing the envelope

type Envelope = Readonly<{ id: string; response: Readonly<Record<string, unknown>> }>;

/** Every authenticator we know of stays far below this; the spec's limit is 1023. */
const MAX_CREDENTIAL_ID_BYTES = 1023;

function parseEnvelope(value: unknown): Envelope | null {
  const record = asRecord(value);
  if (record === null || record["type"] !== "public-key") return null;
  const id = asString(record["id"]);
  const rawId = asString(record["rawId"]);
  const response = asRecord(record["response"]);
  if (id === null || rawId === null || response === null || id !== rawId || !isBase64Url(id) || id === "") return null;
  return { id, response };
}

function base64UrlBytes(value: unknown): Buffer | null {
  const text = asString(value);
  return text === null || !isBase64Url(text) ? null : Buffer.from(text, "base64url");
}

/** Node's base64url decoder skips characters it does not know; this refuses them instead. */
function isBase64Url(text: string): boolean {
  return /^[A-Za-z0-9_-]*$/.test(text);
}

function rejected(reason: PasskeyRejection, detail: string): Readonly<{ kind: "rejected"; reason: PasskeyRejection; detail: string }> {
  return { kind: "rejected", reason, detail };
}

// ---------------------------------------------------------------- client data

function checkClientData(
  options: Readonly<{ bytes: Buffer; type: "webauthn.create" | "webauthn.get"; expectedChallenge: string; origin: string }>,
): Readonly<{ kind: "rejected"; reason: PasskeyRejection; detail: string }> | null {
  const parsed = parseJson(options.bytes.toString("utf-8"));
  const record = parsed.kind === "ok" ? asRecord(parsed.value) : null;
  const type = asString(record?.["type"]);
  const challenge = asString(record?.["challenge"]);
  const origin = asString(record?.["origin"]);
  if (record === null || type === null || challenge === null || origin === null) {
    return rejected("malformed", "client data is not the expected JSON");
  }
  if (type !== options.type) return rejected("wrong-type", `client data type ${type}, expected ${options.type}`);
  if (!constantTimeEqual(challenge, options.expectedChallenge)) return rejected("challenge-mismatch", "not the challenge this browser was given");
  if (origin !== options.origin) return rejected("origin-mismatch", `origin ${origin}, expected ${options.origin}`);
  if (record["crossOrigin"] === true) return rejected("cross-origin", "the ceremony ran inside a cross-origin frame");
  return null;
}

// ---------------------------------------------------------------- authenticator data

type AuthenticatorData = Readonly<{
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  attested: Readonly<{ credentialId: Buffer; coseKey: CborValue }> | null;
}>;

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;
const FLAG_EXTENSION_DATA = 0x80;
const AUTHENTICATOR_DATA_HEADER_BYTES = 37;
const AUTHENTICATOR_MODEL_ID_BYTES = 16;

/** Layout: rpIdHash(32) flags(1) signCount(4) [model id(16) idLength(2) id key] [extensions]. */
function parseAuthenticatorData(bytes: Buffer): AuthenticatorData | null {
  if (bytes.length < AUTHENTICATOR_DATA_HEADER_BYTES) return null;
  const flags = bytes.readUInt8(32);
  let offset = AUTHENTICATOR_DATA_HEADER_BYTES;
  let attested: AuthenticatorData["attested"] = null;
  if ((flags & FLAG_ATTESTED_CREDENTIAL_DATA) !== 0) {
    const idLengthAt = offset + AUTHENTICATOR_MODEL_ID_BYTES;
    if (bytes.length < idLengthAt + 2) return null;
    const idLength = bytes.readUInt16BE(idLengthAt);
    const idEnd = idLengthAt + 2 + idLength;
    if (bytes.length < idEnd) return null;
    const coseKey = decodeCborPrefix({ bytes, offset: idEnd, depth: 0 });
    if (coseKey === null) return null;
    attested = { credentialId: bytes.subarray(idLengthAt + 2, idEnd), coseKey: coseKey.value };
    offset = coseKey.nextOffset;
  }
  if ((flags & FLAG_EXTENSION_DATA) !== 0) {
    const extensions = decodeCborPrefix({ bytes, offset, depth: 0 });
    if (extensions === null) return null;
    offset = extensions.nextOffset;
  }
  if (offset !== bytes.length) return null;
  return {
    rpIdHash: bytes.subarray(0, 32),
    userPresent: (flags & FLAG_USER_PRESENT) !== 0,
    userVerified: (flags & FLAG_USER_VERIFIED) !== 0,
    signCount: bytes.readUInt32BE(33),
    attested,
  };
}

function checkAuthenticatorFlags(
  options: Readonly<{ authenticatorData: AuthenticatorData; relyingParty: RelyingParty }>,
): Readonly<{ kind: "rejected"; reason: PasskeyRejection; detail: string }> | null {
  const { authenticatorData, relyingParty } = options;
  const expectedHash = createHash("sha256").update(relyingParty.id, "utf-8").digest();
  if (!timingSafeEqual(authenticatorData.rpIdHash, expectedHash)) {
    return rejected("rp-id-mismatch", `the authenticator signed for another relying party than ${relyingParty.id}`);
  }
  if (!authenticatorData.userPresent) return rejected("user-not-present", "the user-present flag is not set");
  if (relyingParty.requireUserVerification && !authenticatorData.userVerified) {
    return rejected("user-not-verified", "the user-verified flag is not set and verification is required");
  }
  return null;
}

// ---------------------------------------------------------------- COSE keys and signatures

/** COSE key labels (RFC 9052 / RFC 9053) and the values the two algorithms use. */
const COSE_KTY = 1;
const COSE_ALG = 3;
const COSE_EC2_CRV = -1;
const COSE_EC2_X = -2;
const COSE_EC2_Y = -3;
const COSE_RSA_N = -1;
const COSE_RSA_E = -2;
const COSE_KTY_EC2 = 2;
const COSE_KTY_RSA = 3;
const COSE_CRV_P256 = 1;
const P256_COORDINATE_BYTES = 32;
const MIN_RSA_MODULUS_BITS = 2048;

type KeyFromCose =
  | Readonly<{ kind: "ok"; key: KeyObject; algorithm: PasskeyAlgorithm }>
  | Readonly<{ kind: "rejected"; reason: PasskeyRejection; detail: string }>;

function publicKeyFromCose(coseKey: CborValue): KeyFromCose {
  if (!(coseKey instanceof Map)) return rejected("malformed", "the credential public key is not a COSE map");
  const algorithm = algorithmOf(coseKey.get(COSE_ALG));
  if (algorithm === null) return rejected("unsupported-algorithm", `COSE algorithm ${String(coseKey.get(COSE_ALG))} is not ES256 or RS256`);
  const bytesAt = (label: number): Buffer | null => {
    const value = coseKey.get(label);
    return value instanceof Uint8Array ? Buffer.from(value) : null;
  };
  try {
    switch (algorithm) {
      case "ES256": {
        const x = bytesAt(COSE_EC2_X);
        const y = bytesAt(COSE_EC2_Y);
        if (coseKey.get(COSE_KTY) !== COSE_KTY_EC2 || coseKey.get(COSE_EC2_CRV) !== COSE_CRV_P256) {
          return rejected("unsupported-algorithm", "ES256 needs an EC2 key on P-256");
        }
        if (x === null || y === null || x.length !== P256_COORDINATE_BYTES || y.length !== P256_COORDINATE_BYTES) {
          return rejected("malformed", "the P-256 point is not two 32-byte coordinates");
        }
        const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: x.toString("base64url"), y: y.toString("base64url") }, format: "jwk" });
        return { kind: "ok", key, algorithm };
      }
      case "RS256": {
        const modulus = bytesAt(COSE_RSA_N);
        const exponent = bytesAt(COSE_RSA_E);
        if (coseKey.get(COSE_KTY) !== COSE_KTY_RSA) return rejected("unsupported-algorithm", "RS256 needs an RSA key");
        if (modulus === null || exponent === null) return rejected("malformed", "the RSA key lacks its modulus or exponent");
        const key = createPublicKey({ key: { kty: "RSA", n: modulus.toString("base64url"), e: exponent.toString("base64url") }, format: "jwk" });
        const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
        if (bits < MIN_RSA_MODULUS_BITS) return rejected("unsupported-algorithm", `an RSA modulus of ${String(bits)} bits is too short`);
        return { kind: "ok", key, algorithm };
      }
      default:
        return assertNever(algorithm);
    }
  } catch (cause) {
    // createPublicKey refuses a point that is not on the curve, among other things.
    return rejected("malformed", `the public key does not load: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** The parse boundary from a COSE number; a closed lookup, so a new algorithm is added in one place. */
function algorithmOf(value: CborValue | undefined): PasskeyAlgorithm | null {
  for (const algorithm of PASSKEY_ALGORITHMS) {
    if (PASSKEY_ALGORITHM_IDS[algorithm] === value) return algorithm;
  }
  return null;
}

function verifySignature(
  options: Readonly<{ algorithm: PasskeyAlgorithm; key: KeyObject; signed: Buffer; signature: Buffer }>,
): boolean {
  const { algorithm, key, signed, signature } = options;
  try {
    switch (algorithm) {
      case "ES256":
        // WebAuthn ECDSA signatures are ASN.1 DER, node's default encoding.
        return key.asymmetricKeyType === "ec" && verify("sha256", signed, { key, dsaEncoding: "der" }, signature);
      case "RS256":
        // RSASSA-PKCS1-v1_5, node's default padding for an RSA key.
        return key.asymmetricKeyType === "rsa" && verify("sha256", signed, key, signature);
      default:
        return assertNever(algorithm);
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- a minimal CBOR decoder

/**
 * The subset of CBOR (RFC 8949) that authenticators send: unsigned and negative integers,
 * byte and text strings, arrays, maps, and the simple values false, true and null. Anything
 * else (indefinite lengths, tags, floats, integers past 2^53) does not decode, which is a
 * rejection: no authenticator data the portal needs uses them.
 */
type CborValue = number | string | boolean | null | Uint8Array | readonly CborValue[] | ReadonlyMap<CborValue, CborValue>;

/** Deep enough for an attestation object (three levels); bounds recursion on hostile input. */
const MAX_CBOR_DEPTH = 8;

/** The whole buffer as one value, or null when it is not exactly one well-formed item. */
function decodeCborWhole(bytes: Buffer): CborValue | null {
  const decoded = decodeCborPrefix({ bytes, offset: 0, depth: 0 });
  return decoded === null || decoded.nextOffset !== bytes.length ? null : decoded.value;
}

function decodeCborPrefix(
  options: Readonly<{ bytes: Buffer; offset: number; depth: number }>,
): Readonly<{ value: CborValue; nextOffset: number }> | null {
  const { bytes, offset, depth } = options;
  if (depth > MAX_CBOR_DEPTH || offset >= bytes.length) return null;
  const initial = bytes.readUInt8(offset);
  const majorType = initial >> 5;
  const head = readArgument({ bytes, offset, additional: initial & 0x1f });
  if (head === null) return null;
  const { argument, nextOffset } = head;
  switch (majorType) {
    case 0:
      return { value: argument, nextOffset };
    case 1:
      return { value: -1 - argument, nextOffset };
    case 2:
    case 3: {
      const end = nextOffset + argument;
      if (end > bytes.length) return null;
      const slice = bytes.subarray(nextOffset, end);
      return { value: majorType === 2 ? new Uint8Array(slice) : slice.toString("utf-8"), nextOffset: end };
    }
    case 4: {
      const items: CborValue[] = [];
      let cursor = nextOffset;
      for (let index = 0; index < argument; index += 1) {
        const item = decodeCborPrefix({ bytes, offset: cursor, depth: depth + 1 });
        if (item === null) return null;
        items.push(item.value);
        cursor = item.nextOffset;
      }
      return { value: items, nextOffset: cursor };
    }
    case 5: {
      const entries = new Map<CborValue, CborValue>();
      let cursor = nextOffset;
      for (let index = 0; index < argument; index += 1) {
        const key = decodeCborPrefix({ bytes, offset: cursor, depth: depth + 1 });
        if (key === null) return null;
        const entry = decodeCborPrefix({ bytes, offset: key.nextOffset, depth: depth + 1 });
        if (entry === null) return null;
        // Map keys are compared by identity, so only numbers and strings are useful (and allowed).
        if (typeof key.value !== "number" && typeof key.value !== "string") return null;
        if (entries.has(key.value)) return null;
        entries.set(key.value, entry.value);
        cursor = entry.nextOffset;
      }
      return { value: entries, nextOffset: cursor };
    }
    case 7:
      return simpleValue({ additional: initial & 0x1f, nextOffset: offset + 1 });
    default:
      // Major type 6 (tags) is not used by authenticators.
      return null;
  }
}

function readArgument(
  options: Readonly<{ bytes: Buffer; offset: number; additional: number }>,
): Readonly<{ argument: number; nextOffset: number }> | null {
  const { bytes, offset, additional } = options;
  const start = offset + 1;
  if (additional < 24) return { argument: additional, nextOffset: start };
  const width = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
  // 28-30 are reserved, 31 is an indefinite length: neither is accepted.
  if (width === 0 || start + width > bytes.length) return null;
  if (width === 8) {
    const big = bytes.readBigUInt64BE(start);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { argument: Number(big), nextOffset: start + width };
  }
  return { argument: bytes.readUIntBE(start, width), nextOffset: start + width };
}

function simpleValue(options: Readonly<{ additional: number; nextOffset: number }>): Readonly<{ value: CborValue; nextOffset: number }> | null {
  switch (options.additional) {
    case 20:
      return { value: false, nextOffset: options.nextOffset };
    case 21:
      return { value: true, nextOffset: options.nextOffset };
    case 22:
      return { value: null, nextOffset: options.nextOffset };
    default:
      return null;
  }
}
