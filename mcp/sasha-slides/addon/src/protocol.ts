// The sasha-slides Drive staging protocol, as a set of immutable values plus the parsers that
// produce them. See ../../PROTOCOL.md — that file is the contract and this one is its only
// TypeScript transcription; nothing else in the extension may re-describe these shapes.
//
// Everything here is PARSED AT THE BOUNDARY: a `READY` / `manifest.json` body arrives as an
// untrusted string from Drive and leaves these functions as a typed value or an explicit failure.
// Guards are hand written rather than generated: this package has no ts-patch/typia setup, and
// three small object shapes do not justify adding one (the MCP server's google-auth.ts makes the
// same call for the same reason).

/** The only protocol version this build understands. An unknown version is ignored, never guessed. */
export const PROTOCOL_VERSION = 1;

/** `appProperties.sashaSlides` values, which are what every Drive query matches on. */
export const SASHA_SLIDES_PROPERTY = "sashaSlides";
export const ROLE_READY = "ready";
export const ROLE_PICK = "pick";

/** `READY` — the final mark. Until it exists a proposal is partial and must be ignored. */
export type ReadyMarker = Readonly<{
  protocolVersion: number;
  proposalId: string;
  count: number;
  manifestFileId: string;
}>;

/** One candidate slide. `index` is 1-based everywhere, so a human can say "option 3". */
export type SlideEntry = Readonly<{
  index: number;
  fileId: string;
  name: string;
  label: string;
}>;

export type Manifest = Readonly<{
  protocolVersion: number;
  proposalId: string;
  createdAt: string;
  /** The target deck when the server knew it, else null. */
  presentationId: string | null;
  count: number;
  slides: readonly SlideEntry[];
  /**
   * HOW MANY TIMES THE CANDIDATE SET HAS CHANGED, bumped by every revision and every clear. Null
   * on a manifest written before the field existed.
   *
   * It answers "have the candidates changed" and nothing else. It is deliberately NOT the "has
   * anything happened" signal -- listing `events/` is that -- because the add-on appends events
   * too, and an event that bumped `revision` would make the add-on a writer of `manifest.json`,
   * putting both writers back into the read-modify-write that one file per event exists to avoid.
   *
   * It also OUTRANKS `READY` for everything after the first staging: a clear leaves `READY` in
   * place while `count` drops to 0, so a folder with a READY is not a folder with candidates.
   */
  revision: number | null;
}>;

/** Fractional (0-1) box relative to the 1280x720 slide, so it survives any scaling. */
export type Region = Readonly<{ x: number; y: number; w: number; h: number }>;

export const WHOLE_SLIDE: Region = { x: 0, y: 0, w: 1, h: 1 };

export type Anomaly = Readonly<{ index: number; note: string; region: Region }>;

/** `PICK` — the ONLY file this extension ever writes. */
export type Pick = Readonly<{
  protocolVersion: number;
  proposalId: string;
  /** null when the user dismissed the picker without choosing. */
  picked: number | null;
  decidedAt: string;
  insertedObjectIds: readonly string[];
  anomalies: readonly Anomaly[];
}>;

export type Parsed<TValue> =
  | Readonly<{ kind: "ok"; value: TValue }>
  | Readonly<{ kind: "invalid"; reason: string }>
  | Readonly<{ kind: "unsupported-version"; protocolVersion: number }>;

export function parseReadyMarker(body: string): Parsed<ReadyMarker> {
  const json = readJsonObject(body);
  if (json.kind !== "ok") return json;
  const version = versionOf(json.value);
  if (version.kind !== "ok") return version;
  const proposalId = stringAt({ record: json.value, key: "proposalId" });
  const manifestFileId = stringAt({ record: json.value, key: "manifestFileId" });
  const count = integerAt({ record: json.value, key: "count" });
  if (proposalId === null) return { kind: "invalid", reason: "READY has no string proposalId" };
  if (manifestFileId === null) return { kind: "invalid", reason: "READY has no string manifestFileId" };
  if (count === null || count < 1) return { kind: "invalid", reason: "READY has no positive integer count" };
  return { kind: "ok", value: { protocolVersion: version.value, proposalId, count, manifestFileId } };
}

export function parseManifest(body: string): Parsed<Manifest> {
  const json = readJsonObject(body);
  if (json.kind !== "ok") return json;
  const version = versionOf(json.value);
  if (version.kind !== "ok") return version;
  const proposalId = stringAt({ record: json.value, key: "proposalId" });
  const createdAt = stringAt({ record: json.value, key: "createdAt" });
  const count = integerAt({ record: json.value, key: "count" });
  if (proposalId === null) return { kind: "invalid", reason: "manifest has no string proposalId" };
  if (createdAt === null) return { kind: "invalid", reason: "manifest has no string createdAt" };
  // ZERO IS LEGAL, and it is the shape a CLEARED set has: `clear_slides` deletes the uninserted
  // candidates and bumps `revision`, leaving `READY` in place. Refusing count 0 made a cleared
  // proposal read as "the manifest could not be read", which is the one thing clearing must never
  // look like -- PROTOCOL.md: "never silently".
  if (count === null || count < 0) return { kind: "invalid", reason: "manifest has no count" };

  const presentationField = json.value["presentationId"];
  if (presentationField !== null && typeof presentationField !== "string") {
    return { kind: "invalid", reason: "manifest presentationId is neither a string nor null" };
  }
  const slides = parseSlides(json.value["slides"]);
  if (slides.kind !== "ok") return slides;
  if (slides.value.length !== count) {
    return { kind: "invalid", reason: `manifest count ${count} disagrees with ${slides.value.length} slides` };
  }
  // 1-based and gap-free, because the picker numbers the chips off the index and the user says
  // "option 3" meaning slides[2]. A hole here would silently renumber the offer.
  for (let position = 0; position < slides.value.length; position++) {
    const entry = slides.value[position];
    if (entry === undefined || entry.index !== position + 1) {
      return { kind: "invalid", reason: `manifest slides are not 1..${count} in order` };
    }
  }
  return {
    kind: "ok",
    value: {
      protocolVersion: version.value,
      proposalId,
      createdAt,
      presentationId: presentationField,
      count,
      slides: slides.value,
      revision: integerAt({ record: json.value, key: "revision" }),
    },
  };
}

/**
 * The body written to `PICK`. Separate from writing it so the bytes can be asserted in a unit test
 * without a Drive, and so an invalid decision is refused before anything leaves the browser.
 */
export function serializePick(pick: Pick): Parsed<string> {
  if (pick.protocolVersion !== PROTOCOL_VERSION) return { kind: "unsupported-version", protocolVersion: pick.protocolVersion };
  if (pick.proposalId === "") return { kind: "invalid", reason: "PICK has an empty proposalId" };
  for (const anomaly of pick.anomalies) {
    if (!Number.isInteger(anomaly.index) || anomaly.index < 1) {
      return { kind: "invalid", reason: `anomaly index ${anomaly.index} is not a 1-based slide number` };
    }
    if (!isFractionalRegion(anomaly.region)) {
      return { kind: "invalid", reason: `anomaly ${anomaly.index} has a region outside 0-1` };
    }
  }
  return { kind: "ok", value: JSON.stringify(pick, null, 2) };
}

export function isFractionalRegion(region: Region): boolean {
  const sides = [region.x, region.y, region.w, region.h];
  if (!sides.every((side) => Number.isFinite(side) && side >= 0 && side <= 1)) return false;
  return region.w > 0 && region.h > 0 && region.x + region.w <= 1.0001 && region.y + region.h <= 1.0001;
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

function parseSlides(field: unknown): Parsed<readonly SlideEntry[]> {
  if (!Array.isArray(field)) return { kind: "invalid", reason: "manifest slides is not an array" };
  const entries: SlideEntry[] = [];
  for (const candidate of field) {
    const record = asRecord(candidate);
    if (record === null) return { kind: "invalid", reason: "a manifest slide is not an object" };
    const index = integerAt({ record, key: "index" });
    const fileId = stringAt({ record, key: "fileId" });
    const name = stringAt({ record, key: "name" });
    const label = stringAt({ record, key: "label" });
    if (index === null || index < 1) return { kind: "invalid", reason: "a manifest slide has no 1-based index" };
    if (fileId === null) return { kind: "invalid", reason: `slide ${index} has no string fileId` };
    if (name === null) return { kind: "invalid", reason: `slide ${index} has no string name` };
    entries.push({ index, fileId, name, label: label ?? "" });
  }
  return { kind: "ok", value: entries };
}

function versionOf(record: Readonly<Record<string, unknown>>): Parsed<number> {
  const version = integerAt({ record, key: "protocolVersion" });
  if (version === null) return { kind: "invalid", reason: "no integer protocolVersion" };
  if (version !== PROTOCOL_VERSION) return { kind: "unsupported-version", protocolVersion: version };
  return { kind: "ok", value: version };
}

function readJsonObject(body: string): Parsed<Readonly<Record<string, unknown>>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    return { kind: "invalid", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  const record = asRecord(parsed);
  return record === null ? { kind: "invalid", reason: "top level is not an object" } : { kind: "ok", value: record };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function stringAt({ record, key }: { record: Readonly<Record<string, unknown>>; key: string }): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function integerAt({ record, key }: { record: Readonly<Record<string, unknown>>; key: string }): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
