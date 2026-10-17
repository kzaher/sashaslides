/**
 * never.ts — the anonymiser's exhaustiveness check. Its own copy rather than the add-on's
 * (protocol.ts): this module is string in, string out, and imports nothing from the surfaces.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled anonymiser case: ${JSON.stringify(value)}`);
}
