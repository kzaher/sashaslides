// A RUNNING EDITOR OVER FAKES, for the tests that exercise feedbacks: the real `createEditorSystem`
// with the fake stores, a virtual-time scheduler and a recording error reporter. Every dependency the
// composition root would inject is here, explicitly, so a test changes only the one it is about.

import {
  EMPTY_DISCUSSION,
  type DiscussionSnapshot,
  type DocumentSnapshot,
  type EditorEvent,
  type EditorState,
  type PresenceChannel,
  type RunningSystem,
} from "../../contracts/index.ts";
import { createEditorSystem } from "../editor-system.ts";
import { ME } from "./document-fixtures.ts";
import {
  createFakeAssetStore,
  createFakeDiscussionStore,
  createFakeDocumentStore,
  type FakeAssetStore,
  type FakeDiscussionStore,
  type FakeDocumentStore,
  type PutBehaviour,
  type Settlement,
} from "./fake-stores.ts";
import { createVirtualScheduler, type VirtualScheduler } from "./virtual-scheduler.ts";

export type EditorHarness = Disposable &
  Readonly<{
    system: RunningSystem<EditorState, EditorEvent>;
    documentStore: FakeDocumentStore;
    discussionStore: FakeDiscussionStore;
    assetStore: FakeAssetStore;
    scheduler: VirtualScheduler;
    reportedErrors: () => readonly string[];
    state: () => EditorState;
    dispatch: (event: EditorEvent) => void;
  }>;

export function createEditorHarness(
  options: Readonly<{
    document: DocumentSnapshot;
    discussion?: DiscussionSnapshot;
    settle?: "synchronously" | Readonly<{ delayMilliseconds: number }>;
    putBehaviours?: readonly PutBehaviour[];
    presence?: PresenceChannel;
  }>,
): EditorHarness {
  const scheduler = createVirtualScheduler({ startAt: 0 });
  const settlement: Settlement =
    options.settle === undefined || options.settle === "synchronously"
      ? { kind: "synchronously" }
      : { kind: "onScheduler", scheduler, delayMilliseconds: options.settle.delayMilliseconds };
  const documentStore = createFakeDocumentStore({ initial: options.document, settle: settlement });
  const discussionStore = createFakeDiscussionStore(options.discussion ?? EMPTY_DISCUSSION);
  const assetStore = createFakeAssetStore({ behaviours: options.putBehaviours ?? ["neverSettles"], now: () => scheduler.now() });
  const errors: string[] = [];
  const system = createEditorSystem({
    documentStore,
    discussionStore,
    assetStore,
    presence: options.presence ?? null,
    scheduler,
    now: () => scheduler.now(),
    sessionPrefix: "Test0000",
    me: ME,
    embedding: { kind: "webApplication" },
    reportError: (error, context) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
  });
  system.dispatch({ kind: "viewportResized", size: { width: 1360, height: 800 } });
  return {
    system,
    documentStore,
    discussionStore,
    assetStore,
    scheduler,
    reportedErrors: () => errors.slice(),
    state: () => system.currentState(),
    dispatch: (event) => system.dispatch(event),
    [Symbol.dispose]: () => {
      system[Symbol.dispose]();
      documentStore[Symbol.dispose]();
      discussionStore[Symbol.dispose]();
    },
  };
}

/** Let promise callbacks (a resolved `put`, a settled `submit`) run. */
export async function flushPromises(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await Promise.resolve();
}
