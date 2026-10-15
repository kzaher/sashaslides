// COMMENTS' TWO EFFECTS (contracts/discussion.ts).
//
//  * DISCUSSION REQUESTS: every queued request is submitted to the authority once, keyed by request
//    id over `pendingDiscussion` and `inFlightDiscussion` together, so the reducer moving it from one
//    list to the other on `discussionRequestSent` (comments.ts) never submits it twice. A `createThread` draft's text range is
//    encoded here as Yjs relative positions with `DocumentStore.encodeTextAnchor` -- the reducer
//    cannot, it holds no Y.Doc -- and falls back to an element anchor when the text is already gone.
//    `submit` never throws by contract; a broken promise still settles as a rejection.
//
//  * TEXT ANCHORS: after each document revision (or a new discussion snapshot) the text-anchored
//    threads' current ranges are resolved and reported, only when they changed.

import { concat, defer, EMPTY, from, of } from "rxjs";
import { catchError, map } from "rxjs/operators";
import {
  assertNever,
  type CommentAnchor,
  type CommentTarget,
  type DiscussionRequest,
  type DiscussionStore,
  type DocumentStore,
  type EditorEvent,
  type EditorState,
  type EncodedTextAnchor,
  type Feedback,
  type PendingDiscussionRequest,
  type TextRange,
  type ThreadId,
} from "../../contracts/index.ts";
import { react, reactSet } from "../rxfeedback/react-feedbacks.ts";
import { messageOf } from "./document-feedbacks.ts";

export function discussionRequestsFeedback(
  dependencies: Readonly<{ documentStore: DocumentStore; discussionStore: DiscussionStore; reportError: (error: unknown, context: string) => void }>,
): Feedback<EditorState, EditorEvent> {
  return reactSet<EditorState, PendingDiscussionRequest, EditorEvent>({
    query: (state) => new Map([...state.pendingDiscussion, ...state.inFlightDiscussion].map((request) => [request.requestId, request])),
    effects: (request) =>
      defer(() => {
        const submission = dependencies.discussionStore.submit(encodeRequest(request, dependencies.documentStore));
        return concat(of<EditorEvent>({ kind: "discussionRequestSent", requestId: request.requestId }), from(submission).pipe(map((outcome): EditorEvent => ({ kind: "discussionSettled", outcome }))));
      }).pipe(
        catchError((error: unknown) => {
          dependencies.reportError(error, `submitting discussion request ${request.requestId}`);
          return of<EditorEvent>({ kind: "discussionSettled", outcome: { kind: "rejected", requestId: request.requestId, reason: "notPermitted", message: messageOf(error) } });
        }),
      ),
  });
}

/** The draft as the authority receives it, with any text range encoded (see the header). */
export function encodeRequest(request: PendingDiscussionRequest, documentStore: DocumentStore): DiscussionRequest {
  const command = request.command;
  switch (command.kind) {
    case "createThread": {
      const anchor: CommentAnchor = {
        slideId: command.slideId,
        target: encodeTarget(command.target, documentStore),
        region: command.region,
        elementFrameAtCreation: command.elementFrameAtCreation,
      };
      return {
        requestId: request.requestId,
        command: { kind: "createThread", threadId: command.threadId, anchor, markings: command.markings, messageId: command.messageId, body: command.body, mentions: command.mentions },
      };
    }
    case "reply":
    case "editMessage":
    case "deleteMessage":
    case "resolveThread":
    case "reopenThread":
    case "deleteThread":
      return { requestId: request.requestId, command };
    default:
      return assertNever(command);
  }
}

export function textAnchorsFeedback(dependencies: Readonly<{ documentStore: DocumentStore; reportError: (error: unknown, context: string) => void }>): Feedback<EditorState, EditorEvent> {
  return react<EditorState, AnchorRequest, EditorEvent>({
    query: (state) => {
      const anchors = state.discussion.threads.flatMap((thread) => {
        const target = thread.anchor.target;
        switch (target.kind) {
          case "text":
            return [{ threadId: thread.id, anchor: target.anchor }];
          case "slide":
          case "element":
            return [];
          default:
            return assertNever(target);
        }
      });
      if (anchors.length === 0 && state.resolvedTextAnchors.size === 0) return null;
      return { revision: state.document.revision, sequence: state.discussion.sequence, anchors, current: state.resolvedTextAnchors };
    },
    areEqual: (previous, next) => previous.revision === next.revision && previous.sequence === next.sequence,
    effects: (request) =>
      defer(() => {
        const resolved = dependencies.documentStore.resolveTextAnchors(request.anchors.map((entry) => entry.anchor));
        const ranges = new Map(request.anchors.map((entry, index) => [entry.threadId, resolved[index] ?? null]));
        if (sameRanges(ranges, request.current)) return EMPTY;
        return of<EditorEvent>({ kind: "textAnchorsResolved", ranges });
      }).pipe(
        catchError((error: unknown) => {
          dependencies.reportError(error, "resolving text anchors");
          return of<EditorEvent>({ kind: "feedbackFailed", context: "Finding the text comments point to", message: messageOf(error) });
        }),
      ),
  });
}

function encodeTarget(target: Extract<PendingDiscussionRequest["command"], { kind: "createThread" }>["target"], documentStore: DocumentStore): CommentTarget {
  switch (target.kind) {
    case "slide":
      return { kind: "slide" };
    case "element":
      return { kind: "element", elementId: target.elementId };
    case "text": {
      const anchor = documentStore.encodeTextAnchor(target.range);
      if (anchor === null) return { kind: "element", elementId: target.elementId };
      return { kind: "text", elementId: target.elementId, anchor, quotedText: target.quotedText };
    }
    default:
      return assertNever(target);
  }
}

type AnchorRequest = Readonly<{
  revision: number;
  sequence: number;
  anchors: readonly Readonly<{ threadId: ThreadId; anchor: EncodedTextAnchor }>[];
  current: ReadonlyMap<ThreadId, TextRange | null>;
}>;

function sameRanges(first: ReadonlyMap<ThreadId, TextRange | null>, second: ReadonlyMap<ThreadId, TextRange | null>): boolean {
  if (first.size !== second.size) return false;
  for (const [threadId, range] of first) {
    if (!second.has(threadId)) return false;
    const other = second.get(threadId) ?? null;
    if (range === null || other === null) {
      if (range !== other) return false;
      continue;
    }
    if (range.start !== other.start || range.end !== other.end || JSON.stringify(range.target) !== JSON.stringify(other.target)) return false;
  }
  return true;
}
