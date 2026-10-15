// THE EDITOR'S REDUCER: `(EditorState, EditorEvent) -> EditorState`, pure and replayable. One
// exhaustive switch over the event union delegates to the file that owns each concern (gestures,
// text, arrange, clipboard, slides, comments, uploads, the store's changes), so adding an event is a
// compile error here until it is handled.
//
// Never a clock and never a random source: ids come from `idSeed`, times are stamped by the stores,
// timers are feedbacks. Replaying the event log from the same initial state reproduces the same state,
// ids included -- a test replays a whole session to prove it.

import {
  assertNever,
  type EditorEvent,
  type EditorState,
  type ElementPatch,
  type NoticeId,
  type Point,
  type ShapePreset,
} from "../../contracts/index.ts";
import { addAnimation, chooseAnimationStep, endBuildPreview, moveAnimationSteps, patchAnimationStep, previewBuilds, removeAnimationStep, surviveAnimationChoice } from "./animations.ts";
import { reduceArrange, editFrameField, nudgeSelection } from "./arrange.ts";
import { commentingRefusal, editingRefusal } from "./access.ts";
import { cutSelection, pasteContent } from "./clipboard.ts";
import {
  announceAgentScripts,
  newUnapprovedAgentScripts,
  reduceAgentRevertSettled,
  reduceCollaborationChanged,
  reduceCollaborationNotice,
  requestAgentRevert,
  requestReconnect,
} from "./collaboration.ts";
import { markDiscussionSent, openComposer, queueDiscussion, reduceDiscussionSettled, replyToThread, submitComment } from "./comments.ts";
import { reduceDocumentChanged, reduceEditSettled } from "./document-changes.ts";
import { findElementPath, findSlide, leavesOf, textShapeOf } from "./document-lookup.ts";
import { queueEnvelope, queueHistory, raiseNotice, refuse } from "./editor-queue.ts";
import { perElementPatches } from "./element-patches.ts";
import { elementIdOfTarget, selectedElements, selectElements, textSelectionOf } from "./editor-selection.ts";
import { captureFormat } from "./format-painter.ts";
import { scaleFor } from "./initial-editor-state.ts";
import { chordToIntent, type KeyIntent } from "./keyboard.ts";
import { reduceSlideLayoutChosen } from "./layout-remap.ts";
import { withRecentColour } from "./recent-colours.ts";
import { reduceLayoutMeasured } from "./measured-layout.ts";
import { cancelGesture, gestureIsIdle, reducePointerDown, reducePointerMove, reducePointerUp } from "./pointer-gestures.ts";
import {
  activateSlide,
  deleteSelection,
  dragSlidesOver,
  duplicateSelection,
  endPresentation,
  endSlideDrag,
  goToSlide,
  newSlide,
  requestPresentation,
  selectAll,
  selectSibling,
  selectSlides,
  setSlideProperties,
  startSlideDrag,
} from "./slides.ts";
import {
  applyParagraphStyle,
  applyRunStyle,
  changeListLevel,
  changeTextSelection,
  endComposition,
  endTextEditing,
  insertAutomaticTextAtCaret,
  rangeOf,
  reduceTextInput,
  resolvedRunStyle,
  startComposition,
  startTextEditing,
  toggleList,
  toggledPatch,
} from "./text-editing.ts";
import { patchTableCells } from "./table-cells.ts";
import { approveScript, changeScriptDraft, openScriptEditor, previewTransition, reloadScript, saveScript } from "./transition-scripts.ts";
import { abandonUpload, reduceAssetStored, reduceAssetStoreFailed, retryUpload, startUpload } from "./uploads.ts";
import { flattenBody, runStyleAt } from "./text-model.ts";

export function reduceEditor(state: EditorState, event: EditorEvent): EditorState {
  return surviveAnimationChoice({ before: state, after: reduceEvent(state, event) });
}

/** What a chord's intent does here; the clipboard and Present are the view's (keyboard.ts header). */
export function applyKeyIntent(state: EditorState, intent: KeyIntent | null): EditorState {
  if (intent === null) return state;
  switch (intent.kind) {
    case "undo":
      return queueHistory(state, "undo");
    case "redo":
      return queueHistory(state, "redo");
    case "copy":
    case "cut":
    case "paste":
    case "present":
      return state;
    case "duplicate":
      return duplicateSelection(state);
    case "delete":
      return deleteSelection(state);
    case "selectAll":
      return selectAll(state);
    case "nudge":
      return nudgeSelection(state, intent.deltaX, intent.deltaY);
    case "arrange":
      return reduceArrange(state, intent.action);
    case "enter":
      return enterSelection(state);
    case "escape":
      return escape(state);
    case "selectSibling":
      return selectSibling(state, intent.direction);
    case "listLevel":
      return changeListLevel(state, intent.delta);
    case "insertTabCharacter":
      return reduceTextInput(state, { kind: "insertTab", outdent: false });
    case "toggleFormat":
      return textSelectionOf(state.selection) === null ? toggleFormatOnElements(state, intent.format) : reduceTextInput(state, { kind: "toggleFormat", format: intent.format });
    case "alignParagraphs":
      return applyParagraphStyle(state, { alignment: intent.alignment }, []);
    case "toggleList":
      return toggleList(state, intent.list);
    case "openLinkEditor":
      return { ...state, chrome: { ...state.chrome, dialog: { kind: "linkEditor" } } };
    case "newSlide":
      return newSlide(state, null);
    case "comment":
      return commentOnSelection(state);
    case "showKeyboardShortcuts":
      return { ...state, chrome: { ...state.chrome, dialog: { kind: "keyboardShortcuts" } } };
    case "goToSlide":
      return goToSlide(state, intent.step);
    default:
      return assertNever(intent);
  }
}

function reduceEvent(state: EditorState, event: EditorEvent): EditorState {
  switch (event.kind) {
    // --- canvas pointer
    case "canvasPointerDown":
      return reducePointerDown(withPointer(state, event.sample.slidePoint), event);
    case "canvasPointerMove":
      return reducePointerMove(withPointer(state, event.sample.slidePoint), event.sample, event.modifiers);
    case "canvasPointerUp":
      return reducePointerUp(state, event.sample, event.modifiers);
    case "canvasPointerCancelled":
      return cancelGesture(state);
    case "canvasPointerLeft":
      return withPointer(state, null);
    // --- keyboard
    case "keyPressed":
      return applyKeyIntent(state, chordToIntent(event.chord, state));
    // --- text editing
    case "textEditingRequested":
      return startTextEditing(state, event.target, event.at);
    case "textInput":
      return reduceTextInput(state, event.input);
    case "textSelectionChanged":
      return changeTextSelection(state, event.anchor, event.focus);
    case "compositionStarted":
      return startComposition(state, event.anchor, event.focus);
    case "compositionEnded":
      return endComposition(state, event.text);
    case "textEditingEnded":
      return endTextEditing(state);
    case "layoutMeasured":
      return reduceLayoutMeasured(state, event.slideId, event.elementId, event.measurement);
    // --- toolbar and properties panel
    case "toolChosen":
      return chooseTool(state, event.tool);
    case "formatPainterRequested": {
      const captured = captureFormat(state);
      return captured === null ? state : { ...state, tool: { kind: "formatPainter", captured, sticky: event.sticky } };
    }
    case "elementPatchRequested":
      return patchSelectedElements(state, event.patch);
    case "tableCellPatchRequested":
      return patchTableCells(state, event.patch);
    case "runStyleRequested":
      return applyRunStyle(state, event.patch, event.clear);
    case "paragraphStyleRequested":
      return applyParagraphStyle(state, event.patch, event.clear);
    case "listToggled":
      return toggleList(state, event.list);
    case "listIndentChanged":
      return changeListLevel(state, event.delta);
    case "frameFieldEdited":
      return editFrameField(state, event.field, event.value);
    case "aspectRatioLockToggled":
      return { ...state, chrome: { ...state.chrome, aspectRatioLocked: !state.chrome.aspectRatioLocked } };
    case "arrangeRequested":
      return reduceArrange(state, event.action);
    case "shapePresetChanged":
      return changePreset(state, event.preset);
    case "automaticTextInsertRequested":
      return insertAutomaticTextAtCaret(state);
    // --- slides and filmstrip
    case "slideActivated":
      return activateSlide(state, event.slideId);
    case "slidesSelected":
      return selectSlides(state, event.slideIds, event.mode);
    case "newSlideRequested":
      return newSlide(state, event.layoutId);
    case "duplicateRequested":
      return duplicateSelection(state);
    case "deleteRequested":
      return textSelectionOf(state.selection) === null ? deleteSelection(state) : reduceTextInput(state, { kind: "deleteForward", unit: "character" });
    case "selectAllRequested":
      return selectAll(state);
    case "slideDragStarted":
      return startSlideDrag(state, event.slideIds);
    case "slideDragOver":
      return dragSlidesOver(state, event.dropAfter);
    case "slideDragEnded":
      return endSlideDrag(state, event.dropped);
    case "slidePropertiesRequested":
      return setSlideProperties(state, event.patch);
    case "slideLayoutChosen":
      return reduceSlideLayoutChosen(state, event.layoutId);
    // --- transition scripts
    case "transitionScriptEditorOpened":
      return openScriptEditor(state, { scriptId: event.scriptId, purpose: event.purpose });
    case "transitionScriptDraftChanged":
      return changeScriptDraft(state, event.draft);
    case "transitionScriptSaveRequested":
      return saveScript(state, event.overwrite);
    case "transitionScriptReloadRequested":
      return reloadScript(state);
    case "transitionScriptApproved":
      return approveScript(state, event.scriptId, event.fingerprint);
    case "transitionPreviewRequested":
      return previewTransition(state, event.slideId);
    case "transitionPreviewEnded":
      return { ...state, chrome: { ...state.chrome, transitionPreview: null } };
    // --- builds: the Animate tab (animations.ts)
    case "animationAddRequested":
      return addAnimation(state, event.effect);
    case "animationStepSelected":
      return chooseAnimationStep(state, event.stepId);
    case "animationStepPatchRequested":
      return patchAnimationStep(state, { stepId: event.stepId, patch: event.patch });
    case "animationStepsMoved":
      return moveAnimationSteps(state, { stepIds: event.stepIds, after: event.after });
    case "animationStepRemoved":
      return removeAnimationStep(state, event.stepId);
    case "buildPreviewRequested":
      return previewBuilds(state, event.slideId);
    case "buildPreviewEnded":
      return endBuildPreview(state);
    // --- clipboard
    case "copied":
      return { ...state, clipboard: { pasteCascade: null } };
    case "cutRequested":
      return cutSelection({ ...state, clipboard: { pasteCascade: null } });
    case "pasteReceived":
      return pasteContent(state, event.content, event.at);
    case "clipboardUnavailable":
      return raiseNotice(state, {
        tone: "information",
        message: `Use the keyboard shortcut to ${event.operation} here: this window cannot reach the clipboard from a menu.`,
        action: openInNewTabAction(state),
      });
    // --- history
    case "undoRequested":
      return queueHistory(state, "undo");
    case "redoRequested":
      return queueHistory(state, "redo");
    // --- images and assets
    case "imageFilesChosen": {
      const refusal = editingRefusal(state);
      return refusal === null ? startUpload(state, { files: event.files, at: event.at, destination: event.destination }) : refuse(state, refusal);
    }
    case "assetStored":
      return reduceAssetStored(state, event.uploadId, event.asset);
    case "assetStoreFailed":
      return reduceAssetStoreFailed(state, event.uploadId, event.message, event.willRetry);
    case "assetAvailable":
      return state.availableAssetIds.has(event.assetId) ? state : { ...state, availableAssetIds: new Set([...state.availableAssetIds, event.assetId]) };
    // --- comments and annotations
    case "commentComposerOpened":
      return openComposer(state, { slideId: event.slideId, elementId: event.elementId, textRange: event.textRange, region: event.region });
    case "commentDraftChanged":
      return updateComposer(state, (composer) => ({ ...composer, draft: event.draft, mentions: event.mentions }));
    case "markingDrawn":
      return updateComposer(state, (composer) => ({ ...composer, markings: [...composer.markings, event.marking] }));
    case "commentSubmitted":
      return submitComment(state);
    case "commentComposerClosed":
      return { ...state, chrome: { ...state.chrome, composer: { kind: "closed" } } };
    case "threadFocused":
      return { ...state, chrome: { ...state.chrome, focusedThreadId: event.threadId } };
    case "threadReplied":
      return replyToThread(state, event.threadId, event.body, event.mentions);
    case "messageEdited":
      return queueDiscussion(state, { kind: "editMessage", threadId: event.threadId, messageId: event.messageId, body: event.body, mentions: event.mentions });
    case "messageDeleted":
      return queueDiscussion(state, { kind: "deleteMessage", threadId: event.threadId, messageId: event.messageId });
    case "threadResolved":
      return queueDiscussion(state, { kind: "resolveThread", threadId: event.threadId });
    case "threadReopened":
      return queueDiscussion(state, { kind: "reopenThread", threadId: event.threadId });
    case "threadDeleted":
      return queueDiscussion(state, { kind: "deleteThread", threadId: event.threadId });
    case "resolvedThreadsToggled":
      return { ...state, chrome: { ...state.chrome, showResolvedThreads: !state.chrome.showResolvedThreads } };
    // --- chrome
    case "menuOpened":
      return { ...state, chrome: { ...state.chrome, openMenu: event.menu, contextMenu: null } };
    case "menuClosed":
      return { ...state, chrome: { ...state.chrome, openMenu: null } };
    case "contextMenuOpened":
      return { ...state, chrome: { ...state.chrome, contextMenu: { at: event.at, scope: event.scope }, openMenu: null } };
    case "contextMenuClosed":
      return { ...state, chrome: { ...state.chrome, contextMenu: null } };
    case "dialogOpened":
      return { ...state, chrome: { ...state.chrome, dialog: event.dialog, openMenu: null, contextMenu: null } };
    case "dialogClosed":
      return { ...state, chrome: { ...state.chrome, dialog: { kind: "none" } } };
    case "deckRenamed":
      return renameDeck(state, event.title);
    case "propertiesTabChosen":
      return { ...state, chrome: { ...state.chrome, propertiesTab: event.tab, propertiesPanelOpen: true } };
    case "panelToggled":
      return togglePanel(state, event.panel);
    case "noticeDismissed":
      return dismissNotice(state, event.noticeId);
    case "noticeActionChosen":
      return chooseNoticeAction(state, event.noticeId);
    case "viewportResized":
      return { ...state, viewport: { ...state.viewport, containerSize: event.size, scale: scaleFor({ zoom: state.viewport.zoom, containerSize: event.size, pageSize: state.document.pageSize }) } };
    case "zoomRequested":
      return { ...state, viewport: { ...state.viewport, zoom: event.zoom, scale: scaleFor({ zoom: event.zoom, containerSize: state.viewport.containerSize, pageSize: state.document.pageSize }) } };
    case "scrolled":
      return { ...state, viewport: { ...state.viewport, scroll: event.scroll } };
    case "presentRequested":
      return requestPresentation(state, event.from, event.withSpeakerView);
    case "presentationEnded":
      return endPresentation(state, event.lastSlideId);
    // --- effect results
    case "editSettled":
      return reduceEditSettled(state, event.settlement);
    case "documentChanged": {
      const changed = reduceDocumentChanged(state, event.change);
      const before = state.document.transitionScripts;
      const after = event.change.snapshot.transitionScripts;
      return before === after ? changed : announceAgentScripts(changed, newUnapprovedAgentScripts({ before, after }));
    }
    case "discussionChanged":
      return { ...state, discussion: event.snapshot };
    case "discussionRequestSent":
      return markDiscussionSent(state, event.requestId);
    case "discussionSettled":
      return reduceDiscussionSettled(state, event.outcome);
    case "textAnchorsResolved":
      return { ...state, resolvedTextAnchors: event.ranges };
    case "peersChanged":
      // Peers are OTHER people. After a reload or a deck switch this person's previous connection
      // lingers in awareness under an old client id until it times out; it is still this person.
      return { ...state, peers: event.peers.filter((peer) => peer.person.id !== state.me.id) };
    case "feedbackFailed":
      return raiseNotice(state, { tone: "warning", message: `${event.context} failed: ${event.message}`, action: null });
    case "noticeExpired":
      return { ...state, notices: state.notices.filter((notice) => notice.id !== event.noticeId) };
    case "agentEditObserved":
      return raiseNotice(state, {
        tone: "information",
        message: `${event.agentName} edited the deck: ${event.summary}`,
        action: { kind: "undoAgentEdits", agentSessionId: event.agentSessionId, agentName: event.agentName },
      });
    // --- collaboration (collaboration.ts)
    case "collaborationChanged":
      return reduceCollaborationChanged(state, event.status);
    case "collaborationNoticeReceived":
      return reduceCollaborationNotice(state, event.notice);
    case "reconnectRequested":
      return requestReconnect(state);
    case "agentRevertSettled":
      return reduceAgentRevertSettled(state, { agentSessionId: event.agentSessionId, outcome: event.outcome });
    case "recentColourUsed":
      return { ...state, chrome: { ...state.chrome, recentColours: withRecentColour(state.chrome.recentColours, event.colour) } };
    default:
      return assertNever(event);
  }
}

/** Escape peels one layer: gesture, menus, dialog, composer, text, group, tool, selection. */
function escape(state: EditorState): EditorState {
  if (!gestureIsIdle(state.gesture)) return cancelGesture(state);
  if (state.chrome.openMenu !== null || state.chrome.contextMenu !== null) return { ...state, chrome: { ...state.chrome, openMenu: null, contextMenu: null } };
  if (dialogIsOpen(state)) return { ...state, chrome: { ...state.chrome, dialog: { kind: "none" } } };
  if (composerIsOpen(state)) return { ...state, chrome: { ...state.chrome, composer: { kind: "closed" } } };
  if (textSelectionOf(state.selection) !== null) return endTextEditing(state);
  if (state.enteredGroupId !== null) return leaveGroup(state, state.enteredGroupId);
  if (!toolIsSelect(state)) return { ...state, tool: { kind: "select" } };
  return selectElements(state, []);
}

function leaveGroup(state: EditorState, groupId: NonNullable<EditorState["enteredGroupId"]>): EditorState {
  const slide = state.currentSlideId === null ? null : findSlide(state.document, state.currentSlideId);
  const path = slide === null ? null : findElementPath(slide, groupId);
  const parent = path?.at(-2) ?? null;
  return selectElements({ ...state, enteredGroupId: parent?.id ?? null }, [groupId]);
}

/** Enter: edit the single selected element's text (a table's first cell), or enter the selected group. */
function enterSelection(state: EditorState): EditorState {
  const selected = selectedElements(state);
  const only = selected !== null && selected.elements.length === 1 ? selected.elements[0] : undefined;
  if (selected === null || only === undefined) return state;
  switch (only.kind) {
    case "group": {
      const first = only.children[0];
      return selectElements({ ...state, enteredGroupId: only.id }, first === undefined ? [] : [first.id]);
    }
    case "shape":
      return startTextEditing(state, { kind: "element", slideId: selected.slide.id, elementId: only.id }, "end");
    case "table": {
      const rowId = only.rows[0]?.id;
      const columnId = only.columns[0]?.id;
      if (rowId === undefined || columnId === undefined) return state;
      return startTextEditing(state, { kind: "tableCell", slideId: selected.slide.id, elementId: only.id, cell: { rowId, columnId } }, "end");
    }
    case "image":
    case "line":
    case "unsupported":
      return state;
    default:
      return assertNever(only);
  }
}

/** Primary+Alt+M: a comment on the text range, the element, or the slide. */
function commentOnSelection(state: EditorState): EditorState {
  const slideId = state.currentSlideId;
  if (slideId === null) return state;
  const text = textSelectionOf(state.selection);
  if (text !== null) {
    const range = rangeOf(text);
    const elementId = elementIdOfTarget(text.target);
    return openComposer(state, { slideId, elementId, textRange: range.end > range.start ? { target: text.target, start: range.start, end: range.end } : null, region: null });
  }
  const selected = selectedElements(state);
  return openComposer(state, { slideId, elementId: selected?.elements[0]?.id ?? null, textRange: null, region: null });
}

/** Primary+B with elements selected: toggled from the first text body's first character. */
function toggleFormatOnElements(state: EditorState, format: "bold" | "italic" | "underline" | "strikethrough"): EditorState {
  const selected = selectedElements(state);
  if (selected === null) return state;
  const shape = selected.elements.flatMap(leavesOf).map(textShapeOf).find((candidate) => candidate !== null) ?? null;
  if (shape === null) return state;
  const style = resolvedRunStyle(state, { kind: "element", slideId: selected.slide.id, elementId: shape.id }, runStyleAt(flattenBody(shape.text), 1));
  return applyRunStyle(state, toggledPatch(style, format), []);
}

function chooseTool(state: EditorState, tool: EditorState["tool"]): EditorState {
  const idle: EditorState = { ...state, tool, gesture: { kind: "idle" } };
  switch (tool.kind) {
    case "select":
    case "formatPainter":
    case "pan":
      return idle;
    case "shape":
    case "line":
    case "table": {
      const refusal = editingRefusal(state);
      if (refusal !== null) return refuse({ ...state, tool: { kind: "select" } }, refusal);
      return textSelectionOf(idle.selection) === null ? idle : endTextEditing(idle);
    }
    case "comment":
    case "annotate": {
      const refusal = commentingRefusal(state);
      if (refusal !== null) return refuse({ ...state, tool: { kind: "select" } }, refusal);
      return textSelectionOf(idle.selection) === null ? idle : endTextEditing(idle);
    }
    default:
      return assertNever(tool);
  }
}

/**
 * A panel field for the selected elements' leaves, merged per element (element-patches.ts), in one
 * envelope; the model skips fields a kind does not have.
 */
function patchSelectedElements(state: EditorState, patch: ElementPatch): EditorState {
  const selected = selectedElements(state);
  if (selected === null) return state;
  const groups = perElementPatches({ leaves: selected.elements.flatMap(leavesOf), patch });
  return queueEnvelope(state, {
    commands: groups.map((group) => ({ kind: "updateElements", slideId: selected.slide.id, elementIds: group.elementIds, patch: group.patch })),
    selectionAfter: state.selection,
    mergeWithPrevious: false,
  });
}

function changePreset(state: EditorState, preset: ShapePreset): EditorState {
  const selected = selectedElements(state);
  if (selected === null) return state;
  const shapeIds = selected.elements.flatMap(leavesOf).flatMap((leaf) => textShapeOf(leaf)?.id ?? []);
  if (shapeIds.length === 0) return state;
  return queueEnvelope(state, {
    commands: [{ kind: "updateElements", slideId: selected.slide.id, elementIds: shapeIds, patch: { preset } }],
    selectionAfter: state.selection,
    mergeWithPrevious: false,
  });
}

function updateComposer(
  state: EditorState,
  change: (composer: Extract<EditorState["chrome"]["composer"], { kind: "composing" }>) => Extract<EditorState["chrome"]["composer"], { kind: "composing" }>,
): EditorState {
  const composer = state.chrome.composer;
  switch (composer.kind) {
    case "closed":
      return state;
    case "composing":
      return { ...state, chrome: { ...state.chrome, composer: change(composer) } };
    default:
      return assertNever(composer);
  }
}

function togglePanel(state: EditorState, panel: "properties" | "filmstrip" | "speakerNotes" | "comments"): EditorState {
  switch (panel) {
    case "properties":
      return { ...state, chrome: { ...state.chrome, propertiesPanelOpen: !state.chrome.propertiesPanelOpen } };
    case "filmstrip":
      return { ...state, chrome: { ...state.chrome, filmstripOpen: !state.chrome.filmstripOpen } };
    case "speakerNotes":
      return { ...state, chrome: { ...state.chrome, speakerNotesOpen: !state.chrome.speakerNotesOpen } };
    case "comments":
      return { ...state, chrome: { ...state.chrome, commentsOpen: !state.chrome.commentsOpen } };
    default:
      return assertNever(panel);
  }
}

function dismissNotice(state: EditorState, noticeId: NoticeId): EditorState {
  const notice = state.notices.find((candidate) => candidate.id === noticeId);
  if (notice === undefined) return state;
  const removed: EditorState = { ...state, notices: state.notices.filter((candidate) => candidate.id !== noticeId) };
  const action = notice.action;
  if (action === null) return removed;
  switch (action.kind) {
    case "retryUpload":
      return abandonUpload(removed, action.uploadId);
    case "retryDiscussion":
    case "undoAgentEdits":
    case "reviewTransitionScript":
    case "openInNewTab":
      return removed;
    default:
      return assertNever(action);
  }
}

function chooseNoticeAction(state: EditorState, noticeId: NoticeId): EditorState {
  const notice = state.notices.find((candidate) => candidate.id === noticeId);
  if (notice === undefined || notice.action === null) return state;
  const removed: EditorState = { ...state, notices: state.notices.filter((candidate) => candidate.id !== noticeId) };
  const action = notice.action;
  switch (action.kind) {
    case "retryUpload":
      return retryUpload(removed, action.uploadId);
    case "retryDiscussion":
      return queueDiscussion(removed, action.command);
    case "reviewTransitionScript":
      return openScriptEditor(removed, { scriptId: action.scriptId, purpose: "transition" });
    case "undoAgentEdits":
      return requestAgentRevert(removed, { agentSessionId: action.agentSessionId, agentName: action.agentName });
    case "openInNewTab":
      // The view's click handler opened the tab (BrowserCapabilities.openTab) before dispatching.
      return removed;
    default:
      return assertNever(action);
  }
}

function openInNewTabAction(state: EditorState): EditorState["notices"][number]["action"] {
  switch (state.embedding.kind) {
    case "addonDialog":
      return { kind: "openInNewTab" };
    case "webApplication":
      return null;
    default:
      return assertNever(state.embedding);
  }
}

function dialogIsOpen(state: EditorState): boolean {
  switch (state.chrome.dialog.kind) {
    case "none":
      return false;
    case "insertImage":
    case "insertTable":
    case "linkEditor":
    case "transitionScriptEditor":
    case "keyboardShortcuts":
    case "renameDeck":
    case "newSlideFromLayout":
      return true;
    default:
      return assertNever(state.chrome.dialog);
  }
}

function composerIsOpen(state: EditorState): boolean {
  switch (state.chrome.composer.kind) {
    case "closed":
      return false;
    case "composing":
      return true;
    default:
      return assertNever(state.chrome.composer);
  }
}

function toolIsSelect(state: EditorState): boolean {
  switch (state.tool.kind) {
    case "select":
      return true;
    case "shape":
    case "line":
    case "table":
    case "comment":
    case "annotate":
    case "pan":
    case "formatPainter":
      return false;
    default:
      return assertNever(state.tool);
  }
}

/** The hover pointer (EditorState `pointer`); the same state when it did not move. */
function withPointer(state: EditorState, pointer: Point | null): EditorState {
  const current = state.pointer;
  if (current === pointer || (current !== null && pointer !== null && current.x === pointer.x && current.y === pointer.y)) return state;
  return { ...state, pointer };
}

/** The rename dialog's title: one `setTitle` envelope when it is non-empty and new; the dialog closes either way. */
function renameDeck(state: EditorState, title: string): EditorState {
  const closed: EditorState = { ...state, chrome: { ...state.chrome, dialog: { kind: "none" } } };
  const trimmed = title.trim();
  if (trimmed.length === 0 || trimmed === state.document.title) return closed;
  return queueEnvelope(closed, { commands: [{ kind: "setTitle", title: trimmed }], selectionAfter: state.selection, mergeWithPrevious: false });
}
