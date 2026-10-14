// WHAT PRESENCE CAN AND CANNOT CLAIM. waiting.ts is value in, value out, so every one of these is
// a few microseconds with no browser, no Drive and no clock of its own -- the clock is injected,
// which is the only way "heard from 6 minutes ago" is testable at all.
//
// THE PROPERTIES THESE PIN, which are the whole of UI-CONTRACT.md's "Waiting for Sasha must be
// honest" as it applies to the connection line:
//
//   1. elapsed time comes from an injected clock, and is "just now" rather than invented without one;
//   2. presence is EVIDENCE, not a guess: only a session-log event in Sasha's voice or a delivery
//      receipt counts, and the newest of them is the answer;
//   3. "nobody has ever answered" is refused while the read that could disprove it is unfinished or
//      failed;
//   4. evidence older than the shared delivery threshold is no listener.

import assert from "node:assert/strict";
import test from "node:test";
import { sessionEventsOf, type SessionEvent, type SessionEventFile } from "./session-log.ts";
import {
  describeElapsed,
  elapsedMsOf,
  presenceIsSilent,
  sashaPresenceOf,
  type PresenceReads,
} from "./waiting.ts";
import { FEEDBACK_DELIVERY_THRESHOLD_MS } from "../../feedback-delivery.ts";

const PROPOSAL = "p_1733219000000_a1b2c3";
const AT = "2026-10-04T12:00:00.000Z";
const NOW = Date.parse("2026-10-04T12:14:00.000Z");
const ALL_READ: PresenceReads = { incomplete: null };

// --- the clock -------------------------------------------------------------

test("WITH NO CLOCK NOTHING IS INVENTED: elapsed is null and the words are 'just now'", () => {
  assert.equal(elapsedMsOf({ since: AT, nowMs: null }), null);
  assert.equal(describeElapsed(null), "just now");
});

test("an unreadable timestamp is absence, not zero", () => {
  assert.equal(elapsedMsOf({ since: "not a date", nowMs: NOW }), null);
  assert.equal(elapsedMsOf({ since: "", nowMs: NOW }), null);
});

test("a clock behind Drive's clamps to zero rather than counting backwards", () => {
  // Drive's clock and the browser's are not the same clock. "-3 s ago" reads as a bug.
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

// --- presence: evidence, never a guess ------------------------------------

test("A SASHA-VOICED EVENT IS EVIDENCE, and the NEWEST piece of it is the answer", () => {
  const presence = sashaPresenceOf({ events: logOf([commentOpened(), slideRevised()]), reads: ALL_READ, nowMs: NOW });
  assert.equal(presence.kind, "acted");
  assert.equal(presence.kind === "acted" ? presence.at : null, "2026-10-04T12:08:00.000Z");
  assert.equal(presence.kind === "acted" ? presence.agoMs : null, 6 * 60_000);
});

test("THE USER'S OWN EVENTS ARE NOT EVIDENCE: a comment you opened proves nobody read it", () => {
  const presence = sashaPresenceOf({ events: logOf([commentOpened()]), reads: ALL_READ, nowMs: NOW });
  assert.equal(presence.kind, "never-acted");
});

test("'NOBODY HAS EVER ANSWERED' IS REFUSED while a read that could disprove it is not in", () => {
  const presence = sashaPresenceOf({
    events: [],
    reads: { incomplete: "the event log is still being read" },
    nowMs: NOW,
  });
  assert.deepEqual(presence, { kind: "unknown", message: "the event log is still being read" });
});

test("but EVIDENCE OUTRANKS AN UNFINISHED READ: proof already in hand is still proof", () => {
  const presence = sashaPresenceOf({
    events: logOf([slideRevised()]),
    reads: { incomplete: "the event log is still being read" },
    nowMs: NOW,
  });
  assert.equal(presence.kind, "acted");
});

test("A RECEIPT IS PRESENCE EVIDENCE, and it outranks nothing but is itself outranked by an act", () => {
  const receipt = sashaPresenceOf({ events: logOf([feedbackDelivered()]), reads: ALL_READ, nowMs: NOW });
  assert.deepEqual(receipt, { kind: "delivered", at: "2026-10-04T12:07:00.000Z", agoMs: 7 * 60_000 });

  // An actual act is stronger evidence than a read, so it wins even when the receipt is newer --
  // but the newer receipt is still when the assistant was last HEARD from.
  const acted = sashaPresenceOf({ events: logOf([slideRevisedEarlier(), feedbackDelivered()]), reads: ALL_READ, nowMs: NOW });
  assert.equal(acted.kind, "acted");
  assert.equal(acted.kind === "acted" ? acted.heardAgoMs : null, 7 * 60_000);
});

// --- silence: when the setup guide shows -----------------------------------

test("NOTHING ATTACHED YET: never-acted is silent, so the connect instructions show at once", () => {
  assert.equal(presenceIsSilent({ kind: "never-acted" }), true);
});

test("but an UNFINISHED read never claims it: absence of evidence is not evidence of absence", () => {
  assert.equal(presenceIsSilent({ kind: "unknown", message: "the log could not be read" }), false);
});

test("a session that HAS acted, or read, recently is not silent", () => {
  assert.equal(presenceIsSilent({ kind: "acted", at: AT, agoMs: 1000, heardAgoMs: 1000 }), false);
  assert.equal(presenceIsSilent({ kind: "delivered", at: AT, agoMs: 1000 }), false);
});

test("STALE EVIDENCE IS NO LISTENER: an act or a receipt older than the threshold is silent again", () => {
  // Not two fives: the server reads the same number for its long-poll default.
  assert.equal(FEEDBACK_DELIVERY_THRESHOLD_MS, 300_000);
  const old = FEEDBACK_DELIVERY_THRESHOLD_MS;
  assert.equal(presenceIsSilent({ kind: "acted", at: AT, agoMs: old, heardAgoMs: old }), true);
  assert.equal(presenceIsSilent({ kind: "delivered", at: AT, agoMs: old }), true);
  // A receipt NEWER than the last act is the evidence that counts.
  assert.equal(presenceIsSilent({ kind: "acted", at: AT, agoMs: old * 3, heardAgoMs: 1_000 }), false);
  // Without a clock nobody is accused.
  assert.equal(presenceIsSilent({ kind: "acted", at: AT, agoMs: null, heardAgoMs: null }), false);
});

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
 * and when.
 */
function feedbackDelivered(): Readonly<{ name: string; text: string }> {
  return {
    name: "1759579620000-cccccc-feedback-delivered.json",
    text: JSON.stringify({
      protocolVersion: 1,
      kind: "feedback-delivered",
      at: "2026-10-04T12:07:00.000Z",
      tool: "await_feedback",
      commentIds: ["cc_1"],
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

/** The same revision a minute BEFORE the receipt, so the receipt is the newer evidence. */
function slideRevisedEarlier(): Readonly<{ name: string; text: string }> {
  return {
    name: "1759579500000-dddddd-slide-revised.json",
    text: JSON.stringify({
      protocolVersion: 1,
      kind: "slide-revised",
      at: "2026-10-04T12:05:00.000Z",
      slideIndex: 2,
      answers: ["cc_1"],
    }),
  };
}
