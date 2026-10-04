// The feedback WIRE CONTRACT, both directions. These are the tests the other half of the product
// depends on: what a review note looks like once it is a Google Slides comment, and what comes back
// out of one. Pure values, no Drive, no Apps Script.

import assert from "node:assert/strict";
import test from "node:test";
import {
  FEEDBACK_SENTINEL,
  answeredThreadCount,
  feedbackCommentContent,
  feedbackCommentsFor,
  feedbackThreadsOf,
  readFeedbackComment,
  sendOutcomeOf,
  type FeedbackCommentRecord,
  type ReviewNote,
} from "./feedback.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

const AT = "2026-10-04T12:00:00.000Z";

const boxNote: ReviewNote = {
  noteId: "box_k2h9_1",
  pageObjectId: "g2d8c1f0a_0_1",
  region: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 },
  text: "the chart lost its gridlines",
};

const slideNote: ReviewNote = {
  noteId: "slide_k2h9_2",
  pageObjectId: "g2d8c1f0a_0_1",
  region: null,
  text: "this slide says too much",
};

test("a region note becomes the user's words plus one machine-readable sentinel line", () => {
  const body = feedbackCommentContent({ note: boxNote, createdAt: AT });
  assert.equal(body.kind, "ok");
  const content = body.kind === "ok" ? body.value : "";
  const lines = content.split("\n");
  assert.equal(lines[0], "the chart lost its gridlines", "the prose comes first, for a human");
  const sentinel = lines[lines.length - 1] ?? "";
  assert.ok(sentinel.startsWith(FEEDBACK_SENTINEL), "the sentinel is the last line");
  assert.deepEqual(JSON.parse(sentinel.slice(FEEDBACK_SENTINEL.length)), {
    protocolVersion: PROTOCOL_VERSION,
    noteId: "box_k2h9_1",
    pageObjectId: "g2d8c1f0a_0_1",
    region: { x: 0.1, y: 0.2, w: 0.3, h: 0.25 },
    createdAt: AT,
  });
});

test("a note not tied to a region carries region: null, not a whole-slide box", () => {
  const body = feedbackCommentContent({ note: slideNote, createdAt: AT });
  assert.equal(body.kind, "ok");
  const sentinel = JSON.parse((body.kind === "ok" ? body.value : "").split(FEEDBACK_SENTINEL)[1] ?? "{}");
  assert.equal(sentinel.region, null, "null means 'about this slide', and must not be faked as 0,0,1x1");
  assert.equal(sentinel.pageObjectId, "g2d8c1f0a_0_1", "it is still pinned to the page the user was on");
});

test("the fractional region survives the round trip unchanged", () => {
  const body = feedbackCommentContent({ note: boxNote, createdAt: AT });
  const read = readFeedbackComment(body.kind === "ok" ? body.value : "");
  assert.equal(read.kind, "note");
  if (read.kind !== "note") return;
  assert.deepEqual(read.note.region, boxNote.region);
  assert.equal(read.note.pageObjectId, boxNote.pageObjectId);
  assert.equal(read.note.noteId, boxNote.noteId);
  assert.equal(read.note.text, boxNote.text);
  assert.equal(read.createdAt, AT);
});

test("a long fraction is rounded, and the rounding stays inside the 0-1 box", () => {
  const body = feedbackCommentContent({
    note: { ...boxNote, region: { x: 1 / 3, y: 2 / 3, w: 1 / 3, h: 1 / 3 } },
    createdAt: AT,
  });
  assert.equal(body.kind, "ok");
  const read = readFeedbackComment(body.kind === "ok" ? body.value : "");
  // Rounding to 5 decimals drifts by at most 2e-5, well inside isFractionalRegion's tolerance --
  // which is the only thing that keeps x+w <= 1 from being violated on a bottom/right-edge box.
  assert.equal(read.kind, "note", "a rounded 2/3 + 1/3 box must still read back as valid");
});

test("a multi-line note keeps its line breaks and still parses", () => {
  const body = feedbackCommentContent({
    note: { ...boxNote, text: "the legend overlaps\nand the axis labels are cut off" },
    createdAt: AT,
  });
  const read = readFeedbackComment(body.kind === "ok" ? body.value : "");
  assert.equal(read.kind, "note");
  if (read.kind !== "note") return;
  assert.equal(read.note.text, "the legend overlaps\nand the axis labels are cut off");
});

test("a note with nothing in it, or a bad region, is refused rather than sent", () => {
  assert.equal(feedbackCommentContent({ note: { ...boxNote, text: "   " }, createdAt: AT }).kind, "invalid");
  assert.equal(feedbackCommentContent({ note: { ...boxNote, pageObjectId: "" }, createdAt: AT }).kind, "invalid");
  assert.equal(
    feedbackCommentContent({ note: { ...boxNote, region: { x: 0.9, y: 0, w: 0.5, h: 0.5 } }, createdAt: AT }).kind,
    "invalid",
    "a box that runs off the right edge is not a 0-1 box",
  );
});

test("a note that contains the sentinel itself is refused, because the body would be ambiguous", () => {
  const body = feedbackCommentContent({
    note: { ...boxNote, text: `look at ${FEEDBACK_SENTINEL}{"protocolVersion":1}` },
    createdAt: AT,
  });
  assert.equal(body.kind, "invalid");
});

test("a batch reports both the bodies to send and the notes it refused, with reasons", () => {
  const built = feedbackCommentsFor({ notes: [boxNote, { ...slideNote, text: "" }], createdAt: AT });
  assert.equal(built.contents.length, 1);
  assert.equal(built.refused.length, 1);
  assert.equal(built.refused[0]?.noteId, "slide_k2h9_2");
  assert.match(built.refused[0]?.reason ?? "", /no text/);
});

test("somebody else's comment on the deck is foreign, not an error", () => {
  assert.equal(readFeedbackComment("can we cut this slide?").kind, "foreign");
  assert.equal(readFeedbackComment("").kind, "foreign");
});

test("our own comment that no longer parses is reported, never guessed at", () => {
  assert.equal(readFeedbackComment(`note\n\n${FEEDBACK_SENTINEL}{not json`).kind, "unreadable");
  assert.equal(readFeedbackComment(`note\n\n${FEEDBACK_SENTINEL}{"protocolVersion":1}`).kind, "unreadable");
  const future = readFeedbackComment(`note\n\n${FEEDBACK_SENTINEL}{"protocolVersion":99,"noteId":"n","pageObjectId":"p"}`);
  assert.equal(future.kind, "unreadable");
  assert.match(future.kind === "unreadable" ? future.reason : "", /protocolVersion 99/);
});

test("a sentinel with no prose above it is unreadable -- a note with no words says nothing", () => {
  const body = feedbackCommentContent({ note: boxNote, createdAt: AT });
  const sentinelOnly = (body.kind === "ok" ? body.value : "").split("\n").slice(-1).join("\n");
  assert.equal(readFeedbackComment(sentinelOnly).kind, "unreadable");
});

test("the LAST sentinel wins, so an appended or quoted body still reads correctly", () => {
  const first = feedbackCommentContent({ note: boxNote, createdAt: AT });
  const second = feedbackCommentContent({ note: { ...slideNote, text: "the real note" }, createdAt: AT });
  const glued = `${first.kind === "ok" ? first.value : ""}\n${second.kind === "ok" ? second.value : ""}`;
  const read = readFeedbackComment(glued);
  assert.equal(read.kind, "note");
  if (read.kind !== "note") return;
  assert.equal(read.note.noteId, "slide_k2h9_2");
  assert.equal(read.note.text.split("\n").slice(-1)[0], "the real note");
});

test("the thread walk keeps our threads newest-first and skips the deck's own comments", () => {
  const ours = feedbackCommentContent({ note: boxNote, createdAt: AT });
  const alsoOurs = feedbackCommentContent({ note: slideNote, createdAt: AT });
  const records: readonly FeedbackCommentRecord[] = [
    record({ commentId: "c_old", content: ours.kind === "ok" ? ours.value : "", createdAt: "2026-10-04T10:00:00Z" }),
    record({ commentId: "c_human", content: "nice deck", createdAt: "2026-10-04T11:00:00Z" }),
    record({
      commentId: "c_new",
      content: alsoOurs.kind === "ok" ? alsoOurs.value : "",
      createdAt: "2026-10-04T12:00:00Z",
      replies: [{ replyId: "r_1", author: "Claude", createdAt: "2026-10-04T12:01:00Z", text: "trimmed it", authoredByAgent: true }],
    }),
    record({ commentId: "c_broken", content: `x\n\n${FEEDBACK_SENTINEL}{`, createdAt: "2026-10-04T09:00:00Z" }),
  ];
  const walked = feedbackThreadsOf({ records });
  assert.deepEqual(
    walked.threads.map((thread) => thread.commentId),
    ["c_new", "c_old"],
    "newest first, and the human's comment is not ours to show",
  );
  assert.equal(walked.unreadable.length, 1);
  assert.match(walked.unreadable[0] ?? "", /^c_broken: /);
  assert.equal(answeredThreadCount(walked.threads), 1);
  assert.equal(walked.threads[0]?.replies[0]?.text, "trimmed it");
  assert.equal(
    walked.threads[0]?.createdAt,
    "2026-10-04T12:00:00Z",
    "Drive's own timestamp outranks the sentinel's",
  );
});

test("a send is only 'sent' when every comment came back with an id", () => {
  assert.deepEqual(sendOutcomeOf({ results: [{ commentId: "c1", error: null }], requested: 1 }), {
    kind: "sent",
    count: 1,
  });
  const partial = sendOutcomeOf({
    results: [
      { commentId: "c1", error: null },
      { commentId: null, error: "HTTP 403: insufficient permissions" },
    ],
    requested: 2,
  });
  assert.equal(partial.kind, "failed");
  assert.match(partial.kind === "failed" ? partial.message : "", /only 1 of 2/);
  assert.match(partial.kind === "failed" ? partial.message : "", /403/);

  const short = sendOutcomeOf({ results: [{ commentId: "c1", error: null }], requested: 3 });
  assert.equal(short.kind, "failed");
  assert.match(short.kind === "failed" ? short.message : "", /1 of 3 comments/);
});

function record({
  commentId,
  content,
  createdAt,
  replies = [],
}: {
  commentId: string;
  content: string;
  createdAt: string;
  replies?: FeedbackCommentRecord["replies"];
}): FeedbackCommentRecord {
  return { commentId, content, createdAt, resolved: false, author: "Krunoslav", replies };
}
