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

/** The file in public/ that a path is served from, or null when it is not one of the pages. */
export function pageFor(path: string): string | null {
  return Object.hasOwn(PAGES, path) ? PAGES[path] : null;
}
