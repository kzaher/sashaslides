/**
 * Cross-cutting types used by multiple server modules. The actual type
 * definitions live in `src/api/wire.ts` (so they're shared with the
 * browser client); this file re-exports them so existing server-side
 * imports of `./types.js` keep working without touching every call site.
 *
 * Per-API option shapes live next to their implementations:
 *   - CommonSendArguments, SendOptions, SendFormattedOptions → session.ts
 *   - InterruptException, StructuredError, FatalShellError    → errors.ts
 */

export type { Result, ClaudeModel } from "../api/wire.js";
export { Claude } from "../api/wire.js";
