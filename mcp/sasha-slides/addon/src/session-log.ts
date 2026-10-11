// THE ONE BOUNDARY against the server's session log, and the single place that knows the Drive
// shapes PROTOCOL.md's last section specifies. Both surfaces read it; neither reaches past it.
//
// WHY IT IS ONE FILE. The server half of this product is being built in parallel against the same
// protocol document, and the exact argument shapes of its `session_events` / `revise_slide` /
// `clear_slides` tools have not landed yet. Everything that would have to change when they do is
// here -- the event body fields, the file-name grammar, the per-candidate comment read -- so
// reconciling is one file's diff rather than a sweep through the UI.
//
// TWO THINGS LIVE HERE AND THEY ARE THE SAME PROTOCOL SECTION:
//
//   1. THE EVENT LOG. One file per event, named `<epochMillis>-<6 base36>-<kind>.json`, because
//      Drive has no append: a single `events.jsonl` would mean read-modify-write from two writers
//      that cannot see each other (the server and the add-on) and the loser's event would vanish.
//      Order by the millisecond prefix, then the suffix, THEN THE DRIVE FILE ID -- the first two
//      are not a total order, because two writers can mint the same pair and Drive allows duplicate
//      names. Sorting on fewer keys renders a different order than the server does.
//
//      LISTING THIS FOLDER IS THE "has anything happened" SIGNAL, and `manifest.revision` is the
//      separate "have the candidates changed" one. They are deliberately not the same: the add-on
//      appends events too, so if an event bumped `revision` the add-on would have to WRITE
//      `manifest.json` -- putting both writers back into the read-modify-write that one file per
//      event exists to prevent. Nothing here ever writes the manifest.
//
//      AN UNKNOWN `kind` IS NEVER DROPPED. It parses to `opaque` and renders as a "something
//      happened" line, because a reader on an older build must not silently show an incomplete
//      history. The same is true of a body that will not parse at all and of one declaring a
//      protocolVersion this build does not speak: all three become `opaque` with the reason.
//
//   2. THE UNRESOLVED COUNTS. A comment lives on the CANDIDATE -- a native Drive comment on
//      `NN.html` -- not on the deck, because the point is to mark a slide up BEFORE it is
//      inserted. Resolution is Drive's own `resolved` flag, so "unresolved count for slide N" is a
//      query over that file's open threads and the grid and the conversation are reading the same
//      source. `UnresolvedCount` is a UNION, not a number: a view that has not read the comments
//      yet, or could not, has no way to render a misleading zero because there is no zero to
//      render. That is how UI-CONTRACT.md's "the two must never disagree; if one cannot reach it,
//      it says so rather than showing zero" is enforced structurally rather than by care.
//
// NOTE ON SENTINELS. The deck-comment channel (feedback.ts) tags its comments with a sentinel so
// the add-on can tell its own threads from a human's. Candidate comments are deliberately NOT
// filtered that way: PROTOCOL.md says the count is "a query over that file's open comment
// threads", every one of them, and a candidate file has no other use. A sentinel IS still written
// when the user drew a box, because the region has to travel; it is read back here as a bonus, not
// as a filter.

import { FEEDBACK_DELIVERED_EVENT_KIND } from "../../feedback-delivery.ts";
import { readFeedbackComment, type FeedbackCommentRecord, type FeedbackReply } from "./feedback.ts";
import { PROTOCOL_VERSION, assertNever, type Parsed, type Region } from "./protocol.ts";

/** The subfolder of a proposal folder that holds the event files. PROTOCOL.md's name. */
export const SESSION_EVENTS_FOLDER = "events";

/** One event, as the log has it. `eventId` is the file's own name, which is also its order key. */
export type SessionEvent = Readonly<{
  eventId: string;
  /** Drive's own id for the file. The sort's last key, and the only one that is truly unique. */
  fileId: string;
  /** The millisecond prefix of the file name: the ORDER key, and the only one that is always there. */
  atMillis: number;
  /** When it happened, in words, for the screen. Empty when neither the name nor the body said. */
  at: string;
  proposalId: string;
  body: SessionEventBody;
}>;

export type SessionEventBody =
  | Readonly<{ kind: "slides-staged"; count: number; revision: number | null }>
  | Readonly<{ kind: "comment-opened"; commentId: string; slideIndex: number; text: string; region: Region | null }>
  | Readonly<{ kind: "comment-answered"; commentId: string; slideIndex: number; text: string }>
  | Readonly<{ kind: "slide-revised"; slideIndex: number; answers: readonly string[]; revision: number | null }>
  | Readonly<{ kind: "comment-resolved"; commentId: string; slideIndex: number }>
  | Readonly<{ kind: "slides-cleared"; count: number | null; reason: string | null }>
  | Readonly<{ kind: "slide-inserted"; slideIndex: number; pageObjectId: string | null }>
  /**
   * A CONNECTED CLIENT READ THESE COMMENTS. Written by the server when `read_feedback` or
   * `await_feedback` hands them over, and it is the ONLY entry in this log that proves something was
   * listening -- see waiting.ts. It is a receipt and never an answer: `commentIds` is who it
   * reached, not what it said, and this surface must never render it as a reply.
   */
  | Readonly<{ kind: "feedback-delivered"; commentIds: readonly string[]; tool: string | null }>
  /**
   * AN EVENT THIS BUILD CANNOT READ, kept so the history stays complete. `rawKind` is whatever the
   * file name or the body said, and `reason` is why it could not be read -- an unknown kind, an
   * unparseable body, or a protocolVersion from the future.
   */
  | Readonly<{ kind: "opaque"; rawKind: string; reason: string }>;

/** The kinds this build renders specifically. `opaque` is not one of them -- it is the fallback. */
export const SESSION_EVENT_KINDS = [
  "slides-staged",
  "comment-opened",
  "comment-answered",
  "slide-revised",
  "comment-resolved",
  "slides-cleared",
  "slide-inserted",
  FEEDBACK_DELIVERED_EVENT_KIND,
] as const;

export type KnownSessionEventKind = (typeof SESSION_EVENT_KINDS)[number];

/**
 * One event file exactly as `sashaReadEvents` relayed it: its Drive id, its name, its bytes, and
 * whose folder. The `fileId` is here for ONE reason -- it is the last tie-break of the sort, and
 * without it two events minted in the same millisecond with the same random suffix would order
 * differently here than on the server.
 */
export type SessionEventFile = Readonly<{ proposalId: string; fileId: string; name: string; text: string }>;

/**
 * THE WHOLE LOG, in order. Ordered by the file name's millisecond prefix with the base36 suffix as
 * the tie-break, exactly as PROTOCOL.md specifies -- never by the body's `at`, which is written by
 * whoever emitted the event and can disagree with the name.
 *
 * Nothing is dropped. A file whose name does not parse keeps its name as the order key's fallback
 * (0) and renders opaque, which puts it at the top rather than losing it.
 *
 * THREE KEYS, not two: millisecond prefix, then the whole file name (which carries the base36
 * suffix), then Drive's own file id. The first two are not a total order -- two writers can mint
 * the same prefix and suffix, and Drive allows duplicate names -- so a two-key sort is a different
 * order from the server's on exactly the collision the random suffix was meant to avoid.
 */
export function sessionEventsOf({ files }: { files: readonly SessionEventFile[] }): readonly SessionEvent[] {
  const events = files.map((file) => parseSessionEventFile(file));
  return [...events].sort((left, right) => {
    if (left.atMillis !== right.atMillis) return left.atMillis - right.atMillis;
    if (left.eventId !== right.eventId) return left.eventId < right.eventId ? -1 : 1;
    return left.fileId < right.fileId ? -1 : left.fileId > right.fileId ? 1 : 0;
  });
}

/**
 * ONE EVENT FILE, and this function is TOTAL: there is no input for which it returns nothing.
 * "An unknown `kind` is rendered as an opaque 'something happened' line, never dropped"
 * (PROTOCOL.md) is only enforceable if the parser cannot fail, so every failure is an `opaque`
 * event carrying the reason instead of an absence.
 */
export function parseSessionEventFile({ proposalId, fileId, name, text }: SessionEventFile): SessionEvent {
  const named = parseSessionEventName(name);
  const record = asRecord(parseJson(text));
  if (record === null) {
    return {
      eventId: name,
      fileId,
      atMillis: named?.atMillis ?? 0,
      at: "",
      proposalId,
      body: { kind: "opaque", rawKind: named?.kind ?? name, reason: "the event file is not a JSON object" },
    };
  }
  const at = stringAt({ record, key: "at" }) ?? "";
  const atMillis = named?.atMillis ?? millisOf(at);
  const protocolVersion = integerAt({ record, key: "protocolVersion" });
  // The body's own `kind` outranks the file name's: the name is a convenience for ordering and a
  // writer could have sanitised it, while the body is the record.
  const rawKind = stringAt({ record, key: "kind" }) ?? named?.kind ?? "";
  if (protocolVersion !== null && protocolVersion !== PROTOCOL_VERSION) {
    return {
      eventId: name,
      fileId,
      atMillis,
      at,
      proposalId,
      body: { kind: "opaque", rawKind, reason: `it declares protocolVersion ${protocolVersion}` },
    };
  }
  return { eventId: name, fileId, atMillis, at, proposalId, body: bodyOf({ rawKind, record }) };
}

/**
 * The file name's three parts, or null when it is not one of ours. `<epochMillis>-<6 base36>-<kind>.json`
 * -- and `kind` may itself contain hyphens, which is why the split is anchored rather than greedy.
 */
export function parseSessionEventName(name: string): SessionEventName | null {
  const matched = /^(\d{1,15})-([0-9a-z]{6})-([a-z][a-z0-9-]*)\.json$/.exec(name);
  if (matched === null) return null;
  const millis = matched[1];
  const suffix = matched[2];
  const kind = matched[3];
  if (millis === undefined || suffix === undefined || kind === undefined) return null;
  const atMillis = Number.parseInt(millis, 10);
  return Number.isFinite(atMillis) ? { atMillis, suffix, kind } : null;
}

export type SessionEventName = Readonly<{ atMillis: number; suffix: string; kind: string }>;

/**
 * The name to CREATE an event under. A write is a create -- which cannot clobber -- so the
 * uniqueness has to come from the name, and the suffix is the caller's randomness (the composition
 * root owns it, never a reducer).
 */
export function sessionEventFileName({
  atMillis,
  suffix,
  kind,
}: {
  atMillis: number;
  suffix: string;
  kind: KnownSessionEventKind;
}): Parsed<string> {
  if (!Number.isInteger(atMillis) || atMillis <= 0) {
    return { kind: "invalid", reason: "an event is named for the millisecond it happened" };
  }
  if (!/^[0-9a-z]{6}$/.test(suffix)) {
    return { kind: "invalid", reason: "an event's tie-break suffix is six base36 characters" };
  }
  return { kind: "ok", value: `${atMillis}-${suffix}-${kind}.json` };
}

/**
 * The bytes of an event the ADD-ON appends. It writes exactly two kinds -- `comment-opened` when
 * the user marks a candidate up, and `slide-inserted` when a candidate goes into the deck -- and
 * both are refused rather than written malformed, the same rule `serializePick` follows.
 */
export function serializeSessionEvent({ body, at }: { body: SessionEventBody; at: string }): Parsed<string> {
  if (at.trim() === "") return { kind: "invalid", reason: "an event is stamped with when it happened" };
  const fields = writableFieldsOf(body);
  if (fields === null) {
    return { kind: "invalid", reason: `this surface does not write ${body.kind} events` };
  }
  return { kind: "ok", value: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, at, kind: body.kind, ...fields }) };
}

/**
 * WHICH SLIDE AN EVENT IS ABOUT, or null when it is about the whole set. Derived through an
 * exhaustive switch so a new event kind has to answer the question rather than silently reading as
 * "no slide" -- which is what decides whether an unresolved count appears beside it.
 */
export function slideIndexOf(body: SessionEventBody): number | null {
  switch (body.kind) {
    case "comment-opened":
    case "comment-answered":
    case "slide-revised":
    case "comment-resolved":
    case "slide-inserted":
      return body.slideIndex;
    case "slides-staged":
    case "slides-cleared":
    // A receipt is about COMMENTS, which may span several candidates, so it belongs to no one
    // slide. waiting.ts matches it by comment id instead.
    case "feedback-delivered":
    case "opaque":
      return null;
    default:
      return assertNever(body);
  }
}

/**
 * WHETHER AN EVENT CHANGED THE CANDIDATE SET, which is what decides whether `manifest.json` has to
 * be read again. An exhaustive switch, so a new kind has to answer the question rather than
 * silently reading as "nothing changed" and leaving a cleared set on screen.
 *
 * This is the add-on's half of the protocol's split: LISTING `events/` is the "has anything
 * happened" signal, and `manifest.revision` is the "have the candidates changed" one. The add-on
 * never writes the manifest, so it reads it only when an event says the set moved.
 */
export function changesCandidateSet(body: SessionEventBody): boolean {
  switch (body.kind) {
    case "slides-staged":
    case "slide-revised":
    case "slides-cleared":
      return true;
    case "comment-opened":
    case "comment-answered":
    case "comment-resolved":
    case "slide-inserted":
    // Reading changes nothing. A receipt is the one event that is purely observational.
    case "feedback-delivered":
      return false;
    case "opaque":
      // An event this build cannot read MIGHT have changed the set. Re-reading a manifest that did
      // not change is one Drive call; showing a stale candidate set is a wrong picture.
      return true;
    default:
      return assertNever(body);
  }
}

/** The newest event that changed the set, or null. The manifest read is keyed on this. */
export function newestSetChangeIn(events: readonly SessionEvent[]): string | null {
  let newest: string | null = null;
  for (const event of events) if (changesCandidateSet(event.body)) newest = event.eventId;
  return newest;
}

/** Whose turn an event is. A comment the user opened belongs to the USER's turn (UI-CONTRACT.md). */
export function sessionEventVoiceOf(body: SessionEventBody): SessionEventVoice {
  switch (body.kind) {
    case "comment-opened":
      return "user";
    case "slides-staged":
    case "comment-answered":
    case "slide-revised":
    case "comment-resolved":
    case "slides-cleared":
      return "sasha";
    case "slide-inserted":
      return "deck";
    // ITS OWN VOICE, deliberately not `sasha`. A receipt proves a client READ the comment; the
    // sasha-voiced events all prove it ACTED. waiting.ts ranks the two differently -- "it answered"
    // says strictly more than "it looked" -- and one voice for both would collapse that.
    case "feedback-delivered":
      return "delivery";
    case "opaque":
      return "opaque";
    default:
      return assertNever(body);
  }
}

export type SessionEventVoice = "user" | "sasha" | "deck" | "delivery" | "opaque";

/** One line of prose per event, for the screen. The opaque arm is the "something happened" line. */
export function describeSessionEvent(body: SessionEventBody): string {
  switch (body.kind) {
    case "slides-staged":
      return body.count === 1 ? "Sasha staged 1 candidate slide" : `Sasha staged ${body.count} candidate slides`;
    case "comment-opened":
      return body.region === null
        ? `you commented on slide ${body.slideIndex}`
        : `you marked a box on slide ${body.slideIndex}`;
    case "comment-answered":
      return `Sasha answered your comment on slide ${body.slideIndex}`;
    case "slide-revised":
      return `Sasha revised slide ${body.slideIndex}`;
    case "comment-resolved":
      return `that comment on slide ${body.slideIndex} is resolved`;
    case "slides-cleared":
      return body.reason === null
        ? "Sasha discarded the candidates that were not inserted"
        : `Sasha discarded the candidates that were not inserted: ${body.reason}`;
    case "slide-inserted":
      return `slide ${body.slideIndex} went into the deck`;
    case "feedback-delivered":
      // "read", never "answered". The log line may not imply more than the receipt proves.
      return body.commentIds.length === 1
        ? "a Claude session read 1 of your comments"
        : `a Claude session read ${body.commentIds.length} of your comments`;
    case "opaque":
      // NEVER "nothing happened". The history is complete; this build just cannot read this line.
      return `something happened that this add-on cannot read (${body.rawKind === "" ? "no kind" : body.rawKind}) -- ${body.reason}`;
    default:
      return assertNever(body);
  }
}

// ---------------------------------------------------------------------------
// THE UNRESOLVED COUNTS. One source (the candidate's own Drive comments), one derivation, two
// views -- which is the only way UI-CONTRACT.md's "must never disagree" is more than a hope.
// ---------------------------------------------------------------------------

/**
 * How many open comment threads a slide has, as a UNION. There is deliberately no path from "not
 * read yet" or "could not be read" to the number 0: the type has no zero for those cases, so a
 * view cannot render one by accident.
 */
export type UnresolvedCount =
  | Readonly<{ kind: "known"; count: number }>
  // The server's `read_feedback` answers the same question the same way: its `unresolved[]` carries
  // `unresolved: null` -- never 0 -- for a candidate it could not read. The two arms below ARE that
  // null, kept apart so no view can format it as a zero.
  /** Nothing has been read yet. The view waits rather than claiming either answer. */
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "unreachable"; message: string }>;

/** One candidate's comment threads, or why they could not be read. Per-slide, because Drive is. */
export type SlideComments = Readonly<{
  proposalId: string;
  slideIndex: number;
  threads: SlideThreadsRead;
}>;

export type SlideThreadsRead =
  | Readonly<{ kind: "read"; threads: readonly SlideThread[] }>
  | Readonly<{ kind: "unreadable"; message: string }>;

/**
 * One comment thread on a candidate. Not a `FeedbackThread`: that type carries a parsed sentinel
 * and exists for the deck-comment channel, while a candidate thread is whatever is on the file --
 * including a comment typed straight into Drive, which still counts as unresolved.
 */
export type SlideThread = Readonly<{
  commentId: string;
  author: string;
  text: string;
  at: string;
  resolved: boolean;
  /** Where on the slide, when the comment carried our sentinel. Null for a whole-slide comment. */
  region: Region | null;
  replies: readonly FeedbackReply[];
}>;

/**
 * EVERY variant past `unrequested` carries the slides, including `loading` and `failed`. The
 * counts are polled, so a variant that dropped them would make every badge flicker to "unknown"
 * on each tick and a single bad poll would blank them -- UI-CONTRACT.md's "a re-read keeps what it
 * had", applied to the one number the two surfaces have to agree on.
 */
export type SlideCommentsLoad =
  | Readonly<{ kind: "unrequested" }>
  | Readonly<{ kind: "loading"; slides: readonly SlideComments[] }>
  | Readonly<{ kind: "loaded"; slides: readonly SlideComments[]; readAt: string }>
  | Readonly<{ kind: "failed"; message: string; slides: readonly SlideComments[] }>;

export const NO_SLIDE_COMMENTS: SlideCommentsLoad = { kind: "unrequested" };

/** One candidate's comments exactly as `sashaCandidateComments` relayed them. */
export type CandidateCommentFile = Readonly<{
  proposalId: string;
  slideIndex: number;
  comments: readonly FeedbackCommentRecord[];
  /** Drive refused this one file. The other slides' counts are still good. */
  error: string | null;
}>;

/**
 * THE READ, JOINED BACK TO THE SLIDES. `sashaCandidateComments` answers by FILE ID -- it has no
 * idea which candidate a file is -- so this is where the reply becomes per-slide. Both surfaces
 * call it, which is the other half of why they cannot disagree: the join is one function, not two
 * loops written twice.
 *
 * A SLIDE THE REPLY SAYS NOTHING ABOUT becomes an `unreadable` entry, never an empty one. Drive
 * answering for three of four files and the fourth badge silently reading "no open comments" is
 * exactly the failure `UnresolvedCount` exists to prevent.
 */
export function candidateCommentsFrom({
  proposalId,
  slides,
  entries,
}: {
  proposalId: string;
  slides: readonly CandidateFile[];
  entries: readonly CandidateCommentsEntry[];
}): readonly SlideComments[] {
  return slideCommentsOf({
    files: slides.map((slide) => {
      const found = entries.find((entry) => entry.fileId === slide.fileId);
      if (found === undefined) {
        return {
          proposalId,
          slideIndex: slide.slideIndex,
          comments: [],
          error: "Drive did not answer for this candidate",
        };
      }
      return { proposalId, slideIndex: slide.slideIndex, comments: found.comments, error: found.error };
    }),
  });
}

/** Which candidate a Drive file is. The only thing the join above needs from a slide. */
export type CandidateFile = Readonly<{ slideIndex: number; fileId: string }>;

/** One file's comments as `sashaCandidateComments` reported them. Re-declared nowhere else. */
export type CandidateCommentsEntry = Readonly<{
  fileId: string;
  comments: readonly FeedbackCommentRecord[];
  error: string | null;
}>;

/** The parse boundary: Drive comment records in, `SlideComments` out, one entry per candidate. */
export function slideCommentsOf({ files }: { files: readonly CandidateCommentFile[] }): readonly SlideComments[] {
  return files.map((file) => ({
    proposalId: file.proposalId,
    slideIndex: file.slideIndex,
    threads:
      file.error === null
        ? { kind: "read", threads: file.comments.map((record) => slideThreadOf(record)) }
        : { kind: "unreadable", message: file.error },
  }));
}

/**
 * THE ONE DERIVATION BOTH VIEWS CALL. The grid cell and the conversation row pass the same
 * `SlideCommentsLoad` through this function, so they cannot disagree about anything but how stale
 * their own poll is -- and they cannot disagree about whether the answer is known at all.
 */
export function unresolvedCountFor({
  comments,
  proposalId,
  slideIndex,
}: {
  comments: SlideCommentsLoad;
  proposalId: string;
  slideIndex: number;
}): UnresolvedCount {
  switch (comments.kind) {
    case "unrequested":
      return { kind: "unknown" };
    case "loading":
    case "loaded":
      return countIn({ slides: comments.slides, proposalId, slideIndex, whenMissing: { kind: "unknown" } });
    case "failed":
      // A failed re-read keeps the last good number for the slides it has; a slide it never read
      // says the read failed rather than claiming nothing is open on it.
      return countIn({
        slides: comments.slides,
        proposalId,
        slideIndex,
        whenMissing: { kind: "unreachable", message: comments.message },
      });
    default:
      return assertNever(comments);
  }
}

/** The badge's text. An exhaustive switch, so "unknown" can never be formatted as "0". */
export function describeUnresolvedCount(count: UnresolvedCount): string {
  switch (count.kind) {
    case "known":
      return count.count === 0 ? "no open comments" : `${count.count} open comment${count.count === 1 ? "" : "s"}`;
    case "unknown":
      return "open comments not read yet";
    case "unreachable":
      return `open comments could not be read: ${count.message}`;
    default:
      return assertNever(count);
  }
}

/** The short form for a cell badge: a number, a "?" or a "!" -- never a silent zero. */
export function unresolvedBadgeOf(count: UnresolvedCount): string | null {
  switch (count.kind) {
    case "known":
      return count.count === 0 ? null : String(count.count);
    case "unknown":
      return "?";
    case "unreachable":
      return "!";
    default:
      return assertNever(count);
  }
}

/**
 * EVERY OPEN THREAD, oldest first, across every candidate. UI-CONTRACT.md: "Open comments stay
 * listed until resolved. They do not scroll away into history" -- so the conversation pins this
 * list rather than relying on the user scrolling back to the event that opened each one.
 */
export function openThreadsOf({ comments }: { comments: SlideCommentsLoad }): readonly OpenThread[] {
  const open: OpenThread[] = [];
  for (const slide of loadedSlideComments(comments)) {
    if (slide.threads.kind === "unreadable") continue;
    for (const thread of slide.threads.threads) {
      if (thread.resolved) continue;
      open.push({ proposalId: slide.proposalId, slideIndex: slide.slideIndex, thread });
    }
  }
  return [...open].sort((left, right) =>
    left.thread.at < right.thread.at ? -1 : left.thread.at > right.thread.at ? 1 : 0,
  );
}

export type OpenThread = Readonly<{ proposalId: string; slideIndex: number; thread: SlideThread }>;

/** Which candidates could not be read, so a surface can say so once instead of per cell. */
export function unreadableSlidesOf({ comments }: { comments: SlideCommentsLoad }): readonly string[] {
  return loadedSlideComments(comments).flatMap((slide) =>
    slide.threads.kind === "unreadable" ? [`slide ${slide.slideIndex}: ${slide.threads.message}`] : [],
  );
}

/**
 * ONE CANDIDATE'S THREADS, or why they are not known.
 *
 * The same join `unresolvedCountFor` makes, handed over whole rather than counted -- the editor's
 * thread rail needs the threads themselves, and reading them through a second path is how two
 * surfaces start disagreeing about what was asked.
 *
 * A slide the read says nothing about is `unreadable`, never an empty list: "we could not look"
 * and "there is nothing" are different answers and the interface must not confuse them.
 */
export function threadsForSlide(
  options: Readonly<{ comments: SlideCommentsLoad; proposalId: string; slideIndex: number }>,
): SlideThreadsRead {
  const { comments, proposalId, slideIndex } = options;
  for (const slide of loadedSlideComments(comments)) {
    if (slide.proposalId === proposalId && slide.slideIndex === slideIndex) return slide.threads;
  }
  switch (comments.kind) {
    case "unrequested":
    case "loading":
      return { kind: "read", threads: [] };
    case "loaded":
      return { kind: "read", threads: [] };
    case "failed":
      return { kind: "unreadable", message: comments.message };
    default:
      return assertNever(comments);
  }
}

/** The comments to render: whatever was last read, even mid-poll and even after a failed one. */
export function loadedSlideComments(comments: SlideCommentsLoad): readonly SlideComments[] {
  switch (comments.kind) {
    case "loading":
    case "loaded":
    case "failed":
      return comments.slides;
    case "unrequested":
      return [];
    default:
      return assertNever(comments);
  }
}

/**
 * Whether the comment read should run. A predicate over the union rather than a bare
 * `kind === "unrequested"`, so adding a variant is a compile error here instead of a silently
 * skipped fetch.
 */
export function needsSlideComments(comments: SlideCommentsLoad): boolean {
  switch (comments.kind) {
    // A finished read wants another one: the counts and the threads are what a Claude session
    // is changing while the panel is open. Only a read already in flight answers "no".
    case "unrequested":
    case "loaded":
    case "failed":
      return true;
    case "loading":
      return false;
    default:
      return assertNever(comments);
  }
}

function slideThreadOf(record: FeedbackCommentRecord): SlideThread {
  // The sentinel is read for the REGION only. A comment without one is still a comment on this
  // candidate and still counts -- see the note at the top of this file.
  const read = readFeedbackComment(record.content);
  return {
    commentId: record.commentId,
    author: record.author,
    text: read.kind === "note" ? read.note.text : record.content,
    at: record.createdAt,
    resolved: record.resolved,
    region: read.kind === "note" ? read.note.region : null,
    replies: record.replies,
  };
}

function countIn({
  slides,
  proposalId,
  slideIndex,
  whenMissing,
}: {
  slides: readonly SlideComments[];
  proposalId: string;
  slideIndex: number;
  whenMissing: UnresolvedCount;
}): UnresolvedCount {
  const found = slides.find((slide) => slide.proposalId === proposalId && slide.slideIndex === slideIndex);
  if (found === undefined) return whenMissing;
  switch (found.threads.kind) {
    case "read":
      return { kind: "known", count: found.threads.threads.filter((thread) => !thread.resolved).length };
    case "unreadable":
      return { kind: "unreachable", message: found.threads.message };
    default:
      return assertNever(found.threads);
  }
}

/**
 * The fields an event body contributes beyond `{protocolVersion, at, kind}`, or null when this
 * surface has no business writing that kind. An exhaustive switch, so a new kind has to decide.
 */
function writableFieldsOf(body: SessionEventBody): Readonly<Record<string, unknown>> | null {
  switch (body.kind) {
    case "comment-opened":
      return {
        commentId: body.commentId,
        slideIndex: body.slideIndex,
        text: body.text,
        region: body.region,
      };
    case "slide-inserted":
      return { slideIndex: body.slideIndex, pageObjectId: body.pageObjectId };
    // Sasha's own events. The add-on reads them and never writes them: a `slides-cleared` the
    // add-on invented would say the server discarded something it still has.
    case "slides-staged":
    case "comment-answered":
    case "slide-revised":
    case "comment-resolved":
    case "slides-cleared":
    // AND THE RECEIPT, most of all: a delivery this add-on invented would be the add-on telling
    // itself that someone is listening. Only the server, handing a comment to a real client, may
    // write one -- that is what makes it evidence rather than decoration.
    case "feedback-delivered":
    case "opaque":
      return null;
    default:
      return assertNever(body);
  }
}

/**
 * The body, by kind. The default arm is the point of this function: anything this build has not
 * been taught becomes `opaque` with the kind it saw, so the line stays in the history.
 *
 * It is NOT an exhaustive switch over `KnownSessionEventKind`, and cannot be: `rawKind` is a
 * string off the wire, which is exactly the parse-boundary exception the style guide names. The
 * `KNOWN` table below it is the exhaustive half -- adding a kind to the union without adding it
 * there is a compile error.
 */
function bodyOf({ rawKind, record }: { rawKind: string; record: Readonly<Record<string, unknown>> }): SessionEventBody {
  switch (rawKind) {
    case "slides-staged":
      return {
        kind: "slides-staged",
        count: integerAt({ record, key: "count" }) ?? 0,
        revision: integerAt({ record, key: "revision" }),
      };
    case "comment-opened":
      return {
        kind: "comment-opened",
        commentId: stringAt({ record, key: "commentId" }) ?? "",
        slideIndex: integerAt({ record, key: "slideIndex" }) ?? 0,
        text: stringAt({ record, key: "text" }) ?? "",
        region: regionAt({ record, key: "region" }),
      };
    case "comment-answered":
      return {
        kind: "comment-answered",
        commentId: stringAt({ record, key: "commentId" }) ?? "",
        slideIndex: integerAt({ record, key: "slideIndex" }) ?? 0,
        text: stringAt({ record, key: "text" }) ?? "",
      };
    case "slide-revised":
      return {
        kind: "slide-revised",
        slideIndex: integerAt({ record, key: "slideIndex" }) ?? 0,
        answers: stringsAt({ record, key: "answers" }),
        revision: integerAt({ record, key: "revision" }),
      };
    case "comment-resolved":
      return {
        kind: "comment-resolved",
        commentId: stringAt({ record, key: "commentId" }) ?? "",
        slideIndex: integerAt({ record, key: "slideIndex" }) ?? 0,
      };
    case "slides-cleared":
      return {
        kind: "slides-cleared",
        count: integerAt({ record, key: "count" }),
        reason: stringAt({ record, key: "reason" }),
      };
    case "slide-inserted":
      return {
        kind: "slide-inserted",
        slideIndex: integerAt({ record, key: "slideIndex" }) ?? 0,
        pageObjectId: stringAt({ record, key: "pageObjectId" }),
      };
    case FEEDBACK_DELIVERED_EVENT_KIND: {
      const commentIds = stringsAt({ record, key: "commentIds" });
      // A receipt naming no comment cannot say WHICH comment reached anybody, so it may not read as
      // proof that any one of them did. Opaque keeps the line in the history without the claim.
      if (commentIds.length === 0) {
        return { kind: "opaque", rawKind, reason: "it is a delivery receipt that names no comment" };
      }
      return { kind: "feedback-delivered", commentIds, tool: stringAt({ record, key: "tool" }) };
    }
    default:
      return {
        kind: "opaque",
        rawKind,
        reason: rawKind === "" ? "it names no kind" : "this build does not know that kind of event",
      };
  }
}

/**
 * The exhaustive half of the parse above. It exists only to fail the build when a kind is added to
 * `SessionEventBody` and `bodyOf` is not taught it -- a `Record<KnownSessionEventKind, …>` cannot
 * be written with a key missing.
 */
const KNOWN_KIND_IS_PARSED: Readonly<Record<KnownSessionEventKind, true>> = {
  "slides-staged": true,
  "comment-opened": true,
  "comment-answered": true,
  "slide-revised": true,
  "comment-resolved": true,
  "slides-cleared": true,
  "slide-inserted": true,
  "feedback-delivered": true,
};

/** Whether `bodyOf` has a case for a kind. The one reader of the table above. */
export function isParsedSessionEventKind(candidate: string): candidate is KnownSessionEventKind {
  return Object.prototype.hasOwnProperty.call(KNOWN_KIND_IS_PARSED, candidate);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function millisOf(at: string): number {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : 0;
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
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
}

function stringsAt({ record, key }: { record: Readonly<Record<string, unknown>>; key: string }): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

function regionAt({ record, key }: { record: Readonly<Record<string, unknown>>; key: string }): Region | null {
  const value = asRecord(record[key]);
  if (value === null) return null;
  const x = integerOrFractionAt({ record: value, key: "x" });
  const y = integerOrFractionAt({ record: value, key: "y" });
  const w = integerOrFractionAt({ record: value, key: "w" });
  const h = integerOrFractionAt({ record: value, key: "h" });
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w, h };
}

function integerOrFractionAt({
  record,
  key,
}: {
  record: Readonly<Record<string, unknown>>;
  key: string;
}): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
