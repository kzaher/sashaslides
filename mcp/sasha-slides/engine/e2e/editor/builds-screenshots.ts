// BUILDS AND MORPH IN THE INTEGRATED DEMO, driven as a person would and photographed: the Animate
// tab with the "Builds" sample slide's sequence (and its numbered badges), the show caught in the
// middle of a fly-in build, and the show caught in the middle of a morph between the two sample
// slides that share morph keys. Unit tests prove the keyframes; this proves the four modules
// together in a real browser.
//
//   npx tsx e2e/editor/builds-screenshots.ts <output directory>
//
// Needs the demo served on 127.0.0.1:8790 (`npx tsx build-demo.ts --serve`) and Chrome on
// 127.0.0.1:9223. The fly-in and the morph are slowed to 3 seconds through the editor's own fields
// first, so the mid-animation shots land well inside them. Every wait polls page state.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "chrome-remote-interface";
import { evaluate, screenshot, waitFor, withPage } from "./editor-session.ts";

const DEMO_ADDRESS = "http://127.0.0.1:8790/";
const BUILDS_SLIDE_INDEX = 6;
const SLOW_MILLISECONDS = 3000;

const output = process.argv[2] ?? join(tmpdir(), "sasha-engine-builds");
await mkdir(output, { recursive: true });
const report = await withPage({ address: DEMO_ADDRESS, scheme: "light", reducedMotion: false }, (client) => photograph(client));
console.log(JSON.stringify(report, null, 2));
if (report.problems.length > 0) {
  console.error(report.problems.join("\n"));
  process.exitCode = 1;
}

async function photograph(client: Client): Promise<Readonly<{ shots: readonly string[]; facts: Record<string, unknown>; problems: readonly string[] }>> {
  const problems: string[] = [];
  const shots: string[] = [];
  await waitFor(client, `document.querySelectorAll("[data-sasha-thumbnail]").length > ${BUILDS_SLIDE_INDEX + 2}`, 8000);
  await evaluate(client, `Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]).then(() => true)`);
  const thumbnails = (await evaluate(client, `[...document.querySelectorAll("[data-sasha-thumbnail]")].map((thumbnail) => thumbnail.getAttribute("data-sasha-thumbnail"))`)) as readonly string[];
  const buildsSlide = thumbnails[BUILDS_SLIDE_INDEX] ?? "";
  const morphAfterSlide = thumbnails[BUILDS_SLIDE_INDEX + 2] ?? "";

  // The morph INTO the second morph slide, slowed down.
  await clickAt({ client, selector: `[data-sasha-thumbnail="${morphAfterSlide}"]` });
  await waitFor(client, `document.querySelector('.sasha-view-canvas-stage [data-sasha-slide-id="${morphAfterSlide}"]') !== null`);
  await clickText({ client, selector: `[role="tab"]`, text: "Transition" });
  await typeNumber({ client, label: "Duration", value: SLOW_MILLISECONDS });

  // The builds slide: the Animate tab, the fly-in chosen and slowed down.
  await clickAt({ client, selector: `[data-sasha-thumbnail="${buildsSlide}"]` });
  await waitFor(client, `document.querySelector('.sasha-view-canvas-stage [data-sasha-slide-id="${buildsSlide}"]') !== null`);
  await clickText({ client, selector: `[role="tab"]`, text: "Animate" });
  await waitFor(client, `document.querySelectorAll('[aria-label="Animation sequence"] [data-step-id]').length === 4`);
  await evaluate(client, `(document.querySelectorAll('[aria-label="Animation sequence"] [data-step-id]')[1]).click(), true`);
  await waitFor(client, `document.querySelector('input[aria-label="Duration"]') !== null`);
  await typeNumber({ client, label: "Duration", value: SLOW_MILLISECONDS });
  await settleFrames(client);
  const animateShot = join(output, "animate-tab.png");
  await screenshot(client, animateShot);
  shots.push(animateShot);
  const badges = Number(await evaluate(client, `document.querySelectorAll("[data-badge-element]").length`));

  // Present from the builds slide: first click fades the title in, the second flies the card in.
  await clickText({ client, selector: `button.sasha-pill-primary`, text: "Present", trusted: true });
  await waitFor(client, `document.querySelector('[data-screen="slide"][data-slide-id="${buildsSlide}"]') !== null`, 6000);
  const hiddenAtStart = Number(await evaluate(client, `document.querySelectorAll('.sasha-presentation [data-sasha-element-id]').length`));
  // The presenter system subscribes its keys in an effect after the first paint; a key before that is dropped.
  await settleFrames(client);
  await evaluate(client, `new Promise((resolve) => setTimeout(() => resolve(true), 300))`);
  await pressRight(client);
  await waitFor(client, `document.querySelector('[data-build="1"][data-run-phase="none"]') !== null`, 3000);
  await pressRight(client);
  await waitFor(client, `document.querySelector('[data-run-phase="running"]') !== null`, 2000);
  await evaluate(client, `new Promise((resolve) => setTimeout(() => resolve(true), ${SLOW_MILLISECONDS * 0.45}))`);
  const buildShot = join(output, "presenter-mid-build.png");
  await screenshot(client, buildShot);
  shots.push(buildShot);
  const midBuild = await evaluate(client, `(() => { const root = document.querySelector("[data-screen]"); return { screen: root?.getAttribute("data-screen"), phase: root?.getAttribute("data-run-phase"), clicks: root?.getAttribute("data-build-clicks") }; })()`);

  // Finish the slide's builds (the spin follows the fly-in by itself), fly the oval out, then on to the morph pair.
  // The fly-in and the spin chained after it are one segment, so the card is done at build 2; the oval's exit is build 3.
  await waitFor(client, `document.querySelector('[data-build="2"][data-run-phase="none"]') !== null`, SLOW_MILLISECONDS + 3000);
  await pressRight(client);
  await waitFor(client, `document.querySelector('[data-build="3"][data-run-phase="none"]') !== null`, 3000);
  await pressRight(client);
  await waitFor(client, `document.querySelector('[data-screen="slide"][data-run-phase="none"]') !== null && document.querySelector('[data-slide-id="${buildsSlide}"][data-screen]') === null`, 3000);
  await pressRight(client);
  await waitFor(client, `document.querySelector('[data-screen="transition"]') !== null`, 2000);
  await evaluate(client, `new Promise((resolve) => setTimeout(() => resolve(true), ${SLOW_MILLISECONDS * 0.45}))`);
  const morphShot = join(output, "presenter-mid-morph.png");
  await screenshot(client, morphShot);
  shots.push(morphShot);
  const midMorph = await evaluate(client, `document.querySelector("[data-screen]")?.getAttribute("data-screen") ?? ""`);
  if (midMorph !== "transition") problems.push(`the morph shot was taken on "${String(midMorph)}"`);
  await waitFor(client, `document.querySelector('[data-screen="slide"][data-slide-id="${morphAfterSlide}"]') !== null`, SLOW_MILLISECONDS + 3000);
  if (badges === 0) problems.push("no animation badges on the canvas");
  return { shots, facts: { badges, hiddenAtStart, midBuild, midMorph }, problems };
}

async function pressRight(client: Client): Promise<void> {
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
}

/** A trusted mouse click at the centre of the first element matching `selector`. */
async function clickAt(options: Readonly<{ client: Client; selector: string }>): Promise<void> {
  const centre = (await evaluate(
    options.client,
    `(() => { const element = document.querySelector(${JSON.stringify(options.selector)}); if (element === null) return null; element.scrollIntoView({ block: "nearest" }); const box = element.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`,
  )) as Readonly<{ x: number; y: number }> | null;
  if (centre === null) throw new Error(`Nothing to click: ${options.selector}`);
  await options.client.Input.dispatchMouseEvent({ type: "mousePressed", x: centre.x, y: centre.y, button: "left", clickCount: 1 });
  await options.client.Input.dispatchMouseEvent({ type: "mouseReleased", x: centre.x, y: centre.y, button: "left", clickCount: 1 });
}

/** Clicks the element matching `selector` whose text is `text`: through the DOM, or as a trusted click. */
async function clickText(options: Readonly<{ client: Client; selector: string; text: string; trusted?: boolean }>): Promise<void> {
  const finder = `[...document.querySelectorAll(${JSON.stringify(options.selector)})].find((element) => element.textContent.trim() === ${JSON.stringify(options.text)})`;
  await waitFor(options.client, `${finder} !== undefined`);
  if (options.trusted !== true) {
    await evaluate(options.client, `(${finder}).click(), true`);
    return;
  }
  const box = (await evaluate(options.client, `(() => { const box = ${finder}.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`)) as Readonly<{ x: number; y: number }>;
  await options.client.Input.dispatchMouseEvent({ type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await options.client.Input.dispatchMouseEvent({ type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
}

/** Types `value` into the number field labelled `label` and commits it with Enter. */
async function typeNumber(options: Readonly<{ client: Client; label: string; value: number }>): Promise<void> {
  await waitFor(options.client, `document.querySelector('input[aria-label=${JSON.stringify(options.label)}]') !== null`);
  await evaluate(options.client, `(() => { const input = document.querySelector('input[aria-label=${JSON.stringify(options.label)}]'); input.focus(); input.select(); return true; })()`);
  await options.client.Input.insertText({ text: String(options.value) });
  await options.client.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await options.client.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
}

/** Two animation frames, so the last state change is painted before a shot. */
async function settleFrames(client: Client): Promise<void> {
  await evaluate(client, `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
}
