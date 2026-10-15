// AGENT HISTORIES: the deck server's replica applies Claude's edits (and imports) itself, and a
// person can take back everything one agent session did ("Undo Claude's edit", `deck_revert`).
// SPEC.md 21.6 "Agent history".
//
// Key decisions:
//
//  * ONE ORIGIN OBJECT AND ONE Y.UndoManager PER AGENT SESSION. Each session's envelopes are written
//    under that session's own origin, and its undo manager tracks only that origin, so undoing
//    session A never touches session B's steps, a person's edits, or the replica's repairs. The
//    document store's own history (LOCAL_EDIT_ORIGIN) is untouched: the server never types.
//  * EVERY ENVELOPE IS ITS OWN STEP. `stopCapturing()` runs before each one and the capture timeout
//    is infinite, so Yjs's wall clock never merges two of Claude's calls into one step.
//  * A REVERT UNDOES NEWEST FIRST AND COUNTS WHAT IT SKIPS. Yjs does not restore a map entry someone
//    else overwrote since (document-store.ts "Undo against collaborators"); a step whose undo changes
//    nothing is popped past, and the revert reports it in `skippedSteps` instead of hiding it.
//  * PERSON ENVELOPES (an import a person started) use SERVER_EDIT_ORIGIN, which no history tracks:
//    only agent work is revertible here; a person undoes their own work in their own editor.
//  * IN MEMORY ONLY. A restart forgets every history; a revert then answers that there is nothing to
//    revert (SPEC.md 21.6).

import * as Y from "yjs";
import { assertNever } from "../contracts/assert-never.ts";
import type { CommandEnvelope, CommandOutcome } from "../contracts/commands.ts";
import type { RandomSource } from "../contracts/ids.ts";
import { UNDO_SCOPE_ROOTS } from "../contracts/yjs-schema.ts";
import { applyCommand } from "./command-application.ts";
import { validateEnvelope } from "./command-validation.ts";
import { documentRoots } from "./document-paths.ts";

/** The origin of an envelope a person (not an agent) asked the server's replica to apply: never undoable here. */
export const SERVER_EDIT_ORIGIN: Readonly<{ kind: "serverEdit" }> = Object.freeze({ kind: "serverEdit" });

export type AgentHistories = Disposable &
  Readonly<{
    /** Validates and writes one envelope on the shared document; an agent's lands on its session's history. */
    apply(envelope: CommandEnvelope): CommandOutcome;
    /** Undoes every step of the session, newest first. A session with no history reverts nothing. */
    revert(options: Readonly<{ agentSessionId: string }>): AgentRevertResult;
    /** Sessions with revertible steps, newest edit first. */
    sessions(): readonly AgentSessionHistory[];
    /** True while any session still has a step to revert (the room then stays loaded longer). */
    hasHistory(): boolean;
    /** True when `origin` is one of this object's transaction origins (an agent session's or a server edit's). */
    ownsOrigin(origin: unknown): boolean;
  }>;

export type AgentRevertResult = Readonly<{ stepsReverted: number; skippedSteps: number }>;

export type AgentSessionHistory = Readonly<{ agentSessionId: string; agentName: string; editCount: number; lastEditAt: number }>;

export function createAgentHistories(
  options: Readonly<{
    sharedDocument: Y.Doc;
    random: RandomSource;
    now: () => number;
    /** The document store's current revision, for `basedOnRevision` checks and the outcome. */
    revision: () => number;
  }>,
): AgentHistories {
  const { sharedDocument, random, now, revision } = options;
  const roots = documentRoots(sharedDocument);
  const histories = new Map<string, SessionHistory>();
  const origins = new WeakSet<object>([SERVER_EDIT_ORIGIN]);

  const historyFor = (author: Readonly<{ name: string; agentSessionId: string }>): SessionHistory => {
    const existing = histories.get(author.agentSessionId);
    if (existing !== undefined) return existing;
    const origin = Object.freeze({ kind: "agentSession", agentSessionId: author.agentSessionId });
    origins.add(origin);
    const undoManager = new Y.UndoManager(
      UNDO_SCOPE_ROOTS.map((name) => roots[name]),
      { captureTimeout: Number.POSITIVE_INFINITY, trackedOrigins: new Set<unknown>([origin]) },
    );
    const created: SessionHistory = { origin, undoManager, agentName: author.name, editCount: 0, lastEditAt: 0 };
    histories.set(author.agentSessionId, created);
    return created;
  };

  const write = (envelope: CommandEnvelope, origin: object): void => {
    const context = { roots, random, now, author: envelope.author };
    sharedDocument.transact(() => {
      for (const command of envelope.commands) applyCommand(context, command);
    }, origin);
  };

  return {
    apply: (envelope) => {
      const rejection = validateEnvelope({ context: { roots, revision: revision() }, envelope });
      if (rejection !== null) return { kind: "rejected", commandId: envelope.commandId, rejection };
      const author = envelope.author;
      switch (author.kind) {
        case "person":
          write(envelope, SERVER_EDIT_ORIGIN);
          break;
        case "agent": {
          const history = historyFor(author);
          history.undoManager.stopCapturing();
          write(envelope, history.origin);
          history.editCount += 1;
          history.lastEditAt = now();
          break;
        }
        default:
          return assertNever(author);
      }
      return { kind: "applied", commandId: envelope.commandId, revision: revision() };
    },
    revert: ({ agentSessionId }) => {
      const history = histories.get(agentSessionId);
      if (history === undefined) return { stepsReverted: 0, skippedSteps: 0 };
      const stack = history.undoManager.undoStack;
      let stepsReverted = 0;
      let skippedSteps = 0;
      while (stack.length > 0) {
        const before = stack.length;
        const popped = history.undoManager.undo();
        const after = history.undoManager.undoStack.length;
        skippedSteps += before - after - (popped === null ? 0 : 1);
        if (popped !== null) stepsReverted += 1;
      }
      // The session is spent: its redo stack would only let a revert be reverted, which nothing offers.
      history.undoManager.destroy();
      histories.delete(agentSessionId);
      return { stepsReverted, skippedSteps };
    },
    sessions: () =>
      [...histories.entries()]
        .filter(([, history]) => history.undoManager.undoStack.length > 0)
        .map(([agentSessionId, history]) => ({ agentSessionId, agentName: history.agentName, editCount: history.editCount, lastEditAt: history.lastEditAt }))
        .sort((left, right) => right.lastEditAt - left.lastEditAt),
    hasHistory: () => [...histories.values()].some((history) => history.undoManager.undoStack.length > 0),
    ownsOrigin: (origin) => typeof origin === "object" && origin !== null && origins.has(origin),
    [Symbol.dispose]: () => {
      for (const history of histories.values()) history.undoManager.destroy();
      histories.clear();
    },
  };
}

/** Mutable on purpose: the counters belong to this module's closure and never leave it. */
type SessionHistory = {
  readonly origin: object;
  readonly undoManager: Y.UndoManager;
  readonly agentName: string;
  editCount: number;
  lastEditAt: number;
};
