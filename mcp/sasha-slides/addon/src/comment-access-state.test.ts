// THE "LET SASHA ANSWER COMMENTS" CARD, as states: which answer shows which card, that a seed never
// beats a fresh answer, that a failed check keeps what is on screen, and that coming back from the
// allow page re-checks exactly once per Allow press.

import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_COMMENT_ACCESS,
  commentAccessCardOf,
  needsCommentAccessCheck,
  reduceCommentAccess,
  type CommentAccessAnswer,
  type CommentAccessEvent,
  type CommentAccessState,
} from "./comment-access-state.ts";

const ALLOW_URL = "https://sashaslides.com/comments/allow?deck=deck_0123456789";
const NEEDS_ALLOW: CommentAccessAnswer = { access: "needsAllow", allowUrl: ALLOW_URL };
const READY: CommentAccessAnswer = { access: "ready" };

function run(events: readonly CommentAccessEvent[], from: CommentAccessState = INITIAL_COMMENT_ACCESS): CommentAccessState {
  return events.reduce(reduceCommentAccess, from);
}

test("each answer draws its card, and only an answer that is not ready draws one", () => {
  // Columns: the checker's answer -> the card.
  const rows: readonly Readonly<{ answer: CommentAccessAnswer; card: ReturnType<typeof commentAccessCardOf> }>[] = [
    { answer: READY, card: null },
    { answer: NEEDS_ALLOW, card: { kind: "allow", allowUrl: ALLOW_URL, checking: false } },
    { answer: { access: "notConnected", connectUrl: "https://sashaslides.com/mcp", explanation: "connect first" }, card: { kind: "notConnected" } },
    { answer: { access: "viewOnly" }, card: { kind: "viewOnly" } },
  ];
  for (const row of rows) {
    const state = run([{ kind: "access-check-requested" }, { kind: "access-check-arrived", answer: row.answer }]);
    assert.deepEqual(commentAccessCardOf(state), row.card, row.answer.access);
  }
  assert.equal(commentAccessCardOf(INITIAL_COMMENT_ACCESS), null, "nothing known yet: no card");
});

test("every open checks once: wanted at the start, not again once it is out or answered", () => {
  assert.equal(needsCommentAccessCheck(INITIAL_COMMENT_ACCESS), true);
  const out = run([{ kind: "access-check-requested" }]);
  assert.equal(needsCommentAccessCheck(out), false, "in flight");
  assert.equal(needsCommentAccessCheck(run([{ kind: "access-check-arrived", answer: READY }], out)), false, "answered");
  assert.equal(needsCommentAccessCheck(run([{ kind: "access-check-failed", message: "HTTP 502" }], out)), false, "failed: no retry loop");
});

test("the seed draws the last answer at once, quietly, and never overwrites a fresh one", () => {
  const seeded = run([{ kind: "access-seeded", answer: NEEDS_ALLOW }, { kind: "access-check-requested" }]);
  assert.deepEqual(commentAccessCardOf(seeded), { kind: "allow", allowUrl: ALLOW_URL, checking: false }, "the boot refresh behind a seed is not announced");
  assert.equal(commentAccessCardOf(run([{ kind: "access-check-arrived", answer: READY }], seeded)), null, "the fresh answer replaces the seed");
  const fresh = run([{ kind: "access-check-arrived", answer: READY }]);
  assert.deepEqual(run([{ kind: "access-seeded", answer: NEEDS_ALLOW }], fresh), fresh, "a late seed is ignored");
});

test("a failed check keeps the card that was on screen", () => {
  const shown = run([{ kind: "access-check-arrived", answer: NEEDS_ALLOW }, { kind: "access-check-requested" }, { kind: "access-check-failed", message: "HTTP 502" }]);
  assert.equal(commentAccessCardOf(shown)?.kind, "allow");
});

test("coming back after Allow re-checks ONCE, says it is checking, and hides the card when ready", () => {
  const shown = run([{ kind: "access-check-requested" }, { kind: "access-check-arrived", answer: NEEDS_ALLOW }]);
  // Columns: what happened since the card was shown -> whether a check is wanted now.
  const rows: readonly Readonly<{ label: string; events: readonly CommentAccessEvent[]; wanted: boolean }>[] = [
    { label: "returned without pressing Allow", events: [{ kind: "access-returned" }], wanted: false },
    { label: "pressed Allow, not back yet", events: [{ kind: "access-allow-opened" }], wanted: false },
    { label: "pressed Allow, came back", events: [{ kind: "access-allow-opened" }, { kind: "access-returned" }], wanted: true },
    { label: "pressed Allow twice, came back", events: [{ kind: "access-allow-opened" }, { kind: "access-allow-opened" }, { kind: "access-returned" }], wanted: true },
  ];
  for (const row of rows) assert.equal(needsCommentAccessCheck(run(row.events, shown)), row.wanted, row.label);

  const rechecking = run([{ kind: "access-allow-opened" }, { kind: "access-returned" }, { kind: "access-check-requested" }], shown);
  assert.deepEqual(commentAccessCardOf(rechecking), { kind: "allow", allowUrl: ALLOW_URL, checking: true });
  const secondReturn = run([{ kind: "access-returned" }], rechecking);
  assert.equal(needsCommentAccessCheck(secondReturn), false, "a second return (focus, then visibility) does not check again");
  assert.equal(commentAccessCardOf(run([{ kind: "access-check-arrived", answer: READY }], secondReturn)), null, "ready: the card goes away");
});

test("a return while the boot check is still out waits for it instead of asking twice", () => {
  const out = run([{ kind: "access-allow-opened" }, { kind: "access-check-requested" }, { kind: "access-returned" }]);
  assert.equal(needsCommentAccessCheck(out), false);
  assert.equal(out.awaitingReturn, true, "the press is still owed its re-check");
  const answered = run([{ kind: "access-check-arrived", answer: NEEDS_ALLOW }, { kind: "access-returned" }], out);
  assert.equal(needsCommentAccessCheck(answered), true);
});
