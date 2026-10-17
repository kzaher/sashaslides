// THE /deck/<id> PAGE'S COMPOSITION ROOT (build-web.ts bundles it; SPEC.md 21.8). Every effectful
// thing the deck page uses is created here, once, and passed down: the session (the cookie, or in
// the add-on the bearer from the fragment's ticket), the deck API client, the HTTP asset store, the
// deck workspace with its replicas (a Y.Doc, the model's store with `seed: none` and `reportOnly`,
// the collaboration client over a real WebSocket), the editor composition, the add-on shell relay,
// the page title, and the unload warning.
//
// Key decisions:
//
//  * SIGNED OUT GOES TO SIGN IN AT ONCE (the API's `signInAddress`), before anything is drawn.
//  * THE PAGE TITLE IS THE DECK'S TITLE, read from the replica as it changes, so a rename by a
//    collaborator shows in the tab too.
//  * LEAVING WITH UNSENT CHANGES ASKS FIRST (`beforeunload`): nothing is kept across a reload
//    (SPEC.md section 1, not offline-first), so an edit made offline would be lost.
//
// Explicit resource management is imported FIRST (SPEC.md section 16).

import "../../platform/explicit-resource-management.ts";
import { useCallback, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { asyncScheduler, fromEvent, map, merge, startWith } from "rxjs";
import { Doc } from "yjs";
import { assertNever } from "../../contracts/assert-never.ts";
import { DECK_SYNC_PATH_PREFIX, type CollaborationNotice } from "../../contracts/collaboration.ts";
import type { DeckRole } from "../../contracts/deck-access.ts";
import { DECK_PAGE_PATH_PREFIX, type DeckSessionBody, type GoogleSlidesLink } from "../../contracts/deck-api.ts";
import type { EditorEmbedding } from "../../contracts/editor-state.ts";
import type { EditorHost } from "../../contracts/editor-system.ts";
import { parseDeckId, type DeckId } from "../../contracts/ids.ts";
import { createDocumentStore, reduceDiscussionLog } from "../../model/index.ts";
import { createDeckApiClient, okBodyOf, problemOf, sessionCredentials, signInAddressOf, type ApiResult, type DeckApiClient } from "../api/deck-api-client.ts";
import { createDeckCollaboration, type SessionRefreshOutcome } from "../collaboration/deck-collaboration.ts";
import { browserDeckSocket } from "../collaboration/deck-socket.ts";
import { createHttpAssetStore } from "../collaboration/http-asset-store.ts";
import { scheduleBearerRenewal, startEmbeddedSession } from "../embedded/embedded-session.ts";
import { createShellRelay, shellOriginOf, type InboundMessage, type ShellRelay } from "../embedded/shell-relay.ts";
import { PAGE_CONFIGURATION_ID, PAGE_ROOT_ID, parsePageConfiguration } from "../../view/application/editor-page.ts";
import type { ComposedEditor } from "../../view/application/compose-editor.ts";
import { composeDeckEditor } from "./deck-editor.ts";
import { reviewRequestOf } from "./review-address.ts";
import { createExportRunner, type PageNotice } from "./deck-exports.ts";
import { deckEditorHost, TopBarAccessory } from "./deck-host.tsx";
import { DeckPage, DeckProblem, DeckUnavailable, type NumberedNotice } from "./deck-page.tsx";
import { createDeckWorkspace, type DeckReplica, type DeckWorkspace, type WorkspaceView } from "./deck-workspace.ts";

type StartedDeck = Readonly<{
  deckId: DeckId;
  api: DeckApiClient;
  session: DeckSessionBody;
  embedding: EditorEmbedding;
  shell: ShellRelay | null;
  role: DeckRole;
  googleSlides: GoogleSlidesLink | null;
  runnerAddress: string;
}>;

type StartOutcome =
  | Readonly<{ kind: "started"; deck: StartedDeck }>
  | Readonly<{ kind: "redirected" }>
  | Readonly<{ kind: "notFound" }>
  | Readonly<{ kind: "problem"; message: string }>;

const reportError = (error: unknown, context: string): void => console.error(`[sasha deck] ${context}`, error);

async function start(): Promise<StartOutcome> {
  const configuration = parsePageConfiguration(document.getElementById(PAGE_CONFIGURATION_ID)?.textContent ?? null);
  const deckId = parseDeckId(decodeURIComponent(window.location.pathname.slice(DECK_PAGE_PATH_PREFIX.length)));
  if (deckId === null) return { kind: "notFound" };
  // A query value is untrusted text, not a closed union: only the exact "addon" embeds.
  const embedded = new URLSearchParams(window.location.search).get("embed") === "addon";
  const api = createDeckApiClient({ origin: window.location.origin, fetch: (address, init) => window.fetch(address, init), credentials: sessionCredentials(embedded ? "bearer" : "cookie") });

  const session = embedded ? await embeddedSession(api) : await cookieSession(api);
  switch (session.kind) {
    case "stopped":
      return session.outcome;
    case "session":
      break;
    default:
      return assertNever(session);
  }

  const details = await api.deck(deckId).details();
  const signIn = signInAddressOf(details);
  if (signIn !== null) {
    window.location.assign(signIn);
    return { kind: "redirected" };
  }
  const body = okBodyOf(details);
  if (body === null) return statusOf(details) === 404 ? { kind: "notFound" } : { kind: "problem", message: problemOf(details) ?? "The deck could not be opened." };
  document.title = `${body.deck.title === "" ? "Untitled deck" : body.deck.title} - Sasha Slides`;

  const shellOrigin = embedded ? shellOriginOf({ ancestorOrigins: window.location.ancestorOrigins === undefined ? null : [...window.location.ancestorOrigins], referrer: document.referrer }) : null;
  const shell = shellOrigin === null || window.parent === window ? null : createShellRelay({ shellOrigin, shell: window.parent, listen: listenToMessages, scheduler: asyncScheduler });
  return {
    kind: "started",
    deck: {
      deckId,
      api,
      session: session.body,
      embedding: embedded ? { kind: "addonDialog", webApplicationAddress: `${window.location.origin}${DECK_PAGE_PATH_PREFIX}${deckId}` } : { kind: "webApplication" },
      shell,
      role: body.deck.role,
      googleSlides: body.deck.googleSlides,
      runnerAddress: configuration?.runnerAddress ?? "about:blank",
    },
  };
}

/** The HTTP status of a failed answer; null when it succeeded or no answer came. */
function statusOf(result: ApiResult<unknown>): number | null {
  switch (result.kind) {
    case "failed":
      return result.status;
    case "ok":
    case "unreachable":
      return null;
    default:
      return assertNever(result);
  }
}

type SessionStart = Readonly<{ kind: "session"; body: DeckSessionBody }> | Readonly<{ kind: "stopped"; outcome: StartOutcome }>;

async function cookieSession(api: DeckApiClient): Promise<SessionStart> {
  const result = await api.session();
  const signIn = signInAddressOf(result);
  if (signIn !== null) {
    window.location.assign(signIn);
    return { kind: "stopped", outcome: { kind: "redirected" } };
  }
  const body = okBodyOf(result);
  return body === null ? { kind: "stopped", outcome: { kind: "problem", message: problemOf(result) ?? "Your session could not be read." } } : { kind: "session", body };
}

async function embeddedSession(api: DeckApiClient): Promise<SessionStart> {
  const started = await startEmbeddedSession({
    api,
    address: {
      hash: () => window.location.hash,
      pathname: () => window.location.pathname,
      search: () => window.location.search,
      replaceState: (address) => window.history.replaceState(null, "", address),
    },
  });
  switch (started.kind) {
    case "started":
      scheduleBearerRenewal({
        api,
        scheduler: asyncScheduler,
        expiresAt: started.session.expiresAt,
        onRenewed: () => undefined,
        onExpired: () => reportError(new Error("the bearer expired"), "renewing the add-on session"),
      });
      return { kind: "session", body: started.session.session };
    case "noTicket":
      return { kind: "stopped", outcome: { kind: "problem", message: "Reopen this deck from the Sasha Slides menu in Google Slides." } };
    case "failed":
      return { kind: "stopped", outcome: { kind: "problem", message: `${started.message} Reopen this deck from the Sasha Slides menu in Google Slides.` } };
    default:
      return assertNever(started);
  }
}

function listenToMessages(handler: (message: InboundMessage) => void): Disposable {
  const listener = (event: MessageEvent<unknown>): void => handler({ origin: event.origin, source: event.source, data: event.data });
  window.addEventListener("message", listener);
  return { [Symbol.dispose]: () => window.removeEventListener("message", listener) };
}

/** A fresh replica of the deck: a new Y.Doc, the model's store on it, and its collaboration client. */
function openReplica(deck: StartedDeck, initialNotices: readonly CollaborationNotice[]): DeckReplica {
  const documentStore = createDocumentStore({
    sharedDocument: new Doc(),
    seed: { kind: "none" },
    now: () => Date.now(),
    random: Math.random,
    scheduler: asyncScheduler,
    repairPolicy: "reportOnly",
    typingMergeWindowMilliseconds: 500,
  });
  const socketOrigin = window.location.origin.replace(/^http/, "ws");
  const collaboration = createDeckCollaboration({
    deckId: deck.deckId,
    sharedDocument: documentStore.sharedDocument,
    expectedRole: deck.role,
    openSocket: browserDeckSocket((address, protocols) => new WebSocket(address, protocols)),
    syncAddress: (discussionAfter) => `${socketOrigin}${DECK_SYNC_PATH_PREFIX}${deck.deckId}?discussionAfter=${discussionAfter}`,
    bearerToken: deck.api.credentials.bearerToken,
    refreshSession: () => refreshSession(deck),
    revertAgentSession: async (agentSessionId) => {
      const result = await deck.api.deck(deck.deckId).revertAgentSession(agentSessionId);
      return okBodyOf(result) ?? { kind: "failed", message: problemOf(result) ?? "The revert failed." };
    },
    reduceDiscussionLog,
    browserOnline: merge(fromEvent(window, "online").pipe(map(() => true)), fromEvent(window, "offline").pipe(map(() => false))),
    initiallyOnline: window.navigator.onLine,
    pageVisible: fromEvent(document, "visibilitychange").pipe(map(() => document.visibilityState === "visible")),
    scheduler: asyncScheduler,
    random: Math.random,
    now: () => Date.now(),
    initialNotices,
    reportError,
  });
  const titles = documentStore.changes.pipe(startWith(null)).subscribe(() => {
    const title = documentStore.snapshot().title;
    if (title !== "") document.title = `${title} - Sasha Slides`;
  });
  return {
    documentStore,
    collaboration,
    [Symbol.dispose]: () => {
      titles.unsubscribe();
      collaboration[Symbol.dispose]();
      documentStore[Symbol.dispose]();
      documentStore.sharedDocument.destroy();
    },
  };
}

/** After a 4001: GET /deck-api/session with the cookie, POST /deck-api/embed/renew with the bearer. */
async function refreshSession(deck: StartedDeck): Promise<SessionRefreshOutcome> {
  const result = await refreshedSession(deck.api);
  switch (result.kind) {
    case "ok":
      return { kind: "refreshed" };
    case "failed": {
      const signIn = signInAddressOf(result);
      if (signIn !== null) return { kind: "signedOut", signInAddress: signIn };
      // A 401 without an address: the add-on's bearer is gone (a server restart); reloading the
      // frame cannot help, the dialog must be reopened from the add-on menu.
      return statusOf(result) === 401 ? { kind: "signedOut", signInAddress: `${DECK_PAGE_PATH_PREFIX}${deck.deckId}` } : { kind: "unreachable" };
    }
    case "unreachable":
      return { kind: "unreachable" };
    default:
      return assertNever(result);
  }
}

function refreshedSession(api: DeckApiClient): Promise<ApiResult<unknown>> {
  switch (api.credentials.mode) {
    case "cookie":
      return api.session();
    case "bearer":
      return api.renewBearer();
    default:
      return assertNever(api.credentials.mode);
  }
}

function DeckApplication(properties: Readonly<{ deck: StartedDeck }>): ReactElement {
  const { deck } = properties;
  const [notices, setNotices] = useState<readonly NumberedNotice[]>([]);
  const notify = useCallback((notice: PageNotice) => setNotices((current) => [...current.slice(-2), { ...notice, id: Date.now() + Math.random() }]), []);
  const [workspace] = useState<DeckWorkspace<ComposedEditor>>(() => composeWorkspace(deck));
  const [exports] = useState(() => createExportRunner({ deck: deck.api.deck(deck.deckId), shell: deck.shell, notify }));
  const hostFor = useCallback(
    (role: DeckRole): EditorHost =>
      deckEditorHost({
        deckId: deck.deckId,
        origin: window.location.origin,
        embedding: deck.embedding,
        role,
        googleSlides: deck.googleSlides,
        exports,
        navigate: (address) => window.location.assign(address),
        openTab: (address) => void window.open(address, "_blank", "noopener,noreferrer"),
        topBarAccessory: <TopBarAccessory deck={deck.api.deck(deck.deckId)} showAccount={deck.shell === null} portalTarget={() => document.body} />,
      }),
    [deck, exports],
  );
  return <DeckPage workspace={workspace} hostFor={hostFor} notices={notices} onDismissNotice={(id) => setNotices((current) => current.filter((notice) => notice.id !== id))} />;
}

function composeWorkspace(deck: StartedDeck): DeckWorkspace<ComposedEditor> {
  const assetStore = createHttpAssetStore({
    deck: deck.api.deck(deck.deckId),
    createAddress: (bytes, mediaType) => URL.createObjectURL(new Blob([bytes], { type: mediaType })),
    releaseAddress: (address) => URL.revokeObjectURL(address),
    scheduler: asyncScheduler,
    reportError,
  });
  const workspace = createDeckWorkspace<ComposedEditor>({
    openReplica: (options) => openReplica(deck, options.initialNotices),
    composeEditor: (replica) =>
      composeDeckEditor({ page: window, replica, assetStore, me: deck.session.me, embedding: deck.embedding, runnerAddress: deck.runnerAddress, storage: () => window.localStorage, reportError }),
    reportError,
  });
  let announced = false;
  workspace.view$.subscribe((view) => {
    switch (view.kind) {
      case "ready": {
        if (announced) return;
        announced = true;
        deck.shell?.post({ source: "sasha-editor", kind: "ready" });
        const review = reviewRequestOf(window.location);
        if (review === null) return;
        window.history.replaceState(null, "", review.addressWithoutRequest);
        view.editor.system.dispatch({ kind: "transitionScriptEditorOpened", scriptId: review.scriptId, purpose: "transition" });
        return;
      }
      case "opening":
      case "unavailable":
        return;
      default:
        assertNever(view);
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!hasUnsentChanges(workspace.current())) return;
    event.preventDefault();
    // Older browsers show the prompt only when `returnValue` is set.
    event.returnValue = "";
  });
  return workspace;
}

function hasUnsentChanges(view: WorkspaceView<ComposedEditor>): boolean {
  switch (view.kind) {
    case "opening":
    case "ready":
      return view.replica.collaboration.session.status().unsentChanges;
    case "unavailable":
      return false;
    default:
      return assertNever(view);
  }
}

const container = document.getElementById(PAGE_ROOT_ID);
if (container !== null) {
  const root = createRoot(container);
  start()
    .then((outcome) => {
      switch (outcome.kind) {
        case "started":
          root.render(<DeckApplication deck={outcome.deck} />);
          return;
        case "redirected":
          return;
        case "notFound":
          root.render(<DeckUnavailable reason="deckNotFound" signInAddress={null} />);
          return;
        case "problem":
          root.render(<DeckProblem message={outcome.message} />);
          return;
        default:
          assertNever(outcome);
      }
    })
    .catch((error: unknown) => {
      reportError(error, "opening the deck");
      root.render(<DeckProblem message="The deck could not be opened. Reload the page to try again." />);
    });
}
