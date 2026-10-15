/**
 * What the deck server keeps about each deck besides its document (SPEC.md 21.7), the index that
 * lets it find decks by account without opening any of them, and the one function that decides a
 * caller's role.
 *
 *  - `DeckRecord` is sealed under the OWNER's data key (`deck.sealed`): members, invitations with
 *    their addresses, link sharing, the Google Slides link, add-on bindings, and the title and
 *    times the deck list shows. Erasing the owner makes it unreadable.
 *  - `DeckIndex` (`index.json`) holds no personal data in the clear: account ids (random), hashes
 *    of invitation addresses and of add-on binding secrets, and creation times.
 *  - Both are parsed at the trust boundary (they are read from disk): a record that does not parse
 *    is treated like one that does not open.
 */
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import type { DeckRole, LinkSharing } from "../engine/src/contracts/deck-access.ts";
import type { GoogleSlidesLink } from "../engine/src/contracts/deck-api.ts";
import { parseDeckId, type DeckId } from "../engine/src/contracts/ids.ts";
import type { AccountId } from "../http/account-vault";

export type DeckRecord = Readonly<{
  version: 1;
  deckId: DeckId;
  ownerAccountId: AccountId;
  /** The owner first, with role "owner". */
  members: readonly MemberRecord[];
  invitations: readonly InvitationRecord[];
  linkSharing: LinkSharing;
  googleSlides: GoogleSlidesLink | null;
  addonBindings: readonly AddonBindingRecord[];
  /** The document's title as the server last saw it. */
  title: string;
  createdAt: number;
  updatedAt: number;
}>;

export type MemberRecord = Readonly<{ accountId: AccountId; role: DeckRole; addedAt: number }>;

export type InvitationRecord = Readonly<{
  invitationId: string;
  emailHash: string;
  email: string;
  role: Exclude<DeckRole, "owner">;
  invitedAt: number;
  /** Who invited: the 100-per-day limit is per inviting account. */
  invitedBy: AccountId;
}>;

export type AddonBindingRecord = Readonly<{ bindingSecretHash: string; presentationId: string }>;

export type DeckIndex = Readonly<{ version: 1; decks: Readonly<Record<string, DeckIndexEntry>> }>;

export type DeckIndexEntry = Readonly<{
  ownerAccountId: AccountId;
  memberAccountIds: readonly AccountId[];
  invitationEmailHashes: readonly string[];
  addonBindingHashes: readonly string[];
  createdAt: number;
}>;

export const EMPTY_DECK_INDEX: DeckIndex = { version: 1, decks: {} };

/** The caller's role on a deck, or null when they may not read it (the routes then answer 404). */
export function roleOf(options: Readonly<{ record: DeckRecord; accountId: AccountId }>): DeckRole | null {
  const member = options.record.members.find((candidate) => candidate.accountId === options.accountId);
  if (member !== undefined) return member.role;
  const sharing = options.record.linkSharing;
  switch (sharing.kind) {
    case "off":
      return null;
    case "anyoneSignedIn":
      return sharing.role;
    default:
      return assertNever(sharing);
  }
}

export function indexEntryOf(record: DeckRecord): DeckIndexEntry {
  return {
    ownerAccountId: record.ownerAccountId,
    memberAccountIds: record.members.map((member) => member.accountId),
    invitationEmailHashes: record.invitations.map((invitation) => invitation.emailHash),
    addonBindingHashes: record.addonBindings.map((binding) => binding.bindingSecretHash),
    createdAt: record.createdAt,
  };
}

/** Null when `value` is not a version 1 record (see the header). */
export function parseDeckRecord(value: unknown): DeckRecord | null {
  const record = asRecord(value);
  if (record === null || record["version"] !== 1) return null;
  const deckId = typeof record["deckId"] === "string" ? parseDeckId(record["deckId"]) : null;
  const ownerAccountId = asString(record["ownerAccountId"]);
  const members = parseList({ value: record["members"], parse: parseMember });
  const invitations = parseList({ value: record["invitations"], parse: parseInvitation });
  const linkSharing = parseLinkSharing(record["linkSharing"]);
  const addonBindings = parseList({ value: record["addonBindings"], parse: parseBinding });
  const title = asString(record["title"]);
  const createdAt = asNumber(record["createdAt"]);
  const updatedAt = asNumber(record["updatedAt"]);
  const googleSlides = record["googleSlides"] === null ? null : parseGoogleSlidesLink(record["googleSlides"]);
  if (deckId === null || ownerAccountId === null || members === null || invitations === null || linkSharing === null) return null;
  if (addonBindings === null || title === null || createdAt === null || updatedAt === null) return null;
  if (record["googleSlides"] !== null && googleSlides === null) return null;
  return { version: 1, deckId, ownerAccountId, members, invitations, linkSharing, googleSlides, addonBindings, title, createdAt, updatedAt };
}

/** Null when `value` is not a version 1 index; the storage then refuses to start rather than overwrite it. */
export function parseDeckIndex(value: unknown): DeckIndex | null {
  const record = asRecord(value);
  const decks = record === null ? null : asRecord(record["decks"]);
  if (record === null || record["version"] !== 1 || decks === null) return null;
  const parsed: Record<string, DeckIndexEntry> = {};
  for (const [deckId, entry] of Object.entries(decks)) {
    const fields = asRecord(entry);
    if (fields === null || parseDeckId(deckId) === null) return null;
    const ownerAccountId = asString(fields["ownerAccountId"]);
    const memberAccountIds = parseList({ value: fields["memberAccountIds"], parse: asString });
    const invitationEmailHashes = parseList({ value: fields["invitationEmailHashes"], parse: asString });
    const addonBindingHashes = parseList({ value: fields["addonBindingHashes"], parse: asString });
    const createdAt = asNumber(fields["createdAt"]);
    if (ownerAccountId === null || memberAccountIds === null || invitationEmailHashes === null || addonBindingHashes === null || createdAt === null) return null;
    parsed[deckId] = { ownerAccountId, memberAccountIds, invitationEmailHashes, addonBindingHashes, createdAt };
  }
  return { version: 1, decks: parsed };
}

const ROLES: readonly DeckRole[] = ["owner", "editor", "commenter", "viewer"];

function parseMember(value: unknown): MemberRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  const accountId = asString(record["accountId"]);
  const role = ROLES.find((candidate) => candidate === record["role"]) ?? null;
  const addedAt = asNumber(record["addedAt"]);
  return accountId === null || role === null || addedAt === null ? null : { accountId, role, addedAt };
}

function parseInvitation(value: unknown): InvitationRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  const invitationId = asString(record["invitationId"]);
  const emailHash = asString(record["emailHash"]);
  const email = asString(record["email"]);
  const role = parseInvitedRole(record["role"]);
  const invitedAt = asNumber(record["invitedAt"]);
  const invitedBy = asString(record["invitedBy"]);
  if (invitationId === null || emailHash === null || email === null || role === null || invitedAt === null || invitedBy === null) return null;
  return { invitationId, emailHash, email, role, invitedAt, invitedBy };
}

export function parseInvitedRole(value: unknown): Exclude<DeckRole, "owner"> | null {
  switch (value) {
    case "editor":
    case "commenter":
    case "viewer":
      return value;
    default:
      return null;
  }
}

export function parseLinkSharing(value: unknown): LinkSharing | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (record["kind"] === "off") return { kind: "off" };
  if (record["kind"] !== "anyoneSignedIn") return null;
  const role = record["role"];
  return role === "viewer" || role === "commenter" ? { kind: "anyoneSignedIn", role } : null;
}

function parseBinding(value: unknown): AddonBindingRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  const bindingSecretHash = asString(record["bindingSecretHash"]);
  const presentationId = asString(record["presentationId"]);
  return bindingSecretHash === null || presentationId === null ? null : { bindingSecretHash, presentationId };
}

function parseGoogleSlidesLink(value: unknown): GoogleSlidesLink | null {
  const record = asRecord(value);
  if (record === null) return null;
  const presentationId = asString(record["presentationId"]);
  const presentationAddress = asString(record["presentationAddress"]);
  const title = asString(record["title"]);
  const lastImportedAt = nullableNumber(record["lastImportedAt"]);
  const lastExportedAt = nullableNumber(record["lastExportedAt"]);
  const importedRevisionId = record["importedRevisionId"] === null ? null : asString(record["importedRevisionId"]);
  if (presentationId === null || presentationAddress === null || title === null || lastImportedAt === undefined || lastExportedAt === undefined) return null;
  if (record["importedRevisionId"] !== null && importedRevisionId === null) return null;
  return { presentationId, presentationAddress, title, lastImportedAt, lastExportedAt, importedRevisionId };
}

function parseList<TValue>(options: Readonly<{ value: unknown; parse: (value: unknown) => TValue | null }>): readonly TValue[] | null {
  if (!Array.isArray(options.value)) return null;
  const parsed: TValue[] = [];
  for (const item of options.value) {
    const value = options.parse(item);
    if (value === null) return null;
    parsed.push(value);
  }
  return parsed;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `undefined` when malformed, so null stays a legal value. */
function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
