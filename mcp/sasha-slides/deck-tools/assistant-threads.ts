/**
 * THE DISCUSSION AS AN AGENT READS IT. Claude cannot see the canvas, so a thread is flattened to
 * what it can act on: which slide (and its number), which element, the quoted text of a text
 * anchor, the region, and the KINDS of markings drawn ("pen", "rectangle"), so it at least knows
 * someone drew something (assistant-deck-tools.ts `AssistantThread`).
 *
 * `discussionChanges` is what `deck_await_comments` reports: threads that appeared, messages that
 * arrived and threads resolved or reopened between two discussion snapshots -- leaving out what
 * this agent did itself, since an agent woken by its own reply would only wait again.
 */
import type { AssistantThread } from "../engine/src/contracts/assistant-deck-tools.ts";
import { assertNever } from "../engine/src/contracts/assert-never.ts";
import type { CommentTarget, CommentThread, DiscussionSnapshot, ThreadStatus } from "../engine/src/contracts/discussion.ts";
import type { DocumentSnapshot } from "../engine/src/contracts/document.ts";
import type { ElementId, MessageId, PersonId, SlideId } from "../engine/src/contracts/ids.ts";

export type DiscussionChange = Readonly<{
  change: "newThread" | "newMessages" | "resolved" | "reopened";
  thread: AssistantThread;
  /** The messages that arrived since; every message for a new thread. */
  newMessageIds: readonly MessageId[];
}>;

export function assistantThreads(
  options: Readonly<{ discussion: DiscussionSnapshot; snapshot: DocumentSnapshot; status: "open" | "all"; slideId: SlideId | null }>,
): readonly AssistantThread[] {
  return options.discussion.threads
    .filter((thread) => options.slideId === null || thread.anchor.slideId === options.slideId)
    .filter((thread) => listed({ wanted: options.status, status: thread.status }))
    .map((thread) => assistantThread({ thread, snapshot: options.snapshot }));
}

export function assistantThread(options: Readonly<{ thread: CommentThread; snapshot: DocumentSnapshot }>): AssistantThread {
  const { thread } = options;
  const slideIndex = options.snapshot.slides.findIndex((slide) => slide.id === thread.anchor.slideId);
  return {
    threadId: thread.id,
    slideId: thread.anchor.slideId,
    slideNumber: slideIndex === -1 ? null : slideIndex + 1,
    target: thread.anchor.target.kind,
    elementId: targetElementId(thread.anchor.target),
    quotedText: quotedTextOf(thread.anchor.target),
    region: thread.anchor.region,
    markingKinds: [...new Set(thread.markings.map((marking) => marking.kind))],
    status: threadStatusName(thread.status),
    messages: thread.messages.map((message) => ({
      messageId: message.id,
      authorName: message.author.displayName,
      authorKind: message.author.kind,
      body: message.body,
      createdAt: message.createdAt,
    })),
  };
}

/**
 * What changed from `before` to `after`, ignoring `ignoreAuthorId`'s own messages, threads and
 * status changes. `before` null (a sequence this server never answered) counts every thread with a
 * message from someone else as new.
 */
export function discussionChanges(
  options: Readonly<{ before: DiscussionSnapshot | null; after: DiscussionSnapshot; snapshot: DocumentSnapshot; ignoreAuthorId: PersonId }>,
): readonly DiscussionChange[] {
  const previous = new Map((options.before?.threads ?? []).map((thread) => [thread.id, thread] as const));
  const changes: DiscussionChange[] = [];
  for (const thread of options.after.threads) {
    const earlier = previous.get(thread.id);
    const knownMessages = new Set((earlier?.messages ?? []).map((message) => message.id));
    const newMessageIds = thread.messages.filter((message) => !knownMessages.has(message.id) && message.author.id !== options.ignoreAuthorId).map((message) => message.id);
    const change = changeOf({ earlier: earlier ?? null, thread, newMessageCount: newMessageIds.length, ignoreAuthorId: options.ignoreAuthorId });
    if (change === null) continue;
    changes.push({ change, thread: assistantThread({ thread, snapshot: options.snapshot }), newMessageIds });
  }
  return changes;
}

function changeOf(
  options: Readonly<{ earlier: CommentThread | null; thread: CommentThread; newMessageCount: number; ignoreAuthorId: PersonId }>,
): DiscussionChange["change"] | null {
  const { earlier, thread } = options;
  if (earlier === null) return options.newMessageCount > 0 ? "newThread" : null;
  const before = threadStatusName(earlier.status);
  const after = threadStatusName(thread.status);
  if (before !== after && statusChangedBy(thread.status) !== options.ignoreAuthorId) return statusChange(thread.status);
  return options.newMessageCount > 0 ? "newMessages" : null;
}

function listed(options: Readonly<{ wanted: "open" | "all"; status: ThreadStatus }>): boolean {
  switch (options.wanted) {
    case "all":
      return true;
    case "open":
      return isOpen(options.status);
    default:
      return assertNever(options.wanted);
  }
}

function isOpen(status: ThreadStatus): boolean {
  switch (status.kind) {
    case "open":
      return true;
    case "resolved":
      return false;
    default:
      return assertNever(status);
  }
}

/** What a status change is called, by the status it changed TO. */
function statusChange(status: ThreadStatus): "resolved" | "reopened" {
  switch (status.kind) {
    case "open":
      return "reopened";
    case "resolved":
      return "resolved";
    default:
      return assertNever(status);
  }
}

function threadStatusName(status: ThreadStatus): "open" | "resolved" {
  switch (status.kind) {
    case "open":
      return "open";
    case "resolved":
      return "resolved";
    default:
      return assertNever(status);
  }
}

/** Who resolved a resolved thread; a reopen does not record who, so it is never "the agent's own". */
function statusChangedBy(status: ThreadStatus): PersonId | null {
  switch (status.kind) {
    case "open":
      return null;
    case "resolved":
      return status.resolvedBy.id;
    default:
      return assertNever(status);
  }
}

function targetElementId(target: CommentTarget): ElementId | null {
  switch (target.kind) {
    case "slide":
      return null;
    case "element":
    case "text":
      return target.elementId;
    default:
      return assertNever(target);
  }
}

function quotedTextOf(target: CommentTarget): string | null {
  switch (target.kind) {
    case "slide":
    case "element":
      return null;
    case "text":
      return target.quotedText;
    default:
      return assertNever(target);
  }
}
