import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitFeedback } from "../feedback/feedback.ts";
import { createFakeComments } from "./fake-comments.ts";
import { pollProgressReporter } from "../long-poll-progress.ts";

/**
 * A long poll must report progress, or the client kills it.
 *
 * Measured against a real Model Context Protocol client: `await_feedback` with a 420 s budget
 * died after 60 s with `McpError -32001: Request timed out  data: { timeout: 60000 }`. The
 * client's timer only resets on a progress notification, and the server sent none — so every
 * wait longer than the client default was unusable, which is the whole point of the tool.
 *
 * This asserts the hook the handler needs: the poll reports each iteration.
 */
test("awaitFeedback reports every poll, so the handler can keep the client's timer alive", async () => {
  let nowMs = 1_000_000;
  const now = (): Date => new Date(nowMs);
  const fileId = "02.html";
  const fake = createFakeComments({ now, pageObjectIds: ["p"], defaultFileId: fileId });
  const seen: number[] = [];

  const outcome = await awaitFeedback({
    env: {
      channel: fake.channel,
      now,
      sleep: async ({ milliseconds }: Readonly<{ milliseconds: number }>) => { nowMs += milliseconds; },
      warn: () => {},
    },
    target: { kind: "candidate", proposalId: "p_test", slideIndex: 2, fileId },
    since: null,
    timeoutMs: 30_000,
    onPoll: ({ polls }) => { seen.push(polls); },
  });

  assert.equal(outcome.kind, "timeout", "nothing was posted, so it must time out as a value");
  assert.ok(seen.length >= 2, `expected several progress reports, got ${seen.length}`);
  assert.deepEqual(seen, seen.map((_, i) => i + 1), "poll numbers must be 1..n with no gaps");
});

/**
 * The reporter only speaks when the client asked, and reports a monotonic fraction.
 *
 * Both halves matter: inventing a `progressToken` the client never sent is a protocol
 * violation, and a `progress` that is not monotonic is one too.
 */
test("pollProgressReporter notifies with a monotonic fraction of the budget", async () => {
  const sent: { progressToken: string | number; progress: number; total?: number; message?: string }[] = [];
  const reporter = pollProgressReporter({
    extra: {
      _meta: { progressToken: "tok-1" },
      sendNotification: async ({ params }) => { sent.push(params); },
    },
    timeoutMs: 10_000,
    describe: ({ polls }) => `poll ${String(polls)}`,
    warn: () => { throw new Error("must not warn"); },
  });

  reporter({ polls: 1, elapsedMs: 0 });
  reporter({ polls: 2, elapsedMs: 4_000 });
  // Past the budget: clipped, because `progress` above `total` is nonsense to a progress bar.
  reporter({ polls: 3, elapsedMs: 99_000 });
  await Promise.resolve();

  assert.deepEqual(
    sent.map((params) => params.progress),
    [0, 4_000, 10_000],
  );
  assert.ok(sent.every((params) => params.progressToken === "tok-1" && params.total === 10_000));
  assert.deepEqual(sent.map((params) => params.message), ["poll 1", "poll 2", "poll 3"]);
});

test("pollProgressReporter stays silent when the client sent no progressToken", () => {
  const reporter = pollProgressReporter({
    extra: {
      sendNotification: async () => { throw new Error("must not notify without a token"); },
    },
    timeoutMs: 1_000,
    describe: () => "unused",
    warn: () => { throw new Error("must not warn"); },
  });
  reporter({ polls: 1, elapsedMs: 0 });
});

/** A client that vanished mid-wait must not take the poll down with it. */
test("pollProgressReporter reports a failed notification and keeps going", async () => {
  const warnings: string[] = [];
  const reporter = pollProgressReporter({
    extra: {
      _meta: { progressToken: 7 },
      sendNotification: async () => { throw new Error("transport closed"); },
    },
    timeoutMs: 1_000,
    describe: () => "poll",
    warn: (message) => { warnings.push(message); },
  });
  reporter({ polls: 1, elapsedMs: 0 });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(warnings, ["progress notification failed: transport closed"]);
});
