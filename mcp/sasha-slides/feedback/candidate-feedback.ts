/**
 * Where the two channels meet: a comment on a CANDIDATE.
 *
 * `feedback.ts` knows how to talk to Drive's comment threads and `proposal.ts` knows where a
 * proposal's `NN.html` files are. This file is the only place that needs both, so it is the
 * only place that holds both environments — everything below it still sees exactly one.
 *
 * What it adds on top of a plain comment read:
 *
 *  - **Addressing.** `(proposalId, slideIndex)` becomes the Drive file id of `NN.html`. The
 *    user is marking up the thing they are looking at, before it is inserted, which is the
 *    correction UI-CONTRACT.md calls the one that matters most: a comment on a deck page is a
 *    bug report, a comment on a candidate is art direction.
 *  - **The log.** Sasha's answer and the thread closing are events in the session log, so the
 *    conversation can render the round trip. A reply that reached the user but whose event did
 *    not reach Drive is reported as `logged: false`, never as a clean success — the user has
 *    the answer, so failing the whole call would be a lie in the other direction.
 *  - **Unresolved counts.** One query per candidate, which both surfaces read, so the grid's
 *    badge and the conversation's count cannot disagree.
 *  - **The delivery receipt.** Handing a comment to a client is itself an event
 *    (`feedback-delivered`), because it is the ONLY thing that proves to the add-on that anything
 *    is listening. Without it the add-on can count elapsed seconds and nothing else, which is how
 *    a user came to watch a spinner for 1 h 47 minutes with no session attached. A receipt is NOT
 *    an answer, and a read that hands back nothing writes none.
 */
import {
  awaitFeedback,
  countUnresolvedThreads,
  readFeedback,
  replyFeedback,
  resolveFeedback,
  type AwaitFeedbackOutcome,
  type FeedbackCursor,
  type CandidateTarget,
  type FeedbackEnvironment,
  type ReadFeedbackOutcome,
  type ReplyFeedbackOutcome,
  type UnresolvedSlideCount,
} from "./feedback";
import { assertNever } from "../google-auth";
import {
  appendProposalEvent,
  findCandidate,
  listCandidates,
  type CandidateFile,
  type ProposalEnvironment,
} from "../proposal";
import { SESSION_LOG_PROTOCOL_VERSION, type FeedbackDeliveryTool, type SessionEvent } from "../session-log";

/**
 * Both halves, injected. They are separate environments rather than one merged one because
 * they are resolved separately per call — in HTTP mode from the same caller's identity, in
 * stdio mode from the one developer token — and nothing here should be able to mix them up.
 */
export type CandidateFeedbackEnvironment = Readonly<{
  proposal: ProposalEnvironment;
  feedback: FeedbackEnvironment;
}>;

/** Why a `(proposalId, slideIndex)` could not be turned into a candidate file. */
export type CandidateAddressFailure =
  | Readonly<{ kind: "unknown-proposal"; proposalId: string }>
  | Readonly<{ kind: "unknown-slide"; proposalId: string; slideIndex: number; available: readonly number[] }>
  | Readonly<{ kind: "drive-failed"; reason: string }>;

export type ReadCandidateFeedbackOutcome =
  | Readonly<{
      kind: "ok";
      proposalId: string;
      /** Null when the whole proposal was read rather than one candidate. */
      slideIndex: number | null;
      outcome: ReadFeedbackOutcome;
      /** Every candidate's open-thread count, so the grid and the conversation agree. */
      unresolved: readonly UnresolvedSlideCount[];
      /** What the log now says about this hand-over. A receipt, never an answer. */
      delivery: DeliveryReceipt;
    }>
  | Readonly<{ kind: "failed"; failure: CandidateAddressFailure }>;

/**
 * WHETHER THE HAND-OVER WAS RECEIPTED, as a value with three arms rather than a boolean, because
 * the three mean different things to the user on the other end:
 *
 *  - `nothing-delivered` — no comment changed hands, so there is nothing to receipt. Correct
 *    silence. The add-on is right to keep saying nothing is listening, because nothing read
 *    anything.
 *  - `logged` — the add-on will see this and stop accusing nobody of listening.
 *  - `log-failed` — the agent HAS the comment but the user's add-on cannot know it, so past the
 *    threshold it will tell them nobody is listening while a session is reading them. Reported to
 *    the agent for exactly that reason; never hidden behind a clean success.
 */
export type DeliveryReceipt =
  | Readonly<{ kind: "nothing-delivered" }>
  | Readonly<{ kind: "logged"; at: string; commentIds: readonly string[] }>
  | Readonly<{ kind: "log-failed"; reason: string; commentIds: readonly string[] }>;

/**
 * The user's comments on a proposal's candidates. With `slideIndex`, one candidate's threads
 * and its cursor; without, every candidate's threads merged — each thread already reports the
 * slide it is on, because the file it is on *is* the slide.
 */
export async function readCandidateFeedback(
  options: Readonly<{
    env: CandidateFeedbackEnvironment;
    proposalId: string;
    slideIndex: number | null;
    since: string | null;
    includeResolved: boolean;
  }>,
): Promise<ReadCandidateFeedbackOutcome> {
  const { env, proposalId, slideIndex, since, includeResolved } = options;
  const targets = await candidateTargets({ env: env.proposal, proposalId, slideIndex });
  switch (targets.kind) {
    case "failed":
      return { kind: "failed", failure: targets.failure };
    case "ok":
      break;
    default:
      return assertNever(targets);
  }

  const threads: ReadFeedbackOutcome["threads"][number][] = [];
  let numbering: ReadFeedbackOutcome["slideNumbering"] = { kind: "candidate", proposalId, slideIndex };
  let cursor: FeedbackCursor | null = null;
  for (const target of targets.targets) {
    try {
      const read = await readFeedback({ env: env.feedback, target, since, includeResolved });
      threads.push(...read.threads);
      numbering = read.slideNumbering;
      cursor = read.cursor;
    } catch (cause) {
      // A read that returned no threads would look exactly like "the user said nothing",
      // which is the one thing this must never say when it does not know.
      return {
        kind: "failed",
        failure: { kind: "drive-failed", reason: cause instanceof Error ? cause.message : String(cause) },
      };
    }
  }
  // Counts are taken over EVERY candidate even when one was asked about, because the grid
  // needs all of them and a second tool call to fetch them would be a second round trip.
  const everyTarget = await candidateTargets({ env: env.proposal, proposalId, slideIndex: null });
  const unresolved = await unresolvedFor({ env: env.feedback, targets: everyTarget });
  const delivery = await logDeliveryEvent({
    env,
    proposalId,
    folderId: targets.folderId,
    tool: "read_feedback",
    commentIds: threads.map((thread) => thread.commentId),
  });

  return {
    kind: "ok",
    proposalId,
    slideIndex,
    delivery,
    outcome: {
      threads,
      // One candidate: its own cursor. Several: there is no single watermark across several
      // files, so the per-slide cursors in `unresolved` are the honest answer and this one is
      // seeded from the last read rather than invented.
      cursor: cursor ?? { modifiedTime: env.feedback.now().toISOString(), seenPostIds: [] },
      slideNumbering: numbering,
    },
    unresolved,
  };
}

export type CandidateReplyOutcome =
  | Readonly<{
      kind: "ok";
      slideIndex: number;
      outcome: ReplyFeedbackOutcome;
      /** False when the reply landed but its session-log event did not. Never hidden. */
      logged: boolean;
      logFailure: string | null;
    }>
  | Readonly<{ kind: "failed"; failure: CandidateAddressFailure }>;

/** Sasha answers inside the user's own thread, and the log gains `comment-answered`. */
export async function replyToCandidateComment(
  options: Readonly<{
    env: CandidateFeedbackEnvironment;
    proposalId: string;
    slideIndex: number;
    commentId: string;
    text: string;
  }>,
): Promise<CandidateReplyOutcome> {
  const { env, proposalId, slideIndex, commentId, text } = options;
  const located = await oneCandidate({ env: env.proposal, proposalId, slideIndex });
  switch (located.kind) {
    case "failed":
      return { kind: "failed", failure: located.failure };
    case "ok":
      break;
    default:
      return assertNever(located);
  }

  const outcome = await replyFeedback({ env: env.feedback, target: located.target, commentId, text });
  const logged = await logReplyEvent({
    env,
    proposalId,
    folderId: located.folderId,
    slideIndex,
    commentId,
    text,
    outcome,
    kind: "comment-answered",
  });
  return { kind: "ok", slideIndex, outcome, logged: logged.logged, logFailure: logged.reason };
}

/** Closes the thread Drive's own way (a reply with a resolve action) and logs it. */
export async function resolveCandidateComment(
  options: Readonly<{
    env: CandidateFeedbackEnvironment;
    proposalId: string;
    slideIndex: number;
    commentId: string;
    text: string | null;
  }>,
): Promise<CandidateReplyOutcome> {
  const { env, proposalId, slideIndex, commentId, text } = options;
  const located = await oneCandidate({ env: env.proposal, proposalId, slideIndex });
  switch (located.kind) {
    case "failed":
      return { kind: "failed", failure: located.failure };
    case "ok":
      break;
    default:
      return assertNever(located);
  }

  const outcome = await resolveFeedback({ env: env.feedback, target: located.target, commentId, text });
  const logged = await logReplyEvent({
    env,
    proposalId,
    folderId: located.folderId,
    slideIndex,
    commentId,
    text: text ?? "",
    outcome,
    kind: "comment-resolved",
  });
  return { kind: "ok", slideIndex, outcome, logged: logged.logged, logFailure: logged.reason };
}

export type AwaitCandidateFeedbackOutcome =
  | Readonly<{
      kind: "ok";
      slideIndex: number;
      outcome: AwaitFeedbackOutcome;
      /** What the log now says about this hand-over. A timeout delivered nothing and receipts none. */
      delivery: DeliveryReceipt;
    }>
  | Readonly<{ kind: "failed"; failure: CandidateAddressFailure }>;

/**
 * Long-polls one candidate for the user's next comment or reply. One candidate, not the whole
 * proposal: a cursor is a watermark into one file's threads, so "wait on four files" would
 * need four cursors and could not report a single resumable position.
 */
export async function awaitCandidateFeedback(
  options: Readonly<{
    env: CandidateFeedbackEnvironment;
    proposalId: string;
    slideIndex: number;
    since: FeedbackCursor | null;
    timeoutMs: number;
    /** Passed straight to `awaitFeedback`, so the caller can keep its client's timer alive. */
    onPoll?: (progress: Readonly<{ polls: number; elapsedMs: number }>) => void;
  }>,
): Promise<AwaitCandidateFeedbackOutcome> {
  const { env, proposalId, slideIndex, since, timeoutMs, onPoll } = options;
  const located = await oneCandidate({ env: env.proposal, proposalId, slideIndex });
  switch (located.kind) {
    case "failed":
      return { kind: "failed", failure: located.failure };
    case "ok":
      break;
    default:
      return assertNever(located);
  }
  const outcome = await awaitFeedback({
    env: env.feedback,
    target: located.target,
    since,
    timeoutMs,
    ...(onPoll === undefined ? {} : { onPoll }),
  });
  return {
    kind: "ok",
    slideIndex,
    outcome,
    delivery: await logDeliveryEvent({
      env,
      proposalId,
      folderId: located.folderId,
      tool: "await_feedback",
      commentIds: deliveredCommentIds(outcome),
    }),
  };
}

/**
 * The comment ids a wait handed over. An exhaustive switch, so a third `AwaitFeedbackOutcome` arm
 * has to say whether it delivered anything rather than silently receipting nothing -- or, worse,
 * receipting a timeout as contact.
 */
function deliveredCommentIds(outcome: AwaitFeedbackOutcome): readonly string[] {
  switch (outcome.kind) {
    case "arrived":
      return dedupe(outcome.posts.map((post) => post.commentId));
    case "timeout":
      return [];
    default:
      return assertNever(outcome);
  }
}

/** What a caller is told when the address could not be resolved. Always a value. */
export function describeCandidateAddressFailure(failure: CandidateAddressFailure): string {
  switch (failure.kind) {
    case "unknown-proposal":
      return `no proposal ${failure.proposalId} (it may have been cleaned up)`;
    case "unknown-slide":
      return (
        `proposal ${failure.proposalId} has no candidate ${String(failure.slideIndex)}; ` +
        `it holds ${failure.available.length === 0 ? "none" : failure.available.join(", ")}`
      );
    case "drive-failed":
      return `Drive could not be reached: ${failure.reason}`;
    default:
      return assertNever(failure);
  }
}

/**
 * APPENDS THE RECEIPT FOR A HAND-OVER THAT ACTUALLY HAPPENED, and nothing at all for one that did
 * not. "No comments came back" and "a comment came back" are the two cases, and conflating them is
 * the exact failure this whole mechanism exists to stop: a receipt written for an empty read would
 * tell the add-on something is listening every time an idle agent polls, which is a worse lie than
 * the spinner it replaces.
 *
 * `folderId` is passed in by callers that are already holding it, so a receipt is one Drive
 * create and no extra listing.
 */
async function logDeliveryEvent(
  options: Readonly<{
    env: CandidateFeedbackEnvironment;
    proposalId: string;
    folderId: string;
    tool: FeedbackDeliveryTool;
    commentIds: readonly string[];
  }>,
): Promise<DeliveryReceipt> {
  const { env, proposalId, folderId, tool, commentIds } = options;
  if (commentIds.length === 0) return { kind: "nothing-delivered" };
  const at = env.proposal.now().toISOString();
  const appended = await appendProposalEvent({
    env: env.proposal,
    proposalId,
    folderId,
    event: {
      kind: "feedback-delivered",
      protocolVersion: SESSION_LOG_PROTOCOL_VERSION,
      at,
      tool,
      commentIds,
    },
  });
  switch (appended.kind) {
    case "ok":
      return { kind: "logged", at, commentIds };
    case "drive-failed":
      return { kind: "log-failed", reason: appended.reason, commentIds };
    default:
      return assertNever(appended);
  }
}

/** First occurrence wins, so a receipt names each comment once in the order it was handed over. */
function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/** Null counts rather than no counts when the second listing failed: never a silent zero. */
async function unresolvedFor(
  options: Readonly<{ env: FeedbackEnvironment; targets: CandidateTargets }>,
): Promise<readonly UnresolvedSlideCount[]> {
  const { env, targets } = options;
  switch (targets.kind) {
    case "ok":
      return await countUnresolvedThreads({ env, targets: targets.targets });
    case "failed":
      return [];
    default:
      return assertNever(targets);
  }
}

type CandidateTargets =
  | Readonly<{
      kind: "ok";
      targets: readonly CandidateTarget[];
      candidates: readonly CandidateFile[];
      /** The proposal folder, so the receipt costs no second listing. */
      folderId: string;
    }>
  | Readonly<{ kind: "failed"; failure: CandidateAddressFailure }>;

async function candidateTargets(
  options: Readonly<{ env: ProposalEnvironment; proposalId: string; slideIndex: number | null }>,
): Promise<CandidateTargets> {
  const { env, proposalId, slideIndex } = options;
  const listed = await listCandidates({ env, proposalId });
  switch (listed.kind) {
    case "unknown-proposal":
      return { kind: "failed", failure: { kind: "unknown-proposal", proposalId } };
    case "drive-failed":
      return { kind: "failed", failure: { kind: "drive-failed", reason: listed.reason } };
    case "ok":
      break;
    default:
      return assertNever(listed);
  }
  const wanted =
    slideIndex === null
      ? listed.candidates
      : listed.candidates.filter((candidate) => candidate.index === slideIndex);
  if (slideIndex !== null && wanted.length === 0) {
    return {
      kind: "failed",
      failure: {
        kind: "unknown-slide",
        proposalId,
        slideIndex,
        available: listed.candidates.map((candidate) => candidate.index),
      },
    };
  }
  return {
    kind: "ok",
    candidates: wanted,
    folderId: listed.folderId,
    targets: wanted.map((candidate) => ({
      kind: "candidate",
      proposalId,
      slideIndex: candidate.index,
      fileId: candidate.fileId,
    })),
  };
}

type OneCandidate =
  | Readonly<{ kind: "ok"; target: CandidateTarget; folderId: string }>
  | Readonly<{ kind: "failed"; failure: CandidateAddressFailure }>;

async function oneCandidate(
  options: Readonly<{ env: ProposalEnvironment; proposalId: string; slideIndex: number }>,
): Promise<OneCandidate> {
  const { env, proposalId, slideIndex } = options;
  const found = await findCandidate({ env, proposalId, slideIndex });
  switch (found.kind) {
    case "ok":
      return {
        kind: "ok",
        folderId: found.folderId,
        target: { kind: "candidate", proposalId, slideIndex, fileId: found.candidate.fileId },
      };
    case "unknown-proposal":
      return { kind: "failed", failure: { kind: "unknown-proposal", proposalId } };
    case "unknown-slide":
      return {
        kind: "failed",
        failure: { kind: "unknown-slide", proposalId, slideIndex, available: found.available },
      };
    case "drive-failed":
      return { kind: "failed", failure: { kind: "drive-failed", reason: found.reason } };
    default:
      return assertNever(found);
  }
}

/** Exhaustive, so a third reply-shaped event kind cannot silently log as a resolution. */
function replyEvent(
  options: Readonly<{
    kind: "comment-answered" | "comment-resolved";
    common: Readonly<{
      protocolVersion: number;
      at: string;
      slideIndex: number;
      commentId: string;
      replyId: string;
      text: string;
    }>;
  }>,
): SessionEvent {
  switch (options.kind) {
    case "comment-answered":
      return { kind: "comment-answered", ...options.common };
    case "comment-resolved":
      return { kind: "comment-resolved", ...options.common };
    default:
      return assertNever(options.kind);
  }
}

type LogAttempt = Readonly<{ logged: boolean; reason: string | null }>;

/**
 * Appends the event for a reply that actually posted. A reply that did not post gets no
 * event at all — the log records what happened, not what was attempted.
 */
async function logReplyEvent(
  options: Readonly<{
    env: CandidateFeedbackEnvironment;
    proposalId: string;
    folderId: string;
    slideIndex: number;
    commentId: string;
    text: string;
    outcome: ReplyFeedbackOutcome;
    kind: "comment-answered" | "comment-resolved";
  }>,
): Promise<LogAttempt> {
  const { env, proposalId, folderId, slideIndex, commentId, text, outcome, kind } = options;
  switch (outcome.kind) {
    case "unknown-comment":
    case "invalid-input":
      return { logged: false, reason: null };
    case "ok":
      break;
    default:
      return assertNever(outcome);
  }
  const at = env.proposal.now().toISOString();
  const common = {
    protocolVersion: SESSION_LOG_PROTOCOL_VERSION,
    at,
    slideIndex,
    commentId,
    replyId: outcome.replyId,
    text,
  } as const;
  const appended = await appendProposalEvent({
    env: env.proposal,
    proposalId,
    folderId,
    event: replyEvent({ kind, common }),
  });
  switch (appended.kind) {
    case "ok":
      return { logged: true, reason: null };
    case "drive-failed":
      return { logged: false, reason: appended.reason };
    default:
      return assertNever(appended);
  }
}
