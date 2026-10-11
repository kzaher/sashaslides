/**
 * The three Chrome DevTools Protocol helpers every live test here needs, written ONCE against
 * the repo's real boundary types in `types/cdp-types.ts`.
 *
 * They exist because each was independently got wrong in three separate scripts, and `tsx`
 * strips types without checking them, so the scripts ran perfectly while `tsc` was red:
 *
 *  - `exceptionDetails` is optional AND typed `unknown`, so `.text` cannot be read off it.
 *  - `CdpPage` has no `bringToFront`; bringing a tab forward is `Target.activateTarget`.
 *  - Google's own widgets ignore synthetic clicks, so a press must be real input events.
 */
import type { CdpClient } from "../../../types/cdp-types.ts";

export type Point = Readonly<{ x: number; y: number; label?: string }>;

/** `exceptionDetails` is `unknown` on the boundary type; narrow it instead of casting. */
function describeException(details: unknown): string {
  if (typeof details === "object" && details !== null && "text" in details) {
    const text = (details as Readonly<{ text?: unknown }>).text;
    if (typeof text === "string") return text;
  }
  return "the page threw";
}

/**
 * Evaluate an expression and return its value as a string.
 *
 * A disconnected target is reported as "CLOSED" rather than thrown: a consent popup closing
 * itself is the SUCCESS path of an OAuth grant, and callers need to tell that apart from a
 * genuine failure.
 */
export async function evaluateText(client: CdpClient, expression: string): Promise<string> {
  try {
    const { result, exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true });
    if (exceptionDetails !== undefined && exceptionDetails !== null) return `THREW ${describeException(exceptionDetails)}`;
    return typeof result.value === "string" ? result.value : String(result.value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return /WebSocket is not open|Target closed|disconnected/i.test(message) ? "CLOSED" : `THREW ${message}`;
  }
}

/** Google Docs and Slides ignore input entirely when `document.hasFocus()` is false. */
export async function bringToFront(client: CdpClient, targetId: string): Promise<void> {
  await client.Target.activateTarget({ targetId });
}

/** A real browser-level press. Needed for Google's widgets, and for anything opening a popup. */
export async function realClick(client: CdpClient, at: Readonly<{ x: number; y: number }>): Promise<void> {
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: at.x, y: at.y });
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1 });
}

/**
 * Evaluate an expression that resolves to a Promise, and return the resolved value.
 *
 * Needed for any gesture a React surface has to re-render between: dispatching
 * pointerdown/move/up in one synchronous task means React has not applied the state from the
 * first event when the second arrives, so the drag is silently dropped. The expression has to
 * be able to await a frame, which means it has to be a promise, which means `awaitPromise`.
 */
export async function evaluateAsyncText(client: CdpClient, expression: string): Promise<string> {
  try {
    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails !== undefined && exceptionDetails !== null) return `THREW ${describeException(exceptionDetails)}`;
    return typeof result.value === "string" ? result.value : String(result.value);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return /WebSocket is not open|Target closed|disconnected/i.test(message) ? "CLOSED" : `THREW ${message}`;
  }
}
