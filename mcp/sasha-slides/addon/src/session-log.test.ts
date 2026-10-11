// THE BOUNDARY: the session log's file grammar and parse, and the unresolved counts.
//
// These are the two things the whole rebuilt interface rests on, and both have a rule that is
// easier to break than to notice:
//
//   * NOTHING IS EVER DROPPED. An unknown kind, an unparseable body, a protocolVersion from the
//     future and a name that does not match the grammar all have to render, because a reader on an
//     older build must not silently show an incomplete history.
//   * THERE IS NO SILENT ZERO. A count that has not been read, or could not be, must be
//     distinguishable from "no open comments" at the type level, not by convention.
//
// The order follows session-log.ts's.

import assert from "node:assert/strict";
import test from "node:test";
import {
  candidateCommentsFrom,
  describeSessionEvent,
  describeUnresolvedCount,
  isParsedSessionEventKind,
  loadedSlideComments,
  needsSlideComments,
  openThreadsOf,
  parseSessionEventFile,
  parseSessionEventName,
  SESSION_EVENT_KINDS,
  serializeSessionEvent,
  sessionEventFileName,
  sessionEventVoiceOf,
  sessionEventsOf,
  slideCommentsOf,
  slideIndexOf,
  unreadableSlidesOf,
  unresolvedBadgeOf,
  unresolvedCountFor,
  type SessionEventFile,
  type SlideCommentsLoad,
} from "./session-log.ts";
import { feedbackCommentContent, type FeedbackCommentRecord } from "./feedback.ts";

const PROPOSAL = "p_1791115140000_a1b2c3";
const AT = "2026-10-04T12:06:00.000Z";

// --- ordering -------------------------------------------------------------

test("events are ordered by the file name's millisecond prefix, with the suffix as the tie-break", () => {
  const events = sessionEventsOf({
    files: [
      file({ name: "1791115800000-ffffff-comment-resolved.json", kind: "comment-resolved" }),
      file({ name: "1791115140000-bbbbbb-slides-staged.json", kind: "slides-staged" }),
      file({ name: "1791115140000-aaaaaa-slides-staged.json", kind: "slides-staged" }),
    ],
  });
  assert.deepEqual(
    events.map((event) => event.eventId),
    [
      "1791115140000-aaaaaa-slides-staged.json",
      "1791115140000-bbbbbb-slides-staged.json",
      "1791115800000-ffffff-comment-resolved.json",
    ],
  );
});

test("the order key is the NAME, not the body -- a body that disagrees does not reshuffle the log", () => {
  const events = sessionEventsOf({
    files: [
      {
        proposalId: PROPOSAL,
        fileId: "drive_a",
        name: "1791115140000-aaaaaa-slides-staged.json",
        // A body claiming a much later time. The name is what the protocol orders by.
        text: JSON.stringify({ protocolVersion: 1, at: "2027-01-01T00:00:00.000Z", kind: "slides-staged", count: 2 }),
      },
      file({ name: "1791115800000-ffffff-comment-resolved.json", kind: "comment-resolved" }),
    ],
  });
  assert.equal(events[0]?.body.kind, "slides-staged");
  assert.equal(events[0]?.atMillis, 1791115140000);
});

test("two writers minting the same name are ordered by Drive's file id -- the only unique key", () => {
  // The prefix and the suffix are NOT a total order: two writers can mint the same millisecond and
  // the same six random characters, and Drive allows duplicate names. A two-key sort would order
  // these differently from the server's.
  const events = sessionEventsOf({
    files: [
      file({ name: "1791115140000-aaaaaa-slides-staged.json", kind: "slides-staged", fileId: "drive_z" }),
      file({ name: "1791115140000-aaaaaa-slides-staged.json", kind: "slides-staged", fileId: "drive_a" }),
    ],
  });
  assert.deepEqual(
    events.map((event) => event.fileId),
    ["drive_a", "drive_z"],
  );
});

test("the file name grammar: millis, six base36, a kind that may itself contain hyphens", () => {
  assert.deepEqual(parseSessionEventName("1791115140000-a1b2c3-slides-staged.json"), {
    atMillis: 1791115140000,
    suffix: "a1b2c3",
    kind: "slides-staged",
  });
  assert.equal(parseSessionEventName("events.jsonl"), null);
  assert.equal(parseSessionEventName("1791115140000-A1B2C3-slides-staged.json"), null, "base36 is lower case");
  assert.equal(parseSessionEventName("1791115140000-a1b2-slides-staged.json"), null, "six characters, exactly");
  assert.equal(parseSessionEventName("1791115140000-a1b2c3-slides-staged.txt"), null);
});

// --- nothing is ever dropped ---------------------------------------------

test("AN UNKNOWN KIND is an opaque line carrying the kind it saw", () => {
  const event = parseSessionEventFile({
    proposalId: PROPOSAL,
    fileId: "drive_one",
    name: "1791115140000-aaaaaa-teleported-slide.json",
    text: JSON.stringify({ protocolVersion: 1, at: AT, kind: "teleported-slide", slideIndex: 2 }),
  });
  assert.deepEqual(event.body, {
    kind: "opaque",
    rawKind: "teleported-slide",
    reason: "this build does not know that kind of event",
  });
  assert.match(describeSessionEvent(event.body), /something happened that this add-on cannot read/);
});

test("A BODY THAT IS NOT JSON is an opaque line too, not an absence", () => {
  const event = parseSessionEventFile({
    proposalId: PROPOSAL,
    fileId: "drive_one",
    name: "1791115140000-aaaaaa-slides-staged.json",
    text: "{ this is not json",
  });
  assert.equal(event.body.kind, "opaque");
  assert.equal(event.atMillis, 1791115140000, "the name still orders it");
});

test("A PROTOCOLVERSION FROM THE FUTURE is opaque and says so, rather than being read optimistically", () => {
  const event = parseSessionEventFile({
    proposalId: PROPOSAL,
    fileId: "drive_one",
    name: "1791115140000-aaaaaa-slides-staged.json",
    text: JSON.stringify({ protocolVersion: 99, at: AT, kind: "slides-staged", count: 4 }),
  });
  assert.deepEqual(event.body, {
    kind: "opaque",
    rawKind: "slides-staged",
    reason: "it declares protocolVersion 99",
  });
});

test("A NAME THAT DOES NOT PARSE still produces an event, dated from the body", () => {
  const event = parseSessionEventFile({
    proposalId: PROPOSAL,
    fileId: "drive_one",
    name: "slides-staged.json",
    text: JSON.stringify({ protocolVersion: 1, at: AT, kind: "slides-staged", count: 2 }),
  });
  assert.equal(event.body.kind, "slides-staged");
  assert.equal(event.eventId, "slides-staged.json");
  assert.equal(event.atMillis, Date.parse(AT), "the body's own stamp is the fallback order key");
});

test("every kind the union declares has a case in the parse, by construction", () => {
  for (const kind of SESSION_EVENT_KINDS) assert.equal(isParsedSessionEventKind(kind), true);
  assert.equal(isParsedSessionEventKind("teleported-slide"), false);
});

test("every kind has a voice and says whether it is about one slide", () => {
  const parsed = sessionEventsOf({ files: SESSION_EVENT_KINDS.map((kind, at) => fullFile({ kind, at })) });
  assert.deepEqual(
    parsed.map((event) => [event.body.kind, sessionEventVoiceOf(event.body), slideIndexOf(event.body)]),
    [
      ["slides-staged", "sasha", null],
      ["comment-opened", "user", 2],
      ["comment-answered", "sasha", 2],
      ["slide-revised", "sasha", 2],
      ["comment-resolved", "sasha", 2],
      ["slides-cleared", "sasha", null],
      ["slide-inserted", "deck", 2],
      // ITS OWN VOICE, and no slide: a receipt is about comments, which may span candidates. It is
      // NOT `sasha` -- "something read this" and "Sasha did this" are different claims, and
      // waiting.ts ranks them differently.
      ["feedback-delivered", "delivery", null],
    ],
  );
});

// --- writing --------------------------------------------------------------

test("an event is NAMED for the millisecond it happened plus a six-base36 tie-break", () => {
  assert.deepEqual(sessionEventFileName({ atMillis: 1791115140000, suffix: "a1b2c3", kind: "comment-opened" }), {
    kind: "ok",
    value: "1791115140000-a1b2c3-comment-opened.json",
  });
  assert.equal(sessionEventFileName({ atMillis: 0, suffix: "a1b2c3", kind: "comment-opened" }).kind, "invalid");
  assert.equal(sessionEventFileName({ atMillis: 1, suffix: "A1B2C3", kind: "comment-opened" }).kind, "invalid");
});

test("the add-on writes the two kinds it causes, and REFUSES the ones that are Sasha's", () => {
  const opened = serializeSessionEvent({
    body: { kind: "comment-opened", commentId: "cc_1", slideIndex: 2, text: "gridlines gone", region: null },
    at: AT,
  });
  assert.equal(opened.kind, "ok");
  if (opened.kind !== "ok") return;
  assert.deepEqual(JSON.parse(opened.value), {
    protocolVersion: 1,
    at: AT,
    kind: "comment-opened",
    commentId: "cc_1",
    slideIndex: 2,
    text: "gridlines gone",
    region: null,
  });
  assert.equal(
    serializeSessionEvent({ body: { kind: "slides-cleared", count: 3, reason: null }, at: AT }).kind,
    "invalid",
    "a clear the add-on invented would say the server discarded something it still has",
  );
  assert.equal(
    serializeSessionEvent({ body: { kind: "slide-inserted", slideIndex: 1, pageObjectId: "g1" }, at: "" }).kind,
    "invalid",
    "an event with no stamp cannot be ordered",
  );
});

test("a written comment-opened round-trips back through the parse", () => {
  const serialized = serializeSessionEvent({
    body: {
      kind: "comment-opened",
      commentId: "cc_1",
      slideIndex: 3,
      text: "the chart is clipped",
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 },
    },
    at: AT,
  });
  assert.equal(serialized.kind, "ok");
  if (serialized.kind !== "ok") return;
  const read = parseSessionEventFile({
    proposalId: PROPOSAL,
    fileId: "drive_one",
    name: "1791115140000-a1b2c3-comment-opened.json",
    text: serialized.value,
  });
  assert.deepEqual(read.body, {
    kind: "comment-opened",
    commentId: "cc_1",
    slideIndex: 3,
    text: "the chart is clipped",
    region: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 },
  });
});

// --- the unresolved counts ------------------------------------------------

test("THERE IS NO SILENT ZERO: unread and unreachable are their own answers", () => {
  const unread: SlideCommentsLoad = { kind: "unrequested" };
  assert.deepEqual(unresolvedCountFor({ comments: unread, proposalId: PROPOSAL, slideIndex: 1 }), { kind: "unknown" });
  assert.equal(unresolvedBadgeOf({ kind: "unknown" }), "?");
  assert.match(describeUnresolvedCount({ kind: "unknown" }), /not read yet/);

  const broken: SlideCommentsLoad = { kind: "failed", message: "Drive HTTP 403", slides: [] };
  assert.deepEqual(unresolvedCountFor({ comments: broken, proposalId: PROPOSAL, slideIndex: 1 }), {
    kind: "unreachable",
    message: "Drive HTTP 403",
  });
  assert.equal(unresolvedBadgeOf({ kind: "unreachable", message: "x" }), "!");

  assert.equal(unresolvedBadgeOf({ kind: "known", count: 0 }), null, "a real zero shows no badge at all");
  assert.equal(unresolvedBadgeOf({ kind: "known", count: 3 }), "3");
  assert.equal(describeUnresolvedCount({ kind: "known", count: 1 }), "1 open comment");
});

test("resolved threads do not count, and the count is per slide", () => {
  const comments = loaded([
    { slideIndex: 1, records: [record({ id: "a", resolved: false }), record({ id: "b", resolved: true })] },
    { slideIndex: 2, records: [] },
  ]);
  assert.deepEqual(unresolvedCountFor({ comments, proposalId: PROPOSAL, slideIndex: 1 }), { kind: "known", count: 1 });
  assert.deepEqual(unresolvedCountFor({ comments, proposalId: PROPOSAL, slideIndex: 2 }), { kind: "known", count: 0 });
});

test("a failed re-read keeps the counts it has, and only an unread slide reads as unreachable", () => {
  const stale: SlideCommentsLoad = {
    kind: "failed",
    message: "Drive HTTP 500",
    slides: slideCommentsOf({
      files: [{ proposalId: PROPOSAL, slideIndex: 1, comments: [record({ id: "a", resolved: false })], error: null }],
    }),
  };
  assert.deepEqual(unresolvedCountFor({ comments: stale, proposalId: PROPOSAL, slideIndex: 1 }), {
    kind: "known",
    count: 1,
  });
  assert.deepEqual(unresolvedCountFor({ comments: stale, proposalId: PROPOSAL, slideIndex: 2 }), {
    kind: "unreachable",
    message: "Drive HTTP 500",
  });
});

test("a PER-FILE Drive failure is per slide: one bad candidate does not blind the others", () => {
  const comments: SlideCommentsLoad = {
    kind: "loaded",
    readAt: AT,
    slides: slideCommentsOf({
      files: [
        { proposalId: PROPOSAL, slideIndex: 1, comments: [record({ id: "a", resolved: false })], error: null },
        { proposalId: PROPOSAL, slideIndex: 2, comments: [], error: "Drive HTTP 404" },
      ],
    }),
  };
  assert.deepEqual(unresolvedCountFor({ comments, proposalId: PROPOSAL, slideIndex: 1 }), { kind: "known", count: 1 });
  assert.deepEqual(unresolvedCountFor({ comments, proposalId: PROPOSAL, slideIndex: 2 }), {
    kind: "unreachable",
    message: "Drive HTTP 404",
  });
  assert.deepEqual(unreadableSlidesOf({ comments }), ["slide 2: Drive HTTP 404"]);
});

test("A SLIDE DRIVE DID NOT ANSWER FOR is unreadable, not empty -- the join does not invent a zero", () => {
  const joined = candidateCommentsFrom({
    proposalId: PROPOSAL,
    slides: [
      { slideIndex: 1, fileId: "html_1" },
      { slideIndex: 2, fileId: "html_2" },
    ],
    entries: [{ fileId: "html_1", comments: [record({ id: "a", resolved: false })], error: null }],
  });
  const comments: SlideCommentsLoad = { kind: "loaded", readAt: AT, slides: joined };
  assert.deepEqual(unresolvedCountFor({ comments, proposalId: PROPOSAL, slideIndex: 2 }), {
    kind: "unreachable",
    message: "Drive did not answer for this candidate",
  });
});

test("A COMMENT WITH NO SENTINEL still counts -- the count is every open thread on the file", () => {
  const comments = loaded([
    { slideIndex: 1, records: [{ ...record({ id: "a", resolved: false }), content: "typed straight into Drive" }] },
  ]);
  assert.deepEqual(unresolvedCountFor({ comments, proposalId: PROPOSAL, slideIndex: 1 }), { kind: "known", count: 1 });
  const threads = loadedSlideComments(comments)[0]?.threads;
  assert.equal(threads?.kind === "read" ? threads.threads[0]?.text : "", "typed straight into Drive");
  assert.equal(threads?.kind === "read" ? threads.threads[0]?.region : "unset", null);
});

test("a comment that DOES carry our sentinel keeps its region and its prose", () => {
  const body = feedbackCommentContent({
    note: { noteId: "box_1", pageObjectId: null, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }, text: "gridlines gone" },
    createdAt: AT,
  });
  assert.equal(body.kind, "ok");
  if (body.kind !== "ok") return;
  const comments = loaded([
    { slideIndex: 1, records: [{ ...record({ id: "a", resolved: false }), content: body.value }] },
  ]);
  const threads = loadedSlideComments(comments)[0]?.threads;
  assert.equal(threads?.kind === "read" ? threads.threads[0]?.text : "", "gridlines gone");
  assert.deepEqual(threads?.kind === "read" ? threads.threads[0]?.region : null, {
    x: 0.1,
    y: 0.2,
    w: 0.3,
    h: 0.2,
  });
});

test("the open threads are every unresolved one, oldest first, across every candidate", () => {
  const comments = loaded([
    { slideIndex: 1, records: [record({ id: "late", resolved: false, at: "2026-10-04T12:09:00.000Z" })] },
    {
      slideIndex: 2,
      records: [
        record({ id: "early", resolved: false, at: "2026-10-04T12:01:00.000Z" }),
        record({ id: "done", resolved: true, at: "2026-10-04T12:02:00.000Z" }),
      ],
    },
  ]);
  assert.deepEqual(
    openThreadsOf({ comments }).map((open) => [open.slideIndex, open.thread.commentId]),
    [
      [2, "early"],
      [1, "late"],
    ],
  );
});

/**
 * ONE read in flight at a time, and a NEW read on every poll.
 *
 * This used to assert the opposite -- that a finished read wants no other -- which is what
 * froze the conversation after its first load (see conversation-state.test.ts). The counts
 * and threads here are what a Claude session changes while the panel is open, so "loaded" is
 * a reason to read again, not a reason to stop.
 */
test("one comment read at a time, and a fresh one on every poll", () => {
  assert.equal(needsSlideComments({ kind: "unrequested" }), true);
  assert.equal(needsSlideComments({ kind: "loading", slides: [] }), false);
  assert.equal(needsSlideComments({ kind: "loaded", slides: [], readAt: AT }), true);
  assert.equal(needsSlideComments({ kind: "failed", message: "x", slides: [] }), true);
});

function file({ name, kind, fileId }: { name: string; kind: string; fileId?: string }): SessionEventFile {
  return {
    proposalId: PROPOSAL,
    fileId: fileId ?? `drive_${name}`,
    name,
    text: JSON.stringify({ protocolVersion: 1, at: AT, kind, slideIndex: 2, count: 2, commentId: "cc_1" }),
  };
}

/** One file per kind, stamped a minute apart so `sessionEventsOf` keeps them in declaration order. */
function fullFile({ kind, at }: { kind: string; at: number }): SessionEventFile {
  const suffix = "abcdef";
  return {
    proposalId: PROPOSAL,
    fileId: `drive_${kind}`,
    name: `${1791115140000 + at * 60_000}-${suffix}-${kind}.json`,
    text: JSON.stringify({
      protocolVersion: 1,
      at: AT,
      kind,
      count: 3,
      slideIndex: 2,
      commentId: "cc_1",
      text: "gridlines gone",
      answers: ["cc_1"],
      revision: 2,
      reason: "superseded",
      pageObjectId: "g_new",
      commentIds: ["cc_1"],
      tool: "await_feedback",
    }),
  };
}

function loaded(
  slides: readonly Readonly<{ slideIndex: number; records: readonly FeedbackCommentRecord[] }>[],
): SlideCommentsLoad {
  return {
    kind: "loaded",
    readAt: AT,
    slides: slideCommentsOf({
      files: slides.map((slide) => ({
        proposalId: PROPOSAL,
        slideIndex: slide.slideIndex,
        comments: slide.records,
        error: null,
      })),
    }),
  };
}

function record({
  id,
  resolved,
  at = AT,
}: {
  id: string;
  resolved: boolean;
  at?: string;
}): FeedbackCommentRecord {
  return { commentId: id, content: "a comment", createdAt: at, resolved, author: "Krunoslav", replies: [] };
}
