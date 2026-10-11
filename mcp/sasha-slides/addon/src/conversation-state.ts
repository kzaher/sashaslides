// THE CONVERSATION'S WHOLE STATE: the spine of the product, and now the ONLY thing the Slides menu
// opens (UI-CONTRACT.md, "One way in: Ask Sasha"). One immutable tree, one pure reducer.
//
// WHAT IT IS NOW. It used to be a chat with a "there are candidates waiting" banner bolted on top,
// and the menu listed the two surfaces so the user assembled the product themselves. It is now a
// SERIALIZED EVENT LOG: everything that happens -- slides staged, a comment you opened, Sasha's
// answer, a revised slide, a resolution, a clear, an insertion -- is an event, appended in order,
// rendered in order, for ever. A "message" is one more entry in the same list, not a separate
// stream, which is why `conversationEntriesOf` merges the two rather than stacking two panes.
//
// THREE SOURCES, ONE ORDERED LIST:
//
//   1. THE SESSION LOG (`log`). One file per event in `<proposal>/events/`, read through
//      session-log.ts, which is also the only file that knows the Drive shapes. An event kind this
//      build does not know renders as an opaque line and is NEVER dropped.
//   2. THE DECK'S COMMENT PANE (`thread`). What the user types here is one native Slides comment
//      on the presentation and Sasha's answers are the replies under it -- the transport that was
//      already here, kept because the user's words land where Google's own notifications find
//      them and nothing new has to be persisted.
//   3. THE CANDIDATES' OWN COMMENTS (`comments`). Comments live on `NN.html`, not on the deck,
//      because the point is to mark a slide up BEFORE it is inserted. This is where the
//      unresolved counts come from, and the SAME `SlideCommentsLoad` the slides window reads --
//      see session-log.ts's `unresolvedCountFor`, which both surfaces call.
//
// THE SURFACES STILL SHARE NOTHING. Separate HtmlService documents, separate frames: everything
// below reaches the slides window through the server and only through the server. `scanInbox` says
// what is staged, `sashaOpenPicker` asks Apps Script to show it. There is no postMessage, no
// shared storage and no window handle -- which is also why "the dialog opens by itself when slides
// arrive" is a decision made HERE (`proposalToAutoOpen`) and executed as a server call.

import type { NothingListeningNotice } from "../../feedback-delivery.ts";
import type { ProposalMark } from "./bridge.ts";
import type { CommentFilter } from "./comment-panel.ts";
import type { FeedbackReply, FeedbackThread, ReviewNote } from "./feedback.ts";
import { assertNever, type Manifest, type Region, type SlideEntry } from "./protocol.ts";
import {
  deliveriesOf,
  nothingListeningOn,
  type Deliveries,
  sashaPresenceOf,
  waitingOn,
  type PresenceReads,
  type SashaPresence,
  type WaitingItem,
} from "./waiting.ts";
import {
  loadedSlideComments,
  needsSlideComments,
  newestSetChangeIn,
  sessionEventVoiceOf,
  slideIndexOf,
  type SessionEvent,
  type SessionEventBody,
  type CandidateFile,
  type SessionEventVoice,
  type SlideCommentsLoad,
} from "./session-log.ts";

export type Conversation = Readonly<{
  /** Null until `sashaHello` has answered, and the reason every send has a "not connected" path. */
  presentationId: string | null;
  /** The composer's contents. In the tree, so a poll-driven re-render cannot swallow a half-typed message. */
  draft: string;
  send: SendPhase;
  thread: ThreadLoad;
  /** Candidates waiting in Drive, so the conversation can offer to open the slides window. */
  staged: StagedLoad;
  /**
   * THE SET THIS CONVERSATION IS FOLLOWING, and it is STICKY. It is adopted from the newest staged
   * proposal and replaced only by a strictly newer one -- never cleared when the proposal is
   * answered, because the log is append-only and "for ever" (UI-CONTRACT.md). A conversation that
   * emptied itself the moment a slide was inserted would lose exactly the history that proves the
   * round trip happened.
   */
  set: FollowedSet;
  log: SessionLogLoad;
  /** The candidates' comment threads: the unresolved counts' one source, shared with the grid. */
  comments: SlideCommentsLoad;
  open: OpenPhase;
  /**
   * The proposals the slides window has already been opened for WITHOUT being asked. The dialog
   * opens by itself when slides arrive (UI-CONTRACT.md) and must then stay closed if the user
   * closes it, so the fact that it was offered is remembered per proposal rather than re-derived.
   */
  autoOpened: readonly string[];
  /**
   * Asking for the DEFECT-REPORT window -- a third document of its own now, not a mode of the
   * slides window. Its own phase and not `open`'s, because the two are different requests with
   * different refusals and a user who pressed one must not be shown the other's verdict.
   */
  report: OpenPhase;
  /**
   * Which comments the side panel is showing. In the TREE, not in the component: the panel is
   * re-rendered by every poll, and a filter held in component state would snap back to the
   * default every few seconds.
   */
  commentFilter: CommentFilter;
  /**
   * EACH THREAD'S REPLY PILL AND WHAT ITS LAST REPLY OR RESOLVE DID, keyed by the thread's root
   * comment id. In the tree for the same reason `draft` is: a poll lands every few seconds and a
   * reply the user is half-way through typing must survive the re-render it causes.
   */
  threadActions: Readonly<Record<string, ThreadActionState>>;
  /**
   * ONE MORE READ, ASKED FOR BY AN ACTION. A reply or a resolve has to show up in its card, so a
   * success raises the flag for the source it changed and that read's own `*-requested` lowers it.
   *
   * A FLAG AND NOT A CLOCK, on purpose: "read again" wired into `pump` once re-armed itself on
   * every state change and spent the day's UrlFetch quota (call-budget.ts). A flag cleared by the
   * very request it causes can start exactly one read per action, whatever `pump` does.
   */
  rereadWanted: Readonly<{ thread: boolean; comments: boolean }>;
  /**
   * WHICH OF THE THREE PRESENCE READS HAS COME BACK AT LEAST ONCE -- for the followed set, in the
   * case of the log and the comments, so a new set starts over.
   *
   * The loads alone cannot say it: the 8 s poll puts every one of them back in `loading` (keeping
   * what it had), and a `loading` that is a RE-read looks exactly like the first one. Presence used
   * to read both as "unfinished", flip to `unknown` on every poll, and drop the nothing-listening
   * notice for the length of each round trip (user report, 2026-10-11). A re-read in flight, or one
   * that failed, does not take back what the last completed read proved.
   */
  readOnce: Readonly<{ thread: boolean; log: boolean; comments: boolean }>;
  /** A failure that is about the whole conversation rather than one load. Null when there is none. */
  trouble: string | null;
  /**
   * THE WALL CLOCK, IN THE TREE. Elapsed time is what makes a wait honest (UI-CONTRACT.md,
   * "Waiting for Sasha must be honest"), and a component that read `Date.now()` in its render body
   * would show the time of the last unrelated re-render rather than the time now -- the exact
   * failure the owner saw, where a comment sat under a static line with no activity at all.
   *
   * It is `null` until the composition root's first tick, which is typed absence rather than a
   * sentinel `0`: a surface that has not been told the time says "just now", it does not compute a
   * 57-year wait.
   */
  nowMs: number | null;
}>;

/** One thread's pill and its last action. Absent from the record means "nothing typed, nothing done". */
export type ThreadActionState = Readonly<{ draft: string; phase: ThreadActionPhase }>;

/** The two things a card can do to its thread. Both are a POST to Drive's replies endpoint. */
export type ThreadActionKind = "reply" | "resolve";

export type ThreadActionPhase =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "sending"; action: ThreadActionKind }>
  | Readonly<{ kind: "done"; action: ThreadActionKind }>
  | Readonly<{ kind: "failed"; action: ThreadActionKind; message: string }>;

/**
 * WHICH TRANSPORT A THREAD CAME FROM, and so which read has to happen after it changes: a deck
 * message is in `thread` (the presentation's comment pane), a candidate's mark-up in `comments`.
 */
export type ThreadSource = "deck" | "candidate";

export type SendPhase =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "sending" }>
  | Readonly<{ kind: "sent" }>
  | Readonly<{ kind: "failed"; message: string }>;

/**
 * EVERY variant past `unrequested` carries the threads, including `loading` and `failed`. The
 * conversation is re-read every few seconds, so a variant that dropped them would blank the whole
 * exchange on each poll and again on each failure -- and losing the conversation because one poll
 * was slow or failed is worse than showing it next to a warning.
 */
export type ThreadLoad =
  | Readonly<{ kind: "unrequested" }>
  | Readonly<{ kind: "loading"; threads: readonly FeedbackThread[] }>
  | Readonly<{ kind: "loaded"; threads: readonly FeedbackThread[]; readAt: string }>
  | Readonly<{ kind: "failed"; message: string; threads: readonly FeedbackThread[] }>;

/** Same "a re-read keeps what it had" rule as `ThreadLoad`, for the event log. */
export type SessionLogLoad =
  | Readonly<{ kind: "unrequested" }>
  | Readonly<{ kind: "loading"; events: readonly SessionEvent[] }>
  | Readonly<{ kind: "loaded"; events: readonly SessionEvent[]; readAt: string }>
  | Readonly<{ kind: "failed"; message: string; events: readonly SessionEvent[] }>;

export type StagedLoad =
  | Readonly<{ kind: "unrequested" }>
  /**
   * A scan is in flight. `had` is what the LAST one found, or null when there has never been one.
   *
   * It carries the previous result because this load is re-read every SCAN_FRESH_MS for the life
   * of the session: a bare `loading` made `conversationIsOpening` true on every poll, so the
   * whole conversation was replaced by a spinner every few seconds -- and every other reader
   * (the report entry, the slides button) forgot what it knew for the length of the round trip.
   * A refresh must never take away what is already on screen.
   */
  | Readonly<{ kind: "loading"; had: Readonly<{ proposals: readonly StagedProposal[]; readAt: string }> | null }>
  /** `readAt` is what makes a finished read go stale instead of re-firing at once. */
  | Readonly<{ kind: "loaded"; proposals: readonly StagedProposal[]; readAt: string }>
  | Readonly<{ kind: "failed"; message: string }>;

/** A proposal that is complete (`READY` exists) and unanswered (no sibling `PICK`). */
export type StagedProposal = Readonly<{
  proposalId: string;
  folderId: string;
  readyFileId: string;
  createdTime: string;
}>;

/**
 * The followed set. `none` until the first scan finds something; after that it always names a
 * proposal, whose manifest is what the comment read and the inline revisions need (the fileIds of
 * `NN.html`).
 */
export type FollowedSet =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "following";
      proposalId: string;
      folderId: string;
      readyFileId: string;
      createdTime: string;
      manifest: ManifestLoad;
      /** The candidates, with the HTML of the ones a revision has to render inline. */
      slides: readonly ConversationSlide[];
    }>;

/**
 * `forEventId` is the newest SET-CHANGING event in the log when this manifest was read, and it is
 * what makes the read happen again: a revision or a clear appends an event, so when that id moves
 * the candidate set has moved and the manifest is stale. That is the protocol's split -- listing
 * `events/` is the "has anything happened" signal, `manifest.revision` is "have the candidates
 * changed" -- and it is why the add-on polls the LOG and never the manifest. The add-on appending
 * an event must never make it a writer of `manifest.json`.
 */
export type ManifestLoad =
  | Readonly<{ kind: "unrequested" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "loaded"; count: number; revision: number | null; forEventId: string | null }>
  | Readonly<{ kind: "failed"; message: string; forEventId: string | null }>;

/**
 * One candidate, from the conversation's point of view. It holds the HTML only for the slides a
 * `slide-revised` event points at: the conversation renders a revised slide INLINE at the point in
 * the log where it happened, and that is the completion signal for a round trip -- not a spinner
 * and not a toast (UI-CONTRACT.md).
 */
export type ConversationSlide = Readonly<{
  slideIndex: number;
  fileId: string;
  name: string;
  label: string;
  html: SlideHtmlLoad;
  /**
   * WHICH `slide-revised` EVENT THE BYTES IN HAND BELONG TO, or null for the bytes as first staged.
   *
   * A revision overwrites `NN.html` IN PLACE -- that is what keeps the comment threads attached
   * across revisions -- so the file id does NOT change and a cache keyed on it would serve the old
   * slide for ever. Keying on the event instead is what makes a second revision re-fetch.
   */
  fetchedFor: string | null;
}>;

export type SlideHtmlLoad =
  | Readonly<{ kind: "unrequested" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "loaded"; html: string }>
  | Readonly<{ kind: "failed"; message: string }>;

/** Asking Apps Script to show another window. It can be refused, and a refusal has to reach the screen. */
export type OpenPhase =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "opening" }>
  | Readonly<{ kind: "opened" }>
  | Readonly<{ kind: "failed"; message: string }>;

export type ConversationEvent =
  | Readonly<{ kind: "connected"; presentationId: string | null }>
  | Readonly<{ kind: "trouble"; message: string }>
  | Readonly<{ kind: "draft-typed"; text: string }>
  | Readonly<{ kind: "send-started" }>
  | Readonly<{ kind: "send-succeeded" }>
  | Readonly<{ kind: "send-failed"; message: string }>
  | Readonly<{ kind: "thread-requested" }>
  | Readonly<{ kind: "thread-arrived"; threads: readonly FeedbackThread[]; readAt: string }>
  | Readonly<{ kind: "thread-failed"; message: string }>
  | Readonly<{ kind: "staged-requested" }>
  | Readonly<{ kind: "staged-arrived"; marks: readonly ProposalMark[]; readAt: string }>
  | Readonly<{ kind: "staged-failed"; message: string }>
  | Readonly<{ kind: "manifest-requested" }>
  | Readonly<{ kind: "manifest-arrived"; manifest: Manifest }>
  | Readonly<{ kind: "manifest-failed"; message: string }>
  | Readonly<{ kind: "log-requested" }>
  | Readonly<{ kind: "log-arrived"; events: readonly SessionEvent[]; readAt: string }>
  | Readonly<{ kind: "log-failed"; message: string }>
  | Readonly<{ kind: "comments-requested" }>
  | Readonly<{ kind: "comments-arrived"; comments: SlideCommentsLoad }>
  | Readonly<{ kind: "comments-failed"; message: string }>
  | Readonly<{ kind: "slide-requested"; slideIndex: number }>
  | Readonly<{ kind: "slide-arrived"; slideIndex: number; html: string }>
  | Readonly<{ kind: "slide-failed"; slideIndex: number; message: string }>
  | Readonly<{ kind: "open-requested" }>
  | Readonly<{ kind: "open-succeeded" }>
  | Readonly<{ kind: "open-failed"; message: string }>
  /** The slides window was shown without the user asking, for this proposal. Recorded once. */
  | Readonly<{ kind: "auto-opened"; proposalId: string }>
  | Readonly<{ kind: "report-requested" }>
  | Readonly<{ kind: "report-succeeded" }>
  | Readonly<{ kind: "report-failed"; message: string }>
  /** The clock moved. Its own event because it changes NOTHING else -- see `nowMs`. */
  | Readonly<{ kind: "clock-ticked"; nowMs: number }>
  | Readonly<{ kind: "comment-filter-chosen"; filter: CommentFilter }>
  | Readonly<{ kind: "reply-typed"; commentId: string; text: string }>
  | Readonly<{ kind: "thread-action-started"; commentId: string; action: ThreadActionKind }>
  | Readonly<{ kind: "thread-action-succeeded"; commentId: string; action: ThreadActionKind; source: ThreadSource }>
  | Readonly<{ kind: "thread-action-failed"; commentId: string; action: ThreadActionKind; message: string }>;

export const INITIAL_CONVERSATION: Conversation = {
  presentationId: null,
  draft: "",
  send: { kind: "idle" },
  thread: { kind: "unrequested" },
  staged: { kind: "unrequested" },
  set: { kind: "none" },
  log: { kind: "unrequested" },
  comments: { kind: "unrequested" },
  open: { kind: "idle" },
  autoOpened: [],
  commentFilter: "open",
  report: { kind: "idle" },
  threadActions: {},
  rereadWanted: { thread: false, comments: false },
  readOnce: { thread: false, log: false, comments: false },
  trouble: null,
  nowMs: null,
};

export function reduceConversation(conversation: Conversation, event: ConversationEvent): Conversation {
  switch (event.kind) {
    case "connected":
      return { ...conversation, presentationId: event.presentationId, trouble: null };

    case "trouble":
      return { ...conversation, trouble: event.message };

    case "clock-ticked":
      // Identity is preserved when the millisecond has not moved, so a tick that lands twice in the
      // same millisecond does not re-render the whole log.
      return conversation.nowMs === event.nowMs ? conversation : { ...conversation, nowMs: event.nowMs };

    case "draft-typed":
      // Typing makes the last send's verdict stale: "sent" next to a fresh unsent message reads as
      // though that one went too. A send IN FLIGHT is not cleared -- it is still happening.
      return { ...conversation, draft: event.text, send: afterEdit(conversation.send) };

    case "send-started":
      return { ...conversation, send: { kind: "sending" } };

    case "send-succeeded":
      // The message is now a comment on the deck, so the composer empties and the thread list is
      // stale -- the answer to what was just sent will arrive as a reply under it.
      return { ...conversation, draft: "", send: { kind: "sent" }, thread: { kind: "unrequested" } };

    case "send-failed":
      // The draft is KEPT. A message the user typed must never be destroyed by a failed send.
      return { ...conversation, send: { kind: "failed", message: event.message } };

    case "thread-requested":
      return {
        ...conversation,
        thread: { kind: "loading", threads: loadedThreads(conversation.thread) },
        rereadWanted: { ...conversation.rereadWanted, thread: false },
      };

    case "thread-arrived":
      return {
        ...conversation,
        thread: { kind: "loaded", threads: event.threads, readAt: event.readAt },
        readOnce: { ...conversation.readOnce, thread: true },
      };

    case "thread-failed":
      return {
        ...conversation,
        thread: { kind: "failed", message: event.message, threads: loadedThreads(conversation.thread) },
      };

    case "comment-filter-chosen":
      return { ...conversation, commentFilter: event.filter };

    case "staged-requested":
      return {
        ...conversation,
        staged: {
          kind: "loading",
          had: conversation.staged.kind === "loaded"
            ? { proposals: conversation.staged.proposals, readAt: conversation.staged.readAt }
            : stagedResultOf(conversation.staged),
        },
      };

    case "staged-arrived": {
      const proposals = stagedProposalsOf({ marks: event.marks });
      return {
        ...conversation,
        staged: { kind: "loaded", proposals, readAt: event.readAt },
        ...followOn({ conversation, proposals }),
      };
    }

    case "staged-failed":
      return { ...conversation, staged: { kind: "failed", message: event.message } };

    case "manifest-requested":
      return withSet(conversation, (set) => ({ ...set, manifest: { kind: "loading" } }));

    case "manifest-arrived":
      return withSet(conversation, (set) => ({
        ...set,
        manifest: {
          kind: "loaded",
          count: event.manifest.count,
          revision: event.manifest.revision,
          forEventId: newestSetChangeIn(loadedEvents(conversation.log)),
        },
        slides: event.manifest.slides.map((slide) => slideOf({ slide, slides: set.slides })),
      }));

    case "manifest-failed":
      return withSet(conversation, (set) => ({
        ...set,
        manifest: {
          kind: "failed",
          message: event.message,
          // The failure is recorded AGAINST the log it was read at, so a later event retries it
          // rather than leaving the conversation stuck on one bad read.
          forEventId: newestSetChangeIn(loadedEvents(conversation.log)),
        },
      }));

    case "log-requested":
      return { ...conversation, log: { kind: "loading", events: loadedEvents(conversation.log) } };

    case "log-arrived":
      return {
        ...conversation,
        log: { kind: "loaded", events: event.events, readAt: event.readAt },
        readOnce: { ...conversation.readOnce, log: true },
      };

    case "log-failed":
      return {
        ...conversation,
        log: { kind: "failed", message: event.message, events: loadedEvents(conversation.log) },
      };

    case "comments-requested":
      return {
        ...conversation,
        comments: { kind: "loading", slides: loadedSlideComments(conversation.comments) },
        rereadWanted: { ...conversation.rereadWanted, comments: false },
      };

    case "comments-arrived":
      return {
        ...conversation,
        comments: event.comments,
        readOnce: {
          ...conversation.readOnce,
          comments: conversation.readOnce.comments || reasonOfCommentRead(event.comments) === null,
        },
      };

    case "comments-failed":
      return {
        ...conversation,
        comments: { kind: "failed", message: event.message, slides: loadedSlideComments(conversation.comments) },
      };

    case "slide-requested": {
      // Stamped with the revision the fetch is FOR, so a revision that lands while this one is in
      // flight is seen as a new fetch rather than satisfied by the bytes already on the way.
      const fetchedFor = latestRevisionIdFor({ conversation, slideIndex: event.slideIndex });
      return mapSlide(conversation, event.slideIndex, (slide) => ({
        ...slide,
        html: { kind: "loading" },
        fetchedFor,
      }));
    }

    case "slide-arrived":
      return mapSlide(conversation, event.slideIndex, (slide) => ({
        ...slide,
        html: { kind: "loaded", html: event.html },
      }));

    case "slide-failed":
      return mapSlide(conversation, event.slideIndex, (slide) => ({
        ...slide,
        html: { kind: "failed", message: event.message },
      }));

    case "open-requested":
      return { ...conversation, open: { kind: "opening" } };

    case "open-succeeded":
      return { ...conversation, open: { kind: "opened" } };

    case "open-failed":
      return { ...conversation, open: { kind: "failed", message: event.message } };

    case "auto-opened":
      return conversation.autoOpened.includes(event.proposalId)
        ? conversation
        : { ...conversation, autoOpened: [...conversation.autoOpened, event.proposalId] };

    case "report-requested":
      return { ...conversation, report: { kind: "opening" } };

    case "report-succeeded":
      return { ...conversation, report: { kind: "opened" } };

    case "report-failed":
      return { ...conversation, report: { kind: "failed", message: event.message } };

    case "reply-typed": {
      // Typing makes the last verdict stale, as in the composer; a post IN FLIGHT stays shown.
      const current = threadActionOf({ conversation, commentId: event.commentId });
      return withThreadAction(conversation, event.commentId, {
        draft: event.text,
        phase: current.phase.kind === "sending" ? current.phase : { kind: "idle" },
      });
    }

    case "thread-action-started": {
      const current = threadActionOf({ conversation, commentId: event.commentId });
      return withThreadAction(conversation, event.commentId, {
        ...current,
        phase: { kind: "sending", action: event.action },
      });
    }

    case "thread-action-succeeded": {
      const current = threadActionOf({ conversation, commentId: event.commentId });
      return {
        ...withThreadAction(conversation, event.commentId, {
          // A posted reply empties the pill; a resolve leaves whatever was typed alone.
          draft: event.action === "reply" ? "" : current.draft,
          phase: { kind: "done", action: event.action },
        }),
        rereadWanted: rereadAfter({ wanted: conversation.rereadWanted, source: event.source }),
      };
    }

    case "thread-action-failed": {
      // The words are KEPT. A reply the user typed must never be destroyed by a failed post.
      const current = threadActionOf({ conversation, commentId: event.commentId });
      return withThreadAction(conversation, event.commentId, {
        ...current,
        phase: { kind: "failed", action: event.action, message: event.message },
      });
    }

    default:
      return assertNever(event);
  }
}

/**
 * THE CONVERSATION, as one ordered list: the session log and the comment threads merged.
 *
 * The EVENTS' own order is preserved exactly -- `sessionEventsOf` already ordered them by the file
 * name's millisecond prefix, and this sort uses that same number as the key, so the event
 * subsequence of the result is the log's order whatever the threads do.
 *
 * ONE ENTRY PER THREAD, placed by when its ROOT was posted, with the replies nested inside it in
 * their own order. It used to be one entry per post, so a question and the answer to it were two
 * cards with the log in between -- nothing like Google's comment pane, which the user reads beside
 * this one and where a thread is a single card (the user's reference screenshot, 2026-10-04).
 *
 * A COMMENT IS PART OF THE USER'S TURN, not a separate stream (UI-CONTRACT.md). That is why there
 * is one list and not two panes: a thread carries `voice: "user"` and renders in the same column
 * as what the user typed.
 */
export function conversationEntriesOf({
  events,
  threads,
  comments,
  files,
}: {
  events: readonly SessionEvent[];
  threads: readonly FeedbackThread[];
  /**
   * THE CANDIDATES' OWN COMMENT THREADS -- source 3, and the one the user actually writes on.
   *
   * It was missing here, and that is the whole reason a round trip measured against the
   * deployed add-on (2026-10-04) delivered the comment to the connector and posted Sasha's
   * reply to Drive while the conversation showed neither: the entries were built from the
   * DECK's pane alone. The counts were already read from this load, so the answer was on the
   * client the entire time -- it simply was not rendered.
   */
  comments: SlideCommentsLoad;
  /**
   * WHICH DRIVE FILE EACH THREAD LIVES ON, so its card can reply to it and resolve it: the deck's
   * own threads are on the presentation, a candidate's on its `NN.html`. `SlideComments` knows
   * only the slide index, so the manifest's join is handed in rather than re-read here. A file
   * that is not known yet is `null` on the thread -- the card then says why it cannot answer.
   */
  files: ThreadFiles;
}): readonly ConversationEntry[] {
  const entries: Keyed[] = [];
  // The connector appends `comment-opened` / `comment-answered` for the very posts the
  // threads below carry, so without this every comment and every answer appeared TWICE.
  // The thread wins: it is the live object and knows whether the comment is still open.
  const carriedByAThread = commentIdsInThreads(comments);
  events.forEach((event, position) => {
    const about = commentIdOfEvent(event.body);
    if (about !== null && carriedByAThread.has(about)) return;
    entries.push({
      at: event.atMillis,
      position,
      entry: {
        kind: "event",
        entryId: `event_${event.eventId}`,
        at: event.at,
        voice: sessionEventVoiceOf(event.body),
        event,
      },
    });
  });
  // Oldest first, which is what a conversation reads like. `feedbackThreadsOf` hands them over
  // newest-first because the replies view wanted the thing you just sent at the top.
  const oldestFirst = [...threads].sort((left, right) =>
    left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
  );
  let position = events.length;
  for (const thread of oldestFirst) {
    entries.push({
      at: millisOf(thread.createdAt),
      position: (position += 1),
      entry: threadEntryOf({
        commentId: thread.commentId,
        source: "deck",
        fileId: files.deck,
        slideIndex: null,
        about: aboutOf(thread.note),
        resolved: thread.resolved,
        // The deck channel's note carries no author: it is always what was typed in this panel.
        root: { postId: thread.commentId, author: "You", text: thread.note.text, at: thread.createdAt, voice: "user" },
        replies: thread.replies.map((reply) => postOfReply({ reply, fallbackAt: thread.createdAt })),
      }),
    });
  }
  // A candidate a poll could not read contributes nothing: `loadedSlideComments` keeps the last
  // good slides and `unreadable` is skipped, so a bad poll never deletes conversation history.
  for (const slide of loadedSlideComments(comments)) {
    if (slide.threads.kind === "unreadable") continue;
    const fileId = files.candidates.find((candidate) => candidate.slideIndex === slide.slideIndex)?.fileId ?? null;
    for (const thread of slide.threads.threads) {
      entries.push({
        at: millisOf(thread.at),
        position: (position += 1),
        entry: threadEntryOf({
          commentId: thread.commentId,
          source: "candidate",
          fileId,
          slideIndex: slide.slideIndex,
          about: aboutCandidate({ slideIndex: slide.slideIndex, region: thread.region }),
          resolved: thread.resolved,
          root: {
            postId: thread.commentId,
            author: thread.author === "" ? "You" : thread.author,
            text: thread.text,
            at: thread.at,
            voice: "user",
          },
          replies: thread.replies.map((reply) => postOfReply({ reply, fallbackAt: thread.at })),
        }),
      });
    }
  }
  return entries
    .sort((left, right) => (left.at !== right.at ? left.at - right.at : left.position - right.position))
    .map((keyed) => keyed.entry);
}

/** The files the threads live on. See `conversationEntriesOf`'s `files`. */
export type ThreadFiles = Readonly<{ deck: string | null; candidates: readonly CandidateFile[] }>;

/** The files of THIS conversation: its presentation, and the followed set's candidates. */
export function threadFilesOf(conversation: Conversation): ThreadFiles {
  return {
    deck: conversation.presentationId,
    candidates: slidesOf(conversation).map((slide) => ({ slideIndex: slide.slideIndex, fileId: slide.fileId })),
  };
}

/**
 * The comment ids the candidates' threads already render, so the log's receipts for them can
 * stand down. An id only counts when its thread was actually READ: an unreadable candidate
 * must not silently swallow the log's record of what happened on it.
 */
function commentIdsInThreads(comments: SlideCommentsLoad): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const slide of loadedSlideComments(comments)) {
    if (slide.threads.kind === "unreadable") continue;
    for (const thread of slide.threads.threads) ids.add(thread.commentId);
  }
  return ids;
}

/** The comment a log event is about, or null for an event that is not about one. */
function commentIdOfEvent(body: SessionEventBody): string | null {
  switch (body.kind) {
    case "comment-opened":
    case "comment-answered":
    case "comment-resolved":
      return body.commentId;
    case "slides-staged":
    case "slide-revised":
    case "slides-cleared":
    case "slide-inserted":
    case "feedback-delivered":
    case "opaque":
      return null;
    default:
      return assertNever(body);
  }
}

/** One card of the conversation: a log event, or a whole comment thread. */
export type ConversationEntry =
  | Readonly<{ kind: "event"; entryId: string; at: string; voice: SessionEventVoice; event: SessionEvent }>
  | Readonly<{ kind: "thread"; entryId: string; at: string; voice: SessionEventVoice; thread: ConversationThread }>;

/**
 * ONE COMMENT THREAD, the way Google's pane draws it: the root and its replies, in one card.
 *
 * It carries everything the card needs to ACT on the thread as well as draw it -- the file it lives
 * on and which transport it came from -- because a reply is a POST to that file's comment, and the
 * read that brings the reply back is the one its source names.
 */
export type ConversationThread = Readonly<{
  commentId: string;
  source: ThreadSource;
  /** The Drive file the comment is on, or null when that file is not known yet. */
  fileId: string | null;
  /**
   * The candidate this is a comment on, or null for a message about the deck.
   *
   * It is here so the unresolved badge can ride on the THREAD. It used to ride on the log's
   * `comment-opened` receipt, which is suppressed when the thread itself is on screen -- and the
   * badge has to follow the card that survived, or a slide with open comments stops saying so.
   */
  slideIndex: number | null;
  /** "the deck" for a general message, or which slide and box it was about. */
  about: string;
  resolved: boolean;
  root: ConversationPost;
  /** In the order Drive lists them, which is the order they were posted. */
  replies: readonly ConversationPost[];
}>;

/**
 * One post in a thread. `author` is already the name to SHOW: the agent's posts are always
 * "Sasha", never Drive's author -- the connector posts as the user's own Google account, so that
 * field carries the user's name on Sasha's words, and signing them with it is the one thing the
 * card must not do.
 */
export type ConversationPost = Readonly<{ postId: string; author: string; text: string; at: string; voice: PostVoice }>;

/** Who wrote a post. Only two: a thread is the user's conversation with Sasha. */
export type PostVoice = "user" | "sasha";

/**
 * THE PILL AND THE LAST ACTION OF ONE THREAD, with "nothing typed, nothing done" for a thread
 * that has never been touched -- typed absence in the record rather than an entry per thread.
 */
export function threadActionOf({
  conversation,
  commentId,
}: {
  conversation: Conversation;
  commentId: string;
}): ThreadActionState {
  return conversation.threadActions[commentId] ?? NO_THREAD_ACTION;
}

/** What a thread's pill would post, or null when there is nothing to post. Never an empty reply. */
export function outgoingReply({
  conversation,
  commentId,
}: {
  conversation: Conversation;
  commentId: string;
}): string | null {
  const text = threadActionOf({ conversation, commentId }).draft.trim();
  return text === "" ? null : text;
}

/** Whether a reply or resolve on this thread is in flight, so the card can go read-only. */
export function isThreadBusy(state: ThreadActionState): boolean {
  switch (state.phase.kind) {
    case "sending":
      return true;
    case "idle":
    case "done":
    case "failed":
      return false;
    default:
      return assertNever(state.phase);
  }
}

const NO_THREAD_ACTION: ThreadActionState = { draft: "", phase: { kind: "idle" } };

/**
 * THE SLIDE A `slide-revised` ENTRY SHOULD RENDER, or why it cannot.
 *
 * A revision OVERWRITES `NN.html` in place (that is what keeps the comment threads attached across
 * revisions), so only the LATEST revision of a slide has bytes to show: an earlier one's are gone
 * and saying "superseded" is the honest answer rather than drawing the wrong picture under it.
 */
export function revisedSlideFor({
  conversation,
  event,
}: {
  conversation: Conversation;
  event: SessionEvent;
}): RevisedSlideRender {
  if (event.body.kind !== "slide-revised") return { kind: "not-a-revision" };
  const slideIndex = event.body.slideIndex;
  if (latestRevisionIdFor({ conversation, slideIndex }) !== event.eventId) return { kind: "superseded" };
  const slide = slidesOf(conversation).find((candidate) => candidate.slideIndex === slideIndex);
  if (slide === undefined) {
    return { kind: "unavailable", message: `slide ${slideIndex} is not in the manifest this conversation read` };
  }
  switch (slide.html.kind) {
    case "unrequested":
    case "loading":
      return { kind: "loading", slideIndex };
    case "loaded":
      return { kind: "ready", slideIndex, label: slide.label === "" ? slide.name : slide.label, html: slide.html.html };
    case "failed":
      return { kind: "unavailable", message: slide.html.message };
    default:
      return assertNever(slide.html);
  }
}

export type RevisedSlideRender =
  | Readonly<{ kind: "ready"; slideIndex: number; label: string; html: string }>
  | Readonly<{ kind: "loading"; slideIndex: number }>
  | Readonly<{ kind: "superseded" }>
  | Readonly<{ kind: "unavailable"; message: string }>
  | Readonly<{ kind: "not-a-revision" }>;

/**
 * EVERYTHING WAITING FOR SASHA, with how long it has been. One list over both transports -- the
 * deck's comment pane and the candidates' own comments -- because from the user's side they are the
 * same wait. See waiting.ts for what this can and cannot know.
 */
export function waitingFor(conversation: Conversation): readonly WaitingItem[] {
  return waitingOn({
    threads: loadedThreads(conversation.thread),
    comments: conversation.comments,
    // FROM THE SAME `loadedEvents` the log renders, so a receipt the history shows and a receipt the
    // pinned list honours can never be two different sets.
    deliveries: deliveriesOf({ events: loadedEvents(conversation.log) }),
    nowMs: conversation.nowMs,
  });
}

/**
 * THE RECEIPTS THIS SESSION HAS, for the surfaces that show one comment at a time. `waitingFor`
 * derives its own from the same `loadedEvents`, so the pinned list and a log row cannot disagree
 * about whether something read a comment.
 */
export function deliveriesFor(conversation: Conversation): Deliveries {
  return deliveriesOf({ events: loadedEvents(conversation.log) });
}

/**
 * WHAT TO PRINT WHEN NOTHING IS LISTENING, or null.
 *
 * It no longer takes the proposal: the instruction names no identifier, because `open_work`
 * answers "what is waiting for me?" from the connector's own authenticated account. A user
 * should never have to find and copy a `p_…` out of this panel.
 */
export function nothingListeningFor(conversation: Conversation): NothingListeningNotice | null {
  // Presence as well as the waits: how to attach a session is needed the moment there isn't one,
  // not five minutes after the first message goes unanswered (waiting.ts).
  return nothingListeningOn({ waiting: waitingFor(conversation), presence: sashaPresence(conversation) });
}

/**
 * WHETHER ANYTHING HAS EVER BEEN LISTENING, from the three reads the conversation already polls.
 * It is the honest half of the waiting indicator: "waiting" and "nobody is listening" look
 * identical without it, and the interface has already told a user the second was the first.
 */
export function sashaPresence(conversation: Conversation): SashaPresence {
  return sashaPresenceOf({
    events: loadedEvents(conversation.log),
    threads: loadedThreads(conversation.thread),
    comments: conversation.comments,
    reads: presenceReadsOf(conversation),
    nowMs: conversation.nowMs,
  });
}

/**
 * WHY "NOBODY HAS EVER ANSWERED" CANNOT BE CLAIMED YET, or null when it can. All three reads carry
 * evidence of an attached session, so any one of them being unfinished or failed means the absence
 * of evidence is not evidence of absence -- which is exactly the distinction `UnresolvedCount`
 * already makes for the counts, applied to presence.
 */
export function presenceReadsOf(conversation: Conversation): PresenceReads {
  const { readOnce } = conversation;
  const reasons = [
    readOnce.log ? null : reasonOfLogRead(conversation.log),
    readOnce.thread ? null : reasonOfThreadRead(conversation.thread),
    readOnce.comments ? null : reasonOfCommentRead(conversation.comments),
  ].flatMap((reason) => (reason === null ? [] : [reason]));
  return { incomplete: reasons[0] ?? null };
}

/** Whether the event log can yet support a claim about presence. A switch, so every arm answers. */
function reasonOfLogRead(log: SessionLogLoad): string | null {
  switch (log.kind) {
    case "loaded":
      return null;
    case "unrequested":
    case "loading":
      return "the event log is still being read";
    case "failed":
      return log.message;
    default:
      return assertNever(log);
  }
}

/** Same contract, for the deck's comment pane. */
function reasonOfThreadRead(thread: ThreadLoad): string | null {
  switch (thread.kind) {
    case "loaded":
      return null;
    case "unrequested":
    case "loading":
      return "this deck's comments are still being read";
    case "failed":
      return thread.message;
    default:
      return assertNever(thread);
  }
}

/** Same contract, for the candidates' own comments. */
function reasonOfCommentRead(comments: SlideCommentsLoad): string | null {
  switch (comments.kind) {
    case "loaded":
      return null;
    case "unrequested":
    case "loading":
      return "the candidates' comments are still being read";
    case "failed":
      return comments.message;
    default:
      return assertNever(comments);
  }
}

/**
 * What the user is about to send, as a note. No page and no region: this is a message about the
 * DECK, not about one slide, and `ReviewNote.pageObjectId === null` is how the wire says that.
 * Returns null when there is nothing to send, so the caller never builds an empty comment.
 */
export function outgoingMessage({
  conversation,
  messageId,
}: {
  conversation: Conversation;
  messageId: string;
}): ReviewNote | null {
  const text = conversation.draft.trim();
  if (text === "") return null;
  return { noteId: messageId, pageObjectId: null, region: null, text };
}

/**
 * WHETHER THE SLIDES WINDOW SHOULD BE OPENED WITHOUT BEING ASKED, and which proposal for.
 *
 * "The dialog opens by itself when slides arrive" (UI-CONTRACT.md) -- once, per proposal. It is a
 * decision over the state rather than a side effect in a fetch handler, so it is testable with
 * values and so a user who closes the window is not dragged back into it on the next poll.
 */
export function proposalToAutoOpen(conversation: Conversation): string | null {
  // It waits for the MANIFEST rather than firing on the scan, and that costs one round trip on
  // purpose: `READY` survives a clear, so a scan alone cannot tell a staged set from a discarded
  // one, and opening a window onto nothing is worse than opening it a second later.
  const reachable = slidesReachability(conversation);
  if (reachable.kind !== "reachable") return null;
  if (conversation.set.kind !== "following" || conversation.set.manifest.kind !== "loaded") return null;
  if (conversation.set.manifest.count === 0) return null;
  // THROUGH `stagedResultOf`, so a refresh in flight still knows what the last scan found.
  const held = stagedResultOf(conversation.staged);
  if (held === null) return null;
  const newest = held.proposals[held.proposals.length - 1];
  if (newest === undefined || newest.proposalId !== reachable.proposalId) return null;
  return conversation.autoOpened.includes(newest.proposalId) ? null : newest.proposalId;
}

/**
 * WHETHER THE SLIDES ARE REACHABLE FROM HERE, and what the button should say when they are not.
 * The button is the only way back to them once the moment they arrived has passed, so it is never
 * simply hidden: a surface that cannot do a thing says why (UI-CONTRACT.md).
 */
export function slidesReachability(conversation: Conversation): SlidesReachability {
  switch (conversation.set.kind) {
    case "following": {
      const manifest = conversation.set.manifest;
      // A CLEARED SET STILL HAS ITS `READY`. `clear_slides` deletes the uninserted candidates and
      // bumps `revision`; it does not remove the marker. So `READY` is actively stale after a
      // clear and `manifest.count` is the thing to trust -- offering a window onto nothing is
      // exactly the "it just showed nothing" failure this protocol has already shipped once.
      if (manifest.kind === "loaded" && manifest.count === 0) {
        return { kind: "cleared", proposalId: conversation.set.proposalId };
      }
      return { kind: "reachable", proposalId: conversation.set.proposalId };
    }
    case "none":
      return unstagedReachability(conversation.staged);
    default:
      return assertNever(conversation.set);
  }
}

export type SlidesReachability =
  | Readonly<{ kind: "reachable"; proposalId: string }>
  /** Sasha discarded the uninserted candidates. The log says so too; this is why the button is off. */
  | Readonly<{ kind: "cleared"; proposalId: string }>
  /** Nothing has ever been staged in this session. */
  | Readonly<{ kind: "nothing-staged" }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "unreadable"; message: string }>;

/**
 * WHETHER A DEFECT REPORT CAN BE STARTED FROM HERE, and why not when it cannot.
 *
 * A defect report is about ONE SLIDE and it carries that slide's HTML through the anonymiser, so it
 * needs one of Sasha's staged candidates to report on -- the conversation has no slide of its own.
 */
export function defectReportReadiness(conversation: Conversation): DefectReportReadiness {
  // A refresh keeps the previous answer: the report entry must not forget there is something to
  // report on for the length of every poll.
  const held = stagedResultOf(conversation.staged);
  if (held !== null) return held.proposals.length === 0 ? { kind: "nothing-staged" } : { kind: "ready" };
  switch (conversation.staged.kind) {
    case "unrequested":
    case "loading":
      return { kind: "unknown" };
    case "failed":
      return { kind: "unreadable", message: conversation.staged.message };
    case "loaded":
      return conversation.staged.proposals.length === 0 ? { kind: "nothing-staged" } : { kind: "ready" };
    default:
      return assertNever(conversation.staged);
  }
}

export type DefectReportReadiness =
  | Readonly<{ kind: "ready" }>
  /** The inbox has not been read yet. The button waits rather than lying in either direction. */
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "nothing-staged" }>
  | Readonly<{ kind: "unreadable"; message: string }>;

/** Which proposals are complete and still unanswered, OLDEST FIRST. PROTOCOL.md's two rules. */
export function stagedProposalsOf({ marks }: { marks: readonly ProposalMark[] }): readonly StagedProposal[] {
  // READY is written last, so its absence means the proposal is still partial; a sibling PICK means
  // the slides window (or a previous session) has already answered it.
  const staged: StagedProposal[] = [];
  for (const mark of marks) {
    if (mark.readyFileId === null || mark.pickFileId !== null) continue;
    staged.push({
      proposalId: mark.proposalId,
      folderId: mark.folderId,
      readyFileId: mark.readyFileId,
      createdTime: mark.createdTime,
    });
  }
  return [...staged].sort((left, right) =>
    left.createdTime < right.createdTime ? -1 : left.createdTime > right.createdTime ? 1 : 0,
  );
}

/** The followed set, or null. Every loop below is gated on it rather than on `set.kind` inline. */
export function followedSet(conversation: Conversation): FollowedProposal | null {
  switch (conversation.set.kind) {
    case "following":
      return {
        proposalId: conversation.set.proposalId,
        folderId: conversation.set.folderId,
        readyFileId: conversation.set.readyFileId,
      };
    case "none":
      return null;
    default:
      return assertNever(conversation.set);
  }
}

export type FollowedProposal = Readonly<{ proposalId: string; folderId: string; readyFileId: string }>;

/** The followed set's candidates, or none when nothing is followed or its manifest is not in. */
export function slidesOf(conversation: Conversation): readonly ConversationSlide[] {
  switch (conversation.set.kind) {
    case "following":
      return conversation.set.slides;
    case "none":
      return [];
    default:
      return assertNever(conversation.set);
  }
}

/**
 * Whether the thread loop should read. A predicate over the union rather than a bare
 * `kind === "unrequested"`, so adding a `ThreadLoad` variant is a compile error here instead of a
 * silently skipped fetch.
 */
/**
 * WHETHER A POLL SHOULD READ THIS AGAIN.
 *
 * "Loaded" is not "done": the conversation is a live log of what a Claude session is doing in
 * Drive, so every finished read wants another one on the next tick. The only answer that is
 * "no" is a read already IN FLIGHT -- otherwise an 8 s poll would stack requests.
 *
 * It used to answer "no" for everything but `unrequested`, which froze the whole panel after
 * its first successful read: measured in the deployed add-on on 2026-10-04, a second comment,
 * its answer and a `revise_slide` all landed in Drive and none of them ever appeared.
 */
export function needsThread(conversation: Conversation): boolean {
  switch (conversation.thread.kind) {
    case "unrequested":
    case "failed":
      return true;
    case "loaded":
      if (conversation.rereadWanted.thread) return true;
      return isStale({ readAt: conversation.thread.readAt, nowMs: conversation.nowMs, freshMs: SCAN_FRESH_MS });
    case "loading":
      return false;
    default:
      return assertNever(conversation.thread);
  }
}

/**
 * HOW LONG A FINISHED READ COUNTS AS FRESH -- and the reason it is a DURATION and not simply
 * "loaded means read it again".
 *
 * `sidebar.tsx`'s `dispatch` calls `pump` after every state change, so a `needs*` that answered
 * "yes" the moment a read ARRIVED started the next one immediately: an unbounded chain of Drive
 * calls as fast as Apps Script would answer. Measured 2026-10-04 -- the new bundle was being
 * served and not one comment card rendered, because the reads that feed them never got through
 * the queue the log reads were saturating.
 *
 * Shorter than the 8 s poll, so every tick still re-reads and the conversation stays live; long
 * enough that the dozen dispatches between two ticks start nothing.
 */
export const READ_FRESH_MS = 5_000;

/**
 * THE SLOWER READS, and why they are slower.
 *
 * Apps Script serialises one user's `google.script.run` calls, and the SLIDES WINDOW shares that
 * queue. With all four reads on the 5 s cadence the window's own comment read waited behind them
 * and blew its 25 s client budget -- "open comments could not be read: sashaCandidateComments
 * did not answer within 25000 ms", on screen in its header (deployed add-on, 2026-10-04).
 *
 * The log is the conversation, so it stays on READ_FRESH_MS. The other two are not: a proposal
 * appearing in the inbox twenty seconds late is not a defect; a starved sibling window is.
 */
export const SCAN_FRESH_MS = 20_000;

/**
 * With NO clock yet, or an undateable read, the answer is STALE.
 *
 * A conversation that has not ticked cannot date its last read, and a panel that silently stops
 * reading is a worse failure than one that reads twice -- that is the bug this whole mechanism
 * exists to prevent, and the fallback must not reintroduce it.
 */
function isStale(options: Readonly<{ readAt: string; nowMs: number | null; freshMs: number }>): boolean {
  const { readAt, nowMs, freshMs } = options;
  if (nowMs === null) return true;
  const readAtMs = Date.parse(readAt);
  if (!Number.isFinite(readAtMs)) return true;
  return nowMs - readAtMs >= freshMs;
}

/** Same contract as `needsThread`, for the inbox scan. */
/**
 * WHETHER THE PANEL IS STILL OPENING -- before the first inbox scan has said anything.
 *
 * In that state there is nothing to report and nothing to offer, so the panel renders ONE
 * spinner. It used to announce that it was loading in three places at once ("loading" beside
 * the title, "checking your Drive..." in a panel, "checking which slides there are to report
 * on..." under a disabled button) around a paragraph explaining what would appear later. The
 * user called it confusing and unnecessary, and they were right: none of it was information.
 *
 * A FAILED first scan is NOT opening. It has an answer -- a bad one -- and this project's own
 * rule is that there is no spinner that cannot end, so the failure is said out loud instead.
 */
/**
 * What a scan still holds when another one starts: the previous result, through however many
 * refreshes. A failed scan keeps the last GOOD one too -- one bad round trip is not a reason to
 * blank a conversation that was fine a moment ago.
 */
export function stagedResultOf(staged: StagedLoad): Readonly<{ proposals: readonly StagedProposal[]; readAt: string }> | null {
  switch (staged.kind) {
    case "loaded":
      return { proposals: staged.proposals, readAt: staged.readAt };
    case "loading":
      return staged.had;
    case "unrequested":
    case "failed":
      return null;
    default:
      return assertNever(staged);
  }
}

export function conversationIsOpening(conversation: Conversation): boolean {
  switch (conversation.staged.kind) {
    case "unrequested":
      return true;
    // ONLY THE FIRST ONE. A scan that already has a previous result is a refresh, and a refresh
    // keeps the conversation on screen (see `StagedLoad`).
    case "loading":
      return conversation.staged.had === null;
    case "loaded":
    case "failed":
      return false;
    default:
      return assertNever(conversation.staged);
  }
}

export function needsStaged(conversation: Conversation): boolean {
  switch (conversation.staged.kind) {
    case "unrequested":
    case "failed":
      return true;
    case "loaded":
      return isStale({ readAt: conversation.staged.readAt, nowMs: conversation.nowMs, freshMs: SCAN_FRESH_MS });
    case "loading":
      return false;
    default:
      return assertNever(conversation.staged);
  }
}

/**
 * Whether the manifest wants reading. Not a plain once-per-request gate: it is re-read when the
 * LOG says the candidate set changed, which is the only signal the add-on is allowed to use (it
 * must never write `manifest.json`, so it must never treat `revision` as its own clock).
 */
export function needsManifest(conversation: Conversation): boolean {
  if (conversation.set.kind === "none") return false;
  const atEvent = newestSetChangeIn(loadedEvents(conversation.log));
  switch (conversation.set.manifest.kind) {
    case "unrequested":
      return true;
    case "loading":
      return false;
    case "loaded":
    case "failed":
      return conversation.set.manifest.forEventId !== atEvent;
    default:
      return assertNever(conversation.set.manifest);
  }
}

/** Same contract again, for the event log. False when there is no proposal folder to read. */
export function needsLog(conversation: Conversation): boolean {
  if (conversation.set.kind === "none") return false;
  switch (conversation.log.kind) {
    case "unrequested":
    case "failed":
      return true;
    case "loaded":
      return isStale({ readAt: conversation.log.readAt, nowMs: conversation.nowMs, freshMs: READ_FRESH_MS });
    case "loading":
      return false;
    default:
      return assertNever(conversation.log);
  }
}

/**
 * Same contract again, for the candidates' comments -- and it also needs the MANIFEST, because the
 * read is by candidate file id and the manifest is where those come from.
 */
export function needsComments(conversation: Conversation): boolean {
  if (slidesOf(conversation).length === 0) return false;
  if (!needsSlideComments(conversation.comments)) return false;
  // An action asked for one more read; `comments-requested` lowers the flag, so this is one read.
  if (conversation.rereadWanted.comments) return true;
  return commentsAreStale({ comments: conversation.comments, nowMs: conversation.nowMs });
}

/**
 * HOW LONG A COMMENTS READ STAYS FRESH. The log and the deck's threads are one Drive call each
 * and ride the poll's own 8 s cadence; this one is a call PER CANDIDATE, and Apps Script
 * serialises a single user's calls.
 *
 * Measured consequence of not having this: with the sidebar asking for four candidates every
 * 8 s, the slides window's own read queued behind it and died -- "sashaCandidateComments did
 * not answer within 25000 ms" (deployed add-on, 2026-10-04). Thirty seconds is slow enough to
 * leave the queue free and fast enough that a comment Sasha answered is on screen before the
 * user has finished reading the one above it.
 */
export const COMMENTS_FRESH_MS = 30_000;

/**
 * With NO clock the answer is "yes". A conversation that has not ticked yet cannot date its
 * last read, and a panel that silently stops reading is worse than one that reads twice.
 */
function commentsAreStale(
  options: Readonly<{ comments: SlideCommentsLoad; nowMs: number | null }>,
): boolean {
  const { comments, nowMs } = options;
  if (comments.kind !== "loaded") return true;
  return isStale({ readAt: comments.readAt, nowMs, freshMs: COMMENTS_FRESH_MS });
}

/**
 * THE NEXT REVISED SLIDE WHOSE HTML IS WANTED, or null. Only the slides a `slide-revised` event
 * points at are fetched: the conversation is a log, not a second grid, and fetching every
 * candidate into a 300 px column would be N round trips for pictures nobody asked for.
 *
 * A SECOND REVISION RE-FETCHES. `NN.html` is overwritten in place, so the file id is unchanged and
 * the bytes in hand are keyed on the revision event instead -- without that, the inline slide
 * would show the first revision for ever and the completion signal would be a lie.
 */
export function nextRevisedSlideToLoad(conversation: Conversation): ConversationSlide | null {
  for (const slide of slidesOf(conversation)) {
    const latest = latestRevisionIdFor({ conversation, slideIndex: slide.slideIndex });
    if (latest === null) continue;
    if (wantsFetch({ html: slide.html, fetchedFor: slide.fetchedFor, latest })) return slide;
  }
  return null;
}

/** Whether a send is in flight, so the composer can go read-only without re-deriving it. */
export function isSending(conversation: Conversation): boolean {
  switch (conversation.send.kind) {
    case "sending":
      return true;
    case "idle":
    case "sent":
    case "failed":
      return false;
    default:
      return assertNever(conversation.send);
  }
}

/**
 * The threads to render: whatever was last loaded, even while a re-read is in flight and even when
 * the most recent one failed. Only `unrequested` -- nothing has ever been read -- is empty.
 */
export function loadedThreads(thread: ThreadLoad): readonly FeedbackThread[] {
  switch (thread.kind) {
    case "loading":
    case "loaded":
    case "failed":
      return thread.threads;
    case "unrequested":
      return [];
    default:
      return assertNever(thread);
  }
}

/** Same rule as `loadedThreads`, for the event log. */
export function loadedEvents(log: SessionLogLoad): readonly SessionEvent[] {
  switch (log.kind) {
    case "loading":
    case "loaded":
    case "failed":
      return log.events;
    case "unrequested":
      return [];
    default:
      return assertNever(log);
  }
}

/**
 * The newest `slide-revised` event for a slide, by event id, or null when there is none. Read off
 * the ORDERED log, so "newest" is the log's own order and not a timestamp comparison that an event
 * with an unreadable name would lose.
 */
function latestRevisionIdFor({
  conversation,
  slideIndex,
}: {
  conversation: Conversation;
  slideIndex: number;
}): string | null {
  let latest: string | null = null;
  for (const event of loadedEvents(conversation.log)) {
    if (event.body.kind !== "slide-revised") continue;
    if (slideIndexOf(event.body) !== slideIndex) continue;
    latest = event.eventId;
  }
  return latest;
}

/**
 * Adopt or replace the followed set. A STRICTLY NEWER proposal replaces it (and resets the log,
 * the comments and the manifest, which are all about the old one); the same proposal, or an older
 * one still sitting in the inbox, changes nothing -- re-adopting would re-fetch the manifest on
 * every poll and throw away the HTML already loaded for an inline revision.
 */
function followOn({
  conversation,
  proposals,
}: {
  conversation: Conversation;
  proposals: readonly StagedProposal[];
}): Partial<Conversation> {
  const newest = proposals[proposals.length - 1];
  if (newest === undefined) return {};
  const current = conversation.set;
  if (current.kind === "following") {
    if (current.proposalId === newest.proposalId) return {};
    if (newest.createdTime <= current.createdTime) return {};
  }
  return {
    set: {
      kind: "following",
      proposalId: newest.proposalId,
      folderId: newest.folderId,
      readyFileId: newest.readyFileId,
      createdTime: newest.createdTime,
      manifest: { kind: "unrequested" },
      slides: [],
    },
    log: { kind: "unrequested" },
    comments: { kind: "unrequested" },
    // A NEW set's log and comments have not been read; the old set's reads say nothing about them.
    readOnce: { ...conversation.readOnce, log: false, comments: false },
  };
}

/** Change the followed set, or do nothing when none is followed. */
function withSet(
  conversation: Conversation,
  change: (set: Extract<FollowedSet, { kind: "following" }>) => FollowedSet,
): Conversation {
  switch (conversation.set.kind) {
    case "none":
      return conversation;
    case "following":
      return { ...conversation, set: change(conversation.set) };
    default:
      return assertNever(conversation.set);
  }
}

function mapSlide(
  conversation: Conversation,
  slideIndex: number,
  change: (slide: ConversationSlide) => ConversationSlide,
): Conversation {
  return withSet(conversation, (set) => ({
    ...set,
    slides: set.slides.map((slide) => (slide.slideIndex === slideIndex ? change(slide) : slide)),
  }));
}

/**
 * A manifest entry as a conversation slide, KEEPING the HTML already fetched for that index. A
 * revision bumps the manifest's `revision`, so this runs again after every revision -- and
 * dropping the bytes would make the inline slide flash back to "loading" each time.
 */
function slideOf({
  slide,
  slides,
}: {
  slide: SlideEntry;
  slides: readonly ConversationSlide[];
}): ConversationSlide {
  const known = slides.find((candidate) => candidate.slideIndex === slide.index);
  // A DIFFERENT file id means a different document, so the bytes are not the same slide's. The
  // SAME file id with new bytes (a revision in place) is handled by `fetchedFor`, not here.
  const kept = known !== undefined && known.fileId === slide.fileId;
  return {
    slideIndex: slide.index,
    fileId: slide.fileId,
    name: slide.name,
    label: slide.label,
    html: kept && known !== undefined ? known.html : { kind: "unrequested" },
    fetchedFor: kept && known !== undefined ? known.fetchedFor : null,
  };
}

/**
 * Whether a slide's bytes have to be fetched for the revision now on screen. An exhaustive switch
 * over the load union, so a new variant has to say whether it wants one.
 */
function wantsFetch({
  html,
  fetchedFor,
  latest,
}: {
  html: SlideHtmlLoad;
  fetchedFor: string | null;
  latest: string;
}): boolean {
  switch (html.kind) {
    case "unrequested":
      return true;
    case "loading":
      // Already on its way FOR this revision. A newer one restamps `fetchedFor`, so this becomes
      // true again on the next pump rather than two fetches racing for the same slide.
      return fetchedFor !== latest;
    case "loaded":
    case "failed":
      return fetchedFor !== latest;
    default:
      return assertNever(html);
  }
}

function unstagedReachability(staged: StagedLoad): SlidesReachability {
  // A refresh keeps the last answer: "unknown" for the length of every poll would make the
  // slides button flicker between states for the life of the session.
  if (stagedResultOf(staged) !== null) return { kind: "nothing-staged" };
  switch (staged.kind) {
    case "unrequested":
    case "loading":
      return { kind: "unknown" };
    case "failed":
      return { kind: "unreadable", message: staged.message };
    case "loaded":
      return { kind: "nothing-staged" };
    default:
      return assertNever(staged);
  }
}

/**
 * One reply as a post. Who wrote it, not where it sits: the user can reply in Drive's own pane,
 * and both halves post as the same Google account, so only the marker (`authoredByAgent`) can say.
 */
function postOfReply({ reply, fallbackAt }: { reply: FeedbackReply; fallbackAt: string }): ConversationPost {
  if (reply.authoredByAgent) {
    return { postId: reply.replyId, author: "Sasha", text: reply.text, at: reply.createdAt === "" ? fallbackAt : reply.createdAt, voice: "sasha" };
  }
  return { postId: reply.replyId, author: reply.author === "" ? "You" : reply.author, text: reply.text, at: reply.createdAt === "" ? fallbackAt : reply.createdAt, voice: "user" };
}

/** A thread as a log entry. Keyed by the ROOT's id: the thread is the unit, not the post. */
function threadEntryOf(thread: ConversationThread): ConversationEntry {
  return { kind: "thread", entryId: `thread_${thread.commentId}`, at: thread.root.at, voice: "user", thread };
}

function withThreadAction(conversation: Conversation, commentId: string, state: ThreadActionState): Conversation {
  return { ...conversation, threadActions: { ...conversation.threadActions, [commentId]: state } };
}

/** Which read a changed thread wants. Exhaustive, so a third transport must say which it is. */
function rereadAfter({
  wanted,
  source,
}: {
  wanted: Conversation["rereadWanted"];
  source: ThreadSource;
}): Conversation["rereadWanted"] {
  switch (source) {
    case "deck":
      return { ...wanted, thread: true };
    case "candidate":
      return { ...wanted, comments: true };
    default:
      return assertNever(source);
  }
}

/**
 * Where a CANDIDATE comment came from, in words.
 *
 * It names the slide, unlike the deck channel's "a box on a slide": the conversation covers
 * every candidate in the proposal at once, so a message that does not say which one leaves the
 * user to guess which of four slides to look at.
 */
function aboutCandidate({ slideIndex, region }: { slideIndex: number; region: Region | null }): string {
  return region === null ? `slide ${String(slideIndex)}` : `a box on slide ${String(slideIndex)}`;
}

/** Where a message came from, in words. A box drawn in the slides window keeps its region. */
function aboutOf(note: ReviewNote): string {
  if (note.pageObjectId === null) return "the deck";
  return note.region === null ? "a slide" : "a box on a slide";
}

function afterEdit(send: SendPhase): SendPhase {
  switch (send.kind) {
    case "sending":
      return send;
    case "idle":
    case "sent":
    case "failed":
      return { kind: "idle" };
    default:
      return assertNever(send);
  }
}

function millisOf(at: string): number {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** One entry with its sort key. A record, not a tuple, so the sort reads as what it compares. */
type Keyed = Readonly<{ at: number; position: number; entry: ConversationEntry }>;
