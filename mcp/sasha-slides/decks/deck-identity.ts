/**
 * Who people are on a deck, without revealing who they are anywhere else (SPEC.md 21.3).
 *
 *  - A PERSON ID is `pr_` + the first 32 hexadecimal characters of
 *    SHA-256("sasha-person.v1:" + accountId); the account's agent is `ag_` + the same 32. Stable,
 *    unguessable from outside, and never the account id itself (deck-access.ts).
 *  - A DISPLAY NAME is the profile's name, else the sign-in address before "@", else
 *    "Collaborator"; the agent is always "Claude".
 *  - The PEER COLOUR is the first 8 hexadecimal characters of the person id modulo the theme's
 *    number of peer colours, so everyone sees the same colour for the same person.
 *  - DECK IDS are `dk_` + 22 random base-62 characters; INVITATION EMAILS are indexed by a
 *    labelled SHA-256 of the normalised address, so `index.json` names no address in the clear.
 *  - An AGENT SESSION is `as_` + the first 24 hexadecimal characters of SHA-256(MCP session id).
 */
import { createHash, randomBytes } from "node:crypto";
import { AGENT_DISPLAY_NAME, AGENT_PERSON_ID_PREFIX, PERSON_ID_DIGEST_LENGTH, PERSON_ID_HASH_LABEL, PERSON_ID_PREFIX } from "../engine/src/contracts/deck-access.ts";
import type { Person } from "../engine/src/contracts/discussion.ts";
import { parseDeckId, parsePersonId, type DeckId, type PersonId } from "../engine/src/contracts/ids.ts";
import { TIDEPOOL_TOKENS } from "../engine/src/theme/tidepool-theme.ts";
import type { DeckCaller } from "../deck-contracts/deck-service-contract";
import type { AccountId } from "../http/account-vault";

/** Used when an account has neither a profile name nor a sign-in address. */
export const FALLBACK_DISPLAY_NAME = "Collaborator";

/** The deck caller for an account, given the name its collaborators see. */
export function deckCallerFor(options: Readonly<{ accountId: AccountId; displayName: string }>): DeckCaller {
  return {
    accountId: options.accountId,
    person: personFor(options),
    agent: agentFor({ accountId: options.accountId }),
  };
}

export function personFor(options: Readonly<{ accountId: AccountId; displayName: string }>): Person {
  const id = personIdFor({ accountId: options.accountId });
  return { id, displayName: options.displayName, colourIndex: colourIndexFor(id), kind: "person" };
}

export function agentFor(options: Readonly<{ accountId: AccountId }>): Person {
  const digest = personDigest(options.accountId);
  const id = brandPersonId(`${AGENT_PERSON_ID_PREFIX}${digest}`);
  return { id, displayName: AGENT_DISPLAY_NAME, colourIndex: colourIndexFor(id), kind: "agent" };
}

export function personIdFor(options: Readonly<{ accountId: AccountId }>): PersonId {
  return brandPersonId(`${PERSON_ID_PREFIX}${personDigest(options.accountId)}`);
}

/** `parseInt(first 8 hexadecimal of the digest, 16) % peer colour count` (SPEC.md 21.3). */
export function colourIndexFor(personId: PersonId): number {
  const digest = personId.slice(PERSON_ID_PREFIX.length, PERSON_ID_PREFIX.length + 8);
  return Number.parseInt(digest, 16) % TIDEPOOL_TOKENS.light.peerColours.length;
}

/** The profile name, else the address before "@", else "Collaborator". */
export function displayNameFor(options: Readonly<{ profileName: string | null; email: string | null }>): string {
  if (options.profileName !== null && options.profileName.trim() !== "") return options.profileName.trim();
  const local = options.email === null ? "" : options.email.slice(0, Math.max(0, options.email.indexOf("@")));
  return local.trim() === "" ? FALLBACK_DISPLAY_NAME : local.trim();
}

/** `dk_` + 22 base-62 characters from `randomBytes` (rejection-free: 62 * 4 = 248 < 256, the rest re-drawn). */
export function newDeckId(random: (size: number) => Uint8Array): DeckId {
  let text = "dk_";
  while (text.length < 3 + DECK_ID_RANDOM_CHARACTERS) {
    for (const byte of random(32)) {
      if (byte >= BASE62_ALPHABET.length * 4) continue;
      text += BASE62_ALPHABET[byte % BASE62_ALPHABET.length] ?? "";
      if (text.length === 3 + DECK_ID_RANDOM_CHARACTERS) break;
    }
  }
  const parsed = parseDeckId(text);
  if (parsed === null) throw new Error(`minted an invalid deck id: ${text}`);
  return parsed;
}

/** The production randomness for deck ids and tokens. */
export function cryptoRandom(size: number): Uint8Array {
  return randomBytes(size);
}

/** Addresses compare case-insensitively and without surrounding spaces. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** What `index.json` stores for an invitation: never the address itself (SPEC.md 21.7). */
export function emailHash(email: string): string {
  return createHash("sha256").update(`${EMAIL_HASH_LABEL}${normaliseEmail(email)}`, "utf-8").digest("hex");
}

/** A plausible address: one "@", something on both sides, a dot in the domain, no spaces. */
export function isEmailAddress(candidate: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(candidate.trim()) && candidate.trim().length <= 320;
}

const DECK_ID_RANDOM_CHARACTERS = 22;
const BASE62_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const EMAIL_HASH_LABEL = "sasha-invitation-email.v1:";

function personDigest(accountId: AccountId): string {
  return createHash("sha256").update(`${PERSON_ID_HASH_LABEL}${accountId}`, "utf-8").digest("hex").slice(0, PERSON_ID_DIGEST_LENGTH);
}

function brandPersonId(text: string): PersonId {
  const parsed = parsePersonId(text);
  if (parsed === null) throw new Error(`not a person id: ${text}`);
  return parsed;
}
