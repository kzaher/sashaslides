// THE CONTRACTS, in one import. Every engine module (model, state, view, presenter) codes against
// these types and nothing else of each other's, which is what lets four builders work in parallel.
// They are owned by the architect: a builder that needs a change asks for it rather than editing
// here, because a change ripples through every module's exhaustive switches by design. The shared
// look lives beside them in src/theme/ (also the architect's).

export * from "./assert-never.ts";
export * from "./ids.ts";
export * from "./serialisable.ts";
export * from "./geometry.ts";
export * from "./style.ts";
export * from "./document.ts";
export * from "./animations.ts";
export * from "./yjs-schema.ts";
export * from "./selection.ts";
export * from "./text-delta.ts";
export * from "./commands.ts";
export * from "./document-store.ts";
export * from "./discussion.ts";
export * from "./presence.ts";
export * from "./rxfeedback.ts";
export * from "./editor-state.ts";
export * from "./editor-events.ts";
export * from "./editor-system.ts";
export * from "./render.ts";
export * from "./transition-protocol.ts";
export * from "./presenter.ts";
export * from "./module-surfaces.ts";
// milestone 2
export * from "./deck-access.ts";
export * from "./collaboration.ts";
export * from "./deck-api.ts";
export * from "./assistant-deck-tools.ts";
