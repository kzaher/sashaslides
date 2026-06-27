/**
 * addon-server — the externally-hosted UI + API for the html2slides Google Slides
 * add-on. The Apps Script sidebar is a thin shell: `Code.gs` fetches `/shell.html`
 * from this server and serves it via HtmlService (so the UI updates without
 * redeploying the add-on), while the heavy UI bundle + the self-hosted drawio
 * editor load directly from this server (script-src / iframe).
 *
 * Dependency-free on purpose (native `http` + libs already in the repo's root
 * node_modules) so it runs without an npm install, and so the Docker image stays
 * small. TLS/Let's Encrypt is terminated by Caddy in front of this (see Caddyfile);
 * this process always speaks plain HTTP on $PORT behind it.
 *
 * Routes (│ = filled by a parallel feature workstream):
 *   GET  /healthz                 — liveness (Caddy upstream check)
 *   GET  /                        — the full option-rich UI (public/app.html)
 *   GET  /shell.html              — small shell Code.gs fetches → HtmlService
 *   GET  /static/*                — public/ assets (app.js, app.css)
 *   GET  /drawio/*                — self-hosted drawio webapp (deps/drawio)        │ D
 *   GET  /api/config              — UI defaults (oversampling, etc.)
 *   POST /api/export              — zip of non-skipped slides as PNG (slide range) │ B
 *   POST /api/drawio/render       — drawio mxfile XML → PNG (+embedded XML chunk)  │ D
 *   POST /api/drawio/detect       — scan a PNG for an embedded drawio mxfile       │ D
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { existsSync, statSync, createReadStream, readFileSync } from "fs";
import { join, normalize, extname, dirname } from "path";
import { fileURLToPath } from "url";
import { apiHandlers } from "./registry.js";
// Feature modules register their routes (via ./registry) at import time. Static
// imports so tsx resolves the .js→.ts mapping; each is a no-op stub until its
// workstream lands. Adding a workstream = new file under api/ + one import here.
import "./api/export.js";
import "./api/drawio.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "public");
// drawio webapp root once the submodule is populated on the host. The Maven
// webapp source lives under src/main/webapp; a built/exported copy may live in
// a `build/` dir — prefer whichever exists.
const DRAWIO_CANDIDATES = [
  join(HERE, "../../../deps/drawio/src/main/webapp"),
  join(HERE, "../../../deps/drawio/build"),
];
const DRAWIO_DIR = DRAWIO_CANDIDATES.find((d) => existsSync(d)) || null;

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "0.0.0.0";

// Build stamp written into the image at build time (Dockerfile → public/build-info.json),
// surfaced via /api/config so the UI can show when it was last refreshed.
let BUILD_DATE = "dev";
try { BUILD_DATE = JSON.parse(readFileSync(join(PUBLIC_DIR, "build-info.json"), "utf8")).buildDate || "dev"; } catch { /* no stamp (dev) */ }

// Default UI config — overridable via env so the container is configurable.
const CONFIG = {
  buildDate: BUILD_DATE,
  oversampling: { default: Number(process.env.OVERSAMPLING_DEFAULT) || 2, min: 1, max: 8 },
  drawioAvailable: Boolean(DRAWIO_DIR),
  // Marker fill used for the off-canvas drawio-XML text field so it's easy to
  // find in the Slides selection pane / API. Bright magenta, deliberately garish.
  drawioMetaColor: process.env.DRAWIO_META_COLOR || "FF00FF",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gs": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  // drawio webapp assets (served under /drawio/) — fonts, stencils, icons.
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

function send(res: ServerResponse, status: number, body: string | Buffer, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

/** Read the JSON body of a request (capped). */
function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Serve a file from a root, blocking path traversal. */
function serveStatic(res: ServerResponse, root: string, relPath: string): boolean {
  const safe = normalize(relPath).replace(/^(\.\.[/\\])+/, "");
  const full = join(root, safe);
  if (!full.startsWith(root) || !existsSync(full) || !statSync(full).isFile()) return false;
  const type = MIME[extname(full)] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=300" });
  createReadStream(full).pipe(res);
  return true;
}

// Feature extension points live in ./registry (apiHandlers + registerApi),
// imported above — kept in a separate module so feature files don't import this
// server module (circular import + top-level await = deadlock).

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const p = url.pathname;
    const method = (req.method || "GET").toUpperCase();
    // lazy body reader (only the handler that needs it pays for it)
    let bodyPromise: Promise<Buffer> | null = null;
    const body = () => (bodyPromise ??= readBody(req));

    // CORS for the Apps Script HtmlService origin + local dev. The UI is loaded
    // cross-origin (script-src / iframe from googleusercontent.com), so allow it.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    // `*` = allow any request header (the sidebar runs cross-origin in the Apps
    // Script iframe; a too-narrow list fails the preflight → "Failed to fetch").
    res.setHeader("Access-Control-Allow-Headers", "*");
    if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (p === "/healthz") return send(res, 200, "ok");
    if (p === "/api/config") return send(res, 200, JSON.stringify(CONFIG), MIME[".json"]);

    // registered API handlers (export, drawio, …)
    for (const h of apiHandlers) {
      if (h.method === method && p === h.path) {
        if (await h.fn(req, res, url, body)) return;
      }
    }

    // self-hosted drawio webapp
    if (p === "/drawio" || p.startsWith("/drawio/")) {
      if (!DRAWIO_DIR) return send(res, 503, "drawio submodule not populated on this host");
      const rel = p === "/drawio" || p === "/drawio/" ? "index.html" : p.slice("/drawio/".length);
      if (serveStatic(res, DRAWIO_DIR, rel)) return;
      return send(res, 404, "drawio asset not found");
    }

    // One-line installer: serve public/install.sh with __ORIGIN__ baked in so the
    // piped `curl … | sh` downloads the bridge zip from this same origin.
    if (p === "/install.sh") {
      const proto = (req.headers["x-forwarded-proto"] as string)
        || (url.hostname === "localhost" || url.hostname.startsWith("127.") ? "http" : "https");
      const origin = `${proto}://${req.headers.host}`;
      const sh = readFileSync(join(PUBLIC_DIR, "install.sh"), "utf8").split("__ORIGIN__").join(origin);
      res.writeHead(200, { "Content-Type": "text/x-shellscript", "Cache-Control": "no-store" });
      res.end(sh);
      return;
    }

    // UI shell + app + static
    if (p === "/" ) { if (serveStatic(res, PUBLIC_DIR, "app.html")) return; }
    if (p === "/shell.html") { if (serveStatic(res, PUBLIC_DIR, "shell.html")) return; }
    if (p.startsWith("/static/")) { if (serveStatic(res, PUBLIC_DIR, p.slice("/static/".length))) return; }
    if (serveStatic(res, PUBLIC_DIR, p.slice(1))) return;

    send(res, 404, "not found");
  } catch (err) {
    send(res, 500, `server error: ${(err as Error).message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[addon-server] listening on http://${HOST}:${PORT}`);
  console.log(`[addon-server] drawio: ${DRAWIO_DIR ? "self-hosted at /drawio" : "NOT populated (submodule)"}`);
  console.log(`[addon-server] oversampling default ${CONFIG.oversampling.default}x (${CONFIG.oversampling.min}-${CONFIG.oversampling.max})`);
});

export { server, CONFIG, PUBLIC_DIR, DRAWIO_DIR };
