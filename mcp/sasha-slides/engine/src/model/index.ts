// THE MODEL MODULE (contracts/module-surfaces.ts `ModelModule`): the stored document over a Y.Doc,
// its commands, undo history, snapshots and validation (document-store.ts), the discussion log
// (discussion-log.ts), and the in-memory stand-ins for milestone 2's network (memory-transports.ts).
// Free of the page, so the deck server and Claude's tools can run it on Node. Milestone 2 adds what
// the deck server's room needs: per-agent-session histories (agent-histories.ts) and the protected
// fields its guard reads and corrects (protected-fields.ts). Every import here names a DOM-free
// contract file, never contracts/index.ts, so the connector's Node-only typecheck accepts it.

export { createDocumentStore } from "./document-store.ts";
export { createMemoryDiscussionStore, reduceDiscussionLog } from "./discussion-log.ts";
export { connectInMemory, createMemoryAssetStore, createMemoryPresenceHub } from "./memory-transports.ts";
export { createAgentHistories, SERVER_EDIT_ORIGIN, type AgentHistories, type AgentRevertResult, type AgentSessionHistory } from "./agent-histories.ts";
export { discussionRefusal, type DiscussionRefusal } from "./discussion-log.ts";
export { PROTECTED_META_KEYS, readProtectedFields, writeProtectedFields, type ProtectedFields, type ProtectedFieldWrite, type ProtectedScriptFields } from "./protected-fields.ts";
