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

/** Lenient: anything that is not an array reads as empty. */
export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
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

/** One field's parse: its value, or a message naming what is wrong (never the value itself). */
export type FieldParse<TValue> = Readonly<{ kind: "ok"; value: TValue }> | Readonly<{ kind: "error"; message: string }>;

/** The `code` of a thrown Node system error (ENOENT, EACCES...), never its message. */
export function nodeErrorCode(cause: unknown): string {
  const code = cause instanceof Error && "code" in cause ? cause.code : undefined;
  return typeof code === "string" ? code : "unreadable";
}

/** A Google error code (`invalid_grant`, `PERMISSION_DENIED`) fit for a log line, or a placeholder. */
export function googleErrorCode(value: unknown): string {
  const code = asString(value);
  return code !== null && /^[A-Za-z_]{1,64}$/.test(code) ? code : "(no error code)";
}

/** A string field of a parsed JSON object, or null. */
export function stringFieldOf(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || !(key in value)) return null;
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof field === "string" ? field : null;
}

/** A field of a parsed JSON object as `unknown`, or undefined. */
export function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || !(key in value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
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
