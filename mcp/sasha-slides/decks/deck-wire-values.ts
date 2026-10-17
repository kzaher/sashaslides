/**
 * Parsers for values the deck server reads back from disk or from a request body, beyond what the
 * engine's room parses itself. A stored discussion entry is read by the engine's discussion-log
 * reader (engine/src/shared/discussion-wire-values.ts) -- the same one the room uses for a client's
 * request and the web client uses for the entries the server sends -- so a tampered
 * `discussion.log` line is skipped rather than trusted, and nothing is served that a client would
 * refuse.
 */
import type { DiscussionLogEntry, Person } from "../engine/src/contracts/discussion.ts";
import { readDiscussionLogEntry, readPerson } from "../engine/src/shared/discussion-wire-values.ts";
import { parseOrNull } from "../engine/src/shared/untrusted-values.ts";

export function parseDiscussionLogEntry(value: unknown): DiscussionLogEntry | null {
  return parseOrNull(() => readDiscussionLogEntry(value));
}

export function parsePerson(value: unknown): Person | null {
  return parseOrNull(() => readPerson(value));
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}
