// THE MODEL MODULE: the stored document over a Y.Doc, its commands, undo history, snapshots and
// validation (document-store.ts), the discussion log (discussion-log.ts), and the in-memory stand-ins
// for the network (memory-transports.ts). Free of the page, so the deck server and Claude's tools can
// run it on Node; they import what the deck server's room needs (agent-histories.ts,
// protected-fields.ts) from those files. Every import here names a DOM-free contract file, never
// contracts/index.ts, so the connector's Node-only typecheck accepts it.

export { createDocumentStore } from "./document-store.ts";
export { createMemoryDiscussionStore, reduceDiscussionLog } from "./discussion-log.ts";
export { connectInMemory, createMemoryAssetStore, createMemoryPresenceHub } from "./memory-transports.ts";
