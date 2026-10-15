// THE MODEL MODULE (contracts/module-surfaces.ts `ModelModule`): the stored document over a Y.Doc,
// its commands, undo history, snapshots and validation (document-store.ts), the discussion log
// (discussion-log.ts), and the in-memory stand-ins for milestone 2's network (memory-transports.ts).
// Free of the page, so the deck server and Claude's tools can run it on Node.

export { createDocumentStore } from "./document-store.ts";
export { createMemoryDiscussionStore, reduceDiscussionLog } from "./discussion-log.ts";
export { connectInMemory, createMemoryAssetStore, createMemoryPresenceHub } from "./memory-transports.ts";
