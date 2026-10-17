// THE GUARD'S DECISION: given the protected fields before and after one editor's update, and who
// sent it, which fields must be written back and what to tell the sender. Pure, so the whole rule
// table is tested without a socket (collaboration.ts header "corrects rather than rejects",
// SPEC.md 21.5 and 21.6).
//
// The rules, per transition script the update touched:
//
//  * AUTHORSHIP. A script whose text changed, or a new script, records its SENDER as the author; an
//    author changed without the text is put back as it was. Nobody signs a script as Claude or as a
//    colleague (`scriptAuthorRestored`).
//  * APPROVAL. A script may hold `approved` after the update only when the update did not change its
//    approval or text, or when the sender is a PERSON whose role may approve, `approvedBy` names that
//    person, and `fingerprint` is the script's fingerprint after the update. Anything else becomes
//    `unapproved` (`approvalRevoked`, with the first failing reason in the order notPermitted,
//    approvedByAnotherPerson, fingerprintMismatch). A changed text under an old approval is caught
//    by the same check: its fingerprint no longer matches.
//  * META. `deckId`, `schemaVersion` and `createdAt` are put back to what they were (`metaRestored`).
//
// Untouched scripts are never judged: an approval granted long ago by someone else stays valid
// whoever sends the next unrelated update.

import { assertNever } from "../contracts/assert-never.ts";
import type { ApprovalRevocationReason, ProtectedFieldCorrection } from "../contracts/collaboration.ts";
import { roleAllows, type DeckRole } from "../contracts/deck-access.ts";
import type { Person } from "../contracts/discussion.ts";
import type { TransitionApproval, TransitionAuthor } from "../contracts/document.ts";
import { PROTECTED_META_KEYS, type ProtectedFields, type ProtectedFieldWrite, type ProtectedScriptFields } from "../model/protected-fields.ts";
import { parseValue, TRANSITION_APPROVAL } from "../model/stored-values.ts";

/** Who sent the update, as the room's connection knows them (never what the update claims). */
export type GuardSender = Readonly<{ person: Person; role: DeckRole }>;

export type GuardDecision = Readonly<{
  /** What the room writes back, in one REPAIR_ORIGIN transaction. Empty when the update was fine. */
  writes: readonly ProtectedFieldWrite[];
  /** What the sender is told, one `correction` message each. */
  corrections: readonly ProtectedFieldCorrection[];
}>;

export function correctionsFor(options: Readonly<{ before: ProtectedFields; after: ProtectedFields; sender: GuardSender }>): GuardDecision {
  const { before, after, sender } = options;
  const writes: ProtectedFieldWrite[] = [];
  const corrections: ProtectedFieldCorrection[] = [];
  for (const [scriptId, current] of after.scripts) {
    const previous = before.scripts.get(scriptId) ?? null;
    const author = authorCorrection({ previous, current, sender });
    if (author !== null) {
      writes.push({ kind: "scriptAuthor", scriptId, author: author.value });
      corrections.push({ kind: "scriptAuthorRestored", scriptId });
    }
    const revocation = approvalRevocation({ previous, current, sender });
    if (revocation !== null) {
      writes.push({ kind: "scriptApproval", scriptId, approval: UNAPPROVED });
      corrections.push({ kind: "approvalRevoked", scriptId, reason: revocation });
    }
  }
  for (const key of PROTECTED_META_KEYS) {
    if (sameValue(before.meta[key], after.meta[key])) continue;
    writes.push({ kind: "meta", key, value: before.meta[key] });
    corrections.push({ kind: "metaRestored", key });
  }
  return { writes, corrections };
}

const UNAPPROVED: TransitionApproval = { kind: "unapproved" };

type AuthorCorrection = Readonly<{ value: unknown }>;

/** The author to write back, or null when the stored one is right (see the header). */
function authorCorrection(
  options: Readonly<{ previous: ProtectedScriptFields | null; current: ProtectedScriptFields; sender: GuardSender }>,
): AuthorCorrection | null {
  const { previous, current, sender } = options;
  const textChanged = previous === null || previous.fingerprint !== current.fingerprint;
  if (textChanged) {
    const expected = authorOf(sender.person);
    return sameValue(current.author, expected) ? null : { value: expected };
  }
  // Text unchanged: the author may not change either.
  return sameValue(previous.author, current.author) ? null : { value: previous.author };
}

/** Why the stored approval must be revoked, or null when it may stand. */
function approvalRevocation(
  options: Readonly<{ previous: ProtectedScriptFields | null; current: ProtectedScriptFields; sender: GuardSender }>,
): ApprovalRevocationReason | null {
  const { previous, current, sender } = options;
  const untouched = previous !== null && previous.fingerprint === current.fingerprint && sameValue(previous.approval, current.approval);
  if (untouched) return null;
  const approval = parseApproval(current.approval);
  switch (approval.kind) {
    case "unapproved":
      return null;
    case "malformed":
      return "notPermitted";
    case "approved":
      if (sender.person.kind !== "person" || !roleAllows({ role: sender.role, permission: "approveTransitionScript" })) return "notPermitted";
      if (approval.approvedBy !== sender.person.id) return "approvedByAnotherPerson";
      if (approval.fingerprint !== current.fingerprint) return "fingerprintMismatch";
      return null;
    default:
      return assertNever(approval);
  }
}

type ParsedApproval =
  | TransitionApproval
  /** Anything a forged client could store that is neither: treated as an approval nobody may grant. */
  | Readonly<{ kind: "malformed" }>;

/** The stored approval through the model's own check (stored-values.ts); an absent one is unapproved. */
function parseApproval(stored: unknown): ParsedApproval {
  if (stored === undefined) return UNAPPROVED;
  const parsed = parseValue({ candidate: stored, kind: TRANSITION_APPROVAL });
  switch (parsed.kind) {
    case "valid":
      return parsed.value;
    case "unsupported":
    case "wrongType":
    case "missing":
      return { kind: "malformed" };
    default:
      return assertNever(parsed);
  }
}

function authorOf(person: Person): TransitionAuthor {
  switch (person.kind) {
    case "person":
      return { kind: "person", personId: person.id };
    case "agent":
      // An agent never sends document updates over a socket (its edits run on the server's
      // replica); should one ever, it signs as itself without a session, which no history owns.
      return { kind: "agent", name: person.displayName, agentSessionId: "" };
    default:
      return assertNever(person.kind);
  }
}

/** Structural equality of stored values (JSON with sorted keys; Yjs values are JSON). */
function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}
