/**
 * THE SCRIPT LIMITS `deck_write_transition` ENFORCES: exactly the engine's `TRANSITION_LIMITS`
 * (contracts/transition-limits.ts, DOM-free so the connector can import it), narrowed to the four a
 * stored script must meet. A script the presenter would refuse to load is not worth storing.
 */
import { TRANSITION_LIMITS } from "../engine/src/contracts/transition-limits.ts";

export const SCRIPT_LIMITS = {
  maximumScriptBytes: TRANSITION_LIMITS.maximumScriptBytes,
  maximumStylesheetBytes: TRANSITION_LIMITS.maximumStylesheetBytes,
  maximumOverlayMarkupBytes: TRANSITION_LIMITS.maximumOverlayMarkupBytes,
  maximumDurationMilliseconds: TRANSITION_LIMITS.maximumDurationMilliseconds,
} as const;
