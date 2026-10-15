// THE DECK PAGE'S VIEW (`/deck/<id>`, SPEC.md 21.8): the calm wash with an "Opening deck..." card
// until the replica's first sync, then the editor with the page's `EditorHost`; or, when the deck
// cannot be opened, a card that says why. Renders the workspace (deck-workspace.ts); composes
// nothing itself.

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { ClosedReason } from "../../contracts/collaboration.ts";
import type { DeckRole } from "../../contracts/deck-access.ts";
import type { EditorHost } from "../../contracts/editor-system.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { EditorApplication } from "../../view/index.ts";
import { SashaLogo } from "../shared/web-chrome.tsx";
import { WEB_CLASS } from "../web-stylesheet.ts";
import type { PageNotice } from "./deck-exports.ts";
import type { DeckEditor } from "./deck-editor.ts";
import { PageNotices } from "./deck-host.tsx";
import type { DeckWorkspace, WorkspaceView } from "./deck-workspace.ts";

export type NumberedNotice = PageNotice & Readonly<{ id: number }>;

export function DeckPage(properties: Readonly<{
  workspace: DeckWorkspace<DeckEditor>;
  /** The host for the current role (the role decides which File items are enabled). */
  hostFor: (role: DeckRole) => EditorHost;
  notices: readonly NumberedNotice[];
  onDismissNotice: (id: number) => void;
}>): ReactElement {
  const view = useObservedView(properties.workspace);
  return (
    <>
      <WorkspaceContent view={view} hostFor={properties.hostFor} />
      <PageNotices notices={properties.notices} onDismiss={properties.onDismissNotice} />
    </>
  );
}

function WorkspaceContent(properties: Readonly<{ view: WorkspaceView<DeckEditor>; hostFor: (role: DeckRole) => EditorHost }>): ReactElement {
  const view = properties.view;
  switch (view.kind) {
    case "opening":
      return <OpeningDeck />;
    case "unavailable":
      return <DeckUnavailable reason={view.reason} signInAddress={view.signInAddress} />;
    case "ready":
      return <ReadyEditor editor={view.editor} session={view.replica.collaboration.session} hostFor={properties.hostFor} />;
    default:
      return assertNever(view);
  }
}

function ReadyEditor(properties: Readonly<{ editor: DeckEditor; session: DeckEditorSession; hostFor: (role: DeckRole) => EditorHost }>): ReactElement {
  const session = properties.session;
  const [status, setStatus] = useState(() => session.status());
  useEffect(() => {
    setStatus(session.status());
    const subscription = session.statusChanges.subscribe(setStatus);
    return () => subscription.unsubscribe();
  }, [session]);
  const { hostFor } = properties;
  const role = status.role;
  // The host changes only with the role: a new value per status would re-render the whole chrome.
  const host = useMemo(() => hostFor(role), [hostFor, role]);
  const editor = properties.editor;
  return (
    <div className={WEB_CLASS.deckPage} data-sasha-connection={status.connection.kind} data-sasha-unsent={String(status.unsentChanges)}>
      <EditorApplication
        system={editor.system}
        assetStore={editor.assetStore}
        browser={editor.browser}
        presenterDependencies={editor.presenterDependencies}
        clipboardContentFor={editor.clipboardContentFor}
        arrangeThreads={editor.arrangeThreads}
        host={host}
      />
    </div>
  );
}

type DeckEditorSession = Extract<WorkspaceView<DeckEditor>, { kind: "ready" }>["replica"]["collaboration"]["session"];

/** The calm wash with one card, until the first sync. */
export function OpeningDeck(): ReactElement {
  return (
    <div className={`${TIDEPOOL_CLASS.root} ${TIDEPOOL_CLASS.calmGround} ${WEB_CLASS.opening}`} data-sasha-opening="true">
      <div className={`${TIDEPOOL_CLASS.card} ${WEB_CLASS.openingCard}`} role="status">
        <SashaLogo />
        <p>Opening deck...</p>
      </div>
    </div>
  );
}

export function DeckUnavailable(properties: Readonly<{ reason: ClosedReason; signInAddress: string | null }>): ReactElement {
  return (
    <div className={`${TIDEPOOL_CLASS.root} ${TIDEPOOL_CLASS.calmGround} ${WEB_CLASS.opening}`}>
      <div className={`${TIDEPOOL_CLASS.card} ${WEB_CLASS.openingCard}`} role="alert">
        <SashaLogo />
        <p>{unavailableSentence(properties.reason)}</p>
        {properties.signInAddress === null ? <a href="/decks">All decks</a> : <a href={properties.signInAddress}>Sign in again</a>}
      </div>
    </div>
  );
}

/** A card with a sentence of the page's own (no ticket in the add-on, a failed start). */
export function DeckProblem(properties: Readonly<{ message: string }>): ReactElement {
  return (
    <div className={`${TIDEPOOL_CLASS.root} ${TIDEPOOL_CLASS.calmGround} ${WEB_CLASS.opening}`}>
      <div className={`${TIDEPOOL_CLASS.card} ${WEB_CLASS.openingCard}`} role="alert">
        <SashaLogo />
        <p>{properties.message}</p>
      </div>
    </div>
  );
}

function unavailableSentence(reason: ClosedReason): string {
  switch (reason) {
    case "accessRevoked":
      return "You no longer have access to this deck.";
    case "deckNotFound":
      return "This deck does not exist, or it has not been shared with you.";
    case "deckDeleted":
      return "This deck was deleted.";
    case "signedOut":
      return "You are signed out.";
    case "protocolVersionUnsupported":
      return "This page is out of date. Reload it to open the deck.";
    case "documentSchemaTooNew":
      return "This deck was saved by a newer version of Sasha Slides. Reload the page.";
    default:
      return assertNever(reason);
  }
}

function useObservedView(workspace: DeckWorkspace<DeckEditor>): WorkspaceView<DeckEditor> {
  const [view, setView] = useState(() => workspace.current());
  useEffect(() => {
    const subscription = workspace.view$.subscribe(setView);
    return () => subscription.unsubscribe();
  }, [workspace]);
  return view;
}
