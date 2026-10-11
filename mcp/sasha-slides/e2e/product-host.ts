#!/usr/bin/env npx tsx
/**
 * product-host.ts — the local stand-in for the Apps Script host.
 *
 * It serves the EMITTED `dist/mcp/sasha-slides/addon/Sidebar.html` — byte for byte the bundle
 * `clasp push` would upload — with two things added ahead of it:
 *
 *   1. `<meta name="sasha-e2e-shim-config">`, carrying a fresh OAuth access token and the target
 *      deck's URL as base64 JSON. A `<meta>` rather than an inlined JS literal so nothing
 *      hand-written in JavaScript ships into the page (repo rule: compile TS, never ship raw JS).
 *   2. the compiled `product-shim/shim.ts` bundle, which installs `window.google.script.run`.
 *
 * It is a LONG-LIVED SERVICE, so it is started detached (`setsid`) and outlives the turn, the same
 * way Chrome and the VNC stack are run here. Each *test* step then fits inside the 30 s command cap.
 *
 *   setsid env … npx tsx mcp/sasha-slides/e2e/product-host.ts \
 *       --port 7342 --presentation <deckId> > /tmp/host.log 2>&1 < /dev/null &
 *
 * Endpoints
 *   GET /sidebar.html   the page (token minted per request, so a long session cannot go stale)
 *   GET /healthz        readiness + which deck + token expiry, for the harness to poll
 *   GET /token          a freshly minted access token, which the shim re-reads after a 401
 *   GET /relay?url=…    one server-side fetch of a Google-hosted URL. This is the harness's
 *                       UrlFetchApp: a page thumbnail's `contentUrl` is an unauthenticated
 *                       googleusercontent.com link whose bytes a browser cannot read cross-origin,
 *                       and Apps Script reads it server side. Nothing else is proxied.
 *
 * It binds 127.0.0.1 EXPLICITLY. Node's default bind picks `::` here, and an IPv6-only listener is
 * invisible to curl and to Chrome's `http://127.0.0.1:<port>`.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { OAuth2Client } from "google-auth-library";
import { describeAuthFailure, loadOAuthClient } from "../google-auth.ts";

const HERE = __dirname;
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SIDEBAR_PATH = join(REPO_ROOT, "dist", "mcp", "sasha-slides", "addon", "Sidebar.html");
const SHIM_ENTRY = join(HERE, "product-shim", "shim.ts");
const SHIM_PROJECT = join(HERE, "product-shim");
const INBOX_FOLDER_NAME = "Sasha Slides Inbox";
const RELAY_PATH = "/relay";
const TOKEN_PATH = "/token";
/** Only a Google-served asset may be relayed; the endpoint is not an open proxy. */
const RELAY_HOST_SUFFIXES = [".googleusercontent.com", ".googleapis.com", ".google.com"] as const;

type HostOptions = Readonly<{ port: number; presentationId: string }>;

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.kind === "invalid") {
    process.stderr.write(`product-host: ${parsed.reason}\n\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  if (!existsSync(SIDEBAR_PATH)) {
    throw new Error(`no ${SIDEBAR_PATH} — run: cd mcp/sasha-slides/addon && npx tsx build-addon.ts`);
  }
  const sidebar = readFileSync(SIDEBAR_PATH, "utf-8");
  if (!sidebar.includes("<script>")) throw new Error(`${SIDEBAR_PATH} carries no inline bundle`);

  // The gate, before anything is emitted: esbuild strips types without checking them.
  process.stdout.write(`typecheck  ${SHIM_PROJECT}\n`);
  execFileSync(join(REPO_ROOT, "node_modules", ".bin", "tsc"), ["--noEmit", "-p", SHIM_PROJECT], { stdio: "inherit" });
  const shimJs = await bundleShim();
  process.stdout.write(`shim       ${SHIM_ENTRY} -> ${shimJs.length.toLocaleString()} bytes JS\n`);

  const loaded = await loadOAuthClient();
  if (loaded.kind !== "ok") throw new Error(`cannot serve: ${describeAuthFailure(loaded)}`);
  const auth = loaded.auth;
  process.stdout.write(`auth       scopes: ${loaded.granted.join(" ")}\n`);

  await serve({ options: parsed.options, sidebar, shimJs, auth });
}

function serve({
  options,
  sidebar,
  shimJs,
  auth,
}: {
  options: HostOptions;
  sidebar: string;
  shimJs: string;
  auth: OAuth2Client;
}): Promise<void> {
  const presentationUrl = `https://docs.google.com/presentation/d/${options.presentationId}/edit`;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void route({ request, response, options, sidebar, shimJs, auth, presentationUrl }).catch((cause: unknown) => {
      answer({ response, status: 500, contentType: "text/plain; charset=utf-8", body: describe(cause) });
    });
  });

  return new Promise<void>((_never, failed) => {
    server.on("error", failed);
    server.listen(options.port, "127.0.0.1", () => {
      process.stdout.write(
        `listening  http://127.0.0.1:${options.port}/sidebar.html\n` +
          `deck       ${presentationUrl}\n` +
          "ready\n",
      );
    });
  });
}

async function route({
  request,
  response,
  options,
  sidebar,
  shimJs,
  auth,
  presentationUrl,
}: {
  request: IncomingMessage;
  response: ServerResponse;
  options: HostOptions;
  sidebar: string;
  shimJs: string;
  auth: OAuth2Client;
  presentationUrl: string;
}): Promise<void> {
  const requested = new URL(request.url ?? "/", `http://127.0.0.1:${options.port}`);
  switch (requested.pathname) {
    case "/":
    case "/sidebar.html": {
      const page = pageWithShim({
        sidebar,
        shimJs,
        config: {
          accessToken: await accessTokenOf(auth),
          presentationUrl,
          inboxFolderName: INBOX_FOLDER_NAME,
          relayPath: RELAY_PATH,
          tokenPath: TOKEN_PATH,
        },
      });
      answer({ response, status: 200, contentType: "text/html; charset=utf-8", body: page });
      return;
    }
    case "/healthz": {
      const token = await accessTokenOf(auth);
      answer({
        response,
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({
          ok: true,
          presentationId: options.presentationId,
          presentationUrl,
          sidebarBytes: sidebar.length,
          shimBytes: shimJs.length,
          tokenPrefix: token.slice(0, 8),
          tokenExpiresAt:
            typeof auth.credentials.expiry_date === "number" ? new Date(auth.credentials.expiry_date).toISOString() : null,
        }),
      });
      return;
    }
    case TOKEN_PATH: {
      answer({
        response,
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: JSON.stringify({ accessToken: await accessTokenOf(auth) }),
      });
      return;
    }
    case RELAY_PATH: {
      await relay({ response, target: requested.searchParams.get("url") });
      return;
    }
    default:
      answer({ response, status: 404, contentType: "text/plain; charset=utf-8", body: `no ${requested.pathname}` });
      return;
  }
}

/** The served document: config meta, then the shim, then the untouched sidebar bundle in <body>. */
function pageWithShim({
  sidebar,
  shimJs,
  config,
}: {
  sidebar: string;
  shimJs: string;
  config: Readonly<{
    accessToken: string;
    presentationUrl: string;
    inboxFolderName: string;
    relayPath: string;
    tokenPath: string;
  }>;
}): string {
  const encoded = Buffer.from(JSON.stringify(config), "utf-8").toString("base64");
  const head = `<meta name="sasha-e2e-shim-config" content="${encoded}">\n<script>\n${shimJs}\n</script>\n</head>`;
  return sidebar.replace("</head>", head);
}

function bundleShim(): Promise<string> {
  return build({
    entryPoints: [SHIM_ENTRY],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    sourcemap: false,
    legalComments: "none",
    logLevel: "warning",
  }).then((bundled) => {
    const text = bundled.outputFiles?.[0]?.text;
    if (text === undefined) throw new Error("esbuild produced no shim output");
    return text;
  });
}

async function relay({ response, target }: { response: ServerResponse; target: string | null }): Promise<void> {
  if (target === null) {
    answer({ response, status: 400, contentType: "text/plain; charset=utf-8", body: "relay needs ?url=" });
    return;
  }
  const allowed = isRelayable(target);
  if (!allowed) {
    answer({ response, status: 403, contentType: "text/plain; charset=utf-8", body: `relay refuses ${target.slice(0, 120)}` });
    return;
  }
  const fetched = await fetch(target);
  if (!fetched.ok) {
    answer({ response, status: 502, contentType: "text/plain; charset=utf-8", body: `upstream HTTP ${fetched.status}` });
    return;
  }
  const bytes = Buffer.from(await fetched.arrayBuffer());
  response.writeHead(200, {
    "Content-Type": fetched.headers.get("content-type") ?? "application/octet-stream",
    "Content-Length": String(bytes.byteLength),
    // The page is a different origin (127.0.0.1:<port> vs the same host), so the fetch needs this.
    "Access-Control-Allow-Origin": "*",
  });
  response.end(bytes);
}

function isRelayable(target: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  return RELAY_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
}

async function accessTokenOf(auth: OAuth2Client): Promise<string> {
  // googleapis refreshes in here when the cached token has expired; a dead refresh token throws,
  // which is what should surface rather than a silent 401 inside the page.
  const minted = await auth.getAccessToken();
  if (typeof minted.token !== "string" || minted.token === "") throw new Error("getAccessToken returned no token");
  return minted.token;
}

function answer({
  response,
  status,
  contentType,
  body,
}: {
  response: ServerResponse;
  status: number;
  contentType: string;
  body: string;
}): void {
  response.writeHead(status, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*" });
  response.end(body);
}

type ParsedArguments =
  | Readonly<{ kind: "run"; options: HostOptions }>
  | Readonly<{ kind: "invalid"; reason: string }>;

function parseArguments(argv: readonly string[]): ParsedArguments {
  let port = 7342;
  let presentationId = "";
  for (let position = 0; position < argv.length; position += 1) {
    const flag = argv[position];
    const value = argv[position + 1];
    switch (flag) {
      case "--port": {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
          return { kind: "invalid", reason: "--port takes a port number" };
        }
        port = parsed;
        position += 1;
        break;
      }
      case "--presentation": {
        if (value === undefined || !/^[A-Za-z0-9_-]{10,}$/.test(value)) {
          return { kind: "invalid", reason: "--presentation takes a Google Slides file id" };
        }
        presentationId = value;
        position += 1;
        break;
      }
      default:
        return { kind: "invalid", reason: `unknown flag "${String(flag)}"` };
    }
  }
  if (presentationId === "") return { kind: "invalid", reason: "--presentation is required" };
  return { kind: "run", options: { port, presentationId } };
}

function usage(): string {
  return [
    "usage: npx tsx mcp/sasha-slides/e2e/product-host.ts --presentation <fileId> [--port 7342]",
    "",
    "Serves dist/mcp/sasha-slides/addon/Sidebar.html with a real google.script.run shim.",
    "Start it detached — it is a service, not a test step:",
    "  setsid npx tsx mcp/sasha-slides/e2e/product-host.ts --presentation <id> > /tmp/host.log 2>&1 < /dev/null &",
  ].join("\n");
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.message}\n${cause.stack ?? ""}` : String(cause);
}

// Wrapped rather than top-level await: the root package.json has no "type": "module", so tsx
// transforms this to CJS, where esbuild rejects top-level await outright.
void main().catch((cause: unknown) => {
  process.stderr.write(`product-host failed: ${describe(cause)}\n`);
  process.exit(1);
});
