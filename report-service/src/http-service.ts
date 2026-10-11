// THE HTTP SURFACE. Four routes, one response shape, and no path by which a submission can come
// back out.
//
//   POST   /v1/reports       accept, validate, store, hand back an id and a deletion token
//   GET    /v1/reports/:id   the receipt: timestamps, sizes, versions. NO CONTENT, EVER.
//   DELETE /v1/reports/:id   self-service deletion, gated on the deletion token
//   GET    /healthz          liveness
//
// WHY THERE IS NO HTML VIEW AND NO ENDPOINT THAT RETURNS A SUBMISSION. A service that accepts
// arbitrary HTML from strangers and can be made to serve it back is an open XSS and phishing host:
// an attacker submits a page, gets a URL on this origin, and sends it to someone. The defence is
// structural rather than a sanitiser. The store exposes no function that returns the submitted
// text (see `report-store.ts`), so a handler here physically cannot read it; every response is
// `application/json` with `X-Content-Type-Options: nosniff` so a browser will not sniff it into
// markup; and every response carries `Content-Security-Policy: default-src 'none'; sandbox`, which
// neutralises scripting even if some future route did serve the wrong thing. An operator who needs
// to read a report opens the file on disk.
//
// ERROR BODIES NEVER QUOTE A VALUE. `{"error":{"code":…,"message":…}}` where `message` names a
// field and a limit. The field name itself is scrubbed by `safeFieldName` before it is used,
// because it came from the attacker's JSON.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { assertNever } from "./assert-never.ts";
import {
  ALLOWED_METHODS,
  ALLOWED_REQUEST_HEADERS,
  corsDecisionFor,
  type CorsDecision,
  type CorsPolicy,
} from "./cors.ts";
import { clientIdentityOf, type ClientIdentity } from "./client-identity.ts";
import {
  DEFECT_REPORT_SCHEMA_VERSION,
  parseDefectReport,
  REPORT_LIMITS,
  type ReportRejection,
  type ReportRejectionCode,
} from "./defect-report.ts";
import { parseDeletionToken, parseReportId, type ReportId } from "./report-id.ts";
import type { CapacityLimit, ReportIndexEntry, ReportStore } from "./report-store.ts";
import type { RateLimiter } from "./rate-limiter.ts";
import type { RequestLog, RequestOutcome } from "./request-log.ts";

/** Everything the HTTP layer needs, all injected: no module-level state, no clock of its own. */
export type ReportServiceDependencies = Readonly<{
  store: ReportStore;
  /** Small and fast-refilling: absorbs a legitimate flurry, stops a hammering loop. */
  burstLimiter: RateLimiter;
  /** Large and slow-refilling: stops a patient client from submitting all day. */
  sustainedLimiter: RateLimiter;
  log: RequestLog;
  now: () => Date;
  limits: HttpLimits;
  cors: CorsPolicy;
}>;

export type HttpLimits = Readonly<{
  maxBodyBytes: number;
  trustedProxyHops: number;
  ipHashSecret: string;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxConnections: number;
}>;

export function createReportServer(dependencies: ReportServiceDependencies): Server {
  const server = createServer((request, response) => {
    void handle({ request, response, dependencies });
  });

  // Slow-loris budget. A request that has not finished its headers in `headersTimeoutMs`, or its
  // body in `requestTimeoutMs`, is dropped: without these a few hundred trickling sockets can hold
  // the connection budget open indefinitely at no cost to the attacker.
  server.headersTimeout = dependencies.limits.headersTimeoutMs;
  server.requestTimeout = dependencies.limits.requestTimeoutMs;
  server.keepAliveTimeout = dependencies.limits.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = 256;
  server.maxConnections = dependencies.limits.maxConnections;

  // A malformed request line never reaches the handler, so it gets its answer here. Without this
  // Node emits an unhandled `clientError` and the socket is left to the default 400.
  server.on("clientError", (_error, socket) => {
    if (socket.writableEnded) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return server;
}

/** The receipt body. Spelled out as a type so no field can be added without being read here. */
export type ReportReceipt = Readonly<{
  id: string;
  receivedAt: string;
  clientReportedAt: string;
  storedBytes: number;
  htmlBytes: number;
  converterOutputBytes: number;
  noteBytes: number;
  versions: Readonly<{ addon: string; converter: string; protocol: number }>;
}>;

export function receiptOf(entry: ReportIndexEntry): ReportReceipt {
  return {
    id: entry.id,
    receivedAt: entry.receivedAt,
    clientReportedAt: entry.clientReportedAt,
    storedBytes: entry.storedBytes,
    htmlBytes: entry.htmlBytes,
    converterOutputBytes: entry.converterOutputBytes,
    noteBytes: entry.noteBytes,
    versions: entry.versions,
  };
}

type Route =
  | Readonly<{ kind: "health" }>
  | Readonly<{ kind: "submit" }>
  | Readonly<{ kind: "receipt"; id: ReportId }>
  | Readonly<{ kind: "delete"; id: ReportId }>
  | Readonly<{ kind: "preflight" }>
  | Readonly<{ kind: "method-not-allowed" }>
  | Readonly<{ kind: "not-found" }>;

async function handle(options: {
  request: IncomingMessage;
  response: ServerResponse;
  dependencies: ReportServiceDependencies;
}): Promise<void> {
  const startedAt = Date.now();
  const { request, response, dependencies } = options;

  // An aborted upload emits `error` on the request; without a listener that is an unhandled event
  // that takes the process down.
  request.on("error", () => undefined);

  const client = clientIdentityOf({
    socketAddress: request.socket.remoteAddress ?? null,
    forwardedFor: headerValue({ request, name: "x-forwarded-for" }),
    trustedProxyHops: dependencies.limits.trustedProxyHops,
    hashSecret: dependencies.limits.ipHashSecret,
  });
  const cors = corsDecisionFor({ origin: headerValue({ request, name: "origin" }), policy: dependencies.cors });
  const route = routeOf(request);

  const finish = (outcome: Readonly<{ status: number; outcome: RequestOutcome; reportId: string | null; bytes: number }>) => {
    dependencies.log.request({
      at: dependencies.now().toISOString(),
      method: request.method ?? "?",
      route: routeTemplateOf(route),
      status: outcome.status,
      outcome: outcome.outcome,
      requestBytes: outcome.bytes,
      durationMs: Date.now() - startedAt,
      client: client.logLabel,
      reportId: outcome.reportId,
    });
  };

  try {
    const served = await serve({ request, response, dependencies, route, cors, client });
    finish(served);
  } catch (caught) {
    dependencies.log.service({
      at: dependencies.now().toISOString(),
      event: "handler-threw",
      detail: caught instanceof Error ? caught.message : "unknown error",
    });
    if (!response.headersSent) {
      respond({ response, cors, status: 500, body: errorBody({ code: "internal-error", message: "internal error" }) });
    } else {
      response.end();
    }
    finish({ status: 500, outcome: "internal-error", reportId: null, bytes: 0 });
  }
}

type Served = Readonly<{ status: number; outcome: RequestOutcome; reportId: string | null; bytes: number }>;

async function serve(options: {
  request: IncomingMessage;
  response: ServerResponse;
  dependencies: ReportServiceDependencies;
  route: Route;
  cors: CorsDecision;
  client: ClientIdentity;
}): Promise<Served> {
  const { request, response, dependencies, route, cors, client } = options;

  // Liveness is exempt from both gates below: a probe carries no `Origin` and runs often enough
  // that charging it to a bucket would eventually throttle the thing watching the service.
  const gated = route.kind !== "health";

  // Refusing the write, not just hiding the answer: see the note at the top of `cors.ts`.
  if (gated && cors.kind === "denied") {
    respond({ response, cors, status: 403, body: errorBody({ code: "origin-not-allowed", message: "this origin may not call this service" }) });
    return { status: 403, outcome: "rejected-origin", reportId: null, bytes: 0 };
  }

  const throttled = gated ? throttleOf({ dependencies, clientKey: client.key }) : null;
  if (throttled !== null) {
    respond({
      response,
      cors,
      status: 429,
      body: errorBody({ code: "rate-limited", message: "too many requests; retry later" }),
      headers: { "retry-after": String(throttled.retryAfterSeconds) },
    });
    return { status: 429, outcome: "throttled", reportId: null, bytes: 0 };
  }

  switch (route.kind) {
    case "health": {
      respond({
        response,
        cors,
        status: 200,
        body: { status: "ok", at: dependencies.now().toISOString(), uptimeSeconds: Math.round(process.uptime()) },
      });
      return { status: 200, outcome: "health-ok", reportId: null, bytes: 0 };
    }
    case "preflight": {
      respondNoContent({ response, cors, headers: preflightHeaders() });
      return { status: 204, outcome: "preflight", reportId: null, bytes: 0 };
    }
    case "submit":
      return submit({ request, response, dependencies, cors });
    case "receipt": {
      const entry = dependencies.store.find(route.id);
      if (entry === null) {
        respond({ response, cors, status: 404, body: errorBody({ code: "not-found", message: "no such report" }) });
        return { status: 404, outcome: "not-found", reportId: null, bytes: 0 };
      }
      respond({ response, cors, status: 200, body: receiptOf(entry) });
      return { status: 200, outcome: "receipt-served", reportId: entry.id, bytes: 0 };
    }
    case "delete":
      return remove({ request, response, dependencies, cors, id: route.id });
    case "method-not-allowed": {
      respond({
        response,
        cors,
        status: 405,
        body: errorBody({ code: "method-not-allowed", message: "method not allowed on this route" }),
        headers: { allow: ALLOWED_METHODS },
      });
      return { status: 405, outcome: "method-not-allowed", reportId: null, bytes: 0 };
    }
    case "not-found": {
      respond({ response, cors, status: 404, body: errorBody({ code: "not-found", message: "no such route" }) });
      return { status: 404, outcome: "not-found", reportId: null, bytes: 0 };
    }
    default:
      return assertNever(route);
  }
}

async function submit(options: {
  request: IncomingMessage;
  response: ServerResponse;
  dependencies: ReportServiceDependencies;
  cors: CorsDecision;
}): Promise<Served> {
  const { request, response, dependencies, cors } = options;

  if (headerValue({ request, name: "content-encoding" }) !== null) {
    respond({
      response,
      cors,
      status: 415,
      body: errorBody({ code: "unsupported-encoding", message: "send an identity-encoded body; this service does not decompress" }),
    });
    return { status: 415, outcome: "rejected-encoding", reportId: null, bytes: 0 };
  }

  if (!isJsonContentType(headerValue({ request, name: "content-type" }))) {
    respond({
      response,
      cors,
      status: 415,
      body: errorBody({ code: "unsupported-media-type", message: "Content-Type must be application/json" }),
    });
    return { status: 415, outcome: "rejected-content-type", reportId: null, bytes: 0 };
  }

  const declaredLength = Number(headerValue({ request, name: "content-length" }) ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > dependencies.limits.maxBodyBytes) {
    respond({ response, cors, status: 413, body: tooLargeBody(dependencies.limits.maxBodyBytes), headers: CLOSE_CONNECTION });
    return { status: 413, outcome: "rejected-too-large", reportId: null, bytes: declaredLength };
  }

  const body = await readBody({ request, maxBytes: dependencies.limits.maxBodyBytes });
  switch (body.kind) {
    case "too-large":
      respond({ response, cors, status: 413, body: tooLargeBody(dependencies.limits.maxBodyBytes), headers: CLOSE_CONNECTION });
      return { status: 413, outcome: "rejected-too-large", reportId: null, bytes: body.bytes };
    case "aborted":
      return { status: 499, outcome: "client-aborted", reportId: null, bytes: body.bytes };
    case "not-utf8":
      respond({
        response,
        cors,
        status: 400,
        body: errorBody({ code: "malformed-body", message: "body is not valid UTF-8" }),
      });
      return { status: 400, outcome: "rejected-schema", reportId: null, bytes: body.bytes };
    case "ok":
      break;
    default:
      return assertNever(body);
  }

  const parsed = parseDefectReport({ body: body.text });
  if (parsed.kind === "rejected") {
    const status = statusForRejection(parsed.rejection.code);
    respond({ response, cors, status, body: rejectionBody(parsed.rejection) });
    return {
      status,
      outcome: status === 413 ? "rejected-too-large" : "rejected-schema",
      reportId: null,
      bytes: body.bytes,
    };
  }

  const stored = await dependencies.store.submit({ report: parsed.report, receivedAt: dependencies.now() });
  switch (stored.kind) {
    case "stored":
      respond({
        response,
        cors,
        status: 201,
        body: {
          id: stored.entry.id,
          deletionToken: stored.deletionToken,
          receivedAt: stored.entry.receivedAt,
          storedBytes: stored.entry.storedBytes,
          duplicate: false,
        },
      });
      return { status: 201, outcome: "accepted", reportId: stored.entry.id, bytes: body.bytes };
    case "duplicate":
      // Byte-identical to something already held, so nothing is written. No deletion token comes
      // back: this service does not hold the original's token and will not mint a second one.
      respond({
        response,
        cors,
        status: 200,
        body: {
          id: stored.entry.id,
          deletionToken: null,
          receivedAt: stored.entry.receivedAt,
          storedBytes: stored.entry.storedBytes,
          duplicate: true,
        },
      });
      return { status: 200, outcome: "duplicate", reportId: stored.entry.id, bytes: body.bytes };
    case "capacity-exhausted":
      respond({
        response,
        cors,
        status: 503,
        body: errorBody({ code: "storage-full", message: describeCapacityLimit(stored.limit) }),
        headers: { "retry-after": "3600" },
      });
      return { status: 503, outcome: "storage-full", reportId: null, bytes: body.bytes };
    case "write-failed":
      dependencies.log.service({ at: dependencies.now().toISOString(), event: "store-write-failed", detail: stored.detail });
      respond({ response, cors, status: 500, body: errorBody({ code: "internal-error", message: "could not store the report" }) });
      return { status: 500, outcome: "internal-error", reportId: null, bytes: body.bytes };
    default:
      return assertNever(stored);
  }
}

async function remove(options: {
  request: IncomingMessage;
  response: ServerResponse;
  dependencies: ReportServiceDependencies;
  cors: CorsDecision;
  id: ReportId;
}): Promise<Served> {
  const { request, response, dependencies, cors, id } = options;
  const supplied = headerValue({ request, name: "x-deletion-token" });
  const token = supplied === null ? null : parseDeletionToken(supplied);
  if (token === null) {
    respond({
      response,
      cors,
      status: 401,
      body: errorBody({ code: "deletion-token-required", message: "supply the deletion token from your receipt in the X-Deletion-Token header" }),
    });
    return { status: 401, outcome: "forbidden", reportId: id, bytes: 0 };
  }

  const removed = await dependencies.store.remove({ id, deletionToken: token });
  switch (removed.kind) {
    case "removed":
      respond({ response, cors, status: 200, body: { id, deleted: true } });
      return { status: 200, outcome: "deleted", reportId: id, bytes: 0 };
    case "not-found":
      respond({ response, cors, status: 404, body: errorBody({ code: "not-found", message: "no such report" }) });
      return { status: 404, outcome: "not-found", reportId: null, bytes: 0 };
    case "token-mismatch":
      respond({ response, cors, status: 403, body: errorBody({ code: "deletion-token-invalid", message: "that deletion token does not match this report" }) });
      return { status: 403, outcome: "forbidden", reportId: id, bytes: 0 };
    case "remove-failed":
      dependencies.log.service({ at: dependencies.now().toISOString(), event: "store-remove-failed", detail: removed.detail });
      respond({ response, cors, status: 500, body: errorBody({ code: "internal-error", message: "could not delete the report" }) });
      return { status: 500, outcome: "internal-error", reportId: id, bytes: 0 };
    default:
      return assertNever(removed);
  }
}

/**
 * The path is matched against a fixed shape and the id segment must satisfy `parseReportId`, whose
 * alphabet has no `.` and no `/`. There is therefore nothing to sanitise: a traversal attempt
 * cannot produce a `ReportId`, and the store accepts nothing else.
 */
function routeOf(request: IncomingMessage): Route {
  const method = request.method ?? "GET";
  const path = pathOf(request.url ?? "/");

  if (path === "/healthz") return method === "GET" || method === "HEAD" ? { kind: "health" } : { kind: "method-not-allowed" };
  if (method === "OPTIONS") return { kind: "preflight" };

  if (path === "/v1/reports") return method === "POST" ? { kind: "submit" } : { kind: "method-not-allowed" };

  const idSegment = /^\/v1\/reports\/([^/]+)$/.exec(path)?.[1];
  if (idSegment === undefined) return { kind: "not-found" };
  const id = parseReportId(decodeOrEmpty(idSegment));
  if (id === null) return { kind: "not-found" };
  if (method === "GET") return { kind: "receipt", id };
  if (method === "DELETE") return { kind: "delete", id };
  return { kind: "method-not-allowed" };
}

/** Route TEMPLATES for the log, so an unmatched attacker-chosen path is never written anywhere. */
function routeTemplateOf(route: Route): string {
  switch (route.kind) {
    case "health":
      return "/healthz";
    case "submit":
      return "POST /v1/reports";
    case "receipt":
      return "GET /v1/reports/:id";
    case "delete":
      return "DELETE /v1/reports/:id";
    case "preflight":
      return "OPTIONS";
    case "method-not-allowed":
      return "<method-not-allowed>";
    case "not-found":
      return "<unmatched>";
    default:
      return assertNever(route);
  }
}

function pathOf(target: string): string {
  const queryAt = target.indexOf("?");
  const withoutQuery = queryAt === -1 ? target : target.slice(0, queryAt);
  const hashAt = withoutQuery.indexOf("#");
  return hashAt === -1 ? withoutQuery : withoutQuery.slice(0, hashAt);
}

function decodeOrEmpty(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

/**
 * Sent with a 413. The rest of the oversized body is still in flight and this service is not going
 * to read it, so the socket has to go rather than be reused with unread bytes on it. Destroying the
 * request instead would race the response's own flush and the client would see a connection reset
 * where a status code belongs.
 */
const CLOSE_CONNECTION: Readonly<Record<string, string>> = { connection: "close" };

type BodyRead =
  | Readonly<{ kind: "ok"; text: string; bytes: number }>
  | Readonly<{ kind: "too-large"; bytes: number }>
  | Readonly<{ kind: "aborted"; bytes: number }>
  | Readonly<{ kind: "not-utf8"; bytes: number }>;

/**
 * Counts bytes as they arrive and stops at the cap. `Content-Length` was checked first, but it is
 * a claim: a chunked body carries none, and a lying one is trivial to send, so the running count is
 * the limit that actually holds. Decoding is strict UTF-8 -- invalid bytes are a refusal, not a
 * string full of replacement characters that then gets stored.
 */
async function readBody(options: { request: IncomingMessage; maxBytes: number }): Promise<BodyRead> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of options.request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      bytes += buffer.byteLength;
      if (bytes > options.maxBytes) return { kind: "too-large", bytes };
      chunks.push(buffer);
    }
  } catch {
    return { kind: "aborted", bytes };
  }
  try {
    return { kind: "ok", text: decoder.decode(Buffer.concat(chunks)), bytes };
  } catch {
    return { kind: "not-utf8", bytes };
  }
}

/** `application/json`, optionally with parameters. Anything else, including `*\/*`, is a 415. */
function isJsonContentType(header: string | null): boolean {
  if (header === null) return false;
  const mediaType = header.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json";
}

function throttleOf(options: {
  dependencies: ReportServiceDependencies;
  clientKey: string;
}): Readonly<{ retryAfterSeconds: number }> | null {
  const now = options.dependencies.now().getTime();
  const burst = options.dependencies.burstLimiter.take({ clientKey: options.clientKey, now });
  if (burst.kind === "throttled") return { retryAfterSeconds: burst.retryAfterSeconds };
  const sustained = options.dependencies.sustainedLimiter.take({ clientKey: options.clientKey, now });
  if (sustained.kind === "throttled") return { retryAfterSeconds: sustained.retryAfterSeconds };
  return null;
}

/** A size problem is a 413 even when it is one field rather than the whole body. */
function statusForRejection(code: ReportRejectionCode): number {
  switch (code) {
    case "field-too-large":
      return 413;
    case "malformed-json":
    case "not-an-object":
      return 400;
    case "unknown-field":
    case "missing-field":
    case "wrong-type":
    case "bad-value":
    case "unsupported-schema-version":
      return 422;
    default:
      return assertNever(code);
  }
}

function describeCapacityLimit(limit: CapacityLimit): string {
  switch (limit) {
    case "report-count":
      return "the service is holding its maximum number of reports; try again later";
    case "total-bytes":
      return "the service is at its storage budget; try again later";
    default:
      return assertNever(limit);
  }
}

function rejectionBody(rejection: ReportRejection): unknown {
  return {
    error: {
      code: rejection.code,
      message: rejection.detail,
      schemaVersion: DEFECT_REPORT_SCHEMA_VERSION,
      limits: REPORT_LIMITS,
    },
  };
}

function tooLargeBody(maxBodyBytes: number): unknown {
  return errorBody({ code: "body-too-large", message: `the request body must be at most ${String(maxBodyBytes)} bytes` });
}

function errorBody(options: Readonly<{ code: string; message: string }>): unknown {
  return { error: { code: options.code, message: options.message } };
}

function respond(options: {
  response: ServerResponse;
  cors: CorsDecision;
  status: number;
  body: unknown;
  headers?: Readonly<Record<string, string>>;
}): void {
  const payload = Buffer.from(`${JSON.stringify(options.body)}\n`, "utf8");
  options.response.writeHead(options.status, {
    ...securityHeaders(),
    ...corsHeaders(options.cors),
    ...(options.headers ?? {}),
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
  });
  options.response.end(payload);
}

function respondNoContent(options: {
  response: ServerResponse;
  cors: CorsDecision;
  headers: Readonly<Record<string, string>>;
}): void {
  options.response.writeHead(204, { ...securityHeaders(), ...corsHeaders(options.cors), ...options.headers });
  options.response.end();
}

/**
 * On every response, including errors. `default-src 'none'; sandbox` means that even if a browser
 * were somehow persuaded to treat a response here as a document, it would have no scripting, no
 * origin and no ability to load anything.
 */
function securityHeaders(): Readonly<Record<string, string>> {
  return {
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; sandbox",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    vary: "Origin",
  };
}

function corsHeaders(cors: CorsDecision): Readonly<Record<string, string>> {
  switch (cors.kind) {
    case "allowed":
      // Note the absence of `access-control-allow-credentials`. See `cors.ts`.
      return { "access-control-allow-origin": cors.origin };
    case "no-origin":
    case "denied":
      return {};
    default:
      return assertNever(cors);
  }
}

function preflightHeaders(): Readonly<Record<string, string>> {
  return {
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-allow-headers": ALLOWED_REQUEST_HEADERS,
    "access-control-max-age": "600",
  };
}

function headerValue(options: Readonly<{ request: IncomingMessage; name: string }>): string | null {
  const raw = options.request.headers[options.name];
  if (typeof raw === "string") return raw;
  // Node collapses repeated headers into an array only for a few names; the first is the one a
  // proxy prepended, and for `x-forwarded-for` the join is what the hop arithmetic expects.
  if (Array.isArray(raw)) return raw.join(", ");
  return null;
}
