// THE INTEGRATED DEMO, DRIVEN AS A PERSON WOULD: the real model, state, view and presenter served by
// `build-demo.ts --serve`, edited through the real chrome, then photographed. The chrome harness
// (screenshots.ts) proves the look on a stand-in reducer; this proves the four modules together.
//
//   npx tsx e2e/editor/demo-screenshots.ts <output directory>
//
// For each colour scheme it opens the demo at 1440 x 900, goes to the "Styles" slide, gives that
// slide a linear gradient background in the Slide tab, selects the gradient rounded rectangle on the
// canvas with a real (trusted) pointer click and gives it a border in the Border tab -- so the shot
// shows a bordered rounded shape, a gradient background, a text box, the sample image, a selection
// with handles and the properties panel. Then it gives the next slide a 3 second Push, presents
// from the Styles slide, presses the right arrow and photographs the show mid-transition.
//
// Needs the demo served on 127.0.0.1:8790 (runner on localhost:8791) and Chrome on 127.0.0.1:9223.
// Every wait polls page state with a few seconds' budget; the whole run is under a minute.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Tab } from "../shared/chrome-session.ts";
import { withPage } from "./editor-session.ts";

const DEMO_ADDRESS = "http://127.0.0.1:8790/";
const STYLES_SLIDE_INDEX = 2;
const PUSH_MILLISECONDS = 3000;

const output = process.argv[2] ?? join(tmpdir(), "sasha-engine-demo");
await mkdir(output, { recursive: true });

const report: Record<string, unknown>[] = [];
for (const scheme of ["light", "dark"] as const) {
  report.push(await withPage({ address: DEMO_ADDRESS, scheme, reducedMotion: false }, (tab) => photographScheme({ tab, scheme })));
}
console.log(JSON.stringify(report, null, 2));
const problems = report.flatMap((entry) => (Array.isArray(entry["problems"]) ? entry["problems"].map(String) : []));
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
}

async function photographScheme(options: Readonly<{ tab: Tab; scheme: "light" | "dark" }>): Promise<Record<string, unknown>> {
  const { tab, scheme } = options;
  const problems: string[] = [];
  await tab.waitFor(`document.querySelectorAll("[data-sasha-thumbnail]").length > ${STYLES_SLIDE_INDEX + 1}`, 8000);
  await tab.evaluate(`Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]).then(() => true)`);
  const thumbnails = (await tab.evaluate(`[...document.querySelectorAll("[data-sasha-thumbnail]")].map((thumbnail) => thumbnail.getAttribute("data-sasha-thumbnail"))`)) as readonly string[];
  const stylesSlide = thumbnails[STYLES_SLIDE_INDEX] ?? "";
  const nextSlide = thumbnails[STYLES_SLIDE_INDEX + 1] ?? "";

  // The next slide gets a slow Push, so the show can be photographed mid-transition.
  await clickAt({ tab, selector: `[data-sasha-thumbnail="${nextSlide}"]` });
  await tab.waitFor(`document.querySelector('[data-sasha-slide-id="${nextSlide}"]') !== null`, 4000);
  await clickText({ tab, selector: `[role="tab"]`, text: "Transition" });
  await chooseOption({ tab, label: "Transition", value: "push" });
  await tab.waitFor(`document.querySelector('input[aria-label="Duration"]') !== null`, 4000);
  await typeNumber({ tab, label: "Duration", value: PUSH_MILLISECONDS });

  // The Styles slide: a gradient background, then the rounded gradient rectangle selected and bordered.
  await clickAt({ tab, selector: `[data-sasha-thumbnail="${stylesSlide}"]` });
  await tab.waitFor(`document.querySelector('[data-sasha-slide-id="${stylesSlide}"]') !== null`, 4000);
  await clickText({ tab, selector: `[role="tab"]`, text: "Slide" });
  await clickText({ tab, selector: `[role="radiogroup"][aria-label="Fill kind"] [role="radio"]`, text: "Linear" });
  await clickAt({ tab, selector: `[data-sasha-element-id]`, containingText: "Gradient, corners, shadow" });
  await tab.waitFor(`document.querySelectorAll("[data-sasha-handle]").length > 0`, 4000);
  await clickText({ tab, selector: `[role="tab"]`, text: "Border" });
  await clickText({ tab, selector: `[role="radiogroup"][aria-label="Border kind"] [role="radio"]`, text: "All sides" });
  await settleFrames(tab);
  const editorShot = join(output, `demo-editor-${scheme}.png`);
  await tab.screenshot(editorShot);
  const facts = (await tab.evaluate(
    `(() => {
      const slide = document.querySelector('.sasha-view-canvas-stage [data-sasha-slide-id]');
      const selected = [...document.querySelectorAll('[data-sasha-element-id]')].find((element) => element.textContent.includes("Gradient, corners, shadow"));
      const leaf = selected?.firstElementChild ?? selected;
      return {
        slideBackground: slide === null ? "" : getComputedStyle(slide).backgroundImage.slice(0, 40),
        selectedBorder: leaf === null || leaf === undefined ? "" : getComputedStyle(leaf).borderTopStyle + " " + getComputedStyle(leaf).borderTopWidth,
        selectedRadius: leaf === null || leaf === undefined ? "" : getComputedStyle(leaf).borderTopLeftRadius,
        handles: document.querySelectorAll("[data-sasha-handle]").length,
        blurredChrome: [...document.querySelectorAll(".sasha-panel, .sasha-popover, .sasha-dialog, .sasha-card")].filter((element) => getComputedStyle(element).backdropFilter !== "none").length,
        primaryPillText: (() => { const pill = document.querySelector(".sasha-pill-primary"); return pill === null ? "" : getComputedStyle(pill).color + " on " + getComputedStyle(pill).backgroundColor; })(),
        wash: getComputedStyle(document.querySelector(".sasha-calm-ground"), "::before").position + " " + getComputedStyle(document.querySelector(".sasha-calm-ground"), "::before").animationName,
      };
    })()`,
  )) as Record<string, unknown>;
  if (!String(facts["slideBackground"]).startsWith("linear-gradient")) problems.push(`${scheme}: the slide background is not a gradient (${String(facts["slideBackground"])})`);
  if (Number(facts["handles"]) === 0) problems.push(`${scheme}: no selection handles`);
  if (Number(facts["blurredChrome"]) > 0) problems.push(`${scheme}: chrome with a backdrop filter`);

  // Present (a trusted click, so full screen is allowed), then the right arrow, then the shot mid-Push.
  await clickText({ tab, selector: `button.sasha-pill-primary`, text: "Present", trusted: true });
  await tab.waitFor(`document.querySelector('[data-screen="slide"][data-slide-id="${stylesSlide}"]') !== null`, 6000);
  await settleFrames(tab);
  await tab.press({ key: "ArrowRight", code: "ArrowRight", keyCode: 39 });
  await tab.waitFor(`document.querySelector('[data-screen="transition"]') !== null`, 3000);
  await tab.evaluate(`new Promise((resolve) => setTimeout(() => resolve(true), ${PUSH_MILLISECONDS / 2}))`);
  const presenterShot = join(output, `demo-presenter-mid-transition-${scheme}.png`);
  await tab.screenshot(presenterShot);
  const midScreen = await tab.evaluate(`document.querySelector("[data-screen]")?.getAttribute("data-screen") ?? ""`);
  if (midScreen !== "transition") problems.push(`${scheme}: the presenter shot was taken on "${String(midScreen)}", not mid-transition`);
  await tab.waitFor(`document.querySelector('[data-screen="slide"][data-slide-id="${nextSlide}"]') !== null`, PUSH_MILLISECONDS + 3000);
  return { scheme, editorShot, presenterShot, facts, midScreen, problems };
}

/** A trusted mouse click at the centre of the first element matching `selector` (and containing `containingText`). */
async function clickAt(options: Readonly<{ tab: Tab; selector: string; containingText?: string }>): Promise<void> {
  const centre = (await options.tab.evaluate(
    `(() => {
      const candidates = [...document.querySelectorAll(${JSON.stringify(options.selector)})];
      const element = ${options.containingText === undefined ? "candidates[0]" : `candidates.filter((candidate) => candidate.textContent.includes(${JSON.stringify(options.containingText)})).at(-1)`};
      if (element === undefined) return null;
      element.scrollIntoView({ block: "nearest" });
      const box = element.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`,
  )) as Readonly<{ x: number; y: number }> | null;
  if (centre === null) throw new Error(`Nothing to click: ${options.selector} ${options.containingText ?? ""}`);
  await options.tab.click({ x: centre.x, y: centre.y });
}

/** Clicks the element matching `selector` whose text is `text`: through the DOM, or as a trusted click. */
async function clickText(options: Readonly<{ tab: Tab; selector: string; text: string; trusted?: boolean }>): Promise<void> {
  const finder = `[...document.querySelectorAll(${JSON.stringify(options.selector)})].find((element) => element.textContent.trim() === ${JSON.stringify(options.text)})`;
  await options.tab.waitFor(`${finder} !== undefined`, 4000);
  if (options.trusted === true) {
    const box = (await options.tab.evaluate(`(() => { const box = ${finder}.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`)) as Readonly<{ x: number; y: number }>;
    await options.tab.click({ x: box.x, y: box.y });
    return;
  }
  await options.tab.evaluate(`(${finder}).click(), true`);
}

/** Chooses `value` in the select labelled `label`, as React sees a person's choice. */
async function chooseOption(options: Readonly<{ tab: Tab; label: string; value: string }>): Promise<void> {
  const select = `document.querySelector('select[aria-label=${JSON.stringify(options.label)}]')`;
  await options.tab.waitFor(`${select} !== null`, 4000);
  await options.tab.evaluate(
    `(() => {
      const select = ${select};
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, ${JSON.stringify(options.value)});
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
  );
}

/** Types `value` into the number field labelled `label` and commits it with Enter. */
async function typeNumber(options: Readonly<{ tab: Tab; label: string; value: number }>): Promise<void> {
  await options.tab.evaluate(`(() => { const input = document.querySelector('input[aria-label=${JSON.stringify(options.label)}]'); input.focus(); input.select(); return true; })()`);
  await options.tab.insertText(String(options.value));
  await options.tab.press({ key: "Enter", code: "Enter", keyCode: 13 });
}

/** Two animation frames, so the last state change is painted before a shot. */
async function settleFrames(tab: Tab): Promise<void> {
  await tab.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
}
