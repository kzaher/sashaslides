// THE COLLABORATION CLIENT UNDER TEST: a real model document store on a fresh replica, the real
// `createDeckCollaboration`, a y-protocols fake server (fake-deck-server.ts) whose document is
// seeded with a blank deck, a virtual-time scheduler, and the browser's signals as subjects the
// test drives. Shared by the collaboration and the deck workspace tests.

import { Subject } from "rxjs";
import { Doc } from "yjs";
import type { CollaborationNotice, CollaborationStatus } from "../../contracts/collaboration.ts";
import type { Person } from "../../contracts/discussion.ts";
import type { DocumentChangeOrigin, DocumentStore } from "../../contracts/document-store.ts";
import { mintId, parseDeckId, parsePersonId, type DeckId, type RandomSource } from "../../contracts/ids.ts";
import { createDocumentStore, reduceDiscussionLog } from "../../model/index.ts";
import { createVirtualScheduler, type VirtualScheduler } from "../../state/testing/virtual-scheduler.ts";
import { createDeckCollaboration, type DeckCollaboration, type SessionRefreshOutcome } from "../collaboration/deck-collaboration.ts";
import { createFakeDeckServer, type FakeDeckServer } from "./fake-deck-server.ts";

export const TEST_DECK_ID: DeckId = deckIdOf("dk_TestDeck00000000000000");
export const TEST_PERSON: Person = personOf({ id: "pr_0123456789abcdef0123456789abcdef", displayName: "Ada Lovelace" });
export const PEER_PERSON: Person = personOf({ id: "pr_fedcba9876543210fedcba9876543210", displayName: "Grace Hopper" });

export type CollaborationHarness = Disposable &
  Readonly<{
    scheduler: VirtualScheduler;
    server: FakeDeckServer;
    serverStore: DocumentStore;
    store: DocumentStore;
    collaboration: DeckCollaboration;
    browserOnline: Subject<boolean>;
    pageVisible: Subject<boolean>;
    statuses: readonly CollaborationStatus[];
    notices: readonly CollaborationNotice[];
    origins: readonly DocumentChangeOrigin[];
    errors: readonly string[];
    status: () => CollaborationStatus;
    /** A local edit through the model: the deck's title. */
    setTitle: (title: string) => void;
  }>;

export function createCollaborationHarness(options: Readonly<{
  random?: RandomSource;
  refreshSession?: () => Promise<SessionRefreshOutcome>;
  initiallyOnline?: boolean;
  initialNotices?: readonly CollaborationNotice[];
}> = {}): CollaborationHarness {
  const scheduler = createVirtualScheduler({ startAt: 1_000_000 });
  const server = createFakeDeckServer({ deckId: TEST_DECK_ID, me: TEST_PERSON });
  const serverStore = createDocumentStore({
    sharedDocument: server.document,
    seed: { kind: "blankDeck", deckId: TEST_DECK_ID },
    now: () => scheduler.now(),
    random: () => 0.5,
    scheduler,
    repairPolicy: "repairAfterTransaction",
    typingMergeWindowMilliseconds: 500,
  });
  const store = createDocumentStore({
    sharedDocument: new Doc(),
    seed: { kind: "none" },
    now: () => scheduler.now(),
    random: () => 0.5,
    scheduler,
    repairPolicy: "reportOnly",
    typingMergeWindowMilliseconds: 500,
  });
  const browserOnline = new Subject<boolean>();
  const pageVisible = new Subject<boolean>();
  const errors: string[] = [];
  const statuses: CollaborationStatus[] = [];
  const notices: CollaborationNotice[] = [];
  const origins: DocumentChangeOrigin[] = [];
  const collaboration = createDeckCollaboration({
    deckId: TEST_DECK_ID,
    sharedDocument: store.sharedDocument,
    expectedRole: "editor",
    openSocket: server.openSocket,
    syncAddress: (discussionAfter) => `wss://sashaslides.test/deck-api/sync/${TEST_DECK_ID}?discussionAfter=${discussionAfter}`,
    bearerToken: () => null,
    refreshSession: options.refreshSession ?? (() => Promise.resolve({ kind: "refreshed" })),
    revertAgentSession: () => Promise.resolve({ kind: "nothingToRevert", skippedSteps: 0 }),
    reduceDiscussionLog,
    browserOnline,
    initiallyOnline: options.initiallyOnline ?? true,
    pageVisible,
    scheduler,
    random: options.random ?? (() => 0.5),
    now: () => scheduler.now(),
    initialNotices: options.initialNotices ?? [],
    reportError: (error, context) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
  });
  const subscriptions = [
    collaboration.session.statusChanges.subscribe((status) => statuses.push(status)),
    collaboration.session.notices.subscribe((notice) => notices.push(notice)),
    store.changes.subscribe((change) => origins.push(change.origin)),
  ];
  let counter = 0;
  return {
    scheduler,
    server,
    serverStore,
    store,
    collaboration,
    browserOnline,
    pageVisible,
    statuses,
    notices,
    origins,
    errors,
    status: () => collaboration.session.status(),
    setTitle: (title) => {
      counter += 1;
      const outcome = store.apply({
        commandId: mintId({ seed: { sessionPrefix: "TestCase", counter }, kind: "command" }).id,
        author: { kind: "person", personId: TEST_PERSON.id },
        commands: [{ kind: "setTitle", title }],
        selectionBefore: { kind: "none" },
        selectionAfter: { kind: "none" },
        mergeWithPrevious: false,
      });
      if (outcome.kind === "rejected") throw new Error(`setTitle was refused: ${JSON.stringify(outcome.rejection)}`);
    },
    [Symbol.dispose]: () => {
      for (const subscription of subscriptions) subscription.unsubscribe();
      collaboration[Symbol.dispose]();
      store[Symbol.dispose]();
      serverStore[Symbol.dispose]();
    },
  };
}

function deckIdOf(text: string): DeckId {
  const deckId = parseDeckId(text);
  if (deckId === null) throw new Error(`Not a deck id: ${text}`);
  return deckId;
}

function personOf(options: Readonly<{ id: string; displayName: string }>): Person {
  const personId = parsePersonId(options.id);
  if (personId === null) throw new Error(`Not a person id: ${options.id}`);
  return { id: personId, displayName: options.displayName, colourIndex: 1, kind: "person" };
}
