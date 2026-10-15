// ASK SASHA'S UI: the connection with the assistant, and the assets it staged. Passive, like
// Picker.tsx: a function of `Conversation` plus the callbacks sidebar.tsx hands it, every
// conditional an exhaustive switch over a discriminated union, and no state of its own.
//
// WHAT IS NOT HERE ANY MORE, and why. This panel used to be a conversation: a comments panel with
// filters and reply pills, an "Activity" log, a "You" composer with Send, and a "Report a defect"
// entry. Conversation now happens in the deck's own Google Slides comments, which the comment bot
// answers, so the side panel carries only what a comment cannot:
//
//   1. the header
//   2. THE CONNECTION -- one status line while an assistant is listening, and the setup guide
//      (setup-guide.tsx, with its animated walkthrough) when nothing is; under it, only when Sasha
//      cannot yet answer this deck's comments with the user's own Google grant, one small card
//      that says so and, when one click can fix it, offers "Allow" (comment-access-state.ts)
//   3. THE ASSETS -- the staged candidates with Working / Archived, Open, Archive and
//      "Open artifacts", which is the way back to the slides window
//
// The defect report is still one click away: from the slides window, which is where the slide it
// reports on is shown.
//
// EVERY LOAD PATH HAS A VISIBLE FAILURE STATE. UI-CONTRACT.md: "Never render a spinner that cannot
// end." A failed scan, manifest or open says so in words; the panel-wide `trouble` is a banner.

import { type JSX, type ReactNode } from "react";
import { SlideThumb } from "./slide-thumb.tsx";
import { previewOf, type SlidePreviews } from "./slide-previews.ts";
import { SASHA_ICON_SVG } from "../../http/sasha-icon.generated.ts";
import { PICKER_CSS } from "./picker-styles.ts";
import { TIDEPOOL_CSS } from "./tidepool-styles.ts";
import { SetupGuide, type SetupEnvironment } from "./setup-guide.tsx";
import { assertNever } from "./protocol.ts";
import {
  CANDIDATE_TABS,
  CANDIDATE_TAB_LABEL,
  type CandidateLists,
  type CandidateTab,
} from "./candidate-archive.ts";
import {
  assistantConnectionOf,
  candidateListsOf,
  conversationIsOpening,
  seedIsRefreshing,
  type AssistantConnection,
  type Conversation,
  type ConversationSlide,
  type OpenPhase,
} from "./conversation-state.ts";
import { describeElapsed } from "./waiting.ts";
import type { CommentAccessCard } from "./comment-access-state.ts";

/** Everything the panel is allowed to cause. Injected, so the tree renders with no ports. */
export type ConversationActions = Readonly<{
  /**
   * OPEN THE SLIDES WINDOW. With a `slideIndex` the window comes up on that candidate; without one
   * it opens the whole set. The two documents share nothing, so the target is recorded
   * server-side and collected by the window.
   */
  openArtifact(target: Readonly<{ proposalId: string; slideIndex: number | null }>): void;
  /**
   * ARCHIVE OR RESTORE ONE CANDIDATE. Takes effect on the click and is then recorded in the
   * proposal's session log, so it survives a reopen and Sasha can read it; a failed write undoes it.
   */
  setCandidateArchived(target: Readonly<{ proposalId: string; slideIndex: number; archived: boolean }>): void;
  /** Which of the set card's lists is shown. In the tree, so a poll cannot reset it. */
  chooseCandidateTab(tab: CandidateTab): void;
  /**
   * THE ALLOW LINK WAS OPENED (in a new tab: the link itself navigates). Recorded so the user's
   * return to the deck re-checks once and the card goes away when it worked.
   */
  allowCommentAccessOpened(): void;
}>;

export function ConversationPanel({
  conversation,
  previews,
  commentAccess,
  setup,
  actions,
}: {
  conversation: Conversation;
  /** The candidates' thumbnails (slide-previews.ts), held beside the state by sidebar.tsx. */
  previews: SlidePreviews;
  /** The "Let Sasha answer comments" card (comment-access-state.ts), or null for none. */
  commentAccess: CommentAccessCard | null;
  /** Build-time connection facts and the viewer's remembered tab, for the setup guide. */
  setup: SetupEnvironment;
  actions: ConversationActions;
}): JSX.Element {
  return (
    <ConversationShell>
      <section className="sasha-chat" role="region" aria-label="Ask Sasha">
        {conversation.trouble === null ? null : <p className="sasha-trouble">sasha-slides: {conversation.trouble}</p>}
        {/* STILL OPENING: one spinner, nothing else. Before the first scan lands there is
            nothing to report and nothing to offer. */}
        {conversationIsOpening(conversation) ? (
          <p className="sasha-opening" role="status" aria-label="Opening Ask Sasha">
            <span className="sasha-opening-ring" aria-hidden="true" />
          </p>
        ) : (
          <ConversationBody conversation={conversation} previews={previews} commentAccess={commentAccess} setup={setup} actions={actions} />
        )}
      </section>
    </ConversationShell>
  );
}

/** The panel once it has something to say. Split out so the opening state is one clear branch. */
function ConversationBody({
  conversation,
  previews,
  commentAccess,
  setup,
  actions,
}: {
  conversation: Conversation;
  previews: SlidePreviews;
  commentAccess: CommentAccessCard | null;
  setup: SetupEnvironment;
  actions: ConversationActions;
}): JSX.Element {
  const connection = assistantConnectionOf(conversation);
  return (
    <>
      <ConversationHeader conversation={conversation} connection={connection} />
      <ConnectionStatus connection={connection} setup={setup} />
      {commentAccess === null ? null : <CommentAccessNotice card={commentAccess} onAllowOpened={actions.allowCommentAccessOpened} />}
      <OpenStatus open={conversation.open} />
      <Assets conversation={conversation} previews={previews} actions={actions} />
    </>
  );
}

/**
 * THE TITLE, AND A SPINNER THAT CANNOT MOVE ANYTHING. Absolute, so whether it is there or not
 * cannot change the header's height.
 *
 * NOT WHILE NOTHING IS LISTENING: the poll is always in flight somewhere, and a spinner beside the
 * setup guide reads as "Sasha is working" when nothing is attached (waiting.ts).
 */
function ConversationHeader({
  conversation,
  connection,
}: {
  conversation: Conversation;
  connection: AssistantConnection;
}): JSX.Element {
  // LAST KNOWN, SAID AS SUCH. While anything on screen is still the boot seed's (sidebar-seed.ts)
  // the header says so in one quiet word instead of a spinner, and it says it even beside the
  // setup guide: that guide may be the last session's verdict, about to be replaced.
  const refreshing = seedIsRefreshing(conversation);
  const working =
    !refreshing &&
    connection.kind !== "nothing-listening" &&
    (conversation.log.kind === "loading" || conversation.staged.kind === "loading");
  return (
    <header className="sasha-header">
      {/* The real logo, a generated constant (docs/brand/export-brand.ts), never user content. */}
      <span className="sasha-tide-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: SASHA_ICON_SVG }} />
      <strong>Ask Sasha</strong>
      {refreshing ? (
        <span className="sasha-header-refreshing" role="status" title="Showing what was last seen, while it is read again">
          Updating
        </span>
      ) : null}
      {working ? <span className="sasha-header-spin" aria-label="working" /> : null}
    </header>
  );
}

/**
 * THE CONNECTION WITH THE ASSISTANT. When something is listening it is one compact line, because
 * there is nothing to do about it; when nothing is, it is the setup guide, because that is the one
 * situation where waiting longer cannot help. WHEN each shows is waiting.ts's decision.
 *
 * "Connected" is stated with its evidence -- how long since the assistant was last heard from --
 * because nothing proves a session is attached right now, only that one was.
 */
function ConnectionStatus({
  connection,
  setup,
}: {
  connection: AssistantConnection;
  setup: SetupEnvironment;
}): JSX.Element {
  switch (connection.kind) {
    case "connected":
      return (
        <div className="sasha-connection" role="status">
          <p className="sasha-connection-line">
            <span className="sasha-connection-dot sasha-connection-dot-on" aria-hidden="true" />
            <span>Connected to your assistant</span>
          </p>
          <p className="sasha-dim sasha-connection-hint">
            {describeLastHeard(connection.agoMs)}. Talk to Sasha in the deck&apos;s comments.
          </p>
        </div>
      );
    case "checking":
      return (
        <div className="sasha-connection" role="status">
          <p className="sasha-connection-line">
            <span className="sasha-connection-dot" aria-hidden="true" />
            <span>Checking for your assistant...</span>
          </p>
          <p className="sasha-dim sasha-connection-hint">{connection.reason}</p>
        </div>
      );
    case "nothing-listening":
      return <SetupGuide notice={connection.notice} environment={setup} />;
    default:
      return assertNever(connection);
  }
}

/**
 * CAN SASHA ANSWER COMMENTS HERE? Shown only when it cannot yet. "Allow" is a real link with
 * target=_blank -- the HtmlService sandbox lets a user-clicked link open a tab, while script
 * `window.open` is unreliable there -- and it opens the connector's allow page with this deck
 * preselected in Google's picker. The other two cases have no one-click fix, so they are one line.
 */
function CommentAccessNotice({ card, onAllowOpened }: { card: CommentAccessCard; onAllowOpened: () => void }): JSX.Element {
  switch (card.kind) {
    case "allow":
      return (
        <div className="sasha-comment-access" role="status">
          <p className="sasha-comment-access-line">Let Sasha answer comments on this deck</p>
          <p className="sasha-dim sasha-comment-access-hint">One click in Google&apos;s file picker, for this deck only.</p>
          <a className="sasha-primary sasha-comment-access-allow" href={card.allowUrl} target="_blank" rel="noopener noreferrer" onClick={onAllowOpened}>
            {card.checking ? "Checking..." : "Allow"}
          </a>
        </div>
      );
    case "notConnected":
      return (
        <p className="sasha-dim sasha-comment-access-note">
          Sasha cannot answer comments here yet: connect Sasha Slides to your assistant with this Google account. The Setup guide shows how.
        </p>
      );
    case "viewOnly":
      return <p className="sasha-dim sasha-comment-access-note">You can view this deck but not comment; ask the owner for Commenter access.</p>;
    default:
      return assertNever(card);
  }
}

function describeLastHeard(agoMs: number | null): string {
  return agoMs === null ? "Last heard from just now" : `Last heard from ${describeElapsed(agoMs)} ago`;
}

/** Whether the slides window opened, or why it did not. Never silent: it is the way back. */
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
 * THE ASSETS: the followed set's candidates, or what stands in for them -- nothing staged yet, a
 * manifest still on its way, or why it could not be read.
 */
function Assets({
  conversation,
  previews,
  actions,
}: {
  conversation: Conversation;
  previews: SlidePreviews;
  actions: ConversationActions;
}): JSX.Element | null {
  const set = conversation.set;
  switch (set.kind) {
    case "none":
      return conversation.staged.kind === "failed" ? (
        <p className="sasha-trouble">could not look for candidate slides: {conversation.staged.message}</p>
      ) : (
        <p className="sasha-dim sasha-assets-empty">
          No candidate slides yet. When your assistant stages some, they are listed here.
        </p>
      );
    case "following":
      switch (set.manifest.kind) {
        case "unrequested":
        case "loading":
          return null;
        case "failed":
          return <p className="sasha-trouble">could not read the candidate slides: {set.manifest.message}</p>;
        case "loaded":
          if (set.slides.length === 0) {
            return <p className="sasha-dim sasha-assets-empty">No candidate slides right now.</p>;
          }
          return (
            <CandidateCard
              conversation={conversation}
              previews={previews}
              actions={actions}
              proposalId={set.proposalId}
              count={set.manifest.count}
            />
          );
        default:
          return assertNever(set.manifest);
      }
    default:
      return assertNever(set);
  }
}

/**
 * THE SET ITSELF: the candidates, in two lists, stacked vertically because that is what they are --
 * a pile of candidates, in order.
 *
 * WORKING AND ARCHIVED. The user sets a candidate aside with Archive; it moves to the Archived tab
 * and never disappears, so Restore always brings it back. The working tab keeps the last archived
 * one in view, so a candidate archived by mistake is one click away without switching tabs.
 */
function CandidateCard({
  conversation,
  previews,
  actions,
  proposalId,
  count,
}: {
  conversation: Conversation;
  previews: SlidePreviews;
  actions: ConversationActions;
  proposalId: string;
  count: number;
}): JSX.Element {
  const lists = candidateListsOf(conversation);
  const counts: Readonly<Record<CandidateTab, number>> = {
    working: lists.working.length,
    archived: lists.archived.length,
  };
  const lastArchived = lists.archived[0];
  return (
    <div className="sasha-artifact">
      <p className="sasha-artifact-head mono">
        {count} candidate{count === 1 ? "" : "s"}
      </p>
      <div className="sasha-candidate-tabs" role="group" aria-label="Candidates">
        {CANDIDATE_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={tab === conversation.candidateTab ? "sasha-tab sasha-tab-on" : "sasha-tab"}
            aria-pressed={tab === conversation.candidateTab}
            onClick={() => actions.chooseCandidateTab(tab)}
          >
            {CANDIDATE_TAB_LABEL[tab]}
            <span className="sasha-filter-count">{counts[tab]}</span>
          </button>
        ))}
      </div>
      <CandidateTabBody
        conversation={conversation}
        previews={previews}
        actions={actions}
        proposalId={proposalId}
        lists={lists}
      />
      {conversation.candidateTab === "working" && lastArchived !== undefined ? (
        <p className="sasha-last-archived">
          <span className="sasha-last-archived-text">
            Last archived: <span className="mono">{`${lastArchived.slide.slideIndex} · ${slideLabelOf(lastArchived.slide)}`}</span>
          </span>
          <button
            type="button"
            className="sasha-secondary sasha-small"
            onClick={() =>
              actions.setCandidateArchived({ proposalId, slideIndex: lastArchived.slide.slideIndex, archived: false })
            }
          >
            Restore
          </button>
        </p>
      ) : null}
      {conversation.archiveTrouble === null ? null : (
        <p className="sasha-trouble" role="alert">
          {conversation.archiveTrouble}
        </p>
      )}
      <button
        type="button"
        className="sasha-primary sasha-small"
        onClick={() => actions.openArtifact({ proposalId, slideIndex: null })}
      >
        Open artifacts
      </button>
    </div>
  );
}

/** The list the chosen tab shows, or what to do when it is empty. */
function CandidateTabBody({
  conversation,
  previews,
  actions,
  proposalId,
  lists,
}: {
  conversation: Conversation;
  previews: SlidePreviews;
  actions: ConversationActions;
  proposalId: string;
  lists: CandidateLists<ConversationSlide>;
}): JSX.Element {
  const row = (slide: ConversationSlide, archived: boolean): JSX.Element => (
    <CandidateRow
      key={slide.slideIndex}
      conversation={conversation}
      previews={previews}
      actions={actions}
      proposalId={proposalId}
      slide={slide}
      archived={archived}
    />
  );
  switch (conversation.candidateTab) {
    case "working":
      if (lists.working.length === 0) {
        return (
          <p className="sasha-dim sasha-candidates-empty">
            {lists.archived.length === 1
              ? "The only candidate is archived."
              : `All ${lists.archived.length} candidates are archived.`}{" "}
            <button type="button" className="sasha-stack-archive" onClick={() => actions.chooseCandidateTab("archived")}>
              Show archived
            </button>
          </p>
        );
      }
      return (
        <ol className="sasha-stack" aria-label="the candidates in this set">
          {lists.working.map((slide) => row(slide, false))}
        </ol>
      );
    case "archived":
      if (lists.archived.length === 0) {
        return (
          <p className="sasha-dim sasha-candidates-empty">
            Nothing archived. Archive sets a candidate aside here, and Restore brings it back.
          </p>
        );
      }
      return (
        <ol className="sasha-stack sasha-stack-archived" aria-label="the archived candidates, most recent first">
          {lists.archived.map((entry) => row(entry.slide, true))}
        </ol>
      );
    default:
      return assertNever(conversation.candidateTab);
  }
}

/** One candidate: number, thumbnail, label, Archive or Restore, and Open. */
function CandidateRow({
  conversation,
  previews,
  actions,
  proposalId,
  slide,
  archived,
}: {
  conversation: Conversation;
  previews: SlidePreviews;
  actions: ConversationActions;
  proposalId: string;
  slide: ConversationSlide;
  archived: boolean;
}): JSX.Element {
  return (
    <li className="sasha-stack-slide">
      <span className="sasha-stack-number mono">{slide.slideIndex}</span>
      {/* The picture opens the candidate too: it is the biggest target in the row. */}
      <button
        type="button"
        className="sasha-stack-thumb"
        aria-label={`Open candidate ${slide.slideIndex}`}
        onClick={() => actions.openArtifact({ proposalId, slideIndex: slide.slideIndex })}
      >
        <SlideThumb
          preview={previewOf({ conversation, previews, slideIndex: slide.slideIndex })}
          title={`candidate ${slide.slideIndex}`}
        />
      </button>
      {/* The label gets the row's whole width and the buttons go under it: side by side, two
          buttons left a ~300 px sidebar about 20 px of label ("I...", seen live 2026-10-11). */}
      <span className="sasha-stack-body">
        <span className="sasha-stack-label" title={slideLabelOf(slide)}>
          {slideLabelOf(slide)}
        </span>
        <span className="sasha-stack-actions">
          <button
            type="button"
            className="sasha-secondary sasha-small"
            onClick={() => actions.openArtifact({ proposalId, slideIndex: slide.slideIndex })}
          >
            Open
          </button>
          <button
            type="button"
            className="sasha-secondary sasha-small"
            title={archived ? "Bring this candidate back to the working list" : "Set this candidate aside; it can be restored"}
            onClick={() => actions.setCandidateArchived({ proposalId, slideIndex: slide.slideIndex, archived: !archived })}
          >
            {archived ? "Restore" : "Archive"}
          </button>
        </span>
      </span>
    </li>
  );
}

/** A candidate's caption, or its file name when Sasha gave none. */
function slideLabelOf(slide: ConversationSlide): string {
  return slide.label === "" ? slide.name : slide.label;
}

/**
 * The SIDEBAR's shell -- the narrow one. The wider surfaces add `sasha-shell-wide`. It alone wears
 * the Tidepool look (tidepool-styles.ts): the moving background behind, glass cards in front.
 */
function ConversationShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <>
      <style>{PICKER_CSS}</style>
      <style>{TIDEPOOL_CSS}</style>
      <div className="sasha-shell sasha-tide">
        <div className="sasha-tide-ambient" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
        {children}
      </div>
    </>
  );
}
