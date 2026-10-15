// THE COMMENT RAIL: replaces the properties panel while comments are open. Threads are glass cards,
// placed by the state module's pure `arrangeThreads` (on their element, where a removed element
// was, on the slide, or "on deleted slides"), the current slide's first, newest activity first,
// open or resolved. The focused thread expands to its replies and a reply box; requests still on
// their way to the authority read "Sending..." (SPEC.md section 12).
//
// Drafts of replies are this component's own state: they are not shared, not undoable and gone
// when the card closes, exactly like a reply box anywhere else. The thread being composed is editor
// state (`ui.composer`), because the canvas draws its region and markings.

import { memo, useState, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { CommentThread } from "../../contracts/discussion.ts";
import type { ArrangedThread } from "../../contracts/editor-system.ts";
import type { PendingDiscussionRequest } from "../../contracts/editor-state.ts";
import type { SlideId, ThreadId } from "../../contracts/ids.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { shallowEqual, useEditorSelector, useEditorServices } from "../application/editor-services.tsx";
import { peerColour } from "../canvas/canvas-overlay.tsx";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { Icon } from "./icons.tsx";
import { initials } from "./top-bar.tsx";

export const CommentRail = memo(function CommentRail(): ReactElement {
  const services = useEditorServices();
  const dispatch = services.system.dispatch;
  const view = useEditorSelector(
    (state) => ({
      discussion: state.discussion,
      document: state.document,
      anchors: state.resolvedTextAnchors,
      currentSlideId: state.currentSlideId,
      focused: state.ui.focusedThreadId,
      showResolved: state.ui.showResolvedThreads,
      composer: state.ui.composer,
      inFlight: state.inFlightDiscussion,
      pending: state.pendingDiscussion,
      me: state.me,
    }),
    shallowEqual,
  );
  const arranged = services.arrangeThreads({ discussion: view.discussion, document: view.document, resolvedTextAnchors: view.anchors });
  const shown = orderForRail({ arranged, currentSlideId: view.currentSlideId, showResolved: view.showResolved });
  const sending = new Set([...view.inFlight, ...view.pending].map(threadOfRequest).filter((id): id is ThreadId => id !== null));
  return (
    <aside className={`${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.commentRail}`} aria-label="Comments">
      <div className={`${VIEW_CLASS.panelHeader} ${VIEW_CLASS.fieldRow}`}>
        <strong>Comments</strong>
        <div className={TIDEPOOL_CLASS.tabs} role="tablist" aria-label="Which comments" style={{ marginInlineStart: "auto" }}>
          <button type="button" role="tab" className={TIDEPOOL_CLASS.tab} aria-selected={!view.showResolved} onClick={() => view.showResolved && dispatch({ kind: "resolvedThreadsToggled" })}>
            Open
          </button>
          <button type="button" role="tab" className={TIDEPOOL_CLASS.tab} aria-selected={view.showResolved} onClick={() => !view.showResolved && dispatch({ kind: "resolvedThreadsToggled" })}>
            All
          </button>
        </div>
        <button type="button" className={TIDEPOOL_CLASS.iconButton} aria-label="Close comments" onClick={() => dispatch({ kind: "panelToggled", panel: "comments" })}>
          <Icon name="close" />
        </button>
      </div>
      <div className={VIEW_CLASS.panelBody}>
        {view.composer.kind === "composing" ? <Composer draft={view.composer.draft} /> : null}
        {shown.length === 0 && view.composer.kind !== "composing" ? (
          <div className={TIDEPOOL_CLASS.card}>
            <p className={TIDEPOOL_CLASS.muted} style={{ margin: 0 }}>
              No comments yet. Choose the comment tool and drag over the slide to start one.
            </p>
            <button type="button" className={TIDEPOOL_CLASS.secondaryPill} style={{ marginBlockStart: 8 }} onClick={() => dispatch({ kind: "toolChosen", tool: { kind: "comment" } })}>
              <Icon name="comment" /> Comment tool
            </button>
          </div>
        ) : null}
        {shown.map((entry) => (
          <ThreadCard key={entry.arranged.thread.id} arranged={entry.arranged} label={entry.label} focused={entry.arranged.thread.id === view.focused} sending={sending.has(entry.arranged.thread.id)} mine={(author) => author === view.me.id} />
        ))}
      </div>
    </aside>
  );
});

function Composer(properties: Readonly<{ draft: string }>): ReactElement {
  const dispatch = useEditorServices().system.dispatch;
  return (
    <form
      className={`${TIDEPOOL_CLASS.card} ${VIEW_CLASS.composer}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (properties.draft.trim().length > 0) dispatch({ kind: "commentSubmitted" });
      }}
    >
      <label className={VIEW_CLASS.fieldLabel}>
        <span>New comment</span>
        <textarea className={VIEW_CLASS.textArea} value={properties.draft} autoFocus placeholder="Say what you see; drag on the slide to mark it" onChange={(event) => dispatch({ kind: "commentDraftChanged", draft: event.currentTarget.value })} />
      </label>
      <div className={VIEW_CLASS.threadActions}>
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={() => dispatch({ kind: "toolChosen", tool: { kind: "annotate", marking: "pen" } })}>
          Draw
        </button>
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={() => dispatch({ kind: "toolChosen", tool: { kind: "annotate", marking: "rectangle" } })}>
          Box
        </button>
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={() => dispatch({ kind: "commentComposerClosed" })} style={{ marginInlineStart: "auto" }}>
          Cancel
        </button>
        <button type="submit" className={TIDEPOOL_CLASS.primaryPill} disabled={properties.draft.trim().length === 0}>
          Comment
        </button>
      </div>
    </form>
  );
}

function ThreadCard(properties: Readonly<{ arranged: ArrangedThread; label: string; focused: boolean; sending: boolean; mine: (authorId: CommentThread["createdBy"]["id"]) => boolean }>): ReactElement {
  const dispatch = useEditorServices().system.dispatch;
  const [reply, setReply] = useState("");
  const thread = properties.arranged.thread;
  const resolved = threadIsResolved(thread);
  const first = thread.messages[0];
  const replies = thread.messages.slice(1);
  return (
    <article
      className={`${TIDEPOOL_CLASS.card} ${VIEW_CLASS.thread}`}
      data-focused={properties.focused ? "true" : "false"}
      data-resolved={resolved ? "true" : "false"}
      aria-label={`Comment by ${thread.createdBy.displayName}`}
      onClick={() => {
        if (!properties.focused) dispatch({ kind: "threadFocused", threadId: thread.id });
      }}
    >
      <div className={VIEW_CLASS.threadHeader}>
        <span className={VIEW_CLASS.avatar} style={{ marginInlineStart: 0, backgroundColor: peerColour(thread.createdBy.colourIndex) }} aria-hidden="true">
          {initials(thread.createdBy.displayName)}
        </span>
        <div style={{ minInlineSize: 0 }}>
          <strong>{thread.createdBy.displayName}</strong>
          {thread.createdBy.kind === "agent" ? <span className={TIDEPOOL_CLASS.subtle}> (Claude)</span> : null}
          <div className={TIDEPOOL_CLASS.subtle}>{properties.label}</div>
        </div>
        {properties.sending ? <span className={TIDEPOOL_CLASS.subtle} style={{ marginInlineStart: "auto" }}>Sending...</span> : null}
      </div>
      {first === undefined ? null : <p className={VIEW_CLASS.threadMessage}>{first.body}</p>}
      {properties.focused ? (
        <>
          {replies.map((message) => (
            <div key={message.id}>
              <strong className={TIDEPOOL_CLASS.muted}>{message.author.displayName}</strong>
              <p className={VIEW_CLASS.threadMessage}>{message.body}</p>
            </div>
          ))}
          <form
            className={VIEW_CLASS.composer}
            onSubmit={(event) => {
              event.preventDefault();
              if (reply.trim().length === 0) return;
              dispatch({ kind: "threadReplied", threadId: thread.id, body: reply.trim() });
              setReply("");
            }}
          >
            <textarea className={VIEW_CLASS.textArea} value={reply} placeholder="Reply" aria-label="Reply" onChange={(event) => setReply(event.currentTarget.value)} />
            <div className={VIEW_CLASS.threadActions}>
              <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={() => dispatch(resolved ? { kind: "threadReopened", threadId: thread.id } : { kind: "threadResolved", threadId: thread.id })}>
                {resolved ? "Reopen" : "Resolve"}
              </button>
              {properties.mine(thread.createdBy.id) ? (
                <button type="button" className={TIDEPOOL_CLASS.dangerPill} onClick={() => dispatch({ kind: "threadDeleted", threadId: thread.id })}>
                  Delete
                </button>
              ) : null}
              <button type="submit" className={TIDEPOOL_CLASS.primaryPill} style={{ marginInlineStart: "auto" }} disabled={reply.trim().length === 0}>
                Reply
              </button>
            </div>
          </form>
        </>
      ) : replies.length > 0 ? (
        <span className={TIDEPOOL_CLASS.subtle}>{replies.length === 1 ? "1 reply" : `${replies.length} replies`}</span>
      ) : null}
    </article>
  );
}

/** Threads for the rail: the current slide's first, then by newest activity; resolved only when asked. */
export function orderForRail(options: Readonly<{ arranged: readonly ArrangedThread[]; currentSlideId: SlideId | null; showResolved: boolean }>): readonly Readonly<{ arranged: ArrangedThread; label: string }>[] {
  const lastActivity = (thread: CommentThread): number => Math.max(thread.createdAt, ...thread.messages.map((message) => message.editedAt ?? message.createdAt));
  return options.arranged
    .filter((arranged) => options.showResolved || !threadIsResolved(arranged.thread))
    .map((arranged) => ({ arranged, onCurrent: placementSlide(arranged) === options.currentSlideId && options.currentSlideId !== null, label: placementLabel(arranged) }))
    .sort((first, second) => (first.onCurrent === second.onCurrent ? lastActivity(second.arranged.thread) - lastActivity(first.arranged.thread) : first.onCurrent ? -1 : 1))
    .map((entry) => ({ arranged: entry.arranged, label: entry.label }));
}

function threadIsResolved(thread: CommentThread): boolean {
  switch (thread.status.kind) {
    case "open":
      return false;
    case "resolved":
      return true;
    default:
      return assertNever(thread.status);
  }
}

function placementSlide(arranged: ArrangedThread): SlideId | null {
  const placement = arranged.placement;
  switch (placement.kind) {
    case "onElement":
    case "elementRemoved":
    case "onSlide":
      return placement.slideId;
    case "slideRemoved":
      return null;
    default:
      return assertNever(placement);
  }
}

function placementLabel(arranged: ArrangedThread): string {
  const placement = arranged.placement;
  switch (placement.kind) {
    case "onElement":
      return placement.textRange === null ? "On an element" : "On text";
    case "elementRemoved":
      return "The element was removed";
    case "onSlide":
      return "On the slide";
    case "slideRemoved":
      return "On a deleted slide";
    default:
      return assertNever(placement);
  }
}

function threadOfRequest(request: PendingDiscussionRequest): ThreadId | null {
  const command = request.command;
  switch (command.kind) {
    case "createThread":
    case "reply":
    case "editMessage":
    case "deleteMessage":
    case "resolveThread":
    case "reopenThread":
    case "deleteThread":
      return command.threadId;
    default:
      return assertNever(command);
  }
}
