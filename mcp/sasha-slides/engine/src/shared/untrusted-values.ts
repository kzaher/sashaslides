// READING VALUES THAT CROSSED A TRUST BOUNDARY: a server frame, an HTTP answer, an awareness state
// a peer wrote, a `postMessage` from another origin, a value from local storage, a client's
// discussion request at the deck server. DOM-free and Node-free, so the web module, the server and
// the connector's `decks/` build their boundary parsers from the same readers; each parser returns
// a typed value or null, and nothing past the boundary re-checks a shape.
//
// Key decisions:
//
//  * A READER THROWS `MalformedValue`, AND ONLY `parseOrNull` CATCHES IT. A parser then reads like
//    the type it builds (`{ title: stringAt(record, "title"), ... }`) instead of a ladder of
//    `if (x === null) return null`, and the exception never escapes the boundary function: any
//    other error is a bug and is rethrown.
//  * CLOSED SETS ARE CHECKED AGAINST A TOTAL TABLE (`memberOf` with `keysOf` of a
//    `Record<Union, true>`), so a new variant of a contract union is a compile error here until the
//    parser accepts it, instead of a value the parser silently refuses.
//  * NO TYPIA: the engine's dependency list is fixed by the architect (SPEC.md section 16), so the
//    readers are hand-written, small, and tested through the parsers that use them.

/** Thrown by a reader when a value does not have the expected shape; caught by `parseOrNull`. */
export class MalformedValue extends Error {}

export type UntrustedRecord = Readonly<Record<string, unknown>>;

/** Runs a parser built from the readers below; null when any of them refused the value. */
export function parseOrNull<TValue>(parse: () => TValue): TValue | null {
  try {
    return parse();
  } catch (error) {
    if (error instanceof MalformedValue) return null;
    throw error;
  }
}

/** `JSON.parse` that never throws: undefined (which no JSON text produces) for text that is not JSON. */
export function parseStructuredText(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return undefined;
  }
}

export function recordOf(value: unknown, what: string): UntrustedRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new MalformedValue(`${what} is not an object`);
  // A non-null, non-array object: its own enumerable properties are what `Reflect.get` reads.
  return value as UntrustedRecord;
}

export function stringOf(value: unknown, what: string): string {
  if (typeof value !== "string") throw new MalformedValue(`${what} is not text`);
  return value;
}

export function stringAt(record: UntrustedRecord, key: string): string {
  return stringOf(record[key], key);
}

export function stringOrNullAt(record: UntrustedRecord, key: string): string | null {
  const value = record[key];
  return value === null ? null : stringOf(value, key);
}

export function numberOf(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new MalformedValue(`${what} is not a finite number`);
  return value;
}

export function numberAt(record: UntrustedRecord, key: string): number {
  return numberOf(record[key], key);
}

export function numberOrNullAt(record: UntrustedRecord, key: string): number | null {
  const value = record[key];
  return value === null ? null : numberOf(value, key);
}

export function nonNegativeIntegerAt(record: UntrustedRecord, key: string): number {
  const value = numberAt(record, key);
  if (!Number.isSafeInteger(value) || value < 0) throw new MalformedValue(`${key} is not a whole number`);
  return value;
}

export function arrayOf(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new MalformedValue(`${what} is not a list`);
  // Array.isArray narrowed to any[]; reading it as unknown[] keeps every element unchecked.
  const elements: readonly unknown[] = value;
  return elements;
}

export function arrayAt(record: UntrustedRecord, key: string): readonly unknown[] {
  return arrayOf(record[key], key);
}

/** Each element through `parseElement`; any refusal refuses the whole list. */
export function listAt<TElement>(record: UntrustedRecord, key: string, parseElement: (value: unknown) => TElement): readonly TElement[] {
  return arrayAt(record, key).map(parseElement);
}

/** The keys of a total `Record<Union, true>` table: the union's members, checked by the compiler. */
export function keysOf<TKey extends string>(table: Readonly<Record<TKey, true>>): readonly TKey[] {
  // Object.keys of a Record<TKey, true> literal returns exactly TKey's members (the table is total).
  return Object.keys(table) as TKey[];
}

export function memberOf<TMember extends string>(value: unknown, members: readonly TMember[], what: string): TMember {
  const text = stringOf(value, what);
  const member = members.find((candidate) => candidate === text);
  if (member === undefined) throw new MalformedValue(`${what} "${text}" is not one of ${members.join(", ")}`);
  return member;
}

export function memberAt<TMember extends string>(record: UntrustedRecord, key: string, members: readonly TMember[]): TMember {
  return memberOf(record[key], members, key);
}

/** A branded id through its contract parser (ids.ts), refusing what the parser refuses. */
export function identifierAt<TIdentifier>(record: UntrustedRecord, key: string, parse: (candidate: string) => TIdentifier | null): TIdentifier {
  const parsed = parse(stringAt(record, key));
  if (parsed === null) throw new MalformedValue(`${key} is not a valid identifier`);
  return parsed;
}
