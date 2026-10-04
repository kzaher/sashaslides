// REPORT IDENTIFIERS. Two of them, for two different jobs, which is the whole point of this file.
//
// `ReportId` is what the submitter quotes to a maintainer. It is unguessable (128 bits of CSPRNG)
// but it is NOT treated as a secret, because the moment a user pastes it into a chat window it
// stops being one. Everything reachable with an id alone therefore has to be harmless, and it is:
// `GET /v1/reports/:id` answers with timestamps, byte counts and version strings, never content.
//
// `DeletionToken` is a separate 128-bit secret, returned once at submission and never again, and
// stored only as a SHA-256 digest. Deletion is the destructive operation, so it gets the real
// secret rather than riding on the quotable identifier. If the two were the same value, quoting
// your report id in public would hand a stranger the ability to delete it.
//
// BOTH TYPES ARE BRANDED. A path segment arrives as a `string`; only `parseReportId` can turn one
// into a `ReportId`, and the store accepts nothing else. That is what makes path traversal
// (`/v1/reports/..%2f..%2fetc%2fpasswd`) structurally impossible rather than defended against: the
// character class is a closed alphabet with no dot and no slash in it, so a traversal attempt
// cannot produce a value of the type the filesystem code requires.

/** The quotable identifier. Opaque; always rendered with its `rep_` prefix. */
export type ReportId = string & { readonly [reportIdBrand]: true };

/** The one-time deletion secret. Opaque; always rendered with its `del_` prefix. */
export type DeletionToken = string & { readonly [deletionTokenBrand]: true };

/**
 * The entropy source, injected rather than imported, so a test can make ids deterministic without
 * reaching into `node:crypto`.
 */
export type RandomBytes = (size: number) => Uint8Array;

export const REPORT_ID_PREFIX = "rep_";
export const DELETION_TOKEN_PREFIX = "del_";

/** 128 bits: far beyond enumeration, and 26 base32 characters is still a pasteable length. */
const SECRET_BYTES = 16;

export function newReportId({ randomBytes }: { randomBytes: RandomBytes }): ReportId {
  // The alphabet and length are fixed by `encodeBase32`, so the result always matches the pattern
  // `parseReportId` enforces.
  return `${REPORT_ID_PREFIX}${encodeBase32(randomBytes(SECRET_BYTES))}` as ReportId;
}

export function newDeletionToken({ randomBytes }: { randomBytes: RandomBytes }): DeletionToken {
  // Same construction as `newReportId`, so the same invariant holds.
  return `${DELETION_TOKEN_PREFIX}${encodeBase32(randomBytes(SECRET_BYTES))}` as DeletionToken;
}

/**
 * The boundary for anything that came off a URL. Returns null rather than throwing, because a bad
 * id is a 404, not an error.
 */
export function parseReportId(candidate: string): ReportId | null {
  if (!ID_PATTERN.test(candidate)) return null;
  // The regex above pins prefix, alphabet and length, which is the entire definition of the brand.
  return candidate as ReportId;
}

export function parseDeletionToken(candidate: string): DeletionToken | null {
  if (!TOKEN_PATTERN.test(candidate)) return null;
  // As above: the pattern is the brand's definition.
  return candidate as DeletionToken;
}

declare const reportIdBrand: unique symbol;
declare const deletionTokenBrand: unique symbol;

/**
 * Crockford's base32 alphabet minus its checksum symbols: no `i`, `l`, `o` or `u`, so an id read
 * aloud or retyped cannot become a different valid id, and no `.` or `/` so it is inert in a path.
 */
const BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

const ID_PATTERN = new RegExp(`^${REPORT_ID_PREFIX}[${BASE32_ALPHABET}]{26}$`);
const TOKEN_PATTERN = new RegExp(`^${DELETION_TOKEN_PREFIX}[${BASE32_ALPHABET}]{26}$`);

/** 16 bytes -> 26 characters (128 bits over 5 bits per character, rounded up). */
function encodeBase32(bytes: Uint8Array): string {
  let output = "";
  let accumulator = 0;
  let bitsHeld = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bitsHeld += 8;
    while (bitsHeld >= 5) {
      bitsHeld -= 5;
      output += symbolAt((accumulator >> bitsHeld) & 31);
    }
  }
  if (bitsHeld > 0) output += symbolAt((accumulator << (5 - bitsHeld)) & 31);
  return output;
}

function symbolAt(index: number): string {
  const symbol = BASE32_ALPHABET[index];
  // `index` is masked to 0-31 by every caller and the alphabet has exactly 32 symbols.
  return symbol === undefined ? "0" : symbol;
}
