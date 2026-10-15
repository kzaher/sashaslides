// THE COMMENT RAIL: replaces the properties panel while comments are open. Threads are glass cards,
// placed by the state module's pure `arrangeThreads` (on their element, where a removed element
// was, on the slide, or on a deleted slide), the current slide's first, newest activity first. A
// filter shows the open threads, the resolved ones, or the ones that mention me; threads whose
// slide was deleted gather under "On deleted slides" (SPEC.md 12 and 21.9).
//
// Key decisions:
//
//  * MENTIONS ARE CHOSEN, NOT PARSED. Typing "@" in the composer or a reply opens the deck's
//    members filtered as one types; choosing one writes "@Display Name " and records the id
//    (mentions.ts). Messages highlight each recorded mention; the agent's messages carry a
//    "Claude" label.
//  * DRAFTS OF REPLIES AND EDITS ARE THIS COMPONENT'S OWN: not shared, not undoable, gone when the
//    card closes, like a reply box anywhere else. The thread being composed is editor state
//    (`chrome.composer`), because the canvas draws its region and markings.
//  * A VIEWER READS ONLY: the composer, replies, resolve and delete are disabled with the reason
//    (access.ts); the reducer refuses them too.
//  * THE FILTER IS A TABLIST with a roving tab index (pill-group.ts). "Resolved" also shows resolved
//    pins on the canvas (`chrome.showResolvedThreads`).

import { memo, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { CommentMessage, CommentThread, Person } from "../../contracts/discussion.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { PendingDiscussionRequest } from "../../contracts/editor-state.ts";
import type { ArrangedThread } from "../../contracts/editor-system.ts";
import type { PersonId, SlideId, ThreadId } from "../../contracts/ids.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { shallowEqual, useEditorSelector, useEditorServices } from "../application/editor-services.tsx";
import { peerColour } from "../canvas/canvas-overlay.tsx";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { commentingDisabledReason } from "./access.ts";
import { Icon } from "./icons.tsx";
import { insertMention, matchingMembers, mentionQueryAt, mentionsStillIn, messageSegments, type MentionQuery } from "./mentions.ts";
import { handlePillGroupKey, rovingTabIndex } from "./pill-group.ts";
import { initials } from "./top-bar.tsx";

export type ThreadFilter = "open" | "resolved" | "mentionsOfMe";

export const THREAD_FILTERS: readonly Readonly<{ filter: ThreadFilter; label: string }>[] = [
  { filter: "open", label: "Open" },
  { filter: "resolved", label: "Resolved" },
  { filter: "mentionsOfMe", label: "Mentions of me" },
];

export const CommentRail = memo(function CommentRail(): ReactElement {
  const services = useEditorServices();
  const dispatch = services.system.dispatch;
  const view = useEditorSelector(
    (state) => ({
      discussion: state.discussion,
      document: state.document,
      anchors: state.resolvedTextAnchors,
      currentSlideId: state.currentSlideId,
      focused: state.chrome.focusedThreadId,
      showResolved: state.chrome.showResolvedThreads,
      composer: state.chrome.composer,
      inFlight: state.inFlightDiscussion,
      pending: state.pendingDiscussion,
      me: state.me,
      members: state.collaboration.members,
      refusal: commentingDisabledReason(state),
    }),
    shallowEqual,
  );
  const [filter, setFilter] = useState<ThreadFilter>(view.showResolved ? "resolved" : "open");
  const chooseFilter = (next: ThreadFilter): void => {
    setFilter(next);
    if (SHOWS_RESOLVED_PINS[next] !== view.showResolved) dispatch({ kind: "resolvedThreadsToggled" });
  };
  const arranged = services.arrangeThreads({ discussion: view.discussion, document: view.document, resolvedTextAnchors: view.anchors });
  const sections = railSections({ arranged, currentSlideId: view.currentSlideId, filter, me: view.me.id });
  const sending = new Set([...view.inFlight, ...view.pending].map(threadOfRequest));
  const people = knownPeople({ members: view.members.map((member) => member.person), threads: view.discussion.threads, me: view.me });
  const mentionable = view.members.map((member) => member.person);
  const chosenIndex = THREAD_FILTERS.findIndex((entry) => entry.filter === filter);
  const card = (entry: RailEntry): ReactElement => (
    <ThreadCard
      key={entry.arranged.thread.id}
      arranged={entry.arranged}
      label={entry.label}
      focused={entry.arranged.thread.id === view.focused}
      sending={sending.has(entry.arranged.thread.id)}
      me={view.me}
      people={people}
      mentionable={mentionable}
      refusal={view.refusal}
    />
  );
  return (
    <aside className={`${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.commentRail}`} aria-label="Comments">
      <div className={`${VIEW_CLASS.panelHeader} ${VIEW_CLASS.fieldRow}`}>
        <strong>Comments</strong>
        <button type="button" className={TIDEPOOL_CLASS.iconButton} aria-label="Close comments" style={{ marginInlineStart: "auto" }} onClick={() => dispatch({ kind: "panelToggled", panel: "comments" })}>
          <Icon name="close" />
        </button>
        <div
          className={TIDEPOOL_CLASS.tabs}
          role="tablist"
          aria-label="Which comments"
          onKeyDown={(event) =>
            handlePillGroupKey(event, (index) => {
              const entry = THREAD_FILTERS[index];
              if (entry !== undefined) chooseFilter(entry.filter);
            })
          }
        >
          {THREAD_FILTERS.map((entry, index) => (
            <button key={entry.filter} type="button" role="tab" className={TIDEPOOL_CLASS.tab} aria-selected={entry.filter === filter} tabIndex={rovingTabIndex({ index, chosenIndex })} onClick={() => chooseFilter(entry.filter)}>
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      <div className={VIEW_CLASS.panelBody}>
        {view.refusal === null ? null : <p className={VIEW_CLASS.explanation}>{view.refusal}</p>}
        {view.composer.kind === "composing" ? <Composer draft={view.composer.draft} mentions={view.composer.mentions} markings={view.composer.markings.length} mentionable={mentionable} me={view.me.id} refusal={view.refusal} /> : null}
        {sections.onSlides.length === 0 && sections.onDeletedSlides.length === 0 && view.composer.kind !== "composing" ? <EmptyRail filter={filter} refusal={view.refusal} dispatch={dispatch} /> : null}
        {sections.onSlides.map(card)}
        {sections.onDeletedSlides.length === 0 ? null : (
          <>
            <h3 className={VIEW_CLASS.railSection}>On deleted slides</h3>
            {sections.onDeletedSlides.map(card)}
          </>
        )}
      </div>
    </aside>
  );
});

function EmptyRail(properties: Readonly<{ filter: ThreadFilter; refusal: string | null; dispatch: (event: EditorEvent) => void }>): ReactElement {
  return (
    <div className={TIDEPOOL_CLASS.card}>
      <p className={TIDEPOOL_CLASS.muted} style={{ margin: 0 }}>
        {EMPTY_MESSAGE[properties.filter]}
      </p>
      {properties.refusal === null ? (
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} style={{ marginBlockStart: 8 }} onClick={() => properties.dispatch({ kind: "toolChosen", tool: { kind: "comment" } })}>
          <Icon name="comment" /> Comment tool
        </button>
      ) : null}
    </div>
  );
}

const EMPTY_MESSAGE: Readonly<Record<ThreadFilter, string>> = {
  open: "No open comments. Choose the comment tool and drag over the slide to start one.",
  resolved: "No resolved comments yet.",
  mentionsOfMe: "Nobody has mentioned you yet.",
};

const SHOWS_RESOLVED_PINS: Readonly<Record<ThreadFilter, boolean>> = { open: false, resolved: true, mentionsOfMe: false };

/** The new thread: text with mentions, and the drawing tools for its markings. */
function Composer(properties: Readonly<{ draft: string; mentions: readonly PersonId[]; markings: number; mentionable: readonly Person[]; me: PersonId; refusal: string | null }>): ReactElement {
  const dispatch = useEditorServices().system.dispatch;
  return (
    <form
      className={`${TIDEPOOL_CLASS.card} ${VIEW_CLASS.composer}`}
      aria-label="New comment"
      onSubmit={(event) => {
        event.preventDefault();
        if (properties.draft.trim().length > 0) dispatch({ kind: "commentSubmitted" });
      }}
    >
      <MentionTextArea
        label="New comment"
        value={properties.draft}
        mentions={properties.mentions}
        members={properties.mentionable}
        me={properties.me}
        autoFocus
        disabledReason={properties.refusal}
        placeholder="Say what you see; @ to mention someone; draw on the slide to mark it"
        onChange={(draft, mentions) => dispatch({ kind: "commentDraftChanged", draft, mentions })}
      />
      <div className={VIEW_CLASS.threadActions}>
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={properties.refusal !== null} onClick={() => dispatch({ kind: "toolChosen", tool: { kind: "annotate", marking: "pen" } })}>
          Draw
        </button>
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={properties.refusal !== null} onClick={() => dispatch({ kind: "toolChosen", tool: { kind: "annotate", marking: "rectangle" } })}>
          Box
        </button>
        {properties.markings === 0 ? null : <span className={TIDEPOOL_CLASS.subtle}>{properties.markings === 1 ? "1 marking" : `${properties.markings} markings`}</span>}
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={() => dispatch({ kind: "commentComposerClosed" })} style={{ marginInlineStart: "auto" }}>
          Cancel
        </button>
        <button type="submit" className={TIDEPOOL_CLASS.primaryPill} disabled={properties.draft.trim().length === 0 || properties.refusal !== null}>
          Comment
        </button>
      </div>
    </form>
  );
}

/**
 * A text area that opens the members list on "@" (mentions.ts): the arrow keys move in the list,
 * Enter or Tab chooses, Escape closes it. The recorded mentions travel with the text.
 */
export function MentionTextArea(properties: Readonly<{
  label: string;
  value: string;
  mentions: readonly PersonId[];
  members: readonly Person[];
  me: PersonId;
  placeholder: string;
  autoFocus?: boolean;
  disabledReason: string | null;
  onChange: (text: string, mentions: readonly PersonId[]) => void;
}>): ReactElement {
  const area = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = area.current;
    const target = pendingCaret.current;
    if (element === null || target === null) return;
    pendingCaret.current = null;
    element.setSelectionRange(target, target);
  });
  const query = caret === null ? null : mentionQueryAt({ text: properties.value, caret });
  const candidates = query === null || query.start === dismissedAt ? [] : matchingMembers({ members: properties.members, query: query.query, me: properties.me });
  const choose = (person: Person, at: MentionQuery): void => {
    const inserted = insertMention({ text: properties.value, caret: caret ?? properties.value.length, query: at, person });
    pendingCaret.current = inserted.caret;
    setCaret(inserted.caret);
    setActive(0);
    properties.onChange(inserted.text, [...properties.mentions.filter((personId) => personId !== person.id), person.id]);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (query === null || candidates.length === 0) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((active + 1) % candidates.length);
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive((active - 1 + candidates.length) % candidates.length);
        return;
      case "Enter":
      case "Tab": {
        const person = candidates[Math.min(active, candidates.length - 1)];
        if (person === undefined) return;
        event.preventDefault();
        choose(person, query);
        return;
      }
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(query.start);
        return;
      default:
        return;
    }
  };
  const listId = `${properties.label.replace(/\W+/g, "-").toLowerCase()}-mentions`;
  return (
    <div className={VIEW_CLASS.composer}>
      <label className={VIEW_CLASS.fieldLabel}>
        <span>{properties.label}</span>
        <textarea
          ref={area}
          className={VIEW_CLASS.textArea}
          value={properties.value}
          autoFocus={properties.autoFocus === true}
          disabled={properties.disabledReason !== null}
          title={properties.disabledReason ?? undefined}
          placeholder={properties.placeholder}
          aria-autocomplete="list"
          aria-expanded={candidates.length > 0}
          aria-controls={candidates.length > 0 ? listId : undefined}
          onKeyDown={onKeyDown}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onChange={(event) => {
            const text = event.currentTarget.value;
            setCaret(event.currentTarget.selectionStart);
            setActive(0);
            properties.onChange(text, mentionsStillIn({ text, mentions: properties.mentions, people: properties.members }));
          }}
        />
      </label>
      {query === null || candidates.length === 0 ? null : <MentionPicker id={listId} candidates={candidates} active={active} onChoose={(person) => choose(person, query)} />}
    </div>
  );
}

/** The filtered members under the text: who "@" can mention. */
export function MentionPicker(properties: Readonly<{ id: string; candidates: readonly Person[]; active: number; onChoose: (person: Person) => void }>): ReactElement {
  return (
    <div id={properties.id} className={VIEW_CLASS.mentionPicker} role="listbox" aria-label="Mention someone">
      {properties.candidates.map((person, index) => (
        <button
          key={person.id}
          type="button"
          role="option"
          className={TIDEPOOL_CLASS.menuItem}
          aria-selected={index === properties.active}
          tabIndex={-1}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => properties.onChoose(person)}
        >
          <span className={VIEW_CLASS.avatar} style={{ marginInlineStart: 0, backgroundColor: peerColour(person.colourIndex) }} aria-hidden="true">
            {initials(person.displayName)}
          </span>
          <span>{person.displayName}</span>
          {person.kind === "agent" ? <span className={VIEW_CLASS.agentLabel}>Claude</span> : null}
        </button>
      ))}
    </div>
  );
}

function ThreadCard(properties: Readonly<{
  arranged: ArrangedThread;
  label: string;
  focused: boolean;
  sending: boolean;
  me: Person;
  people: readonly Person[];
  mentionable: readonly Person[];
  refusal: string | null;
}>): ReactElement {
  const dispatch = useEditorServices().system.dispatch;
  const [reply, setReply] = useState<Readonly<{ text: string; mentions: readonly PersonId[] }>>({ text: "", mentions: [] });
  const thread = properties.arranged.thread;
  const resolved = threadIsResolved(thread);
  const first = thread.messages[0];
  const replies = thread.messages.slice(1);
  return (
    <article
      className={`${TIDEPOOL_CLASS.card} ${VIEW_CLASS.thread}`}
      data-focused={properties.focused ? "true" : "false"}
      data-resolved={resolved ? "true" : "false"}
      data-thread={thread.id}
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
          {thread.createdBy.kind === "agent" ? <span className={VIEW_CLASS.agentLabel}>Claude</span> : null}
          <div className={TIDEPOOL_CLASS.subtle}>
            {properties.label}
            {thread.markings.length === 0 ? "" : thread.markings.length === 1 ? ", 1 marking" : `, ${thread.markings.length} markings`}
          </div>
        </div>
        {properties.sending ? <span className={TIDEPOOL_CLASS.subtle} style={{ marginInlineStart: "auto" }}>Sending...</span> : null}
      </div>
      {first === undefined ? null : <MessageView threadId={thread.id} message={first} showAuthor={false} me={properties.me} people={properties.people} mentionable={properties.mentionable} refusal={properties.refusal} />}
      {properties.focused ? (
        <>
          {replies.map((message) => (
            <MessageView key={message.id} threadId={thread.id} message={message} showAuthor me={properties.me} people={properties.people} mentionable={properties.mentionable} refusal={properties.refusal} />
          ))}
          <form
            className={VIEW_CLASS.composer}
            onSubmit={(event) => {
              event.preventDefault();
              if (reply.text.trim().length === 0) return;
              dispatch({ kind: "threadReplied", threadId: thread.id, body: reply.text.trim(), mentions: reply.mentions });
              setReply({ text: "", mentions: [] });
            }}
          >
            <MentionTextArea label="Reply" value={reply.text} mentions={reply.mentions} members={properties.mentionable} me={properties.me.id} placeholder="Reply; @ to mention someone" disabledReason={properties.refusal} onChange={(text, mentions) => setReply({ text, mentions })} />
            <div className={VIEW_CLASS.threadActions}>
              <button type="button" className={TIDEPOOL_CLASS.secondaryPill} disabled={properties.refusal !== null} onClick={() => dispatch(resolved ? { kind: "threadReopened", threadId: thread.id } : { kind: "threadResolved", threadId: thread.id })}>
                {resolved ? "Reopen" : "Resolve"}
              </button>
              {thread.createdBy.id === properties.me.id ? (
                <button type="button" className={TIDEPOOL_CLASS.dangerPill} disabled={properties.refusal !== null} onClick={() => dispatch({ kind: "threadDeleted", threadId: thread.id })}>
                  Delete
                </button>
              ) : null}
              <button type="submit" className={TIDEPOOL_CLASS.primaryPill} style={{ marginInlineStart: "auto" }} disabled={reply.text.trim().length === 0 || properties.refusal !== null}>
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

/** One message: author (Claude labelled), the text with its mentions highlighted, and Edit and Delete for my own. */
function MessageView(properties: Readonly<{ threadId: ThreadId; message: CommentMessage; showAuthor: boolean; me: Person; people: readonly Person[]; mentionable: readonly Person[]; refusal: string | null }>): ReactElement {
  const dispatch = useEditorServices().system.dispatch;
  const [editing, setEditing] = useState<Readonly<{ text: string; mentions: readonly PersonId[] }> | null>(null);
  const message = properties.message;
  const mine = message.author.id === properties.me.id;
  return (
    <div className={VIEW_CLASS.composer} data-message={message.id}>
      {properties.showAuthor || mine ? (
        <div className={VIEW_CLASS.messageMeta}>
          {properties.showAuthor ? <strong className={TIDEPOOL_CLASS.muted}>{message.author.displayName}</strong> : null}
          {properties.showAuthor && message.author.kind === "agent" ? <span className={VIEW_CLASS.agentLabel}>Claude</span> : null}
          {message.editedAt === null ? null : <span className={TIDEPOOL_CLASS.subtle}>edited</span>}
          {mine && editing === null && properties.refusal === null ? (
            <span className={VIEW_CLASS.messageActions}>
              <button type="button" className={VIEW_CLASS.inlineAction} onClick={() => setEditing({ text: message.body, mentions: message.mentions })}>
                Edit
              </button>
              <button type="button" className={VIEW_CLASS.inlineAction} onClick={() => dispatch({ kind: "messageDeleted", threadId: properties.threadId, messageId: message.id })}>
                Delete
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      {editing === null ? (
        <MessageBody message={message} people={properties.people} />
      ) : (
        <form
          className={VIEW_CLASS.composer}
          onSubmit={(event) => {
            event.preventDefault();
            const body = editing.text.trim();
            if (body.length > 0 && body !== message.body) dispatch({ kind: "messageEdited", threadId: properties.threadId, messageId: message.id, body, mentions: editing.mentions });
            setEditing(null);
          }}
        >
          <MentionTextArea label="Edit message" value={editing.text} mentions={editing.mentions} members={properties.mentionable} me={properties.me.id} placeholder="" autoFocus disabledReason={properties.refusal} onChange={(text, mentions) => setEditing({ text, mentions })} />
          <div className={VIEW_CLASS.threadActions}>
            <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className={TIDEPOOL_CLASS.primaryPill} style={{ marginInlineStart: "auto" }} disabled={editing.text.trim().length === 0}>
              Save
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** A message's text with each recorded mention highlighted (mentions.ts). */
export function MessageBody(properties: Readonly<{ message: CommentMessage; people: readonly Person[] }>): ReactElement {
  const segments = messageSegments({ body: properties.message.body, mentions: properties.message.mentions, people: properties.people });
  return (
    <p className={VIEW_CLASS.threadMessage}>
      {segments.map((segment, index) => {
        switch (segment.kind) {
          case "text":
            return <span key={index}>{segment.text}</span>;
          case "mention":
            return (
              <span key={index} className={VIEW_CLASS.mention} data-mention={segment.person.id} title={segment.person.kind === "agent" ? "Claude" : segment.person.displayName}>
                {segment.text}
              </span>
            );
          default:
            return assertNever(segment);
        }
      })}
    </p>
  );
}

export type RailEntry = Readonly<{ arranged: ArrangedThread; label: string }>;

/**
 * The rail's two sections under a filter: threads on slides (the current slide's first, then by
 * newest activity) and threads on deleted slides, newest activity first.
 */
export function railSections(options: Readonly<{ arranged: readonly ArrangedThread[]; currentSlideId: SlideId | null; filter: ThreadFilter; me: PersonId }>): Readonly<{ onSlides: readonly RailEntry[]; onDeletedSlides: readonly RailEntry[] }> {
  const lastActivity = (thread: CommentThread): number => Math.max(thread.createdAt, ...thread.messages.map((message) => message.editedAt ?? message.createdAt));
  const shown = options.arranged
    .filter((arranged) => threadPassesFilter({ thread: arranged.thread, filter: options.filter, me: options.me }))
    .map((arranged) => ({ arranged, slideId: placementSlide(arranged), label: placementLabel(arranged) }));
  const byActivity = (first: RailEntry, second: RailEntry): number => lastActivity(second.arranged.thread) - lastActivity(first.arranged.thread);
  const onSlides = shown
    .filter((entry) => entry.slideId !== null)
    .sort((first, second) => {
      const firstCurrent = first.slideId === options.currentSlideId;
      const secondCurrent = second.slideId === options.currentSlideId;
      return firstCurrent === secondCurrent ? byActivity(first, second) : firstCurrent ? -1 : 1;
    });
  const onDeletedSlides = shown.filter((entry) => entry.slideId === null).sort(byActivity);
  return { onSlides: onSlides.map(railEntry), onDeletedSlides: onDeletedSlides.map(railEntry) };
}

export function threadPassesFilter(options: Readonly<{ thread: CommentThread; filter: ThreadFilter; me: PersonId }>): boolean {
  switch (options.filter) {
    case "open":
      return !threadIsResolved(options.thread);
    case "resolved":
      return threadIsResolved(options.thread);
    case "mentionsOfMe":
      return options.thread.messages.some((message) => message.mentions.includes(options.me));
    default:
      return assertNever(options.filter);
  }
}

function railEntry(entry: RailEntry): RailEntry {
  return { arranged: entry.arranged, label: entry.label };
}

/** Everyone whose name a message can show: the members, every author in the discussion, and me. */
function knownPeople(options: Readonly<{ members: readonly Person[]; threads: readonly CommentThread[]; me: Person }>): readonly Person[] {
  const people = new Map<PersonId, Person>();
  for (const person of [options.me, ...options.members, ...options.threads.flatMap((thread) => [thread.createdBy, ...thread.messages.map((message) => message.author)])]) {
    if (!people.has(person.id)) people.set(person.id, person);
  }
  return [...people.values()];
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
      return placement.textRange === null ? (arranged.thread.anchor.region === null ? "On an element" : "On part of an element") : "On text";
    case "elementRemoved":
      return "The element was removed";
    case "onSlide":
      return arranged.thread.anchor.region === null ? "On the slide" : "On part of the slide";
    case "slideRemoved":
      return "On a deleted slide";
    default:
      return assertNever(placement);
  }
}

function threadOfRequest(request: PendingDiscussionRequest): ThreadId {
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
