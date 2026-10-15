/**
 * Parsers for values the deck server reads back from disk or from a request body, beyond what the
 * engine's room parses itself. A stored discussion entry is parsed like a client's request (the
 * same command parser, engine/src/server/client-messages.ts) plus the authority's stamps, so a
 * tampered `discussion.log` line is skipped rather than trusted.
 */
import type { DiscussionLogEntry, Person } from "../engine/src/contracts/discussion.ts";
import { parsePersonId } from "../engine/src/contracts/ids.ts";
import { parseDiscussionRequest } from "../engine/src/server/client-messages.ts";

export function parseDiscussionLogEntry(value: unknown): DiscussionLogEntry | null {
  const record = asRecord(value);
  if (record === null) return null;
  const request = parseDiscussionRequest({ requestId: record["requestId"], command: record["command"] });
  const sequence = record["sequence"];
  const at = record["at"];
  const actor = parsePerson(record["actor"]);
  if (request === null || actor === null || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || typeof at !== "number" || !Number.isFinite(at)) return null;
  return { sequence, requestId: request.requestId, actor, at, command: request.command };
}

export function parsePerson(value: unknown): Person | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = typeof record["id"] === "string" ? parsePersonId(record["id"]) : null;
  const displayName = record["displayName"];
  const colourIndex = record["colourIndex"];
  const kind = record["kind"];
  if (id === null || typeof displayName !== "string" || typeof colourIndex !== "number" || (kind !== "person" && kind !== "agent")) return null;
  return { id, displayName, colourIndex, kind };
}

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}
