// THE EDITOR'S TIMED EFFECTS, all on the injected scheduler (contracts/editor-system.ts: no feedback
// calls `setTimeout` or `Date.now`), so tests drive them with virtual time.
//
//  * UPLOADS: `AssetStore.put` with a 20 second timeout per attempt and 3 attempts, waiting half a second
//    then a second between them (exponential backoff). Every failed attempt is reported (`willRetry`) so the
//    state shows the attempt number; the last failure gives up. Keyed by upload id, so the effect
//    lives exactly as long as the upload is listed.
//  * ASSET AVAILABILITY: the store's `available` stream, plus a check of every asset the document
//    names that is not known to be loadable yet (an image pasted by a peer, a reopened deck).
//  * PRESENCE: this editor's slide, selection, pointer and activity, published at most once per
//    `PRESENCE_PUBLISH_INTERVAL_MILLISECONDS` (leading and trailing, so the last position always
//    goes out); peers come back as `peersChanged`.
//  * NOTICE EXPIRY: one timer per expiring notice; a notice dismissed first takes its timer with it.

import { concat, defer, EMPTY, from, merge, Observable, of, timer, type SchedulerLike } from "rxjs";
import { catchError, distinctUntilChanged, ignoreElements, map, mergeMap, tap, throttleTime, timeout } from "rxjs/operators";
import {
  PRESENCE_PUBLISH_INTERVAL_MILLISECONDS,
  type AssetId,
  type AssetStore,
  type EditorEvent,
  type EditorState,
  type Feedback,
  type LocalPresence,
  type Notice,
  type PendingUpload,
  type PresenceChannel,
  type Point,
} from "../../contracts/index.ts";
import { assertNever } from "../../contracts/index.ts";
import { sameValue } from "../editor/text-model.ts";
import { UPLOAD_ATTEMPT_TIMEOUT_MILLISECONDS, UPLOAD_ATTEMPTS, UPLOAD_FIRST_BACKOFF_MILLISECONDS } from "../editor/uploads.ts";
import { reactSet } from "../rxfeedback/react-feedbacks.ts";
import { messageOf } from "./document-feedbacks.ts";

type ReportError = (error: unknown, context: string) => void;

export function uploadsFeedback(dependencies: Readonly<{ assetStore: AssetStore; scheduler: SchedulerLike; reportError: ReportError }>): Feedback<EditorState, EditorEvent> {
  return reactSet<EditorState, PendingUpload, EditorEvent>({
    query: (state) => new Map(state.uploads.map((upload) => [upload.uploadId, upload])),
    effects: (upload) => attemptUpload({ upload, attempt: upload.attempt, ...dependencies }),
  });
}

/** The backoff before attempt `attempt + 1`: 500 milliseconds, then 1000, doubling. */
export function uploadBackoffMilliseconds(attempt: number): number {
  return UPLOAD_FIRST_BACKOFF_MILLISECONDS * 2 ** (attempt - 1);
}

export function assetAvailabilityFeedback(dependencies: Readonly<{ assetStore: AssetStore; reportError: ReportError }>): Feedback<EditorState, EditorEvent> {
  const unknownAssets = reactSet<EditorState, AssetId, EditorEvent>({
    query: (state) => new Map(state.document.assets.filter((asset) => !state.availableAssetIds.has(asset.id)).map((asset) => [asset.id, asset.id])),
    effects: (assetId) =>
      defer(() => (dependencies.assetStore.addressFor(assetId) === null ? EMPTY : of<EditorEvent>({ kind: "assetAvailable", assetId }))).pipe(
        catchError((error: unknown) => {
          dependencies.reportError(error, `checking asset ${assetId}`);
          return of<EditorEvent>({ kind: "feedbackFailed", context: "Loading an image", message: messageOf(error) });
        }),
      ),
  });
  return (state$) => merge(dependencies.assetStore.available.pipe(map((assetId): EditorEvent => ({ kind: "assetAvailable", assetId }))), unknownAssets(state$));
}

export function presenceFeedback(dependencies: Readonly<{ presence: PresenceChannel | null; scheduler: SchedulerLike; reportError: ReportError }>): Feedback<EditorState, EditorEvent> {
  const channel = dependencies.presence;
  if (channel === null) return () => EMPTY;
  return (state$) =>
    merge(
      new Observable<EditorEvent>((subscriber) => {
        const subscription = channel.subscribe((peers) => subscriber.next({ kind: "peersChanged", peers }));
        return () => subscription[Symbol.dispose]();
      }),
      state$.pipe(
        map(localPresenceOf),
        distinctUntilChanged((previous: LocalPresence, next: LocalPresence) => sameValue(previous, next)),
        throttleTime(PRESENCE_PUBLISH_INTERVAL_MILLISECONDS, dependencies.scheduler, { leading: true, trailing: true }),
        tap((presence) => {
          try {
            channel.publish(presence);
          } catch (error: unknown) {
            dependencies.reportError(error, "publishing presence");
          }
        }),
        ignoreElements(),
      ),
    );
}

/** What collaborators see of this editor, derived from state. */
export function localPresenceOf(state: EditorState): LocalPresence {
  return {
    person: state.me,
    slideId: state.currentSlideId,
    selection: state.selection,
    pointer: pointerOf(state),
    activity: state.presentation === null ? "editing" : "presenting",
  };
}

export function noticeExpiryFeedback(dependencies: Readonly<{ scheduler: SchedulerLike }>): Feedback<EditorState, EditorEvent> {
  return reactSet<EditorState, Notice, EditorEvent>({
    query: (state) => new Map(state.notices.filter((notice) => notice.expiresAfterMilliseconds !== null).map((notice) => [notice.id, notice])),
    effects: (notice) => timer(notice.expiresAfterMilliseconds ?? 0, dependencies.scheduler).pipe(map((): EditorEvent => ({ kind: "noticeExpired", noticeId: notice.id }))),
  });
}

function attemptUpload(
  options: Readonly<{ upload: PendingUpload; attempt: number; assetStore: AssetStore; scheduler: SchedulerLike; reportError: ReportError }>,
): Observable<EditorEvent> {
  const upload = options.upload;
  return defer(() => from(options.assetStore.put(upload.bytes, upload.mediaType))).pipe(
    timeout({ first: UPLOAD_ATTEMPT_TIMEOUT_MILLISECONDS, scheduler: options.scheduler }),
    map(
      (assetId): EditorEvent => ({
        kind: "assetStored",
        uploadId: upload.uploadId,
        asset: { id: assetId, mediaType: upload.mediaType, pixelWidth: upload.pixelWidth, pixelHeight: upload.pixelHeight, name: upload.name, byteLength: upload.bytes.byteLength },
      }),
    ),
    catchError((error: unknown) => {
      options.reportError(error, `storing ${upload.name}, attempt ${options.attempt}`);
      const message = messageOf(error);
      if (options.attempt >= UPLOAD_ATTEMPTS) return of<EditorEvent>({ kind: "assetStoreFailed", uploadId: upload.uploadId, message, willRetry: false });
      return concat(
        of<EditorEvent>({ kind: "assetStoreFailed", uploadId: upload.uploadId, message, willRetry: true }),
        timer(uploadBackoffMilliseconds(options.attempt), options.scheduler).pipe(mergeMap(() => attemptUpload({ ...options, attempt: options.attempt + 1 }))),
      );
    }),
  );
}

/** The pointer collaborators see: where this editor's current gesture is, else where it hovers. */
function pointerOf(state: EditorState): Point | null {
  const gesture = state.gesture;
  switch (gesture.kind) {
    case "pressed":
      return gesture.origin.slidePoint;
    case "moving":
    case "resizing":
    case "rotating":
      return gesture.current.slidePoint;
    case "movingLineEnd":
      return gesture.point;
    case "marquee":
    case "creating":
    case "resizingTableLine":
      return gesture.current;
    case "idle":
    case "drawingMarking":
    case "panning":
      return state.pointer;
    case "draggingSlides":
      return null;
    default:
      return assertNever(gesture);
  }
}
