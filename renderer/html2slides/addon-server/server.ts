/**
 * The sashaslides.com website: the product home page, the legal pages, the setup walkthroughs, the
 * developer page (/dev, unlinked) and the self-hosted draw.io editor (/drawio/). Plain HTTP on $PORT
 * behind the server's nginx, which terminates TLS and sends the connector's paths (/mcp, /account,
 * /decks, /deck-api, ...) to the connector instead (deploy/nginx-sashaslides.conf).
 *
 * Dependency-free on purpose (native `http` only), so it runs without an npm install and the image
 * stays small. Every page is a static file in public/; the developer page's scripts are built from
 * TypeScript by dev/build.ts (public/dev.js, dev-pptx.js, e2e-drawio.js).
 *
 * Routes:
 *   GET /healthz      liveness
 *   GET <page>        pages.ts: /, /dev, /privacy, /terms, /walkthroughs/*
 *   GET /static/*     public/ assets
 *   GET /drawio/*     the self-hosted draw.io webapp (deps/drawio), used by /dev and the add-on
 *   GET /<file>       public/ files by name (favicon.ico, e2e-drawio.html, ...)
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pageFor } from "./pages.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
// The draw.io webapp: the Maven webapp source of the deps/drawio submodule, or a built copy.
const DRAWIO_CANDIDATES = [join(HERE, "../../../deps/drawio/src/main/webapp"), join(HERE, "../../../deps/drawio/build")];
const DRAWIO_DIR = DRAWIO_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;

const PORT = Number(process.env["PORT"]) || 8787;
const HOST = process.env["HOST"] ?? "0.0.0.0";

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  // draw.io webapp assets (served under /drawio/): fonts, stencils, icons.
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".otf": "font/otf",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
};

const server = createServer((request, response) => {
  try {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const method = (request.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return send({ response, status: 405, body: "method not allowed" });
    if (path === "/healthz") return send({ response, status: 200, body: "ok" });

    if (path === "/drawio" || path.startsWith("/drawio/")) {
      if (DRAWIO_DIR === null) return send({ response, status: 503, body: "the drawio submodule is not populated on this host" });
      const relative = path === "/drawio" || path === "/drawio/" ? "index.html" : path.slice("/drawio/".length);
      if (serveStatic({ response, root: DRAWIO_DIR, relativePath: relative })) return;
      return send({ response, status: 404, body: "drawio asset not found" });
    }

    const page = pageFor(path);
    if (page !== null && serveStatic({ response, root: PUBLIC_DIR, relativePath: page })) return;
    if (path.startsWith("/static/") && serveStatic({ response, root: PUBLIC_DIR, relativePath: path.slice("/static/".length) })) return;
    if (serveStatic({ response, root: PUBLIC_DIR, relativePath: path.slice(1) })) return;
    send({ response, status: 404, body: "not found" });
  } catch (error) {
    send({ response, status: 500, body: `server error: ${error instanceof Error ? error.message : String(error)}` });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[site] listening on http://${HOST}:${PORT}`);
  console.log(`[site] drawio: ${DRAWIO_DIR === null ? "NOT populated (submodule)" : "self-hosted at /drawio/"}`);
});

export { server, PUBLIC_DIR, DRAWIO_DIR };

function send(options: Readonly<{ response: ServerResponse; status: number; body: string }>): void {
  options.response.writeHead(options.status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  options.response.end(options.body);
}

/** Serves a file under `root`, refusing any path that leaves it. False when there is no such file. */
function serveStatic(options: Readonly<{ response: ServerResponse; root: string; relativePath: string }>): boolean {
  if (options.relativePath === "") return false;
  const full = join(options.root, normalize(options.relativePath));
  if (!full.startsWith(options.root + sep) || !existsSync(full) || !statSync(full).isFile()) return false;
  const mediaType = MEDIA_TYPES[extname(full)] ?? "application/octet-stream";
  options.response.writeHead(200, { "Content-Type": mediaType, "Cache-Control": "public, max-age=300" });
  createReadStream(full).pipe(options.response);
  return true;
}
