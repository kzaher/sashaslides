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
import type { CdpModule, CdpRuntime } from "../../types/cdp-types.ts";

// SAFETY: the ambient declaration types the default export as `unknown` (untyped JS module). This
// is the single boundary assertion that maps it onto the documented runtime contract in
// types/cdp-types.ts; every script consumes the typed form.
export const cdp: CdpModule = CDPDefault as CdpModule;

/**
 * Clicks the first visible `button` / `[role="button"]` whose trimmed text is exactly `text` by
 * dispatching the full pointer + mouse event sequence from page JavaScript. Google Slides' React
 * widgets (e.g. the Import dialog's "Select all slides" / "Import slides") ignore
 * `Input.dispatchMouseEvent`, but answer this. `minY` skips matches whose top edge is at or above
 * that y (to pick a dialog's footer button over a same-named menu item). Resolves to whether a
 * button was clicked.
 */
export async function jsClick(
  runtime: CdpRuntime,
  target: Readonly<{ text: string; minY?: number }>,
): Promise<boolean> {
  const visible = target.minY === undefined ? "r.width > 0" : `r.y > ${target.minY} && r.width > 0`;
  const evaluation = await runtime.evaluate({
    expression: `(() => {
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        if (b.textContent?.trim() === ${JSON.stringify(target.text)}) {
          const r = b.getBoundingClientRect();
          if (${visible}) {
            const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, pointerType: 'mouse', button: 0, pointerId: 1 };
            b.dispatchEvent(new PointerEvent('pointerdown', opts));
            b.dispatchEvent(new MouseEvent('mousedown', opts));
            b.dispatchEvent(new PointerEvent('pointerup', opts));
            b.dispatchEvent(new MouseEvent('mouseup', opts));
            b.dispatchEvent(new MouseEvent('click', opts));
            b.click();
            return true;
          }
        }
      }
      return false;
    })()`,
    returnByValue: true,
  });
  return evaluation.result.value === true;
}
