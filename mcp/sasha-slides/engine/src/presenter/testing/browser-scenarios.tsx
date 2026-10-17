// THE PRESENTER'S CHROME PAGES, one bundle, chosen by `?scenario=`; e2e/presenter/presenter-e2e.ts
// serves it on the editor's site, the runner on a second site, and drives it over the debugging
// protocol.
//
//   suite    in-browser checks a node test cannot make: the real runner frame's attributes, no
//            frame for a show of built-ins, an in-page built-in on the real stage, the speaker view
//            rendered into a provided window with requestFullscreen and window.open spied, and
//            TransitionPreview's onEnded and restart. Results land in `window.sashaSuite`.
//   show     the end-to-end show: ink wipe (a script) -> push (a built-in bundled as a script) ->
//            a busy loop; `window.sashaHeartbeat` and `window.sashaPointerMoves` count the host's
//            own work so the driver can prove the host stays responsive while the runner spins.
//   speaker  the show with its speaker view in a frame in front, for a screenshot.
//
// It is test scaffolding, not shipped: it uses the stand-in toolkit and renderer from this folder.

import "../../platform/explicit-resource-management.ts";
import { createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { asyncScheduler, fromEvent, map, NEVER, startWith } from "rxjs";
import type { AssetStore } from "../../contracts/document-store.ts";
import type { DocumentSnapshot } from "../../contracts/document.ts";
import { newSessionPrefix, type SlideId } from "../../contracts/ids.ts";
import type { PresenterDependencies } from "../../contracts/presenter.ts";
import { tidepoolStylesheet } from "../../theme/tidepool-stylesheet.ts";
import { TIDEPOOL_TOKENS } from "../../theme/tidepool-theme.ts";
import { INK_WIPE_EXAMPLE_SCRIPT } from "./ink-wipe.ts";
import { Presentation, TransitionPreview } from "../index.ts";
import { renderSlideMarkup } from "../../view/render/slide-markup.tsx";
import { StaticSlide } from "../../view/render/static-slide.tsx";
import { builtinTransition, fixtureDocument, scriptedTransition, slideIdOf, type FixtureElement } from "./document-fixture.ts";
import { testRxFeedbackToolkit } from "./rxfeedback-toolkit.ts";

type SuiteResult = Readonly<{ name: string; ok: boolean; detail: string }>;

const parameters = new URLSearchParams(location.search);
const runnerAddress = parameters.get("runner") ?? "about:blank";
Reflect.set(window, "sashaHeartbeat", 0);
Reflect.set(window, "sashaPointerMoves", 0);
setInterval(() => Reflect.set(window, "sashaHeartbeat", Number(Reflect.get(window, "sashaHeartbeat")) + 1), 50);
window.addEventListener("pointermove", () => Reflect.set(window, "sashaPointerMoves", Number(Reflect.get(window, "sashaPointerMoves")) + 1), { capture: true });

const style = document.createElement("style");
style.textContent = tidepoolStylesheet(TIDEPOOL_TOKENS);
document.head.appendChild(style);

void start(parameters.get("scenario") ?? "suite");

async function start(scenario: string): Promise<void> {
  const container = document.getElementById("application");
  if (container === null) throw new Error("The page has no #application element.");
  switch (scenario) {
    case "show":
      createRoot(container).render(presentationOf({ document: await showDeck(), start: "slide_a", speakerWindow: null }));
      return;
    case "speaker": {
      const holder = document.createElement("iframe");
      holder.id = "speaker-window";
      Object.assign(holder.style, { position: "fixed", inset: "0", width: "100%", height: "100%", border: "0", zIndex: "100" });
      document.body.appendChild(holder);
      const speakerWindow = holder.contentWindow;
      createRoot(container).render(presentationOf({ document: await showDeck(), start: "slide_b", speakerWindow }));
      return;
    }
    case "suite":
      Reflect.set(window, "sashaSuite", { done: false, results: [] });
      Reflect.set(window, "sashaSuite", { done: true, results: await runSuite(container) });
      return;
    default:
      throw new Error(`Unknown scenario ${scenario}`);
  }
}

function presentationOf(options: Readonly<{ document: DocumentSnapshot; start: string; speakerWindow: Window | null; onSpeakerViewRequested?: () => Window | null }>): ReactElement {
  return createElement(Presentation, {
    dependencies: dependencies(),
    document: options.document,
    startSlideId: slideIdOf(options.start),
    speakerWindow: options.speakerWindow,
    onSpeakerViewRequested: options.onSpeakerViewRequested ?? (() => null),
    onExit: (lastSlideId: SlideId | null) => Reflect.set(window, "sashaExitedOn", lastSlideId),
  });
}

function dependencies(): PresenterDependencies {
  return {
    rxFeedback: testRxFeedbackToolkit,
    StaticSlide,
    renderSlideMarkup,
    assetStore: NO_ASSETS,
    fontFiles: () => Promise.resolve([]),
    runnerAddress,
    scheduler: asyncScheduler,
    now: () => Date.now(),
    sessionPrefix: newSessionPrefix(Math.random),
    prefersReducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    pageVisibility: fromEvent(document, "visibilitychange").pipe(
      map(() => document.visibilityState === "visible"),
      startWith(document.visibilityState === "visible"),
    ),
    reportError: (error, context) => console.error(context, error),
  };
}

const NO_ASSETS: AssetStore = {
  put: () => Promise.reject(new Error("The demo stores no assets.")),
  addressFor: () => null,
  available: NEVER,
  copyBytesOf: () => Promise.resolve(null),
};

const TITLE: FixtureElement = { id: "title_box", morphKey: "title", frame: { x: 140, y: 250, width: 1000, height: 220 }, fill: "#c7f0fb", text: "" };

function card(options: Readonly<{ text: string; fill: string; x?: number; rotation?: number }>): FixtureElement {
  return { ...TITLE, frame: { x: options.x ?? 140, y: 250, width: 1000, height: 220, rotation: options.rotation ?? 0 }, fill: options.fill, text: options.text };
}

async function showDeck(): Promise<DocumentSnapshot> {
  const pushScript = await (await fetch("builtin-push-script.js")).text();
  return fixtureDocument({
    slides: [
      { id: "slide_a", background: "#1c2333", elements: [card({ text: "One: before the ink", fill: "#f6d4ec" })], notes: "Open with the question the deck answers." },
      { id: "slide_b", background: "#eef1f6", transition: scriptedTransition("script_ink", 2400), elements: [card({ text: "Two: revealed by ink", fill: "#c7f0fb" })], notes: "The ink wipe ran in the sandbox." },
      { id: "slide_c", background: "#4338ca", transition: scriptedTransition("script_push", 1200, { direction: "fromRight", easing: "ease-in-out" }), elements: [card({ text: "Three: pushed by the runner", fill: "#d4f5e2" })] },
      { id: "slide_d", background: "#0e7490", transition: scriptedTransition("script_busy", 6000), elements: [card({ text: "Four: after a stall", fill: "#fde68a" })] },
      { id: "slide_e", background: "#eef1f6", elements: [card({ text: "Five", fill: "#f6d4ec" })] },
    ],
    scripts: [
      { id: "script_ink", script: INK_WIPE_EXAMPLE_SCRIPT, approved: true },
      { id: "script_push", script: pushScript, approved: true },
      { id: "script_busy", script: "sashaTransition.define({ name: 'Busy', run() { for (;;) {} } });", approved: true },
    ],
  });
}

// ------------------------------------------------------------------------------------------------
// The suite
// ------------------------------------------------------------------------------------------------

async function runSuite(container: HTMLElement): Promise<readonly SuiteResult[]> {
  const checks: readonly Readonly<{ name: string; run: (root: Root) => Promise<string> }>[] = [
    { name: "the runner frame has exactly the sandbox attributes", run: runnerFrameAttributes },
    { name: "a show of built-ins never creates a runner frame", run: builtinsCreateNoFrame },
    { name: "an in-page built-in plays on the real stage and lands on the incoming slide", run: inPageBuiltin },
    { name: "never calls requestFullscreen or window.open; the speaker view renders into the given window", run: speakerViewIntoGivenWindow },
    { name: "TransitionPreview plays, calls onEnded, and restarts when the generation changes", run: transitionPreviewRestarts },
  ];
  const results: SuiteResult[] = [];
  for (const check of checks) {
    const host = document.createElement("div");
    container.appendChild(host);
    const root = createRoot(host);
    try {
      results.push({ name: check.name, ok: true, detail: await check.run(root) });
    } catch (error) {
      results.push({ name: check.name, ok: false, detail: String(error) });
    } finally {
      root.unmount();
      host.remove();
    }
  }
  return results;
}

async function runnerFrameAttributes(root: Root): Promise<string> {
  root.render(presentationOf({ document: await showDeck(), start: "slide_a", speakerWindow: null }));
  const frame = await waitFor(() => document.querySelector<HTMLIFrameElement>("iframe.sasha-runner-frame"), "a runner frame");
  const attributes = Object.fromEntries([...frame.attributes].map((attribute) => [attribute.name, attribute.value]));
  expect(frame.getAttribute("sandbox") === "allow-scripts", `sandbox is ${JSON.stringify(frame.getAttribute("sandbox"))}`);
  expect(!frame.sandbox.contains("allow-same-origin"), "allow-same-origin is present");
  expect(frame.hasAttribute("inert"), "inert is missing");
  expect(frame.getAttribute("allow") === "", `allow is ${JSON.stringify(frame.getAttribute("allow"))}`);
  expect(frame.getAttribute("referrerpolicy") === "no-referrer", "referrerpolicy is not no-referrer");
  return JSON.stringify(attributes);
}

async function builtinsCreateNoFrame(root: Root): Promise<string> {
  const deck = fixtureDocument({
    slides: [
      { id: "slide_a", background: "#eef1f6", elements: [card({ text: "A", fill: "#c7f0fb" })] },
      { id: "slide_b", background: "#eef1f6", transition: builtinTransition({ effect: "fade" }, 200), elements: [card({ text: "B", fill: "#f6d4ec" })] },
      { id: "slide_c", background: "#eef1f6", transition: builtinTransition({ effect: "zoom", mode: "in" }, 200), elements: [card({ text: "C", fill: "#d4f5e2" })] },
    ],
  });
  root.render(presentationOf({ document: deck, start: "slide_a", speakerWindow: null }));
  await waitFor(() => document.querySelector('[data-screen="slide"]'), "the first slide");
  for (const expected of ["slide_b", "slide_c"]) {
    press(window, "ArrowRight");
    await waitFor(() => document.querySelector(`[data-screen="slide"][data-slide-id="${expected}"]`), `slide ${expected}`);
  }
  const frames = document.querySelectorAll("iframe").length;
  expect(frames === 0, `${frames} frames exist`);
  return "no frames after two built-in transitions";
}

async function inPageBuiltin(root: Root): Promise<string> {
  const deck = fixtureDocument({
    slides: [
      { id: "slide_a", background: "#1c2333", elements: [card({ text: "A", fill: "#c7f0fb" })] },
      { id: "slide_b", background: "#eef1f6", transition: builtinTransition({ effect: "push", direction: "fromRight" }, 600), elements: [card({ text: "B", fill: "#f6d4ec" })] },
    ],
  });
  root.render(presentationOf({ document: deck, start: "slide_a", speakerWindow: null }));
  await waitFor(() => document.querySelector('[data-screen="slide"]'), "the first slide");
  press(window, "ArrowRight");
  const stage = await waitFor(() => document.querySelector(".sasha-transition-stage"), "the in-page stage");
  const animations = stage.getAnimations({ subtree: true }).length;
  expect(animations === 2, `${animations} animations on the stage, expected the incoming and outgoing push`);
  await waitFor(() => document.querySelector('[data-screen="slide"][data-slide-id="slide_b"]'), "the incoming slide after the push");
  return `${animations} animations, then slide_b`;
}

async function speakerViewIntoGivenWindow(root: Root): Promise<string> {
  const calls = { fullscreen: 0, open: 0, requests: 0 };
  const originalFullscreen = Element.prototype.requestFullscreen;
  const originalOpen = window.open;
  Element.prototype.requestFullscreen = () => {
    calls.fullscreen += 1;
    return Promise.resolve();
  };
  window.open = () => {
    calls.open += 1;
    return null;
  };
  const holder = document.createElement("iframe");
  document.body.appendChild(holder);
  try {
    const speakerWindow = holder.contentWindow;
    if (speakerWindow === null) throw new Error("no speaker window");
    const deck = await showDeck();
    // No window at the start: the speaker view button asks the caller, inside its click, and the
    // presenter renders into the window the caller returns.
    root.render(
      presentationOf({
        document: deck,
        start: "slide_a",
        speakerWindow: null,
        onSpeakerViewRequested: () => {
          calls.requests += 1;
          return speakerWindow;
        },
      }),
    );
    const requestButton = await waitFor(() => [...document.querySelectorAll("button")].find((button) => button.textContent === "Speaker view") ?? null, "the speaker view button");
    requestButton.click();
    expect(calls.requests === 1, `${calls.requests} speaker view requests after one click`);
    const speakerDocument = speakerWindow.document;
    const notes = await waitFor(() => speakerDocument.querySelector("[data-speaker-notes]"), "speaker notes in the given window");
    expect(notes.textContent === "Open with the question the deck answers.", `notes read ${JSON.stringify(notes.textContent)}`);
    await waitFor(() => speakerDocument.querySelector('[aria-label="Next slide"] [data-slide-id="slide_b"]'), "the next slide preview");
    const elapsed = speakerDocument.querySelector('[data-timer="elapsed"]')?.textContent ?? "";
    const clock = speakerDocument.querySelector('[data-timer="clock"]')?.textContent ?? "";
    expect(/^\d+:\d\d$/.test(elapsed), `elapsed timer reads ${JSON.stringify(elapsed)}`);
    expect(clock.length > 0, "the clock is empty");
    press(speakerWindow, "ArrowRight");
    await waitFor(() => document.querySelector('[data-slide-id="slide_b"][data-screen]'), "navigation from a key in the speaker window");
    await waitFor(() => (speakerDocument.querySelector("[data-speaker-notes]")?.textContent === "The ink wipe ran in the sandbox." ? true : null), "the notes of the new slide");
    const speakerButton = [...document.querySelectorAll("button")].find((button) => button.textContent === "Speaker view");
    speakerButton?.click();
    expect(calls.requests === 1, `${calls.requests} speaker view requests: a second click while the window is open only focuses it`);
    expect(calls.fullscreen === 0 && calls.open === 0, `requestFullscreen ${calls.fullscreen} and window.open ${calls.open} calls`);
    return `requested once, then notes, next slide, elapsed ${elapsed}, clock ${clock}; no fullscreen or open calls`;
  } finally {
    Element.prototype.requestFullscreen = originalFullscreen;
    window.open = originalOpen;
    holder.remove();
  }
}

async function transitionPreviewRestarts(root: Root): Promise<string> {
  const deck = fixtureDocument({
    slides: [
      { id: "slide_a", background: "#1c2333", elements: [card({ text: "A", fill: "#c7f0fb" })] },
      { id: "slide_b", background: "#eef1f6", transition: builtinTransition({ effect: "fade" }, 400), elements: [card({ text: "B", fill: "#f6d4ec" })] },
    ],
  });
  let ended = 0;
  let sawRunning = 0;
  const render = (generation: number): void =>
    root.render(
      createElement(TransitionPreview, {
        dependencies: dependencies(),
        document: deck,
        slideId: slideIdOf("slide_b"),
        generation,
        width: 320,
        onEnded: () => {
          ended += 1;
        },
      }),
    );
  for (const generation of [1, 2]) {
    render(generation);
    await waitFor(() => {
      if (document.querySelector('.sasha-transition-preview[data-run-phase="running"] .sasha-transition-stage') !== null) sawRunning = Math.max(sawRunning, generation);
      return ended >= generation ? true : null;
    }, `onEnded for generation ${generation}`);
  }
  expect(ended === 2, `onEnded called ${ended} times`);
  expect(sawRunning === 2, "the second generation never showed a running stage");
  const box = document.querySelector<HTMLElement>(".sasha-transition-preview");
  expect(box !== null && Math.round(box.getBoundingClientRect().height) === 180, "the preview box is not 320 x 180");
  return "onEnded once per generation, a running stage each time, 320 x 180 box";
}

function press(target: Window, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
}

function expect(condition: boolean, problem: string): void {
  if (!condition) throw new Error(problem);
}

async function waitFor<TValue>(probe: () => TValue | null, what: string): Promise<TValue> {
  const deadline = performance.now() + 4000;
  for (;;) {
    const value = probe();
    if (value !== null) return value;
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
