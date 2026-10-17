// The shared deck's chrome without a browser (SPEC.md 21.9): the host's logo, accessory and File
// items (acceptance 9), the connection indicator and the read-only banner (10), mentions (12),
// annotations (13) and presence (14). Rendered with `renderToStaticMarkup`; a click is the
// element's own handler, called on the element tree a hook-free component returns.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SASHA_ICON_SVG } from "../../../../http/sasha-icon.generated.ts";
import { reduceEditor } from "../../state/editor/reduce-editor.ts";
import { editorStateFor, personId as statePersonId, shape, slide, slideId, testDocument } from "../../state/testing/document-fixtures.ts";
import { LOCAL_COLLABORATION_STATUS, type CollaborationStatus } from "../../contracts/collaboration.ts";
import type { CommentMessage, CommentThread, Marking, Person } from "../../contracts/discussion.ts";
import type { EditorEvent, EditorState, PeerPresence, SlideSnapshot } from "../../contracts/index.ts";
import { STANDALONE_EDITOR_HOST, type ArrangedThread, type EditorHost } from "../../contracts/editor-system.ts";
import { EditorGestureContext, EditorServicesContext, ViewPreferencesContext } from "../application/editor-services.tsx";
import { EditorShell } from "../application/editor-shell.tsx";
import { CanvasOverlay } from "../canvas/canvas-overlay.tsx";
import { documentSnapshot, fixtureDeckId, IdMinter, plainBody, shapeElement, slideSnapshot } from "../sample/snapshot-builders.ts";
import { createRecordingSystem, fixtureEditorState, fixtureServices, recordingCapabilities } from "../testing/editor-fixtures.ts";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { MessageBody, railSections, threadPassesFilter } from "./comment-rail.tsx";
import { Filmstrip } from "./filmstrip.tsx";
import { insertMention, matchingMembers, mentionQueryAt } from "./mentions.ts";
import { menuEntries } from "./menu-model.ts";
import { peerLocations } from "./presence.ts";
import { ConnectionIndicator, PeerList, TopBar, connectionNote } from "./top-bar.tsx";

const ids = new IdMinter("Collab01");
const box = shapeElement({ id: ids.next("element"), box: { x: 200, y: 100, width: 400, height: 200 }, text: plainBody("Quarterly numbers") });
const slides = [0, 1, 2].map((index) => slideSnapshot({ ids, elements: index === 2 ? [box] : [shapeElement({ id: ids.next("element"), text: plainBody(`Slide ${index + 1}`) })] }));
const document = documentSnapshot({ deckId: fixtureDeckId("deck_collaboration"), title: "Shared deck", slides });
const thirdSlide: SlideSnapshot = slides[2] ?? missingFixture("the third slide");

const ada: Person = { id: personIdOf("person_ada"), displayName: "Ada Lovelace", colourIndex: 0, kind: "person" };
const grace: Person = { id: personIdOf("person_grace"), displayName: "Grace Hopper", colourIndex: 2, kind: "person" };
const greg: Person = { id: personIdOf("person_greg"), displayName: "Greg House", colourIndex: 3, kind: "person" };
const claude: Person = { id: personIdOf("agent_claude"), displayName: "Claude", colourIndex: 5, kind: "agent" };

describe("the host's additions (acceptance 9)", () => {
  const accessory = createElement("button", { type: "button", "data-host-accessory": "share" }, "Share");
  const host: EditorHost = {
    homeAddress: "https://sashaslides.com/decks",
    topBarAccessory: accessory,
    fileMenuItems: [
      { id: "allDecks", label: "All decks", disabledReason: null, run: () => undefined },
      { id: "export", label: "Export to Google Slides", disabledReason: "Connect Google Slides first", run: () => undefined },
    ],
  };
  const rows: readonly Readonly<{ name: string; host: EditorHost; linked: boolean }>[] = [
    { name: "the logo is the real Sasha Slides logo inside a link to the home address", host, linked: true },
    { name: "control: without a home address the logo is not a link", host: STANDALONE_EDITOR_HOST, linked: false },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const markup = render({ state: fixtureEditorState({ document }), child: createElement(TopBar), host: row.host });
      assert.ok(markup.includes(SASHA_ICON_SVG), "the generated logo markup is in the top bar");
      const linked = new RegExp(`<a class="${VIEW_CLASS.logoLink}" href="https://sashaslides.com/decks"[^>]*><span class="${VIEW_CLASS.logo}"[^>]*>${escapeExpression(SASHA_ICON_SVG.slice(0, 40))}`);
      assert.equal(linked.test(markup), row.linked);
      assert.equal(/<a [^>]*class="sasha-view-logo-link"|<a class="sasha-view-logo-link"/.test(markup), row.linked);
    });
  }

  it("the accessory comes after the peers and before Present", () => {
    const markup = render({ state: fixtureEditorState({ document }), child: createElement(TopBar), host });
    const accessoryAt = markup.indexOf('data-host-accessory="share"');
    const presentAt = markup.indexOf(">Present<");
    assert.ok(accessoryAt > 0 && presentAt > accessoryAt, `${accessoryAt} before ${presentAt}`);
  });

  it("the File menu ends with the host's items in order; a disabled one is aria-disabled with its reason", () => {
    const state = fixtureEditorState({ document });
    const entries = menuEntries({ menu: "file", state, shortcuts: "control", hostItems: host.fileMenuItems, showAnnotations: true });
    const labels = entries.flatMap((entry) => (entry.kind === "item" ? [entry.label] : []));
    assert.deepEqual(labels.slice(-2), ["All decks", "Export to Google Slides"]);
    const opened: EditorState = { ...state, chrome: { ...state.chrome, openMenu: "file" } };
    const markup = render({ state: opened, child: createElement(EditorShell, { services: fixtureServices({ system: createRecordingSystem({ initial: opened }), host }) }), host });
    assert.match(markup, /aria-disabled="true"[^>]*>[\s\S]*?<span>Export to Google Slides<\/span><\/button><div class="sasha-view-menu-hint">Connect Google Slides first<\/div>/);
    assert.match(markup, /aria-disabled="false"[^>]*>[\s\S]*?<span>All decks<\/span>/);
  });
});

describe("the connection (acceptance 10, the view)", () => {
  const offline: CollaborationStatus = { ...LOCAL_COLLABORATION_STATUS, connection: { kind: "offline", reason: "networkLost", attempt: 2, retryInMilliseconds: 8000 } };
  const rows: readonly Readonly<{ name: string; status: CollaborationStatus; text: string | null; tryNow: boolean }>[] = [
    { name: "offline, retrying in 8 seconds", status: offline, text: "Offline - reconnecting in 8 s", tryNow: true },
    { name: "online with changes the server lacks", status: { ...LOCAL_COLLABORATION_STATUS, connection: { kind: "online" }, unsentChanges: true }, text: "Changes not sent yet", tryNow: false },
    { name: "control: online says nothing", status: { ...LOCAL_COLLABORATION_STATUS, connection: { kind: "online" } }, text: null, tryNow: false },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const note = connectionNote(row.status);
      assert.equal(note?.text ?? null, row.text);
      assert.equal(note?.tryNow ?? false, row.tryNow);
    });
  }

  it("Try now dispatches reconnectRequested", () => {
    const dispatched: EditorEvent[] = [];
    const tree = ConnectionIndicator({ status: offline, dispatch: (event) => dispatched.push(event) });
    assert.match(renderToStaticMarkup(tree ?? createElement("span")), /Offline - reconnecting in 8 s/);
    const button = findElement(tree, (element) => element.type === "button");
    clickOf(button)();
    assert.deepEqual(dispatched, [{ kind: "reconnectRequested" }]);
  });

  const bannerRows: readonly Readonly<{ name: string; status: CollaborationStatus; banner: boolean }>[] = [
    { name: "access revoked: a read-only banner with the reason", status: { ...LOCAL_COLLABORATION_STATUS, connection: { kind: "closed", reason: "accessRevoked" } }, banner: true },
    { name: "control: online: no banner", status: { ...LOCAL_COLLABORATION_STATUS, connection: { kind: "online" } }, banner: false },
  ];
  for (const row of bannerRows) {
    it(row.name, () => {
      const state: EditorState = { ...fixtureEditorState({ document }), collaboration: row.status };
      const markup = render({ state, child: createElement(EditorShell, { services: fixtureServices({ system: createRecordingSystem({ initial: state }) }) }) });
      assert.equal(markup.includes(`class="${VIEW_CLASS.readOnlyBanner}"`), row.banner);
      assert.equal(markup.includes("Your access to this deck was removed, so it is read-only now."), row.banner);
    });
  }

  const roleRows = [
    { role: "viewer", disabled: true, reason: "You can view this deck, but not edit it." },
    { role: "commenter", disabled: true, reason: "You can comment on this deck, but not edit it." },
    { role: "editor", disabled: false, reason: null },
  ] as const;
  for (const row of roleRows) {
    it(`${row.role}: the insert tools ${row.disabled ? "are disabled with the reason" : "are enabled"}`, () => {
      const state: EditorState = { ...fixtureEditorState({ document }), collaboration: { ...LOCAL_COLLABORATION_STATUS, connection: { kind: "online" }, role: row.role } };
      const markup = render({ state, child: createElement(EditorShell, { services: fixtureServices({ system: createRecordingSystem({ initial: state }) }) }) });
      const textBoxButton = /<button[^>]*aria-label="Text box"[^>]*>/.exec(markup)?.[0] ?? "";
      assert.equal(textBoxButton.includes('disabled=""'), row.disabled, textBoxButton);
      if (row.reason !== null) assert.ok(textBoxButton.includes(row.reason), textBoxButton);
    });
  }
});

describe("mentions (acceptance 12)", () => {
  const members = [ada, grace, greg, claude];
  it("typing @gr lists Grace and Greg", () => {
    const query = mentionQueryAt({ text: "Ask @gr", caret: 7 });
    assert.deepEqual(query, { start: 4, query: "gr" });
    assert.deepEqual(matchingMembers({ members, query: query?.query ?? "", me: ada.id }).map((person) => person.displayName), ["Grace Hopper", "Greg House"]);
  });

  const queryRows: readonly Readonly<{ text: string; caret: number; query: string | null }>[] = [
    { text: "@", caret: 1, query: "" },
    { text: "mail me@home", caret: 12, query: null },
    { text: "@gr\nmore", caret: 8, query: null },
  ];
  for (const row of queryRows) {
    it(`control: "${row.text.replace("\n", "\\n")}" at ${row.caret} ${row.query === null ? "is no mention" : `queries "${row.query}"`}`, () => {
      assert.equal(mentionQueryAt({ text: row.text, caret: row.caret })?.query ?? null, row.query);
    });
  }

  it("choosing Grace inserts '@Grace Hopper ' and the queued createThread carries her id", () => {
    const query = mentionQueryAt({ text: "Ask @gr", caret: 7 });
    assert.ok(query !== null);
    const inserted = insertMention({ text: "Ask @gr", caret: 7, query, person: grace });
    assert.deepEqual(inserted, { text: "Ask @Grace Hopper ", caret: 18 });
    const box = shape({ id: "shape_mentioned", x: 0, y: 0, width: 100, height: 100 });
    const start = editorStateFor(testDocument({ slides: [slide({ id: "slide_one", elements: [box] })] }));
    const opened = reduceEditor(start, { kind: "commentComposerOpened", slideId: slideId("slide_one"), elementId: box.id, textRange: null, region: null });
    const drafted = reduceEditor(opened, { kind: "commentDraftChanged", draft: `${inserted.text}to check`, mentions: [grace.id] });
    const submitted = reduceEditor(drafted, { kind: "commentSubmitted" });
    const command = submitted.pendingDiscussion[0]?.command;
    assert.ok(command !== undefined && command.kind === "createThread");
    assert.equal(command.body, "Ask @Grace Hopper to check");
    assert.deepEqual(command.mentions, [grace.id]);
  });

  it("a message highlights its mentions, and only the recorded ones", () => {
    const message: CommentMessage = { id: ids.next("message"), author: claude, body: "@Grace Hopper and @Greg House, see this", mentions: [grace.id], createdAt: 1, editedAt: null, editCount: 0 };
    const markup = renderToStaticMarkup(createElement(MessageBody, { message, people: members }));
    assert.match(markup, new RegExp(`<span class="${VIEW_CLASS.mention}" data-mention="person_grace"[^>]*>@Grace Hopper</span>`));
    assert.doesNotMatch(markup, /data-mention="person_greg"/);
  });

  it("the 'mentions of me' filter shows only threads mentioning me", () => {
    const mentioning = threadWith({ mentions: [ada.id] });
    const other = threadWith({ mentions: [grace.id] });
    const arranged: readonly ArrangedThread[] = [mentioning, other].map((thread) => ({ thread, placement: { kind: "onSlide", slideId: thirdSlide.id, box: { x: 0, y: 0, width: 0, height: 0 } } }));
    const shown = railSections({ arranged, currentSlideId: thirdSlide.id, filter: "mentionsOfMe", me: ada.id });
    assert.deepEqual(shown.onSlides.map((entry) => entry.arranged.thread.id), [mentioning.id]);
    assert.equal(threadPassesFilter({ thread: other, filter: "open", me: ada.id }), true, "control: the open filter shows it");
  });

  it("threads on deleted slides gather in their own section", () => {
    const kept = threadWith({ mentions: [] });
    const orphaned = threadWith({ mentions: [] });
    const sections = railSections({
      arranged: [
        { thread: kept, placement: { kind: "onSlide", slideId: thirdSlide.id, box: { x: 0, y: 0, width: 0, height: 0 } } },
        { thread: orphaned, placement: { kind: "slideRemoved" } },
      ],
      currentSlideId: thirdSlide.id,
      filter: "open",
      me: ada.id,
    });
    assert.deepEqual(sections.onSlides.map((entry) => entry.arranged.thread.id), [kept.id]);
    assert.deepEqual(sections.onDeletedSlides.map((entry) => entry.arranged.thread.id), [orphaned.id]);
  });
});

describe("annotations (acceptance 13)", () => {
  const annotated = shape({ id: "shape_annotated", x: 100, y: 100, width: 400, height: 200 });
  const start = editorStateFor(testDocument({ slides: [slide({ id: "slide_one", elements: [annotated] })] }));
  const at = (x: number, y: number) => ({ slidePoint: { x, y }, clientPoint: { x, y } });
  const modifiers = { shift: false, alt: false, primary: false };
  const draw = (state: EditorState, marking: Marking["kind"], points: readonly Readonly<{ x: number; y: number }>[]): EditorState => {
    const chosen = reduceEditor(state, { kind: "toolChosen", tool: { kind: "annotate", marking } });
    const first = points[0];
    if (first === undefined) return chosen;
    let current = reduceEditor(chosen, { kind: "canvasPointerDown", sample: at(first.x, first.y), target: { kind: "element", elementPath: [annotated.id] }, modifiers, button: "primary", clickCount: 1 });
    for (const point of points.slice(1)) current = reduceEditor(current, { kind: "canvasPointerMove", sample: at(point.x, point.y), modifiers });
    const last = points[points.length - 1] ?? first;
    return reduceEditor(current, { kind: "canvasPointerUp", sample: at(last.x, last.y), modifiers });
  };
  const composing = reduceEditor(start, { kind: "commentComposerOpened", slideId: slideId("slide_one"), elementId: annotated.id, textRange: null, region: null });
  const penned = draw(composing, "pen", [{ x: 100, y: 100 }, { x: 300, y: 200 }, { x: 500, y: 300 }]);
  const boxed = draw(penned, "rectangle", [{ x: 400, y: 250 }, { x: 200, y: 150 }]);

  it("a pen stroke and a rectangle are stored in fractions of the element's frame", () => {
    const composer = boxed.chrome.composer;
    assert.equal(composer.kind, "composing");
    if (composer.kind !== "composing") return;
    assert.deepEqual(composer.markings, [
      { kind: "pen", points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }], colour: "#4338ca", width: 3 },
      { kind: "rectangle", region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, colour: "#4338ca" },
    ]);
  });

  const composer = boxed.chrome.composer;
  const markings = composer.kind === "composing" ? composer.markings : [];
  const thread: CommentThread = { ...threadWith({ mentions: [] }), anchor: { slideId: slideId("slide_one"), target: { kind: "element", elementId: annotated.id }, region: null, elementFrameAtCreation: null }, markings };
  const overlayMarkup = (options: Readonly<{ x: number; showAnnotations: boolean }>): string => {
    const moved = { ...annotated, frame: { ...annotated.frame, x: options.x } };
    const movedSlide = slide({ id: "slide_one", elements: [moved] });
    const arranged: ArrangedThread = { thread, placement: { kind: "onElement", slideId: movedSlide.id, elementId: moved.id, box: { x: options.x + 400, y: 100, width: 0, height: 0 }, textRange: null } };
    return renderToStaticMarkup(
      createElement(CanvasOverlay, {
        slide: movedSlide,
        scale: 1,
        selection: { kind: "none" },
        gesture: { kind: "idle" },
        measured: new Map(),
        peers: [],
        pins: [arranged],
        composer: { kind: "closed" },
        focusedThread: arranged,
        showAnnotations: options.showAnnotations,
        pageSize: { width: 1280, height: 720 },
        awayClientIds: new Set<number>(),
      }),
    );
  };
  const rows = [
    { name: "the focused thread's markings sit on the element", x: 100, showAnnotations: true, points: "100,100 300,200 500,300", rectangle: 'x="200" y="150"' },
    { name: "moving the element moves them", x: 300, showAnnotations: true, points: "300,100 500,200 700,300", rectangle: 'x="400" y="150"' },
    { name: "control: View > Show annotations off hides them", x: 100, showAnnotations: false, points: null, rectangle: null },
  ] as const;
  for (const row of rows) {
    it(row.name, () => {
      const markup = overlayMarkup({ x: row.x, showAnnotations: row.showAnnotations });
      if (row.points === null || row.rectangle === null) {
        assert.doesNotMatch(markup, /<polyline points=/);
        return;
      }
      assert.match(markup, new RegExp(`<polyline points="${row.points}"`));
      assert.match(markup, new RegExp(`<rect ${row.rectangle} width="200" height="100"`));
    });
  }
});

describe("presence (acceptance 14)", () => {
  const graceShort: Person = { ...grace, displayName: "Grace" };
  const peers: readonly PeerPresence[] = [
    { person: graceShort, slideId: thirdSlide.id, selection: { kind: "elements", slideId: thirdSlide.id, elementIds: [box.id] }, pointer: { x: 300, y: 150 }, activity: "editing", clientId: 11, lastSeenAt: 0 },
    { person: greg, slideId: thirdSlide.id, selection: { kind: "none" }, pointer: { x: 700, y: 400 }, activity: "editing", clientId: 12, lastSeenAt: 0 },
  ];

  it("the canvas shows two labelled cursors in their peer colours and one peer selection outline", () => {
    const markup = renderToStaticMarkup(
      createElement(CanvasOverlay, {
        slide: thirdSlide,
        scale: 1,
        selection: { kind: "none" },
        gesture: { kind: "idle" },
        measured: new Map(),
        peers,
        pins: [],
        composer: { kind: "closed" },
        focusedThread: null,
        showAnnotations: true,
        pageSize: { width: 1280, height: 720 },
        awayClientIds: new Set<number>(),
      }),
    );
    assert.equal(markup.match(new RegExp(`class="${VIEW_CLASS.peerCursor}"`, "g"))?.length, 2);
    assert.match(markup, /class="sasha-view-peer-cursor" style="left:300px;top:150px;color:var\(--sasha-peer-colours-3\)"[\s\S]*?>Grace<\/span>/);
    assert.match(markup, /class="sasha-view-peer-cursor" style="left:700px;top:400px;color:var\(--sasha-peer-colours-4\)"[\s\S]*?>Greg House<\/span>/);
    assert.equal(markup.match(new RegExp(`class="${VIEW_CLASS.peerSelection}"`, "g"))?.length, 1);
  });

  it("filmstrip thumbnails show the peers' avatars on the slide they are on", () => {
    const state: EditorState = { ...fixtureEditorState({ document }), peers };
    const markup = render({ state, child: createElement(Filmstrip) });
    const third = markup.slice(markup.indexOf(`data-sasha-thumbnail="${thirdSlide.id}"`));
    assert.match(third, new RegExp(`class="${VIEW_CLASS.thumbnailAvatar}"[^>]*data-peer="person_grace"[^>]*>G<`));
    assert.match(third, /data-peer="person_greg"[^>]*>GH</);
    const first = markup.slice(0, markup.indexOf(`data-sasha-thumbnail="${thirdSlide.id}"`));
    assert.doesNotMatch(first, /data-peer=/, "control: no avatar on a slide nobody is on");
  });

  it("the top bar's list says who is on which slide, and a click goes there", () => {
    const locations = peerLocations({ peers, document, now: 0 });
    assert.deepEqual(locations.map((location) => location.label), ["Grace - slide 3", "Greg House - slide 3"]);
    const dispatched: EditorEvent[] = [];
    const tree = PeerList({ locations, dispatch: (event) => dispatched.push(event), onChosen: () => undefined });
    assert.match(renderToStaticMarkup(tree), /<span>Grace - slide 3<\/span>/);
    clickOf(findElement(tree, (element) => element.type === "button"))();
    assert.deepEqual(dispatched, [{ kind: "slideActivated", slideId: thirdSlide.id }]);
  });

  const silenceRows = [
    { name: "a peer heard from 10 seconds ago is here", now: 10_000, label: "Grace - slide 3" },
    { name: "a peer silent for 31 seconds is away", now: 31_000, label: "Grace - slide 3 (away)" },
    { name: "a peer silent for over 2 minutes is gone", now: 121_000, label: null },
  ] as const;
  for (const row of silenceRows) {
    it(row.name, () => {
      const first = peers[0];
      if (first === undefined) throw new Error("the fixture has peers");
      assert.equal(peerLocations({ peers: [first], document, now: row.now })[0]?.label ?? null, row.label);
    });
  }
});

function render(options: Readonly<{ state: EditorState; child: ReactElement; host?: EditorHost }>): string {
  const system = createRecordingSystem({ initial: options.state });
  const services = fixtureServices({ system, ...(options.host === undefined ? {} : { host: options.host }) });
  const gesture = { system, browser: recordingCapabilities([]), clipboardContentFor: services.clipboardContentFor, presentationHost: () => null, speakerWindow: { current: null }, assetAddress: services.assetAddress };
  return renderToStaticMarkup(
    createElement(
      EditorServicesContext.Provider,
      { value: services },
      createElement(EditorGestureContext.Provider, { value: gesture }, createElement(ViewPreferencesContext.Provider, { value: { showAnnotations: true, toggleAnnotations: () => undefined } }, options.child)),
    ),
  );
}

function threadWith(options: Readonly<{ mentions: CommentMessage["mentions"] }>): CommentThread {
  const id = ids.next("thread");
  return {
    id,
    anchor: { slideId: thirdSlide.id, target: { kind: "slide" }, region: null, elementFrameAtCreation: null },
    status: { kind: "open" },
    createdBy: grace,
    createdAt: 1,
    messages: [{ id: ids.next("message"), author: grace, body: "Have a look", mentions: options.mentions, createdAt: 1, editedAt: null, editCount: 0 }],
    markings: [],
  };
}

function missingFixture(what: string): never {
  throw new Error(`The fixture lacks ${what}.`);
}

function personIdOf(text: string): Person["id"] {
  return statePersonId(text);
}

/** The first element in a returned tree that matches (host elements only; components are not expanded). */
function findElement(node: ReactNode, matches: (element: ReactElement<Readonly<Record<string, unknown>>>) => boolean): ReactElement<Readonly<Record<string, unknown>>> {
  const found = searchTree(node, matches);
  if (found === null) throw new Error("no element in the tree matches");
  return found;
}

function searchTree(node: ReactNode, matches: (element: ReactElement<Readonly<Record<string, unknown>>>) => boolean): ReactElement<Readonly<Record<string, unknown>>> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = searchTree(child, matches);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isValidElement<Readonly<Record<string, unknown>>>(node)) return null;
  if (matches(node)) return node;
  const children = node.props["children"];
  return searchTree(isReactNode(children) ? children : null, matches);
}

function isReactNode(value: unknown): value is ReactNode {
  return value === null || value === undefined || typeof value !== "function";
}

function clickOf(element: ReactElement<Readonly<Record<string, unknown>>>): () => void {
  const onClick = element.props["onClick"];
  if (typeof onClick !== "function") throw new Error("the element has no click handler");
  return () => onClick();
}

function escapeExpression(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
