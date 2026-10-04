// THE COMMENT CARD, which both surfaces draw: the Ask Sasha log and the slides window's mark-ups.
//
// The shapes asserted here are read off a real Google Slides comment card (the screenshot the user
// sent on 2026-10-04): a round avatar with one initial, the author's name in bold, the time under
// it as "12:08 AM Today", the body below at the card's own left edge -- NOT indented under the
// avatar -- and a pill-shaped composer at the foot.

import assert from "node:assert/strict";
import test from "node:test";
import { avatarInitialOf, describeCommentTime } from "./comment-card.tsx";

const NOON = Date.parse("2026-10-04T12:08:00.000Z");

test("the avatar is one letter, uppercase, from the author's name", () => {
  assert.equal(avatarInitialOf("Ante M"), "A");
  assert.equal(avatarInitialOf("sasha"), "S");
  // Leading spaces are not an initial, and neither is nothing.
  assert.equal(avatarInitialOf("   ante"), "A");
  assert.equal(avatarInitialOf(""), "?");
  assert.equal(avatarInitialOf("   "), "?");
});

test("an emoji or other astral character is kept whole, never split into half a surrogate pair", () => {
  assert.equal(avatarInitialOf("😀 nobody"), "😀");
});

test("today's time reads like Google's: the clock, then the word Today", () => {
  assert.equal(
    describeCommentTime({ at: "2026-10-04T12:08:00.000Z", nowMs: NOON, timeZone: "UTC" }),
    "12:08 PM Today",
  );
  assert.equal(
    describeCommentTime({ at: "2026-10-04T00:08:00.000Z", nowMs: NOON, timeZone: "UTC" }),
    "12:08 AM Today",
  );
});

test("yesterday is named, and anything older gets its date", () => {
  assert.equal(
    describeCommentTime({ at: "2026-10-03T23:00:00.000Z", nowMs: NOON, timeZone: "UTC" }),
    "11:00 PM Yesterday",
  );
  assert.match(
    describeCommentTime({ at: "2026-09-28T09:30:00.000Z", nowMs: NOON, timeZone: "UTC" }),
    /^9:30 AM Sep \d{1,2}$/,
  );
});

/** With no clock yet the time is still shown -- it is known; only "Today" is not. */
test("with no clock the card still dates the post, it just cannot say Today", () => {
  assert.match(describeCommentTime({ at: "2026-10-04T12:08:00.000Z", nowMs: null, timeZone: "UTC" }), /^12:08 PM/);
  assert.doesNotMatch(describeCommentTime({ at: "2026-10-04T12:08:00.000Z", nowMs: null, timeZone: "UTC" }), /Today/);
});

test("an unparseable or absent timestamp says nothing rather than Invalid Date", () => {
  assert.equal(describeCommentTime({ at: "", nowMs: NOON, timeZone: "UTC" }), "");
  assert.equal(describeCommentTime({ at: "not a date", nowMs: NOON, timeZone: "UTC" }), "");
});
