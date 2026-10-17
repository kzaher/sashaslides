// THE /decks PAGE'S COMPOSITION ROOT (build-web.ts bundles it): reads the session -- a signed-out
// visitor is sent to `signInAddress` at once -- loads the decks, and turns each action of the list
// into its deck API request. The page itself is deck-list-page.tsx over deck-list-state.ts.
//
// Explicit resource management is imported FIRST (SPEC.md section 16).

import "../../platform/explicit-resource-management.ts";
import { useEffect, useReducer, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { assertNever } from "../../contracts/assert-never.ts";
import { DECK_PAGE_PATH_PREFIX } from "../../contracts/deck-api.ts";
import { createDeckApiClient, okBodyOf, problemOf, sessionCredentials, signInAddressOf, type ApiResult, type DeckApiClient } from "../api/deck-api-client.ts";
import { ShareDialogContainer } from "../share/share-dialog.tsx";
import { PAGE_ROOT_ID } from "../../view/application/editor-page.ts";
import { DeckListPage, type DeckListActions } from "./deck-list-page.tsx";
import { INITIAL_DECK_LIST_STATE, reduceDeckList, type DeckListEvent } from "./deck-list-state.ts";

/** The title a new deck starts with; the person renames it in the editor. */
export const NEW_DECK_TITLE = "Untitled deck";

function DeckListApplication(properties: Readonly<{ api: DeckApiClient; navigate: (address: string) => void; now: () => number }>): ReactElement {
  const { api, navigate } = properties;
  const [state, dispatch] = useReducer(reduceDeckList, INITIAL_DECK_LIST_STATE);
  const [now, setNow] = useState(properties.now);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const session = await api.session();
      if (cancelled) return;
      const signIn = signInAddressOf(session);
      if (signIn !== null) {
        navigate(signIn);
        return;
      }
      const body = okBodyOf(session);
      if (body === null) {
        dispatch({ kind: "decksFailed", message: problemOf(session) ?? "Your decks could not be loaded." });
        return;
      }
      dispatch({ kind: "sessionLoaded", session: body });
      const decks = await api.listDecks();
      if (cancelled) return;
      const list = okBodyOf(decks);
      dispatch(list === null ? { kind: "decksFailed", message: problemOf(decks) ?? "Your decks could not be loaded." } : { kind: "decksLoaded", decks: list.decks });
    })();
    // "edited 3 minutes ago" stays true while the page is open.
    const clock = window.setInterval(() => setNow(properties.now()), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(clock);
    };
  }, [api, navigate, properties]);

  const report = (result: ApiResult<unknown>, failed: (message: string) => DeckListEvent): boolean => {
    const signIn = signInAddressOf(result);
    if (signIn !== null) {
      navigate(signIn);
      return false;
    }
    const problem = problemOf(result);
    if (problem === null) return true;
    dispatch(failed(problem));
    return false;
  };

  const actions: DeckListActions = {
    openDeck: (deckId) => navigate(`${DECK_PAGE_PATH_PREFIX}${deckId}`),
    newDeck: () => {
      dispatch({ kind: "creatingStarted" });
      void api.createDeck({ title: NEW_DECK_TITLE }).then((result) => {
        const body = okBodyOf(result);
        if (!report(result, (message) => ({ kind: "creatingFailed", message })) || body === null) return;
        navigate(`${DECK_PAGE_PATH_PREFIX}${body.deck.deckId}`);
      });
    },
    openImport: () => dispatch({ kind: "importOpened" }),
    changeImportAddress: (address) => dispatch({ kind: "importAddressChanged", address }),
    submitImport: () => {
      const dialog = state.dialog;
      switch (dialog.kind) {
        case "import":
          break;
        case "none":
        case "share":
        case "delete":
          return;
        default:
          assertNever(dialog);
      }
      dispatch({ kind: "importStarted" });
      void api.importFromGoogleSlides({ presentation: dialog.address.trim() }).then((result) => {
        switch (result.kind) {
          case "ok":
            navigate(`${DECK_PAGE_PATH_PREFIX}${result.body.deck.deckId}`);
            return;
          case "failed":
            if (result.error.connectAddress !== null) {
              dispatch({ kind: "importNeedsGoogle", connectAddress: result.error.connectAddress, message: result.error.message });
              return;
            }
            report(result, (message) => ({ kind: "importFailed", message }));
            return;
          case "unreachable":
            dispatch({ kind: "importFailed", message: problemOf(result) ?? "The import failed." });
            return;
          default:
            assertNever(result);
        }
      });
    },
    connectGoogle: (connectAddress) => navigate(connectAddress),
    share: (deckId) => dispatch({ kind: "shareOpened", deckId }),
    askDelete: (deck) => dispatch({ kind: "deleteAsked", deck }),
    confirmDelete: (deck) => {
      dispatch({ kind: "deleteStarted" });
      void api
        .deck(deck.deckId)
        .remove()
        .then((result) => {
          if (report(result, (message) => ({ kind: "deleteFailed", message }))) dispatch({ kind: "deckDeleted", deckId: deck.deckId });
        });
    },
    closeDialog: () => dispatch({ kind: "dialogClosed" }),
  };

  return <DeckListPage state={state} now={now} actions={actions} renderShareDialog={(deckId) => <ShareDialogContainer deck={api.deck(deckId)} onClose={actions.closeDialog} />} />;
}

const container = document.getElementById(PAGE_ROOT_ID);
if (container !== null) {
  document.title = "Your decks - Sasha Slides";
  const api = createDeckApiClient({ origin: window.location.origin, fetch: (address, init) => window.fetch(address, init), credentials: sessionCredentials("cookie") });
  createRoot(container).render(<DeckListApplication api={api} navigate={(address) => window.location.assign(address)} now={() => Date.now()} />);
}
