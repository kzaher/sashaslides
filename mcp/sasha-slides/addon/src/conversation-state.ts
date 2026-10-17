// ASK SASHA'S WHOLE STATE: whether an assistant is listening, and the candidate slides it staged.
// One immutable tree, one pure reducer.
//
// WHAT IT USED TO BE. A serialized event log with the deck's comment pane, every candidate's comment
// threads, a composer and a defect-report entry merged into one conversation column. The
// conversation now happens in the deck's own Google Slides comments, which the comment bot answers,
// so this side panel is reduced to the two things a comment cannot carry: the CONNECTION (is
// anything listening, and how to attach it when not) and the ASSETS (the staged candidates, with
// Working / Archived, Open and Archive).
//
// TWO READS, ONE TREE:
//
//   1. THE INBOX SCAN (`staged`) says which proposal is staged; the newest one is FOLLOWED (`set`)
//      and its manifest names the candidates.
//   2. THE SESSION LOG (`log`), one file per event in `<proposal>/events/`, read through
//      session-log.ts. It is still read because three things kept here are derived from it: the
//      archive state (candidate-archive.ts), when the manifest must be re-read (a set-changing
//      event), and whether anything is listening (waiting.ts).
//
// THE SURFACES STILL SHARE NOTHING. Separate HtmlService documents, separate frames: everything
// below reaches the slides window through the server and only through the server. `scanInbox` says
// what is staged, `sashaOpenPicker` asks Apps Script to show it -- which is also why "the dialog
// opens by itself when slides arrive" is a decision made HERE (`proposalToAutoOpen`) and executed
// as a server call.
//
// THE BOOT SEED (sidebar-seed.ts). Code.gs hands the panel the LAST KNOWN scan, manifest and log
// for this deck when it opens it, so the panel draws at once instead of after three round trips in
// series (measured 2026-10-15: candidates at 4.6 s, the connection at 6.4 s). A seed is a head start
// and never the truth: `seeded` marks what came from it, every seeded read is re-read at once, and
// the first FRESH scan decides whether the seeded set is still the one to follow.

import { nothingListeningNotice, type NothingListeningNotice } from "../../feedback-delivery.ts";
import type { ProposalMark } from "./bridge.ts";
import type { HtmlLoad } from "./html-load.ts";
import { assertNever, type Manifest, type MergeSpec, type SlideEntry } from "./protocol.ts";
import { presenceIsSilent, sashaPresenceOf, type PresenceReads, type SashaPresence } from "./waiting.ts";
import { newestSetChangeIn, slideIndexOf, type SessionEvent } from "./session-log.ts";
import {
  archivedSlidesOf,
  pendingAfterLog,
  splitCandidates,
  type CandidateLists,
  type CandidateTab,
  type PendingArchive,
} from "./candidate-archive.ts";

export type Conversation = Readonly<{
  /** Which list the set card shows. In the tree, so a poll cannot snap it back. */
  candidateTab: CandidateTab;
  /**
   * ARCHIVE / RESTORE CLICKS THE LOG DOES NOT SHOW YET, laid over it so a click takes effect at
   * once (candidate-archive.ts). At most one per slide: a newer click replaces the older one.
   */
  archivePending: readonly PendingArchive[];
  /** Why the last archive or restore could not be written, after it was undone. */
  archiveTrouble: string | null;
  /** Candidates waiting in Drive, so the panel can offer to open the slides window. */
  staged: StagedLoad;
  /**
   * THE SET THIS PANEL IS FOLLOWING, and it is STICKY. It is adopted from the newest staged
   * proposal and replaced only by a strictly newer one -- never cleared when the proposal is
   * answered, so the candidates stay reachable after one of them was inserted.
   */
  set: FollowedSet;
  log: SessionLogLoad;
  open: OpenPhase;
  /**
   * The proposals the slides window has already been opened for WITHOUT being asked. The dialog
   * opens by itself when slides arrive (UI-CONTRACT.md) and must then stay closed if the user
   * closes it, so the fact that it was offered is remembered per proposal rather than re-derived.
   */
  autoOpened: readonly string[];
  /**
   * WHETHER THE FOLLOWED SET'S LOG HAS COME BACK AT LEAST ONCE. The load alone cannot say it: the
   * poll puts it back in `loading` (keeping what it had), and a `loading` that is a RE-read looks
   * exactly like the first one. Presence used to read both as "unfinished", flip to `unknown` on
   * every poll, and drop the nothing-listening notice for the length of each round trip (user
   * report, 2026-10-11).
   */
  logReadOnce: boolean;
  /** A failure that is about the whole panel rather than one load. Null when there is none. */
  trouble: string | null;
  /**
   * THE WALL CLOCK, IN THE TREE. Whether evidence of a listener is stale, and whether a finished
   * read is due again, are both measured against it; a component that read `Date.now()` in its
   * render body would show the time of the last unrelated re-render. Null until the first tick,
   * which is typed absence rather than a sentinel `0`.
   */
  nowMs: number | null;
  /**
   * WHICH READS ON SCREEN CAME FROM THE BOOT SEED and have not yet been confirmed or replaced by a
   * fresh one. Each flag makes its read due at once (`needsStaged`, `needsLog`), holds back
   * anything that would act on unverified data (`proposalToAutoOpen`), and is what the panel's
   * "Updating" marker shows.
   */
  seeded: SeededReads;
}>;

/** One flag per read the seed can stand in for. All false outside the first seconds after opening. */
export type SeededReads = Readonly<{ scan: boolean; manifest: boolean; log: boolean }>;

export const NOTHING_SEEDED: SeededReads = { scan: false, manifest: false, log: false };

/**
 * WHAT THE BOOT SEED SAYS, already parsed (sidebar-seed.ts): the last scan this user's sidebar made
 * on this deck, and the manifest and log it last read for a proposal folder. The manifest and log
 * are only used when they belong to the set the seeded scan follows.
 */
export type SidebarSeed = Readonly<{
  marks: readonly ProposalMark[];
  scanReadAt: string;
  /** `forEventId` is the newest set-changing event the sidebar had seen when it read this manifest. */
  manifest: Readonly<{ manifest: Manifest; forEventId: string | null }> | null;
  log: Readonly<{ folderId: string; events: readonly SessionEvent[]; readAt: string }> | null;
}>;

/** Same "a re-read keeps what it had" rule everywhere: a poll must never blank what is on screen. */
export type SessionLogLoad =
  | Readonly<{ kind: "unrequested" }>
  | Readonly<{ kind: "loading"; events: readonly SessionEvent[] }>
  | Readonly<{ kind: "loaded"; events: readonly SessionEvent[]; readAt: string }>
  | Readonly<{ kind: "failed"; message: string; events: readonly SessionEvent[] }>;

export type StagedLoad =
  | Readonly<{ kind: "unrequested" }>
  /**
   * A scan is in flight. `had` is what the LAST one found, or null when there has never been one.
   *
   * It carries the previous result because this load is re-read every SCAN_FRESH_MS for the life
   * of the session: a bare `loading` made `conversationIsOpening` true on every poll, so the
   * whole panel was replaced by a spinner every few seconds. A refresh must never take away what
   * is already on screen.
   */
  | Readonly<{ kind: "loading"; had: Readonly<{ proposals: readonly StagedProposal[]; readAt: string }> | null }>
  /** `readAt` is what makes a finished read go stale instead of re-firing at once. */
  | Readonly<{ kind: "loaded"; proposals: readonly StagedProposal[]; readAt: string }>
  | Readonly<{ kind: "failed"; message: string }>;

/** A proposal that is complete (`READY` exists) and unanswered (no sibling `PICK`). */
export type StagedProposal = Readonly<{
  proposalId: string;
  folderId: string;
  readyFileId: string;
  createdTime: string;
}>;

/**
 * The followed set. `none` until the first scan finds something; after that it always names a
 * proposal, whose manifest names the candidates (the fileIds of `NN.html`).
 */
export type FollowedSet =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "following";
      proposalId: string;
      folderId: string;
      readyFileId: string;
      createdTime: string;
      manifest: ManifestLoad;
      /** The candidates, with the HTML of the ones a revision changed. */
      slides: readonly ConversationSlide[];
    }>;

/**
 * `forEventId` is the newest SET-CHANGING event in the log when this manifest was read, and it is
 * what makes the read happen again: a revision or a clear appends an event, so when that id moves
 * the candidate set has moved and the manifest is stale. That is the protocol's split -- listing
 * `events/` is the "has anything happened" signal, `manifest.revision` is "have the candidates
 * changed" -- and it is why the add-on polls the LOG and never the manifest. The add-on appending
 * an event must never make it a writer of `manifest.json`.
 */
export type ManifestLoad =
  | Readonly<{ kind: "unrequested" }>
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "loaded";
      count: number;
      revision: number | null;
      forEventId: string | null;
      /** The manifest's target deck, kept so the slides window can be seeded without re-reading it. */
      presentationId: string | null;
      /**
       * The merge target and removals, kept for the same reason: a seed without them would offer a
       * merge proposal as an INSERT, and the slides window's own read could not correct it (a
       * re-offered proposal is a no-op). Null for an ordinary proposal.
       */
      merge: MergeSpec | null;
    }>
  | Readonly<{ kind: "failed"; message: string; forEventId: string | null }>;

/**
 * One candidate. It holds the HTML only for the slides a `slide-revised` event points at: a
 * revision overwrites `NN.html` in place, so its thumbnail has to be fetched again for the
 * revision, and those bytes are loaded here (slide-previews.ts reads them).
 */
export type ConversationSlide = Readonly<{
  slideIndex: number;
  fileId: string;
  name: string;
  label: string;
  html: HtmlLoad;
  /**
   * WHICH `slide-revised` EVENT THE BYTES IN HAND BELONG TO, or null for the bytes as first staged.
   *
   * A revision overwrites `NN.html` IN PLACE -- that is what keeps the comment threads attached
   * across revisions -- so the file id does NOT change and a cache keyed on it would serve the old
   * slide for ever. Keying on the event instead is what makes a second revision re-fetch.
   */
  fetchedFor: string | null;
}>;

/** Asking Apps Script to show another window. It can be refused, and a refusal has to reach the screen. */
export type OpenPhase =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "opening" }>
  | Readonly<{ kind: "opened" }>
  | Readonly<{ kind: "failed"; message: string }>;

export type ConversationEvent =
  /** `sashaHello` answered: whatever went wrong before it is no longer the panel's trouble. */
  | Readonly<{ kind: "connected" }>
  /** The boot seed, applied once before any read: only onto a panel that has read nothing yet. */
  | Readonly<{ kind: "seeded"; seed: SidebarSeed }>
  | Readonly<{ kind: "trouble"; message: string }>
  | Readonly<{ kind: "staged-requested" }>
  | Readonly<{ kind: "staged-arrived"; marks: readonly ProposalMark[]; readAt: string }>
  | Readonly<{ kind: "staged-failed"; message: string }>
  | Readonly<{ kind: "manifest-requested" }>
  | Readonly<{ kind: "manifest-arrived"; manifest: Manifest }>
  | Readonly<{ kind: "manifest-failed"; message: string }>
  | Readonly<{ kind: "log-requested" }>
  /**
   * `proposalId` is the set the log was read FOR. A reply for a set this panel no longer follows
   * (the fresh scan replaced a seeded one while the read was in flight) is dropped. Replayed
   * single-set fixtures leave it out.
   */
  | Readonly<{ kind: "log-arrived"; events: readonly SessionEvent[]; readAt: string; proposalId?: string }>
  | Readonly<{ kind: "log-failed"; message: string }>
  | Readonly<{ kind: "slide-requested"; slideIndex: number }>
  | Readonly<{ kind: "slide-arrived"; slideIndex: number; html: string }>
  | Readonly<{ kind: "slide-failed"; slideIndex: number; message: string }>
  | Readonly<{ kind: "open-requested" }>
  | Readonly<{ kind: "open-succeeded" }>
  | Readonly<{ kind: "open-failed"; message: string }>
  /** The slides window was shown without the user asking, for this proposal. Recorded once. */
  | Readonly<{ kind: "auto-opened"; proposalId: string }>
  /** The clock moved. Its own event because it changes NOTHING else -- see `nowMs`. */
  | Readonly<{ kind: "clock-ticked"; nowMs: number }>
  | Readonly<{ kind: "candidate-tab-chosen"; tab: CandidateTab }>
  /** The click, before the write: it takes effect now. `atMillis` names the event and the request. */
  | Readonly<{ kind: "archive-requested"; proposalId: string; slideIndex: number; archived: boolean; atMillis: number }>
  | Readonly<{ kind: "archive-written"; proposalId: string; slideIndex: number; atMillis: number; fileId: string }>
  | Readonly<{ kind: "archive-failed"; proposalId: string; slideIndex: number; atMillis: number; message: string }>;

export const INITIAL_CONVERSATION: Conversation = {
  candidateTab: "working",
  archivePending: [],
  archiveTrouble: null,
  staged: { kind: "unrequested" },
  set: { kind: "none" },
  log: { kind: "unrequested" },
  open: { kind: "idle" },
  autoOpened: [],
  logReadOnce: false,
  trouble: null,
  nowMs: null,
  seeded: NOTHING_SEEDED,
};

export function reduceConversation(conversation: Conversation, event: ConversationEvent): Conversation {
  switch (event.kind) {
    case "connected":
      return { ...conversation, trouble: null };

    case "trouble":
      return { ...conversation, trouble: event.message };

    case "seeded":
      return seededFrom({ conversation, seed: event.seed });

    case "clock-ticked":
      // Identity is preserved when the millisecond has not moved, so a tick that lands twice in the
      // same millisecond does not re-render the panel.
      return conversation.nowMs === event.nowMs ? conversation : { ...conversation, nowMs: event.nowMs };

    case "candidate-tab-chosen":
      return { ...conversation, candidateTab: event.tab };

    case "archive-requested": {
      if (followedSet(conversation)?.proposalId !== event.proposalId) return conversation;
      const click: PendingArchive = {
        proposalId: event.proposalId,
        slideIndex: event.slideIndex,
        archived: event.archived,
        atMillis: event.atMillis,
        fileId: null,
      };
      return {
        ...conversation,
        archivePending: [
          ...conversation.archivePending.filter((pending) => pending.slideIndex !== event.slideIndex),
          click,
        ],
        archiveTrouble: null,
      };
    }

    case "archive-written":
      return {
        ...conversation,
        archivePending: conversation.archivePending.map((pending) =>
          isArchiveRequest({ pending, request: event }) ? { ...pending, fileId: event.fileId } : pending,
        ),
      };

    case "archive-failed": {
      const failed = conversation.archivePending.find((pending) => isArchiveRequest({ pending, request: event }));
      // A failure for a click a NEWER click already replaced changes nothing on screen: the newer
      // click is what the user wants now, and it reports its own outcome.
      if (failed === undefined) return conversation;
      return {
        ...conversation,
        archivePending: conversation.archivePending.filter((pending) => pending !== failed),
        archiveTrouble:
          `could not ${failed.archived ? "archive" : "restore"} candidate ${String(event.slideIndex)}: ` +
          event.message,
      };
    }

    case "staged-requested":
      return { ...conversation, staged: { kind: "loading", had: stagedResultOf(conversation.staged) } };

    case "staged-arrived": {
      const proposals = stagedProposalsOf({ marks: event.marks });
      // THE FIRST FRESH SCAN AFTER A SEED decides whether the seeded set is still the one to
      // follow. The set is otherwise sticky, which is right for a set the user has seen answered
      // in this session and wrong for one remembered from the last: a fresh "nothing staged" or a
      // different newest proposal must replace what the seed drew.
      const base = conversation.seeded.scan ? confirmedOrForgotten({ conversation, proposals }) : conversation;
      return {
        ...base,
        staged: { kind: "loaded", proposals, readAt: event.readAt },
        ...followOn({ conversation: base, proposals }),
      };
    }

    case "staged-failed":
      return { ...conversation, staged: { kind: "failed", message: event.message } };

    case "manifest-requested":
      return withSet(conversation, (set) => ({ ...set, manifest: { kind: "loading" } }));

    case "manifest-arrived":
      // A manifest for another proposal is a read that was in flight when the followed set
      // changed. Its own set has a read of its own coming, so this one is dropped.
      if (followedSet(conversation)?.proposalId !== event.manifest.proposalId) return conversation;
      return withSet({ ...conversation, seeded: { ...conversation.seeded, manifest: false } }, (set) => ({
        ...set,
        manifest: {
          kind: "loaded",
          count: event.manifest.count,
          revision: event.manifest.revision,
          forEventId: newestSetChangeIn(loadedEvents(conversation.log)),
          presentationId: event.manifest.presentationId,
          merge: event.manifest.merge,
        },
        slides: event.manifest.slides.map((slide) => slideOf({ slide, slides: set.slides })),
      }));

    case "manifest-failed":
      return withSet({ ...conversation, seeded: { ...conversation.seeded, manifest: false } }, (set) => ({
        ...set,
        manifest: {
          kind: "failed",
          message: event.message,
          // The failure is recorded AGAINST the log it was read at, so a later event retries it
          // rather than leaving the panel stuck on one bad read.
          forEventId: newestSetChangeIn(loadedEvents(conversation.log)),
        },
      }));

    case "log-requested":
      return { ...conversation, log: { kind: "loading", events: loadedEvents(conversation.log) } };

    case "log-arrived":
      if (event.proposalId !== undefined && followedSet(conversation)?.proposalId !== event.proposalId) {
        return conversation;
      }
      return {
        ...conversation,
        log: { kind: "loaded", events: event.events, readAt: event.readAt },
        // A written click whose event is now in the log is handed over to the log.
        archivePending: pendingAfterLog({ pending: conversation.archivePending, events: event.events }),
        logReadOnce: true,
        seeded: {
          ...conversation.seeded,
          log: false,
          // A SEEDED MANIFEST IS VERIFIED BY THE FRESH LOG, not by reading it again: the protocol's
          // own rule is that a set-changing event is what makes a manifest stale. If the newest one
          // is still the one it was read at, it is current; if not, `needsManifest` re-reads it and
          // `manifest-arrived` clears the flag.
          manifest: conversation.seeded.manifest && !seededManifestIsCurrent({ conversation, events: event.events }),
        },
      };

    case "log-failed":
      return {
        ...conversation,
        log: { kind: "failed", message: event.message, events: loadedEvents(conversation.log) },
      };

    case "slide-requested": {
      // Stamped with the revision the fetch is FOR, so a revision that lands while this one is in
      // flight is seen as a new fetch rather than satisfied by the bytes already on the way.
      const fetchedFor = latestRevisionIdFor({ conversation, slideIndex: event.slideIndex });
      return mapSlide(conversation, event.slideIndex, (slide) => ({
        ...slide,
        html: { kind: "loading" },
        fetchedFor,
      }));
    }

    case "slide-arrived":
      return mapSlide(conversation, event.slideIndex, (slide) => ({
        ...slide,
        html: { kind: "loaded", html: event.html },
      }));

    case "slide-failed":
      return mapSlide(conversation, event.slideIndex, (slide) => ({
        ...slide,
        html: { kind: "failed", message: event.message },
      }));

    case "open-requested":
      return { ...conversation, open: { kind: "opening" } };

    case "open-succeeded":
      return { ...conversation, open: { kind: "opened" } };

    case "open-failed":
      return { ...conversation, open: { kind: "failed", message: event.message } };

    case "auto-opened":
      return conversation.autoOpened.includes(event.proposalId)
        ? conversation
        : { ...conversation, autoOpened: [...conversation.autoOpened, event.proposalId] };

    default:
      return assertNever(event);
  }
}

/**
 * THE CONNECTION LINE, as one verdict over the presence evidence. One union rather than a pair of
 * booleans, so the panel renders exactly one of the three and a fourth is a compile error there.
 */
export type AssistantConnection =
  /** Fresh evidence that an assistant was here. `agoMs` is since the newest of it. */
  | Readonly<{ kind: "connected"; agoMs: number | null }>
  /** The reads that could prove it either way are not in yet, and `reason` says which. Nothing is claimed. */
  | Readonly<{ kind: "checking"; reason: string }>
  /** No evidence, or only stale evidence: the setup guide says how to attach one. */
  | Readonly<{ kind: "nothing-listening"; notice: NothingListeningNotice }>;

export function assistantConnectionOf(conversation: Conversation): AssistantConnection {
  const presence = sashaPresence(conversation);
  switch (presence.kind) {
    case "never-acted":
      return { kind: "nothing-listening", notice: nothingListeningNotice() };
    case "unknown":
      return { kind: "checking", reason: presence.message };
    case "acted":
      return presenceIsSilent(presence)
        ? { kind: "nothing-listening", notice: nothingListeningNotice() }
        : { kind: "connected", agoMs: presence.heardAgoMs };
    case "delivered":
      return presenceIsSilent(presence)
        ? { kind: "nothing-listening", notice: nothingListeningNotice() }
        : { kind: "connected", agoMs: presence.agoMs };
    default:
      return assertNever(presence);
  }
}

/**
 * WHETHER ANYTHING HAS EVER BEEN LISTENING, from the log the panel already polls. It is the honest
 * half of the connection line: "connected" and "nobody is listening" look identical without it.
 */
export function sashaPresence(conversation: Conversation): SashaPresence {
  return sashaPresenceOf({
    events: loadedEvents(conversation.log),
    reads: presenceReadsOf(conversation),
    nowMs: conversation.nowMs,
  });
}

/**
 * WHY "NOBODY HAS EVER ANSWERED" CANNOT BE CLAIMED YET, or null when it can.
 *
 * WITH NO SET THERE IS NO LOG TO READ, and waiting for one would keep presence `unknown` for ever.
 * Once the staged scan has come back empty, there is no evidence anywhere, which is the answer.
 * Before that scan lands, a set may yet appear, so its outcome is the reason instead.
 */
export function presenceReadsOf(conversation: Conversation): PresenceReads {
  switch (conversation.set.kind) {
    case "none":
      return { incomplete: reasonOfStagedScan(conversation.staged) };
    case "following":
      // A SEEDED LOG IS EVIDENCE TOO -- last known, shown as such -- so the connection line is drawn
      // from it at once rather than "checking" until the fresh read lands.
      return {
        incomplete: conversation.logReadOnce || conversation.seeded.log ? null : reasonOfLogRead(conversation.log),
      };
    default:
      return assertNever(conversation.set);
  }
}

/**
 * WHETHER THE SLIDES WINDOW SHOULD BE OPENED WITHOUT BEING ASKED, and which proposal for.
 *
 * "The dialog opens by itself when slides arrive" (UI-CONTRACT.md) -- once, per proposal. It is a
 * decision over the state rather than a side effect in a fetch handler, so it is testable with
 * values and so a user who closes the window is not dragged back into it on the next poll.
 */
export function proposalToAutoOpen(conversation: Conversation): string | null {
  // NEVER ON A SEED. The seeded set may have been answered or replaced since it was remembered, and
  // a window opened onto it would be acting on what the last session saw. The fresh reads land
  // within seconds, and the decision is made on them.
  if (seedIsRefreshing(conversation)) return null;
  // It waits for the MANIFEST rather than firing on the scan, and that costs one round trip on
  // purpose: `READY` survives a clear, so a scan alone cannot tell a staged set from a discarded
  // one, and opening a window onto nothing is worse than opening it a second later.
  const reachable = slidesReachability(conversation);
  if (reachable.kind !== "reachable") return null;
  if (conversation.set.kind !== "following" || conversation.set.manifest.kind !== "loaded") return null;
  if (conversation.set.manifest.count === 0) return null;
  // THROUGH `stagedResultOf`, so a refresh in flight still knows what the last scan found.
  const held = stagedResultOf(conversation.staged);
  if (held === null) return null;
  const newest = held.proposals[held.proposals.length - 1];
  if (newest === undefined || newest.proposalId !== reachable.proposalId) return null;
  return conversation.autoOpened.includes(newest.proposalId) ? null : newest.proposalId;
}

/** WHETHER THE SLIDES ARE REACHABLE FROM HERE, and why not when they are not. */
export function slidesReachability(conversation: Conversation): SlidesReachability {
  switch (conversation.set.kind) {
    case "following": {
      const manifest = conversation.set.manifest;
      // A CLEARED SET STILL HAS ITS `READY`. `clear_slides` deletes the uninserted candidates and
      // bumps `revision`; it does not remove the marker. So `READY` is actively stale after a
      // clear and `manifest.count` is the thing to trust.
      if (manifest.kind === "loaded" && manifest.count === 0) {
        return { kind: "cleared", proposalId: conversation.set.proposalId };
      }
      return { kind: "reachable", proposalId: conversation.set.proposalId };
    }
    case "none":
      return unstagedReachability(conversation.staged);
    default:
      return assertNever(conversation.set);
  }
}

export type SlidesReachability =
  | Readonly<{ kind: "reachable"; proposalId: string }>
  /** Sasha discarded the uninserted candidates. */
  | Readonly<{ kind: "cleared"; proposalId: string }>
  /** Nothing has ever been staged in this session. */
  | Readonly<{ kind: "nothing-staged" }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "unreadable"; message: string }>;

/** Which proposals are complete and still unanswered, OLDEST FIRST. PROTOCOL.md's two rules. */
export function stagedProposalsOf({ marks }: { marks: readonly ProposalMark[] }): readonly StagedProposal[] {
  // READY is written last, so its absence means the proposal is still partial; a sibling PICK means
  // the slides window (or a previous session) has already answered it.
  const staged: StagedProposal[] = [];
  for (const mark of marks) {
    if (mark.readyFileId === null || mark.pickFileId !== null) continue;
    staged.push({
      proposalId: mark.proposalId,
      folderId: mark.folderId,
      readyFileId: mark.readyFileId,
      createdTime: mark.createdTime,
    });
  }
  return [...staged].sort((left, right) =>
    left.createdTime < right.createdTime ? -1 : left.createdTime > right.createdTime ? 1 : 0,
  );
}

/**
 * THE SET CARD'S TWO LISTS: Working in the manifest's order, Archived most recently archived
 * first. The log (this set's events only) plus the clicks it has not caught up with.
 */
export function candidateListsOf(conversation: Conversation): CandidateLists<ConversationSlide> {
  const set = conversation.set;
  switch (set.kind) {
    case "none":
      return { working: [], archived: [] };
    case "following":
      return splitCandidates({
        slides: set.slides,
        archived: archivedSlidesOf({
          events: loadedEvents(conversation.log).filter((event) => event.proposalId === set.proposalId),
          pending: conversation.archivePending.filter((pending) => pending.proposalId === set.proposalId),
        }),
      });
    default:
      return assertNever(set);
  }
}

/** The followed set, or null. Every loop is gated on it rather than on `set.kind` inline. */
export function followedSet(conversation: Conversation): FollowedProposal | null {
  switch (conversation.set.kind) {
    case "following":
      return {
        proposalId: conversation.set.proposalId,
        folderId: conversation.set.folderId,
        readyFileId: conversation.set.readyFileId,
      };
    case "none":
      return null;
    default:
      return assertNever(conversation.set);
  }
}

export type FollowedProposal = Readonly<{ proposalId: string; folderId: string; readyFileId: string }>;

/** The followed set's candidates, or none when nothing is followed or its manifest is not in. */
export function slidesOf(conversation: Conversation): readonly ConversationSlide[] {
  switch (conversation.set.kind) {
    case "following":
      return conversation.set.slides;
    case "none":
      return [];
    default:
      return assertNever(conversation.set);
  }
}

/**
 * HOW LONG A FINISHED READ COUNTS AS FRESH -- and the reason it is a DURATION and not simply
 * "loaded means read it again".
 *
 * `sidebar.tsx`'s `dispatch` calls `pump` after every state change, so a `needs*` that answered
 * "yes" the moment a read ARRIVED started the next one immediately: an unbounded chain of Drive
 * calls as fast as Apps Script would answer (measured 2026-10-04). Shorter than the 8 s poll, so
 * every tick still re-reads; long enough that the dispatches between two ticks start nothing.
 */
export const READ_FRESH_MS = 5_000;

/**
 * THE SLOWER READ. Apps Script serialises one user's `google.script.run` calls, and the SLIDES
 * WINDOW shares that queue; a proposal appearing in the inbox twenty seconds late is not a defect,
 * a starved sibling window is.
 */
export const SCAN_FRESH_MS = 20_000;

/**
 * What a scan still holds when another one starts: the previous result, through however many
 * refreshes. A failed scan keeps the last GOOD one too -- one bad round trip is not a reason to
 * blank a panel that was fine a moment ago.
 */
export function stagedResultOf(staged: StagedLoad): Readonly<{ proposals: readonly StagedProposal[]; readAt: string }> | null {
  switch (staged.kind) {
    case "loaded":
      return { proposals: staged.proposals, readAt: staged.readAt };
    case "loading":
      return staged.had;
    case "unrequested":
    case "failed":
      return null;
    default:
      return assertNever(staged);
  }
}

/**
 * WHETHER THE PANEL IS STILL OPENING -- before the first inbox scan has said anything. In that
 * state there is nothing to report and nothing to offer, so the panel renders ONE spinner.
 *
 * A FAILED first scan is NOT opening. It has an answer -- a bad one -- and this project's own rule
 * is that there is no spinner that cannot end, so the failure is said out loud instead.
 */
export function conversationIsOpening(conversation: Conversation): boolean {
  // A trouble before anything loaded ends the opening: a failed sashaHello stops sidebar.tsx before
  // any scan lands, and a spinner under the error would turn for ever.
  if (conversation.trouble !== null) return false;
  switch (conversation.staged.kind) {
    case "unrequested":
      return true;
    // ONLY THE FIRST ONE. A scan that already has a previous result is a refresh, and a refresh
    // keeps the panel on screen (see `StagedLoad`).
    case "loading":
      return conversation.staged.had === null;
    case "loaded":
    case "failed":
      return false;
    default:
      return assertNever(conversation.staged);
  }
}

/**
 * WHETHER A POLL SHOULD SCAN AGAIN. "Loaded" is not "done": a proposal staged later has to appear.
 * The only "no" is a read already IN FLIGHT, or one still fresh.
 */
export function needsStaged(conversation: Conversation): boolean {
  switch (conversation.staged.kind) {
    case "unrequested":
    case "failed":
      return true;
    case "loaded":
      // A seeded scan is due at once, whenever it was made: it is what the LAST session saw.
      return (
        conversation.seeded.scan ||
        isStale({ readAt: conversation.staged.readAt, nowMs: conversation.nowMs, freshMs: SCAN_FRESH_MS })
      );
    case "loading":
      return false;
    default:
      return assertNever(conversation.staged);
  }
}

/**
 * Whether the manifest wants reading. Not a plain once-per-request gate: it is re-read when the
 * LOG says the candidate set changed, which is the only signal the add-on is allowed to use (it
 * must never write `manifest.json`, so it must never treat `revision` as its own clock).
 */
export function needsManifest(conversation: Conversation): boolean {
  if (conversation.set.kind === "none") return false;
  const atEvent = newestSetChangeIn(loadedEvents(conversation.log));
  switch (conversation.set.manifest.kind) {
    case "unrequested":
      return true;
    case "loading":
      return false;
    case "loaded":
    case "failed":
      return conversation.set.manifest.forEventId !== atEvent;
    default:
      return assertNever(conversation.set.manifest);
  }
}

/** Same contract as `needsStaged`, for the event log. False when there is no proposal folder to read. */
export function needsLog(conversation: Conversation): boolean {
  if (conversation.set.kind === "none") return false;
  switch (conversation.log.kind) {
    case "unrequested":
    case "failed":
      return true;
    case "loaded":
      return (
        conversation.seeded.log ||
        isStale({ readAt: conversation.log.readAt, nowMs: conversation.nowMs, freshMs: READ_FRESH_MS })
      );
    case "loading":
      return false;
    default:
      return assertNever(conversation.log);
  }
}

/**
 * THE NEXT REVISED SLIDE WHOSE HTML IS WANTED, or null. Only the slides a `slide-revised` event
 * points at are fetched here; every other thumbnail comes from slide-previews.ts's batch.
 *
 * A SECOND REVISION RE-FETCHES. `NN.html` is overwritten in place, so the file id is unchanged and
 * the bytes in hand are keyed on the revision event instead -- without that, the thumbnail would
 * show the first revision for ever.
 */
export function nextRevisedSlideToLoad(conversation: Conversation): ConversationSlide | null {
  for (const slide of slidesOf(conversation)) {
    const latest = latestRevisionIdFor({ conversation, slideIndex: slide.slideIndex });
    if (latest === null) continue;
    if (wantsFetch({ html: slide.html, fetchedFor: slide.fetchedFor, latest })) return slide;
  }
  return null;
}

/**
 * The events to derive from: whatever was last loaded, even while a re-read is in flight and even
 * when the most recent one failed. Only `unrequested` -- nothing has ever been read -- is empty.
 */
export function loadedEvents(log: SessionLogLoad): readonly SessionEvent[] {
  switch (log.kind) {
    case "loading":
    case "loaded":
    case "failed":
      return log.events;
    case "unrequested":
      return [];
    default:
      return assertNever(log);
  }
}

/** Whether the staged scan has come back at least once. A re-scan in flight keeps what it had. */
function reasonOfStagedScan(staged: StagedLoad): string | null {
  switch (staged.kind) {
    case "loaded":
      return null;
    case "loading":
      return staged.had === null ? "the candidate slides are still being looked for" : null;
    case "unrequested":
      return "the candidate slides are still being looked for";
    case "failed":
      return staged.message;
    default:
      return assertNever(staged);
  }
}

/** Whether the event log can yet support a claim about presence. A switch, so every arm answers. */
function reasonOfLogRead(log: SessionLogLoad): string | null {
  switch (log.kind) {
    case "loaded":
      return null;
    case "unrequested":
    case "loading":
      return "the event log is still being read";
    case "failed":
      return log.message;
    default:
      return assertNever(log);
  }
}

function unstagedReachability(staged: StagedLoad): SlidesReachability {
  // A refresh keeps the last answer: "unknown" for the length of every poll would make the
  // reachability flicker between states for the life of the session.
  if (stagedResultOf(staged) !== null) return { kind: "nothing-staged" };
  switch (staged.kind) {
    case "unrequested":
    case "loading":
      return { kind: "unknown" };
    case "failed":
      return { kind: "unreadable", message: staged.message };
    case "loaded":
      return { kind: "nothing-staged" };
    default:
      return assertNever(staged);
  }
}

/**
 * WHETHER ANYTHING ON SCREEN IS STILL THE SEED'S, i.e. last known rather than just read. The panel
 * says "Updating" while it is, and nothing acts on the data until it is not.
 */
export function seedIsRefreshing(conversation: Conversation): boolean {
  const seeded = conversation.seeded;
  return seeded.scan || seeded.manifest || seeded.log;
}

/**
 * THE SEED, applied. Only onto a panel that has read nothing yet: a seed must never overwrite a
 * fresh read, so arriving late it changes nothing. The manifest and the log are only taken when
 * they belong to the set the seeded scan follows; anything else is another set's, and dropped.
 */
function seededFrom({ conversation, seed }: { conversation: Conversation; seed: SidebarSeed }): Conversation {
  if (conversation.staged.kind !== "unrequested" || conversation.set.kind !== "none") return conversation;
  const proposals = stagedProposalsOf({ marks: seed.marks });
  const scanned: Conversation = {
    ...conversation,
    staged: { kind: "loaded", proposals, readAt: seed.scanReadAt },
    ...followOn({ conversation, proposals }),
    seeded: { scan: true, manifest: false, log: false },
  };
  const set = scanned.set;
  if (set.kind !== "following") return scanned;
  const log = seed.log !== null && seed.log.folderId === set.folderId ? seed.log : null;
  const logged: Conversation =
    log === null
      ? scanned
      : {
          ...scanned,
          log: { kind: "loaded", events: log.events, readAt: log.readAt },
          seeded: { ...scanned.seeded, log: true },
        };
  const remembered = seed.manifest;
  if (remembered === null || remembered.manifest.proposalId !== set.proposalId) return logged;
  return {
    ...logged,
    set: {
      ...set,
      manifest: loadedManifestOf({ manifest: remembered.manifest, forEventId: remembered.forEventId }),
      slides: remembered.manifest.slides.map((slide) => slideOf({ slide, slides: [] })),
    },
    seeded: { ...logged.seeded, manifest: true },
  };
}

/**
 * THE FIRST FRESH SCAN AFTER A SEED. The seeded set is kept when the scan's newest proposal is the
 * same folder with the same READY; otherwise everything the seed drew is forgotten, so `followOn`
 * adopts from nothing exactly as it would have without a seed.
 */
function confirmedOrForgotten({
  conversation,
  proposals,
}: {
  conversation: Conversation;
  proposals: readonly StagedProposal[];
}): Conversation {
  const newest = proposals[proposals.length - 1];
  const set = conversation.set;
  const confirmed =
    set.kind === "following" &&
    newest !== undefined &&
    newest.proposalId === set.proposalId &&
    newest.folderId === set.folderId &&
    newest.readyFileId === set.readyFileId;
  if (confirmed) return { ...conversation, seeded: { ...conversation.seeded, scan: false } };
  return {
    ...conversation,
    set: { kind: "none" },
    log: { kind: "unrequested" },
    logReadOnce: false,
    candidateTab: "working",
    archivePending: [],
    archiveTrouble: null,
    seeded: NOTHING_SEEDED,
  };
}

/** Whether the seeded manifest was read at the newest set-changing event of a FRESH log. */
function seededManifestIsCurrent({
  conversation,
  events,
}: {
  conversation: Conversation;
  events: readonly SessionEvent[];
}): boolean {
  const set = conversation.set;
  return set.kind === "following" && set.manifest.kind === "loaded" && set.manifest.forEventId === newestSetChangeIn(events);
}

function loadedManifestOf({ manifest, forEventId }: { manifest: Manifest; forEventId: string | null }): ManifestLoad {
  return {
    kind: "loaded",
    count: manifest.count,
    revision: manifest.revision,
    forEventId,
    presentationId: manifest.presentationId,
    merge: manifest.merge,
  };
}

/**
 * Adopt or replace the followed set. A STRICTLY NEWER proposal replaces it (and resets the log and
 * the manifest, which are both about the old one); the same proposal, or an older one still sitting
 * in the inbox, changes nothing -- re-adopting would re-fetch the manifest on every poll.
 */
function followOn({
  conversation,
  proposals,
}: {
  conversation: Conversation;
  proposals: readonly StagedProposal[];
}): Partial<Conversation> {
  const newest = proposals[proposals.length - 1];
  if (newest === undefined) return {};
  const current = conversation.set;
  if (current.kind === "following") {
    if (current.proposalId === newest.proposalId) return {};
    if (newest.createdTime <= current.createdTime) return {};
  }
  return {
    set: {
      kind: "following",
      proposalId: newest.proposalId,
      folderId: newest.folderId,
      readyFileId: newest.readyFileId,
      createdTime: newest.createdTime,
      manifest: { kind: "unrequested" },
      slides: [],
    },
    log: { kind: "unrequested" },
    // A NEW set starts on its working list, with nothing of the old set's clicks.
    candidateTab: "working",
    archivePending: [],
    archiveTrouble: null,
    // A NEW set's log has not been read; the old set's read says nothing about it.
    logReadOnce: false,
    // Nor is a seeded manifest or log about it.
    seeded: { ...conversation.seeded, manifest: false, log: false },
  };
}

/**
 * With NO clock yet, or an undateable read, the answer is STALE: a panel that silently stops
 * reading is a worse failure than one that reads twice.
 */
function isStale(options: Readonly<{ readAt: string; nowMs: number | null; freshMs: number }>): boolean {
  const { readAt, nowMs, freshMs } = options;
  if (nowMs === null) return true;
  const readAtMs = Date.parse(readAt);
  if (!Number.isFinite(readAtMs)) return true;
  return nowMs - readAtMs >= freshMs;
}

/**
 * The newest `slide-revised` event for a slide, by event id, or null when there is none. Read off
 * the ORDERED log, so "newest" is the log's own order.
 */
function latestRevisionIdFor({
  conversation,
  slideIndex,
}: {
  conversation: Conversation;
  slideIndex: number;
}): string | null {
  let latest: string | null = null;
  for (const event of loadedEvents(conversation.log)) {
    if (event.body.kind !== "slide-revised") continue;
    if (slideIndexOf(event.body) !== slideIndex) continue;
    latest = event.eventId;
  }
  return latest;
}

/** Change the followed set, or do nothing when none is followed. */
function withSet(
  conversation: Conversation,
  change: (set: Extract<FollowedSet, { kind: "following" }>) => FollowedSet,
): Conversation {
  switch (conversation.set.kind) {
    case "none":
      return conversation;
    case "following":
      return { ...conversation, set: change(conversation.set) };
    default:
      return assertNever(conversation.set);
  }
}

function mapSlide(
  conversation: Conversation,
  slideIndex: number,
  change: (slide: ConversationSlide) => ConversationSlide,
): Conversation {
  return withSet(conversation, (set) => ({
    ...set,
    slides: set.slides.map((slide) => (slide.slideIndex === slideIndex ? change(slide) : slide)),
  }));
}

/**
 * A manifest entry as a slide, KEEPING the HTML already fetched for that index. A revision bumps
 * the manifest's `revision`, so this runs again after every revision -- and dropping the bytes
 * would make the thumbnail flash back to "loading" each time.
 */
function slideOf({
  slide,
  slides,
}: {
  slide: SlideEntry;
  slides: readonly ConversationSlide[];
}): ConversationSlide {
  const known = slides.find((candidate) => candidate.slideIndex === slide.index);
  // A DIFFERENT file id means a different document, so the bytes are not the same slide's. The
  // SAME file id with new bytes (a revision in place) is handled by `fetchedFor`, not here.
  const kept = known !== undefined && known.fileId === slide.fileId;
  return {
    slideIndex: slide.index,
    fileId: slide.fileId,
    name: slide.name,
    label: slide.label,
    html: kept && known !== undefined ? known.html : { kind: "unrequested" },
    fetchedFor: kept && known !== undefined ? known.fetchedFor : null,
  };
}

/**
 * Whether a slide's bytes have to be fetched for the revision now on screen. An exhaustive switch
 * over the load union, so a new variant has to say whether it wants one.
 */
function wantsFetch({
  html,
  fetchedFor,
  latest,
}: {
  html: HtmlLoad;
  fetchedFor: string | null;
  latest: string;
}): boolean {
  switch (html.kind) {
    case "unrequested":
      return true;
    case "loading":
      // Already on its way FOR this revision. A newer one restamps `fetchedFor`, so this becomes
      // true again on the next pump rather than two fetches racing for the same slide.
      return fetchedFor !== latest;
    case "loaded":
    case "failed":
      return fetchedFor !== latest;
    default:
      return assertNever(html);
  }
}

/** Whether a pending click is the one an outcome is about: same set, same slide, same millisecond. */
function isArchiveRequest({
  pending,
  request,
}: {
  pending: PendingArchive;
  request: Readonly<{ proposalId: string; slideIndex: number; atMillis: number }>;
}): boolean {
  return (
    pending.proposalId === request.proposalId &&
    pending.slideIndex === request.slideIndex &&
    pending.atMillis === request.atMillis
  );
}
