// THE EDITOR, ASSEMBLED: the pure reducer, the starting state read from the stores, and every
// feedback with the dependencies the composition root injected (contracts/editor-system.ts). Nothing
// here reaches for a global: the stores, the scheduler, the presence channel, the deck server session,
// the clock for the event log and the error reporter all arrive as arguments, so a test builds the
// same system from fakes.

import { LOCAL_COLLABORATION_STATUS, type EditorDependencies, type EditorEvent, type EditorState, type RunningSystem } from "../contracts/index.ts";
import { initialEditorState } from "./editor/initial-editor-state.ts";
import { reduceEditor } from "./editor/reduce-editor.ts";
import { collaborationFeedback } from "./feedbacks/collaboration-feedbacks.ts";
import { discussionRequestsFeedback, textAnchorsFeedback } from "./feedbacks/discussion-feedbacks.ts";
import { applyEditsFeedback, storeChangesFeedback } from "./feedbacks/document-feedbacks.ts";
import { assetAvailabilityFeedback, noticeExpiryFeedback, presenceFeedback, uploadsFeedback } from "./feedbacks/scheduled-feedbacks.ts";
import { createSystem } from "./rxfeedback/create-system.ts";

/** Enough recent events to reconstruct a bug report's last few seconds of typing and dragging. */
export const EDITOR_EVENT_LOG_CAPACITY = 500;

export const createEditorSystem = (dependencies: EditorDependencies): RunningSystem<EditorState, EditorEvent> =>
  createSystem<EditorState, EditorEvent>({
    initial: initialEditorState({
      me: dependencies.me,
      sessionPrefix: dependencies.sessionPrefix,
      embedding: dependencies.embedding,
      document: dependencies.documentStore.snapshot(),
      discussion: dependencies.discussionStore.snapshot(),
      containerSize: { width: 0, height: 0 },
      collaboration: dependencies.collaboration?.status() ?? LOCAL_COLLABORATION_STATUS,
      recentColours: dependencies.recentColours,
    }),
    reduce: reduceEditor,
    feedbacks: [
      storeChangesFeedback(dependencies),
      applyEditsFeedback(dependencies),
      discussionRequestsFeedback(dependencies),
      textAnchorsFeedback(dependencies),
      uploadsFeedback(dependencies),
      assetAvailabilityFeedback(dependencies),
      presenceFeedback(dependencies),
      noticeExpiryFeedback(dependencies),
      collaborationFeedback(dependencies),
    ],
    onReducerError: (error, event) => dependencies.reportError(error, `reducing ${event.kind}`),
    onFeedbackError: (error, feedbackIndex) => dependencies.reportError(error, `editor feedback ${feedbackIndex} stopped`),
    eventLogCapacity: EDITOR_EVENT_LOG_CAPACITY,
    now: dependencies.now,
  });
