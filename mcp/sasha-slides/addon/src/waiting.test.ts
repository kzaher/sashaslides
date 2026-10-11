// WHAT A WAIT CAN AND CANNOT CLAIM. waiting.ts is string-and-value in, value out, so every one of
// these is a few microseconds with no browser, no Drive and no clock of its own -- the clock is
// injected, which is the only way "it has been 14 minutes" is testable at all.
//
// THE FOUR PROPERTIES THESE PIN, which are the whole of UI-CONTRACT.md's "Waiting for Sasha must be
// honest":
//
//   1. a wait carries ELAPSED TIME, derived from an injected clock, and says "just now" rather than
//      inventing one when there is no clock;
//   2. presence is EVIDENCE, not a guess: only a session-log event in Sasha's voice or a reply
//      counts, and the newest of them is the answer;
//   3. "nobody has ever answered" is refused while any read that could disprove it is unfinished or
//      failed -- the same rule `UnresolvedCount` applies to the counts;
//   4. no sentence anywhere promises an ANSWER, because nothing readable can promise one;
//   5. DELIVERY, unlike an answer, IS knowable: a `feedback-delivered` receipt in the log is
//      positive evidence that a connected client read a comment, so past the shared threshold a
//      comment with no receipt is reported as "nobody listening" with an instruction -- never as a
//      spinner that counts up for ever, which is what a real user watched for 1 h 47 min.

import assert from "node:assert/strict";
import test from "node:test";
import type { FeedbackThread } from "./feedback.ts";
import {
  sessionEventsOf,
  type SessionEvent,
  type SessionEventFile,
  type SlideCommentsLoad,
  type SlideThread,
} from "./session-log.ts";
import {
  SASHA_PRECONDITION,
  deliveriesOf,
  describeElapsed,
  describeSashaPresence,
  describeWaitState,
  describeWaiting,
  describeWaitingWhat,
  elapsedMsOf,
  noDeliveries,
  nothingListeningOn,
  sashaPresenceOf,
  waitIsLive,
  waitingOn,
  type Deliveries,
  type PresenceReads,
} from "./waiting.ts";
import { FEEDBACK_DELIVERY_THRESHOLD_MS } from "../../feedback-delivery.ts";

const PROPOSAL = "p_1733219000000_a1b2c3";
const AT = "2026-10-04T12:00:00.000Z";
const NOW = Date.parse("2026-10-04T12:14:00.000Z");
const ALL_READ: PresenceReads = { incomplete: null };
const NONE: Deliveries = noDeliveries();

// --- what is waiting, and for how long ------------------------------------

test("both transports are one list, oldest first -- the longest wait is the one most likely to be alone", () => {
  const waiting = waitingOn({ deliveries: NONE, threads: [message()], comments: commentsWith([open()]), nowMs: NOW });
  assert.deepEqual(
    waiting.map((item) => [item.waitId, item.since]),
    [
      ["msg_c_1", AT],
      ["cc_cc_1", "2026-10-04T12:06:00.000Z"],
    ],
  );
  assert.deepEqual(waiting[0]?.what, { kind: "message" });
  assert.deepEqual(waiting[1]?.what, { kind: "comment", slideIndex: 2, region: null });
  assert.equal(waiting[0]?.elapsedMs, 14 * 60_000);
  assert.equal(waiting[1]?.elapsedMs, 8 * 60_000);
  // 14 min and 8 min with NO receipt are both past the threshold, so the pulse is OFF. It used to
  // be `true` here, which is the 1 h 47 min bug written down as an assertion.
  assert.equal(waitIsLive(waiting), false);
});

test("a resolved thread is not waiting, on either transport", () => {
  const waiting = waitingOn({
    deliveries: NONE,
    threads: [{ ...message(), resolved: true }],
    comments: commentsWith([{ ...open(), resolved: true }]),
    nowMs: NOW,
  });
  assert.deepEqual(waiting, []);
  assert.equal(waitIsLive(waiting), false);
  assert.equal(describeWaiting(waiting), "Nothing is waiting for Sasha.");
});

test("ON A CANDIDATE COMMENT A REPLY DOES NOT END THE WAIT: answered-not-resolved is still open", () => {
  // The contract's completion signal for a candidate comment is a RESOLVED thread with a revised
  // slide, not a reply -- and the server has `resolve_feedback` to close it with. So a replied-to
  // comment stays on the list, and the reply is rendered as what has come back so far, which is the
  // closest thing to "Sasha's thinking" this channel carries. There is no progress or thinking
  // transport in PROTOCOL.md; replies are all there is.
  const replied = {
    ...open(),
    replies: [{ replyId: "r_1", author: "Sasha", createdAt: "2026-10-04T12:09:00.000Z", text: "on it", authoredByAgent: true }],
  };
  const waiting = waitingOn({ deliveries: NONE, threads: [], comments: commentsWith([replied]), nowMs: NOW });
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]?.replies, 1);
  assert.equal(waiting[0]?.latestReply, "on it");
});

test("BUT ON A DECK MESSAGE A REPLY IS THE ANSWER, because nothing ever resolves a deck comment", () => {
  // The opposite failure to "no answer yet": a message that kept claiming to be waiting after Sasha
  // answered it would be a permanent false alarm, since there is no closing move for this transport.
  const replied: FeedbackThread = {
    ...message(),
    replies: [{ replyId: "r_1", author: "Sasha", createdAt: "2026-10-04T12:09:00.000Z", text: "here you go", authoredByAgent: true }],
  };
  assert.deepEqual(waitingOn({ deliveries: NONE, threads: [replied], comments: { kind: "unrequested" }, nowMs: NOW }), []);
});

test("a blank reply is no reply at all -- a quote of nothing says nothing", () => {
  const blank = {
    ...open(),
    replies: [{ replyId: "r_1", author: "Sasha", createdAt: "2026-10-04T12:09:00.000Z", text: "   ", authoredByAgent: true }],
  };
  const waiting = waitingOn({ deliveries: NONE, threads: [], comments: commentsWith([blank]), nowMs: NOW });
  assert.equal(waiting[0]?.latestReply, null);
  assert.equal(waiting[0]?.replies, 1, "but the reply itself is still counted");
});

test("the region a mark-up named travels with it, so a box is findable from the pinned list", () => {
  const region = { x: 0.1, y: 0.2, w: 0.3, h: 0.25 };
  const waiting = waitingOn({ deliveries: NONE, threads: [], comments: commentsWith([{ ...open(), region }]), nowMs: NOW });
  assert.deepEqual(waiting[0]?.what, { kind: "comment", slideIndex: 2, region });
  assert.equal(describeWaitingWhat({ kind: "comment", slideIndex: 2, region }), "you, on slide 2 at 10%,20% 30%x25%");
  assert.equal(describeWaitingWhat({ kind: "comment", slideIndex: 2, region: null }), "you, on slide 2");
  assert.equal(describeWaitingWhat({ kind: "message" }), "you, to Sasha");
});

test("a candidate Drive could not be read for contributes nothing, and blinds nobody else", () => {
  const partly: SlideCommentsLoad = {
    kind: "loaded",
    readAt: AT,
    slides: [
      { proposalId: PROPOSAL, slideIndex: 1, threads: { kind: "unreadable", message: "HTTP 404" } },
      { proposalId: PROPOSAL, slideIndex: 2, threads: { kind: "read", threads: [open()] } },
    ],
  };
  const waiting = waitingOn({ deliveries: NONE, threads: [], comments: partly, nowMs: NOW });
  assert.deepEqual(
    waiting.map((item) => item.waitId),
    ["cc_cc_1"],
  );
});

// --- the three states: delivered, waiting, nobody listening ---------------

test("THE 1 h 47 min BUG: no receipt past the threshold is an INSTRUCTION, never a spinner", () => {
  // Exactly what a real user watched: one comment, nothing attached, the clock counting up under a
  // pulse. The disclaimer below it was accurate and useless, because a count-up reads as progress.
  const nowMs = Date.parse(AT) + 107 * 60_000;
  const waiting = waitingOn({ deliveries: NONE, threads: [message()], comments: { kind: "unrequested" }, nowMs });
  assert.deepEqual(waiting[0]?.state, { kind: "nobody-listening", forMs: 107 * 60_000 });
  assert.equal(waitIsLive(waiting), false, "the pulse stops: there is nothing to pulse about");

  const notice = nothingListeningOn({ waiting });
  assert.notEqual(notice, null, "and the surface has something to SAY, not just something to show");
  assert.match(notice?.headline ?? "", /Nothing has picked this up in 5 minutes/);
  // The instruction names NO identifier. It used to name the proposal, on the reasoning that a
  // session cannot act without one -- true until `open_work` existed, and an opaque `p_…` in a
  // sentence written for a person is homework.
  assert.doesNotMatch(notice?.prompt ?? "", new RegExp(PROPOSAL));
  assert.match(notice?.prompt ?? "", /call open_work/);
  assert.match(notice?.connect ?? "", /^claude mcp add sasha-slides /);
  // And the headline over it says what 1 h 47 min MEANS, not just what it is.
  assert.equal(describeWaiting(waiting), "1 thing waiting for Sasha -- nothing has read the oldest for 1 h 47 min");
});

test("A DELIVERY RECEIPT IS POSITIVE EVIDENCE: the same wait is 'delivered', with no instruction", () => {
  const deliveries = deliveriesOf({ events: logOf([feedbackDelivered()]) });
  const waiting = waitingOn({ deliveries, threads: [], comments: commentsWith([open()]), nowMs: NOW });
  assert.deepEqual(waiting[0]?.state, { kind: "delivered", at: "2026-10-04T12:07:00.000Z", agoMs: 7 * 60_000 });
  assert.equal(nothingListeningOn({ waiting }), null);
  assert.equal(waitIsLive(waiting), true, "something read it, so the wait is a live one");
});

test("A RECEIPT IS NEVER AN ANSWER -- it is not a reply, and it promises nothing", () => {
  const deliveries = deliveriesOf({ events: logOf([feedbackDelivered()]) });
  const waiting = waitingOn({ deliveries, threads: [], comments: commentsWith([open()]), nowMs: NOW });
  assert.equal(waiting[0]?.replies, 0, "a receipt does not become a reply");
  assert.equal(waiting[0]?.latestReply, null, "and it is never quoted as one");
  const sentence = describeWaitState(waiting[0]?.state ?? { kind: "waiting", forMs: null });
  assert.match(sentence, /read/, "it says what happened: something read it");
  assert.doesNotMatch(sentence, /answered|is on its way|will answer|is writing/);
});

test("a receipt for ANOTHER comment delivers nothing here -- the contract names THIS comment", () => {
  const deliveries = deliveriesOf({ events: logOf([feedbackDelivered({ commentIds: ["cc_somebody_else"] })]) });
  const waiting = waitingOn({ deliveries, threads: [], comments: commentsWith([open()]), nowMs: NOW });
  assert.equal(waiting[0]?.state.kind, "nobody-listening");
});

test("UNDER the threshold nothing is accused and nothing is promised: it is just waiting", () => {
  const nowMs = Date.parse("2026-10-04T12:06:00.000Z") + FEEDBACK_DELIVERY_THRESHOLD_MS - 1_000;
  const waiting = waitingOn({ deliveries: NONE, threads: [], comments: commentsWith([open()]), nowMs });
  assert.deepEqual(waiting[0]?.state, { kind: "waiting", forMs: FEEDBACK_DELIVERY_THRESHOLD_MS - 1_000 });
  assert.equal(nothingListeningOn({ waiting }), null);
  assert.equal(waitIsLive(waiting), true);
  assert.doesNotMatch(describeWaitState(waiting[0]?.state ?? { kind: "waiting", forMs: null }), /is on its way|will answer/);
});

test("WITH NO CLOCK NOBODY IS ACCUSED: an unknowable elapsed time cannot cross a threshold", () => {
  const waiting = waitingOn({ deliveries: NONE, threads: [message()], comments: { kind: "unrequested" }, nowMs: null });
  assert.deepEqual(waiting[0]?.state, { kind: "waiting", forMs: null });
  assert.equal(nothingListeningOn({ waiting }), null);
});

test("the threshold is ONE constant, and it is the server's own", () => {
  // Not two fives. The server reads the same number for its long-poll default, which is why the
  // threshold is defensible at all: a connected client reads a comment well inside one poll.
  assert.equal(FEEDBACK_DELIVERY_THRESHOLD_MS, 300_000);
  const justUnder = waitingOn({
    deliveries: NONE,
    threads: [],
    comments: commentsWith([open()]),
    nowMs: Date.parse("2026-10-04T12:06:00.000Z") + FEEDBACK_DELIVERY_THRESHOLD_MS,
  });
  assert.equal(justUnder[0]?.state.kind, "nobody-listening", "the threshold itself has passed");
});

// --- the clock -------------------------------------------------------------

test("WITH NO CLOCK NOTHING IS INVENTED: elapsed is null and the words are 'just now'", () => {
  assert.equal(elapsedMsOf({ since: AT, nowMs: null }), null);
  assert.equal(describeElapsed(null), "just now");
  const waiting = waitingOn({ deliveries: NONE, threads: [message()], comments: { kind: "unrequested" }, nowMs: null });
  assert.equal(waiting[0]?.elapsedMs, null);
  assert.equal(describeWaiting(waiting), "1 thing waiting for Sasha -- the oldest for just now");
});

test("an unreadable timestamp is absence, not zero", () => {
  assert.equal(elapsedMsOf({ since: "not a date", nowMs: NOW }), null);
  assert.equal(elapsedMsOf({ since: "", nowMs: NOW }), null);
});

test("a clock behind Drive's clamps to zero rather than counting backwards", () => {
  // Drive's clock and the browser's are not the same clock. "waiting -3 s" reads as a bug.
  assert.equal(elapsedMsOf({ since: AT, nowMs: Date.parse(AT) - 3_000 }), 0);
  assert.equal(describeElapsed(0), "0 s");
});

test("the units are the ones a person would use, and seconds stop mattering after an hour", () => {
  assert.equal(describeElapsed(12_000), "12 s");
  assert.equal(describeElapsed(59_999), "59 s");
  assert.equal(describeElapsed(60_000), "1 min 00 s");
  assert.equal(describeElapsed(4 * 60_000 + 12_000), "4 min 12 s");
  assert.equal(describeElapsed(60 * 60_000), "1 h 00 min");
  assert.equal(describeElapsed(2 * 60 * 60_000 + 5 * 60_000), "2 h 05 min");
  assert.equal(describeElapsed(24 * 60 * 60_000), "1 day 00 h");
  assert.equal(describeElapsed(50 * 60 * 60_000), "2 days 02 h");
});

test("the headline counts the things and dates the oldest one", () => {
  const waiting = waitingOn({ deliveries: NONE, threads: [message()], comments: commentsWith([open()]), nowMs: NOW });
  // Not "the oldest for 14 min", which reads as progress: nothing has read it, and the headline says
  // what the number means rather than only what it is.
  assert.equal(describeWaiting(waiting), "2 things waiting for Sasha -- nothing has read the oldest for 14 min 00 s");

  // With a receipt the same two waits are an ordinary wait again, and the headline is the plain one.
  const heard = waitingOn({
    deliveries: deliveriesOf({ events: logOf([feedbackDelivered()]) }),
    threads: [message()],
    comments: commentsWith([open()]),
    nowMs: NOW,
  });
  assert.equal(describeWaiting(heard), "2 things waiting for Sasha -- the oldest for 14 min 00 s");
});

// --- presence: evidence, never a guess ------------------------------------

test("A SASHA-VOICED EVENT IS EVIDENCE, and the NEWEST piece of it is the answer", () => {
  const presence = sashaPresenceOf({
    events: logOf([commentOpened(), slideRevised()]),
    threads: [],
    comments: { kind: "unrequested" },
    reads: ALL_READ,
    nowMs: NOW,
  });
  assert.equal(presence.kind, "acted");
  assert.equal(presence.kind === "acted" ? presence.at : null, "2026-10-04T12:08:00.000Z");
  assert.equal(presence.kind === "acted" ? presence.agoMs : null, 6 * 60_000);
  assert.equal(describeSashaPresence(presence), "Sasha last did something here 6 min 00 s ago.");
});

test("THE USER'S OWN EVENTS ARE NOT EVIDENCE: a comment you opened proves nobody read it", () => {
  const presence = sashaPresenceOf({
    events: logOf([commentOpened()]),
    threads: [],
    comments: { kind: "unrequested" },
    reads: ALL_READ,
    nowMs: NOW,
  });
  assert.equal(presence.kind, "never-acted");
  assert.match(describeSashaPresence(presence), /Nothing has ever read or answered anything/);
});

test("a reply is evidence too, on either transport -- only an attached session can write one", () => {
  const byMessage = sashaPresenceOf({
    events: [],
    threads: [
      {
        ...message(),
        replies: [{ replyId: "r_1", author: "Sasha", createdAt: "2026-10-04T12:10:00.000Z", text: "done", authoredByAgent: true }],
      },
    ],
    comments: { kind: "unrequested" },
    reads: ALL_READ,
    nowMs: NOW,
  });
  assert.equal(byMessage.kind === "acted" ? byMessage.at : null, "2026-10-04T12:10:00.000Z");

  const byComment = sashaPresenceOf({
    events: [],
    threads: [],
    comments: commentsWith([
      {
        ...open(),
        replies: [{ replyId: "r_2", author: "Sasha", createdAt: "2026-10-04T12:11:00.000Z", text: "fixed", authoredByAgent: true }],
      },
    ]),
    reads: ALL_READ,
    nowMs: NOW,
  });
  assert.equal(byComment.kind === "acted" ? byComment.at : null, "2026-10-04T12:11:00.000Z");
});

test("'NOBODY HAS EVER ANSWERED' IS REFUSED while a read that could disprove it is not in", () => {
  const presence = sashaPresenceOf({
    events: [],
    threads: [],
    comments: { kind: "unrequested" },
    reads: { incomplete: "the event log is still being read" },
    nowMs: NOW,
  });
  assert.deepEqual(presence, { kind: "unknown", message: "the event log is still being read" });
  assert.match(describeSashaPresence(presence), /could not be checked: the event log is still being read/);
});

test("but EVIDENCE OUTRANKS AN UNFINISHED READ: proof already in hand is still proof", () => {
  const presence = sashaPresenceOf({
    events: logOf([slideRevised()]),
    threads: [],
    comments: { kind: "unrequested" },
    reads: { incomplete: "the candidates' comments are still being read" },
    nowMs: NOW,
  });
  assert.equal(presence.kind, "acted");
});

test("A RECEIPT IS PRESENCE EVIDENCE, and it outranks nothing but is itself outranked by an act", () => {
  // `read_feedback` and `await_feedback` used to be pure reads that left nothing in Drive, which is
  // why "is anyone there?" was unanswerable and `SashaPresence` deliberately had no positive arm.
  // They now leave a receipt, so the answer exists -- as `delivered`, which is weaker than `acted`.
  const receipt = sashaPresenceOf({
    events: logOf([feedbackDelivered()]),
    threads: [],
    comments: { kind: "unrequested" },
    reads: ALL_READ,
    nowMs: NOW,
  });
  assert.deepEqual(receipt, { kind: "delivered", at: "2026-10-04T12:07:00.000Z", agoMs: 7 * 60_000 });
  assert.match(describeSashaPresence(receipt), /read your comments/);

  // An actual act is stronger evidence than a read, so it wins even when the receipt is newer:
  // "it answered" says more than "it looked".
  const acted = sashaPresenceOf({
    events: logOf([slideRevised(), feedbackDelivered()]),
    threads: [],
    comments: { kind: "unrequested" },
    reads: ALL_READ,
    nowMs: NOW,
  });
  assert.equal(acted.kind, "acted");
});

test("NO SENTENCE ANYWHERE PROMISES AN ANSWER -- delivery is knowable, an answer never is", () => {
  // The rule that changed and the rule that did not. A receipt proves a client READ the comment, so
  // "something read it" is now sayable. Nothing proves an answer is coming, so no arm may imply one.
  for (const sentence of [
    describeSashaPresence({ kind: "never-acted" }),
    describeSashaPresence({ kind: "unknown", message: "x" }),
    describeSashaPresence({ kind: "acted", at: AT, agoMs: 1_000, heardAgoMs: 1_000 }),
    describeSashaPresence({ kind: "delivered", at: AT, agoMs: 1_000 }),
    describeWaitState({ kind: "delivered", at: AT, agoMs: 1_000 }),
    describeWaitState({ kind: "waiting", forMs: 1_000 }),
    describeWaitState({ kind: "nobody-listening", forMs: 600_000 }),
  ]) {
    assert.doesNotMatch(sentence, /is on its way|will answer|is writing|any moment/, sentence);
  }
  assert.match(SASHA_PRECONDITION, /connector attached and is polling/);
  assert.match(SASHA_PRECONDITION, /never promises an answer is coming/);
  // And the precondition no longer claims presence is unknowable, because a receipt disproved that.
  assert.doesNotMatch(SASHA_PRECONDITION, /cannot see whether one is attached/);
  assert.match(SASHA_PRECONDITION, /read/);
});

function message(): FeedbackThread {
  return {
    commentId: "c_1",
    note: { noteId: "n_1", pageObjectId: null, region: null, text: "make the agenda slide bluer" },
    createdAt: AT,
    resolved: false,
    replies: [],
  };
}

function open(): SlideThread {
  return {
    commentId: "cc_1",
    author: "Krunoslav",
    text: "the gridlines are gone",
    at: "2026-10-04T12:06:00.000Z",
    resolved: false,
    region: null,
    replies: [],
  };
}

function commentsWith(threads: readonly SlideThread[]): SlideCommentsLoad {
  return {
    kind: "loaded",
    readAt: AT,
    slides: [{ proposalId: PROPOSAL, slideIndex: 2, threads: { kind: "read", threads } }],
  };
}

function logOf(files: readonly Readonly<{ name: string; text: string }>[]): readonly SessionEvent[] {
  return sessionEventsOf({
    files: files.map(
      (file): SessionEventFile => ({
        proposalId: PROPOSAL,
        fileId: `drive_${file.name}`,
        name: file.name,
        text: file.text,
      }),
    ),
  });
}

function commentOpened(): Readonly<{ name: string; text: string }> {
  return {
    name: "1759579560000-aaaaaa-comment-opened.json",
    text: JSON.stringify({
      protocolVersion: 1,
      kind: "comment-opened",
      at: "2026-10-04T12:06:00.000Z",
      commentId: "cc_1",
      slideIndex: 2,
      text: "the gridlines are gone",
      region: null,
    }),
  };
}

/**
 * A `feedback-delivered` receipt, as the SERVER writes it: the comment ids it handed to a client
 * and when. Dated after the comment it delivers, because that is the only order Drive can produce.
 */
function feedbackDelivered(
  options: Readonly<{ commentIds?: readonly string[] }> = {},
): Readonly<{ name: string; text: string }> {
  return {
    name: "1759579620000-cccccc-feedback-delivered.json",
    text: JSON.stringify({
      protocolVersion: 1,
      kind: "feedback-delivered",
      at: "2026-10-04T12:07:00.000Z",
      tool: "await_feedback",
      commentIds: options.commentIds ?? ["cc_1", "c_1"],
    }),
  };
}

function slideRevised(): Readonly<{ name: string; text: string }> {
  return {
    name: "1759579680000-bbbbbb-slide-revised.json",
    text: JSON.stringify({
      protocolVersion: 1,
      kind: "slide-revised",
      at: "2026-10-04T12:08:00.000Z",
      slideIndex: 2,
      answers: ["cc_1"],
    }),
  };
}

/*
 * HOW TO CONNECT, BEFORE ANYTHING IS STUCK.
 *
 * The notice used to need a wait that had crossed the five-minute delivery threshold, so a user
 * who opened the add-on with no session attached saw no instructions at all: nothing was waiting,
 * so nothing could be unheard. They had to send a message and wait five minutes to be told how
 * to attach the session that would have answered it.
 */
test("NOTHING ATTACHED YET: the connect instructions show with nothing waiting at all", () => {
  const notice = nothingListeningOn({ waiting: [], presence: { kind: "never-acted" } });
  assert.notEqual(notice, null, "no session has ever acted, so say how to start one");
  assert.match(notice?.prompt ?? "", /sasha-slides/);
});

test("but an UNFINISHED read never claims it: absence of evidence is not evidence of absence", () => {
  assert.equal(
    nothingListeningOn({ waiting: [], presence: { kind: "unknown", message: "the log could not be read" } }),
    null,
  );
});

test("and a session that HAS acted is not told how to connect", () => {
  assert.equal(
    nothingListeningOn({ waiting: [], presence: { kind: "acted", at: "2026-10-06T10:25:00.000Z", agoMs: 1000, heardAgoMs: 1000 } }),
    null,
  );
  assert.equal(
    nothingListeningOn({ waiting: [], presence: { kind: "delivered", at: "2026-10-06T10:25:00.000Z", agoMs: 1000 } }),
    null,
  );
});

/*
 * NO BOT CONNECTED, AND THE NOTICE WENT AWAY (user report, 2026-10-11). Stale evidence is no
 * evidence, and the user's own reply is not Sasha's.
 */
test("STALE EVIDENCE IS NO LISTENER: an act or a receipt older than the threshold brings the notice back", () => {
  const old = FEEDBACK_DELIVERY_THRESHOLD_MS;
  assert.notEqual(
    nothingListeningOn({ waiting: [], presence: { kind: "acted", at: AT, agoMs: old, heardAgoMs: old } }),
    null,
  );
  assert.notEqual(nothingListeningOn({ waiting: [], presence: { kind: "delivered", at: AT, agoMs: old } }), null);
  // A receipt NEWER than the last act is the evidence that counts.
  assert.equal(
    nothingListeningOn({ waiting: [], presence: { kind: "acted", at: AT, agoMs: old * 3, heardAgoMs: 1_000 } }),
    null,
  );
  // Without a clock nobody is accused.
  assert.equal(
    nothingListeningOn({ waiting: [], presence: { kind: "acted", at: AT, agoMs: null, heardAgoMs: null } }),
    null,
  );
});

test("THE USER'S OWN REPLY is neither the answer to a deck message nor evidence that Sasha is here", () => {
  const selfReplied: FeedbackThread = {
    ...message(),
    replies: [{ replyId: "r_me", author: "Krunoslav", createdAt: "2026-10-04T12:13:00.000Z", text: "hello?", authoredByAgent: false }],
  };
  const waiting = waitingOn({ deliveries: NONE, threads: [selfReplied], comments: { kind: "unrequested" }, nowMs: NOW });
  assert.equal(waiting.length, 1, "still waiting on Sasha");
  assert.equal(waiting[0]?.state.kind, "nobody-listening");
  const presence = sashaPresenceOf({ events: [], threads: [selfReplied], comments: commentsWith([]), reads: ALL_READ, nowMs: NOW });
  assert.equal(presence.kind, "never-acted");
  assert.notEqual(nothingListeningOn({ waiting, presence }), null);
});
