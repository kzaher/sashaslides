// THE DECK LIST (sashaslides.com/decks, SPEC.md 21.8): the real logo and "Sasha Slides" in a glass
// header with the account, the lively shapes behind, one `.sasha-lively-card` per deck, "New deck"
// and "Import from Google Slides", Share and Delete on the decks one owns, and one card that says
// "Make your first deck" when there are none. Pure presentation over `DeckListState`; every
// action is a property (deck-list-entry.tsx makes the requests).

import type { KeyboardEvent, ReactElement, ReactNode } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import { roleAllows } from "../../contracts/deck-access.ts";
import type { DeckSummary } from "../../contracts/deck-api.ts";
import type { DeckId } from "../../contracts/ids.ts";
import { LivelyShapes } from "../../theme/lively-shapes.tsx";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { DialogFrame, editedAgo, roleLabel, SashaLogo } from "../shared/web-chrome.tsx";
import { WEB_CLASS } from "../web-stylesheet.ts";
import type { DeckListDialog, DeckListState, ImportProgress } from "./deck-list-state.ts";

export type DeckListActions = Readonly<{
  openDeck: (deckId: DeckId) => void;
  newDeck: () => void;
  openImport: () => void;
  changeImportAddress: (address: string) => void;
  submitImport: () => void;
  connectGoogle: (connectAddress: string) => void;
  share: (deckId: DeckId) => void;
  askDelete: (deck: DeckSummary) => void;
  confirmDelete: (deck: DeckSummary) => void;
  closeDialog: () => void;
}>;

export type DeckListPageProperties = Readonly<{
  state: DeckListState;
  now: number;
  actions: DeckListActions;
  /** The share dialog for one deck, with its requests (share-dialog.tsx `ShareDialogContainer`). */
  renderShareDialog: (deckId: DeckId) => ReactNode;
}>;

export function DeckListPage(properties: DeckListPageProperties): ReactElement {
  const { state, actions } = properties;
  return (
    <div className={`${TIDEPOOL_CLASS.root} ${WEB_CLASS.listPage}`}>
      <LivelyShapes />
      <header className={`${TIDEPOOL_CLASS.livelyCard} ${WEB_CLASS.header}`}>
        <a className={WEB_CLASS.brand} href="/">
          <SashaLogo />
          Sasha Slides
        </a>
        <span className={WEB_CLASS.account}>
          {state.session?.email === null || state.session === null ? null : <span className={TIDEPOOL_CLASS.muted}>{state.session.email}</span>}
          <a className={TIDEPOOL_CLASS.secondaryPill} href="/account">
            Account
          </a>
        </span>
      </header>
      <main className={WEB_CLASS.main}>
        <div className={WEB_CLASS.actions}>
          <h1 className={WEB_CLASS.pageTitle}>Your decks</h1>
          <div>
            <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={actions.openImport}>
              Import from Google Slides
            </button>
            <button type="button" className={TIDEPOOL_CLASS.primaryPill} disabled={state.creating} onClick={actions.newDeck}>
              {state.creating ? "Creating..." : "New deck"}
            </button>
          </div>
        </div>
        {state.problem === null ? null : (
          <p className={`${TIDEPOOL_CLASS.notice} ${WEB_CLASS.problem}`} data-tone="error" role="alert">
            {state.problem}
          </p>
        )}
        <DeckListBody {...properties} />
      </main>
      <Dialog dialog={state.dialog} actions={actions} renderShareDialog={properties.renderShareDialog} />
    </div>
  );
}

function DeckListBody(properties: DeckListPageProperties): ReactElement {
  const { state, actions } = properties;
  const load = state.decks;
  switch (load.kind) {
    case "loading":
      return <p className={TIDEPOOL_CLASS.muted}>Loading your decks...</p>;
    case "failed":
      return (
        <p className={WEB_CLASS.problem} role="alert">
          {load.message}
        </p>
      );
    case "loaded":
      if (load.decks.length === 0) {
        return (
          <section className={`${TIDEPOOL_CLASS.livelyCard} ${WEB_CLASS.emptyCard}`} aria-label="No decks yet">
            <h2 className={WEB_CLASS.deckTitle}>Make your first deck</h2>
            <p className={TIDEPOOL_CLASS.muted}>Start from a blank deck, or bring one in from Google Slides.</p>
            <button type="button" className={TIDEPOOL_CLASS.primaryPill} disabled={state.creating} onClick={actions.newDeck}>
              New deck
            </button>
          </section>
        );
      }
      return (
        <ul className={WEB_CLASS.deckGrid} aria-label="Decks">
          {load.decks.map((deck) => (
            <li key={deck.deckId}>
              <DeckCard deck={deck} now={properties.now} meId={state.session?.me.id ?? null} actions={actions} />
            </li>
          ))}
        </ul>
      );
    default:
      return assertNever(load);
  }
}

function DeckCard(properties: Readonly<{ deck: DeckSummary; now: number; meId: string | null; actions: DeckListActions }>): ReactElement {
  const { deck, actions } = properties;
  const open = (): void => actions.openDeck(deck.deckId);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Enter" || event.target !== event.currentTarget) return;
    event.preventDefault();
    open();
  };
  const owned = roleAllows({ role: deck.role, permission: "share" });
  return (
    <article className={`${TIDEPOOL_CLASS.livelyCard} ${WEB_CLASS.deckCard}`} role="link" tabIndex={0} aria-label={`Open ${deck.title}`} data-deck-id={deck.deckId} data-role={deck.role} onClick={open} onKeyDown={onKeyDown}>
      <h2 className={WEB_CLASS.deckTitle}>{deck.title === "" ? "Untitled deck" : deck.title}</h2>
      <p className={WEB_CLASS.deckFacts}>
        <span className={TIDEPOOL_CLASS.muted}>{roleLabel(deck.role)}</span>
        <span className={TIDEPOOL_CLASS.subtle}>{deck.owner.id === properties.meId ? "Yours" : `Owner: ${deck.owner.displayName}`}</span>
        <span className={TIDEPOOL_CLASS.subtle}>{editedAgo({ now: properties.now, updatedAt: deck.updatedAt })}</span>
      </p>
      {owned ? (
        <div className={WEB_CLASS.cardActions}>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={(event) => {
            event.stopPropagation();
            actions.share(deck.deckId);
          }}>
            Share
          </button>
          {roleAllows({ role: deck.role, permission: "deleteDeck" }) ? (
            <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={(event) => {
              event.stopPropagation();
              actions.askDelete(deck);
            }}>
              Delete
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function Dialog(properties: Readonly<{ dialog: DeckListDialog; actions: DeckListActions; renderShareDialog: (deckId: DeckId) => ReactNode }>): ReactNode {
  const { dialog, actions } = properties;
  switch (dialog.kind) {
    case "none":
      return null;
    case "share":
      return properties.renderShareDialog(dialog.deckId);
    case "import":
      return <ImportDialog address={dialog.address} progress={dialog.progress} actions={actions} />;
    case "delete":
      return (
        <DialogFrame title={`Delete "${dialog.deck.title}"?`} onClose={actions.closeDialog}>
          <p>This deletes the deck for everyone it is shared with. It cannot be undone.</p>
          {dialog.problem === null ? null : (
            <p className={WEB_CLASS.problem} role="alert">
              {dialog.problem}
            </p>
          )}
          <div className={WEB_CLASS.formRow}>
            <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={actions.closeDialog}>
              Cancel
            </button>
            <button type="button" className={TIDEPOOL_CLASS.dangerPill} disabled={dialog.deleting} onClick={() => actions.confirmDelete(dialog.deck)}>
              {dialog.deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </DialogFrame>
      );
    default:
      return assertNever(dialog);
  }
}

function ImportDialog(properties: Readonly<{ address: string; progress: ImportProgress; actions: DeckListActions }>): ReactElement {
  const { progress, actions } = properties;
  const importing = isImporting(progress);
  return (
    <DialogFrame title="Import from Google Slides" onClose={actions.closeDialog}>
      <form
        className={WEB_CLASS.form}
        onSubmit={(event) => {
          event.preventDefault();
          actions.submitImport();
        }}
      >
        <label className={WEB_CLASS.form}>
          <span>The presentation's address</span>
          <input
            className={TIDEPOOL_CLASS.field}
            type="text"
            required
            autoFocus
            placeholder="https://docs.google.com/presentation/d/..."
            value={properties.address}
            disabled={importing}
            onChange={(event) => actions.changeImportAddress(event.currentTarget.value)}
          />
        </label>
        <ImportProgressLine progress={progress} actions={actions} />
        <div className={WEB_CLASS.formRow}>
          <button type="button" className={TIDEPOOL_CLASS.secondaryPill} onClick={actions.closeDialog}>
            Cancel
          </button>
          <button type="submit" className={TIDEPOOL_CLASS.primaryPill} disabled={importing}>
            {importing ? "Importing..." : "Import"}
          </button>
        </div>
      </form>
    </DialogFrame>
  );
}

function ImportProgressLine(properties: Readonly<{ progress: ImportProgress; actions: DeckListActions }>): ReactNode {
  const progress = properties.progress;
  switch (progress.kind) {
    case "editing":
      return <p className={TIDEPOOL_CLASS.subtle}>A copy becomes a new Sasha deck; the presentation itself is not changed.</p>;
    case "importing":
      return <p className={TIDEPOOL_CLASS.muted}>Reading the presentation...</p>;
    case "failed":
      return (
        <p className={WEB_CLASS.problem} role="alert">
          {progress.message}
        </p>
      );
    case "googleNotConnected":
      return (
        <div className={WEB_CLASS.form}>
          <p>{progress.message}</p>
          <div>
            <button type="button" className={TIDEPOOL_CLASS.primaryPill} onClick={() => properties.actions.connectGoogle(progress.connectAddress)}>
              Connect Google Slides
            </button>
          </div>
        </div>
      );
    default:
      return assertNever(progress);
  }
}

function isImporting(progress: ImportProgress): boolean {
  switch (progress.kind) {
    case "importing":
      return true;
    case "editing":
    case "failed":
    case "googleNotConnected":
      return false;
    default:
      return assertNever(progress);
  }
}
