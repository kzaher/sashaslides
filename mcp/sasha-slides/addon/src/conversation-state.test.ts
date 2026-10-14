// ASK SASHA'S STATE AND PANEL. conversation-state.ts is a pure reducer and Conversation.tsx a pure
// function of it, so every test here replays events and reads values or server-rendered markup --
// no browser, no Drive, and a clock that is injected.
//
// The panel is the CONNECTION with the assistant and the ASSETS it staged; the conversation itself
// lives in the deck's own comments, so the last tests pin that none of the old conversation UI
// (the comments panel, the activity log, the composer, the defect-report entry) comes back.

import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { ProposalMark } from "./bridge.ts";
import { parseOpenPickerReply } from "./bridge.ts";
import { ConversationPanel } from "./Conversation.tsx";
import {
  INITIAL_CONVERSATION,
  assistantConnectionOf,
  candidateListsOf,
  conversationIsOpening,
  followedSet,
  needsLog,
  needsManifest,
  needsStaged,
  nextRevisedSlideToLoad,
  proposalToAutoOpen,
  reduceConversation,
  sashaPresence,
  slidesOf,
  slidesReachability,
  stagedProposalsOf,
  type Conversation,
  type ConversationEvent,
} from "./conversation-state.ts";
import { sessionEventsOf, type SessionEventFile } from "./session-log.ts";
import { INERT_CONVERSATION_ACTIONS, UNCONFIGURED_SETUP } from "./inert-actions.ts";
import { NO_PREVIEWS } from "./slide-previews.ts";
import type { Manifest } from "./protocol.ts";

const AT = "2026-10-04T12:00:00.000Z";
const PROPOSAL = "p_1733219000000_a1b2c3";
/** One minute after the server's `slides-staged` (11:59): fresh evidence that something is here. */
const SOON_AFTER_STAGING = Date.parse("2026-10-04T12:00:00.000Z");
/** Fifteen minutes after it: past the delivery threshold, so that evidence no longer counts. */
const LONG_AFTER_STAGING = Date.parse("2026-10-04T12:14:00.000Z");

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
  merge: null,
};

const stagedMark: ProposalMark = {
  proposalId: PROPOSAL,
  folderId: "folder_1",
  readyFileId: "ready",
  pickFileId: null,
  createdTime: "2026-10-04T11:59:00.000Z",
};

/**
 * Replays events onto a panel that has ALREADY FINISHED OPENING. Before the first inbox scan lands
 * the panel is one spinner and nothing else, so a fixture that never scanned would fail every
 * assertion about content for the wrong reason. The seed is an EMPTY scan, so it adds no proposal
 * of its own. Declared up here because the case tables below are built when the module loads.
 */
const OPENED: Conversation = reduceConversation(INITIAL_CONVERSATION, {
  kind: "staged-arrived",
  marks: [],
  readAt: AT,
});

// --- the loads --------------------------------------------------------------

test("a failed LOG re-read keeps the events it had -- one bad poll does not blank the set", () => {
  const failed = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "log-arrived", events: eventsOf([staged(3)]), readAt: AT },
    { kind: "log-requested" },
    { kind: "log-failed", message: "Drive HTTP 500" },
  ]);
  assert.equal(failed.log.kind, "failed");
  assert.equal(failed.log.kind === "failed" ? failed.log.events.length : 0, 1);
});

test("every loop fetches exactly once per request, and the ones with no proposal do not fetch at all", () => {
  assert.equal(needsStaged(INITIAL_CONVERSATION), true);
  assert.equal(needsManifest(INITIAL_CONVERSATION), false, "nothing is followed yet");
  assert.equal(needsLog(INITIAL_CONVERSATION), false);

  const following = replay([{ kind: "staged-arrived", marks: [stagedMark], readAt: AT }]);
  assert.equal(needsManifest(following), true);
  assert.equal(needsLog(following), true);

  const known = reduceConversation(following, { kind: "manifest-arrived", manifest });
  assert.equal(needsManifest(known), false);
  assert.equal(needsLog(reduceConversation(known, { kind: "log-requested" })), false);
});

// --- the followed set is sticky -----------------------------------------------

test("the followed set survives the proposal being answered -- the candidates stay reachable", () => {
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
  assert.match(markupOf(answered), />Open artifacts</);
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

test("a strictly newer proposal replaces it, and resets the log that belonged to the old one", () => {
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
  assert.equal(moved.logReadOnce, false, "the old set's log says nothing about the new one");
});

// --- the only cross-surface signals -------------------------------------------

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
  assert.doesNotMatch(markup, /class="sasha-artifact"/, "nothing offers a window onto nothing");
  assert.match(markup, /No candidate slides right now/);
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
  assert.equal(slidesReachability(INITIAL_CONVERSATION).kind, "unknown");
  assert.match(markupOf(INITIAL_CONVERSATION), /class="sasha-opening"/);
  const nothing = replay([{ kind: "staged-arrived", marks: [], readAt: AT }]);
  assert.equal(slidesReachability(nothing).kind, "nothing-staged");
  assert.doesNotMatch(markupOf(nothing), /class="sasha-artifact"/);
  assert.match(markupOf(nothing), /No candidate slides yet/);
  const broken = replay([{ kind: "staged-failed", message: "Drive HTTP 403" }]);
  assert.deepEqual(slidesReachability(broken), { kind: "unreadable", message: "Drive HTTP 403" });
  assert.match(markupOf(broken), /could not look for candidate slides: Drive HTTP 403/);
  const there = replay([{ kind: "staged-arrived", marks: [stagedMark], readAt: AT }]);
  assert.equal(slidesReachability(there).kind, "reachable");
});

test("sashaOpenPicker must say it opened: silence is a refusal the panel has to show", () => {
  assert.deepEqual(parseOpenPickerReply({ opened: true }), { kind: "ok", value: { opened: true } });
  assert.equal(parseOpenPickerReply({}).kind, "invalid");
  assert.equal(parseOpenPickerReply({ opened: "yes" }).kind, "invalid");
  assert.equal(parseOpenPickerReply(null).kind, "invalid");
});

test("every load path that fails reaches the screen -- no spinner that cannot end", () => {
  assert.match(markupOf(replay([{ kind: "staged-failed", message: "Drive HTTP 403" }])), /Drive HTTP 403/);
  assert.match(
    markupOf(replay([{ kind: "trouble", message: "the add-on is not connected" }])),
    /the add-on is not connected/,
  );
  const refusedOpen = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "open-requested" },
    { kind: "open-failed", message: "the deployed Code.gs is older than this panel" },
  ]);
  assert.match(markupOf(refusedOpen), /older than this panel/);
  const badManifest = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-failed", message: "manifest.json: count is not a number" },
  ]);
  assert.match(markupOf(badManifest), /could not read the candidate slides: manifest.json: count is not a number/);
  const firstLogFailed = replay([
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "log-failed", message: "events HTTP 500" },
  ]);
  assert.match(markupOf(firstLogFailed), /events HTTP 500/, "the connection line says why it cannot tell");
});

// --- the connection with the assistant ----------------------------------------

/*
 * HOW TO CONNECT SHOWS THE MOMENT NOTHING IS ATTACHED, and a compact line when something is.
 * Parametric over the one input that decides it -- how fresh the evidence is -- with the reads
 * otherwise identical, so the verdict changes with that input and nothing else.
 */
const CONNECTION_CASES: readonly Readonly<{
  name: string;
  events: readonly ConversationEvent[];
  connection: "connected" | "checking" | "nothing-listening";
  presence: "acted" | "delivered" | "never-acted" | "unknown";
}>[] = [
  {
    name: "nothing staged and the scan is in: no evidence anywhere",
    events: [{ kind: "staged-arrived", marks: [], readAt: AT }],
    connection: "nothing-listening",
    presence: "never-acted",
  },
  {
    name: "staged a minute ago: the server's slides-staged is fresh evidence",
    events: [...stagedWithLog([staged(2)]), { kind: "clock-ticked", nowMs: SOON_AFTER_STAGING }],
    connection: "connected",
    presence: "acted",
  },
  {
    name: "staged fifteen minutes ago: stale evidence is no listener",
    events: [...stagedWithLog([staged(2)]), { kind: "clock-ticked", nowMs: LONG_AFTER_STAGING }],
    connection: "nothing-listening",
    presence: "acted",
  },
  {
    name: "a receipt newer than the staging keeps it connected",
    events: [
      ...stagedWithLog([staged(2), feedbackDeliveredAt("2026-10-04T12:13:00.000Z")]),
      { kind: "clock-ticked", nowMs: LONG_AFTER_STAGING },
    ],
    connection: "connected",
    presence: "acted",
  },
  {
    name: "the set's log has never come back: absence of evidence is not evidence of absence",
    events: [
      { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
      { kind: "manifest-arrived", manifest },
      { kind: "log-failed", message: "events HTTP 500" },
    ],
    connection: "checking",
    presence: "unknown",
  },
];

for (const row of CONNECTION_CASES) {
  test(`the connection: ${row.name}`, () => {
    const conversation = replay(row.events);
    assert.equal(sashaPresence(conversation).kind, row.presence);
    assert.equal(assistantConnectionOf(conversation).kind, row.connection);
    const markup = markupOf(conversation);
    assert.equal(/Nothing has picked this up/.test(markup), row.connection === "nothing-listening", "the setup guide");
    assert.equal(/Connected to your assistant/.test(markup), row.connection === "connected", "the status line");
    assert.equal(/Checking for your assistant/.test(markup), row.connection === "checking", "the checking line");
  });
}

test("before the staged scan is in, absence is not claimed", () => {
  assert.equal(sashaPresence(INITIAL_CONVERSATION).kind, "unknown");
  const scanFailed = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-failed", message: "Drive HTTP 500" });
  assert.equal(sashaPresence(scanFailed).kind, "unknown");
});

test("the connected line says when the assistant was last heard from, and the setup guide is copyable", () => {
  const connected = markupOf(withCandidates({ nowMs: SOON_AFTER_STAGING }));
  assert.match(connected, /class="sasha-connection-dot sasha-connection-dot-on"/);
  assert.match(connected, /heard from 1 min 00 s ago/);
  const idle = markupOf(withCandidates({ nowMs: LONG_AFTER_STAGING }));
  assert.match(idle, /call open_work, then answer my open comments/);
  assert.match(idle, /class="sasha-copyable"/, "the commands are selectable blocks, not prose");
});

test("NO BOT CONNECTED: the poll putting the log back in flight does not hide the notice", () => {
  const idle = withCandidates({ nowMs: LONG_AFTER_STAGING });
  const polling = replay([{ kind: "log-requested" }], idle);
  assert.match(markupOf(polling), /Nothing has picked this up/);
  // A re-read that FAILS keeps what the last good one proved, too.
  const failed = reduceConversation(polling, { kind: "log-failed", message: "events HTTP 500" });
  assert.match(markupOf(failed), /Nothing has picked this up/);
});

/** A read in flight is a spinner, not a word -- and not while nothing is listening. */
test("work in flight is a spinner while connected, and none while nothing is listening", () => {
  const connected = withCandidates({ nowMs: SOON_AFTER_STAGING });
  assert.doesNotMatch(markupOf(connected), /class="sasha-header-spin"/, "nothing in flight, no spinner");
  assert.match(markupOf(reduceConversation(connected, { kind: "log-requested" })), /class="sasha-header-spin"/);
  const idle = reduceConversation(withCandidates({ nowMs: LONG_AFTER_STAGING }), { kind: "log-requested" });
  assert.doesNotMatch(markupOf(idle), /class="sasha-header-spin"/, "the poll is not Sasha working");
});

// --- freshness: live, but never a runaway ------------------------------------

test("a finished read is re-read on the next poll -- the panel is live, not a snapshot", () => {
  const loaded = loadedConversation();
  assert.equal(needsLog(loaded), true, "the log must be re-read");
  assert.equal(needsStaged(loaded), true, "the inbox must be re-scanned");
});

test("a read already in flight is not started twice", () => {
  const loaded = loadedConversation();
  assert.equal(needsLog(reduceConversation(loaded, { kind: "log-requested" })), false);
  assert.equal(needsStaged(reduceConversation(loaded, { kind: "staged-requested" })), false);
});

test("a FAILED read is retried by the next poll rather than ending the session", () => {
  const failed = reduceConversation(loadedConversation(), { kind: "log-failed", message: "Drive said no" });
  assert.equal(needsLog(failed), true);
});

/**
 * THE RUNAWAY: `pump` runs after EVERY dispatch, not only on the poll tick. A `needs*` that said
 * "read again" the moment a read arrived started an unbounded chain of Drive calls (measured
 * 2026-10-04). With the clock standing still, as it does between ticks, nothing may be due.
 */
test("a read that just arrived does not immediately ask for another one, and the log is the quick one", () => {
  const atMs = Date.parse(AT);
  const settled = replay(
    [
      { kind: "clock-ticked", nowMs: atMs },
      { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
      { kind: "manifest-arrived", manifest },
      { kind: "log-arrived", events: eventsOf([]), readAt: AT },
    ],
    INITIAL_CONVERSATION,
  );
  assert.ok(!needsLog(settled) && !needsStaged(settled) && !needsManifest(settled), "nothing is due");

  const at8s = reduceConversation(settled, { kind: "clock-ticked", nowMs: atMs + 8_000 });
  assert.equal(needsLog(at8s), true, "the log stays live");
  assert.equal(needsStaged(at8s), false, "the inbox scan can wait, so the slides window is not starved");
  const at30s = reduceConversation(settled, { kind: "clock-ticked", nowMs: atMs + 30_000 });
  assert.equal(needsStaged(at30s), true, "but it is not abandoned");
});

// --- opening ------------------------------------------------------------------

test("before the first inbox scan lands, the panel is a spinner and nothing else", () => {
  const asked = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-requested" });
  assert.equal(conversationIsOpening(asked), true);
  const markup = markupOf(asked);
  assert.match(markup, /class="sasha-opening"/, "one spinner");
  assert.doesNotMatch(markup, /No candidate slides yet/);
  assert.doesNotMatch(markup, /Nothing has picked this up/);
});

test("a failed first scan says so rather than spinning for ever", () => {
  const failed = reduceConversation(INITIAL_CONVERSATION, { kind: "staged-failed", message: "Drive would not answer" });
  assert.equal(conversationIsOpening(failed), false);
  const markup = markupOf(failed);
  assert.doesNotMatch(markup, /class="sasha-opening"/);
  assert.match(markup, /Drive would not answer/);
});

test("THE SPINNER IS FOR THE FIRST LOAD ONLY: a re-scan keeps what is on screen", () => {
  const first = replay([{ kind: "staged-arrived", marks: [stagedMark], readAt: AT }]);
  const rescanning = reduceConversation(first, { kind: "staged-requested" });
  assert.equal(conversationIsOpening(rescanning), false, "a refresh must not blank the panel it already has");
  assert.doesNotMatch(markupOf(rescanning), /class="sasha-opening"/);
  assert.equal(slidesReachability(rescanning).kind, "reachable", "a scan in flight still knows what the last one found");
});

// --- the assets -----------------------------------------------------------------

test("the candidates are a vertical stack in one card, with Open artifacts", () => {
  const markup = markupOf(withCandidates({ nowMs: SOON_AFTER_STAGING }));
  assert.match(markup, /class="sasha-artifact"/, "the set itself has a card");
  assert.match(markup, /class="sasha-stack"/, "and the slides are a vertical stack");
  assert.match(markup, />Open artifacts</, "with one button for the whole set");
  assert.match(markup, /class="sasha-stack-number mono">1</);
  assert.match(markup, /class="sasha-stack-number mono">2</);
  assert.doesNotMatch(markup, new RegExp(PROPOSAL), "the raw proposal id is not shown to a person");
});

test("the open handler is wired, and nothing fires on render", () => {
  const asked: { proposalId: string; slideIndex: number | null }[] = [];
  const markup = renderToStaticMarkup(
    createElement(ConversationPanel, {
      conversation: withCandidates({ nowMs: SOON_AFTER_STAGING }),
      previews: NO_PREVIEWS,
      setup: UNCONFIGURED_SETUP,
      actions: { ...INERT_CONVERSATION_ACTIONS, openArtifact: (target) => asked.push(target) },
    }),
  );
  assert.match(markup, /Open artifacts</);
  assert.equal(asked.length, 0);
});

/*
 * ARCHIVING A CANDIDATE. The user sets a candidate aside without it ever disappearing: the set
 * card has a Working and an Archived tab, archiving is optimistic (it moves on the click, before
 * Drive answers), a failed write puts it back and says why, and the log -- where the archive is
 * recorded -- is what brings it back on the next open.
 */
const ARCHIVE_AT_MS = 1791115700000;

test("the set card has Working and Archived tabs, with counts", () => {
  const card = cardOf(markupOf(withCandidates({ nowMs: SOON_AFTER_STAGING })));
  assert.match(card, /class="sasha-candidate-tabs"/);
  assert.match(card, /class="sasha-tab sasha-tab-on"[^>]*>Working<span class="sasha-filter-count">2</);
  assert.match(card, /class="sasha-tab"[^>]*>Archived<span class="sasha-filter-count">0</);
});

test("every working candidate offers Archive next to Open", () => {
  const card = cardOf(markupOf(withCandidates({ nowMs: SOON_AFTER_STAGING })));
  assert.equal((card.match(/>Archive</g) ?? []).length, 2);
  assert.equal((card.match(/>Open</g) ?? []).length, 2);
  assert.doesNotMatch(card, />Restore</);
});

test("archiving is OPTIMISTIC: the candidate leaves Working on the click and the last one stays visible", () => {
  const archived = reduceConversation(withCandidates({ nowMs: SOON_AFTER_STAGING }), archiveRequested(1));
  const lists = candidateListsOf(archived);
  assert.deepEqual(
    lists.working.map((slide) => slide.slideIndex),
    [2],
  );
  assert.deepEqual(
    lists.archived.map((entry) => entry.slide.slideIndex),
    [1],
  );
  const card = cardOf(markupOf(archived));
  assert.doesNotMatch(card, /class="sasha-stack-number mono">1</, "not in the working list");
  assert.match(card, /Archived<span class="sasha-filter-count">1</);
  // NEVER GONE: the working tab names the last archived one, with a way back.
  assert.match(card, /class="sasha-last-archived"[^]*Last archived[^]*1 · option 1[^]*>Restore</);
});

test("the Archived tab lists the most recently archived FIRST, each with Restore and Open", () => {
  const conversation = replay(
    [
      archiveRequested(2, true, ARCHIVE_AT_MS),
      archiveRequested(1, true, ARCHIVE_AT_MS + 1000),
      { kind: "candidate-tab-chosen", tab: "archived" },
    ],
    withCandidates({ nowMs: SOON_AFTER_STAGING }),
  );
  const card = cardOf(markupOf(conversation));
  assert.match(card, /class="sasha-tab sasha-tab-on"[^>]*>Archived<span class="sasha-filter-count">2</);
  const numbers = [...card.matchAll(/class="sasha-stack-number mono">(\d+)</g)].map((match) => match[1]);
  assert.deepEqual(numbers, ["1", "2"], "newest archive first");
  assert.equal((card.match(/>Restore</g) ?? []).length, 2);
  assert.equal((card.match(/>Open</g) ?? []).length, 2);
  assert.doesNotMatch(card, />Archive</);
});

test("with every candidate archived, Working says so and offers the way to Archived", () => {
  const conversation = replay(
    [archiveRequested(1), archiveRequested(2, true, ARCHIVE_AT_MS + 1)],
    withCandidates({ nowMs: SOON_AFTER_STAGING }),
  );
  const card = cardOf(markupOf(conversation));
  assert.match(card, /All 2 candidates are archived/);
  assert.match(card, />Show archived</);
});

test("restoring puts it back in Working, in the manifest's order", () => {
  const conversation = replay(
    [archiveRequested(1), archiveRequested(1, false, ARCHIVE_AT_MS + 1000)],
    withCandidates({ nowMs: SOON_AFTER_STAGING }),
  );
  assert.deepEqual(
    candidateListsOf(conversation).working.map((slide) => slide.slideIndex),
    [1, 2],
  );
  assert.equal(candidateListsOf(conversation).archived.length, 0);
});

test("a FAILED write reverts the archive and says why", () => {
  const conversation = replay(
    [
      archiveRequested(1),
      { kind: "archive-failed", proposalId: PROPOSAL, slideIndex: 1, atMillis: ARCHIVE_AT_MS, message: "Drive HTTP 500" },
    ],
    withCandidates({ nowMs: SOON_AFTER_STAGING }),
  );
  assert.deepEqual(
    candidateListsOf(conversation).working.map((slide) => slide.slideIndex),
    [1, 2],
  );
  assert.match(markupOf(conversation), /could not archive candidate 1: Drive HTTP 500/);
});

test("a failure for a SUPERSEDED request does not undo the newer one", () => {
  const conversation = replay(
    [
      archiveRequested(1, true, ARCHIVE_AT_MS),
      archiveRequested(1, false, ARCHIVE_AT_MS + 1000),
      archiveRequested(1, true, ARCHIVE_AT_MS + 2000),
      { kind: "archive-failed", proposalId: PROPOSAL, slideIndex: 1, atMillis: ARCHIVE_AT_MS, message: "late" },
    ],
    withCandidates({ nowMs: SOON_AFTER_STAGING }),
  );
  assert.deepEqual(
    candidateListsOf(conversation).archived.map((entry) => entry.slide.slideIndex),
    [1],
  );
});

test("the archive survives a reopen: a fresh panel reads it back from the log", () => {
  const reopened = replay(stagedWithLog([staged(2), archivedEventFile(2)]));
  assert.deepEqual(
    candidateListsOf(reopened).archived.map((entry) => [entry.slide.slideIndex, entry.archivedAtMillis]),
    [[2, ARCHIVE_AT_MS]],
  );
});

test("a written archive is handed over to the log once the log holds its file", () => {
  const written = replay(
    [
      archiveRequested(2),
      { kind: "archive-written", proposalId: PROPOSAL, slideIndex: 2, atMillis: ARCHIVE_AT_MS, fileId: `drive_${ARCHIVE_AT_MS}-cccccc-slide-archived.json` },
    ],
    withCandidates({ nowMs: SOON_AFTER_STAGING }),
  );
  assert.equal(written.archivePending.length, 1, "kept until the log has caught up");
  const caughtUp = reduceConversation(written, {
    kind: "log-arrived",
    events: eventsOf([staged(2), archivedEventFile(2)]),
    readAt: AT,
  });
  assert.equal(caughtUp.archivePending.length, 0, "the log is the record now");
  assert.deepEqual(
    candidateListsOf(caughtUp).archived.map((entry) => entry.slide.slideIndex),
    [2],
  );
});

// ONE BUTTON STYLE, AND THE THUMBNAIL OPENS TOO. The user asked for Archive and Open to look the
// same, and for a click on a candidate's picture to open it like Open does.
test("each candidate row's Archive and Open share one style, and its thumbnail is a button that opens it", () => {
  const card = cardOf(markupOf(withCandidates({ nowMs: SOON_AFTER_STAGING })));
  const archive = card.match(/<button[^>]*>Archive<\/button>/g) ?? [];
  const open = card.match(/<button[^>]*>Open<\/button>/g) ?? [];
  assert.ok(archive.length > 0 && open.length === archive.length, `${archive.length} Archive, ${open.length} Open`);
  const classOf = (button: string): string => /class="([^"]*)"/.exec(button)?.[1] ?? "";
  for (const button of archive) assert.equal(classOf(button), classOf(open[0] ?? ""), button);
  assert.match(card, /<button[^>]*aria-label="Open candidate 1"[^>]*>[^]*?sasha-thumb/);
});

// --- only the connection and the assets -------------------------------------------

/*
 * THE CONVERSATION MOVED TO THE DECK'S COMMENTS. The side panel is the connection with the bot and
 * the assets list, and nothing else: no comments panel and its filter, no activity log, no
 * composer and Send, no defect-report entry. Rendered in both connection states, because the
 * setup guide and the status line are different trees and either could bring something back.
 */
const SIMPLIFIED_CASES: readonly Readonly<{
  name: string;
  conversation: Conversation;
  kept: readonly RegExp[];
}>[] = [
  {
    name: "connected, with candidates",
    conversation: withCandidates({ nowMs: SOON_AFTER_STAGING }),
    kept: [/>Ask Sasha</, /Connected to your assistant/, /2 candidates/, />Working</, />Archived</, />Open</, />Archive</, />Open artifacts</],
  },
  {
    name: "nothing listening, with candidates",
    conversation: withCandidates({ nowMs: LONG_AFTER_STAGING }),
    kept: [/>Ask Sasha</, /Nothing has picked this up/, /class="sasha-nobody-listening"/, />Open artifacts</],
  },
  {
    name: "nothing listening, nothing staged",
    conversation: replay([{ kind: "staged-arrived", marks: [], readAt: AT }]),
    kept: [/>Ask Sasha</, /Nothing has picked this up/, /No candidate slides yet/],
  },
];

for (const row of SIMPLIFIED_CASES) {
  test(`only the connection and the assets: ${row.name}`, () => {
    const markup = markupOf(row.conversation);
    for (const kept of row.kept) assert.match(markup, kept);
    assert.doesNotMatch(markup, />Activity</, "no activity log");
    assert.doesNotMatch(markup, /Report a defect/, "no defect-report entry");
    assert.doesNotMatch(markup, />Send</, "no composer");
    assert.doesNotMatch(markup, /Not done/, "no comments filter");
    assert.doesNotMatch(markup, /class="sasha-comments"|class="sasha-msgs"|class="sasha-ask"|<textarea/, "none of their containers");
  });
}

// --- fixtures -----------------------------------------------------------------------

function replay(events: readonly ConversationEvent[], from: Conversation = OPENED): Conversation {
  let conversation = from;
  for (const event of events) conversation = reduceConversation(conversation, event);
  return conversation;
}

function markupOf(conversation: Conversation): string {
  return renderToStaticMarkup(
    createElement(ConversationPanel, {
      conversation,
      previews: NO_PREVIEWS,
      setup: UNCONFIGURED_SETUP,
      actions: INERT_CONVERSATION_ACTIONS,
    }),
  );
}

/** The staged set with its manifest read and this log. */
function stagedWithLog(files: readonly SessionEventFileLike[]): readonly ConversationEvent[] {
  return [
    { kind: "staged-arrived", marks: [stagedMark], readAt: AT },
    { kind: "manifest-arrived", manifest },
    { kind: "log-arrived", events: eventsOf(files), readAt: AT },
  ];
}

/** Two candidates, the log holding only the server's `slides-staged`, and the clock at `nowMs`. */
function withCandidates({ nowMs }: { nowMs: number }): Conversation {
  return replay([...stagedWithLog([staged(2)]), { kind: "clock-ticked", nowMs }]);
}

function loadedConversation(): Conversation {
  return replay(stagedWithLog([]), INITIAL_CONVERSATION);
}

/** The slice of the markup that is the set card. */
function cardOf(markup: string): string {
  const start = markup.indexOf('class="sasha-artifact"');
  return start < 0 ? "" : markup.slice(start, markup.indexOf("Open artifacts", start));
}

function archiveRequested(slideIndex: number, archived = true, atMillis = ARCHIVE_AT_MS): ConversationEvent {
  return { kind: "archive-requested", proposalId: PROPOSAL, slideIndex, archived, atMillis };
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

function commentOpened(slideIndex: number): SessionEventFileLike {
  return {
    name: "1791115560000-bbbbbb-comment-opened.json",
    text: JSON.stringify({
      protocolVersion: 1,
      at: "2026-10-04T12:06:00.000Z",
      kind: "comment-opened",
      commentId: "cc_open",
      slideIndex,
      text: "the gridlines are gone",
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 },
    }),
  };
}

/** The server's receipt: proof a client read the open comment, and nothing more. */
function feedbackDeliveredAt(at: string): SessionEventFileLike {
  return {
    name: `${Date.parse(at)}-dddddd-feedback-delivered.json`,
    text: JSON.stringify({
      protocolVersion: 1,
      at,
      kind: "feedback-delivered",
      tool: "await_feedback",
      commentIds: ["cc_open"],
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

function archivedEventFile(slideIndex: number, atMillis = ARCHIVE_AT_MS): SessionEventFileLike {
  return {
    name: `${atMillis}-cccccc-slide-archived.json`,
    text: JSON.stringify({ protocolVersion: 1, at: AT, kind: "slide-archived", slideIndex }),
  };
}
