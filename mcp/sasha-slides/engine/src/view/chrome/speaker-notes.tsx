// SPEAKER NOTES AND NOTICES: two small glass surfaces. The notes panel under the canvas shows the
// current slide's notes, drawn by the shared paragraph renderer at a reading size, and becomes the
// inline editor when the selection is in them -- a click (or Enter) on the notes puts the caret
// there through `textEditingRequested`. Notices stack at the bottom left, one glass card each,
// with an optional action and a dismiss button; their tone is a data attribute the shared stylesheet
// colours (SPEC.md section 9).

import { memo, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { Notice, NoticeAction } from "../../contracts/editor-state.ts";
import type { TextTarget } from "../../contracts/selection.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { arrayItemsEqual, shallowEqual, useEditorSelector, useEditorServices, useGestureContext } from "../application/editor-services.tsx";
import { handleOpenInNewTab } from "../application/gesture-handlers.ts";
import { sameTextTarget } from "../render/element-view.tsx";
import { slideNumberLookup } from "../render/static-slide.tsx";
import { textStyleContextOf } from "../render/text-layout.ts";
import { TextParagraphs } from "../render/text-paragraphs.tsx";
import { InlineTextEditor } from "../text/inline-text-editor.tsx";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { Icon } from "./icons.tsx";

/** Notes are stored in slide units; the panel reads them at this fraction. */
const NOTES_READING_SCALE = 0.6;
/** Notes read in the chrome's ink, so they stay readable in both schemes. */
const NOTES_INK = "var(--sasha-text)";

export const SpeakerNotes = memo(function SpeakerNotes(): ReactElement | null {
  const view = useEditorSelector((state) => ({ document: state.document, currentSlideId: state.currentSlideId, selection: state.selection, open: state.ui.speakerNotesOpen }), shallowEqual);
  const services = useEditorServices();
  if (!view.open) return null;
  const index = view.document.slides.findIndex((slide) => slide.id === view.currentSlideId);
  const slide = view.document.slides[index];
  if (slide === undefined) return null;
  const target: TextTarget = { kind: "speakerNotes", slideId: slide.id };
  const editing = view.selection.kind === "text" && sameTextTarget(view.selection.target, target);
  const styleContext = textStyleContextOf({ theme: view.document.theme, element: null });
  const slideNumberOf = slideNumberLookup(view.document);
  const empty = slide.speakerNotes.paragraphs.every((paragraph) => paragraph.runs.length === 0);
  const startEditing = (): void => services.system.dispatch({ kind: "textEditingRequested", target, at: "end" });
  return (
    <section className={`${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.notes}`} aria-label="Speaker notes">
      <div className={VIEW_CLASS.fieldRow}>
        <Icon name="notes" />
        <strong>Speaker notes</strong>
        <button type="button" className={TIDEPOOL_CLASS.iconButton} style={{ marginInlineStart: "auto" }} aria-label="Hide speaker notes" onClick={() => services.system.dispatch({ kind: "panelToggled", panel: "speakerNotes" })}>
          <Icon name="close" />
        </button>
      </div>
      <div className={VIEW_CLASS.notesBody} style={{ zoom: NOTES_READING_SCALE }}>
        {editing ? (
          <InlineTextEditor target={target} body={slide.speakerNotes} styleContext={styleContext} slideNumber={index + 1} slideNumberOf={slideNumberOf} inkColour={NOTES_INK} />
        ) : (
          <div
            role="button"
            tabIndex={0}
            aria-label={empty ? "Add speaker notes" : "Edit speaker notes"}
            className={VIEW_CLASS.notesReader}
            onClick={startEditing}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              startEditing();
            }}
          >
            {empty ? (
              <p className={TIDEPOOL_CLASS.muted} style={{ zoom: 1 / NOTES_READING_SCALE, margin: 0 }}>
                Click to add notes for this slide.
              </p>
            ) : (
              <TextParagraphs body={slide.speakerNotes} styleContext={styleContext} slideNumber={index + 1} slideNumberOf={slideNumberOf} fontScale={1} renderGeneration={0} inkColour={NOTES_INK} />
            )}
          </div>
        )}
      </div>
    </section>
  );
});

export const Notices = memo(function Notices(): ReactElement | null {
  const notices = useEditorSelector((state) => state.notices, arrayItemsEqual);
  const gesture = useGestureContext();
  if (notices.length === 0) return null;
  return (
    <div className={VIEW_CLASS.notices} role="region" aria-label="Notices" aria-live="polite">
      {notices.map((notice) => (
        <NoticeCard key={notice.id} notice={notice} onAction={() => runNoticeAction({ notice, gesture })} onDismiss={() => gesture.system.dispatch({ kind: "noticeDismissed", noticeId: notice.id })} />
      ))}
    </div>
  );
});

function NoticeCard(properties: Readonly<{ notice: Notice; onAction: () => void; onDismiss: () => void }>): ReactElement {
  const notice = properties.notice;
  return (
    <div className={`${TIDEPOOL_CLASS.notice} ${VIEW_CLASS.noticeRow}`} data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
      <p>{notice.message}</p>
      {notice.action === null ? null : (
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={properties.onAction}>
          {noticeActionLabel(notice.action)}
        </button>
      )}
      <button type="button" className={TIDEPOOL_CLASS.iconButton} aria-label="Dismiss" onClick={properties.onDismiss}>
        <Icon name="close" />
      </button>
    </div>
  );
}

/** A notice's action: opening a tab must happen inside the click; everything else is the reducer's. */
function runNoticeAction(options: Readonly<{ notice: Notice; gesture: ReturnType<typeof useGestureContext> }>): void {
  const action = options.notice.action;
  if (action === null) return;
  switch (action.kind) {
    case "openInNewTab":
      handleOpenInNewTab(options.gesture);
      options.gesture.system.dispatch({ kind: "noticeDismissed", noticeId: options.notice.id });
      return;
    case "undoAgentEdits":
    case "retryUpload":
    case "reviewTransitionScript":
      options.gesture.system.dispatch({ kind: "noticeActionChosen", noticeId: options.notice.id });
      return;
    default:
      assertNever(action);
  }
}

export function noticeActionLabel(action: NoticeAction): string {
  switch (action.kind) {
    case "undoAgentEdits":
      return `Undo ${action.agentName}'s edit`;
    case "retryUpload":
      return "Try again";
    case "reviewTransitionScript":
      return "Review it";
    case "openInNewTab":
      return "Open in a new tab";
    default:
      return assertNever(action);
  }
}
