// The observer actor: a mailbox around reduceObserver plus the executor that turns its effect
// VALUES into Drive calls, timers and announcements. Every dependency is injected, so the whole
// loop runs in a unit test against a fake Drive, a fake timer and an array-collecting announcer.
//
// Flow is one-directional and circular, as everywhere else in this repo: event -> reduce -> effects
// -> executed at the boundary -> new events. Nothing outside this file reads or writes the state.

import type { DriveApi } from "./drive-api.ts";
import {
  INITIAL_OBSERVER_STATE,
  POLLED_ROLES,
  POLL_PAGE_SIZE,
  reduceObserver,
  type ObserverEffect,
  type ObserverEvent,
  type ObserverState,
  type Proposal,
} from "./observer.ts";
import { assertNever, parseManifest, parseReadyMarker, type Parsed } from "./protocol.ts";

/** Where a proposal (or a problem) is published. The content scripts are the only subscribers. */
export type Announcer = Readonly<{
  proposal(proposal: Proposal): void;
  trouble(message: string): void;
}>;

/** One pending poll, replaceable. Injected so tests advance time instead of waiting for it. */
export type PollTimer = Readonly<{
  schedule(spec: Readonly<{ delayMs: number; fire: () => void }>): void;
  cancel(): void;
}>;

export type SeenStore = Readonly<{
  read(): Promise<readonly string[]>;
  write(seenProposalIds: readonly string[]): Promise<void>;
}>;

export type Logger = Readonly<{ warn(message: string): void }>;

export type Observer = Readonly<{
  /** Loads the persisted `seen` set. Call once, before the first viewer connects. */
  start(): Promise<void>;
  dispatch(event: ObserverEvent): void;
  /**
   * Drains the mailbox to a fixed point: each drained event may append more, so this loops until
   * the chain stops growing. A fixed number of hops is NOT enough -- one poll expands into listed
   * -> load-proposal -> loaded -> announce, and a two-hop await passed or failed depending on how
   * many microtasks the fake Drive happened to use.
   */
  settled(): Promise<void>;
  snapshot(): ObserverState;
}>;

export function createObserver({
  drive,
  announcer,
  timer,
  seen,
  log,
  nowMs,
}: {
  drive: DriveApi;
  announcer: Announcer;
  timer: PollTimer;
  seen: SeenStore;
  log: Logger;
  nowMs: () => number;
}): Observer {
  let state: ObserverState = INITIAL_OBSERVER_STATE;
  // The mailbox. Serialising on one promise chain is what guarantees reduceObserver is never
  // re-entered, so the reducer may stay a plain pure function with no locking of its own.
  let mailbox: Promise<void> = Promise.resolve();

  const observer: Observer = {
    async start() {
      dispatch({ kind: "restored", seenProposalIds: await seen.read() });
      await observer.settled();
    },
    dispatch,
    async settled() {
      let drained: Promise<void> | null = null;
      while (drained !== mailbox) {
        drained = mailbox;
        await drained;
      }
    },
    snapshot() {
      return state;
    },
  };
  return observer;

  function dispatch(event: ObserverEvent): void {
    mailbox = mailbox.then(() => step(event));
  }

  async function step(event: ObserverEvent): Promise<void> {
    const reduction = reduceObserver(state, event);
    state = reduction.state;
    for (const effect of reduction.effects) await execute(effect);
  }

  async function execute(effect: ObserverEffect): Promise<void> {
    switch (effect.kind) {
      case "list-files":
        await listFiles();
        return;
      case "load-proposal":
        await loadProposal(effect);
        return;
      case "announce-proposal":
        announcer.proposal(effect.proposal);
        return;
      case "announce-trouble":
        announcer.trouble(effect.message);
        return;
      case "schedule-poll":
        timer.schedule({ delayMs: effect.delayMs, fire: () => dispatch({ kind: "poll-due", nowMs: nowMs() }) });
        return;
      case "cancel-poll":
        timer.cancel();
        return;
      case "persist-seen":
        await seen.write(effect.seenProposalIds);
        return;
      case "warn":
        log.warn(effect.message);
        return;
      default:
        return assertNever(effect);
    }
  }

  async function listFiles(): Promise<void> {
    const outcome = await drive.listByRoles({ roles: [...POLLED_ROLES], pageSize: POLL_PAGE_SIZE });
    switch (outcome.kind) {
      case "ok":
        dispatch({ kind: "listed", files: outcome.value, nowMs: nowMs() });
        return;
      case "unauthorized":
        dispatch({ kind: "list-failed", message: `Drive rejected the token: ${outcome.message}`, nowMs: nowMs() });
        return;
      case "failed":
        dispatch({
          kind: "list-failed",
          message: `Drive list failed (${outcome.status ?? "no status"}): ${outcome.message}`,
          nowMs: nowMs(),
        });
        return;
      default:
        return assertNever(outcome);
    }
  }

  async function loadProposal({
    proposalId,
    readyFileId,
    folderId,
  }: Readonly<{ proposalId: string; readyFileId: string; folderId: string }>): Promise<void> {
    const loaded = await fetchProposal({ drive, proposalId, readyFileId, folderId });
    switch (loaded.kind) {
      case "ok":
        dispatch({ kind: "loaded", proposal: loaded.value, nowMs: nowMs() });
        return;
      case "unavailable":
        dispatch({ kind: "load-failed", proposalId, message: loaded.message, nowMs: nowMs() });
        return;
      case "rejected":
        dispatch({ kind: "load-rejected", proposalId, reason: loaded.reason, nowMs: nowMs() });
        return;
      default:
        return assertNever(loaded);
    }
  }
}

export type ProposalLoad =
  | Readonly<{ kind: "ok"; value: Proposal }>
  /** Transport: retry it. */
  | Readonly<{ kind: "unavailable"; message: string }>
  /** Content: never retry it. */
  | Readonly<{ kind: "rejected"; reason: string }>;

/**
 * READY -> manifest -> Proposal. READY is written LAST, so by the time its marker is visible both
 * files are complete and this needs no retry-until-consistent dance. The two are still cross-checked
 * against each other: they are separate uploads and a mismatch means the folder is not what the
 * marker claims.
 */
export async function fetchProposal({
  drive,
  proposalId,
  readyFileId,
  folderId,
}: {
  drive: DriveApi;
  proposalId: string;
  readyFileId: string;
  folderId: string;
}): Promise<ProposalLoad> {
  const readyBody = await drive.downloadText(readyFileId);
  if (readyBody.kind !== "ok") return { kind: "unavailable", message: describeDownload(readyBody) };
  const ready = parseReadyMarker(readyBody.value);
  const readyParsed = unwrap({ parsed: ready, what: "READY" });
  if (readyParsed.kind !== "ok") return readyParsed;
  if (readyParsed.value.proposalId !== proposalId) {
    return { kind: "rejected", reason: `READY names ${readyParsed.value.proposalId}, its appProperties ${proposalId}` };
  }

  const manifestBody = await drive.downloadText(readyParsed.value.manifestFileId);
  if (manifestBody.kind !== "ok") return { kind: "unavailable", message: describeDownload(manifestBody) };
  const manifestParsed = unwrap({ parsed: parseManifest(manifestBody.value), what: "manifest.json" });
  if (manifestParsed.kind !== "ok") return manifestParsed;
  const manifest = manifestParsed.value;
  if (manifest.proposalId !== proposalId) {
    return { kind: "rejected", reason: `manifest names ${manifest.proposalId}, READY ${proposalId}` };
  }
  if (manifest.count !== readyParsed.value.count) {
    return { kind: "rejected", reason: `READY count ${readyParsed.value.count} != manifest count ${manifest.count}` };
  }
  return {
    kind: "ok",
    value: {
      proposalId,
      folderId,
      presentationId: manifest.presentationId,
      count: manifest.count,
      slides: manifest.slides,
    },
  };
}

function unwrap<TValue>({
  parsed,
  what,
}: {
  parsed: Parsed<TValue>;
  what: string;
}): Readonly<{ kind: "ok"; value: TValue }> | Readonly<{ kind: "rejected"; reason: string }> {
  switch (parsed.kind) {
    case "ok":
      return parsed;
    case "invalid":
      return { kind: "rejected", reason: `${what} is malformed: ${parsed.reason}` };
    case "unsupported-version":
      return { kind: "rejected", reason: `${what} declares protocolVersion ${parsed.protocolVersion}` };
    default:
      return assertNever(parsed);
  }
}

function describeDownload(outcome: Readonly<{ kind: "unauthorized" | "failed"; message: string }>): string {
  return `${outcome.kind}: ${outcome.message}`;
}
