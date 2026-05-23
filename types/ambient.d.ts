// Boundary-only ambient declarations for third-party modules that ship no .d.ts.
// Per the TypeScript style guide, these are the only acceptable `any`s — and
// they MUST be narrowed at the earliest layer (see CDPStatic in convert-pptx-io.ts
// for the modern pattern). Legacy presentations/scripts/ uses them untyped.

declare module "chrome-remote-interface" {
  // Default export is callable to open a connection; .New / .Close / .Version
  // are runtime-attached static methods. Modern code narrows via
  // `as unknown as CDPStatic` shim — see convert-pptx-io.ts.
  const CDP: unknown;
  export default CDP;
}

declare module "ws" {
  const WS: unknown;
  export default WS;
  export const WebSocket: unknown;
}
