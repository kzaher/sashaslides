// THE COMMENT CARD, which both surfaces draw: the Ask Sasha log and the slides window's mark-ups.
//
// The shapes asserted here are read off a real Google Slides comment card (the screenshot the user
// sent on 2026-10-04): a round avatar with one initial, the author's name in bold, the time under
// it as "12:08 AM Today", the body below at the card's own left edge -- NOT indented under the
// avatar -- and a pill-shaped composer at the foot.

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CHECK_ICON_PATH,
  CommentHead,
  MORE_VERT_ICON_PATH,
  MoreMenu,
  ReplyPill,
  ResolveButton,
  avatarInitialOf,
  describeCommentTime,
  replyKeyIntent,
} from "./comment-card.tsx";

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

// --- the thread card's controls --------------------------------------------

test("the resolve tick is Google's Material check icon, blue, with Google's own tooltip", () => {
  const markup = renderToStaticMarkup(createElement(ResolveButton, { disabled: false, onResolve: () => {} }));
  assert.equal(CHECK_ICON_PATH, "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z");
  assert.match(markup, new RegExp(`d="${CHECK_ICON_PATH.replace(/[.]/g, "\\.")}"`));
  assert.match(markup, /title="Mark as resolved and hide discussion"/);
  assert.match(markup, /aria-label="Mark as resolved and hide discussion"/);
  assert.doesNotMatch(markup, /✓/, "an icon, not a text glyph");
});

test("the three-dot menu is the vertical Material icon, and closed until it is pressed", () => {
  const markup = renderToStaticMarkup(createElement(MoreMenu, { items: [{ kind: "copy", text: "hello" }] }));
  assert.match(markup, /d="M12 8c1\.1 0 2-\.9 2-2s-\.9-2-2-2/);
  assert.ok(markup.includes(`d="${MORE_VERT_ICON_PATH}"`));
  assert.match(markup, /aria-label="More options"/);
  assert.match(markup, /aria-haspopup="menu"/);
  assert.doesNotMatch(markup, /role="menu"/, "no popover until the button is pressed");
  assert.doesNotMatch(markup, /⋮/, "an icon, not a text glyph");
});

test("the reply pill carries Google's placeholder, and Reply appears only once there is text", () => {
  const empty = renderToStaticMarkup(
    createElement(ReplyPill, { value: "", disabled: false, onType: () => {}, onSubmit: () => {} }),
  );
  assert.match(empty, /placeholder="Reply or add others with @"/);
  assert.doesNotMatch(empty, /class="sasha-c-reply-send"/);
  const typed = renderToStaticMarkup(
    createElement(ReplyPill, { value: "more contrast", disabled: false, onType: () => {}, onSubmit: () => {} }),
  );
  assert.match(typed, /class="sasha-c-reply-send"[^>]*>Reply</);
});

test("Enter sends, Shift+Enter is a newline, and an IME composition is never cut short", () => {
  assert.equal(replyKeyIntent({ key: "Enter", shiftKey: false, composing: false }), "send");
  assert.equal(replyKeyIntent({ key: "Enter", shiftKey: true, composing: false }), "type");
  assert.equal(replyKeyIntent({ key: "Enter", shiftKey: false, composing: true }), "type");
  assert.equal(replyKeyIntent({ key: "a", shiftKey: false, composing: false }), "type");
});

test("the agent's avatar has a colour of its own, so Sasha never reads as the user", () => {
  const sasha = renderToStaticMarkup(createElement(CommentHead, { author: "Sasha", at: "", nowMs: null, tone: "agent" }));
  const you = renderToStaticMarkup(createElement(CommentHead, { author: "Ante", at: "", nowMs: null }));
  assert.match(sasha, /class="sasha-c-avatar sasha-c-avatar-agent"[^>]*>S</);
  assert.match(you, /class="sasha-c-avatar"[^>]*>A</);
});
