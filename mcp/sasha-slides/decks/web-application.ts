/**
 * Serves the built web application (SPEC.md 21.2, 21.8): the list page at `/decks`, the editor
 * shell at `/deck/<id>`, the content-hashed assets under `/deck-app/`, and the scripted-transition
 * runner under `/deck-app/runner/`, exactly as `engine/dist/web/manifest.json` (`WebBuildManifest`)
 * names them -- the server never guesses a file name or a policy.
 *
 * Key decisions:
 *
 *  - NOT BUILT IS A 503, NOT A CRASH. Without a manifest every page answers 503 "the web
 *    application is not built"; the manifest is looked for again on the next request, so a build
 *    finished after startup is served without a restart.
 *  - ONLY NAMED FILES ARE SERVED. An asset must be listed in the manifest; a runner file must be a
 *    plain file name inside `runner/`. No path from the request ever reaches the file system.
 *  - Pages are `no-cache` with the manifest's policy (the embedded policy for `?embed=addon`);
 *    assets are immutable for a year.
 */
import { existsSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { DECK_APPLICATION_ASSETS_PREFIX, DECK_LIST_PAGE_PATH, DECK_PAGE_PATH_PREFIX, type WebBuildManifest } from "../engine/src/contracts/deck-api.ts";
import { parseDeckId } from "../engine/src/contracts/ids.ts";

export type WebApplication = Readonly<{
  /** Answers `/decks`, `/deck/<id>` and `/deck-app/...`; false for any other path. */
  handleRequest(options: Readonly<{ request: IncomingMessage; response: ServerResponse; url: URL }>): boolean;
}>;

export function createWebApplication(options: Readonly<{ distributionDirectory: string; warn: (message: string) => void }>): WebApplication {
  const { distributionDirectory, warn } = options;
  let manifest: WebBuildManifest | null = null;
  const current = (): WebBuildManifest | null => {
    if (manifest !== null) return manifest;
    const path = join(distributionDirectory, "manifest.json");
    if (!existsSync(path)) return null;
    const parsed = parseManifest(readFileSync(path, "utf-8"));
    if (parsed === null) warn(`${path} is not a web build manifest`);
    manifest = parsed;
    return manifest;
  };

  return {
    handleRequest: ({ request, response, url }) => {
      const path = url.pathname;
      const isList = path === DECK_LIST_PAGE_PATH || path === `${DECK_LIST_PAGE_PATH}/`;
      const isDeck = path.startsWith(DECK_PAGE_PATH_PREFIX);
      const isAsset = path.startsWith(DECK_APPLICATION_ASSETS_PREFIX);
      if (!isList && !isDeck && !isAsset) return false;
      const method = request.method ?? "GET";
      if (method !== "GET" && method !== "HEAD") {
        response.writeHead(405, { allow: "GET, HEAD" }).end();
        return true;
      }
      const built = current();
      if (built === null) {
        sendText({ response, status: 503, text: "The web application is not built. Run npm run build:web in mcp/sasha-slides/engine." });
        return true;
      }
      if (isList) {
        sendFile({ response, path: join(distributionDirectory, built.listPage), contentType: PAGE_CONTENT_TYPE, headers: pageHeaders(built.contentSecurityPolicy) });
        return true;
      }
      if (isDeck) {
        if (parseDeckId(path.slice(DECK_PAGE_PATH_PREFIX.length)) === null) {
          sendText({ response, status: 404, text: "There is no such deck address." });
          return true;
        }
        const policy = url.searchParams.get("embed") === "addon" ? built.embeddedContentSecurityPolicy : built.contentSecurityPolicy;
        sendFile({ response, path: join(distributionDirectory, built.deckPage), contentType: PAGE_CONTENT_TYPE, headers: pageHeaders(policy) });
        return true;
      }
      const name = path.slice(DECK_APPLICATION_ASSETS_PREFIX.length);
      if (name.startsWith(RUNNER_SEGMENT)) {
        const file = name.slice(RUNNER_SEGMENT.length);
        if (!PLAIN_FILE_NAME.test(file)) {
          sendText({ response, status: 404, text: "Not found." });
          return true;
        }
        const headers = file === built.runnerPage ? { ...IMMUTABLE, "content-security-policy": built.runnerContentSecurityPolicy } : IMMUTABLE;
        sendFile({ response, path: join(distributionDirectory, "runner", file), contentType: contentTypeOf(file), headers });
        return true;
      }
      if (!built.assets.includes(name) || !PLAIN_FILE_NAME.test(name)) {
        sendText({ response, status: 404, text: "Not found." });
        return true;
      }
      sendFile({ response, path: join(distributionDirectory, "assets", name), contentType: contentTypeOf(name), headers: IMMUTABLE });
      return true;
    },
  };
}

const PAGE_CONTENT_TYPE = "text/html; charset=utf-8";
const RUNNER_SEGMENT = "runner/";
const PLAIN_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u;
const IMMUTABLE: Readonly<Record<string, string>> = {
  "cache-control": "public, max-age=31536000, immutable",
  "x-content-type-options": "nosniff",
};

function pageHeaders(policy: string): Readonly<Record<string, string>> {
  return {
    "cache-control": "no-cache",
    "content-security-policy": policy,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": PAGE_CONTENT_TYPE,
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return CONTENT_TYPES[dot < 0 ? "" : name.slice(dot)] ?? "application/octet-stream";
}

function sendFile(options: Readonly<{ response: ServerResponse; path: string; contentType: string; headers: Readonly<Record<string, string>> }>): void {
  if (!existsSync(options.path)) {
    sendText({ response: options.response, status: 404, text: "Not found." });
    return;
  }
  const body = readFileSync(options.path);
  options.response.writeHead(200, { ...options.headers, "content-type": options.contentType, "content-length": String(body.length) });
  options.response.end(body);
}

function sendText(options: Readonly<{ response: ServerResponse; status: number; text: string }>): void {
  options.response.writeHead(options.status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-length": String(Buffer.byteLength(options.text)) });
  options.response.end(options.text);
}

function parseManifest(source: string): WebBuildManifest | null {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(value));
  const text = (key: string): string | null => {
    const field = record[key];
    return typeof field === "string" ? field : null;
  };
  const assets = record["assets"];
  const listPage = text("listPage");
  const deckPage = text("deckPage");
  const contentSecurityPolicy = text("contentSecurityPolicy");
  const embeddedContentSecurityPolicy = text("embeddedContentSecurityPolicy");
  const runnerPage = text("runnerPage");
  const runnerContentSecurityPolicy = text("runnerContentSecurityPolicy");
  const builtAt = text("builtAt");
  if (!Array.isArray(assets) || !assets.every((asset): asset is string => typeof asset === "string")) return null;
  if (listPage === null || deckPage === null || contentSecurityPolicy === null || embeddedContentSecurityPolicy === null) return null;
  if (runnerPage === null || runnerContentSecurityPolicy === null || builtAt === null) return null;
  return { listPage, deckPage, assets, contentSecurityPolicy, embeddedContentSecurityPolicy, runnerPage, runnerContentSecurityPolicy, builtAt };
}
