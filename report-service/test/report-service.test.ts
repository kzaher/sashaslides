// Tests over the real service: a real listening socket, a real filesystem store, the real rate
// limiter. Nothing in this file substitutes a part of the service for a fake of it. The three
// things that ARE injected -- the clock, the entropy source and the log sink -- are injected
// because the production composition root injects them too, not for the tests' benefit.
//
// Requests go out over `node:http` rather than `fetch`, so that the suite can set headers `fetch`
// treats as forbidden (`Origin`), send a body with no `Content-Length` (to exercise the streaming
// byte counter rather than the declared-length pre-check), and read raw response headers.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { corsDecisionFor } from "../src/cors.ts";
import { REPORT_LIMITS } from "../src/defect-report.ts";
import { startReportService, type RunningReportService } from "../src/report-service.ts";
import { parseServiceConfig, type ServiceConfig } from "../src/service-config.ts";
import { silentRequestLog } from "../src/request-log.ts";

const SANDBOX_ORIGIN = "https://n-abc123def-0lu-script.googleusercontent.com";

test("a valid report round-trips: 201, a quotable id, a receipt, and the HTML on disk", async () => {
  await using service = await startedService({});
  const html = '<!doctype html><p data-marker="ROUNDTRIP-MARKER">hello</p>';

  const submitted = await call({
    service,
    method: "POST",
    path: "/v1/reports",
    headers: { "content-type": "application/json", origin: SANDBOX_ORIGIN },
    body: JSON.stringify(validReport({ html })),
  });

  assert.equal(submitted.status, 201);
  const accepted = jsonOf(submitted.body);
  assert.match(stringField(accepted, "id"), /^rep_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.match(stringField(accepted, "deletionToken"), /^del_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.equal(accepted["duplicate"], false);

  const receipt = await call({ service, method: "GET", path: `/v1/reports/${stringField(accepted, "id")}` });
  assert.equal(receipt.status, 200);
  const body = jsonOf(receipt.body);
  assert.equal(body["id"], accepted["id"]);
  assert.equal(body["htmlBytes"], Buffer.byteLength(html, "utf8"));
  assert.deepEqual(body["versions"], { addon: "1.4.0", converter: "2026.10.04", protocol: 1 });

  // The report really is on the disk, byte for byte, in its own file.
  const stored = jsonOf(await readFile(reportFileFor({ service, id: stringField(accepted, "id") }), "utf8"));
  const report = stored["report"];
  assert.ok(report !== null && typeof report === "object");
  assert.equal((report as Record<string, unknown>)["document"] instanceof Object, true);
  assert.equal(JSON.stringify(report).includes("ROUNDTRIP-MARKER"), true);
});

test("the receipt is metadata only and the submitted HTML is never echoed back", async () => {
  await using service = await startedService({});
  const marker = "XSS-PROBE-9f3a";
  const html = `<!doctype html><script>alert("${marker}")</script><img src=x onerror=alert(1)>`;

  const submitted = await call({
    service,
    method: "POST",
    path: "/v1/reports",
    headers: { "content-type": "application/json", origin: SANDBOX_ORIGIN },
    body: JSON.stringify(validReport({ html, note: `see ${marker}` })),
  });
  assert.equal(submitted.status, 201);
  const id = stringField(jsonOf(submitted.body), "id");

  const receipt = await call({ service, method: "GET", path: `/v1/reports/${id}` });
  assert.equal(receipt.status, 200);

  // Nothing the submitter wrote comes back out: not the HTML, not the note, not the marker.
  assert.equal(receipt.body.includes(marker), false);
  assert.equal(receipt.body.includes("<script"), false);
  assert.equal(receipt.body.includes("onerror"), false);

  // And nothing a browser would treat as a document, on any response.
  for (const response of [submitted, receipt]) {
    assert.equal(header(response, "content-type"), "application/json; charset=utf-8");
    assert.equal(header(response, "x-content-type-options"), "nosniff");
    assert.equal(header(response, "content-security-policy"), "default-src 'none'; frame-ancestors 'none'; sandbox");
    assert.equal(header(response, "referrer-policy"), "no-referrer");
  }

  // An unmatched path is attacker-controlled text, so it is not reflected either.
  const reflected = await call({ service, method: "GET", path: `/${encodeURIComponent(`<script>${marker}</script>`)}` });
  assert.equal(reflected.status, 404);
  assert.equal(reflected.body.includes(marker), false);
  assert.equal(reflected.body.includes("<script"), false);
});

test("an oversized field is rejected, and so is an oversized body with no Content-Length", async () => {
  await using service = await startedService({});

  const overTheFieldCap = await call({
    service,
    method: "POST",
    path: "/v1/reports",
    headers: { "content-type": "application/json", origin: SANDBOX_ORIGIN },
    body: JSON.stringify(validReport({ html: "h".repeat(REPORT_LIMITS.htmlBytes + 1) })),
  });
  assert.equal(overTheFieldCap.status, 413);
  assert.equal(errorCodeOf(overTheFieldCap.body), "field-too-large");

  // Declared length over the cap: refused before a single body byte is read.
  const overTheBodyCap = await call({
    service,
    method: "POST",
    path: "/v1/reports",
    headers: { "content-type": "application/json", origin: SANDBOX_ORIGIN },
    body: `{"filler":"${"x".repeat(REPORT_LIMITS.bodyBytes + 64)}"}`,
  });
  assert.equal(overTheBodyCap.status, 413);
  assert.equal(errorCodeOf(overTheBodyCap.body), "body-too-large");

  // Chunked, so there is no Content-Length to pre-check: the running byte counter has to catch it.
  const chunkedPastTheCap = await call({
    service,
    method: "POST",
    path: "/v1/reports",
    headers: { "content-type": "application/json", origin: SANDBOX_ORIGIN },
    body: `{"filler":"${"x".repeat(REPORT_LIMITS.bodyBytes + 64)}"}`,
    chunked: true,
  });
  assert.equal(chunkedPastTheCap.status, 413);
  assert.equal(errorCodeOf(chunkedPastTheCap.body), "body-too-large");
});

test("unknown fields are rejected, at the top level and nested", async () => {
  await using service = await startedService({});

  const extraTopLevel = { ...validReport({}), presentationId: "1xegFC0RQiZd" };
  const topLevel = await submitJson({ service, payload: extraTopLevel });
  assert.equal(topLevel.status, 422);
  assert.equal(errorCodeOf(topLevel.body), "unknown-field");
  assert.match(topLevel.body, /presentationId/);

  const nested = await submitJson({
    service,
    payload: { ...validReport({}), versions: { addon: "1.4.0", converter: "2026.10.04", protocol: 1, userEmail: "a@b.c" } },
  });
  assert.equal(nested.status, 422);
  assert.equal(errorCodeOf(nested.body), "unknown-field");

  // A field name that is not a plain identifier is scrubbed rather than reflected.
  const hostile = await submitJson({ service, payload: { ...validReport({}), '<img src=x onerror="1">': 1 } });
  assert.equal(hostile.status, 422);
  assert.equal(hostile.body.includes("onerror"), false);
  assert.match(hostile.body, /<unprintable>/);
});

test("malformed JSON, wrong types and a wrong schema version are each refused distinctly", async () => {
  await using service = await startedService({});

  const malformed = await call({
    service,
    method: "POST",
    path: "/v1/reports",
    headers: { "content-type": "application/json", origin: SANDBOX_ORIGIN },
    body: '{"schemaVersion":1,',
  });
  assert.equal(malformed.status, 400);
  assert.equal(errorCodeOf(malformed.body), "malformed-json");

  const notAnObject = await call({
    service,
    method: "POST",
    path: "/v1/reports",
    headers: { "content-type": "application/json", origin: SANDBOX_ORIGIN },
    body: "[1,2,3]",
  });
  assert.equal(notAnObject.status, 400);
  assert.equal(errorCodeOf(notAnObject.body), "not-an-object");

  const wrongType = await submitJson({ service, payload: { ...validReport({}), note: 42 } });
  assert.equal(wrongType.status, 422);
  assert.equal(errorCodeOf(wrongType.body), "wrong-type");

  const missing = await submitJson({ service, payload: { schemaVersion: 1, note: "x" } });
  assert.equal(missing.status, 422);
  assert.equal(errorCodeOf(missing.body), "missing-field");

  const futureSchema = await submitJson({ service, payload: { ...validReport({}), schemaVersion: 2 } });
  assert.equal(futureSchema.status, 422);
  assert.equal(errorCodeOf(futureSchema.body), "unsupported-schema-version");

  const badInstant = await submitJson({ service, payload: { ...validReport({}), clientReportedAt: "yesterday" } });
  assert.equal(badInstant.status, 422);
  assert.equal(errorCodeOf(badInstant.body), "bad-value");

  const wrongContentType = await call({
    service,
    method: "POST",
    path: "/v1/reports",
    headers: { "content-type": "text/plain", origin: SANDBOX_ORIGIN },
    body: JSON.stringify(validReport({})),
  });
  assert.equal(wrongContentType.status, 415);
  assert.equal(errorCodeOf(wrongContentType.body), "unsupported-media-type");

  const compressed = await call({
    service,
    method: "POST",
    path: "/v1/reports",
    headers: { "content-type": "application/json", "content-encoding": "gzip", origin: SANDBOX_ORIGIN },
    body: JSON.stringify(validReport({})),
  });
  assert.equal(compressed.status, 415);
  assert.equal(errorCodeOf(compressed.body), "unsupported-encoding");
});

test("the rate limiter trips, says when to retry, and leaves /healthz alone", async () => {
  await using service = await startedService({ env: { REPORT_RATE_BURST: "3", REPORT_RATE_BURST_REFILL_PER_SECOND: "0.001" } });

  const statuses: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await submitJson({ service, payload: validReport({ html: `<p>${String(attempt)}</p>` }) });
    statuses.push(response.status);
    if (response.status !== 429) continue;
    assert.equal(errorCodeOf(response.body), "rate-limited");
    assert.match(header(response, "retry-after") ?? "", /^\d+$/);
  }

  assert.equal(statuses.filter((status) => status === 201).length, 3);
  assert.equal(statuses.filter((status) => status === 429).length, 3);

  // Liveness must keep answering while a client is being throttled, or the probe takes the service
  // out of rotation for somebody else's abuse.
  const health = await call({ service, method: "GET", path: "/healthz" });
  assert.equal(health.status, 200);
  assert.equal(jsonOf(health.body)["status"], "ok");
});

test("concurrent submissions do not corrupt the index", async () => {
  await using service = await startedService({ env: { REPORT_RATE_BURST: "500", REPORT_RATE_SUSTAINED: "500" } });

  const submissions = Array.from({ length: 40 }, (_unused, index) =>
    submitJson({ service, payload: validReport({ html: `<p>slide ${String(index)}</p>` }) }),
  );
  const responses = await Promise.all(submissions);
  assert.equal(responses.every((response) => response.status === 201), true);

  const ids = responses.map((response) => stringField(jsonOf(response.body), "id"));
  assert.equal(new Set(ids).size, 40);

  // Every line of the index parses, and the set it replays to is exactly what was accepted.
  const indexLines = (await readFile(join(service.dataDir, "index.jsonl"), "utf8")).split("\n").filter((line) => line !== "");
  assert.equal(indexLines.length, 40);
  const indexedIds = indexLines.map((line) => {
    const record = jsonOf(line);
    assert.equal(record["kind"], "stored");
    const entry = record["entry"];
    assert.ok(entry !== null && typeof entry === "object");
    return String((entry as Record<string, unknown>)["id"]);
  });
  assert.deepEqual([...indexedIds].sort(), [...ids].sort());

  // And every indexed report has its file.
  for (const id of ids) {
    const info = await stat(reportFileFor({ service, id }));
    assert.equal(info.isFile(), true);
  }

  // The accounting the disk cap depends on survives a restart: a second store over the same
  // directory replays the same count.
  assert.equal(service.store.stats().reportCount, 40);
  assert.equal(service.store.stats().unreadableIndexLines, 0);
  await using reopened = await startedService({ env: { REPORT_DATA_DIR: service.dataDir }, keepDataDir: true });
  assert.equal(reopened.store.stats().reportCount, 40);
  assert.equal(reopened.store.stats().totalBytes, service.store.stats().totalBytes);
});

test("an identical resubmission is collapsed instead of filling the disk", async () => {
  await using service = await startedService({});
  const payload = validReport({ html: "<p>identical</p>" });

  const first = await submitJson({ service, payload });
  const second = await submitJson({ service, payload });

  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(jsonOf(second.body)["duplicate"], true);
  assert.equal(jsonOf(second.body)["id"], jsonOf(first.body)["id"]);
  // No token is minted for a resubmission; the original's is the only one that exists.
  assert.equal(jsonOf(second.body)["deletionToken"], null);
  assert.equal(service.store.stats().reportCount, 1);
});

test("the storage budget refuses new reports rather than filling the volume", async () => {
  await using service = await startedService({ env: { REPORT_MAX_REPORTS: "2", REPORT_RATE_BURST: "50" } });

  for (let index = 0; index < 2; index += 1) {
    const accepted = await submitJson({ service, payload: validReport({ html: `<p>${String(index)}</p>` }) });
    assert.equal(accepted.status, 201);
  }
  const refused = await submitJson({ service, payload: validReport({ html: "<p>one too many</p>" }) });
  assert.equal(refused.status, 503);
  assert.equal(errorCodeOf(refused.body), "storage-full");
  assert.equal(header(refused, "retry-after"), "3600");

  const byteBudget = await startedService({ env: { REPORT_MAX_TOTAL_BYTES: "2048", REPORT_RATE_BURST: "50" } });
  try {
    const tooBig = await submitJson({ service: byteBudget, payload: validReport({ html: "<p>".repeat(1000) }) });
    assert.equal(tooBig.status, 503);
    assert.equal(errorCodeOf(tooBig.body), "storage-full");
  } finally {
    await byteBudget[Symbol.asyncDispose]();
  }
});

test("a submitter can delete their own report with the token, and nobody else can", async () => {
  await using service = await startedService({ env: { REPORT_RATE_BURST: "50" } });
  const submitted = await submitJson({ service, payload: validReport({ html: "<p>delete me</p>" }) });
  const accepted = jsonOf(submitted.body);
  const id = stringField(accepted, "id");
  const token = stringField(accepted, "deletionToken");

  const withoutToken = await call({ service, method: "DELETE", path: `/v1/reports/${id}`, headers: { origin: SANDBOX_ORIGIN } });
  assert.equal(withoutToken.status, 401);

  // Well-formed but wrong: a malformed token is a 401 (no credential), a wrong one a 403.
  const wrongToken = await call({
    service,
    method: "DELETE",
    path: `/v1/reports/${id}`,
    headers: { origin: SANDBOX_ORIGIN, "x-deletion-token": `del_${"0".repeat(26)}` },
  });
  assert.equal(wrongToken.status, 403);

  const deleted = await call({
    service,
    method: "DELETE",
    path: `/v1/reports/${id}`,
    headers: { origin: SANDBOX_ORIGIN, "x-deletion-token": token },
  });
  assert.equal(deleted.status, 200);

  const gone = await call({ service, method: "GET", path: `/v1/reports/${id}` });
  assert.equal(gone.status, 404);
  await assert.rejects(stat(reportFileFor({ service, id })));
  assert.equal(service.store.stats().reportCount, 0);
});

test("an id that is not an id is a 404, so a path cannot escape the data directory", async () => {
  await using service = await startedService({ env: { REPORT_RATE_BURST: "50" } });
  for (const segment of ["..%2f..%2fetc%2fpasswd", "rep_short", "index.jsonl", "rep_IIIIIIIIIIIIIIIIIIIIIIIIII", "%2e%2e"]) {
    const response = await call({ service, method: "GET", path: `/v1/reports/${segment}` });
    assert.equal(response.status, 404, `expected 404 for ${segment}`);
  }
});

test("cross-origin access is granted to the Apps Script sandbox and to nobody else", async () => {
  await using service = await startedService({ env: { REPORT_RATE_BURST: "50" } });

  const preflight = await call({
    service,
    method: "OPTIONS",
    path: "/v1/reports",
    headers: { origin: SANDBOX_ORIGIN, "access-control-request-method": "POST" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(header(preflight, "access-control-allow-origin"), SANDBOX_ORIGIN);
  assert.equal(header(preflight, "vary"), "Origin");
  // Reflecting an origin AND allowing credentials is how a CORS policy becomes a CSRF hole.
  assert.equal(header(preflight, "access-control-allow-credentials"), null);

  const hostile = await call({
    service,
    method: "POST",
    path: "/v1/reports",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify(validReport({})),
  });
  assert.equal(hostile.status, 403);
  assert.equal(errorCodeOf(hostile.body), "origin-not-allowed");
  assert.equal(header(hostile, "access-control-allow-origin"), null);
  // The point of 403 rather than a silently unreadable 201: the write must not happen either.
  assert.equal(service.store.stats().reportCount, 0);

  // No Origin at all is allowed through: the header is absent exactly when it cannot be relied on.
  const serverSide = await call({
    service,
    method: "POST",
    path: "/v1/reports",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(validReport({})),
  });
  assert.equal(serverSide.status, 201);
  assert.equal(header(serverSide, "access-control-allow-origin"), null);
});

test("the origin policy rejects the spellings that would otherwise sneak past a suffix match", () => {
  const policy = { allowedHostPatterns: ["*-script.googleusercontent.com"], allowedOrigins: ["http://localhost:5173"] };
  const verdicts = [
    { origin: SANDBOX_ORIGIN, expected: "allowed" },
    { origin: "https://n-x-9lu-script.googleusercontent.com", expected: "allowed" },
    { origin: "http://localhost:5173", expected: "allowed" },
    { origin: "http://n-abc-0lu-script.googleusercontent.com", expected: "denied" },
    { origin: "https://lh3.googleusercontent.com", expected: "denied" },
    { origin: "https://evil-script.googleusercontent.com.evil.example", expected: "denied" },
    { origin: "https://a.b-script.googleusercontent.com", expected: "denied" },
    { origin: "https://googleusercontent.com", expected: "denied" },
    { origin: "https://n-abc-0lu-script.googleusercontent.com:8443", expected: "denied" },
    { origin: "https://n-abc-0lu-script.googleusercontent.com/", expected: "denied" },
    { origin: "https://user@n-abc-0lu-script.googleusercontent.com", expected: "denied" },
    { origin: "null", expected: "denied" },
  ] as const;
  for (const verdict of verdicts) {
    assert.equal(corsDecisionFor({ origin: verdict.origin, policy }).kind, verdict.expected, verdict.origin);
  }
  assert.equal(corsDecisionFor({ origin: null, policy }).kind, "no-origin");
});

test("a wrong method is a 405 with Allow, and an unknown route is a 404", async () => {
  await using service = await startedService({ env: { REPORT_RATE_BURST: "50" } });
  const wrongMethod = await call({ service, method: "PUT", path: "/v1/reports", headers: { origin: SANDBOX_ORIGIN } });
  assert.equal(wrongMethod.status, 405);
  assert.equal(header(wrongMethod, "allow"), "GET, POST, DELETE, OPTIONS");
  const unknown = await call({ service, method: "GET", path: "/v2/reports", headers: { origin: SANDBOX_ORIGIN } });
  assert.equal(unknown.status, 404);
});

test("the request log records magnitudes and outcomes, and no payload", async () => {
  const lines: string[] = [];
  await using service = await startedService({ captureLog: lines });
  const marker = "LOG-LEAK-PROBE-7c1";
  await submitJson({ service, payload: validReport({ html: `<p>${marker}</p>`, note: marker }) });

  const requestLines = lines.map((line) => jsonOf(line)).filter((record) => record["kind"] === "request");
  assert.equal(requestLines.length, 1);
  const logged = requestLines[0];
  assert.ok(logged !== undefined);
  assert.equal(logged["route"], "POST /v1/reports");
  assert.equal(logged["status"], 201);
  assert.equal(logged["outcome"], "accepted");
  assert.equal(typeof logged["requestBytes"], "number");
  assert.match(String(logged["client"]), /^ip:[0-9a-f]{12}$/);
  assert.equal(lines.some((line) => line.includes(marker)), false);
});

test("configuration is validated at startup rather than quietly falling back", () => {
  const good = parseServiceConfig({ env: { REPORT_PORT: "9000" }, defaultIpHashSecret: "0".repeat(32) });
  assert.equal(good.kind, "ok");
  assert.equal(good.kind === "ok" ? good.config.port : -1, 9000);
  assert.equal(good.kind === "ok" ? good.config.cors.allowedHostPatterns[0] : "", "*-script.googleusercontent.com");

  for (const env of [{ REPORT_MAX_TOTAL_BYTES: "1e99" }, { REPORT_PORT: "-1" }, { REPORT_RETENTION_DAYS: "nope" }]) {
    const parsed = parseServiceConfig({ env, defaultIpHashSecret: "0".repeat(32) });
    assert.equal(parsed.kind, "invalid", JSON.stringify(env));
  }
  const weakSecret = parseServiceConfig({ env: { REPORT_IP_HASH_SECRET: "short" }, defaultIpHashSecret: "0".repeat(32) });
  assert.equal(weakSecret.kind, "invalid");
});

test("shutdown is graceful and idempotent", async () => {
  const service = await startedService({});
  const health = await call({ service, method: "GET", path: "/healthz" });
  assert.equal(health.status, 200);

  await service.stop();
  await service.stop();

  await assert.rejects(call({ service, method: "GET", path: "/healthz" }));
  await service[Symbol.asyncDispose]();
});

type TestService = RunningReportService & {
  dataDir: string;
  [Symbol.asyncDispose]: () => Promise<void>;
};

/**
 * One real service in its own temporary directory. The returned value is an async disposable, so
 * `await using` shuts the server down and removes the directory on every exit from the test --
 * including a failing assertion, which is the path a hand-written teardown always misses.
 */
async function startedService(
  options: Readonly<{
    env?: Readonly<Record<string, string>>;
    /** When given, request log lines land here instead of being discarded. */
    captureLog?: string[];
    /** For the restart test, which reopens the same directory a previous service wrote. */
    keepDataDir?: boolean;
  }>,
): Promise<TestService> {
  const env = options.env ?? {};
  const captureLog = options.captureLog;
  const dataDir = env["REPORT_DATA_DIR"] ?? (await mkdtemp(join(tmpdir(), "report-service-test-")));
  const parsed = parseServiceConfig({
    env: { REPORT_PORT: "0", REPORT_DATA_DIR: dataDir, REPORT_SWEEP_INTERVAL_SECONDS: "86400", ...env },
    defaultIpHashSecret: randomBytes(32).toString("hex"),
  });
  assert.equal(parsed.kind, "ok", parsed.kind === "invalid" ? parsed.problems.join("; ") : "");
  const config: ServiceConfig = parsed.kind === "ok" ? parsed.config : unreachable();

  const service = await startReportService({
    config,
    log:
      captureLog === undefined
        ? silentRequestLog()
        : { request: (record) => captureLog.push(JSON.stringify({ kind: "request", ...record })), service: () => undefined },
    now: () => new Date(),
    randomBytes: (size) => randomBytes(size),
  });

  return {
    ...service,
    dataDir,
    [Symbol.asyncDispose]: async () => {
      await service.stop();
      if (options.keepDataDir === true) return;
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function unreachable(): never {
  throw new Error("configuration was asserted valid immediately above");
}

type Response = Readonly<{ status: number; headers: Readonly<Record<string, string | string[] | undefined>>; body: string }>;

async function call(options: {
  service: Readonly<{ url: string }>;
  method: string;
  path: string;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  /** Sends the body in chunks with no `Content-Length`, which is what a real streaming client does. */
  chunked?: boolean;
}): Promise<Response> {
  const target = new URL(options.path, options.service.url);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method,
        headers: options.headers ?? {},
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        incoming.on("error", reject);
      },
    );
    outgoing.on("error", reject);
    if (options.body === undefined) {
      outgoing.end();
      return;
    }
    if (options.chunked !== true) {
      outgoing.end(options.body);
      return;
    }
    outgoing.setHeader("transfer-encoding", "chunked");
    const size = 64 * 1024;
    for (let offset = 0; offset < options.body.length; offset += size) {
      // The server may answer and close before the whole body is sent; that is the point of the
      // test, so a write failure after the response arrived is not an error here.
      if (outgoing.destroyed || outgoing.writableEnded) break;
      outgoing.write(options.body.slice(offset, offset + size));
    }
    if (!outgoing.destroyed && !outgoing.writableEnded) outgoing.end();
  });
}

async function submitJson(options: { service: Readonly<{ url: string }>; payload: unknown }): Promise<Response> {
  return call({
    service: options.service,
    method: "POST",
    path: "/v1/reports",
    headers: { "content-type": "application/json", origin: SANDBOX_ORIGIN },
    body: JSON.stringify(options.payload),
  });
}

function validReport(overrides: Readonly<{ html?: string; note?: string }>): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    note: overrides.note ?? "the table lost its gridlines",
    document: { html: overrides.html ?? "<!doctype html><p>a slide</p>" },
    converterOutput: { format: "slides-api-requests-json", text: '[{"createShape":{"objectId":"g1"}}]' },
    versions: { addon: "1.4.0", converter: "2026.10.04", protocol: 1 },
    clientReportedAt: "2026-10-04T12:00:00.000Z",
  };
}

function reportFileFor(options: Readonly<{ service: Readonly<{ dataDir: string }>; id: string }>): string {
  return join(options.service.dataDir, "reports", options.id.slice(4, 6), `${options.id}.json`);
}

function jsonOf(body: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(body);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), `not a JSON object: ${body.slice(0, 120)}`);
  return parsed as Readonly<Record<string, unknown>>;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key];
  assert.equal(typeof value, "string", `${key} is not a string`);
  return String(value);
}

function errorCodeOf(body: string): string {
  const error = jsonOf(body)["error"];
  assert.ok(error !== null && typeof error === "object");
  return String((error as Record<string, unknown>)["code"]);
}

function header(response: Response, name: string): string | null {
  const value = response.headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  return null;
}
