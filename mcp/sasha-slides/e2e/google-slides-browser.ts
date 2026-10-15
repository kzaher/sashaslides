/**
 * The Chrome DevTools Protocol tab the live Google Slides scripts drive (Chrome on 127.0.0.1:9223).
 *
 * One tab per script, opened blank and navigated with the load event subscribed FIRST (CLAUDE.md:
 * `loadEventFired` after `DevTools.New({url})` never resolves, and `DevTools.New` truncates an address at its
 * first `&`), and closed on every exit through `await using`. Polls observable state with short
 * budgets instead of sleeping.
 */
import CDPraw from "chrome-remote-interface";
import { writeFileSync } from "node:fs";
import type { CdpClient, CdpModule } from "../../../types/cdp-types.ts";
import { evaluateText, realClick } from "./cdp-page.ts";

// chrome-remote-interface ships no .d.ts and types/ambient.d.ts declares its default export
// `unknown`; CdpModule is the repo's shared boundary type for its callable export and statics.
const DevTools = CDPraw as CdpModule;

export const DEVTOOLS_PORT = 9223;

export type BrowserTab = AsyncDisposable &
  Readonly<{
    client: CdpClient;
    targetId: string;
    evaluate(expression: string): Promise<string>;
    /** Polls `expression` (which must yield "true") every 150 ms until the budget; never a blind sleep. */
    until(options: Readonly<{ expression: string; budgetMilliseconds: number }>): Promise<boolean>;
    screenshot(path: string): Promise<void>;
    click(at: Readonly<{ x: number; y: number }>): Promise<void>;
  }>;

export async function openTab(options: Readonly<{ address: string; loadBudgetMilliseconds: number }>): Promise<BrowserTab> {
  const target = await DevTools.New({ port: DEVTOOLS_PORT });
  const client = await DevTools({ port: DEVTOOLS_PORT, target });
  await client.Page.enable();
  await client.Target.activateTarget({ targetId: target.id });
  const loaded = client.Page.loadEventFired();
  await client.Page.navigate({ url: options.address });
  await Promise.race([loaded, new Promise((resolve) => setTimeout(resolve, options.loadBudgetMilliseconds))]);
  const evaluate = (expression: string): Promise<string> => evaluateText(client, expression);
  return {
    client,
    targetId: target.id,
    evaluate,
    until: async ({ expression, budgetMilliseconds }) => {
      const deadline = Date.now() + budgetMilliseconds;
      while (Date.now() < deadline) {
        if ((await evaluate(expression)) === "true") return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return false;
    },
    screenshot: async (path) => {
      const shot = await client.Page.captureScreenshot({ format: "png" });
      writeFileSync(path, Buffer.from(shot.data, "base64"));
    },
    click: (at) => realClick(client, at),
    [Symbol.asyncDispose]: async () => {
      await client.close().catch(() => undefined);
      await DevTools.Close({ port: DEVTOOLS_PORT, id: target.id }).catch(() => undefined);
    },
  };
}

/**
 * A press on a Google editor widget through the JavaScript pointer sequence: Slides' Closure
 * menubar ignores `Input.dispatchMouseEvent` (CLAUDE.md), so the menus are driven this way.
 * `finder` is an expression yielding the element or null.
 */
export function pointerPressExpression(finder: string): string {
  return `(() => { const element = ${finder}; if (!element) return "missing";
    const box = element.getBoundingClientRect();
    const options = { bubbles: true, cancelable: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, pointerType: "mouse", button: 0, pointerId: 1 };
    element.dispatchEvent(new PointerEvent("pointerdown", options)); element.dispatchEvent(new MouseEvent("mousedown", options));
    element.dispatchEvent(new PointerEvent("pointerup", options)); element.dispatchEvent(new MouseEvent("mouseup", options));
    element.dispatchEvent(new MouseEvent("click", options)); return "pressed"; })()`;
}
