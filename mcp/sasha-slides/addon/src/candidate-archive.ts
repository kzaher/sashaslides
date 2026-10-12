// ARCHIVING A CANDIDATE: which candidates the user has set aside, derived from the session log.
//
// THE LOG IS THE RECORD. The sidebar's Archive / Restore append `slide-archived` / `slide-restored`
// to the proposal's own `events/` folder (PROTOCOL.md), so the choice survives the sidebar closing
// and Sasha reads it through `session_events`. Nothing is deleted: the candidate's `NN.html` and its
// comment threads stay, which is why an archived candidate can always come back.
//
// THE NEWEST EVENT PER SLIDE WINS. The log is ordered (session-log.ts), so the derivation is a walk
// that remembers the last word about each slide.
//
// OPTIMISTIC, WITHOUT LYING. A click takes effect before Drive answers: it becomes a `PendingArchive`
// laid over the log. A pending entry is dropped when the write FAILS (the click is undone and the
// reason shown) or when the log has caught up with the file the write created -- from then on the
// log alone says it.

import { assertNever } from "./protocol.ts";
import type { SessionEvent, SessionEventBody } from "./session-log.ts";

/** Which list the set card shows. */
export type CandidateTab = "working" | "archived";

export const CANDIDATE_TABS: readonly CandidateTab[] = ["working", "archived"];

export const CANDIDATE_TAB_LABEL: Readonly<Record<CandidateTab, string>> = {
  working: "Working",
  archived: "Archived",
};

/** One archived candidate, and when it was archived (the event's millisecond, from its file name). */
export type ArchivedSlide = Readonly<{ slideIndex: number; archivedAtMillis: number }>;

/**
 * A click the log does not show yet. `fileId` is null while the write is in flight, and the created
 * event file's id once Drive answered -- which is what `pendingAfterLog` looks for in the log.
 * `atMillis` is the millisecond the event is named for, and identifies the request.
 */
export type PendingArchive = Readonly<{
  proposalId: string;
  slideIndex: number;
  archived: boolean;
  atMillis: number;
  fileId: string | null;
}>;

/** The two lists the card shows: Working in the manifest's order, Archived newest first. */
export type CandidateLists<TSlide> = Readonly<{
  working: readonly TSlide[];
  archived: readonly Readonly<{ slide: TSlide; archivedAtMillis: number }>[];
}>;

/**
 * THE ARCHIVED CANDIDATES, most recently archived first. The log's events in order, then the
 * pending clicks over them (a click is always the newest word about its slide).
 */
export function archivedSlidesOf({
  events,
  pending,
}: {
  events: readonly SessionEvent[];
  pending: readonly PendingArchive[];
}): readonly ArchivedSlide[] {
  const archivedAt = new Map<number, number>();
  for (const event of events) {
    const effect = archiveEffectOf(event.body);
    if (effect === null) continue;
    if (effect.archived) archivedAt.set(effect.slideIndex, event.atMillis);
    else archivedAt.delete(effect.slideIndex);
  }
  for (const click of [...pending].sort((left, right) => left.atMillis - right.atMillis)) {
    if (click.archived) archivedAt.set(click.slideIndex, click.atMillis);
    else archivedAt.delete(click.slideIndex);
  }
  return [...archivedAt.entries()]
    .map(([slideIndex, archivedAtMillis]) => ({ slideIndex, archivedAtMillis }))
    .sort((left, right) => right.archivedAtMillis - left.archivedAtMillis || left.slideIndex - right.slideIndex);
}

/**
 * The pending clicks the log has NOT caught up with. A written click whose event file is in the log
 * is handed over to the log; one still in flight always stays, whatever the log says.
 */
export function pendingAfterLog({
  pending,
  events,
}: {
  pending: readonly PendingArchive[];
  events: readonly SessionEvent[];
}): readonly PendingArchive[] {
  const logged = new Set(events.map((event) => event.fileId));
  return pending.filter((click) => click.fileId === null || !logged.has(click.fileId));
}

/**
 * The candidates split into the two lists. An archived index the manifest no longer has never
 * invents a row; every candidate the manifest has is in exactly one list.
 */
export function splitCandidates<TSlide extends Readonly<{ slideIndex: number }>>({
  slides,
  archived,
}: {
  slides: readonly TSlide[];
  archived: readonly ArchivedSlide[];
}): CandidateLists<TSlide> {
  const archivedIndices = new Set(archived.map((entry) => entry.slideIndex));
  return {
    working: slides.filter((slide) => !archivedIndices.has(slide.slideIndex)),
    archived: archived.flatMap((entry) => {
      const slide = slides.find((candidate) => candidate.slideIndex === entry.slideIndex);
      return slide === undefined ? [] : [{ slide, archivedAtMillis: entry.archivedAtMillis }];
    }),
  };
}

/** The event to append for a click. */
export function archiveEventBodyOf({
  slideIndex,
  archived,
}: {
  slideIndex: number;
  archived: boolean;
}): Extract<SessionEventBody, { kind: "slide-archived" | "slide-restored" }> {
  return archived ? { kind: "slide-archived", slideIndex } : { kind: "slide-restored", slideIndex };
}

/** What an event says about a slide's archive state, or null when it says nothing. Exhaustive. */
function archiveEffectOf(body: SessionEventBody): Readonly<{ slideIndex: number; archived: boolean }> | null {
  switch (body.kind) {
    case "slide-archived":
      return { slideIndex: body.slideIndex, archived: true };
    case "slide-restored":
      return { slideIndex: body.slideIndex, archived: false };
    case "slides-staged":
    case "comment-opened":
    case "comment-answered":
    case "slide-revised":
    case "comment-resolved":
    case "slides-cleared":
    case "slide-inserted":
    case "feedback-delivered":
    case "opaque":
      return null;
    default:
      return assertNever(body);
  }
}
