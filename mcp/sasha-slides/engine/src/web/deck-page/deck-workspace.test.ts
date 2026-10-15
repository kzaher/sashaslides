// THE DECK WORKSPACE (acceptance 8): the editor is composed once the replica is first online, and a
// `resynchroniseRequired` from the server disposes that editor and its replica, composes a new
// editor over a FRESH replica once it is online, and the new session raises 'resynchronising'.
// Runs the real collaboration client and model against the y-protocols fake server.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NEVER, Subject } from "rxjs";
import { Doc } from "yjs";
import type { CollaborationNotice } from "../../contracts/collaboration.ts";
import { createDocumentStore, reduceDiscussionLog } from "../../model/index.ts";
import { createVirtualScheduler } from "../../state/testing/virtual-scheduler.ts";
import { createDeckCollaboration } from "../collaboration/deck-collaboration.ts";
import { createFakeDeckServer } from "../testing/fake-deck-server.ts";
import { TEST_DECK_ID, TEST_PERSON } from "../testing/collaboration-harness.ts";
import { createDeckWorkspace, type DeckReplica } from "./deck-workspace.ts";

type FakeEditor = Disposable & Readonly<{ number: number; document: Doc; notices: CollaborationNotice[]; disposed: () => boolean }>;

function workspaceWithFakes() {
  const scheduler = createVirtualScheduler({ startAt: 0 });
  const server = createFakeDeckServer({ deckId: TEST_DECK_ID, me: TEST_PERSON });
  using _seed = createDocumentStore({ sharedDocument: server.document, seed: { kind: "blankDeck", deckId: TEST_DECK_ID }, now: () => 0, random: () => 0.5, scheduler, repairPolicy: "repairAfterTransaction", typingMergeWindowMilliseconds: 500 });
  const replicas: DeckReplica[] = [];
  const editors: FakeEditor[] = [];
  const openReplica = (options: Readonly<{ initialNotices: readonly CollaborationNotice[] }>): DeckReplica => {
    const documentStore = createDocumentStore({ sharedDocument: new Doc(), seed: { kind: "none" }, now: () => 0, random: () => 0.5, scheduler, repairPolicy: "reportOnly", typingMergeWindowMilliseconds: 500 });
    const collaboration = createDeckCollaboration({
      deckId: TEST_DECK_ID,
      sharedDocument: documentStore.sharedDocument,
      expectedRole: "editor",
      openSocket: server.openSocket,
      syncAddress: () => "wss://sashaslides.test/deck-api/sync/x",
      bearerToken: () => null,
      refreshSession: () => Promise.resolve({ kind: "refreshed" }),
      revertAgentSession: () => Promise.resolve({ kind: "notPermitted" }),
      reduceDiscussionLog,
      browserOnline: new Subject<boolean>(),
      initiallyOnline: true,
      pageVisible: NEVER,
      scheduler,
      random: () => 0.5,
      now: () => 0,
      initialNotices: options.initialNotices,
      reportError: (error) => assert.fail(String(error)),
    });
    const replica: DeckReplica = {
      documentStore,
      collaboration,
      [Symbol.dispose]: () => {
        collaboration[Symbol.dispose]();
        documentStore[Symbol.dispose]();
      },
    };
    replicas.push(replica);
    return replica;
  };
  const workspace = createDeckWorkspace<FakeEditor>({
    openReplica,
    composeEditor: (replica) => {
      // As the editor's collaboration feedback does: subscribe to the session's notices at once.
      const notices: CollaborationNotice[] = [];
      const subscription = replica.collaboration.session.notices.subscribe((notice) => notices.push(notice));
      let disposed = false;
      const editor: FakeEditor = {
        number: editors.length + 1,
        document: replica.documentStore.sharedDocument,
        notices,
        disposed: () => disposed,
        [Symbol.dispose]: () => {
          disposed = true;
          subscription.unsubscribe();
        },
      };
      editors.push(editor);
      return editor;
    },
    reportError: (error) => assert.fail(String(error)),
  });
  return { server, workspace, replicas, editors };
}

describe("8. resynchronising", () => {
  it("composes the editor only once the replica is first online", () => {
    const { server, workspace, editors } = workspaceWithFakes();
    assert.equal(workspace.current().kind, "opening");
    server.latest().open();
    server.latest().welcome();
    server.flushOne();
    assert.equal(workspace.current().kind, "opening", "synchronising is not enough");
    server.flush();
    assert.equal(workspace.current().kind, "ready");
    assert.equal(editors.length, 1);
    workspace[Symbol.dispose]();
    assert.equal(editors[0]?.disposed(), true);
  });

  it("disposes the editor and replica, composes a new one over a fresh replica, and raises 'resynchronising'", () => {
    const { server, workspace, replicas, editors } = workspaceWithFakes();
    server.latest().handshake();
    const first = editors[0];
    assert.ok(first !== undefined);
    assert.deepEqual(first.notices, [], "no notice on the first composition");

    server.latest().sendMessage({ kind: "resynchroniseRequired", reason: "updateFromReadOnlyRole" });
    server.flush();
    assert.equal(first.disposed(), true, "the old editor was disposed");
    assert.equal(server.connections()[0]?.closedByClient(), 1000, "the old replica's socket was closed");
    assert.equal(replicas.length, 2, "a fresh replica");
    assert.equal(workspace.current().kind, "opening");
    assert.equal(editors.length, 1, "no editor before the fresh replica is online");

    server.latest().handshake();
    assert.equal(workspace.current().kind, "ready");
    const second = editors[1];
    assert.ok(second !== undefined);
    assert.notEqual(second.document, first.document, "composed from a new Y.Doc");
    assert.deepEqual(second.notices, [{ kind: "resynchronising", reason: "updateFromReadOnlyRole" }]);
    workspace[Symbol.dispose]();
  });

  it("shows why when the replica closes before it was ever online, and composes nothing", () => {
    const { server, workspace, editors } = workspaceWithFakes();
    server.latest().open();
    server.latest().close(4004);
    assert.deepEqual(workspace.current(), { kind: "unavailable", reason: "deckNotFound", signInAddress: null });
    assert.equal(editors.length, 0);
    workspace[Symbol.dispose]();
  });
});
