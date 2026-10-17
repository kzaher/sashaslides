// THE DEMO PAGE (build-demo.ts bundles it as dist/demo/editor.js): the whole editor on an in-memory
// Y.Doc holding the sample deck, with the real model, state and presenter. `?editors=2` shows two
// editors side by side on two replicas joined by the model's in-memory loopback and presence hub,
// so each editor shows the other's cursor and selection -- milestone 1's proof of presence.
// `?embed=addon` runs the editor as the add-on dialog would (Present opens a tab). Every editor
// gets a stand-in deck server session (demo-collaboration.ts) whose members -- Ada, Grace and
// Claude -- are who "@" can mention; `?role=` and `?connection=` show the read-only chrome.
//
// Explicit resource management is imported FIRST (SPEC.md section 16): the engine's objects are
// `Disposable` and Safari lacks `Symbol.dispose`.

import "../../platform/explicit-resource-management.ts";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { asyncScheduler } from "rxjs";
import { Doc } from "yjs";
import type { Person } from "../../contracts/discussion.ts";
import type { AssetRecord } from "../../contracts/document.ts";
import type { AssetStore, DocumentStore } from "../../contracts/document-store.ts";
import type { EditorEmbedding } from "../../contracts/editor-state.ts";
import { STANDALONE_EDITOR_HOST } from "../../contracts/editor-system.ts";
import { mintId, parsePersonId, type AssetId, type IdSeed } from "../../contracts/ids.ts";
import { LivelyShapes } from "../../theme/lively-shapes.tsx";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { connectInMemory, createDocumentStore, createMemoryAssetStore, createMemoryDiscussionStore, createMemoryPresenceHub } from "../../model/index.ts";
import { sampleSlides } from "../sample/sample-deck.ts";
import { SAMPLE_PHOTOGRAPH_MARKUP } from "../sample/sample-photograph.ts";
import { fixtureDeckId } from "../../contracts/testing/snapshot-builders.ts";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { composeEditor, type ComposedEditor } from "./compose-editor.ts";
import { createDemoCollaborationSession, demoConnection, demoRole } from "./demo-collaboration.ts";
import type { CollaborationSession } from "../../contracts/collaboration.ts";
import type { DeckMember } from "../../contracts/deck-access.ts";
import { EditorApplication } from "./editor-application.tsx";
import { PAGE_CONFIGURATION_ID, PAGE_ROOT_ID, parsePageConfiguration, type PageConfiguration } from "./editor-page.ts";

type DemoEditor = Readonly<{ label: string; composed: ComposedEditor; assetStore: AssetStore }>;

async function startDemo(): Promise<ReactElement> {
  const configuration = readConfiguration();
  const parameters = new URLSearchParams(window.location.search);
  const embedding: EditorEmbedding = parameters.get("embed") === "addon" ? { kind: "addonDialog", webApplicationAddress: `${window.location.origin}${window.location.pathname}` } : { kind: "webApplication" };
  const assetStore = createMemoryAssetStore({
    createAddress: (bytes, mediaType) => URL.createObjectURL(new Blob([bytes], { type: mediaType })),
    digest: async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  });
  const first = new Doc();
  const store = createDocumentStore({ sharedDocument: first, seed: { kind: "blankDeck", deckId: "deck_demo" }, now: () => Date.now(), random: Math.random, scheduler: asyncScheduler, repairPolicy: "repairAfterTransaction", typingMergeWindowMilliseconds: 500 });
  const ada = person({ id: "person_ada", displayName: "Ada Lovelace", colourIndex: 0 });
  const grace = person({ id: "person_grace", displayName: "Grace Hopper", colourIndex: 2 });
  const claude: Person = { ...person({ id: "agent_claude", displayName: "Claude", colourIndex: 5 }), kind: "agent" };
  const members: readonly DeckMember[] = [
    { person: ada, role: "owner", email: null },
    { person: grace, role: "editor", email: null },
    { person: claude, role: "editor", email: null },
  ];
  const collaboration = createDemoCollaborationSession({ members, role: demoRole(parameters.get("role")), connection: demoConnection(parameters.get("connection")) });
  await addSampleSlides({ store, assetStore, author: ada });

  const editors: DemoEditor[] = [{ label: "Ada's editor", composed: editorFor({ store, assetStore, me: ada, embedding, runnerAddress: configuration.runnerAddress, presenceClient: first.clientID, twoEditors: parameters.get("editors") === "2", collaboration }), assetStore }];
  if (parameters.get("editors") === "2") {
    const second = new Doc();
    connectInMemory({ first, second });
    const replica = createDocumentStore({ sharedDocument: second, seed: { kind: "none" }, now: () => Date.now(), random: Math.random, scheduler: asyncScheduler, repairPolicy: "reportOnly", typingMergeWindowMilliseconds: 500 });
    const graceSession = createDemoCollaborationSession({ members, role: "editor", connection: { kind: "online" } });
    editors.push({ label: "Grace's editor", composed: editorFor({ store: replica, assetStore, me: grace, embedding, runnerAddress: configuration.runnerAddress, presenceClient: second.clientID, twoEditors: true, collaboration: graceSession }), assetStore });
  }
  if (editors.length === 1) {
    const only = editors[0];
    if (only === undefined) throw new Error("No editor was composed.");
    return <EditorApplication system={only.composed.system} assetStore={only.assetStore} browser={only.composed.browser} presenterDependencies={only.composed.presenterDependencies} clipboardContentFor={only.composed.clipboardContentFor} arrangeThreads={only.composed.arrangeThreads} host={STANDALONE_EDITOR_HOST} />;
  }
  return (
    <div className={VIEW_CLASS.sideBySide}>
      {editors.map((editor) => (
        <section key={editor.label} className={VIEW_CLASS.demoPane} aria-label={editor.label}>
          <p className={VIEW_CLASS.demoLabel}>{editor.label}</p>
          <EditorApplication system={editor.composed.system} assetStore={editor.assetStore} browser={editor.composed.browser} presenterDependencies={editor.composed.presenterDependencies} clipboardContentFor={editor.composed.clipboardContentFor} arrangeThreads={editor.composed.arrangeThreads} host={STANDALONE_EDITOR_HOST} />
        </section>
      ))}
    </div>
  );
}

/** One presence hub for the page, so every editor on it sees every other. */
const presenceHub = createMemoryPresenceHub({ now: () => Date.now() });

function editorFor(options: Readonly<{ store: DocumentStore; assetStore: AssetStore; me: Person; embedding: EditorEmbedding; runnerAddress: string; presenceClient: number; twoEditors: boolean; collaboration: CollaborationSession }>): ComposedEditor {
  return composeEditor({
    page: window,
    documentStore: options.store,
    discussionStore: createMemoryDiscussionStore({ actor: options.me, now: () => Date.now(), initialLog: [] }),
    assetStore: options.assetStore,
    presence: options.twoEditors ? presenceHub.channelFor(options.presenceClient) : null,
    collaboration: options.collaboration,
    recentColours: [],
    me: options.me,
    embedding: options.embedding,
    runnerAddress: options.runnerAddress,
  });
}

/** Puts the sample photograph in the asset store and the sample slides after the seeded title slide. */
async function addSampleSlides(options: Readonly<{ store: DocumentStore; assetStore: AssetStore; author: Person }>): Promise<void> {
  const bytes = new TextEncoder().encode(SAMPLE_PHOTOGRAPH_MARKUP).buffer;
  const assetId: AssetId = await options.assetStore.put(bytes, "image/svg+xml");
  const asset: AssetRecord = { id: assetId, mediaType: "image/svg+xml", pixelWidth: 440, pixelHeight: 360, name: "Sample photograph", byteLength: bytes.byteLength };
  const snapshot = options.store.snapshot();
  const seed: IdSeed = { sessionPrefix: "DemoDeck", counter: 0 };
  const outcome = options.store.apply({
    commandId: mintId({ seed, kind: "command" }).id,
    author: { kind: "person", personId: options.author.id },
    commands: [
      { kind: "registerAsset", asset },
      { kind: "insertSlides", slides: sampleSlides({ deckId: fixtureDeckId("deck_demo"), imageAssetId: assetId, extraSlideCount: 3 }), after: snapshot.slides[snapshot.slides.length - 1]?.id ?? null },
    ],
    selectionBefore: { kind: "none" },
    selectionAfter: { kind: "none" },
    mergeWithPrevious: false,
  });
  if (outcome.kind === "rejected") console.warn("[sasha engine demo] the sample slides were refused", outcome.rejection);
}

/** The page's configuration block (editor-page.ts); a missing or malformed one leaves the runner at "about:blank". */
function readConfiguration(): PageConfiguration {
  return parsePageConfiguration(document.getElementById(PAGE_CONFIGURATION_ID)?.textContent ?? null) ?? { runnerAddress: "about:blank" };
}

function person(options: Readonly<{ id: string; displayName: string; colourIndex: number }>): Person {
  const id = parsePersonId(options.id);
  if (id === null) throw new Error(`Not a person id: ${options.id}`);
  return { id, displayName: options.displayName, colourIndex: options.colourIndex, kind: "person" };
}

function DemoProblem(properties: Readonly<{ message: string }>): ReactElement {
  return (
    <div className={TIDEPOOL_CLASS.root} style={{ blockSize: "100vh", display: "grid", placeItems: "center" }}>
      <LivelyShapes />
      <div className={TIDEPOOL_CLASS.livelyCard} style={{ maxInlineSize: 560 }} role="alert">
        <h1 style={{ marginBlockStart: 0 }}>The editor could not start</h1>
        <p>{properties.message}</p>
        <p className={TIDEPOOL_CLASS.muted}>The demo needs the model, state and presenter modules. While one of them is still a stub, the chrome harness (e2e/editor/) shows the editor on a stand-in.</p>
      </div>
    </div>
  );
}

// The page starts LAST, after every module constant above is initialised: started at the top, the
// synchronous part of `startDemo` could read a constant before its declaration ran (in the bundle,
// where `const` becomes `var`, that is `undefined`, not an error).
const container = document.getElementById(PAGE_ROOT_ID);
if (container !== null) {
  const root = createRoot(container);
  startDemo()
    .then((page) => root.render(page))
    .catch((error: unknown) => {
      console.error("[sasha engine demo]", error);
      root.render(<DemoProblem message={error instanceof Error ? error.message : String(error)} />);
    });
}
