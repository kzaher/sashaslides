// THE CONVERSATION'S UI, and the only thing the Slides menu opens. Passive, like Picker.tsx: a
// function of `Conversation` plus the callbacks sidebar.tsx hands it, every conditional an
// exhaustive switch over a discriminated union, and no state of its own (not even the composer,
// which lives in `Conversation.draft` so a poll-driven re-render cannot swallow a half-typed
// message).
//
// IT IS AN EVENT LOG, NOT A CHAT WITH ARTIFACTS BOLTED ON. One ordered list -- slides staged, a
// comment you opened, Sasha's answer, a revised slide, a resolution, a clear, an insertion, and
// whatever you typed -- rendered in order, for ever (UI-CONTRACT.md). Four things in the order the
// user meets them:
//
//   1. the header, and "See the slides" -- the only way back to the candidates once the moment
//      they arrived has passed
//   2. the log
//   3. the open comments, PINNED, because they must not scroll away into history
//   4. the composer, Send, the defect-report entry, and whatever went wrong
//
// EVERY LOAD PATH HAS A VISIBLE FAILURE STATE. UI-CONTRACT.md: "Never render a spinner that cannot
// end." So `LogBody`, `SlidesButton`, `SendStatus` and every unresolved count render their union's
// failing arm with the message in it, and the panel-wide `trouble` is a banner above all of them.
//
// AN UNKNOWN EVENT KIND IS AN OPAQUE LINE, never a dropped one -- `EventRow`'s `opaque` arm, whose
// text comes from session-log.ts's `describeSessionEvent`. A reader on an older build must not
// silently show an incomplete history.

import { type JSX, type ReactNode } from "react";
import { ScaledHtmlFrame } from "./scaled-frame.tsx";
import { SlideThumb } from "./slide-thumb.tsx";
import {
  describeThreadSlide,
  previewOf,
  threadSlideContextOf,
  type SlidePreviews,
} from "./slide-previews.ts";

// NO AUTO-SCROLL HERE ANY MORE. The log sits inside a collapsed <details>, so there is no
// scroller to keep at the bottom; the comments panel above it is what the reader is following.
import { PICKER_CSS } from "./picker-styles.ts";
import {
  COMMENT_FILTERS,
  COMMENT_FILTER_LABEL,
  commentCounts,
  commentSections,
  describeNoComments,
  type CommentFilter,
  type PanelThread,
} from "./comment-panel.ts";
import {
  CommentBody,
  CommentCard,
  CommentHead,
  MoreMenu,
  ReplyPill,
  ResolveButton,
  ResolvedLabel,
  type AvatarTone,
  type MenuItem,
} from "./comment-card.tsx";
import { assertNever } from "./protocol.ts";
import {
  conversationEntriesOf,
  conversationIsOpening,
  followedSet,
  defectReportReadiness,
  deliveriesFor,
  isSending,
  isThreadBusy,
  loadedEvents,
  loadedThreads,
  nothingListeningFor,
  threadActionOf,
  threadFilesOf,
  type Conversation,
  type ConversationPost,
  revisedSlideFor,
  type ConversationEntry,
  type RevisedSlideRender,
  type SessionLogLoad,
  type ThreadLoad,
  type ConversationThread,
  type DefectReportReadiness,
  type OpenPhase,
  type SendPhase,
  type ThreadActionKind,
  type ThreadActionState,
} from "./conversation-state.ts";
import {
  describeUnresolvedCount,
  unresolvedBadgeOf,
  unresolvedCountFor,
  type UnresolvedCount,
  describeSessionEvent,
  slideIndexOf,
  type SessionEvent,
  type SessionEventVoice,
} from "./session-log.ts";
import {
  describeWaitState,
  waitStateOf,
  type Deliveries,
} from "./waiting.ts";
import type { NothingListeningNotice } from "../../feedback-delivery.ts";

/** Everything the conversation is allowed to cause. Injected, so the tree renders with no ports. */
export type ConversationActions = Readonly<{
  typeMessage(text: string): void;
  send(): void;
  refresh(): void;
  /**
   * Show the SLIDES window. It can be refused, and the refusal is rendered -- this button is the
   * only way back to the candidates after the moment they appeared, so it may never silently fail.
   */
  showSlides(): void;
  /**
   * ANONYMISE ONE SLIDE AND REPORT A CONVERTER DEFECT. Its own window: before and after, run by
   * run, side by side needs more than this 300 px column, and it is the heaviest code in the
   * product, so it is a third document rather than a mode of the slides window.
   */
  reportDefect(): void;
  /** What is in one thread's reply pill. Kept in the tree, so a poll cannot swallow it. */
  typeReply(options: Readonly<{ commentId: string; text: string }>): void;
  /** Post the pill's words as a reply on the thread's own Drive file. */
  reply(thread: ConversationThread): void;
  /** Resolve the thread on its own Drive file -- the blue tick, or "Resolve" in the menu. */
  resolve(thread: ConversationThread): void;
  /** Which comments the panel shows. In the tree, so a poll cannot reset it. */
  chooseCommentFilter(filter: CommentFilter): void;
  /**
   * OPEN THE SLIDES ON WHAT THIS COMMENT IS ABOUT. With a `slideIndex` the window comes up on
   * that candidate; without one it opens the whole set. The two documents share nothing, so the
   * target is recorded server-side and collected by the window.
   */
  openArtifact(target: Readonly<{ proposalId: string; slideIndex: number | null }>): void;
}>;

export function ConversationPanel({
  conversation,
  previews,
  actions,
}: {
  conversation: Conversation;
  /** The candidates' thumbnails (slide-previews.ts), held beside the conversation by sidebar.tsx. */
  previews: SlidePreviews;
  actions: ConversationActions;
}): JSX.Element {
  return (
    <ConversationShell>
      <section className="sasha-chat" role="region" aria-label="Ask Sasha">
        {conversation.trouble === null ? null : <p className="sasha-trouble">sasha-slides: {conversation.trouble}</p>}
        {/* STILL OPENING: one spinner, nothing else. Before the first scan lands there is
            nothing to report and nothing to offer, and saying "loading" three different ways
            around a paragraph about what will appear later is not information. */}
        {conversationIsOpening(conversation) ? (
          <p className="sasha-opening" role="status" aria-label="Opening Ask Sasha">
            <span className="sasha-opening-ring" aria-hidden="true" />
          </p>
        ) : (
          <ConversationBody conversation={conversation} previews={previews} actions={actions} />
        )}
      </section>
    </ConversationShell>
  );
}

/** The panel once it has something to say. Split out so the opening state is one clear branch. */
function ConversationBody({
  conversation,
  previews,
  actions,
}: {
  conversation: Conversation;
  previews: SlidePreviews;
  actions: ConversationActions;
}): JSX.Element {
  return (
    <>
        <ConversationHeader conversation={conversation} />
        {/* NOTHING ELSE ON TOP. The "Candidate slides" card that used to sit here -- a heading,
            three lines about the slides opening in their own window, the raw proposalId, a
            button and a status line -- added no information the log does not already carry, and
            it pushed the conversation itself below the fold on every load. */}
        <OpenStatus open={conversation.open} />
        {/* ABOVE THE LOG. When nothing is listening, waiting longer cannot help and the only
            thing worth reading is what to do -- so it leads. It used to sit inside the pinned
            panel BELOW the log, the headline and the waiting list, which in a 300 px sidebar
            put it under the fold: the user saw "4 things waiting for Sasha -- nothing has read
            the oldest for 4 h 39 min" and reported no remedy on screen at all. */}
        <NothingListeningNote notice={nothingListeningFor(conversation)} />
        {/*
          THE COMMENTS, AND ONLY THE COMMENTS.
          
          This panel used to be two things stacked: a chronological log of everything that had
          happened, and the comments underneath it. The log was the taller of the two and the
          reader had to scroll past all of it to reach the thing they came for. A comment pane
          shows comments; what HAPPENED is visible in the comments themselves, because Sasha
          answers inside the thread it is answering.
        */}
        <CommentPanel conversation={conversation} previews={previews} actions={actions} />
        {/*
          THE SESSION LOG, FOLDED AWAY.
          
          It is still the spine -- every event, in order, for ever (UI-CONTRACT.md) -- but it is
          no longer the first thing in a 300 px column. The panel used to be two stacked lists
          with the comments SECOND, so the reader scrolled past everything that had happened to
          reach the thing they came for. Closed by default, one line to open.
        */}
        <details className="sasha-activity">
          <summary className="sasha-activity-head">Activity</summary>
          <LogBody conversation={conversation} />
        </details>
        <Composer conversation={conversation} actions={actions} />
        <ReportEntry
          readiness={defectReportReadiness(conversation)}
          report={conversation.report}
          onReport={actions.reportDefect}
        />
    </>
  );
}


/**
 * WHETHER ANYTHING IS BEING READ RIGHT NOW. Four polls share one indicator, because the reader
 * does not care WHICH read is in flight -- only whether the panel is still catching up.
 */
function anythingInFlight(conversation: Conversation): boolean {
  return (
    conversation.log.kind === "loading" ||
    conversation.thread.kind === "loading" ||
    conversation.staged.kind === "loading" ||
    conversation.comments.kind === "loading"
  );
}

/**
 * THE TITLE, AND A SPINNER THAT CANNOT MOVE ANYTHING.
 *
 * It used to carry "See the slides" and "Refresh" too, and the spinner appearing between them
 * pushed Refresh onto a second row -- the header grew and shrank on every poll. Both buttons are
 * gone rather than rearranged:
 *
 *   REFRESH did by hand what the panel already does every few seconds on its own. A button whose
 *   only effect is "do the thing you were going to do anyway" is furniture.
 *   SEE THE SLIDES opened whichever set the window happened to be following, which is not a
 *   question the reader was asking. The candidates now have their own card, and every comment
 *   can open the slide it is about -- both of which name what they will show.
 *
 * The spinner is ABSOLUTE, so whether it is there or not cannot change the header's height.
 */
function ConversationHeader({ conversation }: { conversation: Conversation }): JSX.Element {
  return (
    <header className="sasha-header">
      <strong>Ask Sasha</strong>
      {anythingInFlight(conversation) ? <span className="sasha-header-spin" aria-label="working" /> : null}
    </header>
  );
}

/** Whether the slides window opened, or why it did not. Never silent: it is the only way back. */
function OpenStatus({ open }: { open: OpenPhase }): JSX.Element | null {
  switch (open.kind) {
    case "idle":
    case "opening":
      return null;
    case "opened":
      return <span className="sasha-dim">The slides are open in their own window.</span>;
    case "failed":
      return <span className="sasha-trouble">{open.message}</span>;
    default:
      return assertNever(open);
  }
}

/**
 * THE LOG. `loading` and `failed` both keep what they had, because it is polled every few seconds:
 * a variant that dropped the entries would blank the whole conversation on each tick, and one that
 * dropped them on failure would lose the session to a single bad poll.
 */
function LogBody({ conversation }: { conversation: Conversation }): JSX.Element {
  const entries = conversationEntriesOf({
    events: loadedEvents(conversation.log),
    threads: loadedThreads(conversation.thread),
    // The candidates' threads, which is where the user actually marks a slide up. Without this
    // the conversation rendered the deck's pane only, so a comment sent from the slides window
    // and Sasha's answer to it were both invisible here.
    comments: conversation.comments,
    files: threadFilesOf(conversation),
  });
  return (
    <>
      <LogTrouble log={conversation.log} thread={conversation.thread} />
      {/* Derived ONCE here and handed down, rather than rebuilt per row on every clock tick. */}
      <EntryList entries={entries} conversation={conversation} deliveries={deliveriesFor(conversation)} />
    </>
  );
}

function LogTrouble({ log, thread }: { log: SessionLogLoad; thread: ThreadLoad }): JSX.Element | null {
  const troubles = [log.kind === "failed" ? log.message : null, thread.kind === "failed" ? thread.message : null];
  const shown = troubles.flatMap((trouble) => (trouble === null ? [] : [trouble]));
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((trouble) => (
        <p className="sasha-trouble" key={trouble}>
          {trouble}
        </p>
      ))}
    </>
  );
}

function EntryList({
  entries,
  conversation,
  deliveries,
}: {
  entries: readonly ConversationEntry[];
  conversation: Conversation;
  deliveries: Deliveries;
}): JSX.Element {
  if (entries.length === 0) {
    return (
      <p className="sasha-dim">
        Nothing yet. Ask Sasha for a slide below. Everything that happens after that -- the slides
        being staged, a comment you open, Sasha&apos;s answer, a revised slide -- appears here in
        order and stays.
      </p>
    );
  }
  return (
    <ul className="sasha-msgs">
      {entries.map((entry) => (
        <EntryRow key={entry.entryId} entry={entry} conversation={conversation} deliveries={deliveries} />
      ))}
    </ul>
  );
}

function EntryRow({
  entry,
  conversation,
  deliveries,
}: {
  entry: ConversationEntry;
  conversation: Conversation;
  deliveries: Deliveries;
}): JSX.Element | null {
  void deliveries;
  switch (entry.kind) {
    case "event":
      return <EventRow event={entry.event} voice={entry.voice} conversation={conversation} />;
    case "thread":
      // A comment is in the comments panel, where it can be filtered and grouped. Rendering it
      // here as well put every comment on screen twice.
      return null;
    default:
      return assertNever(entry);
  }
}

/**
 * ONE EVENT. The body is never switched on for its TEXT -- `describeSessionEvent` owns that, and
 * its own exhaustive switch is what makes a new event kind a compile error there. What is decided
 * here is only what else goes on the row: the unresolved count for the slide it names, and, for a
 * `slide-revised`, THE SLIDE ITSELF, inline, at this point in the log.
 */
function EventRow({
  event,
  voice,
  conversation,
}: {
  event: SessionEvent;
  voice: SessionEventVoice;
  conversation: Conversation;
}): JSX.Element {
  const slideIndex = slideIndexOf(event.body);
  // A CARD, IN THE SAME LANGUAGE AS A COMMENT: avatar, name, time, then what happened. It used
  // to be an uppercase label over a line of text, which read as a log file beside Google's own
  // comment pane.
  return (
    <li className={`sasha-msg sasha-msg-event ${voiceClass(voice)}`}>
      <CommentCard tone={voice === "opaque" ? "opaque" : "event"}>
        <CommentHead author={voiceLabel(voice)} at={event.at} nowMs={conversation.nowMs} tone={avatarToneOf(voice)} />
        <CommentBody text={describeSessionEvent(event.body)} />
      {event.body.kind === "comment-opened" && event.body.text !== "" ? (
        <p className="sasha-msg-quote">{event.body.text}</p>
      ) : null}
      {event.body.kind === "comment-answered" && event.body.text !== "" ? (
        <p className="sasha-msg-quote">{event.body.text}</p>
      ) : null}
      {slideIndex === null ? null : (
        <UnresolvedBadge
          count={unresolvedCountFor({
            comments: conversation.comments,
            proposalId: event.proposalId,
            slideIndex,
          })}
        />
      )}
        <RevisedSlide render={revisedSlideFor({ conversation, event })} />
      </CommentCard>
    </li>
  );
}

/**
 * THE REVISED SLIDE, INLINE. UI-CONTRACT.md: "When Sasha resolves a comment and regenerates the
 * slide, the new slide is output directly in the conversation -- inline, at that point in the log.
 * That is the signal that the round trip completed." Not a spinner, not a toast.
 *
 * `superseded` is the honest answer for an earlier revision of the same slide: a revision
 * overwrites `NN.html` in place, so those bytes are gone and drawing the current slide under an old
 * event would claim a picture that never existed.
 */
function RevisedSlide({ render }: { render: RevisedSlideRender }): JSX.Element | null {
  switch (render.kind) {
    case "not-a-revision":
      return null;
    case "superseded":
      return <span className="sasha-msg-where">superseded by a later revision of this slide</span>;
    case "loading":
      return <span className="sasha-busy">loading the new slide {render.slideIndex}...</span>;
    case "unavailable":
      return <span className="sasha-trouble">the new slide cannot be shown here: {render.message}</span>;
    case "ready":
      return (
        <figure className="sasha-inline-slide">
          {/*
            `.sasha-stage` IS LOAD-BEARING, not decoration. `ScaledHtmlFrame` renders a
            `position:absolute; inset:0` box holding a 1280x720 iframe, so without a positioned,
            16:9-sized ancestor it resolves against the initial containing block -- i.e. it escapes
            to the top of the document, unscaled, and covers whatever is up there. Seen in the
            browser smoke screenshot: the slide landed at the top of the sidebar and wiped out the
            header.
          */}
          <span className="sasha-stage sasha-inline-stage">
            <ScaledHtmlFrame html={render.html} title={`slide ${render.slideIndex} after Sasha revised it`} />
          </span>
          <figcaption className="sasha-dim">
            slide {render.slideIndex} as it is now -- {render.label}
          </figcaption>
        </figure>
      );
    default:
      return assertNever(render);
  }
}

function ThreadRow({
  thread,
  deliveries,
  conversation,
  previews,
  actions,
}: {
  thread: ConversationThread;
  deliveries: Deliveries;
  conversation: Conversation;
  previews: SlidePreviews;
  actions: ConversationActions;
}): JSX.Element {
  const state = threadActionOf({ conversation, commentId: thread.commentId });
  const busy = isThreadBusy(state);
  const answerable = thread.fileId !== null && !busy;
  const nowMs = conversation.nowMs;
  const resolve = (): void => actions.resolve(thread);
  const rootMenu: readonly MenuItem[] =
    thread.resolved || !answerable
      ? [{ kind: "copy", text: thread.root.text }]
      : [{ kind: "copy", text: thread.root.text }, { kind: "resolve", onResolve: resolve }];
  return (
    <li className="sasha-msg sasha-msg-thread">
      <CommentCard tone="thread" resolved={thread.resolved}>
        <CommentHead
          author={thread.root.author}
          at={thread.root.at}
          nowMs={nowMs}
          where={thread.about}
          tone={avatarToneOfPost(thread.root)}
          actions={
            <>
              {thread.resolved ? <ResolvedLabel /> : <ResolveButton disabled={!answerable} onResolve={resolve} />}
              <MoreMenu items={rootMenu} />
            </>
          }
        />
        <CommentBody text={thread.root.text} />
        {/* The same badge the log's events carry, and the same `unresolvedCountFor` the grid
            reads, so the two surfaces cannot disagree about one slide. */}
        {thread.slideIndex === null ? null : (
          <UnresolvedBadge
            count={unresolvedCountFor({
              comments: conversation.comments,
              proposalId: followedSet(conversation)?.proposalId ?? "",
              slideIndex: thread.slideIndex,
            })}
          />
        )}
        {/* NOT a flat "no answer yet", which implies one is coming -- and not a bare count-up
            either, which implies progress. The same three-state verdict the pinned panel
            reaches, from the same `waitStateOf`, so the two can never disagree about one
            comment. */}
        {thread.replies.length > 0 || thread.resolved ? null : (
          <span className="sasha-msg-where">
            {describeWaitState(
              waitStateOf({ commentId: thread.commentId, since: thread.root.at, deliveries, nowMs }),
            )}
          </span>
        )}
        <ThreadReplies thread={thread} nowMs={nowMs} />
        {thread.resolved ? null : (
          <ReplyPill
            value={state.draft}
            disabled={!answerable}
            onType={(text) => actions.typeReply({ commentId: thread.commentId, text })}
            onSubmit={() => actions.reply(thread)}
          />
        )}
        <ThreadActionStatus state={state} fileKnown={thread.fileId !== null} resolved={thread.resolved} />
        {/*
          THE TWO THINGS A THREAD ENDS WITH, as words rather than icons.
          
          The blue tick at the top right is Google's convention and it stays, but it is a 22 px
          target in the corner of a card and nobody finds it -- the user asked where "mark as
          done" was while looking straight at it. And a comment about a slide should be able to
          OPEN that slide from the bottom of the thread, which is where the reader is once they
          have read it.
        */}
        {/* WHICH SLIDE, AND WHICH VERSION OF IT. The comment's words alone ("the middle row is
            1px thicker") do not say which of the candidates they are about; the picture and
            the number do. Only on OPEN threads: a done one is history and its iframe is cost. */}
        {thread.resolved ? null : (
          <ThreadSlideContext thread={thread} conversation={conversation} previews={previews} actions={actions} />
        )}
        <div className="sasha-c-foot">
          {thread.slideIndex !== null && followedSet(conversation) !== null ? (
            <button
              type="button"
              className="sasha-c-open"
              onClick={() =>
                actions.openArtifact({
                  proposalId: followedSet(conversation)?.proposalId ?? "",
                  slideIndex: thread.slideIndex,
                })
              }
            >
              Open slide {thread.slideIndex}
            </button>
          ) : null}
          {thread.resolved ? (
            <span className="sasha-c-done mono">Done</span>
          ) : (
            <button type="button" className="sasha-c-markdone" disabled={!answerable} onClick={resolve}>
              Mark as done
            </button>
          )}
        </div>
      </CommentCard>
    </li>
  );
}

/**
 * THE CANDIDATE A THREAD IS ABOUT: its thumbnail, its number and its revision. The thumbnail is a
 * button too, because a picture of a slide is the first thing anyone clicks to see it bigger.
 */
function ThreadSlideContext({
  thread,
  conversation,
  previews,
  actions,
}: {
  thread: ConversationThread;
  conversation: Conversation;
  previews: SlidePreviews;
  actions: ConversationActions;
}): JSX.Element | null {
  const context = threadSlideContextOf({ conversation, thread });
  switch (context.kind) {
    case "deck":
      return null;
    case "candidate": {
      const followed = followedSet(conversation);
      const label = describeThreadSlide(context);
      return (
        <div className="sasha-c-context">
          <button
            type="button"
            className="sasha-c-thumb"
            aria-label={`Open slide ${context.slideIndex}`}
            disabled={followed === null}
            onClick={() => {
              if (followed === null) return;
              actions.openArtifact({ proposalId: followed.proposalId, slideIndex: context.slideIndex });
            }}
          >
            <SlideThumb
              preview={previewOf({ conversation, previews, slideIndex: context.slideIndex })}
              title={`candidate ${context.slideIndex}`}
            />
          </button>
          <span className="sasha-c-context-label">{label}</span>
        </div>
      );
    }
    default:
      return assertNever(context);
  }
}

/**
 * The replies, nested. A resolved thread is COLLAPSED to a count, the way Google hides a
 * discussion once it is marked resolved -- the words are still one click away in Drive's pane.
 */
function ThreadReplies({ thread, nowMs }: { thread: ConversationThread; nowMs: number | null }): JSX.Element | null {
  if (thread.replies.length === 0) return null;
  if (thread.resolved) {
    const count = thread.replies.length;
    return <span className="sasha-c-collapsed">{`${count} repl${count === 1 ? "y" : "ies"} hidden`}</span>;
  }
  return (
    <>
      {thread.replies.map((reply) => (
        <div className="sasha-c-reply" key={reply.postId}>
          <CommentHead
            author={reply.author}
            at={reply.at}
            nowMs={nowMs}
            tone={avatarToneOfPost(reply)}
            actions={<MoreMenu items={[{ kind: "copy", text: reply.text }]} />}
          />
          <CommentBody text={reply.text} reply />
        </div>
      ))}
    </>
  );
}

/**
 * What the thread's last reply or resolve did. A failure is a VISIBLE line on the card it failed
 * on, never silent; and a card that cannot act says why, rather than a pill that does nothing.
 */
function ThreadActionStatus({
  state,
  fileKnown,
  resolved,
}: {
  state: ThreadActionState;
  fileKnown: boolean;
  resolved: boolean;
}): JSX.Element | null {
  switch (state.phase.kind) {
    case "idle":
      if (fileKnown || resolved) return null;
      return (
        <span className="sasha-dim">
          This comment cannot be answered from here until the candidates have been read.
        </span>
      );
    case "sending":
      return <span className="sasha-busy">{sendingLabelOf(state.phase.action)}</span>;
    case "done":
      return <span className="sasha-dim">{doneLabelOf(state.phase.action)}</span>;
    case "failed":
      return <span className="sasha-trouble">{`${failedLabelOf(state.phase.action)}: ${state.phase.message}`}</span>;
    default:
      return assertNever(state.phase);
  }
}

function sendingLabelOf(action: ThreadActionKind): string {
  switch (action) {
    case "reply":
      return "posting your reply...";
    case "resolve":
      return "resolving...";
    default:
      return assertNever(action);
  }
}

function doneLabelOf(action: ThreadActionKind): string {
  switch (action) {
    case "reply":
      return "Reply posted.";
    case "resolve":
      return "Marked as resolved.";
    default:
      return assertNever(action);
  }
}

function failedLabelOf(action: ThreadActionKind): string {
  switch (action) {
    case "reply":
      return "the reply was not posted";
    case "resolve":
      return "the thread was not resolved";
    default:
      return assertNever(action);
  }
}

/** A post's avatar colour. Exhaustive, so a third author kind has to be given one. */
function avatarToneOfPost(post: ConversationPost): AvatarTone {
  switch (post.voice) {
    case "user":
      return "user";
    case "sasha":
      return "agent";
    default:
      return assertNever(post.voice);
  }
}

/**
 * WHAT IS WAITING FOR SASHA -- PINNED, LIVE, AND HONEST ABOUT WHAT IT DOES NOT KNOW.
 *
 * UI-CONTRACT.md asks for two things at once here. "Open comments stay listed until resolved. They
 * do not scroll away into history" -- so this section is pinned below the log, which scrolls. And
 * "Waiting for Sasha must be honest ... it must distinguish waiting from nobody is listening".
 *
 * WHAT WAS WRONG. Each row said a flat "no answer yet", which implies one is coming. For a user
 * with no Claude session attached, no answer is EVER coming: Sasha replies only while a session has
 * the connector attached and is polling. So every row now carries the elapsed time, the panel
 * carries the last moment Sasha provably did anything, and `SASHA_PRECONDITION` states the
 * condition in full. Nothing here claims an answer is on its way, because nothing here can know it.
 *
 * It reads the SAME sources the per-slide badges do (waiting.ts over `thread` and `comments`), so
 * the pinned list and the counts cannot disagree about which threads are open.
 */

/**
 * THE COMMENTS, THE WAY A DOCUMENT'S SIDE PANEL SHOWS THEM.
 *
 * Open ones by default, with a filter for what has been dealt with. It replaces a yellow panel
 * that summarised the same comments in prose above them and led with how long they had been
 * waiting -- a sentence the reader could not act on, over the comments they could.
 *
 * DONE IS THE USER'S WORD. Sasha answering a comment does not close it; only the tick does, and
 * only the user presses it. That is why "addressed" and "done" are two different things here
 * (comment-panel.ts) and why the open list is split rather than sorted: a comment Sasha has
 * answered is the one worth re-reading, so it leads.
 */
function CommentPanel({
  conversation,
  previews,
  actions,
}: {
  conversation: Conversation;
  previews: SlidePreviews;
  actions: ConversationActions;
}): JSX.Element | null {
  const threads = loadedThreads(conversation.thread);
  const entries = conversationEntriesOf({
    events: loadedEvents(conversation.log),
    threads,
    comments: conversation.comments,
    files: threadFilesOf(conversation),
  });
  /*
   * `at` COMES FROM THE ROOT POST. A `ConversationThread` has no timestamp of its own -- the
   * thread's time IS when it was opened, which is its root. Spreading rather than projecting so
   * the row below still receives the whole thread.
   */
  const all: readonly PanelThread<ConversationThread & { at: string }>[] = entries.flatMap((entry) =>
    entry.kind === "thread"
      ? [{ slideIndex: entry.thread.slideIndex, thread: { ...entry.thread, at: entry.thread.root.at } }]
      : [],
  );
  if (all.length === 0) return null;

  const set = conversation.set;
  const followed = set.kind === "following" ? set : null;
  const manifest = followed !== null && followed.manifest.kind === "loaded" ? followed.manifest : null;
  const counts = commentCounts(all);
  const sections = commentSections({ threads: all, filter: conversation.commentFilter });
  const deliveries = deliveriesFor(conversation);
  return (
    <section className="sasha-comments" aria-label="Comments">
      {/* STICKY, BOTH OF THEM. The set and the filter are the controls for everything below
          them, so scrolling a long thread must not take them off screen. */}
      {/* THE SET ITSELF, above its comments. A thread is about one slide; the candidates are a
          GROUP, and until now nothing on this surface stood for the group -- so there was no
          way to say "show me all of them" without hunting for the header button. The slides are
          stacked vertically because that is what they are: a pile of candidates, in order. */}
      {followed !== null && manifest !== null ? (
        <div className="sasha-artifact">
          <p className="sasha-artifact-head mono">
            {manifest.count} candidate{manifest.count === 1 ? "" : "s"}
          </p>
          <ol className="sasha-stack" aria-label="the candidates in this set">
            {followed.slides.map((slide) => (
              <li className="sasha-stack-slide" key={slide.slideIndex}>
                <span className="sasha-stack-number mono">{slide.slideIndex}</span>
                <SlideThumb
                  preview={previewOf({ conversation, previews, slideIndex: slide.slideIndex })}
                  title={`candidate ${slide.slideIndex}`}
                />
                <span className="sasha-stack-label">{slide.label === "" ? slide.name : slide.label}</span>
                <button
                  type="button"
                  className="sasha-secondary sasha-small"
                  onClick={() =>
                    actions.openArtifact({ proposalId: followed.proposalId, slideIndex: slide.slideIndex })
                  }
                >
                  Open
                </button>
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="sasha-primary sasha-small"
            onClick={() => actions.openArtifact({ proposalId: followed.proposalId, slideIndex: null })}
          >
            Open artifacts
          </button>
        </div>
      ) : null}
      <div className="sasha-filter" role="group" aria-label="Show">
        {COMMENT_FILTERS.map((filter) => (
          <button
            key={filter}
            type="button"
            className={filter === conversation.commentFilter ? "sasha-tab sasha-tab-on" : "sasha-tab"}
            aria-pressed={filter === conversation.commentFilter}
            onClick={() => actions.chooseCommentFilter(filter)}
          >
            {COMMENT_FILTER_LABEL[filter]}
            <span className="sasha-filter-count">{counts[filter]}</span>
          </button>
        ))}
      </div>
      {sections.length === 0 ? (
        <p className="sasha-dim">{describeNoComments(conversation.commentFilter)}</p>
      ) : null}
      {sections.map((section) => (
        <div className="sasha-comment-section" key={section.kind}>
          <p className="sasha-section-head mono">
            {section.title}
            <span className="sasha-filter-count">{section.threads.length}</span>
          </p>
          <ul className="sasha-section-list">
            {section.threads.map(({ thread }) => (
              <li key={thread.commentId}>
                <ThreadRow
                  thread={thread}
                  deliveries={deliveries}
                  conversation={conversation}
                  previews={previews}
                  actions={actions}
                />
                {/* The way into the slide is at the END of the thread now (ThreadRow's foot),
                    which is where the reader is once they have read it. */}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}


/**
 * WHAT TO DO WHEN NOTHING IS LISTENING -- the one place in this product that tells the user to go
 * and start something, because it is the one situation where waiting longer cannot help.
 *
 * The two commands are `<code>` blocks and nothing else, so they can be selected and copied
 * verbatim; the sidebar has no clipboard permission, so "copyable" means "not wrapped in prose".
 * The wording and the threshold come from `feedback-delivery.ts`, shared with the server.
 */
function NothingListeningNote({ notice }: { notice: NothingListeningNotice | null }): JSX.Element | null {
  if (notice === null) return null;
  return (
    <div className="sasha-nobody-listening">
      <p className="sasha-nobody-head">{notice.headline}</p>
      <code className="sasha-copyable">{notice.prompt}</code>
      <p className="sasha-dim">{notice.connectHeadline}</p>
      <code className="sasha-copyable">{notice.connect}</code>
    </div>
  );
}


/**
 * How loudly one row's clock is drawn. Exhaustive, so a fourth wait state has to be given a weight
 * rather than inheriting the quiet one -- which is how an unheard comment would look normal again.
 */

/**
 * How loudly the presence line is drawn. "Never acted" is the one the user has to read: it is the
 * case where the wait will not end on its own. Exhaustive, so a new arm has to be given a weight.
 */

/**
 * THE UNRESOLVED COUNT, beside the slide's events -- the same number the grid cell shows, from the
 * same `unresolvedCountFor`. There is no arm that renders a zero for an answer that is not known:
 * `UnresolvedCount` has no zero for those cases, which is the point of its being a union.
 */
function UnresolvedBadge({ count }: { count: UnresolvedCount }): JSX.Element | null {
  const badge = unresolvedBadgeOf(count);
  if (badge === null) return null;
  return (
    <span className={`sasha-unresolved sasha-unresolved-${count.kind}`} title={describeUnresolvedCount(count)}>
      <span className="sasha-unresolved-mark">{badge}</span>
      <span className="sasha-dim">{describeUnresolvedCount(count)}</span>
    </span>
  );
}

function Composer({
  conversation,
  actions,
}: {
  conversation: Conversation;
  actions: ConversationActions;
}): JSX.Element {
  const busy = isSending(conversation);
  const empty = conversation.draft.trim() === "";
  /*
   * IT IS A NEW COMMENT, so it is drawn as one.
   *
   * It used to be a bare textarea with a grey sentence and a blue Send under it -- the only
   * thing on this surface that did not look like Google's own comment box, sitting directly
   * under a column of cards that did. Same card, same avatar, same Cancel / confirm pair; only
   * the words differ, because this one goes to Sasha rather than onto a slide.
   */
  // ITS OWN NAME. `.sasha-c-pill` is every thread's reply box as well, so the composer needs a
  // handle of its own -- without one, "the first pill on the page" is a thread's, not this.
  return (
    <div className="sasha-ask">
    <CommentCard tone="plain">
      <CommentHead author="You" at={null} nowMs={conversation.nowMs} tone="user" />
      <textarea
        className="sasha-c-pill"
        rows={2}
        disabled={busy}
        placeholder="Ask Sasha for a slide, or what to change"
        value={conversation.draft}
        onChange={(event) => actions.typeMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          if (!busy && !empty) actions.send();
        }}
      />
      <div className="sasha-c-acts">
        <SendStatus send={conversation.send} />
        {/* CANCEL ONLY WHEN THERE IS SOMETHING TO CANCEL. An always-present Cancel beside an
            empty box offers to undo nothing. */}
        {empty ? null : (
          <button type="button" className="sasha-c-cancel" disabled={busy} onClick={() => actions.typeMessage("")}>
            Cancel
          </button>
        )}
        <button type="button" className="sasha-c-send" disabled={busy || empty} onClick={actions.send}>
          Send
        </button>
      </div>
    </CommentCard>
    </div>
  );
}

function SendStatus({ send }: { send: SendPhase }): JSX.Element {
  switch (send.kind) {
    case "idle":
      return <span className="sasha-dim">Sasha answers in this log</span>;
    case "sending":
      return <span className="sasha-busy">posting your message...</span>;
    case "sent":
      // NOT "Sasha's answer appears above": an answer only arrives if a session is attached, and
      // this document cannot see whether one is. What it CAN promise is that the message landed.
      return <span className="sasha-dim">Sent. It is listed as waiting above, with how long for.</span>;
    case "failed":
      return <span className="sasha-trouble">{send.message}</span>;
    default:
      return assertNever(send);
  }
}

/**
 * "REPORT A DEFECT". It opens a window of its own -- the heaviest code in the product (the
 * anonymiser) lives there, and keeping it out of the slides window is what brings that bundle back
 * under the size HtmlService will relay intact.
 *
 * It says what it needs rather than failing silently: the report carries one slide's HTML through
 * the anonymiser, so it needs one of Sasha's staged candidates to report on.
 */
function ReportEntry({
  readiness,
  report,
  onReport,
}: {
  readiness: DefectReportReadiness;
  report: OpenPhase;
  onReport: () => void;
}): JSX.Element {
  return (
    <section className="sasha-reportentry" aria-label="report a defect">
      <button
        type="button"
        className="sasha-secondary sasha-small"
        disabled={readiness.kind !== "ready" || report.kind === "opening"}
        onClick={onReport}
      >
        {report.kind === "opening" ? "opening..." : "Report a defect"}
      </button>
      <span className="sasha-dim">{readinessCaption(readiness)}</span>
      <OpenStatus open={report} />
    </section>
  );
}

function readinessCaption(readiness: DefectReportReadiness): string {
  switch (readiness.kind) {
    case "ready":
      return (
        "Something Sasha drew came out wrong? This opens the editor on two slides -- that one as it " +
        "is, and as it would be sent -- and sends only what you approve."
      );
    case "unknown":
      return "checking which slides there are to report on...";
    case "nothing-staged":
      return (
        "A defect report is about one of Sasha's candidate slides, and none are staged right now. " +
        "Ask for a slide first."
      );
    case "unreadable":
      return `could not check which slides there are to report on: ${readiness.message}`;
    default:
      return assertNever(readiness);
  }
}

/** The SIDEBAR's shell -- the narrow one. The wider surfaces add `sasha-shell-wide`. */
/** Whose turn a row is, as a class. Exhaustive, so a new voice has to be given a style. */
/** Whose avatar an event's card wears. Sasha never shares the user's colour. */
function avatarToneOf(voice: SessionEventVoice): AvatarTone {
  switch (voice) {
    case "sasha":
      return "agent";
    case "deck":
      return "deck";
    case "delivery":
      return "delivery";
    default:
      return "opaque";
  }
}

function voiceClass(voice: SessionEventVoice): string {
  switch (voice) {
    case "user":
      return "sasha-msg-user";
    case "sasha":
      return "sasha-msg-sasha";
    case "deck":
      return "sasha-msg-deck";
    case "delivery":
      return "sasha-msg-delivery";
    case "opaque":
      return "sasha-msg-opaque";
    default:
      return assertNever(voice);
  }
}

/**
 * WHO A CARD IS SIGNED. These are NAMES on a card now, not fragments of a sentence in a log
 * line, so they are capitalised the way a person's name is.
 */
function voiceLabel(voice: SessionEventVoice): string {
  switch (voice) {
    case "user":
      return "You";
    case "sasha":
      return "Sasha";
    case "deck":
      return "This deck";
    // Not "Sasha": a receipt proves a session READ this, which is a weaker and different claim
    // from Sasha having said anything.
    case "delivery":
      return "a Claude session";
    case "opaque":
      return "Unreadable entry";
    default:
      return assertNever(voice);
  }
}

/** The SIDEBAR's shell -- the narrow one. The wider surfaces add `sasha-shell-wide`. */
function ConversationShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <>
      <style>{PICKER_CSS}</style>
      <div className="sasha-shell">{children}</div>
    </>
  );
}
