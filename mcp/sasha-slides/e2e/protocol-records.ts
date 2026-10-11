/**
 * The records of PROTOCOL.md — both the files on Drive and the MCP tool payloads that
 * report them — as types plus parsers.
 *
 * Everything the harness reads out of Drive is untrusted text, so it is parsed into a
 * typed value here and nowhere else; the phases below then branch on types rather than
 * re-checking shapes. The repo has no typia/ts-patch transform wired into `tsx`, so the
 * guards are hand-written — the same tradeoff `../google-auth.ts` already made.
 *
 * This file is the harness's reading of PROTOCOL.md. If the two ever disagree,
 * PROTOCOL.md wins and this file is the bug.
 */

export const PROTOCOL_VERSION = 1;

export const INBOX_FOLDER_NAME = "Sasha Slides Inbox";
export const MANIFEST_NAME = "manifest.json";
export const READY_NAME = "READY";
export const PICK_NAME = "PICK";
/** The extension's render subfolder: `<proposalId>/render/NN.png`. */
export const RENDER_FOLDER_NAME = "render";

export const FOLDER_MIME = "application/vnd.google-apps.folder";
export const HTML_MIME = "text/html";
export const JSON_MIME = "application/json";

/** The `appProperties.sashaSlides` tag every file in the protocol carries. */
export type SashaRole = "inbox" | "proposal" | "slide" | "manifest" | "ready" | "pick";

export const SASHA_PROPERTY = "sashaSlides";

export type ManifestSlide = Readonly<{
  index: number;
  fileId: string;
  name: string;
  label: string;
}>;

export type Manifest = Readonly<{
  protocolVersion: number;
  proposalId: string;
  createdAt: string;
  presentationId: string | null;
  count: number;
  slides: readonly ManifestSlide[];
}>;

export type ReadyMarker = Readonly<{
  protocolVersion: number;
  proposalId: string;
  count: number;
  manifestFileId: string;
}>;

/** Fractional (0-1) against the 1280x720 slide, so it survives any scaling. */
export type AnomalyRegion = Readonly<{ x: number; y: number; w: number; h: number }>;

export type Anomaly = Readonly<{
  index: number;
  note: string;
  region: AnomalyRegion | null;
}>;

export type PickRecord = Readonly<{
  protocolVersion: number;
  proposalId: string;
  /** null when the user dismissed the picker without choosing. */
  picked: number | null;
  decidedAt: string;
  insertedObjectIds: readonly string[];
  anomalies: readonly Anomaly[];
}>;

/** `await_pick`'s reply. A timeout is a status, never an exception. */
export type PickStatus = "picked" | "dismissed" | "timeout" | "unsupported-protocol-version";

export const PICK_STATUSES: readonly PickStatus[] = [
  "picked",
  "dismissed",
  "timeout",
  "unsupported-protocol-version",
];

export type PickReply = Readonly<{
  status: PickStatus;
  picked: number | null;
  anomalies: readonly Anomaly[];
  insertedObjectIds: readonly string[];
  decidedAt: string | null;
  note: string | null;
}>;

export type Parsed<TValue> =
  | Readonly<{ kind: "ok"; value: TValue }>
  | Readonly<{ kind: "invalid"; reason: string }>;

/** 1-based index to the Drive name: 1 -> "01.html". */
export function slideFileName(index: number): string {
  return `${String(index).padStart(2, "0")}.html`;
}

/** `p_<epochMillis>_<6 random base36 chars>` — sortable and collision-free without coordination. */
export function newProposalId(options: Readonly<{ nowMs: number; randomFraction: number }>): string {
  const suffix = Math.floor(options.randomFraction * 36 ** 6)
    .toString(36)
    .padStart(6, "0")
    .slice(0, 6);
  return `p_${options.nowMs}_${suffix}`;
}

export function parseManifest(text: string): Parsed<Manifest> {
  const root = parseJsonObject(text);
  if (root.kind === "invalid") return root;
  const json = root.value;

  const protocolVersion = numberField(json, "protocolVersion");
  if (protocolVersion === null) return invalid("protocolVersion is not a number");
  const proposalId = stringField(json, "proposalId");
  if (proposalId === null) return invalid("proposalId is not a string");
  const createdAt = stringField(json, "createdAt");
  if (createdAt === null) return invalid("createdAt is not a string");
  const count = numberField(json, "count");
  if (count === null) return invalid("count is not a number");

  const presentationIdField = json["presentationId"];
  if (presentationIdField !== null && typeof presentationIdField !== "string") {
    return invalid("presentationId is neither a string nor null");
  }

  const rawSlides = json["slides"];
  if (!Array.isArray(rawSlides)) return invalid("slides is not an array");
  const slides: ManifestSlide[] = [];
  for (const [position, entry] of rawSlides.entries()) {
    const record = asRecord(entry);
    if (record === null) return invalid(`slides[${position}] is not an object`);
    const index = numberField(record, "index");
    const fileId = stringField(record, "fileId");
    const name = stringField(record, "name");
    const label = stringField(record, "label");
    if (index === null) return invalid(`slides[${position}].index is not a number`);
    if (fileId === null) return invalid(`slides[${position}].fileId is not a string`);
    if (name === null) return invalid(`slides[${position}].name is not a string`);
    if (label === null) return invalid(`slides[${position}].label is not a string`);
    slides.push({ index, fileId, name, label });
  }

  return {
    kind: "ok",
    value: { protocolVersion, proposalId, createdAt, presentationId: presentationIdField, count, slides },
  };
}

export function parseReadyMarker(text: string): Parsed<ReadyMarker> {
  const root = parseJsonObject(text);
  if (root.kind === "invalid") return root;
  const json = root.value;

  const protocolVersion = numberField(json, "protocolVersion");
  if (protocolVersion === null) return invalid("protocolVersion is not a number");
  const proposalId = stringField(json, "proposalId");
  if (proposalId === null) return invalid("proposalId is not a string");
  const count = numberField(json, "count");
  if (count === null) return invalid("count is not a number");
  const manifestFileId = stringField(json, "manifestFileId");
  if (manifestFileId === null) return invalid("manifestFileId is not a string");

  return { kind: "ok", value: { protocolVersion, proposalId, count, manifestFileId } };
}

export function parsePickRecord(text: string): Parsed<PickRecord> {
  const root = parseJsonObject(text);
  if (root.kind === "invalid") return root;
  const json = root.value;

  const protocolVersion = numberField(json, "protocolVersion");
  if (protocolVersion === null) return invalid("protocolVersion is not a number");
  const proposalId = stringField(json, "proposalId");
  if (proposalId === null) return invalid("proposalId is not a string");
  const decidedAt = stringField(json, "decidedAt");
  if (decidedAt === null) return invalid("decidedAt is not a string");

  const pickedField = json["picked"];
  if (pickedField !== null && typeof pickedField !== "number") {
    return invalid("picked is neither a number nor null");
  }

  const insertedObjectIds = stringArrayField(json, "insertedObjectIds");
  if (insertedObjectIds === null) return invalid("insertedObjectIds is not an array of strings");

  const rawAnomalies = json["anomalies"];
  if (!Array.isArray(rawAnomalies)) return invalid("anomalies is not an array");
  const anomalies: Anomaly[] = [];
  for (const [position, entry] of rawAnomalies.entries()) {
    const parsed = parseAnomaly(entry, position);
    if (parsed.kind === "invalid") return parsed;
    anomalies.push(parsed.value);
  }

  return {
    kind: "ok",
    value: { protocolVersion, proposalId, picked: pickedField, decidedAt, insertedObjectIds, anomalies },
  };
}

export function parsePickReply(text: string): Parsed<PickReply> {
  const root = parseJsonObject(text);
  if (root.kind === "invalid") return root;
  const json = root.value;

  const status = json["status"];
  if (typeof status !== "string" || !isPickStatus(status)) {
    return invalid(`status is ${JSON.stringify(status)}, expected one of ${PICK_STATUSES.join("|")}`);
  }

  const pickedField = json["picked"];
  if (pickedField !== null && typeof pickedField !== "number") {
    return invalid("picked is neither a number nor null");
  }

  const insertedObjectIds = stringArrayField(json, "insertedObjectIds");
  if (insertedObjectIds === null) return invalid("insertedObjectIds is not an array of strings");

  const rawAnomalies = json["anomalies"];
  if (!Array.isArray(rawAnomalies)) return invalid("anomalies is not an array");
  const anomalies: Anomaly[] = [];
  for (const [position, entry] of rawAnomalies.entries()) {
    const parsed = parseAnomaly(entry, position);
    if (parsed.kind === "invalid") return parsed;
    anomalies.push(parsed.value);
  }

  const decidedAt = json["decidedAt"];
  const note = json["note"];
  return {
    kind: "ok",
    value: {
      status,
      picked: pickedField,
      anomalies,
      insertedObjectIds,
      decidedAt: typeof decidedAt === "string" ? decidedAt : null,
      note: typeof note === "string" ? note : null,
    },
  };
}

/** The same reply, derived from the PICK file itself, so both sides answer in one shape. */
export function pickReplyFromRecord(record: PickRecord): PickReply {
  return {
    status: record.picked === null ? "dismissed" : "picked",
    picked: record.picked,
    anomalies: record.anomalies,
    insertedObjectIds: record.insertedObjectIds,
    decidedAt: record.decidedAt,
    note: null,
  };
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

/** A parse-boundary guard over an untrusted string, so it cannot be status-exhaustive. */
function isPickStatus(candidate: string): candidate is PickStatus {
  return PICK_STATUSES.includes(candidate as PickStatus);
}

function parseAnomaly(entry: unknown, position: number): Parsed<Anomaly> {
  const record = asRecord(entry);
  if (record === null) return invalid(`anomalies[${position}] is not an object`);
  const index = numberField(record, "index");
  if (index === null) return invalid(`anomalies[${position}].index is not a number`);
  const note = stringField(record, "note");
  if (note === null) return invalid(`anomalies[${position}].note is not a string`);

  const rawRegion = record["region"];
  if (rawRegion === undefined || rawRegion === null) {
    return { kind: "ok", value: { index, note, region: null } };
  }
  const regionRecord = asRecord(rawRegion);
  if (regionRecord === null) return invalid(`anomalies[${position}].region is not an object`);
  const x = numberField(regionRecord, "x");
  const y = numberField(regionRecord, "y");
  const width = numberField(regionRecord, "w");
  const height = numberField(regionRecord, "h");
  if (x === null || y === null || width === null || height === null) {
    return invalid(`anomalies[${position}].region needs numeric x, y, w, h`);
  }
  return { kind: "ok", value: { index, note, region: { x, y, w: width, h: height } } };
}

function parseJsonObject(text: string): Parsed<Readonly<Record<string, unknown>>> {
  try {
    const record = asRecord(JSON.parse(text));
    return record === null ? invalid("top level is not an object") : { kind: "ok", value: record };
  } catch (cause) {
    return invalid(`not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stringField(json: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = json[key];
  return typeof value === "string" ? value : null;
}

function numberField(json: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = json[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArrayField(json: Readonly<Record<string, unknown>>, key: string): readonly string[] | null {
  const value = json[key];
  if (!Array.isArray(value)) return null;
  return value.every((entry): entry is string => typeof entry === "string") ? value : null;
}

function invalid(reason: string): Readonly<{ kind: "invalid"; reason: string }> {
  return { kind: "invalid", reason };
}
