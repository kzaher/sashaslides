// THE DECK SERVER'S ENGINE HALF (SPEC.md 21.6): the room that runs Yjs sync, the awareness relay,
// the protected-field guard and the discussion authority over injected send functions. Platform
// free -- no Node types, no timers -- so the connector (mcp/sasha-slides/decks) runs it under `ws`
// and the tests run it under fake connections. Like the model, every import names a DOM-free
// contract file, never contracts/index.ts.

export { createDeckRoom, STORAGE_ORIGIN, type CreateDeckRoomOptions, type DeckRoom, type RoomApplyOutcome, type RoomConnection, type RoomConnectionPort, type RoomFrame } from "./deck-room.ts";
export { createAwarenessRelay, decodeAwarenessUpdate, encodeAwarenessUpdate, type AwarenessEntry, type AwarenessRelay } from "./awareness-relay.ts";
export { parseClientMessage, parseDiscussionRequest, type ParsedClientMessage } from "./client-messages.ts";
export { decideDiscussionRequest, discussionAuthorityFromLog, type DiscussionAuthorityState, type DiscussionDecision } from "./discussion-authority.ts";
export { correctionsFor, type GuardDecision, type GuardSender } from "./protected-field-guard.ts";
export { DEFAULT_RATE_LIMIT_POLICY, initialRateLimitState, takeToken, type RateLimitPolicy, type RateLimitState, type RateLimitVerdict } from "./rate-limit.ts";
export { mergeDocumentUpdates } from "./document-updates.ts";
