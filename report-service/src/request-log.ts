// REQUEST LOGGING THAT CANNOT LEAK A SUBMISSION.
//
// The anonymiser is supposed to have removed everything identifying before the payload is sent.
// This service assumes it failed. Nothing submitted is ever written to a log: not the note, not the
// HTML, not the converter output, not a field value quoted back in an error, not the raw request
// path. What a log line contains is fixed by the type below -- a timestamp, a route template, a
// status, an outcome word, a byte count, a duration, a pseudonymous client label and, where one
// exists, the report id. Every line is built by naming each field, never by spreading an object, so
// a payload cannot arrive in the log through a field somebody added upstream.
//
// The ROUTE TEMPLATE rather than the URL is logged (`/v1/reports/:id`, not the id in the path) for
// requests that did not resolve to a report, because an unmatched path is attacker-controlled text.
// A resolved report id IS logged, in its own field: it is the only way to correlate a stored file
// with the request that created it, which is what an operator needs during an incident.

/** The complete vocabulary of outcomes. A new one must be added here before it can be logged. */
export type RequestOutcome =
  | "accepted"
  | "duplicate"
  | "receipt-served"
  | "deleted"
  | "health-ok"
  | "preflight"
  | "rejected-schema"
  | "rejected-too-large"
  | "rejected-content-type"
  | "rejected-origin"
  | "rejected-encoding"
  | "throttled"
  | "not-found"
  | "method-not-allowed"
  | "forbidden"
  | "storage-full"
  | "client-aborted"
  | "internal-error";

export type RequestLogRecord = Readonly<{
  at: string;
  method: string;
  /** A route template or a literal unmatched marker. Never the raw request target. */
  route: string;
  status: number;
  outcome: RequestOutcome;
  requestBytes: number;
  durationMs: number;
  client: string;
  reportId: string | null;
}>;

/** Service lifecycle and background-task lines. Also payload-free by construction. */
export type ServiceLogRecord = Readonly<{
  at: string;
  event: string;
  detail: string;
}>;

export type RequestLog = Readonly<{
  request: (record: RequestLogRecord) => void;
  service: (record: ServiceLogRecord) => void;
}>;

/**
 * One JSON object per line, which is what every log shipper can read without a parser of its own.
 * `write` is injected so a test can capture lines instead of writing to a stream.
 */
export function jsonLinesRequestLog({ write }: { write: (line: string) => void }): RequestLog {
  return Object.freeze({
    request: (record: RequestLogRecord) => {
      write(
        JSON.stringify({
          at: record.at,
          kind: "request",
          method: record.method,
          route: record.route,
          status: record.status,
          outcome: record.outcome,
          requestBytes: record.requestBytes,
          durationMs: record.durationMs,
          client: record.client,
          reportId: record.reportId,
        }),
      );
    },
    service: (record: ServiceLogRecord) => {
      write(JSON.stringify({ at: record.at, kind: "service", event: record.event, detail: record.detail }));
    },
  });
}

/** Discards everything. For tests that are not asserting on logs. */
export function silentRequestLog(): RequestLog {
  return Object.freeze({ request: () => undefined, service: () => undefined });
}
