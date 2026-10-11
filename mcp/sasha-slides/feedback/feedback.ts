/**
 * The two-way feedback channel of PROTOCOL.md "Feedback over native Slides comments",
 * expressed against the injected `FeedbackChannel` so it can be exercised end to end with
 * no credentials (see `test/feedback.test.ts`).
 *
 * The user annotates a slide with a native Google Slides comment and presses send; the agent
 * reads the thread, acts, and replies **into the user's own thread** so the answer appears
 * where the question was asked. Google Slides' comment UI is the whole transport: nothing
 * here asks the user to adopt a tool they do not already have.
 *
 * Four properties of this file are load-bearing and easy to break:
 *
 *  - **A post is dated by when it was CREATED, never by Drive's `modifiedTime`.** A reply
 *    bumps its parent comment's `modifiedTime` (measured), so dating the head post by
 *    `modifiedTime` would make every thread look new again each time anyone replied —
 *    including when the agent itself replied. `postedAt` is therefore immutable, which is
 *    what makes "new since" decidable at all.
 *  - **The cursor is a watermark plus the ids sitting on it.** Drive's `startModifiedTime`
 *    is *inclusive* (measured), so a watermark alone re-reports the same post forever and
 *    `awaitFeedback` would return instantly on week-old feedback. `newPostsSince` is what
 *    makes the channel exactly-once, and it is pure so a test can prove it.
 *  - **The agent's own replies are tagged, because identity cannot tag them.** This server
 *    acts *as the user* (per-user OAuth), so Drive reports `author.me === true` for the
 *    user's comments **and** for the agent's replies alike. Without `AGENT_REPLY_MARKER`,
 *    `awaitFeedback` would wake on the agent's own last reply and the channel could never
 *    wait for an answer.
 *  - **Text is never rewritten.** `text` is what the author wrote, verbatim, including any
 *    `[slide:…]` marker. The slide is reported *alongside* it, never by editing it.
 *
 * **What the channel is pointed AT changed.** A comment now lands on `NN.html`, the candidate
 * the user is reviewing, not on the finished deck (PROTOCOL.md "Comments live on the
 * CANDIDATE, not the deck"): marking up a slide that is already in the deck is a bug report,
 * marking up a candidate is art direction and is the only one Sasha can act on. `FeedbackTarget`
 * is therefore a union — a candidate addressed by `(proposalId, slideIndex)`, or a presentation
 * — and the slide a comment is about is *known* for a candidate (it is which file the comment is
 * on) while a deck still needs the whole measured anchor machinery to guess it.
 */
import {
  FEEDBACK_SENTINEL,
  parseCommentAnchor,
  parseFeedbackSentinel,
  resolveSlideLocation,
  type CommentAnchor,
  type FeedbackSentinel,
  type SlideLocation,
} from "./comment-anchor";
import type { CommentThread, FeedbackChannel, ReplyAction } from "./feedback-channel";
import { assertNever } from "../google-auth";
import { AGENT_REPLY_MARKER, authoredByAgentText, withoutAgentMarker } from "../agent-marker.ts";

/**
 * Everything this module touches that is not pure. Required, not defaulted: a unit that can
 * silently fall back to the production clock has a path no test exercises.
 */
export type FeedbackEnvironment = Readonly<{
  channel: FeedbackChannel;
  now: () => Date;
  sleep: (options: Readonly<{ milliseconds: number }>) => Promise<void>;
  warn: (message: string) => void;
}>;

/**
 * Appended to every reply this server writes.
 *
 * It is not decoration: it is the only way to tell the agent's posts from the user's, since
 * both authenticate as the same Google account. Re-exported from `agent-marker.ts` because
 * the ADD-ON needs it too -- to strip it before showing the user Sasha's words -- and the
 * add-on cannot import this file, which pulls in `googleapis`.
 */
export { AGENT_REPLY_MARKER } from "../agent-marker.ts";

/**
 * What a comment thread is attached to.
 *
 * `candidate` is the one this product runs on: the Drive file behind `NN.html`, addressed by
 * `(proposalId, slideIndex)` so the slide is never in doubt. `presentation` is the deck, kept
 * because that is where Google's own anchors come from and `e2e/feedback-live.ts` proves the
 * anchor contract against them — not because a tool addresses it.
 */
export type FeedbackTarget = CandidateTarget | Readonly<{ kind: "presentation"; presentationId: string }>;

/** `NN.html` in a proposal folder: the slide index is the file's own, so it is never a guess. */
export type CandidateTarget = Readonly<{
  kind: "candidate";
  proposalId: string;
  slideIndex: number;
  fileId: string;
}>;

/** The Drive file id the comments live on. A Slides file id IS a Drive file id. */
export function feedbackTargetFileId(target: FeedbackTarget): string {
  switch (target.kind) {
    case "candidate":
      return target.fileId;
    case "presentation":
      return target.presentationId;
    default:
      return assertNever(target);
  }
}

/** For a note and an error message: what the caller asked about, in words. */
export function describeFeedbackTarget(target: FeedbackTarget): string {
  switch (target.kind) {
    case "candidate":
      return `candidate ${String(target.slideIndex)} of ${target.proposalId} (file ${target.fileId})`;
    case "presentation":
      return `presentation ${target.presentationId}`;
    default:
      return assertNever(target);
  }
}

/** One comment thread as the agent sees it: the question, its location, and the answers. */
export type FeedbackThread = Readonly<{
  commentId: string;
  author: string;
  authorEmail: string | null;
  /** Verbatim, as the author wrote it. */
  text: string;
  createdTime: string;
  modifiedTime: string;
  resolved: boolean;
  /** Exactly what Drive stores, so a caller can see it even when we cannot interpret it. */
  anchorRaw: string | null;
  anchor: CommentAnchor;
  slide: SlideLocation;
  quotedText: string | null;
  /**
   * The add-on sidebar's structured note, when this comment came from it: the box the user
   * dragged over what is wrong, in the protocol's fractional (0-1) convention. Null for a
   * comment the user typed in the Slides comment pane.
   */
  sentinel: FeedbackSentinel | null;
  replies: readonly FeedbackReply[];
}>;

export type FeedbackReply = Readonly<{
  replyId: string;
  author: string;
  text: string;
  createdTime: string;
  /** `resolve` / `reopen` replies are thread-state changes, not new feedback. */
  action: ReplyAction;
  authoredByAgent: boolean;
}>;

export type ReadFeedbackOutcome = Readonly<{
  threads: readonly FeedbackThread[];
  /** Pass to the next `awaitFeedback` to see only what happened after this read. */
  cursor: FeedbackCursor;
  /** Why a thread may carry a page object id but no 1-based slide number. */
  slideNumbering: SlideNumbering;
}>;

export type SlideNumbering =
  | Readonly<{ kind: "ok"; slideCount: number }>
  | Readonly<{ kind: "unavailable"; reason: string }>
  /**
   * A candidate needs no numbering: the comment is on `NN.html`, so the slide it is about is
   * that file's own index. This is a distinct variant rather than `ok` with a count of 1 so
   * no caller can report "this deck has one slide". `slideIndex` is null when the whole
   * proposal was read, rather than a made-up 0.
   */
  | Readonly<{ kind: "candidate"; proposalId: string; slideIndex: number | null }>;

/**
 * Every open thread, newest first, with its replies. `since` is passed straight to Drive's
 * inclusive `startModifiedTime`, so a thread exactly at that instant is included — a read is
 * meant to be complete, and it is `awaitFeedback` that must not repeat itself.
 */
export async function readFeedback(
  options: Readonly<{
    env: FeedbackEnvironment;
    target: FeedbackTarget;
    since: string | null;
    includeResolved: boolean;
  }>,
): Promise<ReadFeedbackOutcome> {
  const { env, target, since, includeResolved } = options;
  const comments = await env.channel.listComments({
    fileId: feedbackTargetFileId(target),
    startModifiedTime: since,
  });
  const pages = await readSlidePages({ env, target });

  const threads = comments
    .filter((comment) => includeResolved || !comment.resolved)
    .map((comment) => toFeedbackThread({ comment, target, pageObjectIds: pages.pageObjectIds }));

  return {
    threads,
    // Built from every comment returned, not just the ones that survived the resolved
    // filter: a cursor that ignored resolved threads would re-report them forever.
    cursor: feedbackCursorFrom({ comments, now: env.now() }),
    slideNumbering: pages.numbering,
  };
}

/**
 * The unresolved thread count for one candidate.
 *
 * `unresolved` is `null`, never `0`, when the count could not be read. UI-CONTRACT.md is
 * explicit: both surfaces read the same state and "if one cannot reach it, it says so rather
 * than showing zero" — a zero badge on a slide the user has complained about is worse than no
 * badge at all.
 */
export type UnresolvedSlideCount = Readonly<{
  slideIndex: number;
  unresolved: number | null;
  unavailableReason: string | null;
  /** Where a reader should resume from, for `awaitFeedback` on this candidate. */
  cursor: FeedbackCursor | null;
}>;

/**
 * Open-thread counts per candidate: one `comments.list` per candidate file, which is what
 * "unresolved count for slide N is a query over that file's open threads" means literally.
 *
 * A failure on one candidate costs that candidate's count and nothing else — the rest of the
 * grid still gets its badges.
 */
export async function countUnresolvedThreads(
  options: Readonly<{ env: FeedbackEnvironment; targets: readonly CandidateTarget[] }>,
): Promise<readonly UnresolvedSlideCount[]> {
  const { env, targets } = options;
  const counts: UnresolvedSlideCount[] = [];
  for (const target of targets) {
    const { slideIndex } = target;
    try {
      const comments = await env.channel.listComments({
        fileId: target.fileId,
        startModifiedTime: null,
      });
      counts.push({
        slideIndex,
        unresolved: comments.filter((comment) => !comment.resolved).length,
        unavailableReason: null,
        cursor: feedbackCursorFrom({ comments, now: env.now() }),
      });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      env.warn(`unresolved count unavailable for ${describeFeedbackTarget(target)}: ${reason}`);
      counts.push({ slideIndex, unresolved: null, unavailableReason: reason, cursor: null });
    }
  }
  return counts;
}

export type ReplyFeedbackOutcome =
  | Readonly<{ kind: "ok"; replyId: string; createdTime: string; resolved: boolean }>
  | Readonly<{ kind: "unknown-comment" }>
  | Readonly<{ kind: "invalid-input"; reason: string }>;

/**
 * Posts the agent's answer as a reply inside the user's own thread. The thread is read first
 * so an id that names nothing is a value rather than a Google 404 surfacing as a crash.
 */
export async function replyFeedback(
  options: Readonly<{ env: FeedbackEnvironment; target: FeedbackTarget; commentId: string; text: string }>,
): Promise<ReplyFeedbackOutcome> {
  return await postReply({ ...options, resolve: false });
}

/**
 * Marks the thread resolved — which Drive does through a reply carrying `action:"resolve"`,
 * never through `comments.update({resolved:true})` (that is rejected outright: `resolved` is
 * output-only). Because the reply *is* the mechanism it must carry text, so a caller that
 * supplies none gets `DEFAULT_RESOLVE_NOTE` rather than a Google error.
 */
export async function resolveFeedback(
  options: Readonly<{
    env: FeedbackEnvironment;
    target: FeedbackTarget;
    commentId: string;
    text: string | null;
  }>,
): Promise<ReplyFeedbackOutcome> {
  const { env, target, commentId, text } = options;
  return await postReply({
    env,
    target,
    commentId,
    text: text === null || text.trim() === "" ? DEFAULT_RESOLVE_NOTE : text,
    resolve: true,
  });
}

export const DEFAULT_RESOLVE_NOTE = "Handled by the agent.";

export type AwaitFeedbackOutcome =
  | Readonly<{ kind: "arrived"; posts: readonly FeedbackPost[]; cursor: FeedbackCursor; polls: number }>
  | Readonly<{ kind: "timeout"; waitedMs: number; polls: number; cursor: FeedbackCursor }>;

/** A single new thing the user did: a new comment, or a new reply under an existing one. */
export type FeedbackPost = Readonly<{
  kind: FeedbackPostKind;
  /** The comment id for a `comment`, the reply id for a `reply`. */
  postId: string;
  /** Always the thread's comment id — what `reply_feedback` / `resolve_feedback` take. */
  commentId: string;
  author: string;
  text: string;
  /** When the post was created. Immutable, unlike Drive's `modifiedTime`. */
  postedAt: string;
  action: ReplyAction;
  slide: SlideLocation;
}>;

export type FeedbackPostKind = "comment" | "reply";

/**
 * Long-polls for the user, exactly as `awaitPick` long-polls for a pick: one narrow query
 * per poll, exponential backoff, the last sleep clipped to the deadline, and a timeout
 * returned as a value rather than thrown.
 *
 * `since === null` starts the cursor at *now*, so a first call waits for genuinely new
 * activity instead of firing on history. Posts the agent itself wrote advance the cursor but
 * never end the wait — otherwise `reply_feedback` followed by `await_feedback` would return
 * the agent's own words.
 */
export async function awaitFeedback(
  options: Readonly<{
    env: FeedbackEnvironment;
    target: FeedbackTarget;
    since: FeedbackCursor | null;
    timeoutMs: number;
    /**
     * Called once per poll, so the caller can keep the client's request timer alive.
     *
     * Not optional decoration: a real Model Context Protocol client kills a request after its
     * own default (60 s was measured) unless a progress notification resets the timer. Without
     * this, every wait longer than that default failed with `-32001 Request timed out`, which
     * made the long poll useless for exactly the waits it exists to serve.
     */
    onPoll?: (progress: Readonly<{ polls: number; elapsedMs: number }>) => void;
  }>,
): Promise<AwaitFeedbackOutcome> {
  const { env, target, timeoutMs, onPoll } = options;
  const fileId = feedbackTargetFileId(target);
  const startedAtMs = env.now().getTime();
  const deadlineMs = startedAtMs + timeoutMs;

  // "From now" has to mean "nothing that already exists", not "nothing older than this
  // instant": a comment filed in the same millisecond as the cursor would otherwise fire,
  // and Drive's filter is inclusive. So an absent cursor is seeded from the deck's current
  // posts rather than from the clock.
  let cursor: FeedbackCursor =
    options.since ??
    initialFeedbackCursor({
      comments: await env.channel.listComments({ fileId, startModifiedTime: null }),
      now: env.now(),
    });
  let delayMs = FIRST_POLL_DELAY_MS;
  let polls = 0;
  for (;;) {
    polls += 1;
    const comments = await env.channel.listComments({
      fileId,
      startModifiedTime: cursor.modifiedTime,
    });
    // Reported BEFORE any early return, so a poll that finds something still counts as one.
    onPoll?.({ polls, elapsedMs: env.now().getTime() - startedAtMs });
    const fresh = newPostsSince({ comments, cursor });
    const fromUser = fresh.filter((post) => !post.authoredByAgent);
    if (fromUser.length > 0) {
      // Only now is the deck read: a poll that finds nothing should cost one request.
      const pages = await readSlidePages({ env, target });
      return {
        kind: "arrived",
        posts: fromUser.map((post) => withSlide({ post, target, comments, pageObjectIds: pages.pageObjectIds })),
        cursor: feedbackCursorFrom({ comments, now: env.now() }),
        polls,
      };
    }
    // The agent's own posts are not an answer, but leaving them behind the cursor would make
    // every later poll re-examine them.
    if (fresh.length > 0) cursor = feedbackCursorFrom({ comments, now: env.now() });

    const remainingMs = deadlineMs - env.now().getTime();
    if (remainingMs <= 0) {
      return { kind: "timeout", waitedMs: env.now().getTime() - startedAtMs, polls, cursor };
    }
    // The last sleep is clipped to the deadline, so the budget is spent polling rather than
    // on a final oversized wait that would overshoot it.
    await env.sleep({ milliseconds: Math.min(delayMs, remainingMs) });
    delayMs = Math.min(MAX_POLL_DELAY_MS, Math.round(delayMs * POLL_BACKOFF_FACTOR));
  }
}

/**
 * Where a reader got to.
 *
 * `modifiedTime` alone is **not** a cursor: Drive's `startModifiedTime` filter is inclusive,
 * so the posts sitting exactly at the watermark come back on every query. `seenPostIds`
 * names those, and is the only reason this channel does not repeat itself. It stays small
 * because it holds the posts *at* the watermark, never the whole history.
 *
 * Using it as `startModifiedTime` is sound because a thread's `modifiedTime` is never older
 * than the newest post in it, so no thread holding new posts can be filtered out.
 */
export type FeedbackCursor = Readonly<{
  modifiedTime: string;
  seenPostIds: readonly string[];
}>;

/**
 * Pure: a cursor that suppresses **every** post currently present, for "wait for what
 * happens from now on".
 *
 * It differs from `feedbackCursorFrom` on purpose. That one names only the posts sitting on
 * the watermark, which is enough once the caller has actually read everything older. A
 * caller starting fresh has read nothing, so suppressing by timestamp alone would fire on a
 * comment that happens to share the current millisecond.
 */
export function initialFeedbackCursor(
  options: Readonly<{ comments: readonly CommentThread[]; now: Date }>,
): FeedbackCursor {
  const posts = allPosts(options.comments);
  return {
    modifiedTime: newestPostedAt(posts) ?? options.now.toISOString(),
    seenPostIds: posts.map((post) => post.postId),
  };
}

/** Pure: the watermark is the newest post seen, and the ids are the posts sitting on it. */
export function feedbackCursorFrom(
  options: Readonly<{ comments: readonly CommentThread[]; now: Date }>,
): FeedbackCursor {
  const posts = allPosts(options.comments);
  const watermark = newestPostedAt(posts);
  if (watermark === null) {
    // Nothing to anchor to: start from the clock so the next poll waits for new activity
    // rather than replaying an empty deck's history.
    return { modifiedTime: options.now.toISOString(), seenPostIds: [] };
  }
  return {
    modifiedTime: watermark,
    seenPostIds: posts.filter((post) => post.postedAt === watermark).map((post) => post.postId),
  };
}

/**
 * Pure: the posts that are genuinely new relative to `cursor`. Both halves matter — the
 * timestamp drops history the caller has already walked past, and `seenPostIds` drops the
 * posts the inclusive Drive filter keeps handing back at the watermark itself.
 */
export function newPostsSince(
  options: Readonly<{ comments: readonly CommentThread[]; cursor: FeedbackCursor }>,
): readonly RawPost[] {
  const { comments, cursor } = options;
  const seen = new Set(cursor.seenPostIds);
  const cursorMs = Date.parse(cursor.modifiedTime);
  return allPosts(comments).filter(
    (post) => !seen.has(post.postId) && isAtOrAfter({ timeMs: Date.parse(post.postedAt), cursorMs }),
  );
}

/** A post before slide resolution: what the cursor logic works on. */
export type RawPost = Readonly<{
  kind: FeedbackPostKind;
  postId: string;
  commentId: string;
  author: string;
  text: string;
  postedAt: string;
  action: ReplyAction;
  authoredByAgent: boolean;
}>;

/**
 * A POST AS PROSE: everything the two halves write to each other taken back out.
 *
 * Two machine artefacts ride in a comment's body -- the add-on's `sasha-slides-feedback=`
 * line (PROTOCOL.md) and this server's own `[sasha-slides-agent]` marker. Both are already
 * parsed into fields of their own (`region`/`noteId` via `parseFeedbackSentinel`,
 * `authoredByAgent` via the marker), so passing them on in the text only gives the model
 * something to quote: measured against the deployed add-on on 2026-10-04, a real session
 * read back "Second round: … sasha-slides-feedback={…}" and echoed the JSON to the user.
 */
export function readableFeedbackText(text: string): string {
  const kept = text
    .split("\n")
    .filter((line) => !line.trim().startsWith(FEEDBACK_SENTINEL))
    .join("\n");
  return withoutAgentMarker(kept).trim();
}

/** True when this server wrote the text, identified by the marker it appends. */
export function authoredByAgent(options: Readonly<{ text: string }>): boolean {
  return authoredByAgentText(options.text);
}

/** The exact body this server posts: the agent's words plus the marker that identifies them. */
export function agentReplyBody(options: Readonly<{ text: string }>): string {
  const text = options.text.trimEnd();
  return authoredByAgent({ text }) ? text : `${text}\n\n${AGENT_REPLY_MARKER}`;
}

/**
 * A `SlideLocation` flattened to the fields a wire payload needs.
 *
 * It exists so no caller writes `slide.kind === "slide" ? … : …`. A bare comparison has no
 * `never` position, so adding a `SlideLocation` variant would silently take the else branch
 * at every one of those sites; routing through this switch makes it a compile error instead.
 */
export type SlidePlacement = Readonly<{
  slideNumber: number | null;
  pageObjectId: string | null;
  elementObjectIds: readonly string[];
  description: string;
  /** False when the comment could not be put on a slide at all. */
  located: boolean;
}>;

export function slidePlacement(slide: SlideLocation): SlidePlacement {
  switch (slide.kind) {
    case "slide":
      return {
        slideNumber: slide.slideNumber,
        pageObjectId: slide.pageObjectId,
        elementObjectIds: slide.elementObjectIds,
        description: describeSlideLocation(slide),
        located: true,
      };
    case "unknown":
      return {
        slideNumber: null,
        pageObjectId: null,
        elementObjectIds: [],
        description: describeSlideLocation(slide),
        located: false,
      };
    default:
      return assertNever(slide);
  }
}

/** Exhaustive so a new `SlideLocation` variant cannot be silently rendered as "unknown". */
export function describeSlideLocation(slide: SlideLocation): string {
  switch (slide.kind) {
    case "slide": {
      const position = slide.slideNumber === null ? "unknown position" : `slide ${String(slide.slideNumber)}`;
      return `${position} (page ${slide.pageObjectId ?? "unknown"}, via ${slide.via})`;
    }
    case "unknown":
      return `slide unknown: ${slide.reason}`;
    default:
      return assertNever(slide);
  }
}

const FIRST_POLL_DELAY_MS = 1_000;
const MAX_POLL_DELAY_MS = 10_000;
const POLL_BACKOFF_FACTOR = 1.6;

async function postReply(
  options: Readonly<{
    env: FeedbackEnvironment;
    target: FeedbackTarget;
    commentId: string;
    text: string;
    resolve: boolean;
  }>,
): Promise<ReplyFeedbackOutcome> {
  const { env, target, commentId, text, resolve } = options;
  if (text.trim() === "") {
    // Drive's own words for this: a reply with no content is rejected outright.
    return { kind: "invalid-input", reason: "reply text is empty; Drive requires comment content" };
  }
  const fileId = feedbackTargetFileId(target);
  const thread = await env.channel.getComment({ fileId, commentId });
  if (thread === null) return { kind: "unknown-comment" };

  const reply = await env.channel.createReply({
    fileId,
    commentId,
    text: agentReplyBody({ text }),
    resolve,
  });
  // Read the thread back rather than trusting the write: `resolved` is output-only, so the
  // only honest way to report it is to ask.
  const after = await env.channel.getComment({ fileId, commentId });
  if (after === null) {
    env.warn(`replied to ${commentId} but the thread could not be read back to confirm its state`);
    return { kind: "ok", replyId: reply.id, createdTime: reply.createdTime, resolved: resolve };
  }
  return { kind: "ok", replyId: reply.id, createdTime: reply.createdTime, resolved: after.resolved };
}

/**
 * The deck's page order, plus the reason a caller may not get slide numbers.
 *
 * A candidate target does not read a deck at all — there is nothing to number and nothing to
 * fail, which is also one fewer Slides API call on the path the product actually uses.
 */
async function readSlidePages(
  options: Readonly<{ env: FeedbackEnvironment; target: FeedbackTarget }>,
): Promise<Readonly<{ pageObjectIds: readonly string[] | null; numbering: SlideNumbering }>> {
  const { env, target } = options;
  switch (target.kind) {
    case "candidate":
      return {
        pageObjectIds: null,
        numbering: { kind: "candidate", proposalId: target.proposalId, slideIndex: target.slideIndex },
      };
    case "presentation":
      break;
    default:
      return assertNever(target);
  }
  const pages = await env.channel.listSlidePages({ presentationId: target.presentationId });
  switch (pages.kind) {
    case "ok":
      return {
        pageObjectIds: pages.pageObjectIds,
        numbering: { kind: "ok", slideCount: pages.pageObjectIds.length },
      };
    case "unavailable":
      env.warn(`slide numbering unavailable for ${target.presentationId}: ${pages.reason}`);
      return { pageObjectIds: null, numbering: { kind: "unavailable", reason: pages.reason } };
    default:
      return assertNever(pages);
  }
}

/**
 * Which slide a comment is about.
 *
 * For a candidate it is not inferred at all: the comment is on `NN.html`, so the file IS the
 * answer and no anchor, sentinel or marker can contradict it. For a deck it is the measured
 * resolution order of `comment-anchor.ts`. Routed through a switch so adding a target kind is
 * a compile error here rather than a silent "unknown slide".
 */
function locateSlide(
  options: Readonly<{
    target: FeedbackTarget;
    anchor: CommentAnchor;
    text: string;
    pageObjectIds: readonly string[] | null;
  }>,
): SlideLocation {
  const { target, anchor, text, pageObjectIds } = options;
  switch (target.kind) {
    case "candidate":
      return {
        kind: "slide",
        pageObjectId: null,
        slideNumber: target.slideIndex,
        elementObjectIds: [],
        via: "candidate-file",
      };
    case "presentation":
      return resolveSlideLocation({ anchor, text, pageObjectIds });
    default:
      return assertNever(target);
  }
}

function toFeedbackThread(
  options: Readonly<{
    comment: CommentThread;
    target: FeedbackTarget;
    pageObjectIds: readonly string[] | null;
  }>,
): FeedbackThread {
  const { comment, target, pageObjectIds } = options;
  const anchor = parseCommentAnchor(comment.anchor);
  return {
    commentId: comment.id,
    author: comment.author.displayName,
    authorEmail: comment.author.emailAddress,
    text: readableFeedbackText(comment.text),
    createdTime: comment.createdTime,
    modifiedTime: comment.modifiedTime,
    resolved: comment.resolved,
    anchorRaw: comment.anchor,
    anchor,
    slide: locateSlide({ target, anchor, text: comment.text, pageObjectIds }),
    quotedText: comment.quotedText,
    sentinel: parseFeedbackSentinel({ text: comment.text }),
    replies: comment.replies.map((reply) => ({
      replyId: reply.id,
      author: reply.author.displayName,
      text: readableFeedbackText(reply.text),
      createdTime: reply.createdTime,
      action: reply.action,
      authoredByAgent: authoredByAgent({ text: reply.text }),
    })),
  };
}

/** The slide a post belongs to is the slide its THREAD is anchored to, replies included. */
function withSlide(
  options: Readonly<{
    post: RawPost;
    target: FeedbackTarget;
    comments: readonly CommentThread[];
    pageObjectIds: readonly string[] | null;
  }>,
): FeedbackPost {
  const { post, target, comments, pageObjectIds } = options;
  const thread = comments.find((comment) => comment.id === post.commentId);
  const slide: SlideLocation =
    thread === undefined
      ? { kind: "unknown", reason: "the thread this post belongs to was not in the same listing" }
      : locateSlide({
          target,
          anchor: parseCommentAnchor(thread.anchor),
          // A reply inherits its thread's location, so a `[slide:…]` marker is read off the
          // thread's head text, not off the reply.
          text: thread.text,
          pageObjectIds,
        });
  return {
    kind: post.kind,
    postId: post.postId,
    commentId: post.commentId,
    author: post.author,
    text: post.text,
    postedAt: post.postedAt,
    action: post.action,
    slide,
  };
}

/**
 * Head post plus every reply, flattened, which is the unit a cursor counts.
 *
 * Every post is dated by its CREATION time. For the head post that is deliberately not
 * `comment.modifiedTime`: Drive bumps that whenever a reply lands, so using it would make a
 * month-old comment look brand new every time anybody answered it. The cost is that editing
 * an existing comment's text does not register as new activity — see PROTOCOL.md.
 */
function allPosts(comments: readonly CommentThread[]): readonly RawPost[] {
  const posts: RawPost[] = [];
  for (const comment of comments) {
    posts.push({
      kind: "comment",
      postId: comment.id,
      commentId: comment.id,
      author: comment.author.displayName,
      text: readableFeedbackText(comment.text),
      postedAt: comment.createdTime,
      action: "none",
      authoredByAgent: authoredByAgent({ text: comment.text }),
    });
    for (const reply of comment.replies) {
      posts.push({
        kind: "reply",
        postId: reply.id,
        commentId: comment.id,
        author: reply.author.displayName,
        text: readableFeedbackText(reply.text),
        postedAt: reply.createdTime,
        action: reply.action,
        authoredByAgent: authoredByAgent({ text: reply.text }),
      });
    }
  }
  return posts;
}

function newestPostedAt(posts: readonly RawPost[]): string | null {
  let newest: string | null = null;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const post of posts) {
    const atMs = Date.parse(post.postedAt);
    if (Number.isNaN(atMs) || atMs <= newestMs) continue;
    newestMs = atMs;
    newest = post.postedAt;
  }
  return newest;
}

/**
 * An unparseable timestamp counts as new. Reporting a post twice is recoverable; dropping
 * the user's feedback silently is not, so the ambiguous case fails towards the user.
 */
function isAtOrAfter(options: Readonly<{ timeMs: number; cursorMs: number }>): boolean {
  const { timeMs, cursorMs } = options;
  if (Number.isNaN(timeMs) || Number.isNaN(cursorMs)) return true;
  return timeMs >= cursorMs;
}
