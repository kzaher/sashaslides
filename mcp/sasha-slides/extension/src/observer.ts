// The READY observer, as a pure reducer: (state, event) -> (state, effects). No Drive, no timers,
// no chrome.* -- every side effect is an immutable VALUE the runtime executes (observer-runtime.ts),
// which is what makes the whole machine testable against a fake Drive with no network.
//
// !! SUPERSEDED BY PROTOCOL.md, "Discovery is by NAME, not by appProperties". This file discovers
// !! proposals by `appProperties has {key='sashaSlides' ...}`, which CANNOT work across components:
// !! appProperties are private to the writing OAuth client, so a client other than the MCP server's
// !! sees an empty result with no error. The reducer, the dedupe, the cadence and the backoff below
// !! are all unaffected; what must change is `nextCandidate`'s input and `DriveApi.listByRoles`,
// !! which become a NAME walk -- "Sasha Slides Inbox" -> <proposalId> -> READY/PICK. Held pending
// !! the vehicle decision (Chrome extension vs. Apps Script sidebar) because the Drive client is
// !! replaced wholesale in the sidebar case.
//
// WHY POLLING `files.list` AND NOT `drive.changes.list`. The changes feed is the textbook answer and
// it was rejected on purpose:
//   * It is ACCOUNT-WIDE. Every change the app can see churns the cursor, so the extension still
//     polls -- it just polls a feed of mostly-irrelevant deltas instead of a question it cares about.
//   * It is STATEFUL. A `startPageToken` must be persisted, and an expired or lost token yields a
//     404 that can only be recovered by a full resync -- i.e. by the query below anyway. A browser
//     extension is reinstalled, its storage cleared and its profile synced across machines; a
//     cursor is the thing most likely to be wrong.
//   * `files.list` on `appProperties` is SELF-HEALING and idempotent. Whatever happened while the
//     browser was closed is simply visible on the next poll, and "already answered" is derived from
//     the data (a sibling PICK) plus a `seen` set, not from a cursor's position.
// The protocol was designed with `appProperties` on every file precisely so this query is possible,
// and one narrow query with `fields` narrowing is cheap enough to run in a user's browser.

import type { DriveFileRef } from "./drive-api.ts";
import { ROLE_PICK, ROLE_READY, assertNever, type SlideEntry } from "./protocol.ts";

/** What the picker is offered: a complete, READY proposal plus where to write its PICK. */
export type Proposal = Readonly<{
  proposalId: string;
  /** `parents[0]` of the READY marker -- the proposal folder PICK must be created in. */
  folderId: string;
  presentationId: string | null;
  count: number;
  slides: readonly SlideEntry[];
}>;

/** How many Google Slides tabs are listening, and whether any of them is actually on screen. */
export type Viewers = Readonly<{ count: number; anyVisible: boolean }>;

export type ObserverPhase =
  | Readonly<{ kind: "stopped" }>
  | Readonly<{ kind: "waiting"; nextPollAtMs: number }>
  | Readonly<{ kind: "listing" }>
  | Readonly<{ kind: "loading"; proposalId: string; readyFileId: string; folderId: string }>
  | Readonly<{ kind: "offering"; proposal: Proposal }>;

export type ObserverState = Readonly<{
  phase: ObserverPhase;
  viewers: Viewers;
  /** Proposals this browser has already answered or refused to parse. Persisted. */
  seenProposalIds: readonly string[];
  consecutiveFailures: number;
}>;

export type ObserverEvent =
  | Readonly<{ kind: "restored"; seenProposalIds: readonly string[] }>
  | Readonly<{ kind: "viewers-changed"; viewers: Viewers; nowMs: number }>
  | Readonly<{ kind: "poll-due"; nowMs: number }>
  | Readonly<{ kind: "listed"; files: readonly DriveFileRef[]; nowMs: number }>
  | Readonly<{ kind: "list-failed"; message: string; nowMs: number }>
  | Readonly<{ kind: "loaded"; proposal: Proposal; nowMs: number }>
  /** The proposal could not be fetched. Transient, so it stays unanswered and is retried. */
  | Readonly<{ kind: "load-failed"; proposalId: string; message: string; nowMs: number }>
  /** The proposal was fetched and is unusable -- bad JSON, or a protocolVersion we do not know. */
  | Readonly<{ kind: "load-rejected"; proposalId: string; reason: string; nowMs: number }>
  /** The user decided (PICK written) or the offer is otherwise finished with. */
  | Readonly<{ kind: "resolved"; proposalId: string; nowMs: number }>;

export type ObserverEffect =
  | Readonly<{ kind: "list-files" }>
  | Readonly<{ kind: "load-proposal"; proposalId: string; readyFileId: string; folderId: string }>
  | Readonly<{ kind: "announce-proposal"; proposal: Proposal }>
  | Readonly<{ kind: "announce-trouble"; message: string }>
  | Readonly<{ kind: "schedule-poll"; delayMs: number }>
  | Readonly<{ kind: "cancel-poll" }>
  | Readonly<{ kind: "persist-seen"; seenProposalIds: readonly string[] }>
  | Readonly<{ kind: "warn"; message: string }>;

export type Reduction = Readonly<{ state: ObserverState; effects: readonly ObserverEffect[] }>;

/** The roles one poll asks for: the final marks, and the answers that retire them. */
export const POLLED_ROLES = [ROLE_READY, ROLE_PICK] as const;

/** Drive returns at most this many protocol files per poll; far above any plausible backlog. */
export const POLL_PAGE_SIZE = 100;

export const INITIAL_OBSERVER_STATE: ObserverState = {
  phase: { kind: "stopped" },
  viewers: { count: 0, anyVisible: false },
  seenProposalIds: [],
  consecutiveFailures: 0,
};

export function reduceObserver(state: ObserverState, event: ObserverEvent): Reduction {
  switch (event.kind) {
    case "restored":
      return { state: { ...state, seenProposalIds: event.seenProposalIds }, effects: [] };

    case "viewers-changed":
      return onViewersChanged(state, event);

    case "poll-due":
      // A timer that fires in any other phase is a leftover from a cadence change; a request is
      // already in flight and will schedule the next poll itself.
      if (state.phase.kind !== "waiting") return { state, effects: [] };
      return { state: { ...state, phase: { kind: "listing" } }, effects: [{ kind: "list-files" }] };

    case "listed":
      return onListed(state, event);

    case "list-failed":
      if (state.phase.kind !== "listing") return { state, effects: [] };
      return onTransportFailure(state, event);

    case "loaded":
      if (state.phase.kind !== "loading" || state.phase.proposalId !== event.proposal.proposalId) {
        return { state, effects: [] };
      }
      return {
        state: { ...state, phase: { kind: "offering", proposal: event.proposal }, consecutiveFailures: 0 },
        effects: [{ kind: "announce-proposal", proposal: event.proposal }],
      };

    case "load-failed":
      if (state.phase.kind !== "loading" || state.phase.proposalId !== event.proposalId) {
        return { state, effects: [] };
      }
      return onTransportFailure(state, { message: event.message, nowMs: event.nowMs });

    case "load-rejected":
      // Marked seen, not retried: "an unknown version is ignored with a logged warning, never
      // guessed at", and a malformed proposal would otherwise be reloaded on every single poll.
      return afterAnswering({
        state: { ...state, seenProposalIds: withSeen(state.seenProposalIds, event.proposalId) },
        nowMs: event.nowMs,
        extraEffects: [{ kind: "warn", message: `proposal ${event.proposalId} ignored: ${event.reason}` }],
        pollNow: false,
      });

    case "resolved":
      if (state.phase.kind !== "offering" || state.phase.proposal.proposalId !== event.proposalId) {
        return { state, effects: [] };
      }
      // Poll immediately: Claude may already have staged the next proposal, and the user is
      // watching. The only cost is one request.
      return afterAnswering({
        state: { ...state, seenProposalIds: withSeen(state.seenProposalIds, event.proposalId) },
        nowMs: event.nowMs,
        extraEffects: [],
        pollNow: true,
      });

    default:
      return assertNever(event);
  }
}

/**
 * How long until the next poll. Fast only while a Slides tab is actually on screen, because that is
 * the only moment a picker can be seen; a hidden tab drops to a background cadence and no tabs stops
 * the loop outright. Failures back off exponentially.
 */
export function pollDelayMs({
  viewers,
  consecutiveFailures,
}: {
  viewers: Viewers;
  consecutiveFailures: number;
}): number {
  const base = viewers.anyVisible ? VISIBLE_POLL_MS : HIDDEN_POLL_MS;
  if (consecutiveFailures === 0) return base;
  const backoff = base * 2 ** Math.min(consecutiveFailures, MAX_BACKOFF_DOUBLINGS);
  return Math.min(backoff, MAX_POLL_MS);
}

/**
 * The one proposal a poll result should open next, or null. A READY marker is a candidate only when
 * it names a proposal, lives in a folder, has not been answered in a previous session, and has no
 * sibling PICK. Drive returns the page ordered by createdTime, so the oldest unanswered proposal
 * wins and a backlog drains in the order Claude produced it.
 */
export function nextCandidate({
  files,
  seenProposalIds,
}: {
  files: readonly DriveFileRef[];
  seenProposalIds: readonly string[];
}): Readonly<{ proposalId: string; readyFileId: string; folderId: string }> | null {
  const answered = new Set<string>(seenProposalIds);
  for (const file of files) {
    if (file.appProperties["sashaSlides"] !== ROLE_PICK) continue;
    const proposalId = file.appProperties["proposalId"];
    if (proposalId !== undefined) answered.add(proposalId);
  }
  for (const file of files) {
    if (file.appProperties["sashaSlides"] !== ROLE_READY) continue;
    const proposalId = file.appProperties["proposalId"];
    const folderId = file.parents[0];
    if (proposalId === undefined || proposalId === "" || folderId === undefined) continue;
    if (answered.has(proposalId)) continue;
    return { proposalId, readyFileId: file.id, folderId };
  }
  return null;
}

const VISIBLE_POLL_MS = 5_000;
const HIDDEN_POLL_MS = 30_000;
const MAX_POLL_MS = 120_000;
const MAX_BACKOFF_DOUBLINGS = 4;
/** One flake should not flash an error at the user; two in a row is a real problem. */
const FAILURES_BEFORE_ANNOUNCING = 2;

function onViewersChanged(
  state: ObserverState,
  event: Readonly<{ viewers: Viewers; nowMs: number }>,
): Reduction {
  const next: ObserverState = { ...state, viewers: event.viewers };
  if (event.viewers.count === 0) {
    return { state: { ...next, phase: { kind: "stopped" } }, effects: [{ kind: "cancel-poll" }] };
  }
  switch (state.phase.kind) {
    case "stopped":
      return { state: { ...next, phase: { kind: "listing" } }, effects: [{ kind: "list-files" }] };
    case "waiting":
      // A tab just became visible, so re-time the pending poll to the faster cadence.
      return scheduleWaiting({ state: next, nowMs: event.nowMs, extraEffects: [] });
    case "offering":
      // A tab that connected after the offer was made has never heard about it.
      return { state: next, effects: [{ kind: "announce-proposal", proposal: state.phase.proposal }] };
    case "listing":
    case "loading":
      return { state: next, effects: [] };
    default:
      return assertNever(state.phase);
  }
}

function onListed(
  state: ObserverState,
  event: Readonly<{ files: readonly DriveFileRef[]; nowMs: number }>,
): Reduction {
  if (state.phase.kind !== "listing") return { state, effects: [] };
  const settled: ObserverState = { ...state, consecutiveFailures: 0 };
  const candidate = nextCandidate({ files: event.files, seenProposalIds: state.seenProposalIds });
  if (candidate === null) return scheduleWaiting({ state: settled, nowMs: event.nowMs, extraEffects: [] });
  return {
    state: { ...settled, phase: { kind: "loading", ...candidate } },
    effects: [{ kind: "load-proposal", ...candidate }],
  };
}

/** Shared by a failed list and a failed proposal fetch: back off, warn, keep the proposal unanswered. */
function onTransportFailure(state: ObserverState, event: Readonly<{ message: string; nowMs: number }>): Reduction {
  const failures = state.consecutiveFailures + 1;
  const announce: readonly ObserverEffect[] =
    failures >= FAILURES_BEFORE_ANNOUNCING ? [{ kind: "announce-trouble", message: event.message }] : [];
  return scheduleWaiting({
    state: { ...state, consecutiveFailures: failures },
    nowMs: event.nowMs,
    extraEffects: [{ kind: "warn", message: `Drive poll failed (${failures}x): ${event.message}` }, ...announce],
  });
}

function afterAnswering({
  state,
  nowMs,
  extraEffects,
  pollNow,
}: {
  state: ObserverState;
  nowMs: number;
  extraEffects: readonly ObserverEffect[];
  pollNow: boolean;
}): Reduction {
  const persist: ObserverEffect = { kind: "persist-seen", seenProposalIds: state.seenProposalIds };
  if (!pollNow) return scheduleWaiting({ state, nowMs, extraEffects: [persist, ...extraEffects] });
  return {
    state: { ...state, phase: { kind: "listing" } },
    effects: [persist, ...extraEffects, { kind: "list-files" }],
  };
}

function scheduleWaiting({
  state,
  nowMs,
  extraEffects,
}: {
  state: ObserverState;
  nowMs: number;
  extraEffects: readonly ObserverEffect[];
}): Reduction {
  const delayMs = pollDelayMs({ viewers: state.viewers, consecutiveFailures: state.consecutiveFailures });
  return {
    state: { ...state, phase: { kind: "waiting", nextPollAtMs: nowMs + delayMs } },
    effects: [...extraEffects, { kind: "schedule-poll", delayMs }],
  };
}

function withSeen(seenProposalIds: readonly string[], proposalId: string): readonly string[] {
  if (seenProposalIds.includes(proposalId)) return seenProposalIds;
  // Bounded: a proposal folder is disposable, so old ids can never come back and the tail is dead
  // weight that would otherwise grow without limit in chrome.storage.local.
  return [...seenProposalIds, proposalId].slice(-SEEN_LIMIT);
}

const SEEN_LIMIT = 500;
