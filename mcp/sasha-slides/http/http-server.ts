/**
 * The remote server's HTTP surface: the MCP Streamable HTTP endpoint, the two discovery
 * documents, and the three OAuth endpoints. Built on `node:http` and the SDK's
 * `StreamableHTTPServerTransport`; nothing here re-implements MCP framing.
 *
 * It is a translation layer only — every decision lives in `authorization-server.ts`, and
 * this file turns its outcome unions into status codes, headers and redirects. The parts
 * that genuinely belong to HTTP, and that Claude's connector docs are specific about:
 *
 *  - **The 401 is mandatory and must be a 401.** Claude ignores `WWW-Authenticate` on a
 *    200, so the challenge is attached to the 401 path and nowhere else.
 *  - **`/token` must accept `application/x-www-form-urlencoded`.** A JSON body gets 415,
 *    not a parse error, because the failure mode the docs call out is a framework that
 *    only parses JSON and answers 415 for the form encoding — the exact inverse. The two
 *    endpoints use two different parsers on purpose: `/register` is JSON (RFC 7591),
 *    `/token` is form (RFC 6749).
 *  - **CORS** exposes `WWW-Authenticate` and `Mcp-Session-Id`, or a browser-side client
 *    cannot see the challenge that starts the flow.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { parseJson } from "./json-values";
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  AUTHORIZE_PATH,
  bearerChallenge,
  GOOGLE_CALLBACK_PATH,
  MCP_PATH,
  PROTECTED_RESOURCE_METADATA_PATH,
  REGISTER_PATH,
  TOKEN_PATH,
} from "./oauth-metadata";
import { assertNever } from "../google-auth";
import type { AuthorizationServer, OAuthErrorCode } from "./authorization-server";

export type RequestListener = (request: IncomingMessage, response: ServerResponse) => void;

export function createSashaSlidesHttpServer(
  options: Readonly<{
    authorizationServer: AuthorizationServer;
    createMcpServer: () => McpServer;
    /** Wraps the per-request transport; the identity function in a plain deployment. */
    instrumentTransport: (inner: Transport) => Transport;
    warn: (message: string) => void;
  }>,
): Server {
  return createServer(sashaSlidesRequestListener(options));
}

export function sashaSlidesRequestListener(
  options: Readonly<{
    authorizationServer: AuthorizationServer;
    createMcpServer: () => McpServer;
    /** Wraps the per-request transport; the identity function in a plain deployment. */
    instrumentTransport: (inner: Transport) => Transport;
    warn: (message: string) => void;
  }>,
): RequestListener {
  const { authorizationServer, createMcpServer, instrumentTransport, warn } = options;
  const { endpoints } = authorizationServer;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    // The Host is never trusted for anything the documents contain: `publicUrl` is
    // configured, because `resource` has to equal the MCP URL Claude was given, exactly.
    const url = new URL(request.url ?? "/", "http://host.invalid");
    const path = url.pathname.replace(/\/+$/, "") === "" ? "/" : url.pathname.replace(/\/+$/, "");

    if (method === "OPTIONS") {
      response.writeHead(204, corsHeaders({ methods: "GET, POST, DELETE, OPTIONS" })).end();
      return;
    }

    if (isMetadataPath({ path, base: PROTECTED_RESOURCE_METADATA_PATH })) {
      sendJson({ response, status: 200, body: authorizationServer.protectedResourceMetadata });
      return;
    }
    if (
      isMetadataPath({ path, base: AUTHORIZATION_SERVER_METADATA_PATH }) ||
      isMetadataPath({ path, base: "/.well-known/openid-configuration" })
    ) {
      sendJson({ response, status: 200, body: authorizationServer.authorizationServerMetadata });
      return;
    }

    if (path === REGISTER_PATH) {
      await handleRegister({ request, response, authorizationServer });
      return;
    }
    if (path === AUTHORIZE_PATH) {
      await handleAuthorize({ response, authorizationServer, parameters: url.searchParams });
      return;
    }
    if (path === GOOGLE_CALLBACK_PATH) {
      await handleGoogleCallback({ response, authorizationServer, parameters: url.searchParams });
      return;
    }
    if (path === TOKEN_PATH) {
      await handleToken({ request, response, authorizationServer });
      return;
    }
    if (path === MCP_PATH) {
      await handleMcp({
        request,
        response,
        authorizationServer,
        createMcpServer,
        instrumentTransport,
        warn,
      });
      return;
    }
    if (path === "/healthz") {
      sendJson({ response, status: 200, body: { status: "ok", resource: endpoints.mcpUrl } });
      return;
    }
    sendJson({ response, status: 404, body: { error: "not_found", error_description: `no route for ${path}` } });
  }

  return (request, response) => {
    void route(request, response).catch((cause: unknown) => {
      warn(`unhandled error serving ${request.method ?? "?"} ${request.url ?? "?"}: ${String(cause)}`);
      if (response.headersSent) {
        response.end();
        return;
      }
      sendJson({
        response,
        status: 500,
        body: { error: "server_error", error_description: "the server failed to handle the request" },
      });
    });
  };
}

export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** RFC 6749 section 5.2 / RFC 6750: which status an error code is reported with. */
export function statusForOAuthError(error: OAuthErrorCode): number {
  switch (error) {
    case "invalid_client":
      return 401;
    case "unauthorized_client":
    case "access_denied":
      return 403;
    case "invalid_request":
    case "invalid_grant":
    case "unsupported_grant_type":
    case "unsupported_response_type":
    case "invalid_scope":
    case "invalid_target":
      return 400;
    case "server_error":
      return 500;
    default:
      return assertNever(error);
  }
}

async function handleRegister(
  options: Readonly<{
    request: IncomingMessage;
    response: ServerResponse;
    authorizationServer: AuthorizationServer;
  }>,
): Promise<void> {
  const { request, response, authorizationServer } = options;
  if ((request.method ?? "GET") !== "POST") {
    sendOAuthError({ response, error: "invalid_request", description: "POST only" });
    return;
  }
  // RFC 7591: the registration request is JSON. A form body here is the mirror image of
  // the /token mistake, so it gets the same 415 treatment.
  if (mediaTypeOf(request) !== "application/json") {
    sendUnsupportedMediaType({ response, expected: "application/json" });
    return;
  }
  const body = await readBody({ request });
  if (body.kind === "too-large") {
    sendOAuthError({ response, error: "invalid_request", description: body.reason });
    return;
  }
  const parsed = parseJson(body.text);
  if (parsed.kind === "error") {
    sendOAuthError({ response, error: "invalid_request", description: `body is not JSON: ${parsed.reason}` });
    return;
  }
  const outcome = await authorizationServer.register({ body: parsed.value });
  switch (outcome.kind) {
    case "registered":
      sendJson({ response, status: 201, body: outcome.response });
      return;
    case "error":
      sendOAuthError({ response, error: outcome.error, description: outcome.description });
      return;
    default:
      assertNever(outcome);
  }
}

async function handleAuthorize(
  options: Readonly<{
    response: ServerResponse;
    authorizationServer: AuthorizationServer;
    parameters: URLSearchParams;
  }>,
): Promise<void> {
  const outcome = await options.authorizationServer.authorize({ parameters: options.parameters });
  switch (outcome.kind) {
    case "redirect":
      sendRedirect({ response: options.response, location: outcome.location });
      return;
    case "invalid":
      sendOAuthError({
        response: options.response,
        error: outcome.error,
        description: outcome.description,
      });
      return;
    default:
      assertNever(outcome);
  }
}

async function handleGoogleCallback(
  options: Readonly<{
    response: ServerResponse;
    authorizationServer: AuthorizationServer;
    parameters: URLSearchParams;
  }>,
): Promise<void> {
  const outcome = await options.authorizationServer.googleCallback({ parameters: options.parameters });
  switch (outcome.kind) {
    case "redirect":
      sendRedirect({ response: options.response, location: outcome.location });
      return;
    case "invalid":
      sendOAuthError({
        response: options.response,
        error: outcome.error,
        description: outcome.description,
      });
      return;
    default:
      assertNever(outcome);
  }
}

async function handleToken(
  options: Readonly<{
    request: IncomingMessage;
    response: ServerResponse;
    authorizationServer: AuthorizationServer;
  }>,
): Promise<void> {
  const { request, response, authorizationServer } = options;
  if ((request.method ?? "GET") !== "POST") {
    sendOAuthError({ response, error: "invalid_request", description: "POST only" });
    return;
  }
  if (mediaTypeOf(request) !== "application/x-www-form-urlencoded") {
    sendUnsupportedMediaType({ response, expected: "application/x-www-form-urlencoded" });
    return;
  }
  const body = await readBody({ request });
  if (body.kind === "too-large") {
    sendOAuthError({ response, error: "invalid_request", description: body.reason });
    return;
  }
  const outcome = await authorizationServer.token({ parameters: new URLSearchParams(body.text) });
  switch (outcome.kind) {
    case "issued":
      // RFC 6749 section 5.1: a token response must not be cached.
      sendJson({
        response,
        status: 200,
        body: outcome.response,
        headers: { "cache-control": "no-store", pragma: "no-cache" },
      });
      return;
    case "error":
      sendOAuthError({ response, error: outcome.error, description: outcome.description });
      return;
    default:
      assertNever(outcome);
  }
}

/**
 * The protected resource. Unauthenticated calls get the 401 that starts the flow; an
 * authorized call gets a fresh `McpServer` + transport in stateless mode, with the caller's
 * `AuthInfo` attached to the request so tool handlers can read `extra.authInfo`.
 *
 * One server and transport per request, deliberately: there is then no object in which one
 * user's identity could survive into another user's call.
 */
async function handleMcp(
  options: Readonly<{
    request: IncomingMessage & { auth?: AuthInfo };
    response: ServerResponse;
    authorizationServer: AuthorizationServer;
    createMcpServer: () => McpServer;
    /** Wraps the per-request transport; the identity function in a plain deployment. */
    instrumentTransport: (inner: Transport) => Transport;
    warn: (message: string) => void;
  }>,
): Promise<void> {
  const { request, response, authorizationServer, createMcpServer, instrumentTransport, warn } =
    options;
  const verified = await authorizationServer.verifyBearer({ token: bearerTokenOf(request) });
  if (verified.kind === "unauthorized") {
    response.writeHead(401, {
      ...corsHeaders({ methods: "GET, POST, DELETE, OPTIONS" }),
      "content-type": "application/json",
      "www-authenticate": bearerChallenge({
        endpoints: authorizationServer.endpoints,
        error: verified.error === "missing-token" ? "missing-token" : "invalid_token",
        description: verified.description,
      }),
    });
    response.end(
      JSON.stringify({ error: "invalid_token", error_description: verified.description }),
    );
    return;
  }

  request.auth = verified.authInfo;
  const server = createMcpServer();
  // No `sessionIdGenerator` is stateless mode, which the SDK documents as requiring a
  // fresh transport per request — which is what this is.
  const transport = new StreamableHTTPServerTransport({});
  response.on("close", () => {
    void transport.close().catch((cause: unknown) => warn(`transport close failed: ${String(cause)}`));
    void server.close().catch((cause: unknown) => warn(`server close failed: ${String(cause)}`));
  });
  // `StreamableHTTPServerTransport` exposes onclose/onerror/onmessage as accessors typed
  // `T | undefined`, while `Transport` declares them as optional properties; under
  // exactOptionalPropertyTypes those are different types for an identical runtime shape
  // (streamableHttp.d.ts is a straight forwarder to the web-standard transport, which
  // itself `implements Transport`). Every member `connect` uses is present.
  await server.connect(instrumentTransport(transport as unknown as Transport));
  await transport.handleRequest(request, response);
}

type ReadBody =
  | Readonly<{ kind: "ok"; text: string }>
  | Readonly<{ kind: "too-large"; reason: string }>;

function readBody(options: Readonly<{ request: IncomingMessage }>): Promise<ReadBody> {
  return new Promise<ReadBody>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    options.request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        options.request.destroy();
        resolve({
          kind: "too-large",
          reason: `body exceeds ${String(MAX_REQUEST_BODY_BYTES)} bytes`,
        });
        return;
      }
      chunks.push(chunk);
    });
    options.request.on("end", () => resolve({ kind: "ok", text: Buffer.concat(chunks).toString("utf-8") }));
    options.request.on("error", reject);
  });
}

/** The media type without its parameters, lowercased: `application/json; charset=utf-8`. */
function mediaTypeOf(request: IncomingMessage): string | null {
  const header = request.headers["content-type"];
  if (typeof header !== "string") return null;
  const type = header.split(";")[0];
  return type === undefined ? null : type.trim().toLowerCase();
}

function bearerTokenOf(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Both `/.well-known/x` and `/.well-known/x/mcp` answer: RFC 9728 appends the resource's
 * path, and clients differ on whether they do so for the AS document too.
 */
function isMetadataPath(options: Readonly<{ path: string; base: string }>): boolean {
  return options.path === options.base || options.path === `${options.base}${MCP_PATH}`;
}

function sendJson(
  options: Readonly<{
    response: ServerResponse;
    status: number;
    body: unknown;
    headers?: Readonly<Record<string, string>>;
  }>,
): void {
  const payload = JSON.stringify(options.body, null, 2);
  options.response.writeHead(options.status, {
    ...corsHeaders({ methods: "GET, POST, DELETE, OPTIONS" }),
    ...(options.headers ?? {}),
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload, "utf-8")),
  });
  options.response.end(payload);
}

function sendOAuthError(
  options: Readonly<{ response: ServerResponse; error: OAuthErrorCode; description: string }>,
): void {
  sendJson({
    response: options.response,
    status: statusForOAuthError(options.error),
    body: { error: options.error, error_description: options.description },
    headers: { "cache-control": "no-store" },
  });
}

function sendUnsupportedMediaType(
  options: Readonly<{ response: ServerResponse; expected: string }>,
): void {
  sendJson({
    response: options.response,
    status: 415,
    body: {
      error: "invalid_request",
      error_description: `this endpoint requires Content-Type: ${options.expected}`,
    },
    headers: { accept: options.expected },
  });
}

function sendRedirect(options: Readonly<{ response: ServerResponse; location: string }>): void {
  options.response.writeHead(302, {
    ...corsHeaders({ methods: "GET, OPTIONS" }),
    location: options.location,
    "cache-control": "no-store",
  });
  options.response.end();
}

function corsHeaders(options: Readonly<{ methods: string }>): Readonly<Record<string, string>> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": options.methods,
    "access-control-allow-headers": "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version",
    // Without this a browser-side client cannot read the challenge off the 401, and the
    // flow never starts.
    "access-control-expose-headers": "WWW-Authenticate, Mcp-Session-Id",
    "access-control-max-age": "86400",
  };
}
