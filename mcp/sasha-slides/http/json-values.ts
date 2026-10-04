/**
 * Narrowing helpers for JSON that crossed a trust boundary — a DCR body, a token request,
 * the dev store file on disk.
 *
 * The repo has no typia/ts-patch setup (see `google-auth.ts`'s header), so the parse
 * boundaries in `oauth-store.ts` and `authorization-server.ts` are hand written. They are
 * collected here rather than copied into each file, because three private copies of
 * `asString` is the thing that drifts.
 */

export function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const strings: string[] = [];
  for (const entry of value) {
    const text = asString(entry);
    if (text === null) return null;
    strings.push(text);
  }
  return strings;
}

export type ParsedJson =
  | Readonly<{ kind: "ok"; value: unknown }>
  | Readonly<{ kind: "error"; reason: string }>;

export function parseJson(text: string): ParsedJson {
  try {
    return { kind: "ok", value: JSON.parse(text) as unknown };
  } catch (cause) {
    return { kind: "error", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
