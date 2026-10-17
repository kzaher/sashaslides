// ONE REPORT AS A ZIP: everything the user sent and everything the owner wrote about it, in files a
// person can open, so a defect can be taken to a debugger, attached to an issue or archived.
//
// The writer is hand written over `node:zlib` (DEFLATE and CRC-32), for the same reason the parser
// is: this package has no runtime dependencies. It writes the plain PKZIP format -- local headers,
// a central directory, an end record -- with UTF-8 names and no ZIP64, which is enough because one
// report is bounded at a few MiB (defect-report.ts `REPORT_LIMITS`).

import { crc32, deflateRawSync } from "node:zlib";
import { assertNever } from "./assert-never.ts";
import { screenshotBytesOf, type DefectReport } from "./defect-report.ts";
import type { ReportIndexEntry } from "./report-store.ts";
import { describeStatus, type Triage } from "./report-triage.ts";

export type ZipEntry = Readonly<{ path: string; bytes: Uint8Array; modifiedAt: Date }>;

/** The archive's files, in the order a person reads them. Pure: the zip is built from these. */
export function reportBundleEntries(
  options: Readonly<{ entry: ReportIndexEntry; report: DefectReport; triage: Triage; exportedAt: Date }>,
): readonly ZipEntry[] {
  const { entry, report, triage, exportedAt } = options;
  const folder = entry.id;
  const at = new Date(entry.receivedAt);
  const text = (path: string, body: string, modifiedAt: Date = at): ZipEntry => ({
    path: `${folder}/${path}`,
    bytes: Buffer.from(body, "utf8"),
    modifiedAt,
  });
  const summary = {
    id: entry.id,
    receivedAt: entry.receivedAt,
    clientReportedAt: entry.clientReportedAt,
    schemaVersion: report.schemaVersion,
    versions: report.versions,
    slideLabel: report.context.slideLabel,
    note: report.note,
    sizes: {
      storedBytes: entry.storedBytes,
      htmlBytes: entry.htmlBytes,
      converterOutputBytes: entry.converterOutputBytes,
      noteBytes: entry.noteBytes,
    },
    triage: {
      status: triage.status,
      statusChangedAt: triage.statusChangedAt,
      statusChangedBy: triage.statusChangedBy,
      notes: triage.notes,
    },
    exportedAt: exportedAt.toISOString(),
  };
  return [
    text("README.txt", readmeOf({ entry, report, triage }), exportedAt),
    text("report.json", `${JSON.stringify(summary, null, 2)}\n`, exportedAt),
    text("note.txt", report.note === "" ? "" : `${report.note}\n`),
    text("slide.html", report.document.html),
    text("converter-output.json", prettyJsonOrRaw(report.converterOutput.text)),
    text("annotations.json", `${JSON.stringify(report.attachments.annotations, null, 2)}\n`),
    ...report.attachments.screenshots.map((screenshot) => ({
      path: `${folder}/screenshots/${screenshot.name}`,
      bytes: screenshotBytesOf(screenshot),
      modifiedAt: at,
    })),
  ];
}

/** The archive's file name. The id's alphabet is `[0-9a-z_]`, so it needs no quoting. */
export function reportBundleName(entry: ReportIndexEntry): string {
  return `${entry.id}.zip`;
}

function readmeOf(options: Readonly<{ entry: ReportIndexEntry; report: DefectReport; triage: Triage }>): string {
  const { entry, report, triage } = options;
  return [
    `Sasha Slides defect report ${entry.id}`,
    "",
    `Received        ${entry.receivedAt}`,
    `Slide           ${report.context.slideLabel === "" ? "(no label)" : report.context.slideLabel}`,
    `Status          ${describeStatus(triage.status)}`,
    `Add-on          ${report.versions.addon}, converter ${report.versions.converter}, protocol ${String(report.versions.protocol)}`,
    "",
    "Files",
    "  report.json            metadata, the user's comment and the triage history",
    "  note.txt               the user's comment",
    "  slide.html             the anonymised slide the user sent (UNTRUSTED: open it in a sandbox)",
    "  converter-output.json  the Slides API requests the converter made from slide.html",
    `  annotations.json       ${String(report.attachments.annotations.length)} review note(s) the user saw beside the slide`,
    `  screenshots/           ${String(report.attachments.screenshots.length)} PNG(s)`,
    "",
  ].join("\n");
}

function prettyJsonOrRaw(text: string): string {
  try {
    const value: unknown = JSON.parse(text);
    return `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    return text;
  }
}

/** The bytes of a zip holding `entries`. Each is deflated unless that would make it bigger. */
export function zipArchive(entries: readonly ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const raw = Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
    const deflated = deflateRawSync(raw);
    const method: ZipMethod = deflated.byteLength < raw.byteLength ? "deflate" : "store";
    const body = bodyFor({ method, raw, deflated });
    const checksum = crc32(raw) >>> 0;
    const { time, date } = dosDateTime(entry.modifiedAt);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed: 2.0
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(methodCode(method), 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.byteLength, 18);
    header.writeUInt32LE(raw.byteLength, 22);
    header.writeUInt16LE(name.byteLength, 26);
    header.writeUInt16LE(0, 28);
    parts.push(header, name, body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x031e, 4); // made by: Unix, spec 3.0
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(UTF8_NAMES, 8);
    record.writeUInt16LE(methodCode(method), 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(body.byteLength, 20);
    record.writeUInt32LE(raw.byteLength, 24);
    record.writeUInt16LE(name.byteLength, 28);
    record.writeUInt16LE(0, 30); // extra length
    record.writeUInt16LE(0, 32); // comment length
    record.writeUInt16LE(0, 34); // disk number
    record.writeUInt16LE(0, 36); // internal attributes
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.byteLength + name.byteLength + body.byteLength;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, directory, end]);
}

/** General purpose flag bit 11: names are UTF-8. */
const UTF8_NAMES = 0x0800;

type ZipMethod = "store" | "deflate";

function methodCode(method: ZipMethod): number {
  switch (method) {
    case "store":
      return 0;
    case "deflate":
      return 8;
    default:
      return assertNever(method);
  }
}

function bodyFor(options: Readonly<{ method: ZipMethod; raw: Buffer; deflated: Buffer }>): Buffer {
  switch (options.method) {
    case "store":
      return options.raw;
    case "deflate":
      return options.deflated;
    default:
      return assertNever(options.method);
  }
}

/** MS-DOS date and time, in UTC, clamped to the format's 1980 epoch. */
function dosDateTime(at: Date): Readonly<{ time: number; date: number }> {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}
