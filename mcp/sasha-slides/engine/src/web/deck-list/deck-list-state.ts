// THE DECK LIST PAGE'S STATE: who is signed in, the decks, and the one dialog that may be open,
// changed only by `reduceDeckList` (a pure reducer the page runs with React's `useReducer`; the
// requests live in deck-list-entry.tsx and report back as events).

import { assertNever } from "../../contracts/assert-never.ts";
import type { DeckSessionBody, DeckSummary } from "../../contracts/deck-api.ts";
import type { DeckId } from "../../contracts/ids.ts";

export type DeckListState = Readonly<{
  session: DeckSessionBody | null;
  decks: DeckListLoad;
  dialog: DeckListDialog;
  /** "New deck" is waiting for the server. */
  creating: boolean;
  /** A sentence about the last action that failed, shown above the list. */
  problem: string | null;
}>;

export type DeckListLoad =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "loaded"; decks: readonly DeckSummary[] }>
  | Readonly<{ kind: "failed"; message: string }>;

export type DeckListDialog =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "import"; address: string; progress: ImportProgress }>
  | Readonly<{ kind: "share"; deckId: DeckId }>
  | Readonly<{ kind: "delete"; deck: DeckSummary; deleting: boolean; problem: string | null }>;

export type ImportProgress =
  | Readonly<{ kind: "editing" }>
  | Readonly<{ kind: "importing" }>
  | Readonly<{ kind: "failed"; message: string }>
  /** The import needs the person's Google Slides grant first (deck-api.ts `googleNotConnected`). */
  | Readonly<{ kind: "googleNotConnected"; connectAddress: string; message: string }>;

export type DeckListEvent =
  | Readonly<{ kind: "sessionLoaded"; session: DeckSessionBody }>
  | Readonly<{ kind: "decksLoaded"; decks: readonly DeckSummary[] }>
  | Readonly<{ kind: "decksFailed"; message: string }>
  | Readonly<{ kind: "creatingStarted" }>
  | Readonly<{ kind: "creatingFailed"; message: string }>
  | Readonly<{ kind: "importOpened" }>
  | Readonly<{ kind: "importAddressChanged"; address: string }>
  | Readonly<{ kind: "importStarted" }>
  | Readonly<{ kind: "importFailed"; message: string }>
  | Readonly<{ kind: "importNeedsGoogle"; connectAddress: string; message: string }>
  | Readonly<{ kind: "shareOpened"; deckId: DeckId }>
  | Readonly<{ kind: "deleteAsked"; deck: DeckSummary }>
  | Readonly<{ kind: "deleteStarted" }>
  | Readonly<{ kind: "deleteFailed"; message: string }>
  | Readonly<{ kind: "deckDeleted"; deckId: DeckId }>
  | Readonly<{ kind: "dialogClosed" }>;

export const INITIAL_DECK_LIST_STATE: DeckListState = { session: null, decks: { kind: "loading" }, dialog: { kind: "none" }, creating: false, problem: null };

export function reduceDeckList(state: DeckListState, event: DeckListEvent): DeckListState {
  switch (event.kind) {
    case "sessionLoaded":
      return { ...state, session: event.session };
    case "decksLoaded":
      return { ...state, decks: { kind: "loaded", decks: event.decks } };
    case "decksFailed":
      return { ...state, decks: { kind: "failed", message: event.message } };
    case "creatingStarted":
      return { ...state, creating: true, problem: null };
    case "creatingFailed":
      return { ...state, creating: false, problem: event.message };
    case "importOpened":
      return { ...state, dialog: { kind: "import", address: "", progress: { kind: "editing" } } };
    case "importAddressChanged":
      return withImport(state, (dialog) => ({ ...dialog, address: event.address, progress: { kind: "editing" } }));
    case "importStarted":
      return withImport(state, (dialog) => ({ ...dialog, progress: { kind: "importing" } }));
    case "importFailed":
      return withImport(state, (dialog) => ({ ...dialog, progress: { kind: "failed", message: event.message } }));
    case "importNeedsGoogle":
      return withImport(state, (dialog) => ({ ...dialog, progress: { kind: "googleNotConnected", connectAddress: event.connectAddress, message: event.message } }));
    case "shareOpened":
      return { ...state, dialog: { kind: "share", deckId: event.deckId } };
    case "deleteAsked":
      return { ...state, dialog: { kind: "delete", deck: event.deck, deleting: false, problem: null } };
    case "deleteStarted":
      return withDelete(state, (dialog) => ({ ...dialog, deleting: true, problem: null }));
    case "deleteFailed":
      return withDelete(state, (dialog) => ({ ...dialog, deleting: false, problem: event.message }));
    case "deckDeleted":
      return { ...state, dialog: { kind: "none" }, decks: withoutDeck(state.decks, event.deckId) };
    case "dialogClosed":
      return { ...state, dialog: { kind: "none" } };
    default:
      return assertNever(event);
  }
}

type ImportDialog = Extract<DeckListDialog, { kind: "import" }>;
type DeleteDialog = Extract<DeckListDialog, { kind: "delete" }>;

function withImport(state: DeckListState, change: (dialog: ImportDialog) => ImportDialog): DeckListState {
  const dialog = state.dialog;
  switch (dialog.kind) {
    case "import":
      return { ...state, dialog: change(dialog) };
    case "none":
    case "share":
    case "delete":
      return state;
    default:
      return assertNever(dialog);
  }
}

function withDelete(state: DeckListState, change: (dialog: DeleteDialog) => DeleteDialog): DeckListState {
  const dialog = state.dialog;
  switch (dialog.kind) {
    case "delete":
      return { ...state, dialog: change(dialog) };
    case "none":
    case "share":
    case "import":
      return state;
    default:
      return assertNever(dialog);
  }
}

function withoutDeck(load: DeckListLoad, deckId: DeckId): DeckListLoad {
  switch (load.kind) {
    case "loaded":
      return { kind: "loaded", decks: load.decks.filter((deck) => deck.deckId !== deckId) };
    case "loading":
    case "failed":
      return load;
    default:
      return assertNever(load);
  }
}
