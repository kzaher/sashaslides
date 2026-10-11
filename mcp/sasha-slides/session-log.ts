/**
 * The session event log of PROTOCOL.md "The session log, comments on candidates, and
 * revisions": the serialized record of everything that happened to one proposal, which the
 * conversation surface replays in order.
 *
 * Three properties of this file are the contract, and each exists because of a failure mode
 * that is otherwise invisible:
 *
 *  - **One file per event, never one appended file.** Drive has no append, and the server and
 *    the add-on authenticate as different apps that cannot see each other's `appProperties`
 *    (PROTOCOL.md "Identity"). A single `events.jsonl` would therefore be a read-modify-write
 *    between two writers that cannot observe each other, and the loser's event would vanish
 *    with nothing to show it ever existed. Appending here is `createFile`, which cannot
 *    clobber. Nothing in this module reads an event file in order to write one.
 *  - **An unknown `kind` survives as an opaque record.** A newer writer must not break an
 *    older reader: the add-on ships separately from the server, so either half may be newer.
 *    `parseSessionEvent` therefore has no failure case at all — an unknown kind, an
 *    unsupported `protocolVersion`, a missing field or a body that is not even JSON all land
 *    in the `opaque` variant carrying what was found. A reader shows "something happened"
 *    rather than an incomplete history that looks complete.
 *  - **The order is total.** `<epochMillis>-<suffix>-<kind>.json` orders by the millisecond
 *    prefix and breaks ties on the suffix, and `compareSessionEvents` breaks a remaining tie
 *    on the Drive file id — so two events written in the same millisecond, even by two
 *    writers that happened to mint the same suffix, still have exactly one order, and every
 *    reader computes the same one.
 */
import type { DriveChannel, DriveFile, DriveMedia } from "./drive-channel";
import { FEEDBACK_DELIVERED_EVENT_KIND } from "./feedback-delivery";
import { assertNever } from "./google-auth";

/**
 * One line of the conversation. The first seven variants are PROTOCOL.md's `kind` values;
 * `opaque` is the eighth on purpose — see the file header. Every variant carries `at` (when
 * its writer says it happened) and the `protocolVersion` it was written under.
 */
export type SessionEvent =
  | SlidesStagedEvent
  | CommentOpenedEvent
  | CommentAnsweredEvent
  | SlideRevisedEvent
  | CommentResolvedEvent
  | SlidesClearedEvent
  | SlideInsertedEvent
  | FeedbackDeliveredEvent
  | OpaqueEvent;

/** Sasha staged N candidates. Written by the server, at the end of `createProposal`. */
export type SlidesStagedEvent = Readonly<{
  kind: "slides-staged";
  protocolVersion: number;
  at: string;
  proposalId: string;
  /** The manifest `revision` this staging produced. */
  revision: number;
  count: number;
  slides: readonly SessionEventSlide[];
}>;

export type SessionEventSlide = Readonly<{
  index: number;
  fileId: string;
  name: string;
  /** A short caption, never a transcription of the slide. */
  label: string | null;
}>;

/** The user marked up a candidate. Written by the add-on, read by the server. */
export type CommentOpenedEvent = Readonly<{
  kind: "comment-opened";
  protocolVersion: number;
  at: string;
  /** 1-based, matching "slides are 1-based everywhere". */
  slideIndex: number;
  /** The Drive comment id on `NN.html`, which is what `reply_feedback` takes. */
  commentId: string;
  author: string | null;
  /** Verbatim, as the user wrote it. */
  text: string;
  /** Fractional (0-1) against the 1280x720 slide, or null for the slide as a whole. */
  region: EventRegion | null;
  noteId: string | null;
}>;

/** Fractional (0-1), the one coordinate convention in this protocol. */
export type EventRegion = Readonly<{ x: number; y: number; w: number; h: number }>;

/** Sasha replied in the user's thread. Written by the server, on `reply_feedback`. */
export type CommentAnsweredEvent = Readonly<{
  kind: "comment-answered";
  protocolVersion: number;
  at: string;
  slideIndex: number;
  commentId: string;
  replyId: string;
  text: string;
}>;

/** Sasha replaced the candidate in place. Written by the server, on `revise_slide`. */
export type SlideRevisedEvent = Readonly<{
  kind: "slide-revised";
  protocolVersion: number;
  at: string;
  slideIndex: number;
  /** Unchanged by the revision — that is the point of revising in place. */
  fileId: string;
  /** The manifest `revision` this revision produced. */
  revision: number;
  /** The comment ids this revision answers, so the thread and the new slide are linked. */
  answeredCommentIds: readonly string[];
  label: string | null;
}>;

/** A thread closed. Written by the server, on `resolve_feedback`. */
export type CommentResolvedEvent = Readonly<{
  kind: "comment-resolved";
  protocolVersion: number;
  at: string;
  slideIndex: number;
  commentId: string;
  replyId: string;
  text: string;
}>;

/** Sasha discarded the uninserted set. Written by the server, on `clear_slides`. */
export type SlidesClearedEvent = Readonly<{
  kind: "slides-cleared";
  protocolVersion: number;
  at: string;
  revision: number;
  /** 1-based indices whose `NN.html` was deleted. */
  clearedSlideIndices: readonly number[];
  /** 1-based indices kept because they were already inserted into the deck. */
  keptSlideIndices: readonly number[];
  reason: string | null;
}>;

/** A candidate went into the deck. Written by the add-on, read by the server. */
export type SlideInsertedEvent = Readonly<{
  kind: "slide-inserted";
  protocolVersion: number;
  at: string;
  slideIndex: number;
  presentationId: string | null;
  pageObjectId: string | null;
  insertedObjectIds: readonly string[];
}>;

/**
 * A CONNECTED CLIENT READ THE USER'S COMMENTS. Written by the server the moment `read_feedback` or
 * `await_feedback` hands a comment over, which makes it the only thing in Drive that proves
 * something was listening.
 *
 * IT IS A RECEIPT, NOT AN ANSWER, and the distinction is the whole point: it says a client read
 * this comment and says nothing whatsoever about an answer arriving. The add-on renders it as
 * delivery and never as a reply. Nothing is written when a read hands back nothing -- there is no
 * delivery to receipt, and a receipt for an empty read would make silence look like contact.
 */
export type FeedbackDeliveredEvent = Readonly<{
  kind: "feedback-delivered";
  protocolVersion: number;
  at: string;
  /** Which tool handed it over. Diagnosis only; the add-on treats both the same. */
  tool: FeedbackDeliveryTool;
  /** The Drive comment ids delivered, in the order they were handed over. Never empty. */
  commentIds: readonly string[];
}>;

export type FeedbackDeliveryTool = "read_feedback" | "await_feedback";

/**
 * An event this build does not understand, preserved rather than dropped.
 *
 * `rawKind` is whatever the writer called it (from the body, else from the file name, which
 * carries the kind too). `fields` is the record as written, so a reader can show the user
 * *something* and an operator can see exactly what arrived. `reason` says why it landed here.
 */
export type OpaqueEvent = Readonly<{
  kind: "opaque";
  protocolVersion: number | null;
  at: string | null;
  rawKind: string;
  reason: string;
  fields: Readonly<Record<string, unknown>>;
}>;

/** The `kind` values PROTOCOL.md defines. `opaque` is not one: it is this reader's fallback. */
export const SESSION_EVENT_KINDS: readonly string[] = [
  "slides-staged",
  "comment-opened",
  "comment-answered",
  "slide-revised",
  "comment-resolved",
  "slides-cleared",
  "slide-inserted",
  FEEDBACK_DELIVERED_EVENT_KIND,
];

/** The folder events live in, found by NAME under the proposal folder. */
export const EVENTS_FOLDER_NAME = "events";

export const SESSION_LOG_PROTOCOL_VERSION = 1;

/**
 * Everything this module touches that is not pure, and nothing more: no filesystem, no
 * sleeping. `ProposalEnvironment` satisfies it structurally, so the composition root
 * constructs one environment and this module sees only the part it needs.
 */
export type SessionLogEnvironment = Readonly<{
  drive: DriveChannel;
  now: () => Date;
  /** Six base36 characters, the event name's tie-breaking suffix. */
  randomSuffix: () => string;
  warn: (message: string) => void;
}>;

/** One event as stored: the file it is, and the event it holds. */
export type SessionEventRecord = Readonly<{
  /** `<epochMillis>-<suffix>-<kind>` — the file name without `.json`. */
  eventId: string;
  fileId: string;
  name: string;
  /** From the NAME, not the body: the body is the writer's claim, the name is the order. */
  atMillis: number;
  suffix: string;
  event: SessionEvent;
}>;

export type AppendSessionEventOutcome =
  | Readonly<{ kind: "ok"; record: SessionEventRecord }>
  | Readonly<{ kind: "drive-failed"; reason: string }>;

/**
 * Appends one event by CREATING one file. There is no read of the log on this path, which is
 * what makes two blind writers safe.
 *
 * `eventsFolderId` is passed in rather than looked up here so a caller that is already
 * holding the folder (every caller in `proposal.ts`) does not pay a second query, and so
 * this function has exactly one Drive effect.
 */
export async function appendSessionEvent(
  options: Readonly<{
    env: SessionLogEnvironment;
    proposalId: string;
    eventsFolderId: string;
    event: SessionEvent;
  }>,
): Promise<AppendSessionEventOutcome> {
  const { env, proposalId, eventsFolderId, event } = options;
  const atMillis = env.now().getTime();
  const suffix = env.randomSuffix();
  const name = sessionEventFileName({ atMillis, suffix, kind: event.kind });
  try {
    const file = await env.drive.createFile({
      name,
      parentId: eventsFolderId,
      mimeType: "application/json",
      media: sessionEventMedia(event),
      appProperties: { sashaSlides: "event", proposalId, eventKind: event.kind },
    });
    return {
      kind: "ok",
      record: { eventId: stripJsonSuffix(name), fileId: file.id, name, atMillis, suffix, event },
    };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    // Never silent: an event that did not reach Drive is a hole in the history, so the
    // caller must be able to say so rather than reporting a clean success.
    env.warn(`could not append ${event.kind} to the session log of ${proposalId}: ${reason}`);
    return { kind: "drive-failed", reason };
  }
}

export type ReadSessionEventsOutcome =
  | Readonly<{ kind: "ok"; records: readonly SessionEventRecord[]; unreadable: readonly string[] }>
  | Readonly<{ kind: "no-log" }>
  | Readonly<{ kind: "drive-failed"; reason: string }>;

/**
 * The whole log, in order. `no-log` is a value: a proposal staged before this protocol
 * section existed, or one whose folder was cleaned up, has no `events/` folder and that is
 * not an error.
 *
 * A file whose BODY cannot be fetched is reported in `unreadable` and the rest of the log is
 * still returned — one bad event must not cost the reader the whole history.
 */
export async function readSessionEvents(
  options: Readonly<{ env: SessionLogEnvironment; proposalId: string; folderId: string }>,
): Promise<ReadSessionEventsOutcome> {
  const { env, proposalId, folderId } = options;
  let files: readonly DriveFile[];
  try {
    const folder = await findEventsFolder({ env, folderId });
    if (folder === null) return { kind: "no-log" };
    files = await env.drive.listFiles({
      query: {
        name: null,
        parentId: folder.id,
        sashaSlides: null,
        proposalId: null,
        trashed: false,
      },
    });
  } catch (cause) {
    return { kind: "drive-failed", reason: cause instanceof Error ? cause.message : String(cause) };
  }

  const records: SessionEventRecord[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    const named = parseSessionEventFileName({ name: file.name });
    if (named === null) {
      // Not ours and not an event: a stray file in the folder is reported, never parsed.
      unreadable.push(`${file.name} (not an <epochMillis>-<suffix>-<kind>.json event name)`);
      continue;
    }
    const body = await readEventBody({ env, fileId: file.id });
    const event =
      body.kind === "ok"
        ? parseSessionEvent({ body: body.json, fileNameKind: named.kind })
        : opaqueFromUnreadableBody({ kind: named.kind, reason: body.reason });
    records.push({
      eventId: stripJsonSuffix(file.name),
      fileId: file.id,
      name: file.name,
      atMillis: named.atMillis,
      suffix: named.suffix,
      event,
    });
  }
  if (unreadable.length > 0) {
    env.warn(`session log of ${proposalId} holds ${String(unreadable.length)} unreadable entr(ies)`);
  }
  return { kind: "ok", records: [...records].sort(compareSessionEvents), unreadable };
}

/** `<epochMillis>-<6 base36>-<kind>.json`, exactly as PROTOCOL.md names it. */
export function sessionEventFileName(
  options: Readonly<{ atMillis: number; suffix: string; kind: string }>,
): string {
  return `${String(options.atMillis)}-${options.suffix}-${options.kind}.json`;
}

/**
 * The name is the ORDER, so it is parsed separately from the body and wins over it: a writer
 * whose clock disagrees with its own file name cannot reshuffle the log for everyone else.
 *
 * `kind` may contain `-` (every kind does), so the split is "first field, second field,
 * everything else" rather than a three-way split.
 */
export function parseSessionEventFileName(
  options: Readonly<{ name: string }>,
): Readonly<{ atMillis: number; suffix: string; kind: string }> | null {
  const match = /^(\d+)-([0-9a-z]+)-(.+)\.json$/i.exec(options.name);
  if (match === null) return null;
  const atMillis = Number.parseInt(match[1] ?? "", 10);
  const suffix = match[2] ?? "";
  const kind = match[3] ?? "";
  if (!Number.isSafeInteger(atMillis) || suffix === "" || kind === "") return null;
  return { atMillis, suffix, kind };
}

/**
 * The total order: millisecond, then suffix, then Drive file id.
 *
 * The third key is not decoration. Two writers that cannot see each other can mint the same
 * `<millis>-<suffix>` (Drive permits duplicate names in a folder), and a comparator that
 * returned 0 there would leave the order of those two events down to whatever order Drive
 * happened to list them in — different for each reader. The file id is unique and stable, so
 * every reader computes the same sequence.
 */
export function compareSessionEvents(left: SessionEventRecord, right: SessionEventRecord): number {
  if (left.atMillis !== right.atMillis) return left.atMillis - right.atMillis;
  if (left.suffix !== right.suffix) return left.suffix < right.suffix ? -1 : 1;
  if (left.fileId === right.fileId) return 0;
  return left.fileId < right.fileId ? -1 : 1;
}

/**
 * The parse boundary for an event body. **Total by construction: there is no failure
 * return.** Anything this build cannot interpret becomes `opaque` with the reason, because a
 * dropped event is a history that lies about being complete.
 *
 * `fileNameKind` is the kind the file NAME claims, used when the body has no usable `kind` —
 * which is how even a truncated write still renders as "something happened".
 */
export function parseSessionEvent(
  options: Readonly<{ body: Readonly<Record<string, unknown>>; fileNameKind: string }>,
): SessionEvent {
  const { body, fileNameKind } = options;
  const rawKind = asString(body["kind"]) ?? fileNameKind;
  const version = asNumber(body["protocolVersion"]);
  const at = asString(body["at"]);
  const opaque = (reason: string): OpaqueEvent => ({
    kind: "opaque",
    protocolVersion: version,
    at,
    rawKind,
    reason,
    fields: body,
  });

  if (version !== SESSION_LOG_PROTOCOL_VERSION) {
    // Not an error and not a drop: a newer writer is allowed to exist, and the reader still
    // owes the user a line in the conversation.
    return opaque(
      `protocolVersion ${String(version)} is not ${String(SESSION_LOG_PROTOCOL_VERSION)}; ` +
        "reported as an opaque event rather than interpreted",
    );
  }
  if (at === null) return opaque("no string `at`");

  switch (rawKind) {
    case "slides-staged": {
      const proposalId = asString(body["proposalId"]);
      const count = asNumber(body["count"]);
      if (proposalId === null || count === null) return opaque("slides-staged needs proposalId and count");
      return {
        kind: "slides-staged",
        protocolVersion: version,
        at,
        proposalId,
        revision: asNumber(body["revision"]) ?? 0,
        count,
        slides: asArray(body["slides"]).flatMap((entry) => {
          const slide = parseEventSlide(entry);
          return slide === null ? [] : [slide];
        }),
      };
    }
    case "comment-opened": {
      const slideIndex = asNumber(body["slideIndex"]);
      const commentId = asString(body["commentId"]);
      if (slideIndex === null || commentId === null) {
        return opaque("comment-opened needs slideIndex and commentId");
      }
      return {
        kind: "comment-opened",
        protocolVersion: version,
        at,
        slideIndex,
        commentId,
        author: asString(body["author"]),
        text: asString(body["text"]) ?? "",
        region: parseEventRegion(body["region"]),
        noteId: asString(body["noteId"]),
      };
    }
    case "comment-answered":
    case "comment-resolved": {
      const slideIndex = asNumber(body["slideIndex"]);
      const commentId = asString(body["commentId"]);
      const replyId = asString(body["replyId"]);
      if (slideIndex === null || commentId === null || replyId === null) {
        return opaque(`${rawKind} needs slideIndex, commentId and replyId`);
      }
      const common = {
        protocolVersion: version,
        at,
        slideIndex,
        commentId,
        replyId,
        text: asString(body["text"]) ?? "",
      } as const;
      return rawKind === "comment-answered"
        ? { kind: "comment-answered", ...common }
        : { kind: "comment-resolved", ...common };
    }
    case "slide-revised": {
      const slideIndex = asNumber(body["slideIndex"]);
      const fileId = asString(body["fileId"]);
      const revision = asNumber(body["revision"]);
      if (slideIndex === null || fileId === null || revision === null) {
        return opaque("slide-revised needs slideIndex, fileId and revision");
      }
      return {
        kind: "slide-revised",
        protocolVersion: version,
        at,
        slideIndex,
        fileId,
        revision,
        answeredCommentIds: asStringArray(body["answeredCommentIds"]),
        label: asString(body["label"]),
      };
    }
    case "slides-cleared": {
      const revision = asNumber(body["revision"]);
      if (revision === null) return opaque("slides-cleared needs revision");
      return {
        kind: "slides-cleared",
        protocolVersion: version,
        at,
        revision,
        clearedSlideIndices: asNumberArray(body["clearedSlideIndices"]),
        keptSlideIndices: asNumberArray(body["keptSlideIndices"]),
        reason: asString(body["reason"]),
      };
    }
    case "slide-inserted": {
      const slideIndex = asNumber(body["slideIndex"]);
      if (slideIndex === null) return opaque("slide-inserted needs slideIndex");
      return {
        kind: "slide-inserted",
        protocolVersion: version,
        at,
        slideIndex,
        presentationId: asString(body["presentationId"]),
        pageObjectId: asString(body["pageObjectId"]),
        insertedObjectIds: asStringArray(body["insertedObjectIds"]),
      };
    }
    case FEEDBACK_DELIVERED_EVENT_KIND: {
      const commentIds = asStringArray(body["commentIds"]);
      // A receipt that names no comment is not a receipt. Opaque rather than dropped, and opaque
      // rather than interpreted: "something was delivered, we cannot say what" must not read as
      // proof that THIS comment reached anybody.
      if (commentIds.length === 0) return opaque("feedback-delivered needs a non-empty commentIds");
      return {
        kind: "feedback-delivered",
        protocolVersion: version,
        at,
        tool: asDeliveryTool(body["tool"]),
        commentIds,
      };
    }
    default:
      // THE unknown-kind rule. A writer newer than this reader is expected, not exceptional.
      return opaque(`unknown event kind "${rawKind}"`);
  }
}

/**
 * One line of conversation per event, for a reader that has nothing better to render. The
 * `opaque` arm is why this exists at all: PROTOCOL.md requires an unknown kind to render as
 * "something happened", and a bare `if` on the kind would have no `never` position to fail
 * on when a kind is added.
 */
export function describeSessionEvent(event: SessionEvent): string {
  switch (event.kind) {
    case "slides-staged":
      return `Sasha staged ${String(event.count)} candidate(s) (revision ${String(event.revision)})`;
    case "comment-opened":
      return `you commented on slide ${String(event.slideIndex)}${event.region === null ? "" : ", on a region"}`;
    case "comment-answered":
      return `Sasha answered the comment on slide ${String(event.slideIndex)}`;
    case "slide-revised":
      return (
        `Sasha replaced slide ${String(event.slideIndex)} (revision ${String(event.revision)}` +
        `${event.answeredCommentIds.length === 0 ? "" : `, answering ${String(event.answeredCommentIds.length)} comment(s)`})`
      );
    case "comment-resolved":
      return `the comment thread on slide ${String(event.slideIndex)} closed`;
    case "slides-cleared":
      return `Sasha discarded ${String(event.clearedSlideIndices.length)} uninserted candidate(s)`;
    case "slide-inserted":
      return `slide ${String(event.slideIndex)} went into the deck`;
    case "feedback-delivered":
      // "read", never "answered": the receipt says a client has the comment, nothing more.
      return (
        `a Claude session read ${String(event.commentIds.length)} comment(s) ` +
        `through ${event.tool}`
      );
    case "opaque":
      return `something happened (${event.rawKind}), written by a newer build: ${event.reason}`;
    default:
      return assertNever(event);
  }
}

/** The body as written. `opaque` round-trips its own fields, so a reader can forward it. */
export function sessionEventBody(event: SessionEvent): Readonly<Record<string, unknown>> {
  switch (event.kind) {
    case "opaque":
      return event.fields;
    case "slides-staged":
    case "comment-opened":
    case "comment-answered":
    case "slide-revised":
    case "comment-resolved":
    case "slides-cleared":
    case "slide-inserted":
    case "feedback-delivered":
      return { ...event };
    default:
      return assertNever(event);
  }
}

/** Finds `events/` by NAME under the proposal folder, creating it when it is not there. */
export async function ensureEventsFolder(
  options: Readonly<{ env: SessionLogEnvironment; proposalId: string; folderId: string }>,
): Promise<string> {
  const { env, proposalId, folderId } = options;
  const existing = await findEventsFolder({ env, folderId });
  if (existing !== null) return existing.id;
  const created = await env.drive.createFolder({
    name: EVENTS_FOLDER_NAME,
    parentId: folderId,
    appProperties: { sashaSlides: "events", proposalId },
  });
  return created.id;
}

/**
 * The tool named in a receipt, narrowed at the parse boundary. An unrecognised name degrades to
 * `read_feedback` rather than failing the whole receipt: WHICH tool delivered is diagnosis, and
 * losing the receipt over it would cost the add-on the one piece of evidence it has.
 */
function asDeliveryTool(value: unknown): FeedbackDeliveryTool {
  return value === "await_feedback" ? "await_feedback" : "read_feedback";
}

function sessionEventMedia(event: SessionEvent): DriveMedia {
  return { kind: "text", text: `${JSON.stringify(sessionEventBody(event), null, 2)}\n` };
}

async function findEventsFolder(
  options: Readonly<{ env: SessionLogEnvironment; folderId: string }>,
): Promise<DriveFile | null> {
  const folders = await options.env.drive.listFiles({
    query: {
      name: EVENTS_FOLDER_NAME,
      parentId: options.folderId,
      sashaSlides: null,
      proposalId: null,
      trashed: false,
    },
  });
  return folders[0] ?? null;
}

type EventBodyRead =
  | Readonly<{ kind: "ok"; json: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

async function readEventBody(
  options: Readonly<{ env: SessionLogEnvironment; fileId: string }>,
): Promise<EventBodyRead> {
  try {
    const parsed: unknown = JSON.parse(await options.env.drive.readTextFile({ fileId: options.fileId }));
    const record = asRecord(parsed);
    return record === null ? { kind: "unreadable", reason: "top level is not an object" } : { kind: "ok", json: record };
  } catch (cause) {
    return { kind: "unreadable", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

function opaqueFromUnreadableBody(options: Readonly<{ kind: string; reason: string }>): OpaqueEvent {
  return {
    kind: "opaque",
    protocolVersion: null,
    at: null,
    rawKind: options.kind,
    reason: `the event body could not be read: ${options.reason}`,
    fields: {},
  };
}

function stripJsonSuffix(name: string): string {
  return name.endsWith(".json") ? name.slice(0, -".json".length) : name;
}

function parseEventSlide(value: unknown): SessionEventSlide | null {
  const record = asRecord(value);
  if (record === null) return null;
  const index = asNumber(record["index"]);
  const fileId = asString(record["fileId"]);
  const name = asString(record["name"]);
  if (index === null || fileId === null || name === null) return null;
  return { index, fileId, name, label: asString(record["label"]) };
}

/** A region whose numbers are not fractional is DROPPED, never pointed at the wrong place. */
function parseEventRegion(value: unknown): EventRegion | null {
  const record = asRecord(value);
  if (record === null) return null;
  const x = asNumber(record["x"]);
  const y = asNumber(record["y"]);
  const w = asNumber(record["w"]);
  const h = asNumber(record["h"]);
  if (x === null || y === null || w === null || h === null) return null;
  const fractional = [x, y, w, h].every((number) => number >= 0 && number <= 1);
  return fractional ? { x, y, w, h } : null;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): readonly string[] {
  return asArray(value).flatMap((entry) => {
    const text = asString(entry);
    return text === null ? [] : [text];
  });
}

function asNumberArray(value: unknown): readonly number[] {
  return asArray(value).flatMap((entry) => {
    const number = asNumber(entry);
    return number === null ? [] : [number];
  });
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
