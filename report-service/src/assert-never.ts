/**
 * The `default` arm of every exhaustive `switch` in this service.
 *
 * Its argument position is `never`, so adding a variant to any union below turns every
 * decision site that forgot it into a compile error rather than a silent fall-through.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
