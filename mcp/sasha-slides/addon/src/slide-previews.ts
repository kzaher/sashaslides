// THE SIDEBAR'S THUMBNAILS: which candidate HTML to fetch, what each thumbnail shows, and what a
// comment card says about the candidate it is on.
//
// THE SOURCE IS THE CANDIDATE'S OWN HTML, rendered by `ScaledHtmlFrame` -- the same picture the
// slides window's grid draws (UI-CONTRACT.md: "the HTML is authoritative and a thumbnail would
// lie"). Google's rendered PNG (render-cache.ts) is NOT usable here: it is keyed by a hash of the
// converter's batchUpdate requests, which only exist after a conversion the sidebar never runs, so
// the sidebar cannot even compute the key without doing the expensive work it is meant to avoid.
//
// ITS OWN STORE, NEXT TO THE CONVERSATION RATHER than inside it. `Conversation.set.slides` fetches
// bytes only for REVISED slides (the inline "slide as it is now" in the log). Every other
// candidate's bytes live here, keyed by file id AND the newest revision event, because a revision
// overwrites `NN.html` in place: the file id alone would serve the pre-revision picture for ever.
// A revised slide is left to the conversation's own loader, so no file is downloaded twice.

import {
  loadedEvents,
  slidesOf,
  type Conversation,
  type ConversationSlide,
} from "./conversation-state.ts";
import { assertNever } from "./protocol.ts";
import type { SessionEvent } from "./session-log.ts";

/** One preview fetch, by key. Absent from the map means never requested. */
export type PreviewLoad =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "loaded"; html: string }>
  | Readonly<{ kind: "failed"; message: string }>;

export type SlidePreviews = ReadonlyMap<string, PreviewLoad>;

export const NO_PREVIEWS: SlidePreviews = new Map();

export type PreviewEvent =
  | Readonly<{ kind: "preview-requested"; key: string }>
  | Readonly<{ kind: "preview-arrived"; key: string; html: string }>
  | Readonly<{ kind: "preview-failed"; key: string; message: string }>;

/** What one thumbnail can show. Every arm ends: `loading` becomes `ready` or `unavailable`. */
export type SlidePreview =
  | Readonly<{ kind: "ready"; html: string }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable"; message: string }>;

/** The next candidate whose HTML the thumbnails want, addressed by the key its answer is filed under. */
export type PreviewRequest = Readonly<{ key: string; slideIndex: number; fileId: string }>;

/** Which candidate a comment thread is about, so its card can say so. */
export type ThreadSlideContext =
  | Readonly<{ kind: "deck" }>
  | Readonly<{
      kind: "candidate";
      slideIndex: number;
      label: string;
      /** The newest `slide-revised` event's revision number, when it carried one. */
      revision: number | null;
      revised: boolean;
      /** The slide was revised AFTER this comment was opened, so the thumbnail is newer than the comment. */
      revisedSinceComment: boolean;
    }>;

/** The minimum of a thread this module reads, so it can be tested without building whole threads. */
export type ThreadAnchor = Readonly<{ slideIndex: number | null; root: Readonly<{ at: string }> }>;

export function reducePreviews(previews: SlidePreviews, event: PreviewEvent): SlidePreviews {
  const next = new Map(previews);
  switch (event.kind) {
    case "preview-requested":
      next.set(event.key, { kind: "loading" });
      return next;
    case "preview-arrived":
      next.set(event.key, { kind: "loaded", html: event.html });
      return next;
    case "preview-failed":
      next.set(event.key, { kind: "failed", message: event.message });
      return next;
    default:
      return assertNever(event);
  }
}

/**
 * THE NEXT PREVIEW TO FETCH, or null.
 *
 * ONE AT A TIME. Every `google.script.run` call shares the same per-user concurrency with the
 * comment, log and thread polls; firing eight downloads at once would delay the reads the user is
 * actually waiting on. Thumbnails fill in one after the other instead, top to bottom.
 *
 * A failure is final for that key -- the thumbnail says why -- and the next revision is a new key,
 * which is the only retry that is not a loop.
 */
export function nextPreviewToLoad({
  conversation,
  previews,
}: {
  conversation: Conversation;
  previews: SlidePreviews;
}): PreviewRequest | null {
  for (const load of previews.values()) if (load.kind === "loading") return null;
  const events = loadedEvents(conversation.log);
  for (const slide of slidesOf(conversation)) {
    const latest = latestRevisionOf({ events, slideIndex: slide.slideIndex });
    // A revised slide's bytes are the conversation's own revised-slide loader's job.
    if (latest !== null) continue;
    if (hasOwnBytes(slide)) continue;
    const key = previewKeyOf({ fileId: slide.fileId, revisionEventId: null });
    if (previews.has(key)) continue;
    return { key, slideIndex: slide.slideIndex, fileId: slide.fileId };
  }
  return null;
}

/** What the thumbnail of one candidate shows right now. */
export function previewOf({
  conversation,
  previews,
  slideIndex,
}: {
  conversation: Conversation;
  previews: SlidePreviews;
  slideIndex: number;
}): SlidePreview {
  const slide = slidesOf(conversation).find((candidate) => candidate.slideIndex === slideIndex);
  if (slide === undefined) return { kind: "unavailable", message: `slide ${slideIndex} is not in this set` };
  const latest = latestRevisionOf({ events: loadedEvents(conversation.log), slideIndex });
  if (latest !== null) return previewOfConversationSlide({ slide, latestEventId: latest.eventId });
  if (hasOwnBytes(slide)) return previewOfConversationSlide({ slide, latestEventId: null });
  const load = previews.get(previewKeyOf({ fileId: slide.fileId, revisionEventId: null }));
  if (load === undefined) return { kind: "loading" };
  switch (load.kind) {
    case "loading":
      return { kind: "loading" };
    case "loaded":
      return { kind: "ready", html: load.html };
    case "failed":
      return { kind: "unavailable", message: load.message };
    default:
      return assertNever(load);
  }
}

/** Which candidate a thread is on, its revision, and whether it changed after the comment. */
export function threadSlideContextOf({
  conversation,
  thread,
}: {
  conversation: Conversation;
  thread: ThreadAnchor;
}): ThreadSlideContext {
  if (thread.slideIndex === null) return { kind: "deck" };
  const slideIndex = thread.slideIndex;
  const slide = slidesOf(conversation).find((candidate) => candidate.slideIndex === slideIndex);
  const latest = latestRevisionOf({ events: loadedEvents(conversation.log), slideIndex });
  const commentedAt = Date.parse(thread.root.at);
  return {
    kind: "candidate",
    slideIndex,
    label: slide === undefined ? "" : slide.label === "" ? slide.name : slide.label,
    revision: latest === null ? null : latest.revision,
    revised: latest !== null,
    revisedSinceComment: latest !== null && Number.isFinite(commentedAt) && latest.atMillis > commentedAt,
  };
}

/** The one line under a comment's thumbnail: "Candidate 2 · revision 3 · changed since this comment". */
export function describeThreadSlide(context: ThreadSlideContext): string {
  switch (context.kind) {
    case "deck":
      return "the deck";
    case "candidate": {
      const parts = [`Candidate ${context.slideIndex}`];
      if (context.revision !== null) parts.push(`revision ${context.revision}`);
      else if (context.revised) parts.push("revised");
      else if (context.label !== "") parts.push(context.label);
      if (context.revisedSinceComment) parts.push("changed since this comment");
      return parts.join(" · ");
    }
    default:
      return assertNever(context);
  }
}

/** The key one candidate's bytes are filed under. Not exported: callers use the key a request carries. */
function previewKeyOf({ fileId, revisionEventId }: { fileId: string; revisionEventId: string | null }): string {
  return `${fileId}@${revisionEventId ?? "staged"}`;
}

/** Whether the conversation already holds this slide's bytes, so the preview loader need not fetch them. */
function hasOwnBytes(slide: ConversationSlide): boolean {
  switch (slide.html.kind) {
    case "loaded":
      return true;
    case "unrequested":
    case "loading":
    case "failed":
      return false;
    default:
      return assertNever(slide.html);
  }
}

/**
 * A slide's picture from the bytes the conversation holds. Bytes stamped for an OLDER revision are
 * still shown rather than a blank box: the newer ones are already on their way (`wantsFetch` in
 * conversation-state.ts), and the old picture is the closest true thing until they land.
 */
function previewOfConversationSlide({
  slide,
  latestEventId,
}: {
  slide: ConversationSlide;
  latestEventId: string | null;
}): SlidePreview {
  switch (slide.html.kind) {
    case "unrequested":
    case "loading":
      return { kind: "loading" };
    case "loaded":
      return { kind: "ready", html: slide.html.html };
    case "failed":
      return slide.fetchedFor === latestEventId
        ? { kind: "unavailable", message: slide.html.message }
        : { kind: "loading" };
    default:
      return assertNever(slide.html);
  }
}

/** The newest `slide-revised` event for one slide, or null when it was never revised. */
function latestRevisionOf({
  events,
  slideIndex,
}: {
  events: readonly SessionEvent[];
  slideIndex: number;
}): Readonly<{ eventId: string; atMillis: number; revision: number | null }> | null {
  let latest: Readonly<{ eventId: string; atMillis: number; revision: number | null }> | null = null;
  for (const event of events) {
    const body = event.body;
    if (body.kind !== "slide-revised" || body.slideIndex !== slideIndex) continue;
    latest = { eventId: event.eventId, atMillis: event.atMillis, revision: body.revision };
  }
  return latest;
}
