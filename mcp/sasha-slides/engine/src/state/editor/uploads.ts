// IMAGES ON THEIR WAY INTO THE ASSET STORE (reducer side). Chosen, pasted or dropped files become
// `PendingUpload`s; the upload feedback (`uploadsFeedback` in feedbacks/scheduled-feedbacks.ts) stores
// the bytes with retries and a timeout on the scheduler and reports `assetStored` or
// `assetStoreFailed`. A stored asset turns into ONE envelope: the asset record (add-only, outside
// undo) plus what the user asked for -- a new image, an image fill, or a slide background.
//
// A failed upload stays listed (so "Retry" still has its bytes) with a notice offering the retry; the
// retry re-queues it under a FRESH upload id, because the feedback keys effects by id and a finished
// effect under a key that never left state would not run again.

import {
  assertNever,
  type AssetRecord,
  type ChosenImageFile,
  type DocumentCommand,
  type EditorState,
  type ElementId,
  type Point,
  type SlideId,
  type UploadDestination,
  type UploadId,
} from "../../contracts/index.ts";
import { findSlide, slideBox } from "./document-lookup.ts";
import { queueEnvelope, raiseNotice } from "./editor-queue.ts";
import { selectedElements } from "./editor-selection.ts";
import { createImage } from "./element-factory.ts";
import { createIdMinter } from "./id-minter.ts";

/** Attempts per upload, the first backoff and the per-attempt timeout (SPEC.md section 7, "Errors"). */
export const UPLOAD_ATTEMPTS = 3;
export const UPLOAD_FIRST_BACKOFF_MILLISECONDS = 500;
export const UPLOAD_ATTEMPT_TIMEOUT_MILLISECONDS = 20_000;
/** Several images dropped at once land in a short diagonal, this far apart, slide units. */
const DROP_SPACING_UNITS = 16;

export function startUpload(
  state: EditorState,
  options: Readonly<{ files: readonly ChosenImageFile[]; at: Point | null; destination: "newImage" | "fill" | "slideBackground" }>,
): EditorState {
  const slideId = state.currentSlideId;
  if (slideId === null || options.files.length === 0) return state;
  const minter = createIdMinter(state.idSeed);
  const centre = options.at ?? { x: slideBox(state.document).width / 2, y: slideBox(state.document).height / 2 };
  const selected = selectedElements(state);
  const uploads = options.files.map((file, index) => {
    const destination = destinationFor({ kind: options.destination, slideId, centre: { x: centre.x + index * DROP_SPACING_UNITS, y: centre.y + index * DROP_SPACING_UNITS }, elementIds: selected?.elements.map((element) => element.id) ?? [] });
    return { uploadId: minter.next("upload"), name: file.name, mediaType: file.mediaType, bytes: file.bytes, pixelWidth: file.pixelWidth, pixelHeight: file.pixelHeight, destination, attempt: 1 };
  });
  return { ...state, idSeed: minter.seed(), uploads: [...state.uploads, ...uploads] };
}

export function reduceAssetStored(state: EditorState, uploadId: UploadId, asset: AssetRecord): EditorState {
  const upload = state.uploads.find((candidate) => candidate.uploadId === uploadId);
  if (upload === undefined) return state;
  const withoutUpload: EditorState = {
    ...state,
    uploads: state.uploads.filter((candidate) => candidate.uploadId !== uploadId),
    availableAssetIds: new Set([...state.availableAssetIds, asset.id]),
    notices: state.notices.filter((notice) => !retriesUpload(notice.action, uploadId)),
  };
  const register: DocumentCommand[] = state.document.assets.some((known) => known.id === asset.id) ? [] : [{ kind: "registerAsset", asset }];
  const destination = upload.destination;
  if (findSlide(state.document, destination.slideId) === null) return withoutUpload;
  switch (destination.kind) {
    case "newImage": {
      const minter = createIdMinter(withoutUpload.idSeed);
      const id = minter.next("element");
      const image = createImage({ id, asset, centre: destination.centre, slide: slideBox(state.document) });
      return queueEnvelope(
        { ...withoutUpload, idSeed: minter.seed() },
        {
          commands: [...register, { kind: "insertElements", slideId: destination.slideId, elements: [image], placement: { kind: "front" } }],
          selectionAfter: { kind: "elements", slideId: destination.slideId, elementIds: [id] },
          mergeWithPrevious: false,
        },
      );
    }
    case "fill":
      return queueEnvelope(withoutUpload, {
        commands: [
          ...register,
          { kind: "updateElements", slideId: destination.slideId, elementIds: destination.elementIds, patch: { fill: { kind: "image", assetId: asset.id, fit: "cover", opacity: 1 } } },
        ],
        selectionAfter: withoutUpload.selection,
        mergeWithPrevious: false,
      });
    case "slideBackground":
      return queueEnvelope(withoutUpload, {
        commands: [...register, { kind: "setSlideProperties", slideId: destination.slideId, patch: { background: { kind: "image", assetId: asset.id, fit: "cover", opacity: 1 } } }],
        selectionAfter: withoutUpload.selection,
        mergeWithPrevious: false,
      });
    default:
      return assertNever(destination);
  }
}

export function reduceAssetStoreFailed(state: EditorState, uploadId: UploadId, message: string, willRetry: boolean): EditorState {
  const upload = state.uploads.find((candidate) => candidate.uploadId === uploadId);
  if (upload === undefined) return state;
  if (willRetry) {
    return { ...state, uploads: state.uploads.map((candidate) => (candidate.uploadId === uploadId ? { ...candidate, attempt: candidate.attempt + 1 } : candidate)) };
  }
  return raiseNotice(state, { tone: "error", message: `Could not store ${upload.name}: ${message}`, action: { kind: "retryUpload", uploadId } });
}

/** "Retry" on a failed upload's notice: the same bytes under a fresh id, attempt 1. */
export function retryUpload(state: EditorState, uploadId: UploadId): EditorState {
  const upload = state.uploads.find((candidate) => candidate.uploadId === uploadId);
  if (upload === undefined) return state;
  const minter = createIdMinter(state.idSeed);
  const retried = { ...upload, uploadId: minter.next("upload"), attempt: 1 };
  return { ...state, idSeed: minter.seed(), uploads: state.uploads.map((candidate) => (candidate.uploadId === uploadId ? retried : candidate)) };
}

/** Dismissing a failed upload's notice gives up on it. */
export function abandonUpload(state: EditorState, uploadId: UploadId): EditorState {
  return { ...state, uploads: state.uploads.filter((candidate) => candidate.uploadId !== uploadId) };
}

export function retriesUpload(action: EditorState["notices"][number]["action"], uploadId: UploadId): boolean {
  if (action === null) return false;
  switch (action.kind) {
    case "retryUpload":
      return action.uploadId === uploadId;
    case "undoAgentEdits":
    case "reviewTransitionScript":
    case "openInNewTab":
      return false;
    default:
      return assertNever(action);
  }
}

function destinationFor(
  options: Readonly<{ kind: "newImage" | "fill" | "slideBackground"; slideId: SlideId; centre: Point; elementIds: readonly ElementId[] }>,
): UploadDestination {
  switch (options.kind) {
    case "newImage":
      return { kind: "newImage", slideId: options.slideId, centre: options.centre };
    case "fill":
      return options.elementIds.length === 0 ? { kind: "newImage", slideId: options.slideId, centre: options.centre } : { kind: "fill", slideId: options.slideId, elementIds: options.elementIds };
    case "slideBackground":
      return { kind: "slideBackground", slideId: options.slideId };
    default:
      return assertNever(options.kind);
  }
}
