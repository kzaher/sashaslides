// COMMENTS AS REQUESTS TO AN AUTHORITY (contracts/discussion.ts). The editor never edits the
// discussion: it composes a thread (target, region, markings, text), queues `DiscussionRequest`
// drafts in `pendingDiscussion`, and the discussion feedback encodes text anchors and submits them.
// The authority's log comes back as `discussionChanged`; each verdict as `discussionSettled`.
//
// SENT IS AN EVENT. The discussion feedback reports `discussionRequestSent` as it hands a request to
// the authority, and `markDiscussionSent` moves it from `pendingDiscussion` to `inFlightDiscussion`.
// The feedback keys its effects by request id over both lists, so the move never restarts a
// submission.

import {
  assertNever,
  type Box,
  type CommentTargetDraft,
  type DiscussionCommandDraft,
  type DiscussionRequestId,
  type DiscussionOutcome,
  type EditorState,
  type ElementId,
  type FractionalRegion,
  type SlideId,
  type TextRange,
  type ThreadId,
} from "../../contracts/index.ts";
import { findElement, findSlide, slideBox } from "./document-lookup.ts";
import { optimisticText, raiseNotice } from "./editor-queue.ts";
import { elementIdOfTarget } from "./editor-selection.ts";
import { createIdMinter } from "./id-minter.ts";
import { plainTextOfFlat } from "./text-model.ts";

export function openComposer(
  state: EditorState,
  options: Readonly<{ slideId: SlideId; elementId: ElementId | null; textRange: TextRange | null; region: FractionalRegion | null }>,
): EditorState {
  if (findSlide(state.document, options.slideId) === null) return state;
  const target = composerTarget(state, options);
  return {
    ...state,
    tool: { kind: "select" },
    ui: {
      ...state.ui,
      commentsOpen: true,
      composer: { kind: "composing", slideId: options.slideId, target, region: options.region, markings: [], draft: "" },
    },
  };
}

/** What a region and markings are fractions of: the target element's frame, or the slide. */
export function referenceBoxForComposer(state: EditorState): Box {
  const composer = state.ui.composer;
  switch (composer.kind) {
    case "closed":
      return slideBox(state.document);
    case "composing":
      return frameAtCreation(state, composer.slideId, composer.target) ?? slideBox(state.document);
    default:
      return assertNever(composer);
  }
}

export function submitComment(state: EditorState): EditorState {
  const composer = state.ui.composer;
  switch (composer.kind) {
    case "closed":
      return state;
    case "composing": {
      const body = composer.draft.trim();
      if (body.length === 0) return state;
      const minter = createIdMinter(state.idSeed);
      const threadId = minter.next("thread");
      const messageId = minter.next("message");
      const queued = queueDiscussion(
        { ...state, idSeed: minter.seed() },
        {
          kind: "createThread",
          threadId,
          slideId: composer.slideId,
          target: composer.target,
          region: composer.region,
          elementFrameAtCreation: frameAtCreation(state, composer.slideId, composer.target),
          markings: composer.markings,
          messageId,
          body,
        },
      );
      return { ...queued, ui: { ...queued.ui, composer: { kind: "closed" }, focusedThreadId: threadId } };
    }
    default:
      return assertNever(composer);
  }
}

export function queueDiscussion(state: EditorState, command: DiscussionCommandDraft): EditorState {
  const minter = createIdMinter(state.idSeed);
  const requestId = minter.next("discussionRequest");
  return { ...state, idSeed: minter.seed(), pendingDiscussion: [...state.pendingDiscussion, { requestId, command }] };
}

export function replyToThread(state: EditorState, threadId: ThreadId, body: string): EditorState {
  const text = body.trim();
  if (text.length === 0) return state;
  const minter = createIdMinter(state.idSeed);
  const messageId = minter.next("message");
  return queueDiscussion({ ...state, idSeed: minter.seed() }, { kind: "reply", threadId, messageId, body: text });
}

export function reduceDiscussionSettled(state: EditorState, outcome: DiscussionOutcome): EditorState {
  const settled: EditorState = {
    ...state,
    pendingDiscussion: state.pendingDiscussion.filter((request) => request.requestId !== outcome.requestId),
    inFlightDiscussion: state.inFlightDiscussion.filter((request) => request.requestId !== outcome.requestId),
  };
  switch (outcome.kind) {
    case "applied":
      return settled;
    case "rejected":
      return raiseNotice(settled, { tone: "warning", message: `The comment was not saved: ${outcome.message}`, action: null });
    default:
      return assertNever(outcome);
  }
}

/** The feedback submitted this request (see the header); unknown or already moved ids change nothing. */
export function markDiscussionSent(state: EditorState, requestId: DiscussionRequestId): EditorState {
  const sent = state.pendingDiscussion.find((request) => request.requestId === requestId);
  if (sent === undefined) return state;
  return {
    ...state,
    pendingDiscussion: state.pendingDiscussion.filter((request) => request.requestId !== requestId),
    inFlightDiscussion: [...state.inFlightDiscussion, sent],
  };
}

function composerTarget(
  state: EditorState,
  options: Readonly<{ slideId: SlideId; elementId: ElementId | null; textRange: TextRange | null }>,
): CommentTargetDraft {
  const range = options.textRange;
  const rangeElementId = range === null ? null : elementIdOfTarget(range.target);
  if (range !== null && rangeElementId !== null) {
    const items = optimisticText(state, range.target);
    const quotedText = items === null ? "" : plainTextOfFlat(items, Math.min(range.start, range.end), Math.max(range.start, range.end));
    return { kind: "text", elementId: rangeElementId, range, quotedText };
  }
  if (options.elementId !== null) return { kind: "element", elementId: options.elementId };
  return { kind: "slide" };
}

/** The target element's frame as a box (unrotated: regions are fractions of the frame), or null. */
function frameAtCreation(state: EditorState, slideId: SlideId, target: CommentTargetDraft): Box | null {
  const slide = findSlide(state.document, slideId);
  if (slide === null) return null;
  switch (target.kind) {
    case "slide":
      return null;
    case "element":
    case "text": {
      const element = findElement(slide, target.elementId);
      if (element === null) return null;
      return { x: element.frame.x, y: element.frame.y, width: element.frame.width, height: element.frame.height };
    }
    default:
      return assertNever(target);
  }
}
