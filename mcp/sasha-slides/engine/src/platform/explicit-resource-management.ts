// EXPLICIT RESOURCE MANAGEMENT ON EVERY BROWSER. The engine's long-lived objects (the running
// RxFeedback systems, the document store, subscriptions) implement `Disposable`, so scopes release
// them with `using` (coding skill, "Resource management"). Safari does not define
// `Symbol.dispose` / `Symbol.asyncDispose` yet; without them an object literal's
// `[Symbol.dispose]()` method would be stored under the key "undefined", and `using` would throw.
//
// This module installs both as the registry symbols `Symbol.for("Symbol.dispose")` and
// `Symbol.for("Symbol.asyncDispose")` -- the same fallbacks esbuild's and TypeScript's `using`
// helpers look up -- and does nothing where the browser already has them. It must be the FIRST
// import of every entry point (the demo page, the deck page, the presenter's speaker window), so it
// runs before any module evaluates a `[Symbol.dispose]` key.

installWellKnownSymbol({ name: "dispose", registryKey: "Symbol.dispose" });
installWellKnownSymbol({ name: "asyncDispose", registryKey: "Symbol.asyncDispose" });

function installWellKnownSymbol(options: Readonly<{ name: string; registryKey: string }>): void {
  const existing: unknown = Reflect.get(Symbol, options.name);
  if (typeof existing === "symbol") return;
  Reflect.defineProperty(Symbol, options.name, { value: Symbol.for(options.registryKey), writable: false, enumerable: false, configurable: false });
}
