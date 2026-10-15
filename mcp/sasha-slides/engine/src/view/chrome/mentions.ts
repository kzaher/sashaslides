// MENTIONS IN COMMENTS (SPEC.md 21.9): typing "@" opens the deck's members, filtered as one types;
// choosing one writes "@Display Name " into the text and records the person's id. A message stores
// plain text plus the ids (discussion.ts `CommentMessage.mentions`), because two members may share
// a display name; the view highlights "@Display Name" for each recorded id.
//
// Pure functions over the text and the caret, so the composer, the reply box and the message
// renderer agree, and a test can type "@gr" without a browser.

import type { Person } from "../../contracts/discussion.ts";
import type { PersonId } from "../../contracts/ids.ts";

/** Longest run after "@" still treated as a query: past it, an "@" is just text. */
const MAXIMUM_QUERY_LENGTH = 40;

/** The "@..." being typed at the caret: where the "@" is and what follows it; null when none. */
export type MentionQuery = Readonly<{ start: number; query: string }>;

export function mentionQueryAt(options: Readonly<{ text: string; caret: number }>): MentionQuery | null {
  const before = options.text.slice(0, options.caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const preceding = at === 0 ? "" : before.charAt(at - 1);
  if (preceding !== "" && !/\s/.test(preceding)) return null;
  const query = before.slice(at + 1);
  if (query.length > MAXIMUM_QUERY_LENGTH || /[\n@]/.test(query)) return null;
  return { start: at, query };
}

/**
 * Members a query matches, in the members' order: the display name, or any word of it, starts with
 * the query (ignoring case). The person writing is left out; an empty query lists everyone else.
 */
export function matchingMembers(options: Readonly<{ members: readonly Person[]; query: string; me: PersonId }>): readonly Person[] {
  const query = options.query.trim().toLowerCase();
  return options.members.filter((person) => {
    if (person.id === options.me) return false;
    if (query.length === 0) return true;
    const name = person.displayName.toLowerCase();
    return name.startsWith(query) || name.split(/\s+/).some((word) => word.startsWith(query));
  });
}

/** The text with the query replaced by "@Display Name ", and the caret after it. */
export function insertMention(options: Readonly<{ text: string; caret: number; query: MentionQuery; person: Person }>): Readonly<{ text: string; caret: number }> {
  const inserted = `@${options.person.displayName} `;
  const text = options.text.slice(0, options.query.start) + inserted + options.text.slice(options.caret);
  return { text, caret: options.query.start + inserted.length };
}

/** The recorded mentions whose "@Display Name" is still in the text (an edit can delete one). */
export function mentionsStillIn(options: Readonly<{ text: string; mentions: readonly PersonId[]; people: readonly Person[] }>): readonly PersonId[] {
  return options.mentions.filter((personId, index) => {
    if (options.mentions.indexOf(personId) !== index) return false;
    const person = options.people.find((candidate) => candidate.id === personId);
    return person !== undefined && options.text.includes(`@${person.displayName}`);
  });
}

export type MessageSegment = Readonly<{ kind: "text"; text: string }> | Readonly<{ kind: "mention"; text: string; person: Person }>;

/** A message body cut into text and highlighted mentions of the recorded people. */
export function messageSegments(options: Readonly<{ body: string; mentions: readonly PersonId[]; people: readonly Person[] }>): readonly MessageSegment[] {
  const mentioned = options.mentions.flatMap((personId) => options.people.filter((person) => person.id === personId));
  if (mentioned.length === 0) return [{ kind: "text", text: options.body }];
  // Longest names first, so "@Grace Hopper" wins over a member called "Grace".
  const byLength = [...mentioned].sort((first, second) => second.displayName.length - first.displayName.length);
  const segments: MessageSegment[] = [];
  let rest = options.body;
  while (rest.length > 0) {
    const next = byLength
      .map((person) => ({ person, index: rest.indexOf(`@${person.displayName}`) }))
      .filter((candidate) => candidate.index >= 0)
      .sort((first, second) => first.index - second.index)[0];
    if (next === undefined) {
      segments.push({ kind: "text", text: rest });
      break;
    }
    if (next.index > 0) segments.push({ kind: "text", text: rest.slice(0, next.index) });
    const text = `@${next.person.displayName}`;
    segments.push({ kind: "mention", text, person: next.person });
    rest = rest.slice(next.index + text.length);
  }
  return segments;
}
