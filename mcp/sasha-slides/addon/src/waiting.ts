// WHAT IS WAITING FOR SASHA, HOW LONG IT HAS BEEN, AND WHETHER ANYTHING IS LISTENING.
//
// UI-CONTRACT.md, "Waiting for Sasha must be honest": a live indicator with elapsed time, and --
// the part that matters -- a surface that DISTINGUISHES "waiting" from "nobody is listening".
//
// WHY THIS FILE EXISTS. The conversation rendered a static "no answer yet" under an unanswered
// message, which implies an answer is on its way. It is not: Sasha replies only while a Claude
// session has the sasha-slides connector attached and is polling for feedback, and with none
// attached a comment sits unanswered for ever. A real user then watched the FIRST attempt at a fix
// -- an honest disclaimer under a pulsing dot and a count-up -- for 1 h 47 minutes, with no session
// attached, no server running and zero replies. The words were true; the spinner above them was
// the lie, because a clock that counts up reads as progress.
//
// WHAT CAN BE KNOWN, EXACTLY, AND WHAT CANNOT.
//
//   CAN: how long something has been waiting. Every thread and every reply carries Drive's own
//        `createdAt`, so elapsed time is a subtraction against an injected clock.
//   CAN: whether a connected client has READ a given comment. PROTOCOL.md's `feedback-delivered`
//        receipt is appended by the server the moment `read_feedback` or `await_feedback` hands a
//        comment over, so a receipt naming a comment id is positive evidence that something was
//        there. This is new: these tools used to be pure reads that left nothing behind, which is
//        exactly why presence was unknowable before.
//   CAN: whether Sasha has ever ACTED, and when it last did -- every event whose voice is `sasha`
//        plus every reply under a thread. Stronger evidence than a receipt, and ranked above it.
//   CANNOT: whether an ANSWER is coming. Nothing proves that, ever. A receipt says a session read
//        the comment; it does not say it will reply, will not crash, or has not already moved on.
//
// SO THE CONTRACT HAS THREE STATES PER WAIT, not two (PROTOCOL.md, "`feedback-delivered`: proof
// that something is listening"):
//
//   delivered         a receipt names this comment -- something has it. No promise beyond that.
//   waiting           no receipt yet, under the shared threshold. The elapsed time, nothing more.
//   nobody listening  no receipt past the threshold. The SPINNER STOPS and an instruction naming
//                     the proposal is printed, because at that point the user has to act.
//
// The threshold is `FEEDBACK_DELIVERY_THRESHOLD_MS`, which is the server's own long-poll default --
// ONE constant read by both halves, not two fives that drift.

import {
  FEEDBACK_DELIVERY_THRESHOLD_MS,
  nothingListeningNotice,
  type NothingListeningNotice,
} from "../../feedback-delivery.ts";
import type { FeedbackReply, FeedbackThread } from "./feedback.ts";
import { assertNever, type Region } from "./protocol.ts";
import { describeRegion } from "./region-overlay.tsx";
import {
  loadedSlideComments,
  openThreadsOf,
  sessionEventVoiceOf,
  type SessionEvent,
  type SlideComments,
  type SlideCommentsLoad,
  type SlideThread,
} from "./session-log.ts";

/**
 * ONE THING THE USER IS WAITING ON. Both kinds are here because both are the same wait from the
 * user's side -- a message on the deck and a mark-up on a candidate are two transports for "I
 * said something to Sasha and nothing has come back".
 */
export type WaitingItem = Readonly<{
  waitId: string;
  what: WaitingWhat;
  text: string;
  /** Drive's own timestamp for the thread, as an ISO string. */
  since: string;
  /** Milliseconds since `since`, or null when the clock has not ticked or the stamp is unreadable. */
  elapsedMs: number | null;
  /** Which of the contract's three states this wait is in. The one thing the surface renders. */
  state: WaitState;
  /**
   * Replies already under it. A reply does NOT end the wait: the thread is still unresolved, which
   * is "answered, not resolved" -- the contract's completion signal is a RESOLVED comment with a
   * revised slide, not merely a reply.
   */
  replies: number;
  /**
   * THE LAST THING SASHA SAID UNDER THIS THREAD, or null. It is the closest thing to "Sasha's
   * thinking" the channel carries -- there is no progress or thinking transport in PROTOCOL.md, only
   * replies -- so it is rendered as what has come back so far rather than as a status.
   */
  latestReply: string | null;
}>;

/**
 * THE THREE STATES OF ONE WAIT, and the reason this is a union rather than a pair of booleans: the
 * surface has to render exactly one of them, and a `default: assertNever` makes a fourth state a
 * compile error at every decision site instead of a silent fall-through to "waiting".
 */
export type WaitState =
  /**
   * A `feedback-delivered` receipt names this comment. Something read it, `agoMs` ago. This proves
   * DELIVERY ONLY -- it is not an answer, and nothing here may suggest one is on its way.
   */
  | Readonly<{ kind: "delivered"; at: string; agoMs: number | null }>
  /** No receipt yet, and under the threshold. `forMs` is null when there is no clock to ask. */
  | Readonly<{ kind: "waiting"; forMs: number | null }>
  /**
   * No receipt, and past the threshold. The surface stops the spinner and prints an instruction;
   * see `nothingListeningOn`.
   */
  | Readonly<{ kind: "nobody-listening"; forMs: number }>;

export type WaitingWhat =
  /** Typed into the conversation: one native comment on the presentation itself. */
  | Readonly<{ kind: "message" }>
  /** Dragged on a candidate: a comment on that candidate's own `NN.html`, with the box it names. */
  | Readonly<{ kind: "comment"; slideIndex: number; region: Region | null }>;

/**
 * WHETHER ANYTHING HAS BEEN LISTENING, and the strongest evidence for it.
 *
 * There is STILL no `attached` arm, and that is not the same gap it used to be. What changed is
 * that `feedback-delivered` made DELIVERY knowable, so `delivered` is a real positive arm backed by
 * a receipt. What did not change is that nothing proves a session is attached *right now*, or that
 * an answer is coming -- a receipt is a past tense, like every other arm here.
 *
 * The arms are ordered by the strength of the evidence, and `sashaPresenceOf` picks the strongest:
 * an act says strictly more than a read.
 */
export type SashaPresence =
  /**
   * Sasha has acted in this session. `agoMs` is since the most recent thing it did; `heardAgoMs`
   * is since the newest evidence of ANY kind, act or receipt -- a receipt newer than the last act
   * still proves something was here more recently, and only that decides `presenceIsSilent`.
   */
  | Readonly<{ kind: "acted"; at: string; agoMs: number | null; heardAgoMs: number | null }>
  /**
   * A client READ the user's comments, `agoMs` ago, and has done nothing else. Evidence that
   * something was there; evidence of nothing further.
   */
  | Readonly<{ kind: "delivered"; at: string; agoMs: number | null }>
  /** Everything needed was read, and nothing in this session ever read or answered anything. */
  | Readonly<{ kind: "never-acted" }>
  /** A read that would have proved it has not come back, or failed. NEVER reported as "never". */
  | Readonly<{ kind: "unknown"; message: string }>;

/**
 * THE PRECONDITION, in one sentence, rendered wherever a wait is shown. It is a constant rather
 * than prose inlined per surface so the slides window and the conversation cannot drift into saying
 * two different things about the same fact.
 */
export const SASHA_PRECONDITION =
  "Sasha answers only while a Claude session has the sasha-slides connector attached and is " +
  "polling for feedback. This add-on can see when a session has read your comments, and shows you " +
  "when nothing has -- but a session reading something is not an answer, so it never promises an " +
  "answer is coming.";

/**
 * EVERYTHING WAITING, OLDEST FIRST -- the longest wait leads, because it is the one most likely to
 * be waiting on nobody.
 *
 * The deck's threads and the candidates' comments are read from the two sources the conversation
 * already polls, so this adds no fetch: `threads` is `feedbackThreadsOf` over the presentation's
 * comment pane and `comments` is the same `SlideCommentsLoad` every unresolved badge is derived
 * from (session-log.ts). One derivation, so the pinned list and the badges cannot disagree.
 */
export function waitingOn({
  threads,
  comments,
  deliveries,
  nowMs,
}: {
  threads: readonly FeedbackThread[];
  comments: SlideCommentsLoad;
  /** The receipts, from `deliveriesOf` over the session log. `noDeliveries()` when it is not in. */
  deliveries: Deliveries;
  nowMs: number | null;
}): readonly WaitingItem[] {
  const items: WaitingItem[] = [];
  for (const thread of threads) {
    if (!messageIsWaiting(thread)) continue;
    items.push({
      waitId: `msg_${thread.commentId}`,
      what: { kind: "message" },
      text: thread.note.text,
      since: thread.createdAt,
      elapsedMs: elapsedMsOf({ since: thread.createdAt, nowMs }),
      state: waitStateOf({ commentId: thread.commentId, since: thread.createdAt, deliveries, nowMs }),
      replies: thread.replies.length,
      latestReply: lastReplyTextOf(thread.replies),
    });
  }
  // THROUGH `openThreadsOf`, not a second loop over the same state: "which candidate threads are
  // open" has exactly one derivation (session-log.ts), shared with every unresolved badge, and a
  // copy of that filter here is the drift UI-CONTRACT.md warns about for the editor's types.
  for (const open of openThreadsOf({ comments })) {
    items.push(commentWait({ slideIndex: open.slideIndex, thread: open.thread, deliveries, nowMs }));
  }
  return [...items].sort((left, right) => (left.since < right.since ? -1 : left.since > right.since ? 1 : 0));
}

/**
 * EVERY COMMENT A CLIENT HAS BEEN HANDED, to the newest receipt that named it.
 *
 * A map rather than a set because the TIME matters: "something read this 20 s ago" and "something
 * read this 40 minutes ago" are different things to tell a user, and only the first is reassuring.
 * Keyed by Drive comment id, which is what a receipt carries and what both transports have.
 */
export function deliveriesOf({ events }: { events: readonly SessionEvent[] }): Deliveries {
  const newest = new Map<string, string>();
  for (const event of events) {
    if (event.body.kind !== "feedback-delivered") continue;
    // The event's own `at` is empty when neither the file name nor the body carried a usable stamp,
    // and an undated receipt cannot be shown as "read N ago" -- so it is not evidence here.
    if (event.at === "" || !Number.isFinite(Date.parse(event.at))) continue;
    for (const commentId of event.body.commentIds) {
      const already = newest.get(commentId);
      if (already === undefined || already < event.at) newest.set(commentId, event.at);
    }
  }
  return newest;
}

/** Comment id to the newest receipt naming it. */
export type Deliveries = ReadonlyMap<string, string>;

/** No receipts at all -- the honest starting value while the log has not been read. */
export function noDeliveries(): Deliveries {
  return EMPTY_DELIVERIES;
}

/**
 * WHAT TO PRINT WHEN NOTHING IS LISTENING, or null while something still might be.
 *
 * It fires as soon as ANY wait has crossed the threshold, not when all of them have: one comment
 * nobody read for five minutes is already the situation the user has to act on, and a newer comment
 * underneath it does not make the older one less stuck.
 *
 * The wording and the threshold both come from `feedback-delivery.ts`, so this function decides only
 * WHEN -- which is the half that needs the add-on's clock.
 */
export function nothingListeningOn({
  waiting,
  presence,
}: {
  waiting: readonly WaitingItem[];
  /**
   * Whether anything has EVER acted in this session. Optional so the older call sites that only
   * know about waits keep working; without it the notice is wait-driven exactly as before.
   */
  presence?: SashaPresence;
}): NothingListeningNotice | null {
  /*
   * HOW TO CONNECT IS NEEDED BEFORE ANYTHING IS STUCK.
   *
   * This used to fire only when a wait had crossed the delivery threshold -- five minutes --
   * AND only when something was waiting at all. So a user who had just opened the add-on with no
   * session attached saw no instructions whatsoever: nothing was waiting yet, so there was
   * nothing to be unheard, and the one place that says how to attach a Claude session never
   * rendered. They have to type a message, wait five minutes, and only then be told what to do.
   *
   * `never-acted` is the honest signal: every read that could prove a session was here has come
   * back, and none of them did. That is exactly "no bot is connected", and it is knowable
   * immediately. `unknown` deliberately does NOT trigger it -- a read that has not finished is
   * not evidence of absence, and claiming it would be the mistake this file exists to avoid.
   * Evidence older than the threshold counts as none (`presenceIsSilent`): without that, the
   * server's own `slides-staged` made `never-acted` unreachable once any candidate existed.
   */
  const stuck = waiting.some((item) => waitIsUnheard(item.state));
  if (stuck) return nothingListeningNotice();
  if (presence === undefined) return null;
  return presenceIsSilent(presence) ? nothingListeningNotice() : null;
}

/**
 * WHETHER PRESENCE SAYS NOTHING IS LISTENING NOW: no evidence ever, or only evidence older than
 * the delivery threshold.
 *
 * STALE EVIDENCE IS NO EVIDENCE (user report, 2026-10-11: "it disappears even when there is no bot
 * connected"). Every followed set's log opens with the server's own `slides-staged`, so once any
 * candidate exists presence is `acted` for ever -- however long ago the session that staged them
 * went away. `never-acted` was then unreachable in practice, and the notice hung on a single stuck
 * wait: whatever ended that wait without a listener (the user replying under their own message,
 * resolving their own comment) ended the notice too. A connected session reads a comment well
 * inside one threshold (feedback-delivery.ts), so evidence older than that proves only that
 * something WAS here. Without a clock nothing is accused, exactly as in `waitStateOf`.
 */
export function presenceIsSilent(presence: SashaPresence): boolean {
  switch (presence.kind) {
    case "never-acted":
      return true;
    case "unknown":
      return false;
    case "acted":
      return isStaleEvidence(presence.heardAgoMs);
    case "delivered":
      return isStaleEvidence(presence.agoMs);
    default:
      return assertNever(presence);
  }
}

/**
 * ONE WAIT'S STATE, IN WORDS. Each arm says only what is known: a receipt is reported as a read, a
 * wait as a duration, and a crossed threshold as an absence -- never as an answer being due.
 */
export function describeWaitState(state: WaitState): string {
  switch (state.kind) {
    case "delivered":
      return `a Claude session read this ${describeElapsed(state.agoMs)} ago`;
    case "waiting":
      return `waiting ${describeElapsed(state.forMs)}`;
    case "nobody-listening":
      return `waiting ${describeElapsed(state.forMs)} -- nothing has read it`;
    default:
      return assertNever(state);
  }
}

/**
 * THE LAST PROOF THAT ANYTHING WAS LISTENING. The newest of: a session-log event in Sasha's voice,
 * a reply on the deck's comment pane, a reply on a candidate's comments. All three are written by
 * an attached session and by nothing else, which is what makes them evidence.
 *
 * `reads` is how the three polls are going. With no evidence AND an unfinished or failed read the
 * answer is `unknown`, never `never-acted`: "nobody has ever answered" is a claim, and a claim
 * needs a completed read behind it (UI-CONTRACT.md: "if one cannot reach it, it says so rather
 * than showing zero").
 */
export function sashaPresenceOf({
  events,
  threads,
  comments,
  reads,
  nowMs,
}: {
  events: readonly SessionEvent[];
  threads: readonly FeedbackThread[];
  comments: SlideCommentsLoad;
  reads: PresenceReads;
  nowMs: number | null;
}): SashaPresence {
  const latest = latestSashaActivity({ events, threads, comments });
  const read = newestDelivery(deliveriesOf({ events }));
  if (latest !== null) {
    const heard = read !== null && read > latest ? read : latest;
    return {
      kind: "acted",
      at: latest,
      agoMs: elapsedMsOf({ since: latest, nowMs }),
      heardAgoMs: elapsedMsOf({ since: heard, nowMs }),
    };
  }
  // SECOND, not first: an act proves a read happened too, so the stronger claim wins even when the
  // receipt is the newer file. Reporting "it read your comments" over "it answered them" would be
  // technically true and strictly less informative.
  if (read !== null) return { kind: "delivered", at: read, agoMs: elapsedMsOf({ since: read, nowMs }) };
  if (reads.incomplete !== null) return { kind: "unknown", message: reads.incomplete };
  return { kind: "never-acted" };
}

/**
 * How the reads that could carry evidence are going, reduced to the one thing this decision needs:
 * the reason the answer cannot be trusted yet, or null when all three are in.
 */
export type PresenceReads = Readonly<{ incomplete: string | null }>;

/** Milliseconds since an ISO timestamp, or null when the clock or the stamp cannot give one. */
export function elapsedMsOf({ since, nowMs }: { since: string; nowMs: number | null }): number | null {
  if (nowMs === null) return null;
  const at = Date.parse(since);
  if (!Number.isFinite(at)) return null;
  // Clamped at zero: Drive's clock and the browser's are not the same clock, and "waiting -3 s"
  // reads as a bug rather than as the sub-second skew it is.
  return Math.max(0, nowMs - at);
}

/**
 * A duration a person can read at a glance, and the unit a person would use for it. Seconds matter
 * in the first minute (it is the difference between "it is working" and "it is stuck") and stop
 * mattering after an hour.
 */
export function describeElapsed(elapsedMs: number | null): string {
  if (elapsedMs === null) return "just now";
  const seconds = Math.floor(elapsedMs / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${pad(seconds % 60)} s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${pad(minutes % 60)} min`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ${pad(hours % 24)} h`;
}

/**
 * THE HEADLINE OVER A WAIT: how many things, and -- the part that had to change -- what the oldest
 * one's duration MEANS.
 *
 * "the oldest for 1 h 47 min" is a count-up, and a count-up reads as progress. When nothing has
 * read that comment the same number is not a progress report, it is how long the user has been
 * alone, so the headline says so and the notice below it says what to do.
 */
export function describeWaiting(waiting: readonly WaitingItem[]): string {
  if (waiting.length === 0) return "Nothing is waiting for Sasha.";
  const longest = waiting[0];
  const what = waiting.length === 1 ? "1 thing" : `${waiting.length} things`;
  if (longest === undefined) return `${what} waiting for Sasha`;
  const elapsed = describeElapsed(longest.elapsedMs);
  return waitIsUnheard(longest.state)
    ? `${what} waiting for Sasha -- nothing has read the oldest for ${elapsed}`
    : `${what} waiting for Sasha -- the oldest for ${elapsed}`;
}

/** What one waiting row is about. Exhaustive, so a third transport has to be named here. */
export function describeWaitingWhat(what: WaitingWhat): string {
  switch (what.kind) {
    case "message":
      return "you, to Sasha";
    case "comment":
      return what.region === null
        ? `you, on slide ${what.slideIndex}`
        : `you, on slide ${what.slideIndex} at ${describeRegion(what.region)}`;
    default:
      return assertNever(what);
  }
}

/**
 * THE LAST PROOF OF LIFE, IN WORDS -- and never a promise. Each arm says what was observed and
 * stops there; `SASHA_PRECONDITION` carries the rest, rendered beside it.
 */
export function describeSashaPresence(presence: SashaPresence): string {
  switch (presence.kind) {
    case "acted":
      return `Sasha last did something here ${describeElapsed(presence.agoMs)} ago.`;
    // PAST TENSE, deliberately. A receipt proves a session was there WHEN IT READ -- not that one
    // is attached now, which is still unknowable, and not that a reply is coming, which always is.
    case "delivered":
      return (
        `A Claude session read your comments ${describeElapsed(presence.agoMs)} ago. ` +
        "Something was attached then; that is not an answer."
      );
    case "never-acted":
      return (
        "Nothing has ever read or answered anything in this session. Nothing has picked these up, " +
        "and nothing will until a Claude session with the sasha-slides connector runs and polls " +
        "for feedback."
      );
    case "unknown":
      return `Whether Sasha has acted here could not be checked: ${presence.message}`;
    default:
      return assertNever(presence);
  }
}

/**
 * WHETHER THE WAIT SHOULD BE DRAWN AS LIVE -- and it stops once anything has gone unheard.
 *
 * It used to return true whenever anything was waiting, on the argument that the pulse is about the
 * wait rather than about an answer. A real user then watched that pulse for 1 h 47 minutes with
 * nothing attached. The argument was wrong: an animation is read as activity somewhere, and when a
 * comment has gone unread past the threshold there is no activity anywhere -- so the pulse goes
 * off and `nothingListeningOn` prints what to do instead.
 */
export function waitIsLive(waiting: readonly WaitingItem[]): boolean {
  return waiting.length > 0 && !waiting.some((item) => waitIsUnheard(item.state));
}

/** Whether a state is the one that means nobody read it. A switch, so a fourth state must decide. */
export function waitIsUnheard(state: WaitState): boolean {
  switch (state.kind) {
    case "nobody-listening":
      return true;
    case "delivered":
    case "waiting":
      return false;
    default:
      return assertNever(state);
  }
}

/**
 * WHETHER A MESSAGE ON THE DECK IS STILL WAITING, and it is a DIFFERENT rule from a candidate
 * comment's on purpose.
 *
 * A comment on a candidate is waiting until it is RESOLVED, because the contract's completion signal
 * is a resolved comment with a revised slide, and the server has `resolve_feedback` to close it with.
 * A message typed into the conversation has no such closing move -- nothing resolves a deck comment
 * -- so a reply IS its answer, and a thread that kept claiming to be waiting after Sasha answered it
 * would be a permanent false alarm. Which is the same failure as "no answer yet", pointing the other
 * way.
 */
function messageIsWaiting(thread: FeedbackThread): boolean {
  // SASHA'S reply, not any reply. The pill under every thread lets the user reply too, and the
  // connector posts as the user's own Google account, so only `authoredByAgent` can tell the two
  // apart. Counting the user's own "hello?" as the answer ended the wait -- and with it the
  // nothing-listening notice -- with no session attached at all (user report, 2026-10-11).
  return !thread.resolved && !thread.replies.some((reply) => reply.authoredByAgent);
}

function commentWait({
  slideIndex,
  thread,
  deliveries,
  nowMs,
}: {
  slideIndex: number;
  thread: SlideThread;
  deliveries: Deliveries;
  nowMs: number | null;
}): WaitingItem {
  return {
    waitId: `cc_${thread.commentId}`,
    what: { kind: "comment", slideIndex, region: thread.region },
    text: thread.text,
    since: thread.at,
    elapsedMs: elapsedMsOf({ since: thread.at, nowMs }),
    state: waitStateOf({ commentId: thread.commentId, since: thread.at, deliveries, nowMs }),
    replies: thread.replies.length,
    latestReply: lastReplyTextOf(thread.replies),
  };
}

/**
 * THE THREE-WAY DECISION FOR ONE COMMENT, in the order the contract states it (PROTOCOL.md's
 * table). Exported because the LOG renders one message at a time and must reach the same verdict
 * the pinned list does -- two clocks over one comment that could disagree is the drift this product
 * has already shipped once.
 *
 * A receipt wins outright: it is the only positive evidence in the system, and once something has
 * read a comment the elapsed time stops being an accusation. Without one, the threshold decides --
 * and WITHOUT A CLOCK NOBODY IS ACCUSED: `elapsedMs` is null in the first tick and when Drive's
 * stamp is unreadable, and "nothing is listening" is a claim that needs a measured duration behind
 * it, exactly as "nobody has ever answered" needs a completed read behind it.
 */
export function waitStateOf({
  commentId,
  since,
  deliveries,
  nowMs,
}: {
  commentId: string;
  since: string;
  deliveries: Deliveries;
  nowMs: number | null;
}): WaitState {
  const deliveredAt = deliveries.get(commentId);
  if (deliveredAt !== undefined) {
    return { kind: "delivered", at: deliveredAt, agoMs: elapsedMsOf({ since: deliveredAt, nowMs }) };
  }
  const forMs = elapsedMsOf({ since, nowMs });
  if (forMs === null || forMs < FEEDBACK_DELIVERY_THRESHOLD_MS) return { kind: "waiting", forMs };
  return { kind: "nobody-listening", forMs };
}

/** The newest receipt in the whole map, or null when there are none. */
function newestDelivery(deliveries: Deliveries): string | null {
  let newest: string | null = null;
  for (const at of deliveries.values()) if (newest === null || at > newest) newest = at;
  return newest;
}

/** The newest reply's words, or null. Empty text is null too: a blank quote says nothing. */
function lastReplyTextOf(replies: readonly FeedbackReply[]): string | null {
  const last = replies[replies.length - 1];
  if (last === undefined) return null;
  return last.text.trim() === "" ? null : last.text;
}

/**
 * The newest timestamp that only an attached session could have produced, or null.
 *
 * The event side goes through `sessionEventVoiceOf`, so a new event kind has to declare its voice
 * there and is counted or not counted by that one declaration -- rather than by a list of kinds
 * copied into this file that would quietly fall out of date.
 */
function latestSashaActivity({
  events,
  threads,
  comments,
}: {
  events: readonly SessionEvent[];
  threads: readonly FeedbackThread[];
  comments: SlideCommentsLoad;
}): string | null {
  const stamps: string[] = [];
  for (const event of events) if (isSashaVoice(event)) stamps.push(event.at);
  // Only the AGENT'S replies: a reply the user typed under their own thread proves nothing about
  // whether anything is attached, and the same account posts both (see `messageIsWaiting`).
  for (const thread of threads) stamps.push(...agentReplyStamps(thread.replies));
  for (const slide of loadedSlideComments(comments)) {
    for (const thread of readThreadsOf(slide)) stamps.push(...agentReplyStamps(thread.replies));
  }
  const usable = stamps.filter((stamp) => stamp !== "" && Number.isFinite(Date.parse(stamp)));
  if (usable.length === 0) return null;
  return usable.reduce((newest, stamp) => (stamp > newest ? stamp : newest));
}

/** When Sasha replied, for each reply it wrote. The user's own replies are not evidence. */
function agentReplyStamps(replies: readonly FeedbackReply[]): readonly string[] {
  return replies.filter((reply) => reply.authoredByAgent).map((reply) => reply.createdAt);
}

/**
 * One candidate's threads, or none when Drive could not be read for it. A switch, so a new
 * `SlideThreadsRead` variant cannot silently read as "this candidate has no threads".
 */
function readThreadsOf(slide: SlideComments): readonly SlideThread[] {
  switch (slide.threads.kind) {
    case "read":
      return slide.threads.threads;
    case "unreadable":
      return [];
    default:
      return assertNever(slide.threads);
  }
}

/** Whether an event was written by Sasha. A switch over the voice, so a new voice must be placed. */
function isSashaVoice(event: SessionEvent): boolean {
  const voice = sessionEventVoiceOf(event.body);
  switch (voice) {
    case "sasha":
      return true;
    case "user":
    case "deck":
    // A RECEIPT IS NOT AN ACT. It is evidence -- `sashaPresenceOf` reports it as `delivered` -- but
    // counting it here would make "Sasha last did something" mean "something looked at this", and
    // the difference between those two is the whole point of the receipt.
    case "delivery":
    // An entry this build cannot read proves nothing about who wrote it, so it is not evidence.
    case "opaque":
      return false;
    default:
      return assertNever(voice);
  }
}

/** Evidence this old says something WAS here, not that it is. Null (no clock) accuses nobody. */
function isStaleEvidence(agoMs: number | null): boolean {
  return agoMs !== null && agoMs >= FEEDBACK_DELIVERY_THRESHOLD_MS;
}

/** Shared, because an empty map is a value and allocating one per render is pointless churn. */
const EMPTY_DELIVERIES: Deliveries = new Map<string, string>();

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}
