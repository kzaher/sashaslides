// JSON NARROWING at the add-on's parse boundaries: a Code.gs reply, a Drive file, a seed appended
// to the page. Every parser in this package reads untrusted values through these, so there is one
// copy of each rule -- ten private copies of `asRecord` is the thing that drifts. `asRecord` is the
// connector's own (http/json-values.ts, dependency-free and so browser-safe); the field readers keep
// the add-on's `{ record, key }` shape.

export { asRecord } from "../../http/json-values.ts";

type JsonRecord = Readonly<Record<string, unknown>>;

/** The string at `key`, or null. An empty string is a string. */
export function stringAt({ record, key }: { record: JsonRecord; key: string }): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** The string at `key`, or null when it is missing or empty. */
export function nonEmptyStringAt({ record, key }: { record: JsonRecord; key: string }): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The integer at `key`, or null. A fraction is not an integer. */
export function integerAt({ record, key }: { record: JsonRecord; key: string }): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
