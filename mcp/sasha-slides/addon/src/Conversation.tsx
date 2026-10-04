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

import type { JSX, ReactNode } from "react";
import { PICKER_CSS } from "./picker-styles.ts";
import { CommentBody, CommentCard, CommentHead } from "./comment-card.tsx";
import { assertNever } from "./protocol.ts";
import { ScaledHtmlFrame } from "./scaled-frame.tsx";
import {
  conversationEntriesOf,
  followedSet,
  defectReportReadiness,
  deliveriesFor,
  isSending,
  loadedEvents,
  loadedThreads,
  revisedSlideFor,
  nothingListeningFor,
  sashaPresence,
  slidesReachability,
  waitingFor,
  type Conversation,
  type ConversationEntry,
  type ConversationMessage,
  type DefectReportReadiness,
  type OpenPhase,
  type RevisedSlideRender,
  type SendPhase,
  type SessionLogLoad,
  type SlidesReachability,
  type ThreadLoad,
} from "./conversation-state.ts";
import {
  describeSessionEvent,
  describeUnresolvedCount,
  slideIndexOf,
  unresolvedBadgeOf,
  unresolvedCountFor,
  type SessionEvent,
  type SessionEventVoice,
  type UnresolvedCount,
} from "./session-log.ts";
import {
  SASHA_PRECONDITION,
  describeSashaPresence,
  describeWaitState,
  describeWaiting,
  describeWaitingWhat,
  waitIsLive,
  waitStateOf,
  type Deliveries,
  type SashaPresence,
  type WaitState,
  type WaitingItem,
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
}>;

export function ConversationPanel({
  conversation,
  actions,
}: {
  conversation: Conversation;
  actions: ConversationActions;
}): JSX.Element {
  return (
    <ConversationShell>
      <section className="sasha-chat" role="region" aria-label="Ask Sasha">
        {conversation.trouble === null ? null : <p className="sasha-trouble">sasha-slides: {conversation.trouble}</p>}
        <ConversationHeader conversation={conversation} onRefresh={actions.refresh} />
        <SlidesButton
          reachability={slidesReachability(conversation)}
          open={conversation.open}
          onShow={actions.showSlides}
        />
        {/* ABOVE THE LOG. When nothing is listening, waiting longer cannot help and the only
            thing worth reading is what to do -- so it leads. It used to sit inside the pinned
            panel BELOW the log, the headline and the waiting list, which in a 300 px sidebar
            put it under the fold: the user saw "4 things waiting for Sasha -- nothing has read
            the oldest for 4 h 39 min" and reported no remedy on screen at all. */}
        <NothingListeningNote notice={nothingListeningFor(conversation)} />
        <LogBody conversation={conversation} />
        <WaitingPanel
          waiting={waitingFor(conversation)}
          presence={sashaPresence(conversation)}
          onShow={actions.showSlides}
          reachability={slidesReachability(conversation)}
        />
        <Composer conversation={conversation} actions={actions} />
        <ReportEntry
          readiness={defectReportReadiness(conversation)}
          report={conversation.report}
          onReport={actions.reportDefect}
        />
      </section>
    </ConversationShell>
  );
}

function ConversationHeader({
  conversation,
  onRefresh,
}: {
  conversation: Conversation;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <header className="sasha-header">
      <strong>Ask Sasha</strong>
      <span className="sasha-dim">{logCaption({ log: conversation.log, thread: conversation.thread })}</span>
      <button type="button" className="sasha-secondary sasha-small" onClick={onRefresh}>
        Refresh
      </button>
    </header>
  );
}

/**
 * "SEE THE SLIDES" -- the one cross-surface request, and the only way back to the candidates.
 *
 * The conversation cannot ask the slides window anything, so this goes through the server:
 * `sashaOpenPicker` is a `SlidesApp.getUi().showModelessDialog` call and no amount of client
 * JavaScript in this document can do it. The button is never hidden when the slides are out of
 * reach -- it says WHY, because a missing button and a broken one look identical.
 */
function SlidesButton({
  reachability,
  open,
  onShow,
}: {
  reachability: SlidesReachability;
  open: OpenPhase;
  onShow: () => void;
}): JSX.Element {
  return (
    <section className="sasha-staged" aria-label="the candidate slides">
      <strong>{reachabilityHeadline(reachability)}</strong>
      <span className="sasha-dim">{reachabilityCaption(reachability)}</span>
      <button
        type="button"
        className="sasha-primary"
        disabled={reachability.kind !== "reachable" || open.kind === "opening"}
        onClick={onShow}
      >
        {open.kind === "opening" ? "opening..." : "See the slides"}
      </button>
      <OpenStatus open={open} />
    </section>
  );
}

function reachabilityHeadline(reachability: SlidesReachability): string {
  switch (reachability.kind) {
    case "reachable":
      return "Candidate slides";
    case "cleared":
      return "Sasha discarded these slides";
    case "nothing-staged":
      return "No slides yet";
    case "unknown":
      return "Looking for slides";
    case "unreadable":
      return "The slides could not be found";
    default:
      return assertNever(reachability);
  }
}

function reachabilityCaption(reachability: SlidesReachability): string {
  switch (reachability.kind) {
    case "reachable":
      return (
        `They open in their own window, side by side, so you can compare them and mark up what is ` +
        `wrong. ${reachability.proposalId}`
      );
    case "cleared":
      // The log has the `slides-cleared` line; this says why the button is off, so a set vanishing
      // is never indistinguishable from a bug (PROTOCOL.md: "Never silently").
      return (
        `The candidates that were not inserted are gone -- the line is in the log above. Ask Sasha ` +
        `for another set. ${reachability.proposalId}`
      );
    case "nothing-staged":
      return "Ask Sasha for a slide below. They open by themselves when they arrive.";
    case "unknown":
      return "checking your Drive...";
    case "unreadable":
      return reachability.message;
    default:
      return assertNever(reachability);
  }
}

function OpenStatus({ open }: { open: OpenPhase }): JSX.Element | null {
  switch (open.kind) {
    case "idle":
    case "opening":
      return null;
    case "opened":
      return <span className="sasha-dim">The slides are open in their own window. This conversation stays here.</span>;
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
}): JSX.Element {
  switch (entry.kind) {
    case "event":
      return <EventRow event={entry.event} voice={entry.voice} conversation={conversation} />;
    case "message":
      return (
        <MessageRow
          message={entry.message}
          deliveries={deliveries}
          nowMs={conversation.nowMs}
          conversation={conversation}
        />
      );
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
  return (
    <li className={`sasha-msg sasha-msg-event ${voiceClass(voice)}`}>
      <span className="sasha-msg-who">{voiceLabel(voice)}</span>
      <p className="sasha-msg-text">{describeSessionEvent(event.body)}</p>
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

function MessageRow({
  message,
  deliveries,
  nowMs,
  conversation,
}: {
  message: ConversationMessage;
  deliveries: Deliveries;
  nowMs: number | null;
  conversation: Conversation;
}): JSX.Element {
  switch (message.kind) {
    case "from-user":
      return (
        <li className="sasha-msg">
          <CommentCard>
            <CommentHead
              author={message.author}
              at={message.at}
              nowMs={nowMs}
              where={message.about}
              actions={
                /* The same badge the log's events carry, and the same `unresolvedCountFor` the
                   grid reads, so the two surfaces cannot disagree about one slide. */
                message.slideIndex === null ? null : (
                  <UnresolvedBadge
                    count={unresolvedCountFor({
                      comments: conversation.comments,
                      proposalId: followedSet(conversation)?.proposalId ?? "",
                      slideIndex: message.slideIndex,
                    })}
                  />
                )
              }
            />
            <CommentBody text={message.text} />
            {/* NOT a flat "no answer yet", which implies one is coming -- and not a bare count-up
                either, which implies progress. The same three-state verdict the pinned panel
                reaches, from the same `waitStateOf`, so the two can never disagree about one
                comment. */}
            {message.answered ? null : (
              <span className="sasha-msg-where">
                {describeWaitState(
                  waitStateOf({ commentId: message.messageId, since: message.at, deliveries, nowMs }),
                )}
              </span>
            )}
          </CommentCard>
        </li>
      );
    case "from-sasha":
      return (
        <li className="sasha-msg">
          <CommentCard tone="agent">
            {/* ALWAYS "Sasha", never Drive's author. The connector posts as the user's own
                Google account, so the reply's `author` field is the user's name -- signing the
                agent's words with it is the one thing the card must not do. */}
            <CommentHead author="Sasha" at={message.at} nowMs={nowMs} />
            <CommentBody text={message.text} />
          </CommentCard>
        </li>
      );
    default:
      return assertNever(message);
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
function WaitingPanel({
  waiting,
  presence,
  reachability,
  onShow,
}: {
  waiting: readonly WaitingItem[];
  presence: SashaPresence;
  reachability: SlidesReachability;
  onShow: () => void;
}): JSX.Element | null {
  if (waiting.length === 0) return null;
  return (
    <section className="sasha-open-comments" aria-label="open comments">
      <strong className="sasha-waiting-head">
        {/* The live indicator, and it GOES OFF once `waitIsLive` says nothing read any of this. A
            CSS animation rather than a character that changes, because a spinner built out of
            re-renders stops the moment a poll stalls -- but an animation that keeps breathing over
            a comment nobody has read is the 1 h 47 min lie, so the state decides, not the clock. */}
        <span className={waitIsLive(waiting) ? "sasha-pulse" : "sasha-pulse sasha-pulse-off"} aria-hidden="true" />
        {describeWaiting(waiting)}
      </strong>
      <p className={presenceClass(presence)}>{describeSashaPresence(presence)}</p>
      <p className="sasha-dim sasha-precondition">{SASHA_PRECONDITION}</p>
      <ul className="sasha-open-list">
        {waiting.map((item) => (
          <WaitingRow item={item} key={item.waitId} />
        ))}
      </ul>
      <button
        type="button"
        className="sasha-secondary sasha-small"
        disabled={reachability.kind !== "reachable"}
        onClick={onShow}
      >
        See the slides
      </button>
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

function WaitingRow({ item }: { item: WaitingItem }): JSX.Element {
  return (
    <li className="sasha-open-row">
      <span className="sasha-open-slide">{describeWaitingWhat(item.what)}</span>
      <span className="sasha-open-text">{item.text}</span>
      {/* THE STATE, not the raw clock. "waiting 8 min" and "a Claude session read this 20 s ago"
          are different facts, and the row used to be able to say only the first. */}
      <span className={waitClockClass(item.state)}>{describeWaitState(item.state)}</span>
      {item.replies === 0 ? null : (
        <span className="sasha-msg-where">
          answered, not resolved -- {item.replies} repl{item.replies === 1 ? "y" : "ies"}
        </span>
      )}
      {item.latestReply === null ? null : <p className="sasha-msg-quote">{item.latestReply}</p>}
    </li>
  );
}

/**
 * How loudly one row's clock is drawn. Exhaustive, so a fourth wait state has to be given a weight
 * rather than inheriting the quiet one -- which is how an unheard comment would look normal again.
 */
function waitClockClass(state: WaitState): string {
  switch (state.kind) {
    case "delivered":
      return "sasha-wait-clock sasha-wait-delivered";
    case "waiting":
      return "sasha-wait-clock";
    case "nobody-listening":
      return "sasha-wait-clock sasha-wait-unheard";
    default:
      return assertNever(state);
  }
}

/**
 * How loudly the presence line is drawn. "Never acted" is the one the user has to read: it is the
 * case where the wait will not end on its own. Exhaustive, so a new arm has to be given a weight.
 */
function presenceClass(presence: SashaPresence): string {
  switch (presence.kind) {
    case "never-acted":
      return "sasha-trouble";
    case "acted":
    case "delivered":
    case "unknown":
      return "sasha-dim";
    default:
      return assertNever(presence);
  }
}

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
  return (
    <div className="sasha-composer">
      <textarea
        className="sasha-comment-text"
        rows={3}
        disabled={busy}
        placeholder="Ask Sasha for a slide, or tell Sasha what to change"
        value={conversation.draft}
        onChange={(event) => actions.typeMessage(event.target.value)}
      />
      <footer className="sasha-actions">
        <SendStatus send={conversation.send} />
        <button type="button" className="sasha-primary" disabled={busy || empty} onClick={actions.send}>
          Send
        </button>
      </footer>
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

/** Whose turn a row is, as a class. Exhaustive, so a new voice has to be given a style. */
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

function voiceLabel(voice: SessionEventVoice): string {
  switch (voice) {
    case "user":
      return "you";
    case "sasha":
      return "Sasha";
    case "deck":
      return "this deck";
    // Not "Sasha": a receipt proves a session READ this, which is a weaker and different claim
    // from Sasha having said anything.
    case "delivery":
      return "a Claude session";
    case "opaque":
      return "unreadable entry";
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

/** What the header says about the log. The LOG's state leads; the chat's is the fallback. */
function logCaption({ log, thread }: { log: SessionLogLoad; thread: ThreadLoad }): string {
  switch (log.kind) {
    case "unrequested":
      return threadCaption(thread);
    case "loading":
      return "refreshing";
    case "failed":
      return "the log could not be read";
    case "loaded": {
      const count = log.events.length;
      return count === 0 ? threadCaption(thread) : `${count} event${count === 1 ? "" : "s"}`;
    }
    default:
      return assertNever(log);
  }
}

function threadCaption(thread: ThreadLoad): string {
  switch (thread.kind) {
    case "unrequested":
      return "loading";
    case "loading":
      return "refreshing";
    case "failed":
      return "could not be read";
    case "loaded": {
      const count = loadedThreads(thread).length;
      return count === 0 ? "nothing sent yet" : `${count} message${count === 1 ? "" : "s"} sent`;
    }
    default:
      return assertNever(thread);
  }
}
