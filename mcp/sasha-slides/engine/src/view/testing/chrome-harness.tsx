// THE CHROME HARNESS: the real editor shell over the sample deck and a fake system, in named
// scenarios -- the editing screen with a collaborator, a menu over a black slide, the script dialog,
// the comment rail, text editing, a 60-slide filmstrip, a 200-element drag, measured layout, seven
// stacked notices (also in the add-on dialog's smaller frame). The
// end-to-end drivers in e2e/editor/ bundle it, open a scenario in Chrome and screenshot or measure
// it. It needs nothing from the model or state modules, so the view's look and cost are checked on
// their own.
//
// The page exposes `window.sashaHarness` (dispatched events, the current state) for the drivers.

import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import { EMPTY_DISCUSSION, type CommentThread, type DiscussionSnapshot } from "../../contracts/discussion.ts";
import type { DocumentSnapshot, ElementSnapshot, SlideSnapshot, TransitionScriptRecord } from "../../contracts/document.ts";
import type { EditorEvent } from "../../contracts/editor-events.ts";
import type { EditorState } from "../../contracts/editor-state.ts";
import type { ArrangedThread } from "../../contracts/editor-system.ts";
import { parsePersonId, type AssetId } from "../../contracts/ids.ts";
import type { PeerPresence } from "../../contracts/presence.ts";
import { literalColour, themeColour } from "../../contracts/style.ts";
import { EditorShell } from "../application/editor-shell.tsx";
import { pageBrowserCapabilities, primaryModifierOf, readImageFile, richTextFromMarkup } from "../application/browser-services.ts";
import { sampleSlides } from "../sample/sample-deck.ts";
import { IdMinter, documentSnapshot, fixtureAssetId, fixtureDeckId, plainBody, shapeElement, slideSnapshot, tableElement } from "../sample/snapshot-builders.ts";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { EMPTY_ASSET_STORE, createRecordingSystem, fixtureEditorState, fixtureServices, type RecordingSystem } from "./editor-fixtures.ts";
import { harnessReduce } from "./harness-reducer.ts";

export const HARNESS_SCENARIOS = ["editor", "menuOverBlack", "contextMenu", "scriptDialog", "comments", "text", "filmstrip", "drag", "measure", "addon", "notices", "addonNotices"] as const;
export type HarnessScenario = (typeof HARNESS_SCENARIOS)[number];

export type HarnessHandle = Readonly<{
  dispatched: readonly EditorEvent[];
  state: () => EditorState;
  dispatch: (event: EditorEvent) => void;
}>;

/** Mounts a scenario into `container` and returns the handle the drivers read. */
export function mountHarness(options: Readonly<{ container: HTMLElement; scenario: HarnessScenario }>): HarnessHandle {
  const image = fixtureAssetId("harness-photo");
  const state = scenarioState({ scenario: options.scenario, image });
  const system = createRecordingSystem({ initial: state, reduce: harnessReduce });
  const assetStore = { ...EMPTY_ASSET_STORE, addressFor: (assetId: AssetId) => (assetId === image ? SAMPLE_PHOTO : null) };
  const services = {
    ...fixtureServices({ system, assetStore, arrangeThreads: fakeArrangeThreads, richTextFrom: richTextFromMarkup, measurePointerMoves: true }),
    browser: pageBrowserCapabilities(window),
    primaryModifier: primaryModifierOf(window),
    readImageFile,
  };
  createRoot(options.container).render(<HarnessPage system={system} services={services} />);
  return { dispatched: system.dispatched, state: () => system.currentState(), dispatch: (event) => system.dispatch(event) };
}

function HarnessPage(properties: Readonly<{ system: RecordingSystem; services: Parameters<typeof EditorShell>[0]["services"] }>): ReactElement {
  return (
    <div style={{ blockSize: "100vh" }} className={VIEW_CLASS.demoPane}>
      <EditorShell services={properties.services} />
    </div>
  );
}

export function scenarioState(options: Readonly<{ scenario: HarnessScenario; image: AssetId }>): EditorState {
  const slides = sampleSlides({ deckId: fixtureDeckId("deck_harness"), imageAssetId: options.image, extraSlideCount: options.scenario === "filmstrip" ? 60 : 7 });
  const script = sampleScript();
  const baseDocument = { ...documentSnapshot({ deckId: fixtureDeckId("deck_harness"), title: "Tidepool tour", slides }), transitionScripts: [script] };
  const document = scenarioDocument({ scenario: options.scenario, document: baseDocument });
  const base = fixtureEditorState({ document });
  const styles = document.slides[1];
  const black = document.slides[3];
  const gradientBox = styles?.elements[2];
  const listBox = styles?.elements[5];
  const withPeers = { ...base, currentSlideId: styles?.id ?? null, peers: styles === undefined ? [] : samplePeers(styles), discussion: styles === undefined ? EMPTY_DISCUSSION : sampleDiscussion(styles) };
  switch (options.scenario) {
    case "editor":
      return { ...withPeers, selection: styles !== undefined && gradientBox !== undefined ? { kind: "elements", slideId: styles.id, elementIds: [gradientBox.id] } : { kind: "none" }, notices: [{ id: noticeId(), tone: "information", message: "Claude wrote a transition: review it before presenting.", action: { kind: "reviewTransitionScript", scriptId: script.id }, expiresAfterMilliseconds: null }] };
    case "menuOverBlack":
      return { ...base, currentSlideId: black?.id ?? null, chrome: { ...base.chrome, openMenu: "insert" } };
    case "contextMenu":
      return { ...base, currentSlideId: black?.id ?? null, chrome: { ...base.chrome, contextMenu: { at: { x: 720, y: 430 }, scope: "canvas" } } };
    case "scriptDialog":
      return { ...withPeers, chrome: { ...base.chrome, dialog: { kind: "transitionScriptEditor", editor: { draft: { id: script.id, name: script.name, description: script.description, script: script.script, stylesheet: script.stylesheet, markup: script.markup, defaultParameters: script.defaultParameters }, basedOnUpdatedAt: script.updatedAt, conflict: false, previewGeneration: 0 } } } };
    case "comments":
      return { ...withPeers, chrome: { ...base.chrome, commentsOpen: true, focusedThreadId: withPeers.discussion.threads[0]?.id ?? null } };
    case "text":
      return { ...withPeers, selection: styles !== undefined && listBox !== undefined ? { kind: "text", target: { kind: "element", slideId: styles.id, elementId: listBox.id }, anchor: 22, focus: 26 } : { kind: "none" }, chrome: { ...base.chrome, propertiesTab: "text" } };
    case "filmstrip":
      return { ...base, currentSlideId: document.slides[30]?.id ?? null };
    case "drag":
    case "measure":
      return { ...base, currentSlideId: document.slides[0]?.id ?? null, chrome: { ...base.chrome, speakerNotesOpen: false } };
    case "addon":
      return { ...withPeers, embedding: { kind: "addonDialog", webApplicationAddress: "https://sashaslides.com/deck/deck_harness" }, chrome: { ...base.chrome, openMenu: "edit" } };
    case "notices":
      return { ...withPeers, notices: sampleNotices(script.id) };
    case "addonNotices":
      return { ...withPeers, embedding: { kind: "addonDialog", webApplicationAddress: "https://sashaslides.com/deck/deck_harness" }, notices: sampleNotices(script.id) };
    default:
      return base;
  }
}

/** The drag and measure scenarios replace the deck with a slide built for them. */
function scenarioDocument(options: Readonly<{ scenario: HarnessScenario; document: DocumentSnapshot }>): DocumentSnapshot {
  const ids = new IdMinter("Harness1");
  switch (options.scenario) {
    case "drag":
      return { ...options.document, slides: [slideSnapshot({ ids, elements: twoHundredElements(ids) }), ...options.document.slides] };
    case "measure":
      return { ...options.document, slides: [measuredSlide(ids), ...options.document.slides] };
    default:
      return options.document;
  }
}

/** 200 shapes in a grid, a mix of boxes and vector presets with text (the drag budget's slide). */
function twoHundredElements(ids: IdMinter): readonly ElementSnapshot[] {
  const elements: ElementSnapshot[] = [];
  for (let index = 0; index < 200; index += 1) {
    const column = index % 20;
    const row = Math.floor(index / 20);
    elements.push(
      shapeElement({
        id: ids.next("element"),
        preset: index % 3 === 0 ? "ellipse" : "roundedRectangle",
        box: { x: 20 + column * 62, y: 20 + row * 68, width: 54, height: 58 },
        style: { fill: { kind: "solid", colour: themeColour({ slot: index % 2 === 0 ? "accent1" : "accent2", alpha: 1 }) }, border: { kind: "uniform", stroke: { width: 2, colour: literalColour({ hexadecimal: "#1c2333", alpha: 1 }), dash: "solid" } } },
        text: plainBody(String(index + 1), { fontSize: 18, colour: themeColour({ slot: "light1", alpha: 1 }) }),
        textBox: { verticalAlignment: "middle", paddingLeft: 2, paddingRight: 2, paddingTop: 2, paddingBottom: 2 },
      }),
    );
  }
  return elements;
}

/** A table whose second row must grow, and a text box that grows with its text. */
function measuredSlide(ids: IdMinter): SlideSnapshot {
  return slideSnapshot({
    ids,
    elements: [
      tableElement({ ids, id: ids.next("element"), box: { x: 60, y: 60, width: 700, height: 120 }, texts: [["Short", "Short"], ["A cell whose text is long enough to wrap over several lines, so the row grows past its stored minimum height", "Short"]] }),
      shapeElement({ id: ids.next("element"), preset: "textBox", box: { x: 820, y: 60, width: 380, height: 60 }, textBox: { autofit: "resizeShape" }, text: plainBody("This text box grows with its text, line after line after line, as Slides does.", { fontSize: 32 }) }),
    ],
  });
}

function sampleScript(): TransitionScriptRecord {
  const ids = new IdMinter("Script01");
  return {
    id: ids.next("transitionScript"),
    name: "Ink wipe",
    description: "Reveals the next slide behind a moving clip, with its elements rising in.",
    author: { kind: "agent", name: "Claude", agentSessionId: "session_sample" },
    script: INK_WIPE,
    stylesheet: "",
    markup: "",
    defaultParameters: {},
    approval: { kind: "unapproved" },
    updatedAt: 1,
  };
}

function samplePeers(slide: SlideSnapshot): readonly PeerPresence[] {
  const grace = parsePersonId("person_grace");
  const element = slide.elements[3];
  if (grace === null) return [];
  return [
    {
      person: { id: grace, displayName: "Grace Hopper", colourIndex: 2, kind: "person" },
      slideId: slide.id,
      selection: element === undefined ? { kind: "none" } : { kind: "elements", slideId: slide.id, elementIds: [element.id] },
      pointer: { x: 980, y: 380 },
      activity: "editing",
      clientId: 2,
      lastSeenAt: 0,
    },
  ];
}

function sampleDiscussion(slide: SlideSnapshot): DiscussionSnapshot {
  const ids = new IdMinter("Thread01");
  const ada = parsePersonId("person_ada");
  const claude = parsePersonId("agent_claude");
  if (ada === null || claude === null) return EMPTY_DISCUSSION;
  const adaPerson = { id: ada, displayName: "Ada Lovelace", colourIndex: 0, kind: "person" as const };
  const claudePerson = { id: claude, displayName: "Claude", colourIndex: 5, kind: "agent" as const };
  const first = slide.elements[2];
  const threads: CommentThread[] = [
    {
      id: ids.next("thread"),
      anchor: { slideId: slide.id, target: first === undefined ? { kind: "slide" } : { kind: "element", elementId: first.id }, region: null, elementFrameAtCreation: first?.frame ?? null },
      status: { kind: "open" },
      createdBy: adaPerson,
      createdAt: 1,
      messages: [
        { id: ids.next("message"), author: adaPerson, body: "Can the gradient run the other way, so it matches the title slide?", mentions: [], createdAt: 1, editedAt: null, editCount: 0 },
        { id: ids.next("message"), author: claudePerson, body: "Done: it now runs from teal to indigo. Undo my edit if you preferred it before.", mentions: [], createdAt: 2, editedAt: null, editCount: 0 },
      ],
      markings: [],
    },
    {
      id: ids.next("thread"),
      anchor: { slideId: slide.id, target: { kind: "slide" }, region: { x: 0.52, y: 0.62, width: 0.2, height: 0.25 }, elementFrameAtCreation: null },
      status: { kind: "open" },
      createdBy: claudePerson,
      createdAt: 3,
      messages: [{ id: ids.next("message"), author: claudePerson, body: "This image is still a placeholder; shall I find a photograph?", mentions: [], createdAt: 3, editedAt: null, editCount: 0 }],
      markings: [],
    },
  ];
  return { sequence: 3, threads };
}

/** Places threads on their element or slide (a stand-in for the state module's `arrangeThreads`). */
function fakeArrangeThreads(input: Readonly<{ discussion: DiscussionSnapshot; document: DocumentSnapshot }>): readonly ArrangedThread[] {
  return input.discussion.threads.map((thread) => {
    const target = thread.anchor.target;
    const slide = input.document.slides.find((candidate) => candidate.id === thread.anchor.slideId);
    if (slide === undefined) return { thread, placement: { kind: "slideRemoved" } };
    if (target.kind === "slide") {
      const region = thread.anchor.region ?? { x: 0.9, y: 0.05, width: 0.05, height: 0.05 };
      return { thread, placement: { kind: "onSlide", slideId: slide.id, box: { x: region.x * 1280, y: region.y * 720, width: region.width * 1280, height: region.height * 720 } } };
    }
    const element = slide.elements.find((candidate) => candidate.id === target.elementId);
    return element === undefined
      ? { thread, placement: { kind: "elementRemoved", slideId: slide.id, box: thread.anchor.elementFrameAtCreation ?? { x: 0, y: 0, width: 10, height: 10 } } }
      : { thread, placement: { kind: "onElement", slideId: slide.id, elementId: element.id, box: element.frame, textRange: null } };
  });
}

/** Seven notices of every tone, oldest first, as a busy session raises them (the notice stack's screenshot). */
function sampleNotices(scriptId: TransitionScriptRecord["id"]): EditorState["notices"] {
  const ids = new IdMinter("Notices2");
  const notice = (tone: EditorState["notices"][number]["tone"], message: string, action: EditorState["notices"][number]["action"]): EditorState["notices"][number] => ({ id: ids.next("notice"), tone, message, action, expiresAfterMilliseconds: null });
  return [
    notice("information", "Exported to Google Slides.", null),
    notice("warning", "You can comment on this deck, but not edit it.", null),
    notice("information", "Claude wrote a transition: review it before presenting.", { kind: "reviewTransitionScript", scriptId }),
    notice("error", "The image upload failed: the file is larger than 25 megabytes.", null),
    notice("warning", "The server is receiving too many changes from this window; it takes them again in 3 seconds.", null),
    notice("information", "Claude edited the deck: tightened the title slide.", null),
    notice("information", "Copied 2 elements.", null),
  ];
}

function noticeId(): EditorState["notices"][number]["id"] {
  return new IdMinter("Notices1").next("notice");
}

/** A small landscape drawn as markup, standing in for an uploaded photograph. */
const SAMPLE_PHOTO = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="360" viewBox="0 0 440 360"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#fde68a"/></linearGradient></defs><rect width="440" height="360" fill="url(#sky)"/><circle cx="330" cy="110" r="46" fill="#fb923c"/><path d="M0 260 L120 150 L230 250 L320 180 L440 270 L440 360 L0 360 Z" fill="#0e7490"/><path d="M0 300 L160 230 L300 300 L440 250 L440 360 L0 360 Z" fill="#047857"/></svg>`,
)}`;

const INK_WIPE = `sashaTransition.define({
  name: "Ink wipe",
  async run(context) {
    const { outgoing, incoming, overlay, durationMilliseconds, direction } = context;
    if (outgoing === null || context.reducedMotion) {
      await context.animate(incoming, [{ opacity: 0 }, { opacity: 1 }], { duration: 150 }).finished;
      return;
    }
    const sweep = direction === "forward" ? ["inset(0 0 0 100%)", "inset(0 0 0 0)"] : ["inset(0 100% 0 0)", "inset(0 0 0 0)"];
    incoming.style.zIndex = "2";
    const reveal = context.animate(incoming, [{ clipPath: sweep[0] }, { clipPath: sweep[1] }],
      { duration: durationMilliseconds, easing: "cubic-bezier(.6,0,.2,1)" });
    await reveal.finished;
  },
});`;
