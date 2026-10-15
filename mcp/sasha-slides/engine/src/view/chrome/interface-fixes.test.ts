// The milestone 2 interface fixes, asserted without a browser (the screenshots are the visual
// check): notices stack in a corner column beside the slide, newest nearest the corner, scrolling
// past a cap (SPEC.md section 9); the script dialog says where a script really runs (SPEC.md 21.18:
// the runner is on the editor's own site); the local person's own earlier connection is never a
// peer (SPEC.md 21.9, presence); Ungroup is offered only when the selection holds a group.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Person } from "../../contracts/discussion.ts";
import type { EditorState, Notice } from "../../contracts/editor-state.ts";
import type { PeerPresence } from "../../contracts/presence.ts";
import { parsePersonId } from "../../contracts/ids.ts";
import { reduceEditor } from "../../state/editor/reduce-editor.ts";
import { editorStateFor, group, shape, slide, slideId, testDocument } from "../../state/testing/document-fixtures.ts";
import { EditorGestureContext, EditorServicesContext, ViewPreferencesContext } from "../application/editor-services.tsx";
import { sampleSlides } from "../sample/sample-deck.ts";
import { fixtureAssetId, fixtureDeckId, IdMinter } from "../sample/snapshot-builders.ts";
import { scenarioState } from "../testing/chrome-harness.tsx";
import { createRecordingSystem, fixtureServices, recordingCapabilities } from "../testing/editor-fixtures.ts";
import { VIEW_CLASS, viewStylesheet } from "../view-stylesheet.ts";
import { DialogLayer } from "./dialogs.tsx";
import { contextMenuEntries, menuEntries } from "./menu-model.ts";
import { PropertiesPanel } from "./properties-panel.tsx";
import { Notices } from "./speaker-notes.tsx";
import { TopBar } from "./top-bar.tsx";

describe("notices stack in a corner column beside the slide", () => {
  const rule = ruleFor(viewStylesheet(), `.${VIEW_CLASS.notices}`);

  it("the column is anchored to the end corner, never the start corner over the canvas", () => {
    assert.match(rule, /inset-inline-end:/);
    assert.doesNotMatch(rule, /inset-inline-start:/);
  });

  it("the column is placed inside the editor, so the add-on's smaller dialog keeps it in its own frame", () => {
    assert.match(rule, /position: absolute;/);
  });

  it("the column is as wide as the side panel and stops at a maximum height, scrolling beyond it", () => {
    assert.match(rule, /inline-size: min\(300px,/);
    assert.match(rule, /max-block-size: /);
    assert.match(rule, /overflow-y: auto;/);
  });

  it("the newest notice is nearest the corner: newest first in the markup, laid out from the bottom up", () => {
    const ids = new IdMinter("Notices3");
    const notices: readonly Notice[] = ["oldest", "middle", "newest"].map((message) => ({ id: ids.next("notice"), tone: "information", message, action: null, expiresAfterMilliseconds: null }));
    const state = { ...editorStateFor(testDocument({ slides: [slide({ id: "slide_one", elements: [] })] })), notices };
    const markup = render({ state, child: createElement(Notices) });
    const order = ["newest", "middle", "oldest"].map((message) => markup.indexOf(`<p>${message}</p>`));
    assert.deepEqual([...order].sort((first, second) => first - second), order, `markup order ${order.join(", ")}`);
    assert.match(rule, /flex-direction: column-reverse;/);
  });
});

describe("the script dialog says where a script runs (SPEC.md 21.18)", () => {
  const state = scenarioState({ scenario: "scriptDialog", image: fixtureAssetId("photo") });
  const markup = render({ state, child: createElement(DialogLayer) });

  it("an unapproved script runs in an isolated frame on this site, and only once approved", () => {
    assert.match(markup, /Not approved yet\./);
    assert.doesNotMatch(markup, /another site/);
    assert.match(markup, /isolated frame on this site/);
    assert.match(markup, /[Oo]nly approved scripts run/);
  });

  it("the sample deck's table says the same", () => {
    const text = JSON.stringify(sampleSlides({ deckId: fixtureDeckId("deck_sample"), imageAssetId: fixtureAssetId("photo"), extraSlideCount: 0 }));
    assert.doesNotMatch(text, /another site/);
  });
});

describe("the local person's own connections are never peers", () => {
  const grace: Person = { id: personIdOf("person_grace"), displayName: "Grace Hopper", colourIndex: 2, kind: "person" };
  const ada: Person = { id: personIdOf("person_ada"), displayName: "Ada Lovelace", colourIndex: 0, kind: "person" };
  const firstSlide = slide({ id: "slide_one", elements: [] });
  const base: EditorState = editorStateFor(testDocument({ slides: [firstSlide] }), { me: grace });
  const presence = (person: Person, clientId: number): PeerPresence => ({ person, slideId: firstSlide.id, selection: { kind: "none" }, pointer: { x: 10, y: 10 }, activity: "editing", clientId, lastSeenAt: 0 });

  const rows: readonly Readonly<{ name: string; peers: readonly PeerPresence[]; shown: readonly string[] }>[] = [
    { name: "Grace's earlier connection (an old client id) is left out after she reloads", peers: [presence(grace, 7), presence(ada, 11)], shown: ["Ada Lovelace"] },
    { name: "control: someone else's two connections both stay", peers: [presence(ada, 11), presence(ada, 12)], shown: ["Ada Lovelace", "Ada Lovelace"] },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const next = reduceEditor(base, { kind: "peersChanged", peers: row.peers });
      assert.deepEqual(next.peers.map((peer) => peer.person.displayName), row.shown);
      const markup = render({ state: next, child: createElement(TopBar) });
      assert.match(markup, new RegExp(`aria-label="Also here: ${row.shown.join(", ")}"`));
    });
  }
});

describe("Ungroup is offered only when the selection holds a group", () => {
  const textBox = shape({ id: "shape_text", x: 0, y: 0, width: 300, height: 100, preset: "textBox" });
  const loose = shape({ id: "shape_loose", x: 400, y: 0, width: 100, height: 100 });
  const grouped = group({ id: "group_pair", children: [shape({ id: "shape_left", x: 0, y: 300, width: 100, height: 100 }), shape({ id: "shape_right", x: 200, y: 300, width: 100, height: 100 })] });
  const document = testDocument({ slides: [slide({ id: "slide_one", elements: [textBox, loose, grouped] })] });
  const rows: readonly Readonly<{ name: string; selected: readonly (typeof textBox | typeof grouped)[]; enabled: boolean }>[] = [
    { name: "a single text box: Ungroup is disabled", selected: [textBox], enabled: false },
    { name: "two loose shapes: Ungroup is disabled", selected: [textBox, loose], enabled: false },
    { name: "control: a group: Ungroup is enabled", selected: [grouped], enabled: true },
    { name: "control: a group and a loose shape: Ungroup is enabled", selected: [grouped, loose], enabled: true },
  ];
  for (const row of rows) {
    it(row.name, () => {
      const base = editorStateFor(document);
      const state: EditorState = { ...base, currentSlideId: slideId("slide_one"), selection: { kind: "elements", slideId: slideId("slide_one"), elementIds: row.selected.map((element) => element.id) }, chrome: { ...base.chrome, propertiesPanelOpen: true, propertiesTab: "arrange" } };
      const arrangeMenu = menuEntries({ menu: "arrange", state, shortcuts: "control", hostItems: [], showAnnotations: true });
      const contextMenu = contextMenuEntries({ menu: { at: { x: 0, y: 0 }, scope: "element" }, state, shortcuts: "control" });
      for (const [where, entries] of [["Arrange menu", arrangeMenu], ["context menu", contextMenu]] as const) {
        const ungroup = entries.find((entry) => entry.kind === "item" && entry.label === "Ungroup");
        assert.ok(ungroup !== undefined && ungroup.kind === "item", `${where} offers Ungroup`);
        assert.equal(ungroup.disabled, !row.enabled, `${where}: Ungroup disabled`);
      }
      const panel = render({ state, child: createElement(PropertiesPanel) });
      const button = /<button[^>]*>Ungroup<\/button>/.exec(panel)?.[0] ?? "";
      assert.ok(button !== "", "the Arrange tab shows Ungroup");
      assert.equal(/ disabled=""/.test(button), !row.enabled, `properties panel: ${button}`);
    });
  }
});

/** The declarations of the rule whose selector is exactly `selector`. */
function ruleFor(stylesheet: string, selector: string): string {
  const start = stylesheet.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `a rule for ${selector}`);
  return stylesheet.slice(start, stylesheet.indexOf("}", start) + 1);
}

function render(options: Readonly<{ state: EditorState; child: ReactElement }>): string {
  const system = createRecordingSystem({ initial: options.state });
  const services = fixtureServices({ system });
  const gesture = { system, browser: recordingCapabilities([]), clipboardContentFor: services.clipboardContentFor, presentationHost: () => null, speakerWindow: { current: null } };
  return renderToStaticMarkup(
    createElement(
      EditorServicesContext.Provider,
      { value: services },
      createElement(EditorGestureContext.Provider, { value: gesture }, createElement(ViewPreferencesContext.Provider, { value: { showAnnotations: true, toggleAnnotations: () => undefined } }, options.child)),
    ),
  );
}

function personIdOf(text: string): Person["id"] {
  const parsed = parsePersonId(text);
  if (parsed === null) throw new Error(`not a person id: ${text}`);
  return parsed;
}
