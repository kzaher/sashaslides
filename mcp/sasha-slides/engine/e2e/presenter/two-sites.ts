// THE TWO SITES the presenter needs in a browser: the editor (here, the scenario page) on
// 127.0.0.1 and the runner on localhost -- different sites, so Chrome's site isolation runs the
// sandboxed runner in another process (transition-protocol.ts header). Both are tiny static servers
// over a built directory; the runner's responses carry its content security policy as a header,
// as production will. Ports are chosen by the system and released when the scope ends.

import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";

export type TwoSites = AsyncDisposable &
  Readonly<{
    editorAddress: string;
    runnerAddress: string;
  }>;

export async function serveTwoSites(
  options: Readonly<{ editorDirectory: string; runnerDirectory: string; runnerContentSecurityPolicy: string }>,
): Promise<TwoSites> {
  const editor = await listen({ server: staticServer({ directory: options.editorDirectory, headers: {} }), host: "127.0.0.1" });
  const runner = await listen({
    server: staticServer({ directory: options.runnerDirectory, headers: { "content-security-policy": options.runnerContentSecurityPolicy } }),
    host: "::",
  });
  return {
    editorAddress: `http://127.0.0.1:${editor.port}`,
    runnerAddress: `http://localhost:${runner.port}`,
    async [Symbol.asyncDispose]() {
      await Promise.all([close(editor.server), close(runner.server)]);
    },
  };
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

function staticServer(options: Readonly<{ directory: string; headers: Readonly<Record<string, string>> }>): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://site").pathname;
    const relative = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
    readFile(join(options.directory, relative))
      .then((body) => {
        response.writeHead(200, { "content-type": MEDIA_TYPES[extname(relative)] ?? "application/octet-stream", "cache-control": "no-store", ...options.headers });
        response.end(body);
      })
      .catch(() => {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("not found");
      });
  });
}

async function listen(options: Readonly<{ server: Server; host: string }>): Promise<Readonly<{ server: Server; port: number }>> {
  await new Promise<void>((resolve, reject) => {
    options.server.once("error", reject);
    options.server.listen({ port: 0, host: options.host, ipv6Only: false }, () => resolve());
  });
  // A server listening on a TCP port reports an AddressInfo (not a pipe name).
  return { server: options.server, port: (options.server.address() as AddressInfo).port };
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
