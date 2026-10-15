// THE EDITOR'S STARTING STATE and its viewport arithmetic. Pure: the tests' starting point and the
// composition root's, so a replay from it reproduces every id (the seed's counter starts at 0).

import {
  DOCUMENT_SCHEMA_VERSION,
  type EditorState,
  type InitialEditorState,
  type PageSize,
  type Size,
  type ZoomSetting,
} from "../../contracts/index.ts";
import { assertNever } from "../../contracts/index.ts";
import { raiseNotice } from "./editor-queue.ts";

/** Room left around the slide when it is fitted into the canvas, client pixels per side. */
export const FIT_MARGIN_CLIENT_PIXELS = 40;
/** The smallest client-pixels-per-unit the canvas uses, so a collapsed container never divides by zero. */
export const MINIMUM_SCALE = 0.05;

export const initialEditorState: InitialEditorState = (options) => {
  const state: EditorState = {
    me: options.me,
    idSeed: { sessionPrefix: options.sessionPrefix, counter: 0 },
    embedding: options.embedding,
    document: options.document,
    discussion: options.discussion,
    history: { canUndo: false, canRedo: false },
    currentSlideId: options.document.slides[0]?.id ?? null,
    selection: { kind: "none" },
    enteredGroupId: null,
    tool: { kind: "select" },
    gesture: { kind: "idle" },
    textEditing: { typingStyle: {}, composition: null, renderGeneration: 0 },
    viewport: {
      containerSize: options.containerSize,
      zoom: { kind: "fit" },
      scale: scaleFor({ zoom: { kind: "fit" }, containerSize: options.containerSize, pageSize: options.document.pageSize }),
      scroll: { x: 0, y: 0 },
    },
    clipboard: { pasteCascade: null },
    pendingEdits: [],
    inFlightCommandIds: [],
    pendingDiscussion: [],
    inFlightDiscussion: [],
    resolvedTextAnchors: new Map(),
    uploads: [],
    availableAssetIds: new Set(),
    measuredLayouts: new Map(),
    pointer: null,
    peers: [],
    collaboration: options.collaboration,
    pendingAgentReverts: [],
    chrome: {
      propertiesTab: "arrange",
      propertiesPanelOpen: true,
      filmstripOpen: true,
      speakerNotesOpen: false,
      commentsOpen: false,
      openMenu: null,
      contextMenu: null,
      dialog: { kind: "none" },
      composer: { kind: "closed" },
      focusedThreadId: null,
      showResolvedThreads: false,
      aspectRatioLocked: false,
      transitionPreview: null,
      recentColours: options.recentColours,
    },
    notices: [],
    presentation: null,
  };
  if (options.document.schemaVersion <= DOCUMENT_SCHEMA_VERSION) return state;
  return raiseNotice(state, { tone: "warning", message: "This deck was made with a newer version of Sasha, so it opens read-only.", action: null });
};

/** Client pixels per slide unit for a zoom setting in a container. */
export function scaleFor(options: Readonly<{ zoom: ZoomSetting; containerSize: Size; pageSize: PageSize }>): number {
  switch (options.zoom.kind) {
    case "fit": {
      const width = (options.containerSize.width - 2 * FIT_MARGIN_CLIENT_PIXELS) / options.pageSize.width;
      const height = (options.containerSize.height - 2 * FIT_MARGIN_CLIENT_PIXELS) / options.pageSize.height;
      return Math.max(MINIMUM_SCALE, Math.min(width, height));
    }
    case "fixed":
      return Math.max(MINIMUM_SCALE, options.zoom.scale);
    default:
      return assertNever(options.zoom);
  }
}
