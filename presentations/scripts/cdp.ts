/**
 * cdp.ts — the typed `chrome-remote-interface` handle the presentation scripts share.
 *
 * `chrome-remote-interface` ships no `.d.ts`, so `types/ambient.d.ts` declares its default export
 * as `unknown`. The precise boundary types live once, in `types/cdp-types.ts`; this module only
 * applies them to the runtime module, so scripts import `cdp` from here instead of the raw module
 * and every call site is fully typed.
 *
 * See https://github.com/cyrus-and/chrome-remote-interface for the runtime API.
 */

import CDPDefault from "chrome-remote-interface";
import type { CdpModule } from "../../types/cdp-types.ts";

// SAFETY: the ambient declaration types the default export as `unknown` (untyped JS module). This
// is the single boundary assertion that maps it onto the documented runtime contract in
// types/cdp-types.ts; every script consumes the typed form.
export const cdp: CdpModule = CDPDefault as CdpModule;
