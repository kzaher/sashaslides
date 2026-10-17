// ONE STATIC FILE SERVER for the demo build (build-demo.ts --serve) and every end-to-end driver:
// a built directory served on a host and port, never a path outside it (403), nothing cached, and
// optional extra headers per file (a content security policy). `sendFile` is the same answer for a
// server that routes some paths itself (e2e/web/fake-deck-site.ts).

import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

export type HeadersOf = (file: string) => Readonly<Record<string, string>>;

export type DirectoryServer = AsyncDisposable &
  Readonly<{
    /** `http://<host>:<port>/`, with the trailing slash. */
    address: string;
    port: number;
  }>;

/**
 * Serves `directory` until disposed. `port` 0 (the default) lets the system choose; host "::"
 * also answers IPv4, so one server can be reached as both 127.0.0.1 and localhost.
 */
export async function serveDirectory(options: Readonly<{ directory: string; host: string; port?: number; headers?: HeadersOf }>): Promise<DirectoryServer> {
  const server = createServer((request, response) => {
    void sendFile({ response, directory: options.directory, path: new URL(request.url ?? "/", "http://site").pathname, ...(options.headers === undefined ? {} : { headers: options.headers }) });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ port: options.port ?? 0, host: options.host, ipv6Only: false }, () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    address: `http://${options.host}:${port}/`,
    port,
    // Chrome keeps its connections alive, and `close` waits for them: drop them first, or the process never exits.
    [Symbol.asyncDispose]: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      }),
  };
}

/** Answers with the file at the URL-encoded `path` under `directory` ("/" is index.html). */
export async function sendFile(options: Readonly<{ response: ServerResponse; directory: string; path: string; headers?: HeadersOf }>): Promise<void> {
  const root = resolve(options.directory);
  let file: string;
  try {
    const relative = decodeURIComponent(options.path).replace(/^[/\\]+/, "");
    file = resolve(root, relative === "" ? "index.html" : relative);
  } catch {
    return answer({ response: options.response, status: 400, text: "Bad request" });
  }
  if (!file.startsWith(root + sep)) return answer({ response: options.response, status: 403, text: "Forbidden" });
  try {
    const bytes = await readFile(file);
    options.response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store", ...options.headers?.(file) });
    options.response.end(bytes);
  } catch {
    answer({ response: options.response, status: 404, text: "Not found" });
  }
}

function answer(options: Readonly<{ response: ServerResponse; status: number; text: string }>): void {
  options.response.writeHead(options.status, { "content-type": "text/plain; charset=utf-8" });
  options.response.end(options.text);
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
