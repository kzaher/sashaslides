/**
 * A software passkey authenticator for the tests: a real ES256 or RS256 key pair from
 * node:crypto, real authenticator data, client data JSON, a "none" attestation object in
 * CBOR, and real signatures. It plays both the authenticator and the browser, so its output
 * is exactly what `PublicKeyCredential.toJSON()` would hand the page's script.
 *
 * Each ceremony takes a `tamper` record, so one honest authenticator can drive every
 * rejection the relying party must make: a foreign origin, a foreign relying party id, a
 * flipped signature, a signature counter that goes backwards, missing flags.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { assertNever } from "../google-auth";
import type { PasskeyAlgorithm } from "../http/webauthn";

export type RegistrationResponseJson = Readonly<{
  id: string;
  rawId: string;
  type: "public-key";
  response: Readonly<{ clientDataJSON: string; attestationObject: string }>;
  clientExtensionResults: Readonly<Record<string, never>>;
}>;

export type AuthenticationResponseJson = Readonly<{
  id: string;
  rawId: string;
  type: "public-key";
  response: Readonly<{ clientDataJSON: string; authenticatorData: string; signature: string; userHandle: string | null }>;
  clientExtensionResults: Readonly<Record<string, never>>;
}>;

/** What to spoil in one ceremony. Every field absent is an honest ceremony. */
export type CeremonyTamper = Readonly<{
  origin?: string;
  rpId?: string;
  clientDataType?: string;
  crossOrigin?: boolean;
  userPresent?: boolean;
  userVerified?: boolean;
  /** Overrides the counter the authenticator would report. */
  signCount?: number;
  /** Flips one bit of the signature after signing. */
  flipSignature?: boolean;
  /** The credential id the browser reports, when it should differ from the real one. */
  reportedId?: string;
  /** Overrides the user handle an assertion returns. */
  userHandle?: string | null;
}>;

export type SoftwareAuthenticator = Readonly<{
  /** base64url, the id every ceremony reports. */
  credentialId: string;
  register(options: Readonly<{ challenge: string; userHandle: string; tamper: CeremonyTamper }>): RegistrationResponseJson;
  assert(options: Readonly<{ challenge: string; tamper: CeremonyTamper }>): AuthenticationResponseJson;
}>;

export function createSoftwareAuthenticator(
  options: Readonly<{
    algorithm: PasskeyAlgorithm;
    rpId: string;
    origin: string;
    /** True: the counter starts at 1 and grows with each assertion. False: it is always 0, as with most synced passkeys. */
    counting: boolean;
  }>,
): SoftwareAuthenticator {
  const { algorithm, rpId, origin, counting } = options;
  const keys = generateKeys(algorithm);
  const credentialIdBytes = randomBytes(32);
  const credentialId = credentialIdBytes.toString("base64url");
  let counter = counting ? 1 : 0;
  let registeredUserHandle: string | null = null;

  const clientData = (options: Readonly<{ type: string; challenge: string; tamper: CeremonyTamper }>): Buffer =>
    Buffer.from(
      JSON.stringify({
        type: options.tamper.clientDataType ?? options.type,
        challenge: options.challenge,
        origin: options.tamper.origin ?? origin,
        crossOrigin: options.tamper.crossOrigin ?? false,
      }),
      "utf-8",
    );

  const flagsFor = (tamper: CeremonyTamper, attested: boolean): number =>
    (tamper.userPresent === false ? 0 : FLAG_USER_PRESENT) |
    (tamper.userVerified === false ? 0 : FLAG_USER_VERIFIED) |
    (attested ? FLAG_ATTESTED_CREDENTIAL_DATA : 0);

  const header = (tamper: CeremonyTamper, attested: boolean, signCount: number): Buffer => {
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(signCount);
    return Buffer.concat([
      createHash("sha256").update(tamper.rpId ?? rpId, "utf-8").digest(),
      Buffer.from([flagsFor(tamper, attested)]),
      counterBytes,
    ]);
  };

  return {
    credentialId,
    register: ({ challenge, userHandle, tamper }) => {
      registeredUserHandle = userHandle;
      const credentialIdLength = Buffer.alloc(2);
      credentialIdLength.writeUInt16BE(credentialIdBytes.length);
      const authenticatorData = Buffer.concat([
        header(tamper, true, tamper.signCount ?? counter),
        Buffer.alloc(16), // the all-zero authenticator model id, as with "none" attestation
        credentialIdLength,
        credentialIdBytes,
        encodeCbor(coseKey({ algorithm, publicKey: keys.publicKey })),
      ]);
      const attestationObject = encodeCbor(
        new Map<CborKey, CborInput>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authenticatorData],
        ]),
      );
      const reportedId = tamper.reportedId ?? credentialId;
      return {
        id: reportedId,
        rawId: reportedId,
        type: "public-key",
        response: {
          clientDataJSON: clientData({ type: "webauthn.create", challenge, tamper }).toString("base64url"),
          attestationObject: attestationObject.toString("base64url"),
        },
        clientExtensionResults: {},
      };
    },
    assert: ({ challenge, tamper }) => {
      if (counting) counter += 1;
      const authenticatorData = header(tamper, false, tamper.signCount ?? counter);
      const clientDataJSON = clientData({ type: "webauthn.get", challenge, tamper });
      const signed = Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]);
      const signature = sign("sha256", signed, keys.privateKey);
      if (tamper.flipSignature === true) {
        const last = signature.length - 1;
        signature.writeUInt8(signature.readUInt8(last) ^ 0x01, last);
      }
      const reportedId = tamper.reportedId ?? credentialId;
      return {
        id: reportedId,
        rawId: reportedId,
        type: "public-key",
        response: {
          clientDataJSON: clientDataJSON.toString("base64url"),
          authenticatorData: authenticatorData.toString("base64url"),
          signature: signature.toString("base64url"),
          userHandle: tamper.userHandle === undefined ? registeredUserHandle : tamper.userHandle,
        },
        clientExtensionResults: {},
      };
    },
  };
}

// ---------------------------------------------------------------- keys

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;

type KeyPair = Readonly<{ publicKey: KeyObject; privateKey: KeyObject }>;

function generateKeys(algorithm: PasskeyAlgorithm): KeyPair {
  switch (algorithm) {
    case "ES256":
      return generateKeyPairSync("ec", { namedCurve: "P-256" });
    case "RS256":
      return generateKeyPairSync("rsa", { modulusLength: 2048 });
    default:
      return assertNever(algorithm);
  }
}

function coseKey(options: Readonly<{ algorithm: PasskeyAlgorithm; publicKey: KeyObject }>): CborInput {
  const jwk = options.publicKey.export({ format: "jwk" });
  const field = (value: string | undefined): Buffer => Buffer.from(value ?? "", "base64url");
  switch (options.algorithm) {
    case "ES256":
      return new Map<CborKey, CborInput>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, field(jwk.x)],
        [-3, field(jwk.y)],
      ]);
    case "RS256":
      return new Map<CborKey, CborInput>([
        [1, 3],
        [3, -257],
        [-1, field(jwk.n)],
        [-2, field(jwk.e)],
      ]);
    default:
      return assertNever(options.algorithm);
  }
}

// ---------------------------------------------------------------- a minimal CBOR encoder

type CborKey = number | string;
type CborInput = number | string | Buffer | ReadonlyMap<CborKey, CborInput>;

function encodeCbor(value: CborInput): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf-8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  const parts: Buffer[] = [head(5, value.size)];
  for (const [key, entry] of value) parts.push(encodeCbor(key), encodeCbor(entry));
  return Buffer.concat(parts);
}

function head(majorType: number, argument: number): Buffer {
  const major = majorType << 5;
  if (argument < 24) return Buffer.from([major | argument]);
  if (argument < 0x100) return Buffer.from([major | 24, argument]);
  if (argument < 0x10000) {
    const bytes = Buffer.alloc(3);
    bytes[0] = major | 25;
    bytes.writeUInt16BE(argument, 1);
    return bytes;
  }
  const bytes = Buffer.alloc(5);
  bytes[0] = major | 26;
  bytes.writeUInt32BE(argument, 1);
  return bytes;
}
