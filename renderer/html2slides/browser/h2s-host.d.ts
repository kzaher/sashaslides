/**
 * h2s-host.d.ts — the shape of the `window.h2s` host object that the developer
 * page injects. insert-feature.ts registers an `insert(position)` handler via
 * `window.h2s.register(...)`.
 *
 * Declared once here (ambient, program-wide) so no bundle can drift into a
 * conflicting `interface Window` augmentation.
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
