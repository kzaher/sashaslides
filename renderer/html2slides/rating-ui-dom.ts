/**
 * rating-ui-dom.ts — typed DOM lookups and HTML escaping shared by the rating
 * page's browser modules (rating-ui.ts, rating-ui-reverse.ts).
 */

/** An element constructor from lib.dom (HTMLCanvasElement, HTMLInputElement, …), used to narrow lookups. */
export type ElementType<T extends HTMLElement> = { new (): T; prototype: T };

/** The element with `id` when it exists and is a `type`; null otherwise (read-only pages omit the editing controls). */
export function elementById<T extends HTMLElement>(id: string, type: ElementType<T>): T | null {
  const element = document.getElementById(id);
  return element instanceof type ? element : null;
}

/** The element with `id`, which the page always renders; throws when the page and the client disagree. */
export function requiredElement<T extends HTMLElement>(id: string, type: ElementType<T>): T {
  const element = elementById(id, type);
  if (element === null) throw new Error(`rating page: #${id} is missing or has the wrong element type`);
  return element;
}

/** Escape text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The /img route for an absolute PNG path. */
export function imageUrl(path: string): string {
  return "/img?path=" + encodeURIComponent(path);
}

/** A 2D context; every canvas in this page is 2D and a browser without one cannot run it at all. */
export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("rating page: canvas 2D context unavailable");
  return context;
}

/** Exhaustiveness check for a closed union's switch. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}
