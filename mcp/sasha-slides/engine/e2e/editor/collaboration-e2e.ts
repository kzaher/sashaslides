// ACCEPTANCE 6 AND 15 IN CHROME (SPEC.md 21.9 and 21.11): the integrated demo, driven with real
// (trusted) input over the DevTools Protocol, photographed, and checked.
//
//   npm run -s build:demo
//   npx tsx e2e/editor/collaboration-e2e.ts <output directory>
//
//  1. Liquid glass: one editor in each colour scheme; the panels carry the backdrop blur while idle.
//  2. Pill groups: with an element selected and the Arrange tab focused, ArrowRight moves to the
//     Fill tab and leaves the element exactly where it was (no nudge).
//  3. Presence: the two-editor page; Grace selects an element and hovers her canvas, and Ada's
//     editor shows her labelled cursor, her selection outline, her avatar on the filmstrip and in
//     the top bar, whose list says which slide she is on.
//  4. A comment with a pen annotation and a mention: in Ada's editor, primary+Alt+M on an element,
//     Draw, a stroke over the element, "@Gr" (the members list opens, photographed), Enter, submit;
//     the thread shows with its marking on the slide.
//  5. The connection states: offline with Try now, and the closed read-only banner; a commenter's
//     disabled properties.
//
// The driver serves the demo's dist/demo itself on an ephemeral port, so it never photographs a
// different build that happens to answer on the demo's usual port. Chrome must be listening on
// 127.0.0.1:9223; every wait polls page state with a few seconds' budget, and tabs are closed.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Tab } from "../shared/chrome-session.ts";
import { serveDirectory } from "../../serve-directory.ts";
import { withPage } from "./editor-session.ts";

const output = process.argv[2] ?? fileURLToPath(new URL("../../dist/e2e-collaboration", import.meta.url));
await mkdir(output, { recursive: true });
const demoDirectory = fileURLToPath(new URL("../../dist/demo", import.meta.url));
await using server = await serveDirectory({ directory: demoDirectory, host: "127.0.0.1" });

const problems: string[] = [];
const facts: Record<string, unknown> = {};

const CANVAS_ELEMENT = `.sasha-view-canvas-area .sasha-slide-root [data-sasha-element-id]`;
/** The DevTools Protocol's modifier bits; module constants run before the scenarios below use them. */
const MODIFIER = { alt: 1, control: 2, meta: 4, shift: 8 } as const;

for (const scheme of ["light", "dark"] as const) {
  facts[`glass-${scheme}`] = await withPage({ address: server.address, scheme, reducedMotion: true }, async (tab) => {
    await tab.waitFor(`document.querySelector(${JSON.stringify(CANVAS_ELEMENT)}) !== null`, 15_000);
    await fontsAndFrames(tab);
    const panel = await tab.evaluate(`(() => { const style = getComputedStyle(document.querySelector(".sasha-panel")); return { background: style.backgroundColor, backdrop: style.backdropFilter || style.webkitBackdropFilter }; })()`);
    await tab.screenshot(join(output, `glass-panels-${scheme}.png`));
    const backdrop = String(readField(panel, "backdrop"));
    if (!backdrop.includes("blur")) problems.push(`${scheme}: an idle panel has no backdrop blur (${backdrop})`);
    return panel;
  });
}

facts["pill-group-keys"] = await withPage({ address: server.address, scheme: "light", reducedMotion: true }, async (tab) => {
  await tab.waitFor(`document.querySelector(${JSON.stringify(CANVAS_ELEMENT)}) !== null`, 15_000);
  const centre = await centreOf(tab, `document.querySelector(${JSON.stringify(CANVAS_ELEMENT)})`);
  await tab.click(centre);
  await tab.waitFor(`document.querySelector(".sasha-view-selection-box") !== null`, 4000);
  const before = await tab.evaluate(`document.querySelector(".sasha-view-selection-box").getAttribute("style")`);
  await tab.evaluate(`document.querySelector('[data-properties-tab="arrange"]').focus(); true`);
  await tab.press({ key: "ArrowRight", code: "ArrowRight", keyCode: 39 });
  await tab.waitFor(`document.activeElement?.getAttribute("data-properties-tab") === "fill"`, 2000).catch(() => undefined);
  const after = await tab.evaluate(`document.querySelector(".sasha-view-selection-box").getAttribute("style")`);
  const focused = await tab.evaluate(`document.activeElement?.getAttribute("data-properties-tab") ?? null`);
  const selectedTab = await tab.evaluate(`document.querySelector('[role="tab"][aria-selected="true"][data-properties-tab]')?.getAttribute("data-properties-tab") ?? null`);
  await tab.screenshot(join(output, "pill-group-arrow-right.png"));
  if (before !== after) problems.push(`ArrowRight on a focused tab moved the element: ${String(before)} -> ${String(after)}`);
  if (focused !== "fill" || selectedTab !== "fill") problems.push(`ArrowRight on the Arrange tab should focus and choose Fill (focused ${String(focused)}, chosen ${String(selectedTab)})`);
  return { before, after, focused, selectedTab };
});

const PANE = (index: number): string => `document.querySelectorAll(".sasha-view-demo-pane")[${index}]`;

facts["two-editors"] = await withPage({ address: `${server.address}?editors=2`, scheme: "light", reducedMotion: true, viewport: { width: 2400, height: 1000 } }, async (tab) => {
  await tab.waitFor(`${PANE(1)}?.querySelector(${JSON.stringify(CANVAS_ELEMENT)}) !== null`, 15_000);
  await fontsAndFrames(tab);

  // Grace selects the title and hovers her canvas: Ada sees it.
  const graceElement = await centreOf(tab, `${PANE(1)}.querySelector(${JSON.stringify(CANVAS_ELEMENT)})`);
  await tab.click(graceElement);
  await tab.mouse({ type: "mouseMoved", point: { x: graceElement.x + 60, y: graceElement.y + 40 }, buttons: 0 });
  const cursor = await tab.waitFor(`${PANE(0)}.querySelector(".sasha-view-peer-cursor") !== null`, 4000).then(() => true, () => false);
  const outline = await tab.waitFor(`${PANE(0)}.querySelector(".sasha-view-peer-selection") !== null`, 4000).then(() => true, () => false);
  const filmstripAvatar = await tab.waitFor(`${PANE(0)}.querySelector(".sasha-view-thumbnail-avatar") !== null`, 4000).then(() => true, () => false);
  const label = await tab.evaluate(`${PANE(0)}.querySelector(".sasha-view-peer-label")?.textContent ?? null`);
  await tab.screenshot(join(output, "presence-cursors.png"));
  if (!cursor) problems.push("Ada's editor shows no cursor for Grace");
  if (!outline) problems.push("Ada's editor shows no selection outline for Grace");
  if (!filmstripAvatar) problems.push("Ada's filmstrip shows no avatar for Grace");
  if (label !== "Grace Hopper") problems.push(`the peer cursor's label reads ${String(label)}`);

  // Ada's top-bar avatar stack lists Grace and her slide.
  const stack = await centreOf(tab, `${PANE(0)}.querySelector(".sasha-view-avatar-stack")`);
  await tab.click(stack);
  await tab.waitFor(`document.querySelector(".sasha-view-peer-popover") !== null`, 3000);
  const listed = await tab.evaluate(`Array.from(document.querySelectorAll(".sasha-view-peer-popover li")).map((item) => item.textContent)`);
  await tab.screenshot(join(output, "presence-popover.png"));
  if (!JSON.stringify(listed).includes("Grace Hopper - slide 1")) problems.push(`the avatar popover lists ${JSON.stringify(listed)}`);
  await tab.press({ key: "Escape", code: "Escape", keyCode: 27 });
  const popoverClosed = await tab.waitFor(`document.querySelector(".sasha-view-peer-popover") === null`, 2000).then(() => true, () => false);
  if (!popoverClosed) problems.push("Escape did not close the avatar popover");

  // Ada comments on an element: primary+Alt+M, Draw, a stroke, "@Gr", Enter, submit.
  const adaElement = await centreOf(tab, `${PANE(0)}.querySelector(${JSON.stringify(CANVAS_ELEMENT)})`);
  await tab.click(adaElement);
  await tab.waitFor(`${PANE(0)}.querySelector(".sasha-view-selection-box") !== null && document.activeElement?.classList.contains("sasha-view-canvas-area")`, 3000);
  await tab.press({ key: "m", code: "KeyM", keyCode: 77, modifiers: MODIFIER.control | MODIFIER.alt });
  await tab.waitFor(`${PANE(0)}.querySelector("form[aria-label='New comment']") !== null`, 3000);
  await tab.click(await centreOf(tab, `Array.from(${PANE(0)}.querySelectorAll("form[aria-label='New comment'] button")).find((button) => button.textContent === "Draw")`));
  const strokeStart = { x: adaElement.x - 120, y: adaElement.y + 10 };
  await tab.mouse({ type: "mousePressed", point: { x: strokeStart.x, y: strokeStart.y }, buttons: 1 });
  for (let step = 1; step <= 24; step += 1) {
    await tab.mouse({ type: "mouseMoved", point: { x: strokeStart.x + step * 10, y: strokeStart.y + Math.sin(step / 3) * 18 }, buttons: 1 });
  }
  await tab.mouse({ type: "mouseReleased", point: { x: strokeStart.x + 240, y: strokeStart.y }, buttons: 0 });
  await tab.waitFor(`${PANE(0)}.querySelector(".sasha-view-overlay-drawing[data-markings]") !== null`, 3000);
  await tab.click(await centreOf(tab, `${PANE(0)}.querySelector("form[aria-label='New comment'] textarea")`));
  await tab.insertText("Make this line bolder, @Gr");
  const picker = await tab.waitFor(`${PANE(0)}.querySelector(".sasha-view-mention-picker") !== null`, 3000).then(() => true, () => false);
  const candidates = await tab.evaluate(`Array.from(${PANE(0)}.querySelectorAll(".sasha-view-mention-picker [role='option']")).map((option) => option.textContent)`);
  await tab.screenshot(join(output, "mention-picker.png"));
  if (!picker) problems.push("typing @Gr opened no members list");
  await tab.press({ key: "Enter", code: "Enter", keyCode: 13, text: "\r" });
  await tab.insertText("please");
  const draft = await tab.evaluate(`${PANE(0)}.querySelector("form[aria-label='New comment'] textarea").value`);
  if (draft !== "Make this line bolder, @Grace Hopper please") problems.push(`the draft reads ${JSON.stringify(draft)}`);
  await tab.click(await centreOf(tab, `Array.from(${PANE(0)}.querySelectorAll("form[aria-label='New comment'] button")).find((button) => button.textContent === "Comment")`));
  await tab.waitFor(`${PANE(0)}.querySelector(".sasha-view-thread[data-focused='true'] .sasha-view-mention") !== null`, 4000);
  await tab.waitFor(`Number(${PANE(0)}.querySelector(".sasha-view-overlay-drawing")?.getAttribute("data-markings") ?? 0) >= 1`, 3000);
  await fontsAndFrames(tab);
  await tab.screenshot(join(output, "comment-thread-annotation.png"));
  return { cursor, outline, filmstripAvatar, label, listed, candidates, draft };
});

for (const variant of [
  { name: "connection-offline", query: "?connection=offline", expect: `document.querySelector(".sasha-view-connection")?.textContent?.includes("Try now")` },
  { name: "connection-closed", query: "?connection=closed", expect: `document.querySelector(".sasha-view-read-only-banner") !== null` },
  { name: "role-commenter", query: "?role=commenter", expect: `document.querySelector(".sasha-view-panel-fieldset[disabled]") !== null` },
] as const) {
  facts[variant.name] = await withPage({ address: `${server.address}${variant.query}`, scheme: "light", reducedMotion: true }, async (tab) => {
    await tab.waitFor(`document.querySelector(${JSON.stringify(CANVAS_ELEMENT)}) !== null`, 15_000);
    await fontsAndFrames(tab);
    const shown = await tab.waitFor(variant.expect, 3000).then(() => true, () => false);
    await tab.screenshot(join(output, `${variant.name}.png`));
    if (!shown) problems.push(`${variant.name}: not shown (${variant.expect})`);
    return { shown };
  });
}

console.log(JSON.stringify({ output, facts, problems }, null, 2));
if (problems.length > 0) process.exitCode = 1;

type Point = Readonly<{ x: number; y: number }>;

async function centreOf(tab: Tab, elementExpression: string): Promise<Point> {
  const point = await tab.evaluate(`(() => { const element = ${elementExpression}; if (!element) return null; element.scrollIntoView({ block: "nearest" }); const box = element.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
  if (point === null || typeof point !== "object") throw new Error(`Nothing to point at: ${elementExpression}`);
  return { x: Number(Reflect.get(point, "x")), y: Number(Reflect.get(point, "y")) };
}

async function fontsAndFrames(tab: Tab): Promise<void> {
  await tab.evaluate(`Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]).then(() => true)`);
  await tab.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
}

function readField(value: unknown, field: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined;
}
