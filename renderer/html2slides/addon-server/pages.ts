// Public pages served by exact path. "/" is the product home page that Google's OAuth consent
// screen links to; the developer UI that used to be "/" lives at "/dev".

export const PAGES: Readonly<Record<string, string>> = {
  "/": "home.html",
  "/dev": "app.html",
  "/dev/": "app.html",
  "/privacy": "privacy.html",
  "/terms": "terms.html",
  // Animated setup walkthroughs (built by mcp/sasha-slides/addon `npm run build:walkthroughs`).
  "/walkthroughs/claude-ai": "walkthroughs/claude-ai.html",
  "/walkthroughs/chatgpt": "walkthroughs/chatgpt.html",
};

/**
 * The deck list of the Sasha editor, linked from the home page as "Your decks". It is NOT one of
 * the website's pages: nginx routes /decks to the connector, which serves the web application
 * (mcp/sasha-slides/engine/src/web/, SPEC.md 21.8) and sends signed-out visitors to sign in.
 */
export const DECK_LIST_ADDRESS = "/decks";

/** The file in public/ that a path is served from, or null when it is not one of the pages. */
export function pageFor(path: string): string | null {
  return Object.hasOwn(PAGES, path) ? PAGES[path] : null;
}
