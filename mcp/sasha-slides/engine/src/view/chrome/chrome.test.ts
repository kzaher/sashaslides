// The editor chrome, asserted without a browser: Tidepool class names and the view's own rules
// (acceptance 3), the properties panel's points, "mixed" and locked controls (acceptance 5), the
// filmstrip's virtualisation past 40 slides (acceptance 11). The gesture handlers (acceptance 6)
// are in application/gesture-handlers.test.ts.

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ElementSnapshot } from "../../contracts/document.ts";
import type { EditorState, PropertiesTab } from "../../contracts/editor-state.ts";
import { SLIDE_ROOT_CLASS } from "../../contracts/render.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { TIDEPOOL_TOKENS, tidepoolCustomProperties } from "../../theme/tidepool-theme.ts";
import { EditorGestureContext, EditorServicesContext } from "../application/editor-services.tsx";
import { EditorShell } from "../application/editor-shell.tsx";
import { IdMinter, documentSnapshot, fixtureAssetId, fixtureDeckId, imageElement, paragraph, plainBody, run, shapeElement, slideSnapshot, textBody } from "../sample/snapshot-builders.ts";
import { createRecordingSystem, fixtureEditorState, fixtureServices, recordingCapabilities } from "../testing/editor-fixtures.ts";
import { VIEW_CLASS, viewStylesheet } from "../view-stylesheet.ts";
import { Filmstrip, VIRTUALISE_BEYOND_SLIDES, thumbnailItemHeight, visibleThumbnailRange } from "./filmstrip.tsx";
import { PropertiesPanel } from "./properties-panel.tsx";
import { MIXED_PLACEHOLDER, fontSizeEvent, lockedExplanation, textValues } from "./properties-values.ts";

const ids = new IdMinter("Chrome01");

describe("Tidepool chrome", () => {
  const document = documentSnapshot({ deckId: fixtureDeckId("deck_chrome"), title: "Chrome", slides: [slideSnapshot({ ids, elements: [shapeElement({ id: ids.next("element"), text: plainBody("Hello") })] })] });
  const markup = renderToStaticMarkup(createElement(EditorShell, { services: fixtureServices({ system: createRecordingSystem({ initial: fixtureEditorState({ document }) }) }) }));

  const classRows: readonly Readonly<{ label: string; pattern: RegExp }>[] = [
    { label: "the root is the engine root on the calm ground", pattern: new RegExp(`class="${TIDEPOOL_CLASS.root} ${TIDEPOOL_CLASS.calmGround} ${VIEW_CLASS.editor}"`) },
    { label: "the top bar is a glass panel", pattern: new RegExp(`<header class="${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.topBar}"`) },
    { label: "the toolbar is a glass panel", pattern: new RegExp(`class="${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.toolbar}"`) },
    { label: "the filmstrip is a glass panel", pattern: new RegExp(`class="${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.filmstrip}"`) },
    { label: "the properties panel is a glass panel", pattern: new RegExp(`class="${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.sidePanel}"`) },
    { label: "Present is an ink pill", pattern: new RegExp(`class="${TIDEPOOL_CLASS.primaryPill}"[^>]*>Present<`) },
    { label: "tabs are pill tabs and the active one is selected", pattern: new RegExp(`role="tab" class="${TIDEPOOL_CLASS.tab}" aria-selected="true"[^>]*>Arrange<`) },
    { label: "tools are round icon buttons", pattern: new RegExp(`class="${TIDEPOOL_CLASS.iconButton}" aria-label="Select"`) },
    { label: "the slide root carries the slide root class and resets inheritance", pattern: new RegExp(`class="${SLIDE_ROOT_CLASS}" style="all:initial`) },
  ];
  for (const row of classRows) {
    it(row.label, () => assert.match(markup, row.pattern));
  }

  const viewRules = viewStylesheet();
  const defined = new Set(["light", "dark"].flatMap((scheme) => tidepoolCustomProperties({ tokens: TIDEPOOL_TOKENS, scheme: scheme === "light" ? "light" : "dark" }).map((property) => property.name)));

  it("the view's own rules contain no colour literal", () => {
    assert.equal(/#[0-9a-f]{3,8}\b/i.test(viewRules), false, "hexadecimal colour in the view's rules");
    assert.equal(/rgba?\(|hsla?\(/i.test(viewRules), false, "functional colour in the view's rules");
    assert.equal(/:\s*(white|black|red|blue|green|grey|gray)\b/i.test(viewRules), false, "named colour in the view's rules");
  });

  it("the view's own rules read only --sasha- custom properties, every one of them defined", () => {
    const read = [...viewRules.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1] ?? "");
    assert.ok(read.length > 50);
    for (const name of read) {
      assert.ok(name.startsWith("--sasha-"), `${name} is not a Tidepool property`);
      assert.ok(defined.has(name.slice("--sasha-".length)), `${name} is read but never defined`);
    }
  });

  it("the view's own rules never blur what is behind them", () => {
    assert.equal(/backdrop-filter/.test(viewRules), false);
  });

  it("every animation and transition in the view's rules is gated on prefers-reduced-motion: no-preference", () => {
    const withoutGated = viewRules.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}/g, "");
    assert.equal(/animation:|transition:/.test(withoutGated), false);
  });
});

describe("properties panel", () => {
  const eighteenPoints = shapeElement({ id: ids.next("element"), text: textBody([paragraph([run("Eighteen points", { fontSize: 32 })])]) });
  const twentyTwoPoints = shapeElement({ id: ids.next("element"), text: textBody([paragraph([run("Larger", { fontSize: 40 })])]) });
  const fromTheFuture = shapeElement({ id: ids.next("element"), text: textBody([paragraph([run("Kept", { fontSize: 32 })])]), unsupportedKeys: ["text", "fill"] });
  const slide = slideSnapshot({ ids, elements: [eighteenPoints, twentyTwoPoints, fromTheFuture] });
  const document = documentSnapshot({ deckId: fixtureDeckId("deck_panel"), title: "Panel", slides: [slide] });
  const stateWith = (elements: readonly ElementSnapshot[], tab: PropertiesTab): EditorState => {
    const state = fixtureEditorState({ document });
    return { ...state, currentSlideId: slide.id, selection: { kind: "elements", slideId: slide.id, elementIds: elements.map((element) => element.id) }, ui: { ...state.ui, propertiesTab: tab } };
  };

  it("an 18 point run (32 slide units) shows 18", () => {
    const state = stateWith([eighteenPoints], "text");
    assert.deepEqual(textValues(state).fontSizePoints, { kind: "value", value: 18 });
    assert.match(panelMarkup(state), /aria-label="Size" value="18"/);
  });

  const editRows: readonly Readonly<{ typed: string; units: number | null }>[] = [
    { typed: "24", units: 42.67 },
    { typed: "18", units: 32 },
    { typed: "nonsense", units: null },
  ];
  for (const row of editRows) {
    it(`typing ${row.typed} into the size field dispatches ${row.units === null ? "nothing" : `${row.units} units`}`, () => {
      const event = fontSizeEvent(row.typed);
      if (row.units === null) {
        assert.equal(event, null);
        return;
      }
      assert.deepEqual(event, { kind: "runStyleRequested", patch: { fontSize: row.units }, clear: [] });
    });
  }

  it("a push transition shows its direction, and a zoom its mode, on the transition tab", () => {
    const withTransition = (transition: (typeof slide)["transition"]): EditorState => {
      const state = stateWith([], "transition");
      const changed = { ...slide, transition };
      return { ...state, document: { ...state.document, slides: [changed] } };
    };
    const push = panelMarkup(withTransition({ kind: "builtin", effect: { effect: "push", direction: "fromLeft" }, durationMilliseconds: 400, easing: "easeOut" }));
    assert.match(push, /aria-label="Direction"[^>]*>[\s\S]*?<option value="fromLeft" selected="">From the left<\/option>/);
    const zoom = panelMarkup(withTransition({ kind: "builtin", effect: { effect: "zoom", mode: "out" }, durationMilliseconds: 400, easing: "easeOut" }));
    assert.match(zoom, /aria-label="Mode"[^>]*>[\s\S]*?<option value="out" selected="">Zoom out<\/option>/);
    assert.doesNotMatch(zoom, /aria-label="Direction"/);
  });

  it("one selected image shows its crop in percent on the effects tab; two images show none", () => {
    const cropped = { ...imageElement({ id: ids.next("element"), assetId: fixtureAssetId("crop"), box: { x: 0, y: 0, width: 200, height: 100 } }), crop: { left: 0.25, top: 0, right: 0.1, bottom: 0 } };
    const other = imageElement({ id: ids.next("element"), assetId: fixtureAssetId("other"), box: { x: 300, y: 0, width: 200, height: 100 } });
    const withImages = (selected: readonly ElementSnapshot[]): EditorState => {
      const state = stateWith(selected, "effects");
      return { ...state, document: { ...state.document, slides: [{ ...slide, elements: [...slide.elements, cropped, other] }] } };
    };
    const one = panelMarkup(withImages([cropped]));
    assert.match(one, /aria-label="Crop left" value="25"/);
    assert.match(one, /aria-label="Crop right" value="10"/);
    assert.doesNotMatch(panelMarkup(withImages([cropped, other])), /Crop left/);
  });

  it("the text tab edits first-line indent, paragraph direction and wrapping", () => {
    const markup = panelMarkup(stateWith([eighteenPoints], "text"));
    assert.match(markup, /aria-label="First line indent" value="0"/);
    assert.match(markup, /aria-label="Direction"[^>]*>[\s\S]*?<option value="leftToRight" selected="">Left to right<\/option>/);
    assert.match(markup, /role="radiogroup" aria-label="Wrap text"/);
  });

  it("a selection whose runs differ shows mixed, an empty field with a mixed placeholder", () => {
    const state = stateWith([eighteenPoints, twentyTwoPoints], "text");
    assert.deepEqual(textValues(state).fontSizePoints, { kind: "mixed" });
    assert.match(panelMarkup(state), new RegExp(`placeholder="${MIXED_PLACEHOLDER}" aria-label="Size" value=""`));
  });

  const lockRows: readonly Readonly<{ label: string; elements: readonly ElementSnapshot[]; tab: PropertiesTab; locked: boolean }>[] = [
    { label: "text controls of an element with an unsupported text value are disabled", elements: [fromTheFuture], tab: "text", locked: true },
    { label: "fill controls of an element with an unsupported fill are disabled", elements: [fromTheFuture], tab: "fill", locked: true },
    { label: "the same controls on an ordinary element are enabled", elements: [eighteenPoints], tab: "text", locked: false },
  ];
  for (const row of lockRows) {
    it(row.label, () => {
      const markup = panelMarkup(stateWith(row.elements, row.tab));
      const explanation = lockedExplanation({ elements: row.elements, control: row.tab === "fill" ? "fill" : "text" });
      assert.equal(explanation !== null, row.locked);
      if (row.locked) {
        assert.match(markup, /Made with a newer version of Sasha/);
        assert.match(markup, /disabled=""/);
      } else {
        assert.doesNotMatch(markup, /Made with a newer version of Sasha/);
        assert.doesNotMatch(markup, /aria-label="Size"[^>]*disabled/);
      }
    });
  }
});

describe("filmstrip", () => {
  const rows: readonly Readonly<{ slides: number; mounted: (count: number) => boolean; label: string }>[] = [
    { slides: 12, mounted: (count) => count === 12, label: "12 slides: every thumbnail is mounted" },
    { slides: VIRTUALISE_BEYOND_SLIDES, mounted: (count) => count === VIRTUALISE_BEYOND_SLIDES, label: "40 slides: every thumbnail is mounted" },
    { slides: 41, mounted: (count) => count < 20, label: "41 slides: only the visible thumbnails are mounted" },
    { slides: 200, mounted: (count) => count < 20, label: "200 slides: only the visible thumbnails are mounted" },
  ];
  for (const row of rows) {
    it(row.label, () => {
      const slides = Array.from({ length: row.slides }, (_, index) => slideSnapshot({ ids, elements: [shapeElement({ id: ids.next("element"), text: plainBody(`Slide ${index + 1}`) })] }));
      const document = documentSnapshot({ deckId: fixtureDeckId("deck_filmstrip"), title: "Filmstrip", slides });
      const markup = withServices(fixtureEditorState({ document }), createElement(Filmstrip));
      const mounted = markup.match(/data-sasha-thumbnail="/g)?.length ?? 0;
      assert.ok(row.mounted(mounted), `${mounted} thumbnails mounted for ${row.slides} slides`);
    });
  }

  it("the visible range follows the scroll position", () => {
    const itemHeight = thumbnailItemHeight(720);
    const top = visibleThumbnailRange({ slideCount: 100, scrollTop: 0, viewportHeight: 800, itemHeight });
    const further = visibleThumbnailRange({ slideCount: 100, scrollTop: itemHeight * 50, viewportHeight: 800, itemHeight });
    assert.equal(top.first, 0);
    assert.ok(further.first >= 45 && further.first <= 50 && further.last < 70, JSON.stringify(further));
  });
});

function panelMarkup(state: EditorState): string {
  return withServices(state, createElement(PropertiesPanel));
}

function withServices(state: EditorState, child: ReactElement): string {
  const system = createRecordingSystem({ initial: state });
  const services = fixtureServices({ system });
  const gesture = { system, browser: recordingCapabilities([]), clipboardContentFor: services.clipboardContentFor, presentationHost: () => null, speakerWindow: { current: null } };
  return renderToStaticMarkup(createElement(EditorServicesContext.Provider, { value: services }, createElement(EditorGestureContext.Provider, { value: gesture }, child)));
}
