// THE WIRE FORMAT FOR `POST /v1/reports`, AND THE ONE CALL THAT USES IT.
//
// `report-service/` is a SEPARATELY DEPLOYABLE service. Its README says so in as many words: "It
// imports nothing from `mcp/sasha-slides/**`; the wire format ... is the contract, and both sides
// transcribe it independently." So this file is a transcription, not an import, and
// `REPORT_SCHEMA_VERSION` is how a mismatch becomes a visible refusal instead of a silent one.
//
// THE SHAPE IS CLOSED. Every field is required, and UNKNOWN FIELDS ARE REJECTED at the top level
// and in every nested object, which is deliberate on the service's side: "If a future add-on build
// starts leaking one, it gets a 422 rather than quiet storage." Two consequences this file lives
// with rather than works around:
//
//   * `DefectReport.anonymisation` (the carriers, the retained identifiers, the residual risks, the
//     redaction counts) has NOWHERE to go on the wire. It is shown to the USER next to the preview,
//     which is what UI-CONTRACT.md asks for, and it is not sent. The alternative -- folding it into
//     `note` -- would rewrite the user's own words, and the note is theirs.
//   * `versions.anonymiser` likewise. `ANONYMISER_VERSION` is `sasha-anonymise/1`, which is not
//     even a legal version identifier for that service (`/` is outside `[A-Za-z0-9._+:-]`).
//
// `versions.protocol` is a NUMBER on the wire and a STRING in `DefectReport`, so the transcription
// parses it and refuses rather than coercing: `Number("1.x")` is `NaN` and `NaN` would serialise as
// `null`, which the service reads as a missing field and reports as a confusing 422.
//
// A FAILED SEND IS A VERDICT, NEVER A SPINNER. `ReportSubmission` has three arms and the review
// surface renders all three. "The service is not running" is the expected case -- it binds to
// loopback by default and is not started with the add-on -- so `unreachable` is a first-class
// outcome with the endpoint in the message, not a transport exception that leaves the button spinning.

import { assertNever, type Parsed } from "./protocol.ts";
import type { DefectReport } from "./anonymise/index.ts";

/** Must equal the service's `DEFECT_REPORT_SCHEMA_VERSION`. */
export const REPORT_SCHEMA_VERSION = 1;

/** The only value the service accepts for `converterOutput.format`. */
export const CONVERTER_OUTPUT_FORMAT = "slides-api-requests-json";

/**
 * Where reports go, by default. Loopback and the service's own default port, because the service is
 * not running by default and a wrong guess that happens to resolve is worse than one that does not.
 * The review surface shows this and lets the user replace it, so a deployment needs no rebuild.
 */
export const DEFAULT_REPORT_ENDPOINT = "http://127.0.0.1:8787/v1/reports";

/** Bytes. The service refuses a larger body before reading it, so the surface refuses it first. */
export const REPORT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** The body of `POST /v1/reports`, transcribed from report-service/README.md. */
export type ReportRequestBody = Readonly<{
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  note: string;
  document: Readonly<{ html: string }>;
  converterOutput: Readonly<{ format: typeof CONVERTER_OUTPUT_FORMAT; text: string }>;
  versions: Readonly<{ addon: string; converter: string; protocol: number }>;
  clientReportedAt: string;
}>;

/** What the service answered. Three arms, and the surface renders each one. */
export type ReportSubmission =
  | Readonly<{
      kind: "accepted";
      id: string;
      /** Shown ONCE: the service cannot reissue it. Null on a duplicate, which is not a failure. */
      deletionToken: string | null;
      duplicate: boolean;
      storedBytes: number;
    }>
  /** The service answered and said no. `code` is its stable machine code. */
  | Readonly<{ kind: "refused"; status: number; code: string; message: string }>
  /** Nothing answered: not started, wrong endpoint, blocked by CORS, no network. */
  | Readonly<{ kind: "unreachable"; message: string }>;

/** The one capability the flow needs. Injected, so the state machine tests need no network. */
export type ReportSubmitter = Readonly<{
  submit(spec: Readonly<{ endpoint: string; body: string }>): Promise<ReportSubmission>;
}>;

/**
 * The payload, from the report the user approved. Pure: `report` is `defectReportFrom(preview)` and
 * nothing is read from anywhere else, so what is sent is what the preview rendered.
 */
export function reportRequestBodyOf({
  report,
  clientReportedAt,
}: {
  report: DefectReport;
  clientReportedAt: string;
}): Parsed<ReportRequestBody> {
  const protocol = Number(report.versions.protocol);
  if (!Number.isInteger(protocol) || protocol < 0 || protocol > 1_000_000) {
    return { kind: "invalid", reason: `versions.protocol must be an integer, not "${report.versions.protocol}"` };
  }
  for (const [field, value] of [
    ["versions.addon", report.versions.addon],
    ["versions.converter", report.versions.converter],
  ] as const) {
    if (!VERSION_IDENTIFIER.test(value)) {
      return { kind: "invalid", reason: `${field} is not a version identifier the service accepts` };
    }
  }
  if (!UTC_INSTANT.test(clientReportedAt)) {
    return { kind: "invalid", reason: "clientReportedAt must be an ISO-8601 UTC instant" };
  }
  return {
    kind: "ok",
    value: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      note: report.note,
      document: { html: report.slideHtml },
      converterOutput: {
        format: CONVERTER_OUTPUT_FORMAT,
        // The requests ALONE, because `slides-api-requests-json` names exactly that. The
        // converter's `unsupported` list is shown to the user and has no field on the wire.
        text: JSON.stringify(report.conversion.requests),
      },
      versions: { addon: report.versions.addon, converter: report.versions.converter, protocol },
      clientReportedAt,
    },
  };
}

/** The bytes to POST. One shape, so the service's duplicate digest is stable across retries. */
export function serializeReportRequest(body: ReportRequestBody): string {
  return JSON.stringify(body);
}

/**
 * An endpoint the surface will accept. `https:` for anything that is not loopback: the add-on is
 * served over https, so a plain-http cross-origin POST to a real host would be blocked by the
 * browser anyway and the user deserves to be told before they press send rather than after.
 */
export function endpointProblem(endpoint: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return "that is not a URL";
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "the endpoint must be http or https";
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
  if (parsed.protocol === "http:" && !loopback) {
    return "a page served over https cannot POST to a plain-http host; use https or loopback";
  }
  if (!parsed.pathname.endsWith("/v1/reports")) return "the path must be /v1/reports";
  return null;
}

/**
 * The real call. `fetch` rather than `UrlFetchApp`: the report must leave the USER's browser and
 * never the add-on's server half, because routing it through Apps Script would put the payload in
 * Google's logs and give the service one origin for every user.
 *
 * `mode: "cors"` and no credentials, matching the service: it reflects an `Origin` only for
 * `*-script.googleusercontent.com` over https and NEVER sends
 * `Access-Control-Allow-Credentials`, so a credentialed request would fail the preflight.
 */
export function fetchReportSubmitter({ fetchJson }: { fetchJson: HttpPost }): ReportSubmitter {
  return {
    async submit({ endpoint, body }) {
      const problem = endpointProblem(endpoint);
      if (problem !== null) return { kind: "unreachable", message: `${endpoint}: ${problem}` };
      const bytes = utf8Length(body);
      if (bytes > REPORT_BODY_LIMIT_BYTES) {
        return {
          kind: "refused",
          status: 413,
          code: "body-too-large",
          message: `the report is ${bytes} bytes and the service accepts at most ${REPORT_BODY_LIMIT_BYTES}`,
        };
      }
      const answered = await fetchJson({ endpoint, body });
      switch (answered.kind) {
        case "no-answer":
          return {
            kind: "unreachable",
            message:
              `nothing answered at ${endpoint} (${answered.message}). The report service is not running by ` +
              "default: start it with `npm start` in report-service/, or point this at a deployment.",
          };
        case "answered":
          return submissionOf({ status: answered.status, text: answered.text });
        default:
          return assertNever(answered);
      }
    },
  };
}

/** One POST, as the submitter needs it. The only thing in this flow that touches the network. */
export type HttpPost = (
  spec: Readonly<{ endpoint: string; body: string }>,
) => Promise<HttpAnswer>;

export type HttpAnswer =
  | Readonly<{ kind: "answered"; status: number; text: string }>
  | Readonly<{ kind: "no-answer"; message: string }>;

/** `fetch`, wrapped so a rejected promise becomes `no-answer` rather than an exception upstream. */
export function browserHttpPost({ fetchImpl }: { fetchImpl: typeof fetch }): HttpPost {
  return async ({ endpoint, body }) => {
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body,
      });
      return { kind: "answered", status: response.status, text: await response.text() };
    } catch (cause) {
      return { kind: "no-answer", message: cause instanceof Error ? cause.message : String(cause) };
    }
  };
}

/**
 * The service's own reply, read back. A 2xx must carry an id or it is not an acceptance: a proxy
 * that answered 200 with an HTML error page must not be reported to the user as "sent".
 */
export function submissionOf({ status, text }: { status: number; text: string }): ReportSubmission {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return {
      kind: "refused",
      status,
      code: "unreadable-answer",
      message: `the endpoint answered ${status} with something that is not JSON`,
    };
  }
  const record = asRecord(decoded);
  if (record === null) {
    return { kind: "refused", status, code: "unreadable-answer", message: `the endpoint answered ${status} with no object` };
  }
  if (status === 200 || status === 201) {
    const id = stringAt({ record, key: "id" });
    if (id === null) {
      return {
        kind: "refused",
        status,
        code: "unreadable-answer",
        message: `the endpoint answered ${status} but reported no report id`,
      };
    }
    const deletionToken = stringAt({ record, key: "deletionToken" });
    const storedBytes = record["storedBytes"];
    return {
      kind: "accepted",
      id,
      deletionToken,
      duplicate: record["duplicate"] === true,
      storedBytes: typeof storedBytes === "number" && Number.isFinite(storedBytes) ? storedBytes : 0,
    };
  }
  const error = asRecord(record["error"]);
  return {
    kind: "refused",
    status,
    code: error === null ? "unreadable-answer" : (stringAt({ record: error, key: "code" }) ?? "unreadable-answer"),
    message:
      error === null
        ? `the endpoint answered ${status} with no error object`
        : (stringAt({ record: error, key: "message" }) ?? `the endpoint answered ${status}`),
  };
}

/** Bytes of UTF-8, which is what every cap on that service is measured in. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

const VERSION_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,63}$/;
const UTC_INSTANT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stringAt({ record, key }: { record: Readonly<Record<string, unknown>>; key: string }): string | null {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : null;
}
