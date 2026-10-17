// THE DECK SERVER'S ENGINE HALF (SPEC.md 21.6): the room that runs Yjs sync, the awareness relay,
// the protected-field guard and the discussion authority over injected send functions. Platform
// free -- no Node types, no timers -- so the connector (mcp/sasha-slides/decks) runs it under `ws`
// and the tests run it under fake connections. Like the model, every import names a DOM-free
// contract or shared file, never contracts/index.ts.

export { createDeckRoom, type DeckRoom, type RoomConnection, type RoomConnectionPort, type RoomFrame } from "./deck-room.ts";
export { isDocumentUpdate, mergeDocumentUpdates } from "./document-updates.ts";
