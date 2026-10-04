// Same order as report-endpoint.ts: the body, the endpoint check, the call, the reply reading.

import test from "node:test";
import assert from "node:assert/strict";
import type { DefectReport } from "./anonymise/index.ts";
import {
  CONVERTER_OUTPUT_FORMAT,
  REPORT_SCHEMA_VERSION,
  browserHttpPost,
  endpointProblem,
  fetchReportSubmitter,
  reportRequestBodyOf,
  serializeReportRequest,
  submissionOf,
  utf8Length,
  type HttpAnswer,
} from "./report-endpoint.ts";

const AT = "2026-10-04T12:00:00.000Z";

const REPORT: DefectReport = {
  reportVersion: 1,
  slideHtml: "<html><body><h1>Zqxvbnm</h1></body></html>",
  conversion: { requests: [{ insertText: { objectId: "anon-1", text: "Zqxvbnm", insertionIndex: 0 } }], unsupported: [] },
  note: "the table lost its gridlines",
  versions: { anonymiser: "sasha-anonymise/1", converter: "2026.10.04", addon: "0.1.0", protocol: "1" },
  anonymisation: {
    identifierPolicy: "rename",
    carriers: [],
    retainedIdentifiers: [],
    unrecognisedAttributes: [],
    residualRisks: ["colours are preserved"],
    redactedIdentifierCount: 1,
    redactedUrlCount: 0,
  },
};

test("the body is exactly the service's six fields, and the HTML is the preview's byte for byte", () => {
  const body = reportRequestBodyOf({ report: REPORT, clientReportedAt: AT });
  assert.equal(body.kind, "ok");
  if (body.kind !== "ok") return;
  assert.deepEqual(Object.keys(body.value).sort(), [
    "clientReportedAt",
    "converterOutput",
    "document",
    "note",
    "schemaVersion",
    "versions",
  ]);
  assert.equal(body.value.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(body.value.document.html, REPORT.slideHtml);
  assert.equal(body.value.converterOutput.format, CONVERTER_OUTPUT_FORMAT);
  assert.deepEqual(JSON.parse(body.value.converterOutput.text), REPORT.conversion.requests);
  assert.deepEqual(body.value.versions, { addon: "0.1.0", converter: "2026.10.04", protocol: 1 });
});

test("the anonymiser's version and the anonymisation summary are NOT on the wire: the service has no field for them", () => {
  const body = reportRequestBodyOf({ report: REPORT, clientReportedAt: AT });
  assert.equal(body.kind, "ok");
  if (body.kind !== "ok") return;
  const wire = serializeReportRequest(body.value);
  assert.ok(!wire.includes("sasha-anonymise"));
  assert.ok(!wire.includes("anonymisation"));
  assert.ok(!wire.includes("residualRisks"));
});

test("a protocol or version string the service would refuse is refused here, with the field named", () => {
  const badProtocol = reportRequestBodyOf({
    report: { ...REPORT, versions: { ...REPORT.versions, protocol: "1.x" } },
    clientReportedAt: AT,
  });
  assert.equal(badProtocol.kind, "invalid");
  const badAddon = reportRequestBodyOf({
    report: { ...REPORT, versions: { ...REPORT.versions, addon: "sasha/addon" } },
    clientReportedAt: AT,
  });
  assert.equal(badAddon.kind, "invalid");
  if (badAddon.kind !== "invalid") return;
  assert.match(badAddon.reason, /versions\.addon/);
});

test("a timestamp that is not a UTC instant is refused before the request is made", () => {
  assert.equal(reportRequestBodyOf({ report: REPORT, clientReportedAt: "2026-10-04 12:00" }).kind, "invalid");
  assert.equal(reportRequestBodyOf({ report: REPORT, clientReportedAt: "2026-10-04T12:00:00+02:00" }).kind, "invalid");
});

test("the endpoint check refuses what the browser would refuse anyway, and says why", () => {
  assert.equal(endpointProblem("http://127.0.0.1:8787/v1/reports"), null);
  assert.equal(endpointProblem("https://reports.example/v1/reports"), null);
  assert.match(String(endpointProblem("http://reports.example/v1/reports")), /plain-http/);
  assert.match(String(endpointProblem("https://reports.example/submit")), /\/v1\/reports/);
  assert.match(String(endpointProblem("not a url")), /not a URL/);
});

test("nothing answering is `unreachable` with the endpoint and what to do about it -- never a spinner", async () => {
  const submitter = fetchReportSubmitter({
    fetchJson: async () => ({ kind: "no-answer", message: "Failed to fetch" }),
  });
  const submission = await submitter.submit({
    endpoint: "http://127.0.0.1:8787/v1/reports",
    body: "{}",
  });
  assert.equal(submission.kind, "unreachable");
  if (submission.kind !== "unreachable") return;
  assert.match(submission.message, /127\.0\.0\.1:8787/);
  assert.match(submission.message, /not running by default/);
});

test("a body over the service's cap is refused locally rather than sent to be refused", async () => {
  let posted = false;
  const submitter = fetchReportSubmitter({
    fetchJson: async () => {
      posted = true;
      return { kind: "answered", status: 201, text: "{}" };
    },
  });
  const submission = await submitter.submit({
    endpoint: "http://127.0.0.1:8787/v1/reports",
    body: "x".repeat(3 * 1024 * 1024),
  });
  assert.equal(posted, false);
  assert.equal(submission.kind, "refused");
  if (submission.kind !== "refused") return;
  assert.equal(submission.code, "body-too-large");
});

test("201, a duplicate 200, a 422 and a lying 200 each read as what they are", () => {
  assert.deepEqual(
    submissionOf({
      status: 201,
      text: JSON.stringify({ id: "rep_1", deletionToken: "del_1", duplicate: false, storedBytes: 583 }),
    }),
    { kind: "accepted", id: "rep_1", deletionToken: "del_1", duplicate: false, storedBytes: 583 },
  );
  assert.deepEqual(
    submissionOf({ status: 200, text: JSON.stringify({ id: "rep_1", deletionToken: null, duplicate: true }) }),
    { kind: "accepted", id: "rep_1", deletionToken: null, duplicate: true, storedBytes: 0 },
  );
  const refused = submissionOf({
    status: 422,
    text: JSON.stringify({ error: { code: "unknown-field", message: "unknown field presentationId" } }),
  });
  assert.deepEqual(refused, {
    kind: "refused",
    status: 422,
    code: "unknown-field",
    message: "unknown field presentationId",
  });
  const lying = submissionOf({ status: 200, text: JSON.stringify({ ok: true }) });
  assert.equal(lying.kind, "refused");
  if (lying.kind !== "refused") return;
  assert.equal(lying.code, "unreadable-answer");
});

test("an answer that is not JSON at all is a refusal, not a crash", () => {
  const read = submissionOf({ status: 502, text: "<html>Bad Gateway</html>" });
  assert.equal(read.kind, "refused");
});

test("a thrown fetch becomes `no-answer` rather than escaping the submitter", async () => {
  const post = browserHttpPost({
    fetchImpl: (() => {
      throw new Error("NetworkError");
    }) as unknown as typeof fetch,
  });
  const answered: HttpAnswer = await post({ endpoint: "https://reports.example/v1/reports", body: "{}" });
  assert.equal(answered.kind, "no-answer");
});

test("the byte count is bytes of UTF-8, so an emoji cannot buy four times the budget", () => {
  assert.equal(utf8Length("abc"), 3);
  assert.equal(utf8Length("\u{1f600}"), 4);
});
