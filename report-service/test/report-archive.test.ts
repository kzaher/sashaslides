// The owner's half of the store: version 2 uploads with attachments, listing, reading back,
// the zip of one report, triage that survives a restart, deletion, and the overview's filters.
// Real files in a temporary directory and, for the upload, the real HTTP service.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { parseDefectReport, type DefectReport } from "../src/defect-report.ts";
import {
  digestOf,
  filterSummaries,
  NO_FILTER,
  overviewQuery,
  parseOverviewFilter,
  shortened,
  statusTabs,
  summaryOf,
  type ReportSummary,
} from "../src/report-overview.ts";
import type { ReportId } from "../src/report-id.ts";
import { startReportService } from "../src/report-service.ts";
import { openReportStore, type ReportStore } from "../src/report-store.ts";
import { openTriageLog, UNTRIAGED } from "../src/report-triage.ts";
import { reportBundleEntries, zipArchive } from "../src/report-zip.ts";
import { parseServiceConfig } from "../src/service-config.ts";
import { silentRequestLog } from "../src/request-log.ts";

const SANDBOX_ORIGIN = "https://n-abc123def-0lu-script.googleusercontent.com";
/** A real 1x1 PNG. */
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a version 2 report with annotations and a screenshot is accepted over HTTP and reads back whole", async () => {
  await using directory = await temporaryDirectory();
  const parsed = parseServiceConfig({
    env: { REPORT_PORT: "0", REPORT_DATA_DIR: directory.path, REPORT_SWEEP_INTERVAL_SECONDS: "86400" },
    defaultIpHashSecret: randomBytes(32).toString("hex"),
  });
  assert.equal(parsed.kind, "ok");
  if (parsed.kind !== "ok") return;
  const service = await startReportService({
    config: parsed.config,
    log: silentRequestLog(),
    now: () => new Date(),
    randomBytes: (size) => randomBytes(size),
  });
  try {
    const answer = await fetch(`${service.url}/v1/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: SANDBOX_ORIGIN },
      body: JSON.stringify(versionTwoPayload({ note: "the chart lost its legend" })),
    });
    assert.equal(answer.status, 201);
    const accepted = (await answer.json()) as Readonly<Record<string, unknown>>;
    const id = String(accepted["id"]);

    const listed = service.store.list();
    assert.deepEqual(
      listed.map((entry) => entry.id),
      [id],
    );
    const read = await service.store.read(listed[0]?.id ?? unreachable());
    assert.equal(read.kind, "found");
    if (read.kind !== "found") return;
    assert.equal(read.stored.report.schemaVersion, 2);
    assert.equal(read.stored.report.context.slideLabel, "Quarterly results");
    assert.equal(read.stored.report.attachments.annotations[0]?.tone, "risk");
    assert.equal(read.stored.report.attachments.screenshots[0]?.name, "as-sent.png");
  } finally {
    await service.stop();
  }
});

test("version 2 refuses a screenshot that is not a PNG, an unknown tone and an unknown nested field", () => {
  const notPng = parseDefectReport({
    body: JSON.stringify(
      versionTwoPayload({
        screenshots: [{ name: "a.png", mediaType: "image/png", base64: Buffer.from("GIF89a....").toString("base64") }],
      }),
    ),
  });
  assert.equal(notPng.kind === "rejected" ? notPng.rejection.code : "ok", "bad-value");

  const traversal = parseDefectReport({
    body: JSON.stringify(versionTwoPayload({ screenshots: [{ name: "../x.png", mediaType: "image/png", base64: PIXEL_PNG }] })),
  });
  assert.equal(traversal.kind === "rejected" ? traversal.rejection.code : "ok", "bad-value");

  const tone = parseDefectReport({
    body: JSON.stringify(
      versionTwoPayload({ annotations: [{ id: "a1", tone: "panic", heading: "h", detail: "d", side: "as-is" }] }),
    ),
  });
  assert.equal(tone.kind === "rejected" ? tone.rejection.code : "ok", "bad-value");

  const leak = parseDefectReport({
    body: JSON.stringify({ ...versionTwoPayload({}), context: { slideLabel: "x", presentationId: "1xeg" } }),
  });
  assert.equal(leak.kind === "rejected" ? leak.rejection.code : "ok", "unknown-field");

  // A version 1 body may not carry the version 2 fields.
  const mixed = parseDefectReport({ body: JSON.stringify({ ...versionTwoPayload({}), schemaVersion: 1 }) });
  assert.equal(mixed.kind === "rejected" ? mixed.rejection.code : "ok", "unknown-field");
});

test("the zip holds the slide, the comment, the converter output, the annotations, the screenshot and the triage", async () => {
  await using directory = await temporaryDirectory();
  const store = await openStore(directory.path);
  const triage = await openTriageLog({ dataDir: directory.path });
  const id = await submitted({ store, report: reportOf(versionTwoPayload({ note: "legend gone" })) });
  await triage.setStatus({ id, status: "triaged", by: "owner@example.com", at: new Date("2026-10-05T10:00:00Z") });
  await triage.addNote({ id, text: "reproduced on the bar chart", by: "owner@example.com", at: new Date("2026-10-05T10:01:00Z") });

  const read = await store.read(id);
  assert.equal(read.kind, "found");
  if (read.kind !== "found") return;
  const zip = zipArchive(
    reportBundleEntries({ entry: read.stored.entry, report: read.stored.report, triage: triage.get(id), exportedAt: new Date() }),
  );
  const files = unzip(zip);

  assert.deepEqual([...files.keys()].sort(), [
    `${id}/README.txt`,
    `${id}/annotations.json`,
    `${id}/converter-output.json`,
    `${id}/note.txt`,
    `${id}/report.json`,
    `${id}/screenshots/as-sent.png`,
    `${id}/slide.html`,
  ]);
  assert.equal(files.get(`${id}/slide.html`)?.toString("utf8"), "<!doctype html><p>a slide</p>");
  assert.equal(files.get(`${id}/note.txt`)?.toString("utf8"), "legend gone\n");
  assert.deepEqual(files.get(`${id}/screenshots/as-sent.png`), Buffer.from(PIXEL_PNG, "base64"));
  const summary = JSON.parse(files.get(`${id}/report.json`)?.toString("utf8") ?? "{}") as Record<string, unknown>;
  const recorded = summary["triage"] as Record<string, unknown>;
  assert.equal(recorded["status"], "triaged");
  assert.equal((recorded["notes"] as readonly unknown[]).length, 1);
  const annotations = JSON.parse(files.get(`${id}/annotations.json`)?.toString("utf8") ?? "[]") as readonly unknown[];
  assert.equal(annotations.length, 1);
});

test("triage survives a restart, and deleting a report forgets it and its triage", async () => {
  await using directory = await temporaryDirectory();
  const store = await openStore(directory.path);
  const triage = await openTriageLog({ dataDir: directory.path });
  const kept = await submitted({ store, report: reportOf(versionTwoPayload({ note: "kept" })) });
  const doomed = await submitted({ store, report: reportOf(versionTwoPayload({ note: "doomed" })) });
  await triage.setStatus({ id: kept, status: "fixed", by: "owner@example.com", at: new Date() });
  await triage.setStatus({ id: doomed, status: "wontfix", by: "owner@example.com", at: new Date() });
  assert.equal((await triage.addNote({ id: kept, text: "   ", by: "owner@example.com", at: new Date() })).kind, "refused");
  assert.equal((await triage.addNote({ id: kept, text: "shipped in 0.2", by: "", at: new Date() })).kind, "refused");

  assert.equal((await store.purge(doomed)).kind, "removed");
  await triage.forget({ id: doomed, at: new Date() });
  assert.equal(store.find(doomed), null);
  assert.equal((await store.purge(doomed)).kind, "not-found");

  const reopenedStore = await openStore(directory.path);
  const reopened = await openTriageLog({ dataDir: directory.path });
  assert.deepEqual(
    reopenedStore.list().map((entry) => entry.id),
    [kept],
  );
  assert.equal(reopened.get(kept).status, "fixed");
  assert.equal(reopened.get(kept).statusChangedBy, "owner@example.com");
  assert.equal(reopened.get(doomed), UNTRIAGED);

  // Compaction keeps what the store still holds and replays to the same state.
  assert.equal(await reopened.compact({ keep: (id) => reopenedStore.find(id) !== null }), true);
  const compacted = await openTriageLog({ dataDir: directory.path });
  assert.equal(compacted.get(kept).status, "fixed");
});

test("the overview filters by status, text and day, newest first, and its query round-trips", () => {
  const rows: readonly ReportSummary[] = [
    row({ id: "rep_0000000000000000000000000a", receivedAt: "2026-10-01T09:00:00.000Z", note: "Table borders vanish", status: "new" }),
    row({ id: "rep_0000000000000000000000000b", receivedAt: "2026-10-03T09:00:00.000Z", note: "chart legend gone", status: "fixed" }),
    row({ id: "rep_0000000000000000000000000c", receivedAt: "2026-10-02T09:00:00.000Z", note: "TABLE shifted", status: "new" }),
  ];
  assert.deepEqual(
    filterSummaries({ summaries: rows, filter: NO_FILTER }).map((summary) => summary.note),
    ["chart legend gone", "TABLE shifted", "Table borders vanish"],
  );
  const tables = parseOverviewFilter(new URLSearchParams("status=new&q=table&from=2026-10-02"));
  assert.deepEqual(
    filterSummaries({ summaries: rows, filter: tables }).map((summary) => summary.note),
    ["TABLE shifted"],
  );
  assert.equal(overviewQuery(tables), "status=new&q=table&from=2026-10-02");
  assert.deepEqual(parseOverviewFilter(new URLSearchParams(overviewQuery(tables))), tables);
  // A filter that does not parse shows more, never fails.
  assert.deepEqual(parseOverviewFilter(new URLSearchParams("status=bogus&from=yesterday")), NO_FILTER);
  assert.deepEqual(
    statusTabs(rows).map((tab) => `${tab.status}:${String(tab.count)}`),
    ["new:2", "triaged:0", "fixed:1", "wontfix:0"],
  );
  assert.equal(shortened({ text: "one two three four five", maxCharacters: 13 }), "one two three…");
});

function row(options: Readonly<{ id: string; receivedAt: string; note: string; status: ReportSummary["status"] }>): ReportSummary {
  return {
    id: options.id as ReportId,
    receivedAt: options.receivedAt,
    slideLabel: "",
    note: options.note,
    status: options.status,
    annotationCount: 0,
    screenshotCount: 0,
    triageNoteCount: 0,
    storedBytes: 1,
    versions: { addon: "0.1.0", converter: "2026.10.04", protocol: 1 },
  };
}

test("a summary row is built from the index entry, the stored report and its triage", async () => {
  await using directory = await temporaryDirectory();
  const store = await openStore(directory.path);
  const id = await submitted({ store, report: reportOf(versionTwoPayload({ note: "x" })) });
  const read = await store.read(id);
  assert.equal(read.kind, "found");
  if (read.kind !== "found") return;
  const summary = summaryOf({ entry: read.stored.entry, digest: digestOf(read.stored.report), triage: UNTRIAGED });
  assert.equal(summary.status, "new");
  assert.equal(summary.slideLabel, "Quarterly results");
  assert.equal(summary.annotationCount, 1);
  assert.equal(summary.screenshotCount, 1);
});

function versionTwoPayload(
  overrides: Readonly<{ note?: string; screenshots?: readonly unknown[]; annotations?: readonly unknown[] }>,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 2,
    note: overrides.note ?? "the table lost its gridlines",
    document: { html: "<!doctype html><p>a slide</p>" },
    converterOutput: { format: "slides-api-requests-json", text: '[{"createShape":{"objectId":"g1"}}]' },
    versions: { addon: "0.1.0", converter: "2026.10.04", protocol: 1 },
    clientReportedAt: "2026-10-04T12:00:00.000Z",
    context: { slideLabel: "Quarterly results" },
    attachments: {
      annotations: overrides.annotations ?? [
        { id: "residual_0", tone: "risk", heading: "Numbers kept", detail: "Digits are not anonymised.", side: "as-sent" },
      ],
      screenshots: overrides.screenshots ?? [{ name: "as-sent.png", mediaType: "image/png", base64: PIXEL_PNG }],
    },
  };
}

function reportOf(payload: Readonly<Record<string, unknown>>): DefectReport {
  const parsed = parseDefectReport({ body: JSON.stringify(payload) });
  if (parsed.kind === "rejected") throw new Error(parsed.rejection.detail);
  return parsed.report;
}

async function submitted(options: Readonly<{ store: ReportStore; report: DefectReport }>): Promise<ReportId> {
  const outcome = await options.store.submit({ report: options.report, receivedAt: new Date() });
  if (outcome.kind !== "stored") throw new Error(`not stored: ${outcome.kind}`);
  return outcome.entry.id;
}

function openStore(dataDir: string): Promise<ReportStore> {
  return openReportStore({
    dataDir,
    limits: { maxReports: 100, maxTotalBytes: 64 * 1024 * 1024, retentionDays: 30 },
    randomBytes: (size) => randomBytes(size),
  });
}

async function temporaryDirectory(): Promise<{ path: string; [Symbol.asyncDispose]: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "report-archive-test-"));
  return { path, [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }) };
}

/** A minimal reader over the central directory, independent of the writer's own code. */
function unzip(zip: Buffer): ReadonlyMap<string, Buffer> {
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(endAt >= 0, "no end of central directory record");
  const count = zip.readUInt16LE(endAt + 10);
  let cursor = zip.readUInt32LE(endAt + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index += 1) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50);
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localAt = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const localNameLength = zip.readUInt16LE(localAt + 26);
    const localExtraLength = zip.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataAt, dataAt + compressedSize);
    files.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function unreachable(): never {
  throw new Error("the list was asserted to hold one report immediately above");
}
