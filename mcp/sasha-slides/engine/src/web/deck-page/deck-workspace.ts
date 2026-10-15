// ONE OPEN DECK ON THE PAGE, ACROSS REPLICAS (SPEC.md 21.4 "Resynchronise", 21.8): a replica (a
// fresh Y.Doc, the model's document store with `seed: none` and `reportOnly`, and its
// collaboration client) is opened at once; the editor is composed over it the first time it
// reaches online; and when the server says `resynchroniseRequired`, the editor and the replica are
// both disposed and the same happens again from a fresh replica, whose session raises the
// 'resynchronising' notice in the new editor.
//
// Key decisions:
//
//  * THE EDITOR IS COMPOSED ONLY AFTER THE FIRST SYNC. Before it, the replica is empty; an editor
//    composed on it would show "no slides" and might even let someone add one to an empty deck.
//    The page shows the "Opening deck..." card meanwhile.
//  * A REPLICA THAT CLOSES BEFORE IT WAS EVER ONLINE (no access, no such deck, signed out) never
//    gets an editor: the page shows why instead.
//  * THE COMPOSER IS INJECTED, so the workspace is tested with a fake editor over the real
//    collaboration client and the y-protocols fake server.

import { BehaviorSubject, merge, type Observable, type Subscription } from "rxjs";
import { assertNever } from "../../contracts/assert-never.ts";
import type { ClosedReason, CollaborationNotice, ResynchroniseReason } from "../../contracts/collaboration.ts";
import type { DocumentStore } from "../../contracts/document-store.ts";
import type { DeckCollaboration } from "../collaboration/deck-collaboration.ts";
import type { DeckConnectionState } from "../collaboration/connection-machine.ts";

/** A document replica and its collaboration client; disposing it disposes both. */
export type DeckReplica = Disposable & Readonly<{ documentStore: DocumentStore; collaboration: DeckCollaboration }>;

export type WorkspaceView<TEditor> =
  | Readonly<{ kind: "opening"; replica: DeckReplica }>
  | Readonly<{ kind: "ready"; replica: DeckReplica; editor: TEditor }>
  | Readonly<{ kind: "unavailable"; reason: ClosedReason; signInAddress: string | null }>;

export type DeckWorkspace<TEditor> = Disposable &
  Readonly<{
    /** Replays the current view, then every change. */
    view$: Observable<WorkspaceView<TEditor>>;
    current: () => WorkspaceView<TEditor>;
  }>;

export function createDeckWorkspace<TEditor extends Disposable>(options: Readonly<{
  openReplica: (options: Readonly<{ initialNotices: readonly CollaborationNotice[] }>) => DeckReplica;
  composeEditor: (replica: DeckReplica) => TEditor;
  reportError: (error: unknown, context: string) => void;
}>): DeckWorkspace<TEditor> {
  let replica = options.openReplica({ initialNotices: [] });
  const view = new BehaviorSubject<WorkspaceView<TEditor>>({ kind: "opening", replica });
  let watching: Subscription | null = null;
  let disposed = false;

  const editorOf = (current: WorkspaceView<TEditor>): TEditor | null => {
    switch (current.kind) {
      case "ready":
        return current.editor;
      case "opening":
      case "unavailable":
        return null;
      default:
        return assertNever(current);
    }
  };

  const onConnection = (state: DeckConnectionState): void => {
    const current = view.getValue();
    const closed = closedBeforeOnline(state);
    if (closed !== null && editorOf(current) === null) {
      view.next({ kind: "unavailable", reason: closed, signInAddress: state.signInAddress });
      return;
    }
    if (!state.everOnline || editorOf(current) !== null) return;
    try {
      view.next({ kind: "ready", replica, editor: options.composeEditor(replica) });
    } catch (error) {
      options.reportError(error, "composing the editor");
    }
  };

  const resynchronise = (reason: ResynchroniseReason): void => {
    if (disposed) return;
    watching?.unsubscribe();
    editorOf(view.getValue())?.[Symbol.dispose]();
    replica[Symbol.dispose]();
    replica = options.openReplica({ initialNotices: [{ kind: "resynchronising", reason }] });
    view.next({ kind: "opening", replica });
    watch();
  };

  const watch = (): void => {
    const watched = replica;
    watching = merge(watched.collaboration.connection.state$, watched.collaboration.resynchroniseRequired).subscribe((value) => {
      if (watched !== replica) return;
      if (typeof value === "string") resynchronise(value);
      else onConnection(value);
    });
  };
  watch();

  return {
    view$: view.asObservable(),
    current: () => view.getValue(),
    [Symbol.dispose]: () => {
      if (disposed) return;
      disposed = true;
      watching?.unsubscribe();
      editorOf(view.getValue())?.[Symbol.dispose]();
      replica[Symbol.dispose]();
      view.complete();
    },
  };
}

/** The closed reason of a connection that never reached online, else null. */
function closedBeforeOnline(state: DeckConnectionState): ClosedReason | null {
  if (state.everOnline) return null;
  const phase = state.phase;
  switch (phase.kind) {
    case "closed":
      return phase.reason;
    case "connecting":
    case "synchronising":
    case "online":
    case "waiting":
    case "networkLost":
    case "refreshingSession":
      return null;
    default:
      return assertNever(phase);
  }
}
