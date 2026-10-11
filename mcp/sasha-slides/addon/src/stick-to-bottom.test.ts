import assert from "node:assert/strict";
import test from "node:test";
import { shouldStickToBottom, BOTTOM_SLACK_PX } from "./stick-to-bottom.ts";

/**
 * Ask Sasha opened on the OLDEST entry: `.sasha-msgs` is a bounded scroll box and nothing ever
 * set its scroll position, so every answer Sasha wrote landed below the fold and the user had
 * to scroll to find out whether anything had happened at all.
 */
test("a reader sitting at the bottom keeps following the conversation", () => {
  assert.equal(shouldStickToBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }), true);
});

test("a reader who scrolled up to read history is left alone", () => {
  assert.equal(shouldStickToBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400 }), false);
  assert.equal(shouldStickToBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 400 }), false);
});

/**
 * THE SLACK IS LOAD-BEARING. A fractional device-pixel ratio leaves the sum a hair short of
 * `scrollHeight` even when the box is scrolled fully down; an exact comparison reads that as
 * "scrolled up" and the log silently stops following for the rest of the session.
 */
test("a hair short of the bottom is still the bottom", () => {
  assert.equal(shouldStickToBottom({ scrollTop: 599.6, scrollHeight: 1000, clientHeight: 400 }), true);
  assert.equal(
    shouldStickToBottom({ scrollTop: 600 - BOTTOM_SLACK_PX, scrollHeight: 1000, clientHeight: 400 }),
    true,
    "exactly at the slack still counts",
  );
  assert.equal(
    shouldStickToBottom({ scrollTop: 600 - BOTTOM_SLACK_PX - 1, scrollHeight: 1000, clientHeight: 400 }),
    false,
    "one pixel past it does not",
  );
});

/** A log too short to scroll is trivially at the bottom, so it must not be treated as scrolled up. */
test("a log that does not overflow is at the bottom", () => {
  assert.equal(shouldStickToBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 }), true);
});
