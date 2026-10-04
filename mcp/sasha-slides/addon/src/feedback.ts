// REVIEW FEEDBACK: the user's notes about their OWN deck, and the text they become once they are
// native Google Slides comments on the presentation file.
//
// This file is the CONTRACT BETWEEN THE TWO HALVES and nothing else lives here. The sidebar half
// (this package) turns a `ReviewNote` into a comment body with `feedbackCommentContent`; the
// server half (`mcp/sasha-slides/server.ts`, owned elsewhere) reads the same bodies back off the
// Drive comments API and answers by REPLYING to the thread. Both directions go through the
// functions below, so the format is stated once, in TypeScript, under `node --test`.
//
// WHY THE REGION TRAVELS IN THE COMMENT TEXT AND NOT IN A DRIVE `anchor`. Drive's comment `anchor`
// is an opaque, per-application JSON region descriptor; for a Slides file its shape is not
// documented and Slides' own UI is the only thing that writes one. A comment created with no
// anchor is still a first-class comment on the presentation -- it just shows up unanchored in the
// comment pane -- so the box the user dragged is carried as data in the body instead, in the SAME
// fractional (0-1) convention `PROTOCOL.md` already specifies for `PICK.anomalies`. One coordinate
// convention for both directions was the explicit requirement.
//
// THE FORMAT. The user's prose comes first, because that is what a human reads in the Slides
// comment pane; one machine-readable sentinel line comes last:
//
//     the chart lost its gridlines
//
//     sasha-slides-feedback={"protocolVersion":1,"noteId":"user_k2h9","pageObjectId":"g2d1",
//     "region":{"x":0.1,"y":0.2,"w":0.3,"h":0.2},"createdAt":"2026-10-04T12:00:00.000Z"}
//
// (one physical line; wrapped here for the comment). `region` is `null` for a note about the slide
// as a whole. A comment with no sentinel is somebody else's comment on the deck and is reported as
// `foreign` rather than as an error -- the replies view has to walk a pane it does not own.

import { PROTOCOL_VERSION, assertNever, isFractionalRegion, type Parsed, type Region } from "./protocol.ts";

/**
 * One note the user wrote about their own deck. The same value is both the sidebar's DRAFT and what
 * comes back out of a comment, so there is one shape to reason about.
 *
 * `region === null` means "about this slide", not "about nothing": a free-text comment is still
 * pinned to the page the user was looking at.
 */
export type ReviewNote = Readonly<{
  noteId: string;
  /**
   * The slide the note is about, or `null` for a note about the DECK as a whole -- which is what
   * a general conversation message is. The server half already reads this field as
   * `string | null` (`feedback/comment-anchor.ts`: `pageObjectId: string | null`), so a
   * page-less sentinel is a comment it reports as unanchored rather than one it cannot read.
   * An EMPTY string is still refused: that is a malformed page id, not an absent one.
   */
  pageObjectId: string | null;
  region: Region | null;
  text: string;
}>;

/** The sentinel that makes a comment ours. Last line of the body, one line, no whitespace in it. */
export const FEEDBACK_SENTINEL = "sasha-slides-feedback=";

/**
 * How many decimals of a fraction survive the round trip. Five is well inside
 * `isFractionalRegion`'s 1.0001 tolerance (worst-case drift 2e-5) and keeps the sentinel readable
 * for whoever has to debug it in the Slides comment pane.
 */
const REGION_DECIMALS = 5;

/** What one comment on the presentation turned out to be. */
export type FeedbackCommentRead =
  | Readonly<{ kind: "note"; note: ReviewNote; createdAt: string }>
  /** No sentinel: a human's own comment on the deck, which the replies view must skip silently. */
  | Readonly<{ kind: "foreign" }>
  /** Ours by the sentinel, but the sentinel does not parse. Surfaced, never guessed at. */
  | Readonly<{ kind: "unreadable"; reason: string }>;

/** One of our comments plus whatever has been said under it. The replies view renders these. */
export type FeedbackThread = Readonly<{
  commentId: string;
  note: ReviewNote;
  createdAt: string;
  resolved: boolean;
  replies: readonly FeedbackReply[];
}>;

export type FeedbackReply = Readonly<{
  replyId: string;
  author: string;
  createdAt: string;
  /** What to SHOW: the agent's marker is protocol and is taken off in `parseFeedbackReply`. */
  text: string;
  /**
   * Whether the agent wrote it. Not derivable from `author`: the connector posts as the
   * user's own Google account, so every reply in a thread carries the same display name.
   */
  authoredByAgent: boolean;
}>;

/**
 * One comment exactly as `sashaReadFeedback` relayed it from the Drive comments API. Parsed in
 * bridge.ts; interpreted here.
 */
export type FeedbackCommentRecord = Readonly<{
  commentId: string;
  content: string;
  createdAt: string;
  resolved: boolean;
  author: string;
  replies: readonly FeedbackReply[];
}>;

/** What `sashaSendFeedback` is handed: one already-rendered body per comment to create. */
export type SendFeedbackSpec = Readonly<{
  /** The presentation's Drive file id -- the same id the sidebar inserts slides into. */
  fileId: string;
  comments: readonly Readonly<{ content: string }>[];
}>;

/** Per-comment, because Drive can refuse one comment and accept the next. */
export type SendFeedbackResult = Readonly<{ commentId: string | null; error: string | null }>;

export type SendOutcome =
  | Readonly<{ kind: "sent"; count: number }>
  | Readonly<{ kind: "failed"; message: string }>;

/**
 * The bodies for a batch of notes, plus the notes that cannot be sent and why. Nothing is silently
 * dropped: a refused note stays on screen with its reason, which is the whole point of deciding
 * this in TypeScript rather than in `Code.gs`.
 */
export function feedbackCommentsFor({
  notes,
  createdAt,
}: {
  notes: readonly ReviewNote[];
  createdAt: string;
}): Readonly<{
  contents: readonly string[];
  refused: readonly Readonly<{ noteId: string; reason: string }>[];
}> {
  const contents: string[] = [];
  const refused: Readonly<{ noteId: string; reason: string }>[] = [];
  for (const note of notes) {
    const body = feedbackCommentContent({ note, createdAt });
    switch (body.kind) {
      case "ok":
        contents.push(body.value);
        break;
      case "invalid":
        refused.push({ noteId: note.noteId, reason: body.reason });
        break;
      case "unsupported-version":
        refused.push({ noteId: note.noteId, reason: `cannot write protocolVersion ${body.protocolVersion}` });
        break;
      default:
        return assertNever(body);
    }
  }
  return { contents, refused };
}

/**
 * One comment body, or why the note is unsendable. Mirrors `serializePick`: an impossible note is
 * refused in the sidebar instead of landing in the user's comment pane as garbage.
 */
export function feedbackCommentContent({
  note,
  createdAt,
}: {
  note: ReviewNote;
  createdAt: string;
}): Parsed<string> {
  const text = note.text.trim();
  if (text === "") return { kind: "invalid", reason: "a note with no text says nothing" };
  if (note.pageObjectId === "") return { kind: "invalid", reason: "a note names a page or no page, never an empty one" };
  if (note.region !== null && !isFractionalRegion(note.region)) {
    return { kind: "invalid", reason: "the marked region is not a 0-1 box" };
  }
  // The sentinel must survive a line-based read, so a note whose own prose carries one would make
  // the body ambiguous. Refusing is better than stripping something the user typed on purpose.
  if (text.includes(FEEDBACK_SENTINEL)) {
    return { kind: "invalid", reason: `a note may not contain "${FEEDBACK_SENTINEL}"` };
  }
  const sentinel = {
    protocolVersion: PROTOCOL_VERSION,
    noteId: note.noteId,
    pageObjectId: note.pageObjectId,
    region: note.region === null ? null : roundedRegion(note.region),
    createdAt,
  };
  return { kind: "ok", value: `${text}\n\n${FEEDBACK_SENTINEL}${JSON.stringify(sentinel)}` };
}

/**
 * Read one comment body back. The LAST sentinel line wins and everything above it is the user's
 * prose, so a body that has been quoted or appended to still reads correctly.
 */
export function readFeedbackComment(content: string): FeedbackCommentRead {
  const lines = content.split("\n");
  let sentinelAt = -1;
  for (let at = lines.length - 1; at >= 0; at--) {
    const line = lines[at];
    if (line !== undefined && line.trimStart().startsWith(FEEDBACK_SENTINEL)) {
      sentinelAt = at;
      break;
    }
  }
  if (sentinelAt < 0) return { kind: "foreign" };
  const sentinelLine = lines[sentinelAt] ?? "";
  const json = sentinelLine.trimStart().slice(FEEDBACK_SENTINEL.length).trim();
  const parsed = parseSentinel(json);
  switch (parsed.kind) {
    case "invalid":
      return { kind: "unreadable", reason: parsed.reason };
    case "unsupported-version":
      return { kind: "unreadable", reason: `feedback comment declares protocolVersion ${parsed.protocolVersion}` };
    case "ok": {
      const text = lines.slice(0, sentinelAt).join("\n").trim();
      if (text === "") return { kind: "unreadable", reason: "feedback comment carries a sentinel but no note" };
      return {
        kind: "note",
        note: {
          noteId: parsed.value.noteId,
          pageObjectId: parsed.value.pageObjectId,
          region: parsed.value.region,
          text,
        },
        createdAt: parsed.value.createdAt,
      };
    }
    default:
      return assertNever(parsed);
  }
}

/**
 * Our threads, newest first, out of every comment on the deck. Foreign comments are skipped and an
 * unreadable one of ours is reported in place, so the replies view can say "I wrote this and can no
 * longer read it" rather than quietly showing one fewer row.
 */
export function feedbackThreadsOf({
  records,
}: {
  records: readonly FeedbackCommentRecord[];
}): Readonly<{ threads: readonly FeedbackThread[]; unreadable: readonly string[] }> {
  const threads: FeedbackThread[] = [];
  const unreadable: string[] = [];
  for (const record of records) {
    const read = readFeedbackComment(record.content);
    switch (read.kind) {
      case "foreign":
        break;
      case "unreadable":
        unreadable.push(`${record.commentId}: ${read.reason}`);
        break;
      case "note":
        threads.push({
          commentId: record.commentId,
          note: read.note,
          // The Drive record's own timestamp outranks the sentinel's: the sentinel says when the
          // sidebar built the body, the record says when Google accepted it.
          createdAt: record.createdAt === "" ? read.createdAt : record.createdAt,
          resolved: record.resolved,
          replies: record.replies,
        });
        break;
      default:
        return assertNever(read);
    }
  }
  // Newest first: an answer the user is waiting for is about the thing they just sent.
  const ordered = [...threads].sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0));
  return { threads: ordered, unreadable };
}

/** How many of our threads have an answer in them -- the number the replies tab shows as a badge. */
export function answeredThreadCount(threads: readonly FeedbackThread[]): number {
  return threads.filter((thread) => thread.replies.length > 0).length;
}

/**
 * What a `sashaSendFeedback` reply means. A partial success is reported as a FAILURE with the count
 * that did land, because the user has to know which notes to retype -- but the notes that were
 * accepted are already in the deck, so the message says so rather than implying nothing happened.
 */
export function sendOutcomeOf({
  results,
  requested,
}: {
  results: readonly SendFeedbackResult[];
  requested: number;
}): SendOutcome {
  const created = results.filter((result) => result.commentId !== null).length;
  const errors = results.flatMap((result) => (result.error === null ? [] : [result.error]));
  if (results.length !== requested) {
    return {
      kind: "failed",
      message: `Drive answered for ${results.length} of ${requested} comments; ${created} were created.`,
    };
  }
  if (created === requested) return { kind: "sent", count: created };
  const first = errors[0] ?? "Drive reported no id and no error";
  return { kind: "failed", message: `only ${created} of ${requested} comments were created: ${first}` };
}

type Sentinel = Readonly<{
  noteId: string;
  pageObjectId: string | null;
  region: Region | null;
  createdAt: string;
}>;

function parseSentinel(json: string): Parsed<Sentinel> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(json);
  } catch (cause) {
    return { kind: "invalid", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  const record = asRecord(decoded);
  if (record === null) return { kind: "invalid", reason: "the feedback sentinel is not a JSON object" };
  const protocolVersion = record["protocolVersion"];
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) {
    return { kind: "invalid", reason: "the feedback sentinel has no integer protocolVersion" };
  }
  if (protocolVersion !== PROTOCOL_VERSION) return { kind: "unsupported-version", protocolVersion };
  const noteId = stringAt({ record, key: "noteId" });
  if (noteId === null || noteId === "") return { kind: "invalid", reason: "the feedback sentinel has no noteId" };
  // An ABSENT or null pageObjectId is a note about the deck as a whole (a conversation message);
  // an empty string is a malformed one and is still refused. See `ReviewNote.pageObjectId`.
  const pageField = record["pageObjectId"];
  if (pageField !== null && pageField !== undefined && typeof pageField !== "string") {
    return { kind: "invalid", reason: "the feedback sentinel's pageObjectId is not a string" };
  }
  const pageObjectId = typeof pageField === "string" ? pageField : null;
  if (pageObjectId === "") return { kind: "invalid", reason: "the feedback sentinel has an empty pageObjectId" };
  const region = parseRegion(record["region"]);
  if (region.kind !== "ok") return region;
  return {
    kind: "ok",
    value: { noteId, pageObjectId, region: region.value, createdAt: stringAt({ record, key: "createdAt" }) ?? "" },
  };
}

function parseRegion(field: unknown): Parsed<Region | null> {
  if (field === null || field === undefined) return { kind: "ok", value: null };
  const record = asRecord(field);
  if (record === null) return { kind: "invalid", reason: "region is neither an object nor null" };
  const sides = (["x", "y", "w", "h"] as const).map((key) => record[key]);
  if (!sides.every((side): side is number => typeof side === "number" && Number.isFinite(side))) {
    return { kind: "invalid", reason: "region needs finite x, y, w and h" };
  }
  // SAFETY: `sides` is a 4-element map over a 4-element tuple of literal keys and the guard above
  // narrowed every element to `number`, so these four reads cannot be undefined.
  const region: Region = { x: sides[0] ?? 0, y: sides[1] ?? 0, w: sides[2] ?? 0, h: sides[3] ?? 0 };
  return isFractionalRegion(region)
    ? { kind: "ok", value: region }
    : { kind: "invalid", reason: "region is outside the 0-1 box" };
}

function roundedRegion(region: Region): Region {
  return {
    x: roundFraction(region.x),
    y: roundFraction(region.y),
    w: roundFraction(region.w),
    h: roundFraction(region.h),
  };
}

function roundFraction(value: number): number {
  const scale = 10 ** REGION_DECIMALS;
  return Math.round(value * scale) / scale;
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
