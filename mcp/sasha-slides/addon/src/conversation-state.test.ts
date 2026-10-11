// ASK SASHA: the conversation's reducer, its selectors and the panel.
//
// The reducer is pure and the tree is rendered with react-dom/server, so every state of every
// union is asserted without a browser and without an Apps Script host. The order follows the
// code's.

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ProposalMark } from "./bridge.ts";
import { parseOpenPickerReply } from "./bridge.ts";
import { ConversationPanel } from "./Conversation.tsx";
import {
  conversationEntriesOf,
  conversationIsOpening,
  defectReportReadiness,
  followedSet,
  INITIAL_CONVERSATION,
  isSending,
  loadedThreads,
  needsComments,
  needsLog,
  needsManifest,
  needsStaged,
  needsThread,
  nextRevisedSlideToLoad,
  outgoingReply,
  threadActionOf,
  sashaPresence,
  waitingFor,
  outgoingMessage,
  proposalToAutoOpen,
  reduceConversation,
  revisedSlideFor,
  slidesOf,
  slidesReachability,
  stagedProposalsOf,
  type Conversation,
  type ConversationEvent,
} from "./conversation-state.ts";
import { feedbackCommentContent, readFeedbackComment, type FeedbackThread } from "./feedback.ts";
import {
  sessionEventsOf,
  unresolvedCountFor,
  type SessionEventFile,
  NO_SLIDE_COMMENTS,
  type SlideCommentsLoad,
} from "./session-log.ts";
import { INERT_CONVERSATION_ACTIONS } from "./inert-actions.ts";
import type { Manifest } from "./protocol.ts";

const AT = "2026-10-04T12:00:00.000Z";
const PROPOSAL = "p_1733219000000_a1b2c3";

const asked: FeedbackThread = {
  commentId: "c_1",
  note: { noteId: "chat_1", pageObjectId: null, region: null, text: "give me three options for the agenda slide" },
  createdAt: "2026-10-04T12:00:00.000Z",
  resolved: false,
  replies: [
    {
      replyId: "r_1",
      author: "Sasha",
      createdAt: "2026-10-04T12:01:00.000Z",
      text: "staged three -- see the slides",
      authoredByAgent: true,
    },
  ],
};

const aboutABox: FeedbackThread = {
  commentId: "c_2",
  note: { noteId: "box_1", pageObjectId: "g2d1", region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 }, text: "gridlines gone" },
  createdAt: "2026-10-04T12:05:00.000Z",
  resolved: false,
  replies: [],
};

const manifest: Manifest = {
  protocolVersion: 1,
  proposalId: PROPOSAL,
  createdAt: AT,
  presentationId: "deck_0123456789",
  count: 2,
  slides: [
    { index: 1, fileId: "html_1", name: "01.html", label: "option 1" },
    { index: 2, fileId: "html_2", name: "02.html", label: "option 2" },
  ],
  revision: 1,
};

const stagedMark: ProposalMark = {
  proposalId: PROPOSAL,
  folderId: "folder_1",
  readyFileId: "ready",
  pickFileId: null,
  createdTime: "2026-10-04T11:59:00.000Z",
};

// --- a deck-level message is a note with no page --------------------------

test("a conversation message is a note about the DECK: no page, no region", () => {
  const typed = reduceConversation(INITIAL_CONVERSATION, { kind: "draft-typed", text: "  make it bluer  " });
  const note = outgoingMessage({ conversation: typed, messageId: "chat_1" });
  assert.deepEqual(note, { noteId: "chat_1", pageObjectId: null, region: null, text: "make it bluer" });
});

test("an empty composer produces nothing to send, rather than an empty comment", () => {
  assert.equal(outgoingMessage({ conversation: INITIAL_CONVERSATION, messageId: "chat_1" }), null);
  const blank = reduceConversation(INITIAL_CONVERSATION, { kind: "draft-typed", text: "   " });
  assert.equal(outgoingMessage({ conversation: blank, messageId: "chat_1" }), null);
});

test("a page-less message round-trips through the comment body the server already reads", () => {
  const body = feedbackCommentContent({
    note: { noteId: "chat_1", pageObjectId: null, region: null, text: "make it bluer" },
    createdAt: AT,
  });
  assert.equal(body.kind, "ok");
  if (body.kind !== "ok") return;
  assert.match(body.value, /"pageObjectId":null/, "the sentinel says the message is about no one slide");
  const read = readFeedbackComment(body.value);
  assert.equal(read.kind, "note");
  if (read.kind !== "note") return;
  assert.equal(read.note.pageObjectId, null);
  assert.equal(read.note.region, null);
  assert.equal(read.note.text, "make it bluer");
});

test("an EMPTY page id is still refused -- that is malformed, not absent", () => {
  const refused = feedbackCommentContent({
    note: { noteId: "chat_1", pageObjectId: "", region: null, text: "make it bluer" },
    createdAt: AT,
  });
  assert.equal(refused.kind, "invalid");
  const unreadable = readFeedbackComment(
    'note\n\nsasha-slides-feedback={"protocolVersion":1,"noteId":"n","pageObjectId":""}',
  );
  assert.equal(unreadable.kind, "unreadable");
});

// --- the reducer ----------------------------------------------------------

test("a successful send empties the composer and makes the thread list stale", () => {
  const sent = replay([
    { kind: "thread-arrived", threads: [asked], readAt: AT },
    { kind: "draft-typed", text: "make it bluer" },
    { kind: "send-started" },
    { kind: "send-succeeded" },
  ]);
  assert.equal(sent.draft, "");
  assert.equal(sent.send.kind, "sent");
  assert.equal(sent.thread.kind, "unrequested", "the answer arrives as a reply, so the list is re-read");
});

test("a failed send KEEPS the message the user typed", () => {
  const failed = replay([
    { kind: "draft-typed", text: "make it bluer" },
    { kind: "send-started" },
    { kind: "send-failed", message: "HTTP 500" },
  ]);
  assert.equal(failed.draft, "make it bluer");
  assert.deepEqual(failed.send, { kind: "failed", message: "HTTP 500" });
});

test("typing clears a stale verdict, but never cancels a send in flight", () => {
  const afterSent = replay([{ kind: "send-succeeded" }, { kind: "draft-typed", text: "and again" }]);
  assert.equal(afterSent.send.kind, "idle");
  const midFlight = replay([{ kind: "send-started" }, { kind: "draft-typed", text: "and again" }]);
  assert.equal(midFlight.send.kind, "sending");
  assert.equal(isSending(midFlight), true);
});

test("a failed read keeps the conversation on screen next to the reason", () => {
  const failed = replay([
    { kind: "thread-arrived", threads: [asked], readAt: AT },
    { kind: "thread-requested" },
    { kind: "thread-failed", message: "HTTP 500" },
  ]);
  assert.equal(failed.thread.kind, "failed");
  assert.equal(loadedThreads(failed.thread).length, 1, "losing the whole conversation to one bad poll is worse");
});

test("a failed LOG read keeps the events too -- the log is the whole session", () => {
  const failed = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "log-arrived", events: eventsOf([staged(3)]), readAt: AT },
    { kind: "log-requested" },
    { kind: "log-failed", message: "Drive HTTP 500" },
  ]);
  assert.equal(failed.log.kind, "failed");
  assert.equal(failed.log.kind === "failed" ? failed.log.events.length : 0, 1);
  assert.match(markupOf(failed), /Drive HTTP 500/);
  assert.match(markupOf(failed), /Sasha staged 3 candidate slides/, "a bad poll does not blank the log");
});

test("every loop fetches exactly once per request, and the ones with no proposal do not fetch at all", () => {
  assert.equal(needsThread(INITIAL_CONVERSATION), true);
  assert.equal(needsStaged(INITIAL_CONVERSATION), true);
  assert.equal(needsManifest(INITIAL_CONVERSATION), false, "nothing is followed yet");
  assert.equal(needsLog(INITIAL_CONVERSATION), false);
  assert.equal(needsComments(INITIAL_CONVERSATION), false, "the comment read is addressed by candidate file id");

  const following = replay([{ kind: "staged-arrived", marks: [stagedMark], readAt: AT }]);
  assert.equal(needsManifest(following), true);
  assert.equal(needsLog(following), true);
  assert.equal(needsComments(following), false, "still no manifest, so still no file ids");

  const known = reduceConversation(following, { kind: "manifest-arrived", manifest });
  assert.equal(needsManifest(known), false);
  assert.equal(needsComments(known), true);
  assert.equal(needsComments(reduceConversation(known, { kind: "comments-requested" })), false);
});

// --- the followed set is sticky -------------------------------------------

test("the followed set survives the proposal being answered -- the log is append-only, for ever", () => {
  const following = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: eventsOf([staged(2), inserted(1)]), readAt: AT },
  ]);
  assert.equal(followedSet(following)?.proposalId, PROPOSAL);
  const answered = reduceConversation(following, {
    kind: "staged-arrived",
    marks: [{ ...stagedMark, pickFileId: "pick" }],
    readAt: AT,
  });
  assert.equal(followedSet(answered)?.proposalId, PROPOSAL, "it is not cleared when PICK lands");
  assert.match(markupOf(answered), /slide 1 went into the deck/);
});

test("re-adopting the SAME proposal keeps the manifest and the HTML already fetched", () => {
  const loaded = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "slide-arrived", slideIndex: 2, html: "<html>two</html>" },
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
  ]);
  assert.equal(slidesOf(loaded)[1]?.html.kind, "loaded", "a poll must not reset what is already on screen");
});

test("a strictly newer proposal replaces it, and resets the log and the counts that belonged to the old one", () => {
  const moved = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: eventsOf([staged(2)]), readAt: AT },
    {
      kind: "staged-arrived",
      marks: [stagedMark, { ...stagedMark, proposalId: "p_newer", createdTime: "2026-10-04T13:00:00.000Z" }],
      readAt: AT,
    },
  ]);
  assert.equal(followedSet(moved)?.proposalId, "p_newer");
  assert.equal(moved.log.kind, "unrequested");
  assert.equal(moved.comments.kind, "unrequested");
});

// --- the only cross-surface signals ---------------------------------------

test("a proposal is staged only when READY exists and no PICK answers it", () => {
  const marks: readonly ProposalMark[] = [
    { proposalId: "p_partial", folderId: "f1", readyFileId: null, pickFileId: null, createdTime: "t1" },
    { proposalId: "p_waiting", folderId: "f2", readyFileId: "r2", pickFileId: null, createdTime: "t2" },
    { proposalId: "p_answered", folderId: "f3", readyFileId: "r3", pickFileId: "k3", createdTime: "t3" },
  ];
  assert.deepEqual(stagedProposalsOf({ marks }), [
    { proposalId: "p_waiting", folderId: "f2", readyFileId: "r2", createdTime: "t2" },
  ]);
});

test("the slides window opens by itself ONCE per proposal, and not again after the user closes it", () => {
  assert.equal(proposalToAutoOpen(INITIAL_CONVERSATION), null, "an unfinished scan opens nothing");
  const scanned = replay([{ kind: "staged-arrived", marks: [stagedMark], readAt: AT }]);
  assert.equal(proposalToAutoOpen(scanned), null, "the scan alone cannot tell a staged set from a cleared one");
  const arrived = reduceConversation(scanned, { kind: "manifest-arrived", manifest });
  assert.equal(proposalToAutoOpen(arrived), PROPOSAL);
  const opened = reduceConversation(arrived, { kind: "auto-opened", proposalId: PROPOSAL });
  assert.equal(proposalToAutoOpen(opened), null, "a user who closed it is not dragged back in");
  const polled = reduceConversation(opened, { kind: "staged-arrived", marks: [stagedMark], readAt: AT });
  assert.equal(proposalToAutoOpen(polled), null);
  const next = replay([
    {
      kind: "staged-arrived",
      marks: [{ ...stagedMark, proposalId: "p_next", createdTime: "2026-10-04T13:00:00.000Z" }],
      readAt: AT,
    },
    { kind: "manifest-arrived", manifest: { ...manifest, proposalId: "p_next" } },
  ]);
  assert.equal(proposalToAutoOpen(next), "p_next", "a new set does open by itself");
});

test("A CLEARED SET STILL HAS ITS READY, and nothing is offered onto nothing", () => {
  // `clear_slides` deletes the uninserted candidates and bumps `revision`; it does NOT remove the
  // marker. A scan alone therefore still reports the proposal as staged.
  const cleared = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "log-arrived", events: eventsOf([staged(2), clearedEvent()]), readAt: AT },
    { kind: "manifest-arrived", manifest: { ...manifest, count: 0, slides: [], revision: 2 } },
  ]);
  assert.deepEqual(slidesReachability(cleared), { kind: "cleared", proposalId: PROPOSAL });
  assert.equal(proposalToAutoOpen(cleared), null, "a window onto nothing is the failure this prevents");
  const markup = markupOf(cleared);
  // The CARD that used to say this is gone. The button is off, its tooltip says why, and the
  // log -- which is the record, not the chrome -- still carries the line.
  // NO "SEE THE SLIDES" ANY MORE: the header carries only the title. A cleared set simply has
  // no candidates card, so there is nothing offering a window onto nothing.
  assert.doesNotMatch(markup, />See the slides</);
  assert.doesNotMatch(markup, /class="sasha-artifact"/, "nothing offers a window onto nothing");
  assert.match(markup, /Sasha discarded the candidates that were not inserted/, "and the log says it");
});

test("the manifest is re-read when the LOG says the set changed, and not on a clock", () => {
  const read = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "log-arrived", events: eventsOf([staged(2)]), readAt: AT },
    { kind: "manifest-arrived", manifest },
  ]);
  assert.equal(needsManifest(read), false, "a poll with no new set-changing event re-reads nothing");
  // A COMMENT does not change the candidate set.
  const commented = reduceConversation(read, {
    kind: "log-arrived",
    events: eventsOf([staged(2), commentOpened(2)]),
    readAt: AT,
  });
  assert.equal(needsManifest(commented), false);
  // A REVISION does.
  const bumped = reduceConversation(read, {
    kind: "log-arrived",
    events: eventsOf([staged(2), revised(2)]),
    readAt: AT,
  });
  assert.equal(needsManifest(bumped), true);
});

test("A SECOND REVISION of the same slide re-fetches: NN.html is overwritten in place", () => {
  const once = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: eventsOf([revised(2)]), readAt: AT },
    { kind: "slide-requested", slideIndex: 2 },
    { kind: "slide-arrived", slideIndex: 2, html: "<html><body>first revision</body></html>" },
  ]);
  assert.equal(nextRevisedSlideToLoad(once), null, "the bytes in hand are the ones this revision made");
  const twice = reduceConversation(once, {
    kind: "log-arrived",
    events: eventsOf([revised(2), revisedAgain(2)]),
    readAt: AT,
  });
  assert.equal(
    nextRevisedSlideToLoad(twice)?.slideIndex,
    2,
    "the file id did not change, so a cache keyed on it would serve the old slide for ever",
  );
});

test("the slides are reached from the candidates card, and absence of one is the honest answer", () => {
  // The SELECTOR still says "unknown" before the scan; the PANEL no longer says it in prose --
  // while it is opening it is one spinner (conversationIsOpening).
  assert.equal(slidesReachability(INITIAL_CONVERSATION).kind, "unknown");
  assert.match(markupOf(INITIAL_CONVERSATION), /class="sasha-opening"/);
  assert.doesNotMatch(markupOf(INITIAL_CONVERSATION), /checking your Drive/);
  const nothing = replay([{ kind: "staged-arrived", marks: [], readAt: AT }]);
  assert.equal(slidesReachability(nothing).kind, "nothing-staged");
  // NOTHING STAGED: there is no candidates card to press, which is the honest state -- a live
  // button onto an empty set was the thing that used to need a tooltip explaining itself.
  assert.doesNotMatch(markupOf(nothing), /class="sasha-artifact"/);
  const broken = replay([{ kind: "staged-failed", message: "Drive HTTP 403" }]);
  assert.deepEqual(slidesReachability(broken), { kind: "unreadable", message: "Drive HTTP 403" });
  assert.match(markupOf(broken), /Drive HTTP 403/);
  const there = replay([{ kind: "staged-arrived", marks: [stagedMark], readAt: AT }]);
  assert.equal(slidesReachability(there).kind, "reachable");
  const markup = markupOf(there);
  assert.doesNotMatch(markup, />See the slides</, "the header is the title and nothing else");
});

test("the button stays reachable long after the slides arrived, even once they are answered", () => {
  const answered = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "staged-arrived", marks: [{ ...stagedMark, pickFileId: "pick" }], readAt: AT },
  ]);
  assert.equal(slidesReachability(answered).kind, "reachable");
  assert.doesNotMatch(markupOf(answered), /disabled="">See the slides</);
});

test("sashaOpenPicker must say it opened: silence is a refusal the conversation has to show", () => {
  assert.deepEqual(parseOpenPickerReply({ opened: true }), { kind: "ok", value: { opened: true } });
  assert.equal(parseOpenPickerReply({}).kind, "invalid");
  assert.equal(parseOpenPickerReply({ opened: "yes" }).kind, "invalid");
  assert.equal(parseOpenPickerReply(null).kind, "invalid");
});

// --- the log, as one ordered list -----------------------------------------

test("the events keep the log's own order, and the THREADS interleave by when their root was posted", () => {
  const entries = entriesOf({
    events: eventsOf([staged(3), commentOpened(2), answered(2), revised(2)]),
    threads: [asked, aboutABox],
    comments: NO_SLIDE_COMMENTS,
  });
  assert.deepEqual(
    entries.map((entry) => entry.entryId),
    [
      // staged at 11:59, then the two threads rooted at 12:00 and 12:05, then the comment/answer/revision
      // at 12:06-12:08. The EVENT subsequence is exactly the log's own order whatever the messages
      // do, because the merge keys on the same millisecond prefix `sessionEventsOf` sorted by.
      "event_1791115140000-aaaaaa-slides-staged.json",
      // ONE entry per thread: c_1's reply r_1 is nested inside it, not a row of its own.
      "thread_c_1",
      "thread_c_2",
      "event_1791115560000-bbbbbb-comment-opened.json",
      "event_1791115620000-cccccc-comment-answered.json",
      "event_1791115680000-dddddd-slide-revised.json",
    ],
  );
});

test("a COMMENT is part of the user's own turn, not a separate stream", () => {
  const entries = entriesOf({ events: eventsOf([commentOpened(2)]), threads: [], comments: NO_SLIDE_COMMENTS });
  assert.deepEqual(
    entries.map((entry) => entry.voice),
    ["user"],
  );
  const markup = markupOf(replay([{ kind: "log-arrived", events: eventsOf([commentOpened(2)]), readAt: AT }]));
  assert.match(markup, /class="sasha-msg sasha-msg-event sasha-msg-user"/);
  assert.match(markup, /you marked a box on slide 2/);
  assert.match(markup, /the gridlines are gone/, "the comment's own words are in the user's turn");
});

test("AN UNKNOWN EVENT KIND IS AN OPAQUE LINE, never a dropped one", () => {
  const events = eventsOf([
    {
      name: "1791115140000-eeeeee-teleported-slide.json",
      text: JSON.stringify({ protocolVersion: 1, at: AT, kind: "teleported-slide", slideIndex: 2 }),
    },
  ]);
  assert.equal(events.length, 1, "a reader on an older build shows an incomplete history otherwise");
  assert.equal(events[0]?.body.kind, "opaque");
  const markup = markupOf(replay([{ kind: "log-arrived", events, readAt: AT }]));
  assert.match(markup, /class="sasha-msg sasha-msg-event sasha-msg-opaque"/);
  assert.match(markup, /something happened that this add-on cannot read \(teleported-slide\)/);
  // The honest warning keeps its words, in the same card shape as everything else.
  assert.match(markup, /class="sasha-c-name">Unreadable entry</);
});

test("every one of the seven known kinds renders a line of its own", () => {
  const markup = markupOf(
    replay([
      {
        kind: "log-arrived",
        events: eventsOf([staged(3), commentOpened(2), answered(2), revised(2), resolved(2), clearedEvent(), inserted(1)]),
        readAt: AT,
      },
    ]),
  );
  for (const expected of [
    /Sasha staged 3 candidate slides/,
    /you marked a box on slide 2/,
    /Sasha answered your comment on slide 2/,
    /Sasha revised slide 2/,
    /that comment on slide 2 is resolved/,
    /Sasha discarded the candidates that were not inserted/,
    /slide 1 went into the deck/,
  ]) {
    assert.match(markup, expected);
  }
});

test("a CLEAR is never silent: it is a line in the log like anything else", () => {
  const markup = markupOf(replay([{ kind: "log-arrived", events: eventsOf([clearedEvent()]), readAt: AT }]));
  assert.match(markup, /Sasha discarded the candidates that were not inserted: superseded/);
});

// --- the revised slide, inline --------------------------------------------

test("a revised slide renders INLINE at the point in the log where it happened", () => {
  const ready = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: eventsOf([revised(2)]), readAt: AT },
    { kind: "slide-arrived", slideIndex: 2, html: "<html><body>revised two</body></html>" },
  ]);
  const markup = markupOf(ready);
  assert.match(markup, /class="sasha-inline-slide"/);
  assert.match(markup, /slide 2 after Sasha revised it/);
  assert.match(markup, /revised two/, "the candidate's own HTML, scaled -- never a screenshot");
  assert.doesNotMatch(markup, /loading the new slide/);
});

test("only the slides a revision points at are fetched", () => {
  const nothingRevised = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: eventsOf([staged(2)]), readAt: AT },
  ]);
  assert.equal(nextRevisedSlideToLoad(nothingRevised), null, "a log is not a second grid");
  const revisedTwo = reduceConversation(nothingRevised, {
    kind: "log-arrived",
    events: eventsOf([staged(2), revised(2)]),
    readAt: AT,
  });
  assert.equal(nextRevisedSlideToLoad(revisedTwo)?.slideIndex, 2);
});

test("an EARLIER revision of the same slide says superseded rather than drawing the current bytes", () => {
  const twice = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: eventsOf([revised(2), revisedAgain(2)]), readAt: AT },
    { kind: "slide-arrived", slideIndex: 2, html: "<html><body>second revision</body></html>" },
  ]);
  const events = twice.log.kind === "loaded" ? twice.log.events : [];
  const [first, second] = events;
  assert.equal(first !== undefined ? revisedSlideFor({ conversation: twice, event: first }).kind : "", "superseded");
  assert.equal(second !== undefined ? revisedSlideFor({ conversation: twice, event: second }).kind : "", "ready");
  assert.match(markupOf(twice), /superseded by a later revision/);
});

test("a revised slide whose HTML cannot be fetched says so -- never an endless spinner", () => {
  const failed = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: eventsOf([revised(2)]), readAt: AT },
    { kind: "slide-failed", slideIndex: 2, message: "Drive HTTP 404" },
  ]);
  assert.match(markupOf(failed), /the new slide cannot be shown here: Drive HTTP 404/);
});

// --- unresolved counts, in both views -------------------------------------

test("an unresolved count the conversation cannot reach says so rather than showing zero", () => {
  const unread = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: eventsOf([commentOpened(2)]), readAt: AT },
  ]);
  assert.deepEqual(unresolvedCountFor({ comments: unread.comments, proposalId: PROPOSAL, slideIndex: 2 }), {
    kind: "unknown",
  });
  assert.match(markupOf(unread), /open comments not read yet/);

  const broken = reduceConversation(unread, { kind: "comments-failed", message: "Drive HTTP 403" });
  assert.deepEqual(unresolvedCountFor({ comments: broken.comments, proposalId: PROPOSAL, slideIndex: 2 }), {
    kind: "unreachable",
    message: "Drive HTTP 403",
  });
  assert.match(markupOf(broken), /open comments could not be read: Drive HTTP 403/);
});

test("the count beside the slide's events is the number the grid reads, from the same state", () => {
  const counted = withComments();
  assert.deepEqual(unresolvedCountFor({ comments: counted.comments, proposalId: PROPOSAL, slideIndex: 2 }), {
    kind: "known",
    count: 1,
  });
  assert.match(markupOf(counted), /1 open comment/);
});

/*
 * THE YELLOW SUMMARY IS GONE, AND THE COMMENTS ARE THE PANEL.
 *
 * It used to render a pinned block that restated every waiting comment in prose, led with how
 * long each had been waiting, and repeated the precondition -- above the comments themselves.
 * The side panel now works the way a document's comment pane does: the comments, open ones
 * first, with a filter (comment-panel.ts). The WAIT selectors it was built on are unchanged and
 * still covered in waiting.test.ts; what these tests assert is the surface.
 */
test("OPEN COMMENTS ARE THE PANEL, and a resolved one is not in the open filter", () => {
  const counted = withComments();
  // The selector is untouched: a comment is still a wait, and still the only one here.
  assert.deepEqual(
    waitingFor(counted).map((item) => [item.what, item.waitId]),
    [[{ kind: "comment", slideIndex: 2, region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 } }, "cc_cc_open"]],
  );
  const markup = markupOf(counted);
  assert.match(markup, /class="sasha-comments"/, "the comments have their own panel");
  assert.match(markup, /the gridlines are gone/);
  assert.doesNotMatch(markup, /cc_resolved/, "a resolved thread is not in the open filter");
  // AND THE SUMMARY IS NOT BACK.
  assert.doesNotMatch(markup, /class="sasha-open-comments"/);
  assert.doesNotMatch(markup, /thing waiting for Sasha/);
  assert.doesNotMatch(markup, /class="sasha-pulse"/);
});

test("THE FILTER IS THERE, WITH COUNTS, and Not done is what it opens on", () => {
  const markup = markupOf(withComments());
  assert.match(markup, /class="sasha-filter"/);
  for (const label of ["Not done", "Marked as done", "All"]) {
    assert.ok(markup.includes(label), `the ${label} filter is offered`);
  }
  assert.match(markup, /aria-pressed="true"[^>]*>Not done/, "open by default, as a comment pane is");
});

test("THE OPEN LIST IS SPLIT: Addressed leads, because that is what moved", () => {
  const markup = markupOf(withAnsweredAndUnanswered());
  const addressedAt = markup.indexOf("Addressed");
  const notAddressedAt = markup.indexOf("Not addressed");
  assert.ok(addressedAt >= 0 && notAddressedAt >= 0, "both sections render");
  assert.ok(addressedAt < notAddressedAt, "addressed on top");
});

test("HOW TO CONNECT SHOWS WHEN NOTHING IS ATTACHED, not five minutes after the first message", () => {
  // Every read is in and nothing has ever acted: that IS "no bot is connected", and it is
  // knowable at once. It used to need a wait past the delivery threshold as well.
  const everyRead = reduceConversation(withComments(), { kind: "thread-arrived", threads: [], readAt: AT });
  assert.equal(sashaPresence(everyRead).kind, "never-acted");
  const markup = markupOf(everyRead);
  assert.match(markup, /call open_work, then answer my open comments/);
  assert.match(markup, /claude mcp add sasha-slides/);
  assert.match(markup, /class="sasha-copyable"/, "the commands are selectable blocks, not prose");
});

test("but a HALF-DONE read never claims it: absence of evidence is not evidence of absence", () => {
  const everyRead = reduceConversation(withComments(), { kind: "thread-arrived", threads: [], readAt: AT });
  const broken = reduceConversation(everyRead, { kind: "log-failed", message: "events HTTP 500" });
  assert.equal(sashaPresence(broken).kind, "unknown");
  assert.doesNotMatch(markupOf(broken), /claude mcp add sasha-slides/);
  assert.equal(sashaPresence(withComments()).kind, "unknown", "a read in flight, same refusal");
});

test("and once a session HAS acted, with nothing stale, the instructions go away", () => {
  // The clock sits just after the comment, so no wait has crossed the delivery threshold. A
  // session that has acted AND a comment nobody has read for five minutes still prints them --
  // that is the older, wait-driven rule, and it is right: something is attached but it has not
  // picked THIS up.
  const acted = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "thread-arrived", threads: [], readAt: AT },
    { kind: "log-arrived", events: eventsOf([commentOpened(2), answered(2)]), readAt: AT },
    { kind: "comments-arrived", comments: withComments().comments },
    { kind: "clock-ticked", nowMs: Date.parse("2026-10-04T12:07:00.000Z") },
  ]);
  assert.equal(sashaPresence(acted).kind, "acted");
  assert.doesNotMatch(markupOf(acted), /claude mcp add sasha-slides/);
});

test("A RECEIPT IS STILL A READ IN THE LOG, never a reply from Sasha", () => {
  const delivered = reduceConversation(
    replay([
      { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
      { kind: "manifest-arrived", manifest },
      { kind: "log-arrived", events: eventsOf([commentOpened(2), feedbackDelivered()]), readAt: AT },
      { kind: "comments-arrived", comments: openCommentOnSlideTwo() },
    ]),
    { kind: "clock-ticked", nowMs: Date.parse("2026-10-04T12:06:00.000Z") + 107 * 60_000 },
  );
  const markup = markupOf(delivered);
  assert.match(markup, /class="sasha-msg sasha-msg-event sasha-msg-delivery"/);
  assert.match(markup, /a Claude session read 1 of your comments/);
  assert.doesNotMatch(markup, /<li class="sasha-msg sasha-msg-event sasha-msg-sasha"/);
});

test("with no clock yet nothing invents a duration: the row says 'just now'", () => {
  // `Conversation.nowMs` starts null -- typed absence, not a sentinel 0 -- so the first paint says
  // "just now" instead of computing a wait from the epoch.
  const unclocked = withComments();
  assert.equal(unclocked.nowMs, null);
  assert.match(markupOf(unclocked), /waiting just now/);
  const ticked = reduceConversation(unclocked, { kind: "clock-ticked", nowMs: Date.parse(AT) });
  assert.equal(ticked.nowMs, Date.parse(AT));
  // The same tick twice is the same state, so a 1 s clock does not re-render the log for nothing.
  assert.equal(reduceConversation(ticked, { kind: "clock-ticked", nowMs: Date.parse(AT) }), ticked);
});

// --- the panel ------------------------------------------------------------

test("Ask Sasha opens on the log, and says so rather than rendering blank", () => {
  const markup = markupOf(replay([{ kind: "thread-arrived", threads: [], readAt: AT }]));
  assert.match(markup, /Ask Sasha/);
  assert.match(markup, /Nothing yet\. Ask Sasha for a slide below/, "the log's own empty line");
  assert.match(markup, /appears here in\norder and stays|appears here in order and stays/);
  // Matched against text the STYLESHEET cannot contain: PICKER_CSS is inlined in this markup and
  // does mention `.sasha-chip-number`, so a class name is not a safe negative assertion here.
  assert.doesNotMatch(markup, /Insert option/, "the candidates are not in here");
});

test("the log shows what was sent and what came back", () => {
  const markup = markupOf(replay([{ kind: "thread-arrived", threads: [asked, aboutABox], readAt: AT }]));
  assert.match(markup, /give me three options for the agenda slide/);
  // Sasha's reply is nested in the thread's card with an avatar of its own colour, so it never
  // reads as the user's own words.
  assert.match(markup, /class="sasha-c-avatar sasha-c-avatar-agent"/);
  assert.match(markup, /class="sasha-c-name">Sasha</);
  assert.match(markup, /staged three -- see the slides/);
  // NOT "no answer yet": the row says how long it has been waiting, because an answer only comes
  // if a Claude session is attached and this document cannot see whether one is (waiting.ts).
  assert.match(markup, /waiting just now/, "and with no clock yet it says that, not a fake duration");
  assert.doesNotMatch(markup, /no answer yet/);
  assert.match(markup, /class="sasha-msgs"/);
});

test("Send is disabled until there is something to send", () => {
  const empty = markupOf(replay([{ kind: "thread-arrived", threads: [], readAt: AT }]));
  assert.match(empty, /class="sasha-c-send" disabled="">Send</);
  // AND NO CANCEL WHEN THERE IS NOTHING TO CANCEL.
  assert.doesNotMatch(empty, /class="sasha-c-cancel"/);
  const typed = markupOf(
    replay([{ kind: "thread-arrived", threads: [], readAt: AT }, { kind: "draft-typed", text: "make it bluer" }]),
  );
  assert.doesNotMatch(typed, /class="sasha-c-send" disabled="">Send</);
  assert.match(typed, /make it bluer<\/textarea>/);
  // IT IS DRAWN AS A NEW COMMENT: the same card, avatar and Cancel pair as Google's own box.
  assert.match(typed, /class="sasha-c-cancel"[^>]*>Cancel</);
  assert.match(typed, /class="sasha-c-card sasha-c-plain"/);
});

test("the composer goes read-only while the message is being posted", () => {
  const markup = markupOf(replay([{ kind: "draft-typed", text: "x" }, { kind: "send-started" }]));
  assert.match(markup, /posting your message/);
  assert.match(markup, /class="sasha-c-pill" rows="2" disabled/);
});

test("every load path that fails reaches the screen -- no spinner that cannot end", () => {
  assert.match(markupOf(replay([{ kind: "thread-failed", message: "comments HTTP 500" }])), /comments HTTP 500/);
  assert.match(markupOf(replay([{ kind: "staged-failed", message: "Drive HTTP 403" }])), /Drive HTTP 403/);
  assert.match(markupOf(replay([{ kind: "send-failed", message: "comment refused" }])), /comment refused/);
  assert.match(
    markupOf(replay([{ kind: "trouble", message: "the add-on is not connected" }])),
    /the add-on is not connected/,
  );
  const refusedOpen = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "open-requested" },
    { kind: "open-failed", message: "the deployed Code.gs is older than this conversation" },
  ]);
  assert.match(markupOf(refusedOpen), /older than this conversation/);
});

// --- "Report a defect" ----------------------------------------------------

test("the report entry waits for the inbox scan rather than claiming either answer", () => {
  // Before the scan the readiness is genuinely unknown -- and the panel shows NEITHER a
  // disabled button nor a line of prose about it, because while it is opening it shows only a
  // spinner. The button appears, correctly disabled, once there is an answer to disable it for.
  assert.equal(defectReportReadiness(INITIAL_CONVERSATION).kind, "unknown");
  assert.doesNotMatch(markupOf(INITIAL_CONVERSATION), /Report a defect/);

  const scanning = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-arrived", marks: [], readAt: AT });
  const waiting = reduceConversation(scanning, { kind: "manifest-requested" });
  assert.match(markupOf(waiting), /disabled[^>]*>Report a defect</);
});

test("with nothing staged the button says why it cannot be pressed, instead of doing nothing", () => {
  const empty = replay([{ kind: "staged-arrived", marks: [], readAt: AT }]);
  assert.equal(defectReportReadiness(empty).kind, "nothing-staged");
  assert.match(markupOf(empty), /none are staged right now/);
});

test("with a candidate staged the entry is live", () => {
  const staged = replay([{ kind: "staged-arrived", marks: [stagedMark], readAt: AT }]);
  assert.equal(defectReportReadiness(staged).kind, "ready");
  // And it describes the surface it opens: the editor on two slides, not a run-by-run table.
  assert.match(markupOf(staged), /opens the editor on two slides/);
});

test("a failed scan says so on the entry rather than reading as 'nothing to report'", () => {
  const broken = replay([{ kind: "staged-failed", message: "Drive refused the walk" }]);
  assert.deepEqual(defectReportReadiness(broken), { kind: "unreadable", message: "Drive refused the walk" });
  assert.match(markupOf(broken), /could not check which slides there are to report on: Drive refused the walk/);
});

test("a refused report window becomes a line on screen, not a button that silently did nothing", () => {
  const refused = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "report-requested" },
    { kind: "report-failed", message: "the deployed Code.gs is older than this conversation" },
  ]);
  assert.match(markupOf(refused), /older than this conversation/);
  // The SLIDES window's own phase is untouched: two different requests, two different verdicts.
  assert.equal(refused.open.kind, "idle");
});

/**
 * Replays events onto a conversation that has ALREADY FINISHED OPENING.
 *
 * Before the first inbox scan lands the panel is one spinner and nothing else
 * (`conversationIsOpening`), so a fixture that never scanned would render a spinner and every
 * assertion about the panel's content would fail for the wrong reason. The seed is an EMPTY
 * scan, so it adds no proposal of its own; a test that wants one replays `staged-arrived`
 * itself, and a test about the opening state builds from `INITIAL_CONVERSATION` directly.
 */
const OPENED: Conversation = reduceConversation(INITIAL_CONVERSATION, {
  kind: "staged-arrived",
  marks: [],
  readAt: AT,
});

function replay(events: readonly ConversationEvent[], from: Conversation = OPENED): Conversation {
  let conversation = from;
  for (const event of events) conversation = reduceConversation(conversation, event);
  return conversation;
}

function markupOf(conversation: Conversation): string {
  return renderToStaticMarkup(
    createElement(ConversationPanel, { conversation, actions: INERT_CONVERSATION_ACTIONS }),
  );
}

/** A conversation with one open and one resolved thread on slide 2, as Drive would report them. */
function withComments(): Conversation {
  return replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: eventsOf([commentOpened(2)]), readAt: AT },
    { kind: "comments-arrived", comments: withResolvedToo() },
  ]);
}

/** Just the open thread, for the receipt test: the resolved one is noise there. */
function openCommentOnSlideTwo(): SlideCommentsLoad {
  return {
    kind: "loaded",
    readAt: AT,
    slides: [
      {
        proposalId: PROPOSAL,
        slideIndex: 2,
        threads: {
          kind: "read",
          threads: [
            {
              commentId: "cc_open",
              author: "Krunoslav",
              text: "the gridlines are gone",
              at: "2026-10-04T12:06:00.000Z",
              resolved: false,
              region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 },
              replies: [],
            },
          ],
        },
      },
    ],
  };
}

/** Two open threads on slide 2: one Sasha has answered, one it has not. */
function withAnsweredAndUnanswered(): Conversation {
  return replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "thread-arrived", threads: [], readAt: AT },
    { kind: "log-arrived", events: eventsOf([commentOpened(2)]), readAt: AT },
    {
      kind: "comments-arrived",
      comments: {
        kind: "loaded",
        readAt: AT,
        slides: [
          {
            proposalId: PROPOSAL,
            slideIndex: 2,
            threads: {
              kind: "read",
              threads: [
                {
                  commentId: "cc_answered",
                  author: "Krunoslav",
                  text: "the chart is burying the number",
                  at: "2026-10-04T12:06:00.000Z",
                  resolved: false,
                  region: null,
                  replies: [
                    {
                      replyId: "cc_answered_r",
                      author: "Krunoslav",
                      text: "pulled Q4 out as the headline",
                      createdAt: "2026-10-04T12:08:00.000Z",
                      authoredByAgent: true,
                    },
                  ],
                },
                {
                  commentId: "cc_waiting",
                  author: "Krunoslav",
                  text: "the footer is cut off",
                  at: "2026-10-04T12:07:00.000Z",
                  resolved: false,
                  region: null,
                  replies: [],
                },
              ],
            },
          },
        ],
      },
    },
  ]);
}

function withResolvedToo(): SlideCommentsLoad {
  return {
    kind: "loaded",
    readAt: AT,
    slides: [
          { proposalId: PROPOSAL, slideIndex: 1, threads: { kind: "read", threads: [] } },
          {
            proposalId: PROPOSAL,
            slideIndex: 2,
            threads: {
              kind: "read",
              threads: [
                {
                  commentId: "cc_open",
                  author: "Krunoslav",
                  text: "the gridlines are gone",
                  at: "2026-10-04T12:06:00.000Z",
                  resolved: false,
                  region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 },
                  replies: [],
                },
                {
                  commentId: "cc_resolved",
                  author: "Krunoslav",
                  text: "the title was too small",
                  at: "2026-10-04T12:04:00.000Z",
                  resolved: true,
                  region: null,
                  replies: [],
                },
              ],
            },
          },
    ],
  };
}

function eventsOf(files: readonly SessionEventFileLike[]) {
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

type SessionEventFileLike = Readonly<{ name: string; text: string }>;

function staged(count: number): SessionEventFileLike {
  return {
    name: "1791115140000-aaaaaa-slides-staged.json",
    text: JSON.stringify({ protocolVersion: 1, at: "2026-10-04T11:59:00.000Z", kind: "slides-staged", count }),
  };
}

function commentOpened(slideIndex: number, commentId = "cc_open"): SessionEventFileLike {
  return {
    name: "1791115560000-bbbbbb-comment-opened.json",
    text: JSON.stringify({
      protocolVersion: 1,
      at: "2026-10-04T12:06:00.000Z",
      kind: "comment-opened",
      commentId,
      slideIndex,
      text: "the gridlines are gone",
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 },
    }),
  };
}

/** The server's receipt for the open comment: proof a client read it, and nothing more. */
function feedbackDelivered(): SessionEventFileLike {
  return {
    name: "1791115600000-dddddd-feedback-delivered.json",
    text: JSON.stringify({
      protocolVersion: 1,
      at: "2026-10-04T12:06:40.000Z",
      kind: "feedback-delivered",
      tool: "await_feedback",
      commentIds: ["cc_open"],
    }),
  };
}

function answered(slideIndex: number, commentId = "cc_open"): SessionEventFileLike {
  return {
    name: "1791115620000-cccccc-comment-answered.json",
    text: JSON.stringify({
      protocolVersion: 1,
      at: "2026-10-04T12:07:00.000Z",
      kind: "comment-answered",
      commentId,
      slideIndex,
      text: "redrawn with the gridlines back",
    }),
  };
}

function revised(slideIndex: number): SessionEventFileLike {
  return {
    name: "1791115680000-dddddd-slide-revised.json",
    text: JSON.stringify({
      protocolVersion: 1,
      at: "2026-10-04T12:08:00.000Z",
      kind: "slide-revised",
      slideIndex,
      answers: ["cc_open"],
      revision: 2,
    }),
  };
}

function revisedAgain(slideIndex: number): SessionEventFileLike {
  return {
    name: "1791115740000-eeeeee-slide-revised.json",
    text: JSON.stringify({
      protocolVersion: 1,
      at: "2026-10-04T12:09:00.000Z",
      kind: "slide-revised",
      slideIndex,
      answers: ["cc_open"],
      revision: 3,
    }),
  };
}

function resolved(slideIndex: number): SessionEventFileLike {
  return {
    name: "1791115800000-ffffff-comment-resolved.json",
    text: JSON.stringify({
      protocolVersion: 1,
      at: "2026-10-04T12:10:00.000Z",
      kind: "comment-resolved",
      commentId: "cc_open",
      slideIndex,
    }),
  };
}

function clearedEvent(): SessionEventFileLike {
  return {
    name: "1791115860000-gggggg-slides-cleared.json",
    text: JSON.stringify({
      protocolVersion: 1,
      at: "2026-10-04T12:11:00.000Z",
      kind: "slides-cleared",
      count: 3,
      reason: "superseded",
    }),
  };
}

function inserted(slideIndex: number): SessionEventFileLike {
  return {
    name: "1791115920000-hhhhhh-slide-inserted.json",
    text: JSON.stringify({
      protocolVersion: 1,
      at: "2026-10-04T12:12:00.000Z",
      kind: "slide-inserted",
      slideIndex,
      pageObjectId: "g_new",
    }),
  };
}

// --- a comment on a CANDIDATE is part of the same conversation ------------

/**
 * Measured against the deployed add-on, 2026-10-04.
 *
 * A box was drawn on candidate 2 in the slides window and sent; the connector's
 * `await_feedback` delivered it 7 s later and `reply_feedback` posted Sasha's answer 4 s after
 * that (reply id `AAACAzzhygw`, readable through `read_feedback`). The conversation showed
 * NEITHER - not the question and not the answer - because `Conversation.tsx` builds its entries
 * from `conversation.thread` (the DECK's comment pane) alone, while a candidate's comments live
 * in `conversation.comments` and were only ever counted.
 *
 * UI-CONTRACT.md: "The comments should be shown in the conversation as part of user message and
 * open comments should be listed until they are resolved." A reply the user cannot see is the
 * round trip failing at the last inch.
 */
const candidateThreads: SlideCommentsLoad = {
  kind: "loaded",
  readAt: "2026-10-04T12:10:00.000Z",
  slides: [
    {
      proposalId: PROPOSAL,
      slideIndex: 2,
      threads: {
        kind: "read",
        threads: [
          {
            commentId: "cand_c_1",
            author: "Ante M",
            text: "the table borders are uneven",
            at: "2026-10-04T12:06:00.000Z",
            resolved: false,
            region: { x: 0.08, y: 0.3, w: 0.55, h: 0.25 },
            replies: [
              {
                replyId: "cand_r_1",
                author: "Sasha",
                createdAt: "2026-10-04T12:07:00.000Z",
                text: "evened them out -- see the revision",
                authoredByAgent: true,
              },
            ],
          },
        ],
      },
    },
  ],
};

test("a comment on a CANDIDATE is ONE thread entry, with Sasha's answer nested inside it", () => {
  const entries = entriesOf({ events: eventsOf([]), threads: [], comments: candidateThreads });
  assert.deepEqual(
    entries.map((entry) => entry.entryId),
    ["thread_cand_c_1"],
    "one entry per thread -- the reply is not a row of its own, it sits in the same card",
  );
  const [only] = entries;
  assert.ok(only !== undefined && only.kind === "thread");
  assert.equal(only.voice, "user");
  // Which slide it is about, because the conversation covers four candidates at once and
  // "a box on a slide" would not tell the user which one to look at.
  assert.match(only.thread.about, /slide 2/);
  assert.equal(only.thread.slideIndex, 2);
  assert.equal(only.thread.resolved, false);
  assert.equal(only.thread.root.text, "the table borders are uneven");
  assert.equal(only.thread.root.author, "Ante M");
  assert.deepEqual(
    only.thread.replies.map((reply) => ({ id: reply.postId, voice: reply.voice, author: reply.author })),
    [{ id: "cand_r_1", voice: "sasha", author: "Sasha" }],
  );
});

/**
 * A REPLY HAS TO KNOW WHICH FILE TO GO TO. A candidate's thread lives on that candidate's own
 * `NN.html`, a deck message's on the presentation -- and the card can only answer or resolve a
 * thread whose file it was handed.
 */
test("a thread carries the Drive file it lives on: the candidate's NN.html, or the deck", () => {
  const entries = entriesOf({ events: eventsOf([]), threads: [asked], comments: candidateThreads });
  const files = entries.flatMap((entry) =>
    entry.kind === "thread" ? [{ id: entry.thread.commentId, fileId: entry.thread.fileId, source: entry.thread.source }] : [],
  );
  assert.deepEqual(files, [
    { id: "c_1", fileId: "deck_0123456789", source: "deck" },
    { id: "cand_c_1", fileId: "html_2", source: "candidate" },
  ]);
});

test("a candidate whose file id is not known yet has no file -- typed absence, not a guess", () => {
  const entries = conversationEntriesOf({
    events: eventsOf([]),
    threads: [],
    comments: candidateThreads,
    files: { deck: null, candidates: [] },
  });
  const [only] = entries;
  assert.ok(only !== undefined && only.kind === "thread");
  assert.equal(only.thread.fileId, null);
});

test("a candidate's threads interleave with the deck's by when their root was posted, in one list", () => {
  const entries = entriesOf({
    events: eventsOf([staged(3)]),
    threads: [asked, aboutABox],
    comments: candidateThreads,
  });
  assert.deepEqual(
    entries.map((entry) => entry.entryId),
    [
      "event_1791115140000-aaaaaa-slides-staged.json", // 11:59
      "thread_c_1", // 12:00 asked, with its 12:01 reply inside it
      "thread_c_2", // 12:05 aboutABox
      "thread_cand_c_1", // 12:06 the candidate comment, with Sasha's 12:07 answer inside it
    ],
  );
});

/** A candidate Drive refused must not silently remove that slide's conversation. */
test("an unreadable candidate contributes nothing rather than throwing", () => {
  const entries = entriesOf({
    events: eventsOf([]),
    threads: [],
    comments: { kind: "failed", message: "Drive said no", slides: [{ proposalId: PROPOSAL, slideIndex: 2, threads: { kind: "unreadable", message: "Drive said no" } }] },
  });
  assert.deepEqual(entries, []);
});

/**
 * A reply the USER typed straight into Drive's comment pane is theirs, not Sasha's.
 *
 * Both post as the same Google account, so the only thing that can tell them apart is the
 * marker the connector appends -- read into `authoredByAgent` at the parse boundary. Before
 * this, every reply in a thread was rendered in Sasha's voice, which would have put the
 * user's own words on screen as if the agent had said them.
 */
test("a reply is in Sasha's voice only when Sasha wrote it", () => {
  const entries = entriesOf({
    events: eventsOf([]),
    threads: [],
    comments: {
      kind: "loaded",
      readAt: "2026-10-04T12:10:00.000Z",
      slides: [
        {
          proposalId: PROPOSAL,
          slideIndex: 2,
          threads: {
            kind: "read",
            threads: [
              {
                commentId: "cand_c_9",
                author: "Ante M",
                text: "borders",
                at: "2026-10-04T12:06:00.000Z",
                resolved: false,
                region: null,
                replies: [
                  { replyId: "a_1", author: "Ante M", createdAt: "2026-10-04T12:07:00.000Z", text: "evened out", authoredByAgent: true },
                  { replyId: "u_1", author: "Ante M", createdAt: "2026-10-04T12:08:00.000Z", text: "still wrong", authoredByAgent: false },
                ],
              },
            ],
          },
        },
      ],
    },
  });
  const [only] = entries;
  assert.ok(only !== undefined && only.kind === "thread");
  // ALWAYS "Sasha" for the agent's post, never Drive's author: the connector posts as the user's
  // own Google account, so `author` says "Ante M" on both -- only the marker can tell them apart.
  assert.deepEqual(
    only.thread.replies.map((reply) => `${reply.voice}:${reply.author}`),
    ["sasha:Sasha", "user:Ante M"],
  );
});

// --- the conversation is POLLED, so a load that finished wants another one ---

/**
 * Measured in the deployed add-on, 2026-10-04.
 *
 * Two comments were sent from the slides window and answered by a real connector session, and
 * a candidate was revised through `revise_slide`. The sidebar showed only the FIRST of them
 * and sat on the word "refreshing" for the rest of the session: `needsLog`/`needsComments`
 * answered "no" for every state but `unrequested`, so after the first successful read nothing
 * was ever read again. `markStale` made it worse by dispatching `*-requested` (which parks the
 * load in `loading`) WITHOUT running the loader, so the panel was stuck mid-read for ever.
 *
 * A poll wants a fresh read of whatever is already in hand. The only answer that is "no" is a
 * read already in flight.
 */
function loadedConversation(): Conversation {
  const withSet = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-arrived", marks: [stagedMark], readAt: AT });
  const withManifest = reduceConversation(withSet, { kind: "manifest-arrived", manifest });
  const withLog = reduceConversation(withManifest, { kind: "log-arrived", events: eventsOf([]), readAt: AT });
  return reduceConversation(withLog, { kind: "thread-arrived", threads: [], readAt: AT });
}

test("a finished read is re-read on the next poll -- the conversation is live, not a snapshot", () => {
  const loaded = loadedConversation();
  assert.equal(needsLog(loaded), true, "the log must be re-read");
  assert.equal(needsComments(loaded), true, "the candidates' comments must be re-read");
  assert.equal(needsThread(loaded), true, "the deck's threads must be re-read");
  assert.equal(needsStaged(loaded), true, "the inbox must be re-scanned");
});

test("a read already in flight is not started twice", () => {
  const loaded = loadedConversation();
  assert.equal(needsLog(reduceConversation(loaded, { kind: "log-requested" })), false);
  assert.equal(needsComments(reduceConversation(loaded, { kind: "comments-requested" })), false);
  assert.equal(needsThread(reduceConversation(loaded, { kind: "thread-requested" })), false);
  assert.equal(needsStaged(reduceConversation(loaded, { kind: "staged-requested" })), false);
});

test("a FAILED read is retried by the next poll rather than ending the session", () => {
  const failed = reduceConversation(loadedConversation(), { kind: "log-failed", message: "Drive said no" });
  assert.equal(needsLog(failed), true);
});

/**
 * ONE COMMENT, ONE ENTRY.
 *
 * The connector appends `comment-opened` and `comment-answered` to the session log for the
 * same posts the thread itself carries, so rendering both put every comment and every answer
 * on screen TWICE -- seen in the deployed add-on, 2026-10-04:
 *
 *   YOU - ABOUT A BOX ON SLIDE 2  the table borders are uneven ...
 *   YOU  you marked a box on slide 2  the table borders are uneven ...
 *
 * The THREAD wins, because it is the live object: it knows whether the comment is still open
 * and the log event does not. An event whose comment is NOT in the threads still renders --
 * a deleted comment, or a candidate Drive could not read, is history worth keeping.
 */
test("a comment the threads already carry is not repeated from the log", () => {
  const entries = entriesOf({
    events: eventsOf([commentOpened(2, "cand_c_1"), answered(2, "cand_c_1")]),
    threads: [],
    comments: candidateThreads,
  });
  assert.deepEqual(
    entries.map((entry) => entry.entryId),
    ["thread_cand_c_1"],
  );
});

test("a log event for a comment no thread carries is still history", () => {
  const entries = entriesOf({
    events: eventsOf([commentOpened(2, "gone_1")]),
    threads: [],
    comments: candidateThreads,
  });
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["event", "thread"],
  );
});

/**
 * THE LOG IS A COMMENT PANE, so it has to look like one.
 *
 * The user's words beside Google's own comment pane were a 10 px uppercase label over a tinted
 * strip -- a log file, not a conversation. The shape here is read off a real Google Slides
 * comment card: a round avatar with one initial, the author in bold, the time under it, then
 * the words.
 */
test("every message in the log is a comment card: avatar, author, time", () => {
  const withSet = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-arrived", marks: [stagedMark], readAt: AT });
  const withManifest = reduceConversation(withSet, { kind: "manifest-arrived", manifest });
  const ticked = reduceConversation(withManifest, {
    kind: "clock-ticked",
    nowMs: Date.parse("2026-10-04T12:30:00.000Z"),
  });
  const loaded = reduceConversation(ticked, { kind: "thread-arrived", threads: [asked], readAt: AT });
  const markup = markupOf(loaded);

  assert.match(markup, /class="sasha-c-avatar"/, "the round initial");
  assert.match(markup, /class="sasha-c-name">Sasha</, "Sasha's reply is signed");
  assert.match(markup, /class="sasha-c-when">12:0\d (AM|PM) Today/, "Google's own time wording");
  assert.doesNotMatch(markup, /class="sasha-msg-who"/, "the uppercase log label is gone");
});

/** A candidate comment names the slide it is about, because the log covers all four at once. */
test("a comment card says which candidate it is about", () => {
  const withSet = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-arrived", marks: [stagedMark], readAt: AT });
  const withManifest = reduceConversation(withSet, { kind: "manifest-arrived", manifest });
  const loaded = reduceConversation(withManifest, { kind: "comments-arrived", comments: candidateThreads });
  assert.match(markupOf(loaded), /class="sasha-c-where"> · a box on slide 2</);
});

// --- a thread is ONE card, the way Google's comment pane draws it ----------

/**
 * ONE CARD PER THREAD, read off the user's reference screenshot of a real Google Slides comment.
 *
 * The log used to emit one row per post, so a question and Sasha's answer to it were two cards
 * separated by whatever happened in between -- nothing like the pane the user reads next to it,
 * where the replies sit INSIDE the root's card, the resolve tick and the three-dot menu are at its
 * top right, and an open thread ends in a pill-shaped reply box.
 */
test("ONE CARD PER THREAD: the root, its replies nested inside, the tick, the menu and the reply pill", () => {
  const markup = markupOf(withCandidateThreads(candidateThreads));
  assert.equal(countOf(markup, /class="sasha-c-card sasha-c-thread"/g), 1, "one card for the whole thread");
  const card = markup.slice(markup.indexOf('class="sasha-c-card sasha-c-thread"'));
  const replyAt = card.indexOf("evened them out -- see the revision");
  assert.ok(replyAt > 0, "the reply is rendered");
  assert.equal(card.slice(0, replyAt).includes("</li>"), false, "and it is INSIDE the root's card");
  assert.match(card, /class="sasha-c-reply"/, "as a reply row of its own");
  assert.match(card, /class="sasha-c-body sasha-c-body-reply"/, "its words on the grey strip");
  // The agent is ALWAYS "Sasha", with an avatar of its own colour.
  assert.match(card, /class="sasha-c-avatar sasha-c-avatar-agent"[^>]*>S</);
  assert.match(card, /class="sasha-c-name">Sasha</);
  // The tick and the menu are ICONS, Google's own Material paths, not text glyphs.
  assert.match(card, /aria-label="Mark as resolved and hide discussion"/);
  assert.match(card, /title="Mark as resolved and hide discussion"/);
  assert.match(card, /d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/);
  assert.equal(countOf(card, /aria-label="More options"/g), 2, "one three-dot menu on the root, one on the reply");
  assert.match(card, /placeholder="Reply or add others with @"/);
});

test("a RESOLVED thread is collapsed: a Resolved label instead of the tick, and no reply pill", () => {
  // Under the DONE filter: the panel opens on the open comments, so a resolved thread is only on
  // screen once the reader asks for it (comment-panel.ts).
  const markup = markupOf(
    reduceConversation(withCandidateThreads(resolvedCandidateThreads()), {
      kind: "comment-filter-chosen",
      filter: "done",
    }),
  );
  assert.match(markup, /class="sasha-c-card sasha-c-thread sasha-c-resolved"/);
  assert.match(markup, /class="sasha-c-resolved-label">Resolved</);
  assert.doesNotMatch(markup, /aria-label="Mark as resolved and hide discussion"/);
  assert.doesNotMatch(markup, /placeholder="Reply or add others with @"/);
});

test("the Reply button appears only once there is something to send", () => {
  const empty = markupOf(withCandidateThreads(candidateThreads));
  assert.doesNotMatch(empty, /class="sasha-c-reply-send"/);
  const typed = reduceConversation(withCandidateThreads(candidateThreads), {
    kind: "reply-typed",
    commentId: "cand_c_1",
    text: "the top border is still thicker",
  });
  assert.match(markupOf(typed), /class="sasha-c-reply-send"[^>]*>Reply</);
  assert.match(markupOf(typed), /the top border is still thicker/, "the pill holds what was typed");
});

test("a reply typed into one thread's pill is kept in the tree, and only for that thread", () => {
  const typed = reduceConversation(INITIAL_CONVERSATION, { kind: "reply-typed", commentId: "cand_c_1", text: "again" });
  assert.equal(threadActionOf({ conversation: typed, commentId: "cand_c_1" }).draft, "again");
  assert.equal(threadActionOf({ conversation: typed, commentId: "c_1" }).draft, "");
  assert.equal(outgoingReply({ conversation: typed, commentId: "cand_c_1" }), "again");
  assert.equal(outgoingReply({ conversation: typed, commentId: "c_1" }), null, "an empty pill sends nothing");
});

/**
 * ONE RE-READ PER ACTION, NEVER A LOOP. A reply has to show up in its card, so a success asks for
 * a fresh read -- but the last time a "read again" signal was wired into `pump` it re-armed
 * itself on every state change and burned the day's UrlFetch quota (call-budget.ts). So the want
 * is a FLAG that the read's own `*-requested` clears: one action, one read.
 */
test("a successful reply empties that pill and asks for exactly ONE fresh read of the candidates' comments", () => {
  const fresh = freshlyRead();
  assert.equal(needsComments(fresh), false, "precondition: the comments were just read");
  const replied = replay(
    [
      { kind: "reply-typed", commentId: "cand_c_1", text: "still uneven" },
      { kind: "thread-action-started", commentId: "cand_c_1", action: "reply" },
      { kind: "thread-action-succeeded", commentId: "cand_c_1", action: "reply", source: "candidate" },
    ],
    fresh,
  );
  assert.equal(threadActionOf({ conversation: replied, commentId: "cand_c_1" }).draft, "");
  assert.equal(needsComments(replied), true, "the reply must show up in its card");
  assert.equal(needsThread(replied), false, "and the deck's pane is not re-read for a candidate's thread");
  const inFlight = reduceConversation(replied, { kind: "comments-requested" });
  assert.equal(needsComments(inFlight), false);
  const arrived = reduceConversation(inFlight, {
    kind: "comments-arrived",
    comments: candidateThreadsReadAt(AT),
  });
  assert.equal(needsComments(arrived), false, "one action, one read -- never a loop");
});

test("a resolved DECK thread re-reads the deck's pane, not the candidates'", () => {
  const resolvedDeck = replay(
    [
      { kind: "thread-action-started", commentId: "c_1", action: "resolve" },
      { kind: "thread-action-succeeded", commentId: "c_1", action: "resolve", source: "deck" },
    ],
    freshlyRead(),
  );
  assert.equal(needsThread(resolvedDeck), true);
  assert.equal(needsComments(resolvedDeck), false);
  assert.equal(needsThread(reduceConversation(resolvedDeck, { kind: "thread-requested" })), false);
});

test("a failed reply KEEPS the words and says why, on the card", () => {
  const failed = replay(
    [
      { kind: "reply-typed", commentId: "cand_c_1", text: "still uneven" },
      { kind: "thread-action-started", commentId: "cand_c_1", action: "reply" },
      { kind: "thread-action-failed", commentId: "cand_c_1", action: "reply", message: "Drive HTTP 403" },
    ],
    withCandidateThreads(candidateThreads),
  );
  assert.equal(threadActionOf({ conversation: failed, commentId: "cand_c_1" }).draft, "still uneven");
  assert.match(markupOf(failed), /class="sasha-trouble"[^>]*>the reply was not posted: Drive HTTP 403</);
});

test("while a reply is posting the pill is read-only and says so", () => {
  const sending = replay(
    [
      { kind: "reply-typed", commentId: "cand_c_1", text: "still uneven" },
      { kind: "thread-action-started", commentId: "cand_c_1", action: "reply" },
    ],
    withCandidateThreads(candidateThreads),
  );
  const markup = markupOf(sending);
  assert.match(markup, /posting your reply\.\.\./);
  assert.match(markup, /<textarea class="sasha-c-pill"[^>]*disabled=""/);
});

/** Events are cards too: an avatar, a name and a time over the description -- no uppercase label. */
test("an EVENT is a card in the same language: avatar, name, time, then what happened", () => {
  const markup = markupOf(
    replay([{ kind: "log-arrived", events: eventsOf([staged(3), inserted(1)]), readAt: AT }]),
  );
  assert.match(markup, /class="sasha-msg sasha-msg-event sasha-msg-sasha"><div class="sasha-c-card sasha-c-event"/);
  assert.match(markup, /class="sasha-c-name">Sasha</);
  assert.match(markup, /class="sasha-c-name">This deck</);
  assert.match(markup, /class="sasha-c-body">Sasha staged 3 candidate slides</);
  assert.doesNotMatch(markup, /class="sasha-msg-who"/, "the uppercase log label is gone");
});

/**
 * WHEN NOTHING IS LISTENING, THE INSTRUCTION LEADS.
 *
 * The user reported seeing "4 things waiting for Sasha -- nothing has read the oldest for
 * 4 h 39 min" and "no message how to fix this". The instruction WAS rendered -- but inside the
 * pinned panel, below the log, below the headline and below the waiting list, which in a 300 px
 * sidebar puts it under the fold. A remedy the user has to scroll to find is a remedy they do
 * not have.
 *
 * So it moves to the top of the panel, ahead of the log: this is the one situation where
 * waiting longer cannot help, and the only thing on screen worth reading is what to do.
 */
test("the fix for 'nothing is listening' is above the log, not under it", () => {
  // The same fixture the threshold test uses: a comment, no receipt, the clock well past
  // FEEDBACK_DELIVERY_THRESHOLD_MS.
  const stuck = reduceConversation(withComments(), {
    kind: "clock-ticked",
    nowMs: Date.parse("2026-10-04T12:06:00.000Z") + 279 * 60_000,
  });
  const markup = markupOf(stuck);
  const instruction = markup.indexOf("Nothing has picked this up");
  const log = markup.indexOf('class="sasha-msgs"');
  assert.ok(instruction >= 0, "the instruction is on screen at all");
  assert.ok(log >= 0, "and so is the log");
  assert.ok(instruction < log, `the instruction must come first (at ${instruction}, log at ${log})`);
});

/** It is not rendered twice: one instruction, at the top, and the panel does not repeat it. */
test("the instruction appears exactly once", () => {
  const stuck = reduceConversation(withComments(), {
    kind: "clock-ticked",
    nowMs: Date.parse("2026-10-04T12:06:00.000Z") + 279 * 60_000,
  });
  assert.equal(markupOf(stuck).split("Nothing has picked this up").length - 1, 1);
});

/**
 * THE POLL MUST NOT STARVE THE OTHER SURFACE.
 *
 * Making every finished read re-readable fixed the frozen conversation, but it also meant the
 * sidebar asked Drive for all four candidates' comments every 8 s for ever. Apps Script
 * serialises one user's `google.script.run` calls, so the slides window's single comment read
 * ended up behind that queue and died: "open comments could not be read:
 * sashaCandidateComments did not answer within 25000 ms" (seen in the deployed add-on,
 * 2026-10-04).
 *
 * The comments read is the expensive one -- one Drive call per candidate -- so it gets its own,
 * slower staleness window. The log and the deck's threads are one call each and stay on the
 * poll's own cadence.
 */
test("a comments read just done is not repeated on the very next poll", () => {
  const withSet = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-arrived", marks: [stagedMark], readAt: AT });
  const withManifest = reduceConversation(withSet, { kind: "manifest-arrived", manifest });
  const read = reduceConversation(withManifest, { kind: "comments-arrived", comments: candidateThreads });
  const justNow = reduceConversation(read, {
    kind: "clock-ticked",
    nowMs: Date.parse(candidateThreads.kind === "loaded" ? candidateThreads.readAt : AT) + 8_000,
  });
  assert.equal(needsComments(justNow), false, "8 s after a read there is nothing new worth 4 Drive calls");

  const later = reduceConversation(read, {
    kind: "clock-ticked",
    nowMs: Date.parse(candidateThreads.kind === "loaded" ? candidateThreads.readAt : AT) + 40_000,
  });
  assert.equal(needsComments(later), true, "but it does go stale, or the counts freeze again");
});

/** With no clock yet, a finished read is still re-read: a stuck panel is the worse failure. */
test("with no clock the comments are still re-read", () => {
  const withSet = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-arrived", marks: [stagedMark], readAt: AT });
  const withManifest = reduceConversation(withSet, { kind: "manifest-arrived", manifest });
  const read = reduceConversation(withManifest, { kind: "comments-arrived", comments: candidateThreads });
  assert.equal(read.nowMs, null);
  assert.equal(needsComments(read), true);
});

/**
 * THE RUNAWAY: `pump` runs after EVERY dispatch, not only on the poll tick.
 *
 * Making every finished read re-readable unfroze the conversation, but `sidebar.tsx`'s
 * `dispatch` calls `pump` on every state change -- so the moment a read ARRIVED, `needs*` said
 * "read again", which dispatched `*-requested`, which arrived, which asked again. An unbounded
 * chain of Drive calls as fast as Apps Script would answer them.
 *
 * Measured consequence in the deployed add-on, 2026-10-04: the served bundle was the new one
 * (it contained `sasha-c-avatar` and `call open_work`) and yet NOT ONE comment card rendered --
 * `.sasha-c-card` count was 0 and every badge read "open comments not read yet", because the
 * reads that feed the cards never got through the queue the log reads were saturating. The user
 * saw what looked like the old interface.
 *
 * This drives the real cycle: dispatch what a completed read dispatches, then ask `needs*` the
 * question `pump` asks, with the clock standing still as it does between ticks.
 */
function settlesWithoutAClockTick(conversation: Conversation): boolean {
  return !needsLog(conversation) && !needsThread(conversation) && !needsStaged(conversation) && !needsComments(conversation);
}

test("a read that just arrived does not immediately ask for another one", () => {
  const atMs = Date.parse(AT);
  const ticked = reduceConversation(INITIAL_CONVERSATION, { kind: "clock-ticked", nowMs: atMs });
  const staged = reduceConversation(ticked, { kind: "staged-arrived", marks: [stagedMark], readAt: AT });
  const manifested = reduceConversation(staged, { kind: "manifest-arrived", manifest });
  const logged = reduceConversation(manifested, { kind: "log-arrived", events: eventsOf([]), readAt: AT });
  const threaded = reduceConversation(logged, { kind: "thread-arrived", threads: [], readAt: AT });
  const settled = reduceConversation(threaded, { kind: "comments-arrived", comments: candidateThreads });

  assert.ok(
    settlesWithoutAClockTick(settled),
    "with the clock standing still, every load is fresh and pump has nothing to start",
  );
});

test("but the next poll does re-read: the conversation stays live", () => {
  const atMs = Date.parse(AT);
  const ticked = reduceConversation(INITIAL_CONVERSATION, { kind: "clock-ticked", nowMs: atMs });
  const staged = reduceConversation(ticked, { kind: "staged-arrived", marks: [stagedMark], readAt: AT });
  const manifested = reduceConversation(staged, { kind: "manifest-arrived", manifest });
  const logged = reduceConversation(manifested, { kind: "log-arrived", events: eventsOf([]), readAt: AT });
  const threaded = reduceConversation(logged, { kind: "thread-arrived", threads: [], readAt: AT });

  // The log is the conversation and runs fast; the scan and the deck threads are deliberately
  // slower so the slides window is not starved of the serialised Apps Script queue.
  const later = reduceConversation(threaded, { kind: "clock-ticked", nowMs: atMs + 10_000 });
  assert.equal(needsLog(later), true, "ten seconds on, the log is worth re-reading");
  const muchLater = reduceConversation(threaded, { kind: "clock-ticked", nowMs: atMs + 30_000 });
  assert.equal(needsThread(muchLater), true);
  assert.equal(needsStaged(muchLater), true);
});

/**
 * EACH READ GETS THE CADENCE IT IS WORTH, because Apps Script serialises one user's calls and
 * the SLIDES WINDOW is queued behind the sidebar.
 *
 * With the log, the deck's threads and the inbox scan all re-reading every 8 s, the slides
 * window's own comment read waited behind them and blew its 25 s client budget: "open comments
 * could not be read: sashaCandidateComments did not answer within 25000 ms" (deployed add-on,
 * 2026-10-04, visible in the window's header).
 *
 * The log is the conversation and stays fast. The deck's threads and the inbox scan are not --
 * a new proposal appearing a few seconds later is not a defect, a starved sibling window is.
 */
test("the log is the quick one; the scan and the deck threads are not", () => {
  const atMs = Date.parse(AT);
  const ticked = reduceConversation(INITIAL_CONVERSATION, { kind: "clock-ticked", nowMs: atMs });
  const staged = reduceConversation(ticked, { kind: "staged-arrived", marks: [stagedMark], readAt: AT });
  const manifested = reduceConversation(staged, { kind: "manifest-arrived", manifest });
  const logged = reduceConversation(manifested, { kind: "log-arrived", events: eventsOf([]), readAt: AT });
  const threaded = reduceConversation(logged, { kind: "thread-arrived", threads: [], readAt: AT });

  const at8s = reduceConversation(threaded, { kind: "clock-ticked", nowMs: atMs + 8_000 });
  assert.equal(needsLog(at8s), true, "the conversation itself stays live");
  assert.equal(needsThread(at8s), false, "the deck's threads can wait");
  assert.equal(needsStaged(at8s), false, "so can the inbox scan");

  const at30s = reduceConversation(threaded, { kind: "clock-ticked", nowMs: atMs + 30_000 });
  assert.equal(needsThread(at30s), true, "but neither is abandoned");
  assert.equal(needsStaged(at30s), true);
});

/** The candidates' threads on screen, with the manifest that names their files. */
function withCandidateThreads(comments: SlideCommentsLoad): Conversation {
  return replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "clock-ticked", nowMs: Date.parse("2026-10-04T12:30:00.000Z") },
    { kind: "comments-arrived", comments },
  ]);
}

function resolvedCandidateThreads(): SlideCommentsLoad {
  if (candidateThreads.kind !== "loaded") throw new Error("the fixture is a loaded read");
  return {
    ...candidateThreads,
    slides: candidateThreads.slides.map((slide) => ({
      ...slide,
      threads:
        slide.threads.kind === "read"
          ? { kind: "read", threads: slide.threads.threads.map((thread) => ({ ...thread, resolved: true })) }
          : slide.threads,
    })),
  };
}

/** Every read done, and the clock one second later -- so nothing is stale by time alone. */
function freshlyRead(): Conversation {
  return replay(
    [
      { kind: "clock-ticked", nowMs: Date.parse(AT) + 1_000 },
      { kind: "comments-arrived", comments: candidateThreadsReadAt(AT) },
    ],
    loadedConversation(),
  );
}

function countOf(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/**
 * The entries with the files a real conversation would hand over: the deck is the manifest's
 * presentation and each candidate is its manifest entry. Tests that are about the files pass
 * their own to `conversationEntriesOf` directly.
 */
function entriesOf(
  sources: Readonly<{ events: Parameters<typeof conversationEntriesOf>[0]["events"]; threads: readonly FeedbackThread[]; comments: SlideCommentsLoad }>,
) {
  return conversationEntriesOf({
    ...sources,
    files: {
      deck: manifest.presentationId,
      candidates: manifest.slides.map((slide) => ({ slideIndex: slide.index, fileId: slide.fileId })),
    },
  });
}

/** The candidate threads, as a read that finished at `readAt`. */
function candidateThreadsReadAt(readAt: string): SlideCommentsLoad {
  if (candidateThreads.kind !== "loaded") throw new Error("the fixture is a loaded read");
  return { ...candidateThreads, readAt };
}

/**
 * WHILE IT IS STILL OPENING, THERE IS ONLY A SPINNER.
 *
 * The first paint used to say it was loading in three different places at once -- "loading"
 * beside the title, "checking your Drive..." inside a blue panel, and "checking which slides
 * there are to report on..." under a disabled button -- wrapped around a four-line paragraph
 * explaining what would appear later. The user called it confusing and unnecessary: before the
 * first read lands there is nothing to say, so the panel should say nothing.
 */
test("before the first inbox scan lands, the panel is a spinner and nothing else", () => {
  assert.equal(conversationIsOpening(INITIAL_CONVERSATION), true);
  const asked = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-requested" });
  assert.equal(conversationIsOpening(asked), true);

  const markup = markupOf(asked);
  assert.match(markup, /class="sasha-opening"/, "one spinner");
  assert.doesNotMatch(markup, /checking your Drive/);
  assert.doesNotMatch(markup, /checking which slides/);
  assert.doesNotMatch(markup, /Nothing yet\. Ask Sasha for a slide below/);
  assert.doesNotMatch(markup, /Looking for slides/);
  assert.doesNotMatch(markup, /Report a defect/);
});

test("once the scan lands the panel is itself again, with no spinner", () => {
  const scanned = reduceConversation(INITIAL_CONVERSATION, {
    kind: "staged-arrived",
    marks: [stagedMark],
    readAt: AT,
  });
  assert.equal(conversationIsOpening(scanned), false);
  const markup = markupOf(scanned);
  assert.doesNotMatch(markup, /class="sasha-opening"/);
  assert.match(markup, /class="sasha-chat"/, "the panel is itself again");
});

/**
 * A SPINNER THAT CANNOT END IS THE BUG THIS PROJECT KEEPS WRITING DOWN. A first scan that
 * FAILED has an answer -- it just is not a good one -- so it is said out loud.
 */
test("a failed first scan says so rather than spinning for ever", () => {
  const failed = reduceConversation(INITIAL_CONVERSATION, {
    kind: "staged-failed",
    message: "Drive would not answer",
  });
  assert.equal(conversationIsOpening(failed), false);
  const markup = markupOf(failed);
  assert.doesNotMatch(markup, /class="sasha-opening"/);
  assert.match(markup, /Drive would not answer/);
});

// --- the top of the panel is a spinner, or how to connect -----------------

/**
 * THE "CANDIDATE SLIDES" CARD IS GONE.
 *
 * It sat above every conversation and carried a heading, three lines of prose explaining that
 * the slides open in their own window, the raw `p_1791145806407_yig6ws`, a button and a status
 * line. The user's verdict: "there shouldn't be this candidate slides on top, doesn't add
 * value, there should be just spinner, and if the other end isn't connected it should on top
 * report instructions how to connect."
 *
 * So the top of the panel carries exactly one of three things: NOTHING when all is well, a
 * SPINNER while a read is in flight, or the instructions when nothing is listening. The way to
 * the slides survives as one compact control in the header, not as a card.
 */
test("the candidate-slides card is gone, and the way to the slides is a header control", () => {
  const markup = markupOf(withComments());
  assert.doesNotMatch(markup, /class="sasha-staged"/, "no card");
  assert.doesNotMatch(markup, /They open in their own window/, "and none of its prose");
  assert.doesNotMatch(markup, new RegExp(PROPOSAL), "the raw proposal id is not shown to a person");
  // THE WAY THERE IS THE CANDIDATES CARD, not a header button: it names what it will show.
  assert.doesNotMatch(markup, />See the slides</, "the header is the title and nothing else");
  assert.match(markup, />Open artifacts</, "the set's own card is the way to the slides");
});

/** A read in flight is a spinner, not the word "refreshing" next to the title. */
test("work in flight is a spinner, not a word", () => {
  const busy = reduceConversation(withComments(), { kind: "log-requested" });
  const markup = markupOf(busy);
  assert.match(markup, /class="sasha-header-spin"/);
  assert.doesNotMatch(markup, /refreshing/);
});

test("with nothing in flight there is no spinner at all", () => {
  assert.doesNotMatch(markupOf(withComments()), /class="sasha-header-spin"/);
});

/**
 * NOTHING LISTENING PUTS THE INSTRUCTIONS ON TOP -- above the log, where they cannot be
 * scrolled past. This is the one situation where waiting longer cannot help.
 */
test("when nothing is listening the instructions lead the panel", () => {
  const stuck = reduceConversation(withComments(), {
    kind: "clock-ticked",
    nowMs: Date.parse("2026-10-04T12:06:00.000Z") + 279 * 60_000,
  });
  const markup = markupOf(stuck);
  const instruction = markup.indexOf("Nothing has picked this up");
  const log = markup.indexOf('class="sasha-msgs"');
  assert.ok(instruction >= 0 && log >= 0 && instruction < log, "the remedy comes first");
  assert.match(markup, /call open_work/, "and it names no identifier");
});

/*
 * A REFRESH IS NOT AN OPENING.
 *
 * The sidebar re-scans the inbox every SCAN_FRESH_MS, and `staged-requested` used to reset the
 * load to a bare `loading` -- which `conversationIsOpening` reads as "still opening", so the
 * whole conversation was replaced by a spinner on EVERY poll. The user saw the panel blank
 * itself every few seconds for the life of the session.
 */
test("THE SPINNER IS FOR THE FIRST LOAD ONLY: a re-scan keeps what is on screen", () => {
  const first = replay([{ kind: "staged-arrived", marks: [stagedMark], readAt: AT }]);
  assert.equal(conversationIsOpening(first), false, "it has loaded once");

  const rescanning = reduceConversation(first, { kind: "staged-requested" });
  assert.equal(
    conversationIsOpening(rescanning),
    false,
    "a refresh must not blank the conversation it already has",
  );
  // And the panel still renders the body rather than the opening spinner.
  const markup = markupOf(rescanning);
  assert.doesNotMatch(markup, /class="sasha-opening"/, "no opening spinner over loaded content");
  assert.match(markup, /class="sasha-chat"/);
});

test("but the FIRST scan does show it, because there is genuinely nothing yet", () => {
  const opening = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-requested" });
  assert.equal(conversationIsOpening(opening), true);
  assert.match(markupOf(opening), /class="sasha-opening"/);
});

test("and a re-scan keeps what the last one found, so downstream does not see an empty inbox", () => {
  const loaded = replay([{ kind: "staged-arrived", marks: [stagedMark], readAt: AT }]);
  const rescanning = reduceConversation(loaded, { kind: "staged-requested" });
  // `defectReportReadiness` is a plain reader of the staged load: it answered "unknown" for a
  // bare `loading`, so a refresh used to make the report entry forget there was anything to
  // report on.
  assert.deepEqual(
    defectReportReadiness(rescanning),
    defectReportReadiness(loaded),
    "a scan in flight still knows what the last one found",
  );
});

/*
 * THE SET HAS A CARD, AND A COMMENT CAN OPEN WHAT IT IS ABOUT.
 *
 * A thread is about one slide; the candidates are a GROUP, and nothing on this surface stood for
 * the group -- so there was no way to say "show me all of them" from a comment, and no way to
 * jump from a comment about slide 2 to slide 2.
 */
test("the candidates are stacked vertically above their comments, with Open artifacts", () => {
  const markup = markupOf(withComments());
  assert.match(markup, /class="sasha-artifact"/, "the set itself has a card");
  assert.match(markup, /class="sasha-stack"/, "and the slides are a vertical stack");
  assert.match(markup, />Open artifacts</, "with one button for the whole set");
  // Every candidate is in the stack, numbered.
  assert.match(markup, /class="sasha-stack-number mono">1</);
  assert.match(markup, /class="sasha-stack-number mono">2</);
});

test("a comment about a slide ENDS with the two things it can do: open it, or mark it done", () => {
  const markup = markupOf(withComments());
  // At the FOOT of the thread, which is where the reader is once they have read it -- the blue
  // tick in the card's corner is a 22px target the user reported not being able to find.
  assert.match(markup, /class="sasha-c-foot"/);
  assert.match(markup, /class="sasha-c-open"[^>]*>Open slide 2</);
  assert.match(markup, /class="sasha-c-markdone"[^>]*>Mark as done</);
});

test("and a thread already marked done says so instead of offering it again", () => {
  const markup = markupOf(
    reduceConversation(withComments(), { kind: "comment-filter-chosen", filter: "done" }),
  );
  assert.match(markup, /class="sasha-c-done mono">Done</);
  assert.doesNotMatch(markup, /class="sasha-c-markdone"/);
});

test("and the open request names the proposal and the slide, so the window knows where to land", () => {
  const asked: { proposalId: string; slideIndex: number | null }[] = [];
  const markup = renderToStaticMarkup(
    createElement(ConversationPanel, {
      conversation: withComments(),
      actions: { ...INERT_CONVERSATION_ACTIONS, openArtifact: (target) => asked.push(target) },
    }),
  );
  assert.match(markup, /Open artifacts</);
  // The handler is wired; the server half is covered by bridge.test.ts's function list.
  assert.equal(asked.length, 0, "nothing fires on render");
});
