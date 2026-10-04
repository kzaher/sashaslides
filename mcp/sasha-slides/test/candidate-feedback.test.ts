/**
 * Comments on a CANDIDATE: the feedback channel repointed off the deck and onto `NN.html`,
 * asserted against the in-memory Drive and the in-memory comment channel together.
 *
 *   cd mcp/sasha-slides && npx tsx --test test/candidate-feedback.test.ts
 *
 * This is the file that proves the two things the redesign turns on: the slide a comment is
 * about is the FILE it is on (so it can never be guessed wrong), and a revision keeps that
 * file's id (so the threads do not detach from the slide they are about).
 *
 * Ordered to follow candidate-feedback.ts.
 */
import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import {
  awaitCandidateFeedback,
  describeCandidateAddressFailure,
  readCandidateFeedback,
  replyToCandidateComment,
  resolveCandidateComment,
  type CandidateFeedbackEnvironment,
} from "../feedback/candidate-feedback";
import { AGENT_REPLY_MARKER, countUnresolvedThreads } from "../feedback/feedback";
import { createProposal, reviseSlide, type ProposalEnvironment } from "../proposal";
import { DEFAULT_FEEDBACK_TIMEOUT_MS, readFeedbackPayload, replyFeedbackPayload } from "../server";
import { FEEDBACK_DELIVERY_THRESHOLD_MS } from "../feedback-delivery";
import { createFakeComments, type FakeComments } from "./fake-comments";
import { createFakeDrive, type FakeDrive } from "./fake-drive";

describe("readCandidateFeedback", () => {
  test("places a comment by the candidate file it is on - no anchor, no guessing", async () => {
    const harness = await stage({ count: 3 });
    harness.comment({ slideIndex: 2, text: "the chart is unreadable" });

    const read = await readCandidateFeedback({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: null,
      since: null,
      includeResolved: false,
    });
    assert.equal(read.kind, "ok");
    if (read.kind !== "ok") return;
    assert.equal(read.outcome.threads.length, 1);
    const slide = read.outcome.threads[0]?.slide;
    assert.deepEqual(slide, {
      kind: "slide",
      pageObjectId: null,
      slideNumber: 2,
      elementObjectIds: [],
      via: "candidate-file",
    });
    // Nothing asked the Slides API for a page order: a candidate has no deck to number.
    assert.equal(harness.comments.calls().some((call) => call.op === "listSlidePages"), false);
  });

  test("reports an unresolved count for EVERY candidate, so the grid and the log agree", async () => {
    const harness = await stage({ count: 3 });
    harness.comment({ slideIndex: 1, text: "too dense" });
    harness.comment({ slideIndex: 1, text: "and the title is cropped" });
    harness.comment({ slideIndex: 3, text: "wrong accent colour" });

    const read = await readCandidateFeedback({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 1,
      since: null,
      includeResolved: false,
    });
    assert.equal(read.kind, "ok");
    if (read.kind !== "ok") return;
    assert.deepEqual(
      read.unresolved.map((entry) => ({ slideIndex: entry.slideIndex, unresolved: entry.unresolved })),
      [
        { slideIndex: 1, unresolved: 2 },
        { slideIndex: 2, unresolved: 0 },
        { slideIndex: 3, unresolved: 1 },
      ],
    );
    // Asked about one candidate, so only that one's threads come back.
    assert.equal(read.outcome.threads.length, 2);
  });

  test("a count it cannot reach is null, never 0 - a clear badge on a complained-about slide is worse", async () => {
    const harness = await stage({ count: 2 });
    harness.comment({ slideIndex: 1, text: "fix the legend" });
    const breaking: CandidateFeedbackEnvironment = {
      proposal: harness.env.proposal,
      feedback: {
        ...harness.env.feedback,
        channel: {
          ...harness.comments.channel,
          listComments: () => Promise.reject(new Error("503 from Drive")),
        },
      },
    };
    const read = await readCandidateFeedback({
      env: breaking,
      proposalId: harness.proposalId,
      slideIndex: null,
      since: null,
      includeResolved: false,
    });
    // A read that returned no threads would look exactly like "the user said nothing".
    assert.equal(read.kind, "failed");
    if (read.kind !== "failed") return;
    assert.equal(read.failure.kind, "drive-failed");
    assert.match(describeCandidateAddressFailure(read.failure), /Drive could not be reached: 503 from Drive/);
    assert.equal(readFeedbackPayload(read).kind, "error");

    // The per-candidate COUNT, separately, degrades to null rather than to zero.
    const counted = await countUnresolvedThreads({
      env: breaking.feedback,
      targets: [{ kind: "candidate", proposalId: harness.proposalId, slideIndex: 1, fileId: harness.fileIdFor({ slideIndex: 1 }) }],
    });
    assert.deepEqual(
      counted.map((entry) => ({ slideIndex: entry.slideIndex, unresolved: entry.unresolved })),
      [{ slideIndex: 1, unresolved: null }],
    );
  });

  test("an unknown proposal and an unknown candidate are values, with what IS available", async () => {
    const harness = await stage({ count: 2 });
    const unknownProposal = await readCandidateFeedback({
      env: harness.env,
      proposalId: "p_nope_aaaaaa",
      slideIndex: null,
      since: null,
      includeResolved: false,
    });
    assert.equal(unknownProposal.kind, "failed");
    if (unknownProposal.kind !== "failed") return;
    assert.equal(unknownProposal.failure.kind, "unknown-proposal");
    assert.match(describeCandidateAddressFailure(unknownProposal.failure), /no proposal p_nope_aaaaaa/);

    const unknownSlide = await readCandidateFeedback({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 9,
      since: null,
      includeResolved: false,
    });
    assert.equal(unknownSlide.kind, "failed");
    if (unknownSlide.kind !== "failed") return;
    assert.match(describeCandidateAddressFailure(unknownSlide.failure), /has no candidate 9; it holds 1, 2/);
    // And the tool payload is an error the model can act on, not a crash.
    assert.equal(readFeedbackPayload(unknownSlide).kind, "error");
  });
});

describe("the feedback-delivered receipt", () => {
  test("ONE receipt per delivery, naming the comment ids handed over and when", async () => {
    const harness = await stage({ count: 2 });
    const first = harness.comment({ slideIndex: 1, text: "too dense" });
    const second = harness.comment({ slideIndex: 2, text: "wrong accent colour" });

    const read = await readCandidateFeedback({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: null,
      since: null,
      includeResolved: false,
    });
    assert.equal(read.kind, "ok");
    if (read.kind !== "ok") return;
    // It is a RECEIPT, not an answer: nothing was replied to and nothing was resolved.
    assert.deepEqual(harness.logKinds(), ["slides-staged", "feedback-delivered"]);
    assert.deepEqual(read.delivery, {
      kind: "logged",
      at: "2026-10-04T12:00:00.000Z",
      commentIds: [first.id, second.id],
    });
    const receipt = harness.receipts()[0];
    assert.equal(receipt?.["kind"], "feedback-delivered");
    assert.equal(receipt?.["tool"], "read_feedback");
    assert.deepEqual(receipt?.["commentIds"], [first.id, second.id]);
    assert.equal(typeof receipt?.["at"], "string");
  });

  test("A READ THAT HANDS BACK NOTHING WRITES NO RECEIPT -- there was no delivery to receipt", async () => {
    const harness = await stage({ count: 2 });
    const read = await readCandidateFeedback({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: null,
      since: null,
      includeResolved: false,
    });
    assert.equal(read.kind, "ok");
    if (read.kind !== "ok") return;
    assert.deepEqual(read.delivery, { kind: "nothing-delivered" });
    assert.deepEqual(harness.logKinds(), ["slides-staged"]);
  });

  test("await_feedback receipts the posts it woke on, and a timeout receipts nothing", async () => {
    const harness = await stage({ count: 1 });
    const timedOut = await awaitCandidateFeedback({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 1,
      since: null,
      timeoutMs: 1_000,
    });
    assert.equal(timedOut.kind === "ok" && timedOut.outcome.kind, "timeout");
    assert.equal(timedOut.kind === "ok" ? timedOut.delivery.kind : null, "nothing-delivered");
    assert.deepEqual(harness.logKinds(), ["slides-staged"], "a timeout is not a delivery");

    const comment = harness.comment({ slideIndex: 1, text: "fix the legend" });
    const arrived = await awaitCandidateFeedback({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 1,
      since: timedOut.kind === "ok" && timedOut.outcome.kind === "timeout" ? timedOut.outcome.cursor : null,
      timeoutMs: 3_000,
    });
    assert.equal(arrived.kind, "ok");
    if (arrived.kind !== "ok" || arrived.outcome.kind !== "arrived") return;
    assert.deepEqual(harness.logKinds(), ["slides-staged", "feedback-delivered"]);
    assert.equal(arrived.delivery.kind, "logged");
    assert.deepEqual(arrived.delivery.kind === "logged" ? arrived.delivery.commentIds : [], [comment.id]);
  });

  test("a receipt Drive refused is reported, never a clean success -- the add-on will mis-accuse", async () => {
    const harness = await stage({ count: 1 });
    harness.comment({ slideIndex: 1, text: "too dense" });
    const read = await readCandidateFeedback({
      env: {
        proposal: {
          ...harness.env.proposal,
          drive: { ...harness.drive.channel, createFile: () => Promise.reject(new Error("503 from Drive")) },
        },
        feedback: harness.env.feedback,
      },
      proposalId: harness.proposalId,
      slideIndex: null,
      since: null,
      includeResolved: false,
    });
    assert.equal(read.kind, "ok", "the agent still has the comment: failing the read would be worse");
    if (read.kind !== "ok") return;
    assert.equal(read.delivery.kind, "log-failed");
    const payload = readFeedbackPayload(read);
    assert.equal(payload.kind, "payload");
    if (payload.kind !== "payload") return;
    assert.equal(payload.payload.deliveryLogged, false);
    assert.match(payload.payload.note ?? "", /nobody is listening/);
  });

  test("the add-on's threshold and the server's long-poll default are the SAME constant", async () => {
    // Not two fives. The threshold is defensible only because one poll of a connected client is
    // this long, so the add-on reads the server's own number rather than a copy of it.
    assert.equal(DEFAULT_FEEDBACK_TIMEOUT_MS, FEEDBACK_DELIVERY_THRESHOLD_MS);
  });
});

describe("replyToCandidateComment and resolveCandidateComment", () => {
  test("the reply lands in the user's thread, tagged, and comment-answered is logged", async () => {
    const harness = await stage({ count: 2 });
    const comment = harness.comment({ slideIndex: 2, text: "the chart is unreadable" });

    const replied = await replyToCandidateComment({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 2,
      commentId: comment.id,
      text: "redrawn with bigger labels",
    });
    assert.equal(replied.kind, "ok");
    if (replied.kind !== "ok") return;
    assert.equal(replied.outcome.kind, "ok");
    assert.equal(replied.logged, true);

    const thread = harness.comments.threads().find((candidate) => candidate.id === comment.id);
    assert.equal(thread?.replies.length, 1);
    assert.match(thread?.replies[0]?.text ?? "", /redrawn with bigger labels/);
    assert.match(thread?.replies[0]?.text ?? "", new RegExp(escapeForRegExp(AGENT_REPLY_MARKER)));

    const logged = harness.logKinds();
    assert.deepEqual(logged, ["slides-staged", "comment-answered"]);
  });

  test("a reply addressed to the WRONG candidate is refused, not posted somewhere else", async () => {
    const harness = await stage({ count: 2 });
    const comment = harness.comment({ slideIndex: 2, text: "fix this" });
    const replied = await replyToCandidateComment({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 1,
      commentId: comment.id,
      text: "answering the wrong one",
    });
    assert.equal(replied.kind, "ok");
    if (replied.kind !== "ok") return;
    assert.equal(replied.outcome.kind, "unknown-comment");
    assert.equal(replyFeedbackPayload({ outcome: replied, tool: "reply_feedback" }).kind, "error");
    // Nothing was posted and nothing was logged.
    assert.equal(harness.comments.threads()[0]?.replies.length, 0);
    assert.deepEqual(harness.logKinds(), ["slides-staged"]);
  });

  test("a reply that posted but could not be logged says so rather than reporting a clean success", async () => {
    const harness = await stage({ count: 1 });
    const comment = harness.comment({ slideIndex: 1, text: "too dense" });
    const replied = await replyToCandidateComment({
      env: {
        proposal: {
          ...harness.env.proposal,
          drive: { ...harness.drive.channel, createFile: () => Promise.reject(new Error("503 from Drive")) },
        },
        feedback: harness.env.feedback,
      },
      proposalId: harness.proposalId,
      slideIndex: 1,
      commentId: comment.id,
      text: "tightened it",
    });
    assert.equal(replied.kind, "ok");
    if (replied.kind !== "ok") return;
    assert.equal(replied.outcome.kind, "ok", "the user has the answer");
    assert.equal(replied.logged, false);
    assert.equal(replied.logFailure, "503 from Drive");
    const payload = replyFeedbackPayload({ outcome: replied, tool: "reply_feedback" });
    assert.equal(payload.kind, "payload");
    assert.match(payload.kind === "payload" ? (payload.payload.note ?? "") : "", /session log entry could not be written/);
  });

  test("resolving closes the thread, drops it from the count, and logs comment-resolved", async () => {
    const harness = await stage({ count: 2 });
    const comment = harness.comment({ slideIndex: 1, text: "wrong colour" });
    const resolved = await resolveCandidateComment({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 1,
      commentId: comment.id,
      text: null,
    });
    assert.equal(resolved.kind, "ok");
    if (resolved.kind !== "ok") return;
    assert.equal(resolved.outcome.kind === "ok" ? resolved.outcome.resolved : false, true);
    assert.deepEqual(harness.logKinds(), ["slides-staged", "comment-resolved"]);

    const read = await readCandidateFeedback({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 1,
      since: null,
      includeResolved: false,
    });
    assert.equal(read.kind, "ok");
    if (read.kind !== "ok") return;
    assert.equal(read.outcome.threads.length, 0);
    assert.equal(read.unresolved.find((entry) => entry.slideIndex === 1)?.unresolved, 0);
  });
});

describe("a revision keeps the threads attached", () => {
  test("revise_slide replaces the HTML and the comment thread is still on that slide", async () => {
    const harness = await stage({ count: 2 });
    const comment = harness.comment({ slideIndex: 2, text: "the chart is unreadable" });
    const fileIdBefore = harness.fileIdFor({ slideIndex: 2 });

    const revised = await reviseSlide({
      env: harness.env.proposal,
      proposalId: harness.proposalId,
      slideIndex: 2,
      htmlPath: "/slides/candidate-2-v2.html",
      label: null,
      answeredCommentIds: [comment.id],
    });
    assert.equal(revised.kind, "ok");
    if (revised.kind !== "ok") return;
    assert.equal(revised.fileId, fileIdBefore, "the file id is what the threads hang off");

    const read = await readCandidateFeedback({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 2,
      since: null,
      includeResolved: false,
    });
    assert.equal(read.kind, "ok");
    if (read.kind !== "ok") return;
    assert.equal(read.outcome.threads[0]?.commentId, comment.id);
    assert.equal(read.outcome.threads[0]?.slide.kind === "slide" ? read.outcome.threads[0]?.slide.slideNumber : null, 2);
  });
});

describe("awaitCandidateFeedback", () => {
  test("ignores the agent's own reply and times out as a value", async () => {
    const harness = await stage({ count: 1 });
    const comment = harness.comment({ slideIndex: 1, text: "fix the legend" });
    await replyToCandidateComment({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 1,
      commentId: comment.id,
      text: "fixed",
    });
    const waited = await awaitCandidateFeedback({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 1,
      since: null,
      timeoutMs: 3_000,
    });
    assert.equal(waited.kind, "ok");
    if (waited.kind !== "ok") return;
    assert.equal(waited.outcome.kind, "timeout");
  });

  test("wakes on the user's reply, on the candidate it was watching", async () => {
    const harness = await stage({ count: 2 });
    const comment = harness.comment({ slideIndex: 2, text: "fix the legend" });
    const first = await awaitCandidateFeedback({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 2,
      since: null,
      timeoutMs: 1_000,
    });
    assert.equal(first.kind === "ok" && first.outcome.kind, "timeout");

    harness.comments.putUserReply({ commentId: comment.id, text: "much better" });
    const waited = await awaitCandidateFeedback({
      env: harness.env,
      proposalId: harness.proposalId,
      slideIndex: 2,
      since: first.kind === "ok" && first.outcome.kind === "timeout" ? first.outcome.cursor : null,
      timeoutMs: 3_000,
    });
    assert.equal(waited.kind, "ok");
    if (waited.kind !== "ok" || waited.outcome.kind !== "arrived") return;
    assert.equal(waited.outcome.posts.length, 1);
    assert.equal(waited.outcome.posts[0]?.text, "much better");
    assert.equal(
      waited.outcome.posts[0]?.slide.kind === "slide" ? waited.outcome.posts[0]?.slide.slideNumber : null,
      2,
    );
  });
});

type Harness = Readonly<{
  drive: FakeDrive;
  comments: FakeComments;
  env: CandidateFeedbackEnvironment;
  proposalId: string;
  fileIdFor: (options: Readonly<{ slideIndex: number }>) => string;
  /** The user commenting on `NN.html` in Drive, which is the whole transport. */
  comment: (options: Readonly<{ slideIndex: number; text: string }>) => Readonly<{ id: string }>;
  logKinds: () => readonly string[];
  /** Every `feedback-delivered` body in the log, parsed, in the order the files were written. */
  receipts: () => readonly Readonly<Record<string, unknown>>[];
}>;

async function stage(options: Readonly<{ count: number }>): Promise<Harness> {
  const drive = createFakeDrive();
  let nowMs = Date.parse("2026-10-04T12:00:00.000Z");
  // ONE clock for both fakes: when they drifted, a reply written "now" landed before a
  // cursor taken "now" and the cursor tests became unrepeatable.
  const now = (): Date => new Date(nowMs);
  let suffix = 0;
  const proposalEnv: ProposalEnvironment = {
    drive: drive.channel,
    now,
    randomSuffix: () => {
      suffix += 1;
      return String(suffix).padStart(6, "a");
    },
    sleep: ({ milliseconds }) => {
      nowMs += milliseconds;
      return Promise.resolve();
    },
    statFile: () => ({ bytes: 2048 }),
    warn: () => undefined,
  };
  const comments = createFakeComments({ now, pageObjectIds: ["p"], defaultFileId: "unused-deck" });
  const env: CandidateFeedbackEnvironment = {
    proposal: proposalEnv,
    feedback: {
      channel: comments.channel,
      now,
      sleep: ({ milliseconds }) => {
        nowMs += milliseconds;
        return Promise.resolve();
      },
      warn: () => undefined,
    },
  };

  const slides = Array.from({ length: options.count }, (_, position) => ({
    path: `/slides/candidate-${String(position + 1)}.html`,
    label: `option ${String(position + 1)}`,
  }));
  const staged = await createProposal({ env: proposalEnv, slides, presentationId: null });
  if (staged.kind !== "ok") throw new Error(`staging failed: ${staged.reason}`);

  const fileIdFor = ({ slideIndex }: Readonly<{ slideIndex: number }>): string => {
    const slide = staged.slides.find((candidate) => candidate.index === slideIndex);
    if (slide === undefined) throw new Error(`no candidate ${String(slideIndex)}`);
    return slide.fileId;
  };
  return {
    drive,
    comments,
    env,
    proposalId: staged.proposalId,
    fileIdFor,
    comment: ({ slideIndex, text }) =>
      comments.putUserComment({ fileId: fileIdFor({ slideIndex }), text, anchor: null }),
    logKinds: () =>
      drive
        .files()
        .filter((file) => /^\d+-[0-9a-z]+-.+\.json$/.test(file.name))
        .map((file) => file.name.replace(/^\d+-[0-9a-z]+-/, "").replace(/\.json$/, "")),
    receipts: () =>
      drive
        .files()
        .filter((file) => /-feedback-delivered\.json$/.test(file.name))
        .flatMap((file) => {
          const parsed: unknown = JSON.parse(file.text ?? "null");
          return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? [parsed as Readonly<Record<string, unknown>>]
            : [];
        }),
  };
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
