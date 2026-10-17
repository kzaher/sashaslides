#!/usr/bin/env npx tsx
/**
 * The two fixture features the Slides programming interface cannot write, added in the Slides editor over CDP:
 * slide numbers (Insert > Slide numbers, which places `autoText` SLIDE_NUMBER fields) and word art
 * (Insert > Word art). Run once after google-slides-fixture.ts build, then record again.
 *
 *   npx tsx mcp/sasha-slides/e2e/google-slides-fixture-editor.ts <presentationId> <step>
 *   steps: slide-numbers | word-art | look
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CdpKeyEventParams } from "../../../types/cdp-types.ts";
import { openTab, pointerPressExpression } from "./google-slides-browser.ts";

const SHOTS = join(tmpdir(), "sasha-slides-e2e");
mkdirSync(SHOTS, { recursive: true });

async function main(): Promise<void> {
  const [presentationId, step] = process.argv.slice(2);
  if (presentationId === undefined || step === undefined) throw new Error("usage: <presentationId> slide-numbers | word-art | look");
  const slide = step === "word-art" ? "media_slide" : "g1a2b3c4d5_0_1";
  await using tab = await openTab({
    address: `https://docs.google.com/presentation/d/${presentationId}/edit#slide=id.${slide}`,
    loadBudgetMilliseconds: 15_000,
  });
  await tab.client.Target.activateTarget({ targetId: tab.targetId });
  const ready = await tab.until({ expression: `!!document.querySelector("#docs-insert-menu")`, budgetMilliseconds: 15_000 });
  if (!ready) throw new Error("the editor did not load");
  switch (step) {
    case "slide-numbers":
      await insertSlideNumbers({ tab });
      break;
    case "word-art":
      await insertWordArt({ tab });
      break;
    case "look":
      break;
    default:
      throw new Error(`unknown step ${step}`);
  }
  await tab.screenshot(join(SHOTS, `fixture-editor-${step}.png`));
  process.stdout.write(`screenshot ${join(SHOTS, `fixture-editor-${step}.png`)}\n`);
}

type Tab = Awaited<ReturnType<typeof openTab>>;

async function openInsertItem(options: Readonly<{ tab: Tab; label: string }>): Promise<void> {
  const { tab } = options;
  process.stdout.write(`insert menu: ${await tab.evaluate(pointerPressExpression(`document.querySelector("#docs-insert-menu")`))}\n`);
  const item = `[...document.querySelectorAll(".goog-menuitem")].find((element) => element.offsetParent !== null && element.textContent.trim().startsWith(${JSON.stringify(options.label)}))`;
  const shown = await tab.until({ expression: `!!(${item})`, budgetMilliseconds: 3_000 });
  if (!shown) {
    const labels = await tab.evaluate(`JSON.stringify([...document.querySelectorAll(".goog-menuitem")].filter((element) => element.offsetParent !== null).map((element) => element.textContent.trim()))`);
    throw new Error(`no "${options.label}" in ${labels}`);
  }
  process.stdout.write(`${options.label}: ${await tab.evaluate(pointerPressExpression(item))}\n`);
}

async function insertSlideNumbers(options: Readonly<{ tab: Tab }>): Promise<void> {
  const { tab } = options;
  await openInsertItem({ tab, label: "Slide numbers" });
  const dialog = `[...document.querySelectorAll("[role=dialog]")].find((element) => element.offsetParent !== null && /Slide numbers/.test(element.textContent))`;
  if (!(await tab.until({ expression: `!!(${dialog})`, budgetMilliseconds: 5_000 }))) {
    await tab.screenshot(join(SHOTS, "fixture-editor-no-dialog.png"));
    throw new Error(`no slide numbers dialog: ${await tab.evaluate(`JSON.stringify([...document.querySelectorAll("[role=dialog]")].map((element) => element.className + " " + element.textContent.slice(0, 80)))`)}`);
  }
  const texts = await tab.evaluate(`${dialog}.innerText`);
  process.stdout.write(`dialog: ${texts.replace(/\s+/g, " ")}\n`);
  // The "Show slide numbers" switch comes up on; Save applies it to every slide.
  const save = `[...(${dialog}).querySelectorAll("button, [role=button]")].find((element) => element.textContent.trim() === "Save")`;
  const box = await tab.evaluate(`(() => { const box = (${save}).getBoundingClientRect(); return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 }); })()`);
  const at: unknown = JSON.parse(box);
  if (typeof at !== "object" || at === null || !("x" in at) || !("y" in at) || typeof at.x !== "number" || typeof at.y !== "number") throw new Error(`no Save button: ${box}`);
  await tab.click({ x: at.x, y: at.y });
  await tab.until({ expression: `!(${dialog})`, budgetMilliseconds: 5_000 });
}

async function insertWordArt(options: Readonly<{ tab: Tab }>): Promise<void> {
  const { tab } = options;
  await openInsertItem({ tab, label: "Word art" });
  // The word art box is the editable element in the bubble that says "Use Enter to save".
  const hint = `[...document.querySelectorAll("div, span")].find((element) => element.children.length === 0 && element.textContent.startsWith("Use Enter to save") && element.offsetParent !== null)`;
  if (!(await tab.until({ expression: `!!(${hint})`, budgetMilliseconds: 3_000 }))) throw new Error("no word art box");
  const field = `(() => { let node = ${hint}; while (node && !node.querySelector("textarea, input, [contenteditable=true]")) node = node.parentElement; return node ? node.querySelector("textarea, input, [contenteditable=true]") : null; })()`;
  const described = await tab.evaluate(`(() => { const element = ${field}; if (!element) return "none"; const box = element.getBoundingClientRect(); return JSON.stringify({ tag: element.tagName, className: element.className, x: box.x + box.width / 2, y: box.y + box.height / 2 }); })()`);
  process.stdout.write(`word art field: ${described}\n`);
  const at: unknown = JSON.parse(described);
  if (typeof at !== "object" || at === null || !("x" in at) || !("y" in at) || typeof at.x !== "number" || typeof at.y !== "number") throw new Error("no word art field");
  await tab.click({ x: at.x, y: at.y });
  for (const character of "Launch") {
    const press: CdpKeyEventParams & Readonly<{ text: string }> = { type: "keyDown", key: character, text: character };
    await tab.client.Input.dispatchKeyEvent(press);
    await tab.client.Input.dispatchKeyEvent({ type: "keyUp", key: character });
  }
  const enter: CdpKeyEventParams & Readonly<{ text: string; code: string }> = { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 };
  await tab.client.Input.dispatchKeyEvent(enter);
  await tab.client.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
}

main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exit(1);
});
