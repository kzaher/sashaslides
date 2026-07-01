/**
 * h2s-host.d.ts — the single, shared shape of the `window.h2s` host bridge that
 * the server-hosted UI shell (app.html / shell.html) injects. Both browser
 * bundles consume it: addon-main.ts reads `window.h2s.bridge.oversampling`, and
 * insert-feature.ts registers an `insert(position)` handler via
 * `window.h2s.register(...)`.
 *
 * Declared once here (ambient, program-wide) so the two bundles can't drift into
 * conflicting `interface Window` augmentations.
 */
import type { LogFn } from "./convert-core";

declare global {
  /** The live conversion bridge the shell hands to `register` callbacks. */
  interface H2sBridge {
    queue: { name: string; html: string }[];
    log: LogFn;
    oversampling?: () => number;
    inAddon?: boolean;
    insert?: (
      position: "before" | "after" | "download",
    ) => Promise<{ inserted?: number; at?: number } | undefined>;
  }

  interface Window {
    h2s?: {
      register: (f: (b: H2sBridge) => void) => void;
      bridge: H2sBridge;
    };
  }
}

export {};
