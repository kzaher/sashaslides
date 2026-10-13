/**
 * Password hashes for email sign-in: node:crypto `scrypt`, a fresh random salt per password,
 * and the cost parameters written beside the hash so they can be raised later without
 * locking anyone out.
 *
 * Stored form (PHC-style, one string):
 *
 *   $scrypt$ln=15,r=8,p=1$<salt, 16 bytes base64url>$<key, 32 bytes base64url>
 *
 * Attacks and their defences:
 *
 *  - **Offline cracking of a stolen store file.** scrypt is memory-hard: at N=2^15, r=8 each
 *    guess costs 32 MiB and roughly 50–100 ms of one core, which is what makes a GPU or ASIC
 *    farm expensive. The salt is per password, so one precomputed table cannot cover two
 *    users and two users with the same password get different hashes.
 *  - **Timing.** The derived key is compared with `timingSafeEqual`, so how many leading
 *    bytes matched does not show in the response time.
 *  - **A hostile or corrupted stored value.** The parameters are read from the store, so they
 *    are bounded (`MAX_*`) before use: a hand-edited `ln=40` would otherwise ask for terabytes
 *    of memory. Anything out of bounds or malformed is `unreadable` and never matches.
 *  - **Two spellings of one password.** Input is NFC-normalised before hashing, so "é" typed
 *    as one code point or as "e" plus a combining accent is the same password.
 *
 * Raising the cost later: change `DEFAULT_SCRYPT_COST`; `isWeakerThan` tells the sign-in path
 * that a just-verified hash was made at a lower cost, and it is re-hashed then.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export type ScryptCost = Readonly<{
  /** log2 of scrypt's N (CPU and memory cost). */
  logCost: number;
  /** scrypt's r. */
  blockSize: number;
  /** scrypt's p. */
  parallelization: number;
}>;

export type PasswordCheck = Readonly<{ kind: "match" }> | Readonly<{ kind: "mismatch" }> | Readonly<{ kind: "unreadable" }>;

/** OWASP's scrypt floor is N=2^17 at r=8 for interactive logins on dedicated hardware; 2^15 keeps one sign-in under ~100 ms on the shared host. */
export const DEFAULT_SCRYPT_COST: ScryptCost = { logCost: 15, blockSize: 8, parallelization: 1 };

export async function hashPassword(options: Readonly<{ password: string; cost: ScryptCost }>): Promise<string> {
  const { cost } = options;
  const salt = randomBytes(SALT_BYTES);
  const key = await derive({ password: options.password, salt, cost });
  return `$scrypt$ln=${String(cost.logCost)},r=${String(cost.blockSize)},p=${String(cost.parallelization)}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export async function verifyPassword(options: Readonly<{ password: string; encoded: string }>): Promise<PasswordCheck> {
  const stored = parseEncoded(options.encoded);
  if (stored === null) return { kind: "unreadable" };
  const key = await derive({ password: options.password, salt: stored.salt, cost: stored.cost });
  return timingSafeEqual(key, stored.key) ? { kind: "match" } : { kind: "mismatch" };
}

/** True when `encoded` was made at a lower cost than `cost` in any parameter. */
export function isWeakerThan(options: Readonly<{ encoded: string; cost: ScryptCost }>): boolean {
  const stored = parseEncoded(options.encoded);
  if (stored === null) return true;
  return (
    stored.cost.logCost < options.cost.logCost ||
    stored.cost.blockSize < options.cost.blockSize ||
    stored.cost.parallelization < options.cost.parallelization
  );
}

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const MAX_LOG_COST = 20;
const MAX_BLOCK_SIZE = 32;
const MAX_PARALLELIZATION = 16;

type StoredHash = Readonly<{ cost: ScryptCost; salt: Buffer; key: Buffer }>;

function derive(options: Readonly<{ password: string; salt: Buffer; cost: ScryptCost }>): Promise<Buffer> {
  const { cost } = options;
  const costFactor = 2 ** cost.logCost;
  // scrypt needs 128·N·r·p bytes; node's default ceiling (32 MiB) is exactly the default cost,
  // which leaves no headroom, so the ceiling is set from the parameters.
  const maxmem = 256 * costFactor * cost.blockSize * cost.parallelization + 1024 * 1024;
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      Buffer.from(options.password.normalize("NFC"), "utf-8"),
      options.salt,
      KEY_BYTES,
      { N: costFactor, r: cost.blockSize, p: cost.parallelization, maxmem },
      (error, key) => (error === null ? resolve(key) : reject(error)),
    );
  });
}

function parseEncoded(encoded: string): StoredHash | null {
  const match = /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(encoded);
  if (match === null) return null;
  const [, logCostText, blockSizeText, parallelizationText, saltText, keyText] = match;
  const logCost = Number(logCostText);
  const blockSize = Number(blockSizeText);
  const parallelization = Number(parallelizationText);
  if (logCost < 1 || logCost > MAX_LOG_COST || blockSize < 1 || blockSize > MAX_BLOCK_SIZE) return null;
  if (parallelization < 1 || parallelization > MAX_PARALLELIZATION) return null;
  const salt = Buffer.from(saltText ?? "", "base64url");
  const key = Buffer.from(keyText ?? "", "base64url");
  if (salt.length < SALT_BYTES || key.length !== KEY_BYTES) return null;
  return { cost: { logCost, blockSize, parallelization }, salt, key };
}
