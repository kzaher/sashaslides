/**
 * The session log's event FILE NAME grammar (PROTOCOL.md): `<epochMillis>-<6 base36>-<kind>.json`.
 * The one parser both writers' readers use, the server (session-log.ts) and the add-on
 * (addon/src/session-log.ts), so a file one side lists is never one the other drops.
 *
 * DEPENDENCY-FREE on purpose: the add-on bundles it into its pages, so it imports nothing.
 *
 * The name is the ORDER, so it is parsed separately from the body and wins over it: a writer whose
 * clock disagrees with its own file name cannot reshuffle the log for everyone else. `kind` may
 * contain `-` (every kind does), so the split is anchored rather than a three-way split. The suffix
 * is exactly six lower-case base36 characters and the kind is lower-case, as both writers mint them.
 */
export type SessionEventFileName = Readonly<{ atMillis: number; suffix: string; kind: string }>;

/** The name's three parts, or null when it is not an event file (a stray file in the folder). */
export function parseSessionEventFileName(name: string): SessionEventFileName | null {
  const matched = /^(\d{1,15})-([0-9a-z]{6})-([a-z][a-z0-9-]*)\.json$/.exec(name);
  if (matched === null) return null;
  const [, millis, suffix, kind] = matched;
  if (millis === undefined || suffix === undefined || kind === undefined) return null;
  // Fifteen digits at most, so always a safe integer.
  return { atMillis: Number.parseInt(millis, 10), suffix, kind };
}
