// THE EDITOR OVER A SYNCED REPLICA (SPEC.md 21.8): the composition the view's demo does in
// compose-editor.ts, with the deck's real collaboration session, the HTTP asset store, the
// awareness presence channel and the WebSocket discussion store instead of in-memory stand-ins,
// and the viewer's recent colours kept in local storage.
//
// Key decisions:
//
//  * ONE EDITOR PER REPLICA. The deck workspace (deck-workspace.ts) composes this after the
//    replica's first sync and disposes it before a resynchronise, so the editor never outlives the
//    document it was built on.
//  * THE EDITOR'S TIMERS RUN ON THE REAL SCHEDULER, its clock is the page's; both are created by
//    `composeEditor` once, never reached for below (editor-system.ts header).

import { distinctUntilChanged, map } from "rxjs";
import type { Person } from "../../contracts/discussion.ts";
import type { AssetStore } from "../../contracts/document-store.ts";
import type { EditorEmbedding } from "../../contracts/editor-state.ts";
import { composeEditor, type ComposedEditor } from "../../view/application/compose-editor.ts";
import type { DeckReplica } from "./deck-workspace.ts";
import { readRecentColours, writeRecentColours, type ColourStorage } from "./recent-colours.ts";

export function composeDeckEditor(options: Readonly<{
  page: Window;
  replica: DeckReplica;
  assetStore: AssetStore;
  me: Person;
  embedding: EditorEmbedding;
  runnerAddress: string;
  storage: () => ColourStorage;
  reportError: (error: unknown, context: string) => void;
}>): ComposedEditor {
  const collaboration = options.replica.collaboration;
  const editor = composeEditor({
    page: options.page,
    documentStore: options.replica.documentStore,
    discussionStore: collaboration.discussionStore,
    assetStore: options.assetStore,
    presence: collaboration.presence,
    collaboration: collaboration.session,
    recentColours: readRecentColours(options.storage),
    me: options.me,
    embedding: options.embedding,
    runnerAddress: options.runnerAddress,
    reportError: options.reportError,
  });
  const remembering = editor.system.state$
    .pipe(
      map((state) => state.chrome.recentColours),
      distinctUntilChanged(),
    )
    .subscribe((colours) => writeRecentColours({ storage: options.storage, colours }));
  return {
    ...editor,
    [Symbol.dispose]: () => {
      remembering.unsubscribe();
      editor[Symbol.dispose]();
    },
  };
}
