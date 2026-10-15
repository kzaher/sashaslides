// THE EXHAUSTIVENESS GATE, defined once for the whole engine. Every branch over a closed union in
// the engine is a `switch` whose `default` calls this, so adding a variant to any contract union is
// a compile error at every decision site that has to handle it -- which is the point of putting the
// unions in contracts/ at all: four builders code against them in parallel, and the compiler is
// what tells each of them when the architect changed one.

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(value)}`);
}
