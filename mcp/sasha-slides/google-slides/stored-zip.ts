/**
 * A zip archive with every entry STORED (no compression), for the PNG export: PNG files are
 * already deflate-compressed, so deflating them again buys nothing and costs CPU per request.
 *
 * WHY HAND-WRITTEN: the connector image installs only mcp/sasha-slides/deploy/package.json, which
 * has no zip library, and a stored, non-ZIP64 archive is a fixed 30-byte header per entry, a
 * 46-byte central directory record per entry and a 22-byte end record. The reader beside it is
 * pptx-archive.ts. Limits that follow from the format: at most 65535 entries and 4 GiB in total,
 * far above the 60 slides (EXPORT_PNG_LIMITS) a PNG export may hold; both are checked.
 */
import { crc32 } from "node:zlib";

export type StoredZipEntry = Readonly<{ name: string; bytes: Uint8Array }>;

export const STORED_ZIP_MEDIA_TYPE = "application/zip";

/** The bytes of a zip holding `entries` in order, each stored, all stamped `modifiedAt`. */
export function storedZip(options: Readonly<{ entries: readonly StoredZipEntry[]; modifiedAt: Date }>): Buffer {
  const { entries } = options;
  if (entries.length > MAXIMUM_ENTRIES) throw new Error(`a zip holds at most ${MAXIMUM_ENTRIES} entries without ZIP64`);
  const { time, date } = dosDateTime(options.modifiedAt);
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
    const checksum = crc32(body) >>> 0;
    if (offset + LOCAL_HEADER_BYTES + name.byteLength + body.byteLength > MAXIMUM_OFFSET) throw new Error("a zip without ZIP64 holds at most 4 GiB");

    const header = Buffer.alloc(LOCAL_HEADER_BYTES);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(VERSION_NEEDED, 4);
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(STORED, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.byteLength, 18);
    header.writeUInt32LE(body.byteLength, 22);
    header.writeUInt16LE(name.byteLength, 26);
    header.writeUInt16LE(0, 28);
    parts.push(header, name, body);

    const record = Buffer.alloc(CENTRAL_RECORD_BYTES);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(0x031e, 4); // made by: Unix, specification 3.0
    record.writeUInt16LE(VERSION_NEEDED, 6);
    record.writeUInt16LE(UTF8_NAMES, 8);
    record.writeUInt16LE(STORED, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(body.byteLength, 20);
    record.writeUInt32LE(body.byteLength, 24);
    record.writeUInt16LE(name.byteLength, 28);
    record.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += LOCAL_HEADER_BYTES + name.byteLength + body.byteLength;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.byteLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_RECORD_BYTES = 46;
const VERSION_NEEDED = 10; // 1.0: stored entries only
const STORED = 0;
/** General purpose flag bit 11: names are UTF-8. */
const UTF8_NAMES = 0x0800;
const MAXIMUM_ENTRIES = 0xffff;
const MAXIMUM_OFFSET = 0xffffffff;

/** MS-DOS time and date fields (two-second resolution, local fields read as UTC). */
function dosDateTime(when: Date): Readonly<{ time: number; date: number }> {
  const year = Math.max(1980, when.getUTCFullYear());
  return {
    time: (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | Math.floor(when.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate(),
  };
}
