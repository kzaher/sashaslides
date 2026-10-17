// The sasha-slides Drive staging protocol, as a set of immutable values plus the parsers that
// produce them. See ../../PROTOCOL.md — that file is the contract and this one is its only
// TypeScript transcription; nothing else in the extension may re-describe these shapes.
//
// Everything here is PARSED AT THE BOUNDARY: a `READY` / `manifest.json` body arrives as an
// untrusted string from Drive and leaves these functions as a typed value or an explicit failure.
// Guards are hand written rather than generated: this package has no ts-patch/typia setup, and
// three small object shapes do not justify adding one (the MCP server's google-auth.ts makes the
// same call for the same reason).

import { asRecord, integerAt, stringAt } from "./json-fields.ts";

/** The only protocol version this build understands. An unknown version is ignored, never guessed. */
export const PROTOCOL_VERSION = 1;

/** `appProperties.sashaSlides` values, which are what every Drive query matches on. */
export const SASHA_SLIDES_PROPERTY = "sashaSlides";
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

/**
 * A MERGE proposal's target: the existing slide its candidates redesign part of (PROTOCOL.md
 * "Merge proposals"). Absent from the manifest of an ordinary proposal, whose pick is inserted as a
 * new slide.
 */
export type MergeTarget = Readonly<{ presentationId: string; slideObjectId: string }>;

/** What one candidate deletes from the target slide: `pageElements` object ids, as Claude captured them. */
export type CandidateRemoval = Readonly<{ index: number; remove: readonly string[] }>;

/**
 * The target plus every candidate's `remove` list, gathered in one value so a proposal is either a
 * merge with all of it or an insert with none of it. On the wire `remove` sits on each
 * `slides[]` entry; here it is keyed by the candidate's 1-based index, one entry per candidate.
 */
export type MergeSpec = MergeTarget & Readonly<{ removals: readonly CandidateRemoval[] }>;

export type Manifest = Readonly<{
  protocolVersion: number;
  proposalId: string;
  createdAt: string;
  /** The target deck when the server knew it, else null. */
  presentationId: string | null;
  count: number;
  slides: readonly SlideEntry[];
  /** Null for an ordinary proposal (insert the pick as a new slide); see `MergeSpec`. */
  merge: MergeSpec | null;
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

export type Parsed<TValue> = Readonly<{ kind: "ok"; value: TValue }> | ParseFailure;

/** The two ways a parse can refuse. */
export type ParseFailure =
  | Readonly<{ kind: "invalid"; reason: string }>
  | Readonly<{ kind: "unsupported-version"; protocolVersion: number }>;

/** A refused parse, in words -- the one rendering every surface shows, for a call or a file alike. */
export function describeParsedFailure({ parsed, what }: { parsed: ParseFailure; what: string }): string {
  switch (parsed.kind) {
    case "invalid":
      return `${what}: ${parsed.reason}`;
    case "unsupported-version":
      return `${what} declares protocolVersion ${parsed.protocolVersion}`;
    default:
      return assertNever(parsed);
  }
}

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
  if (!slidesAreNumbered({ slides: slides.value, count })) {
    return { kind: "invalid", reason: `manifest slides are not 1..${count} in order` };
  }
  const merge = parseManifestMerge({ record: json.value, presentationId: presentationField });
  if (merge.kind !== "ok") return merge;
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
      merge: merge.value,
    },
  };
}

/**
 * Whether `slides` are exactly 1..count, in order, with no holes. 1-based and gap-free, because the
 * picker numbers the candidates off the index and the user says "option 3" meaning slides[2]; a
 * hole would silently renumber the offer. The manifest and the slides window's seed both hold it.
 */
export function slidesAreNumbered({ slides, count }: { slides: readonly SlideEntry[]; count: number }): boolean {
  return slides.length === count && slides.every((slide, position) => slide.index === position + 1);
}

/**
 * THE ONE RULE FOR READING A STAGED SET'S TWO FILES (PROTOCOL.md, "What READY means now"), and
 * every reader goes through it: the slides window's observer and its revision tick, Ask Sasha and
 * the report window (staged-set.ts).
 *
 * READY says which manifest is the set's, and nothing else in it is trusted. Its `count` is the
 * FIRST staging's: `clear_slides` and every revision leave READY in place while the manifest moves
 * on, so the manifest's own count, slides and revision are the truth -- a cleared set is a manifest
 * with count 0, never a mismatch. What never goes stale is WHOSE the files are, so both must name
 * the folder they were found in (discovery is by name, so that is the proposal id).
 */
export function readyManifestFileIdOf({ readyText, proposalId }: { readyText: string; proposalId: string }): Parsed<string> {
  const ready = parseReadyMarker(readyText);
  if (ready.kind !== "ok") return ready;
  if (ready.value.proposalId !== proposalId) {
    return { kind: "invalid", reason: `it names ${ready.value.proposalId}, its folder ${proposalId}` };
  }
  return { kind: "ok", value: ready.value.manifestFileId };
}

/** The manifest READY named, held to the same rule: it must be the folder's own. See above. */
export function stagedManifestOf({ manifestText, proposalId }: { manifestText: string; proposalId: string }): Parsed<Manifest> {
  const manifest = parseManifest(manifestText);
  if (manifest.kind !== "ok") return manifest;
  if (manifest.value.proposalId !== proposalId) {
    return { kind: "invalid", reason: `it names ${manifest.value.proposalId}, its folder ${proposalId}` };
  }
  return manifest;
}

/** The candidate's `remove` list, or none for a candidate of an ordinary proposal. */
export function removalFor({ merge, index }: { merge: MergeSpec; index: number }): readonly string[] {
  return merge.removals.find((removal) => removal.index === index)?.remove ?? [];
}

/**
 * A `MergeSpec` in the add-on's OWN form (`removals` by index), for the slides window's seed, which
 * carries a parsed proposal from the sidebar. `null` is a proposal that is not a merge.
 */
export function parseMergeSpec(field: unknown): Parsed<MergeSpec | null> {
  if (field === null || field === undefined) return { kind: "ok", value: null };
  const record = asRecord(field);
  if (record === null) return { kind: "invalid", reason: "merge is not an object" };
  const target = mergeTargetOf(record);
  if (target.kind !== "ok") return target;
  const rawRemovals = record["removals"];
  if (!Array.isArray(rawRemovals)) return { kind: "invalid", reason: "merge has no removals array" };
  const removals: CandidateRemoval[] = [];
  for (const candidate of rawRemovals) {
    const entry = asRecord(candidate);
    const index = entry === null ? null : integerAt({ record: entry, key: "index" });
    if (entry === null || index === null || index < 1) return { kind: "invalid", reason: "a merge removal has no 1-based index" };
    const remove = objectIdsOf({ field: entry["remove"], what: `candidate ${String(index)}'s remove` });
    if (remove.kind !== "ok") return remove;
    removals.push({ index, remove: remove.value });
  }
  return { kind: "ok", value: { ...target.value, removals } };
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

export function parseSlides(field: unknown): Parsed<readonly SlideEntry[]> {
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

/**
 * The manifest's `merge` target and every `slides[].remove`, together. Strict on purpose: a merge
 * that fails to parse must never degrade into an INSERT of a candidate that only holds the new
 * parts of a slide, so anything malformed makes the whole manifest invalid -- including a `remove`
 * on a proposal with no target, which would otherwise be silently ignored.
 */
function parseManifestMerge({
  record,
  presentationId,
}: {
  record: Readonly<Record<string, unknown>>;
  presentationId: string | null;
}): Parsed<MergeSpec | null> {
  const slides = Array.isArray(record["slides"]) ? record["slides"] : [];
  const field = record["merge"];
  if (field === undefined || field === null) {
    const stray = slides.some((slide) => asRecord(slide)?.["remove"] !== undefined);
    return stray
      ? { kind: "invalid", reason: "a manifest slide has `remove` but the manifest names no merge target" }
      : { kind: "ok", value: null };
  }
  const mergeRecord = asRecord(field);
  if (mergeRecord === null) return { kind: "invalid", reason: "manifest merge is not an object" };
  const target = mergeTargetOf(mergeRecord);
  if (target.kind !== "ok") return target;
  if (presentationId !== null && presentationId !== target.value.presentationId) {
    return { kind: "invalid", reason: "manifest merge names a different deck than presentationId" };
  }
  const removals: CandidateRemoval[] = [];
  for (const [position, slide] of slides.entries()) {
    const index = position + 1;
    const raw = asRecord(slide)?.["remove"];
    const remove = raw === undefined ? ({ kind: "ok", value: [] } as const) : objectIdsOf({ field: raw, what: `slide ${String(index)}'s remove` });
    if (remove.kind !== "ok") return remove;
    removals.push({ index, remove: remove.value });
  }
  return { kind: "ok", value: { ...target.value, removals } };
}

function mergeTargetOf(record: Readonly<Record<string, unknown>>): Parsed<MergeTarget> {
  const presentationId = stringAt({ record, key: "presentationId" });
  const slideObjectId = stringAt({ record, key: "slideObjectId" });
  if (presentationId === null || presentationId === "") return { kind: "invalid", reason: "merge has no presentationId" };
  if (slideObjectId === null || slideObjectId === "") return { kind: "invalid", reason: "merge has no slideObjectId" };
  return { kind: "ok", value: { presentationId, slideObjectId } };
}

/** A list of non-empty object ids. Empty is legal: a candidate that only adds. */
function objectIdsOf({ field, what }: { field: unknown; what: string }): Parsed<readonly string[]> {
  if (!Array.isArray(field)) return { kind: "invalid", reason: `${what} is not an array` };
  const ids: string[] = [];
  for (const entry of field) {
    if (typeof entry !== "string" || entry === "") return { kind: "invalid", reason: `${what} holds a non-string or empty id` };
    ids.push(entry);
  }
  return { kind: "ok", value: ids };
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
