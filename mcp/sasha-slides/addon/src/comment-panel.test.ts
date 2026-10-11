import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMENT_FILTERS,
  commentCounts,
  commentSections,
  describeNoComments,
  isAddressed,
  type PanelThread,
  type PanelThreadShape,
} from "./comment-panel.ts";

function thread(
  spec: Readonly<{ id: string; at: string; resolved?: boolean; agentReplied?: boolean; userReplied?: boolean }>,
): PanelThreadShape {
  const replies = [
    ...(spec.agentReplied === true ? [{ voice: "sasha" as const }] : []),
    ...(spec.userReplied === true ? [{ voice: "user" as const }] : []),
  ];
  return { commentId: spec.id, at: spec.at, resolved: spec.resolved ?? false, replies };
}

const at = (n: number) => `2026-10-0${String(n)}T10:00:00.000Z`;

const ALL: readonly PanelThread[] = [
  { slideIndex: 1, thread: thread({ id: "open_new", at: at(5) }) },
  { slideIndex: 2, thread: thread({ id: "answered", at: at(3), agentReplied: true }) },
  { slideIndex: 2, thread: thread({ id: "open_old", at: at(1) }) },
  { slideIndex: 3, thread: thread({ id: "finished", at: at(4), resolved: true, agentReplied: true }) },
];

test("ADDRESSED LEADS: an open comment Sasha answered is what the user should look at first", () => {
  const sections = commentSections({ threads: ALL, filter: "open" });
  assert.deepEqual(
    sections.map((s) => s.kind),
    ["addressed", "not-addressed"],
    "addressed on top",
  );
  assert.deepEqual(sections[0]?.threads.map((t) => t.thread.commentId), ["answered"]);
  // Newest first within the section.
  assert.deepEqual(sections[1]?.threads.map((t) => t.thread.commentId), ["open_new", "open_old"]);
});

test("a thread marked done never appears under the open filter, however it was answered", () => {
  const ids = commentSections({ threads: ALL, filter: "open" }).flatMap((s) =>
    s.threads.map((t) => t.thread.commentId),
  );
  assert.ok(!ids.includes("finished"), `open showed ${ids.join(",")}`);
});

test("SASHA ANSWERING IS NOT THE USER AGREEING: an answered thread stays open until marked done", () => {
  const answered = [{ slideIndex: 2, thread: thread({ id: "answered", at: at(3), agentReplied: true }) }];
  const sections = commentSections({ threads: answered, filter: "open" });
  assert.equal(sections.length, 1);
  assert.equal(sections[0]?.kind, "addressed", "still open, just addressed");
});

test("the done filter shows only what the user closed", () => {
  const sections = commentSections({ threads: ALL, filter: "done" });
  assert.deepEqual(sections.map((s) => s.kind), ["done"]);
  assert.deepEqual(sections[0]?.threads.map((t) => t.thread.commentId), ["finished"]);
});

test("the all filter shows every section, open ones still first", () => {
  const sections = commentSections({ threads: ALL, filter: "all" });
  assert.deepEqual(sections.map((s) => s.kind), ["addressed", "not-addressed", "done"]);
  assert.equal(
    sections.flatMap((s) => s.threads).length,
    ALL.length,
    "every thread is somewhere, exactly once",
  );
});

test("an empty section is not rendered as a heading over nothing", () => {
  const onlyOpen = [{ slideIndex: 1, thread: thread({ id: "a", at: at(1) }) }];
  assert.deepEqual(
    commentSections({ threads: onlyOpen, filter: "all" }).map((s) => s.kind),
    ["not-addressed"],
  );
});

test("a reply from the USER does not make a thread addressed -- only Sasha's does", () => {
  assert.equal(isAddressed(thread({ id: "x", at: at(1), userReplied: true })), false);
  assert.equal(isAddressed(thread({ id: "y", at: at(1), agentReplied: true })), true);
  // And a user reply AFTER Sasha's answer keeps it addressed: the answer is still there.
  assert.equal(isAddressed(thread({ id: "z", at: at(1), agentReplied: true, userReplied: true })), true);
});

test("the filter control carries counts, so switching is not needed to learn there is work", () => {
  assert.deepEqual(commentCounts(ALL), { open: 3, done: 1, all: 4 });
});

test("every filter has its own empty sentence, and there are exactly three filters", () => {
  assert.deepEqual([...COMMENT_FILTERS], ["open", "done", "all"]);
  const said = COMMENT_FILTERS.map((filter) => describeNoComments(filter));
  assert.equal(new Set(said).size, said.length, "each says something different");
});

test("an unparseable timestamp sorts last instead of scrambling the order", () => {
  const messy: readonly PanelThread[] = [
    { slideIndex: 1, thread: thread({ id: "good_old", at: at(1) }) },
    { slideIndex: 1, thread: { ...thread({ id: "broken", at: at(1) }), at: "not a date" } },
    { slideIndex: 1, thread: thread({ id: "good_new", at: at(9) }) },
  ];
  const ids = commentSections({ threads: messy, filter: "open" })[0]?.threads.map((t) => t.thread.commentId);
  assert.deepEqual(ids, ["good_new", "good_old", "broken"]);
});
