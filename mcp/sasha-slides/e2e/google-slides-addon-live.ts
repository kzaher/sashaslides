#!/usr/bin/env npx tsx
/**
 * LIVE add-on check over the DevTools protocol (Chrome on 127.0.0.1:9223) on the DEVELOPMENT deck and its bound
 * script, never production. Steps, each a separate run so each stays short:
 *
 *   show-manifest   tick "Show appsscript.json" in the bound script's settings (deploy-via-ide.ts
 *                   --step manifest needs the file in the editor's list)
 *   open-editor     SashaSlides > Open in Sasha editor on the development deck; wait for the
 *                   modeless dialog and the editor frame inside it; measure the dialog; screenshot
 *
 *   npx tsx mcp/sasha-slides/e2e/google-slides-addon-live.ts <step>
 *
 * The connector is the loopback stand-in (google-slides-addon-server.ts) behind a cloudflared
 * tunnel, and the add-on was built with SASHA_EDITOR_ORIGIN set to that tunnel.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import CDPraw from "chrome-remote-interface";
import type { CdpModule } from "../../../types/cdp-types.ts";
import { evaluateText, realClick } from "./cdp-page.ts";
import { DEVTOOLS_PORT, openTab, pointerPressExpression, type BrowserTab } from "./google-slides-browser.ts";

// chrome-remote-interface ships no .d.ts; CdpModule is the repo's boundary type for its export.
const DevTools = CDPraw as CdpModule;

const SCRIPT_ID = "1GqibbX21wU_8SMuFAC8nWStv6Y8wfrBNfiK1nQnbiawQXuABRNgr9NFo";
const DEVELOPMENT_DECK = "1zsd1n66C18A4dAzSsxmmD_H1k8KLo9z3HUJu01zHF8U";
const SHOTS = "/home/node/.claude/jobs/940e4929/tmp/engine-m2/google-slides";

async function main(): Promise<void> {
  const [step] = process.argv.slice(2);
  switch (step) {
    case "show-manifest":
      await showManifest();
      return;
    case "open-editor":
      await openEditor();
      return;
    case "delete-measure":
      await deleteMeasureFile();
      return;
    case "editor-home":
      await editorHome();
      return;
    case "run-measure":
      await runMeasure({ functionName: "sashaMeasureClient", logPattern: "sasha-measure azp=\\S+ aud=\\S+ scope=[^\\n]*" });
      return;
    case "run-identity":
      await runMeasure({ functionName: "sashaMeasureIdentity", logPattern: "sasha-identity [^\\n]*" });
      return;
    case "settings-in-editor":
      await settingsInExistingEditor();
      return;
    case "look-script": {
      // What the bound script's editor lists, for a deploy that cannot find a file.
      await using tab = await openTab({ address: `https://script.google.com/home/projects/${SCRIPT_ID}/edit`, loadBudgetMilliseconds: 20_000 });
      await tab.until({ expression: `!!window.monaco && monaco.editor.getModels().length > 0`, budgetMilliseconds: 20_000 });
      process.stdout.write(`${await tab.evaluate(`JSON.stringify([...document.querySelectorAll('div,li,span')].map((node) => (node.innerText || '').trim()).filter((text) => /\\.(gs|html|json)$/.test(text) && text.length < 40))`)}\n`);
      await tab.screenshot(join(SHOTS, "addon-script-editor.png"));
      return;
    }
    default:
      throw new Error("usage: show-manifest | settings-in-editor | editor-home | run-measure | run-identity | delete-measure | open-editor | look-script");
  }
}

async function showManifest(): Promise<void> {
  await using tab = await openTab({ address: `https://script.google.com/home/projects/${SCRIPT_ID}/settings`, loadBudgetMilliseconds: 15_000 });
  // The checkbox has no text of its own; its <label> names it (measured on the settings page).
  const box = `(() => { const label = [...document.querySelectorAll('label')].find((element) => element.textContent.includes('appsscript.json')); if (!label) return null; let node = label; while (node && !node.querySelector('input[type=checkbox],[role=checkbox]')) node = node.parentElement; return label.control || (node ? node.querySelector('input[type=checkbox],[role=checkbox]') : null); })()`;
  if (!(await tab.until({ expression: `!!(${box})`, budgetMilliseconds: 15_000 }))) {
    await tab.screenshot(join(SHOTS, "addon-settings.png"));
    const seen = await tab.evaluate(`JSON.stringify([...document.querySelectorAll('[role=checkbox],input[type=checkbox],label')].map((element) => (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 80)))`);
    throw new Error(`no manifest checkbox on the settings page; saw ${seen} at ${await tab.evaluate("location.href")}`);
  }
  const checked = `(() => { const element = ${box}; return String(element.getAttribute('aria-checked') === 'true' || element.checked === true); })()`;
  if ((await tab.evaluate(checked)) === "true") {
    process.stdout.write("the manifest is already shown\n");
    return;
  }
  // Measured: real presses on the input and on its label showed the press ripple and saved
  // nothing; the input's own click() (the change event the page listens to) is what persists.
  await tab.client.Runtime.enable();
  tab.client.Runtime.consoleAPICalled((event) => process.stdout.write(`console.${event.type}: ${event.args.map((argument) => String(argument.value ?? argument.description ?? "")).join(" ").slice(0, 300)}\n`));
  tab.client.Runtime.exceptionThrown((event) => process.stdout.write(`exception: ${event.exceptionDetails.exception?.description?.slice(0, 300) ?? event.exceptionDetails.text}\n`));
  await bringToFront(tab);
  // Measured: the manifest's "Etc/UTC" leaves the settings form's Time zone EMPTY, and a form with
  // an empty time zone saves nothing at all, so the tick was silently dropped. Pick a time zone
  // first (the manifest deploy writes timeZone back anyway).
  const zone = `[...document.querySelectorAll('[role=combobox],[aria-haspopup=listbox]')].find((element) => (element.closest('div')?.textContent || '').includes('Time zone') || (element.getAttribute('aria-label') || '').includes('Time zone'))`;
  if (await tab.until({ expression: `!!(${zone})`, budgetMilliseconds: 3_000 })) {
    await tab.click(await centreOf({ tab, finder: zone }));
    const option = `[...document.querySelectorAll('[role=option]')].find((element) => element.offsetParent !== null && /Coordinated Universal Time|GMT\\+00:00\\)? ?(UTC|London|Greenwich)/.test(element.textContent))`;
    if (await tab.until({ expression: `!!(${option})`, budgetMilliseconds: 4_000 })) {
      await tab.evaluate(`(() => { (${option}).scrollIntoView({ block: "center" }); return "ok"; })()`);
      await tab.click(await centreOf({ tab, finder: option }));
      process.stdout.write(`time zone: ${await tab.evaluate(`(${zone}).textContent.trim().slice(0, 60)`)}\n`);
    } else {
      process.stdout.write(`no UTC option among ${await tab.evaluate(`String(document.querySelectorAll('[role=option]').length)`)} options\n`);
    }
  }
  process.stdout.write(`focus: ${await tab.evaluate("String(document.hasFocus())")}\n`);
  const before = Number(await tab.evaluate("String(performance.getEntriesByType('resource').length)"));
  // The Wiz page acts on its own jsaction container: the JavaScript pointer sequence on the
  // checkbox's wrapper (the technique Slides' menubar needs, CLAUDE.md).
  process.stdout.write(`press: ${await tab.evaluate(pointerPressExpression(`(${box}).parentElement`))}\n`);
  await tab.until({ expression: `${checked} === "true"`, budgetMilliseconds: 5_000 });
  // The page saves the setting with a request of its own, and navigating away cancels it
  // (measured: a reload right after the tick lost it). Wait for that request to finish.
  const saved = await tab.until({ expression: `performance.getEntriesByType('resource').slice(${before}).some((entry) => entry.responseEnd > 0)`, budgetMilliseconds: 10_000 });
  process.stdout.write(`save request seen: ${saved}; ${await tab.evaluate(`JSON.stringify(performance.getEntriesByType('resource').slice(${before}).map((entry) => entry.name.slice(0, 90)))`)}\n`);
  // The setting is saved by the page in the background; closing the tab at once lost it (measured).
  // So the proof is a RELOAD that still shows it ticked.
  let persisted = false;
  for (let attempt = 0; attempt < 6 && !persisted; attempt += 1) {
    await tab.until({ expression: `document.readyState === "complete"`, budgetMilliseconds: 2_000 });
    const loaded = tab.client.Page.loadEventFired();
    await tab.client.Page.reload({});
    await loaded;
    persisted = await tab.until({ expression: `!!(${box}) && ${checked} === "true"`, budgetMilliseconds: 5_000 });
  }
  await tab.screenshot(join(SHOTS, "addon-settings.png"));
  process.stdout.write(`manifest shown after a reload: ${persisted}\n`);
}

/**
 * The same tick, in the user's ALREADY OPEN editor tab and through its own navigation (the gear,
 * then the code view), for when a fresh settings tab will not save (measured 2026-10-15: four
 * techniques in a new tab ticked the box and nothing persisted).
 */
async function settingsInExistingEditor(): Promise<void> {
  const targets: unknown = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)).json();
  const editor = Array.isArray(targets)
    ? targets.find((target) => String(Object.getOwnPropertyDescriptor(target, "url")?.value ?? "").includes(`/projects/${SCRIPT_ID}/`) && Object.getOwnPropertyDescriptor(target, "type")?.value === "page")
    : undefined;
  const targetId = String(Object.getOwnPropertyDescriptor(editor ?? {}, "id")?.value ?? "");
  if (targetId.length === 0) throw new Error("no open editor tab for the bound script");
  const client = await DevTools({ port: DEVTOOLS_PORT, target: targetId });
  // What the settings page's save calls answer (types/cdp-types.ts declares no Network domain;
  // these two methods and the event are the protocol's stable Network programming interface).
  const network = client as typeof client & Readonly<{ Network: Readonly<{ enable(): Promise<void>; getResponseBody(options: Readonly<{ requestId: string }>): Promise<Readonly<{ body: string }>> }> }>;
  await network.Network.enable();
  client.on("Network.loadingFinished", (parameters) => {
    const requestId = String(Object.getOwnPropertyDescriptor(parameters, "requestId")?.value ?? "");
    void network.Network.getResponseBody({ requestId })
      .then((answer) => {
        if (answer.body.includes("wrb.fr")) process.stdout.write(`rpc answer: ${answer.body.slice(0, 600)}\n`);
      })
      .catch(() => undefined);
  });
  try {
    await client.Page.enable();
    await client.Target.activateTarget({ targetId });
    const evaluate = (expression: string): Promise<string> => evaluateText(client, expression);
    process.stdout.write(`gear: ${await evaluate(pointerPressExpression(`[...document.querySelectorAll('a,button,[role=button],[role=link]')].find((element) => /Project Settings/i.test(element.getAttribute('aria-label') || element.textContent || ''))`))}\n`);
    const label = `[...document.querySelectorAll('label')].find((element) => element.textContent.includes('appsscript.json'))`;
    for (let attempt = 0; attempt < 40 && (await evaluate(`String(!!(${label}))`)) !== "true"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 250));
    const box = `(${label}).parentElement.querySelector('input[type=checkbox]') || (${label}).control`;
    const position: unknown = JSON.parse(await evaluate(`(() => { const box = (${box}).getBoundingClientRect(); return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2, checked: (${box}).checked }); })()`));
    process.stdout.write(`checkbox: ${JSON.stringify(position)} ${await evaluate(`JSON.stringify({ disabled: (${box}).disabled, ariaDisabled: (${box}).getAttribute('aria-disabled'), wrapper: (${box}).parentElement.outerHTML.slice(0, 400), resources: performance.getEntriesByType('resource').length })`)}\n`);
    if (typeof position === "object" && position !== null && "x" in position && "y" in position && typeof position.x === "number" && typeof position.y === "number" && !("checked" in position && position.checked === true)) {
      const page = client.Page as typeof client.Page & Readonly<{ bringToFront(): Promise<void> }>;
      await page.bringToFront();
      process.stdout.write(`focus before the press: ${await evaluate("String(document.hasFocus()) + ' ' + document.visibilityState")}\n`);
      // Measured on this IDE's file menu and delete dialog: its Material controls act on the
      // JavaScript pointer sequence, while real presses only highlight them.
      process.stdout.write(`script press on the input: ${await evaluate(pointerPressExpression(box))}\n`);
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await evaluate(`String((${box}).checked)`)) === "true") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    process.stdout.write(`ticked: ${await evaluate(`String((${box}).checked)`)}; requests since: ${await evaluate(`JSON.stringify(performance.getEntriesByType('resource').slice(-6).map((entry) => entry.name.slice(0, 120)))`)}\n`);
    process.stdout.write(`code view: ${await evaluate(pointerPressExpression(`[...document.querySelectorAll('a,button,[role=button],[role=link]')].find((element) => /^Editor$/i.test((element.getAttribute('aria-label') || element.textContent || '').trim()))`))}\n`);
    let listed = "false";
    for (let attempt = 0; attempt < 40 && listed !== "true"; attempt += 1) {
      // Inside the file list only: the settings label holds an "appsscript.json" span of its own.
      listed = await evaluate(`String(!!document.querySelector('[aria-label="File operations menu for appsscript.json."]'))`);
      if (listed !== "true") await new Promise((resolve) => setTimeout(resolve, 250));
    }
    process.stdout.write(`appsscript.json listed: ${listed}\n`);
  } finally {
    await client.close();
  }
}

/** The user's open editor tab for the bound script, as a DevTools protocol client. */
async function existingEditorClient(): Promise<Awaited<ReturnType<typeof DevTools>>> {
  const targets: unknown = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)).json();
  const editor = Array.isArray(targets)
    ? targets.find((target) => String(Object.getOwnPropertyDescriptor(target, "url")?.value ?? "").includes(`/projects/${SCRIPT_ID}/`) && Object.getOwnPropertyDescriptor(target, "type")?.value === "page")
    : undefined;
  const targetId = String(Object.getOwnPropertyDescriptor(editor ?? {}, "id")?.value ?? "");
  if (targetId.length === 0) throw new Error("no open editor tab for the bound script");
  const client = await DevTools({ port: DEVTOOLS_PORT, target: targetId });
  await client.Page.enable();
  await client.Target.activateTarget({ targetId });
  return client;
}

/** Removes the temporary Measure.gs through the file's own menu (Delete, then the confirmation). */
async function deleteMeasureFile(): Promise<void> {
  const client = await existingEditorClient();
  try {
    const evaluate = (expression: string): Promise<string> => evaluateText(client, expression);
    await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Escape", windowsVirtualKeyCode: 27 });
    await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 });
    // The row's menu button only takes presses while the row is hovered: hover for real, then press it for real.
    const row = `[...document.querySelectorAll('div,li,span')].filter((node) => (node.innerText || '').trim() === 'Measure.gs' && node.getBoundingClientRect().width > 4).sort((first, second) => first.innerText.length - second.innerText.length)[0]`;
    const rowAt: unknown = JSON.parse(await evaluate(`(() => { const box = (${row}).getBoundingClientRect(); return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 }); })()`));
    if (typeof rowAt === "object" && rowAt !== null && "x" in rowAt && "y" in rowAt && typeof rowAt.x === "number" && typeof rowAt.y === "number") await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: rowAt.x, y: rowAt.y });
    const kebab = `document.querySelector('[aria-label="File operations menu for Measure.gs."]')`;
    const kebabAt: unknown = JSON.parse(await evaluate(`(() => { const box = (${kebab}).getBoundingClientRect(); return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width }); })()`));
    process.stdout.write(`menu button: ${JSON.stringify(kebabAt)}\n`);
    if (typeof kebabAt === "object" && kebabAt !== null && "x" in kebabAt && "y" in kebabAt && typeof kebabAt.x === "number" && typeof kebabAt.y === "number") await realClick(client, { x: kebabAt.x, y: kebabAt.y });
    const item = `[...document.querySelectorAll('[role=menuitem]')].find((element) => element.getBoundingClientRect().width > 0 && element.textContent.trim().startsWith('Delete'))`;
    for (let attempt = 0; attempt < 20 && (await evaluate(`String(!!(${item}))`)) !== "true"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 200));
    const itemAt: unknown = JSON.parse(await evaluate(`(() => { const element = ${item}; if (!element) return "{}"; const box = element.getBoundingClientRect(); return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 }); })()`));
    if (typeof itemAt === "object" && itemAt !== null && "x" in itemAt && "y" in itemAt && typeof itemAt.x === "number" && typeof itemAt.y === "number") await realClick(client, { x: itemAt.x, y: itemAt.y });
    // Measured: the real press only highlighted "Delete"; the menu item acts on the JavaScript sequence.
    if ((await evaluate(`String(!!(${item}))`)) === "true") process.stdout.write(`delete item (script press): ${await evaluate(pointerPressExpression(item))}\n`);
    process.stdout.write(`delete item: ${JSON.stringify(itemAt)}\n`);
    const confirm = `[...document.querySelectorAll('button,[role=button]')].find((element) => element.getBoundingClientRect().width > 0 && /^Delete( forever)?$/.test(element.textContent.trim()))`;
    for (let attempt = 0; attempt < 20 && (await evaluate(`String(!!(${confirm}))`)) !== "true"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 200));
    const confirmAt: unknown = JSON.parse(await evaluate(`(() => { const element = ${confirm}; if (!element) return "{}"; const box = element.getBoundingClientRect(); return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 }); })()`));
    if (typeof confirmAt === "object" && confirmAt !== null && "x" in confirmAt && "y" in confirmAt && typeof confirmAt.x === "number" && typeof confirmAt.y === "number") await realClick(client, { x: confirmAt.x, y: confirmAt.y });
    // As with the menu item, the dialog's button acts on the JavaScript sequence (a real press did nothing).
    if ((await evaluate(`String(!!(${confirm}))`)) === "true") process.stdout.write(`confirm (script press): ${await evaluate(pointerPressExpression(confirm))}\n`);
    process.stdout.write(`confirm: ${JSON.stringify(confirmAt)}\n`);
    const shot = await client.Page.captureScreenshot({ format: "png" });
    writeFileSync(join(SHOTS, "addon-delete-measure.png"), Buffer.from(shot.data, "base64"));
    process.stdout.write(`buttons: ${await evaluate(`JSON.stringify([...document.querySelectorAll('button,[role=button]')].filter((element) => element.getBoundingClientRect().width > 0).map((element) => element.textContent.trim()).filter((text) => text.length > 0 && text.length < 30))`)}\n`);
    let gone = "false";
    for (let attempt = 0; attempt < 40 && gone !== "true"; attempt += 1) {
      gone = await evaluate(`String(!document.querySelector('[aria-label="File operations menu for Measure.gs."]'))`);
      if (gone !== "true") await new Promise((resolve) => setTimeout(resolve, 250));
    }
    process.stdout.write(`Measure.gs removed: ${gone}\n`);
  } finally {
    await client.close();
  }
}

/** Back to the code view, with the file list loaded. */
async function editorHome(): Promise<void> {
  const client = await existingEditorClient();
  try {
    const loaded = client.Page.loadEventFired();
    await client.Page.navigate({ url: `https://script.google.com/home/projects/${SCRIPT_ID}/edit` });
    await loaded;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if ((await evaluateText(client, "String(!!window.monaco && monaco.editor.getModels().length > 0)")) === "true") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    process.stdout.write(`editor: ${await evaluateText(client, "String(monaco.editor.getModels().length) + ' models'")}\n`);
  } finally {
    await client.close();
  }
}

/**
 * Run the temporary `sashaMeasureClient` (Measure.gs) from the editor and print its log line: the
 * OAuth client this project's tokens are issued to, which is the identity token's audience.
 */
async function runMeasure(options: Readonly<{ functionName: string; logPattern: string }>): Promise<void> {
  const client = await existingEditorClient();
  try {
    const evaluate = (expression: string): Promise<string> => evaluateText(client, expression);
    const page = client.Page as typeof client.Page & Readonly<{ bringToFront(): Promise<void> }>;
    await page.bringToFront();
    process.stdout.write(`file: ${await evaluate(pointerPressExpression(`[...document.querySelectorAll('div,li,span')].filter((node) => (node.innerText || '').trim() === 'Measure.gs' && node.getBoundingClientRect().width > 4).sort((first, second) => first.innerText.length - second.innerText.length)[0]`))}\n`);
    // The function picker lists the open file's functions; choose ours, then press Run for real.
    // The toolbar's "Select function to run" listbox (measured: its options are always in the DOM).
    const picker = `document.querySelector('[aria-label="Select function to run"]')`;
    const pickerAt: unknown = JSON.parse(await evaluate(`(() => { const box = (${picker}).getBoundingClientRect(); return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 }); })()`));
    if (typeof pickerAt === "object" && pickerAt !== null && "x" in pickerAt && "y" in pickerAt && typeof pickerAt.x === "number" && typeof pickerAt.y === "number") await realClick(client, { x: pickerAt.x, y: pickerAt.y });
    const option = `[...(${picker}).querySelectorAll('[role=option]'), ...document.querySelectorAll('[role=option]')].find((element) => element.textContent.trim() === '${options.functionName}')`;
    for (let attempt = 0; attempt < 20 && (await evaluate(`String(!!(${option}) && (${option}).getBoundingClientRect().height > 0)`)) !== "true"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 250));
    const optionAt: unknown = JSON.parse(await evaluate(`(() => { const box = (${option}).getBoundingClientRect(); return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 }); })()`));
    if (typeof optionAt === "object" && optionAt !== null && "x" in optionAt && "y" in optionAt && typeof optionAt.x === "number" && typeof optionAt.y === "number") await realClick(client, { x: optionAt.x, y: optionAt.y });
    process.stdout.write(`selected: ${await evaluate(`(${picker}).getAttribute('aria-activedescendant') + ' ' + ((${picker}).querySelector('[aria-selected=true]')?.textContent || '')`)}\n`);
    const run = `[...document.querySelectorAll('button,[role=button]')].find((element) => (element.getAttribute('aria-label') || '').trim() === 'Run the selected function')`;
    const position: unknown = JSON.parse(await evaluate(`(() => { const box = (${run}).getBoundingClientRect(); return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 }); })()`));
    if (typeof position !== "object" || position === null || !("x" in position) || !("y" in position) || typeof position.x !== "number" || typeof position.y !== "number") throw new Error("no Run button");
    await realClick(client, { x: position.x, y: position.y });
    let line = "";
    for (let attempt = 0; attempt < 120 && line.length === 0; attempt += 1) {
      line = await evaluate(`(() => { const match = new RegExp(${JSON.stringify(options.logPattern)}).exec(document.body.innerText); return match ? match[0] : ""; })()`);
      if (line.length === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    process.stdout.write(`measured: ${line || "nothing logged"}\n`);
    if (line.length === 0) process.stdout.write(`page says: ${(await evaluate("document.body.innerText")).replace(/\s+/g, " ").slice(-400)}\n`);
  } finally {
    await client.close();
  }
}

async function openEditor(): Promise<void> {
  await using tab = await openTab({ address: `https://docs.google.com/presentation/d/${DEVELOPMENT_DECK}/edit`, loadBudgetMilliseconds: 20_000 });
  await tab.client.Target.activateTarget({ targetId: tab.targetId });
  const menu = `[...document.querySelectorAll('#docs-menubar .menu-button, #docs-menubar [role=menuitem]')].find((element) => element.textContent.trim() === 'SashaSlides')`;
  if (!(await tab.until({ expression: `!!(${menu})`, budgetMilliseconds: 25_000 }))) throw new Error("the SashaSlides menu never appeared");
  process.stdout.write(`menu: ${await tab.evaluate(pointerPressExpression(menu))}\n`);
  const item = `[...document.querySelectorAll('.goog-menuitem')].find((element) => element.offsetParent !== null && element.textContent.trim().startsWith('Open in Sasha editor'))`;
  if (!(await tab.until({ expression: `!!(${item})`, budgetMilliseconds: 4_000 }))) throw new Error("no 'Open in Sasha editor' item");
  process.stdout.write(`item: ${await tab.evaluate(pointerPressExpression(item))}\n`);

  // The dialog: Slides' modeless dialog element holding the HtmlService frame.
  // A fixed-position dialog has no offsetParent; its box is the visibility test (measured).
  // The dialog is found through its HtmlService frame (measured: a docs.google.com/macros/...
  // iframedAppPanel iframe; the googleusercontent sandbox is nested inside it) and the
  // closest ancestor that also holds the "Sasha editor" title: Slides gives it no stable role.
  const dialog = `(() => { const frame = [...document.querySelectorAll('iframe')].find((element) => /iframedAppPanel|googleusercontent/.test(element.src) && element.getBoundingClientRect().width > 400); if (!frame) return null; let node = frame.parentElement; while (node && !/Sasha editor/.test(node.textContent || '')) node = node.parentElement; return node; })()`;
  const shown = await tab.until({ expression: `!!(${dialog})`, budgetMilliseconds: 60_000 });
  await tab.screenshot(join(SHOTS, "addon-open-editor.png"));
  if (!shown) {
    const frames = await tab.evaluate(`JSON.stringify([...document.querySelectorAll('iframe')].map((element) => { const box = element.getBoundingClientRect(); return [element.src.slice(0, 80), Math.round(box.width), Math.round(box.height)]; }).filter((entry) => entry[1] > 100))`);
    throw new Error(`no dialog appeared (screenshot saved); frames ${frames}`);
  }
  const measured = await tab.evaluate(`(() => { const element = ${dialog}; const box = element.getBoundingClientRect(); const frame = element.querySelector('iframe'); const inner = frame ? frame.getBoundingClientRect() : null; return JSON.stringify({ text: element.textContent.slice(0, 120), dialog: { width: Math.round(box.width), height: Math.round(box.height) }, frame: inner && { width: Math.round(inner.width), height: Math.round(inner.height) }, window: { width: innerWidth, height: innerHeight } }); })()`);
  process.stdout.write(`dialog: ${measured}\n`);
  // The editor frame is cross-origin to the deck page, so its arrival is read from Chrome's own
  // target list (the frame becomes a target once it loads), not from the deck page's DOM.
  const deadline = Date.now() + 30_000;
  let editorFrame: string | null = null;
  while (Date.now() < deadline && editorFrame === null) {
    const targets: unknown = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json/list`)).json();
    const found = Array.isArray(targets) ? targets.map((target) => String(Object.getOwnPropertyDescriptor(target, "url")?.value ?? "")).find((address) => address.includes("?embed=addon")) : undefined;
    editorFrame = found ?? null;
    if (editorFrame === null) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  process.stdout.write(`editor frame: ${editorFrame ?? "never loaded"}\n`);
  await tab.screenshot(join(SHOTS, "addon-open-editor.png"));
  process.stdout.write(`screenshot ${join(SHOTS, "addon-open-editor.png")}\n`);
}

/**
 * Page.bringToFront: Google's editors ignore input while `document.hasFocus()` is false (CLAUDE.md).
 * types/cdp-types.ts's CdpPage omits the method, which the protocol has (Page domain, stable).
 */
async function bringToFront(tab: BrowserTab): Promise<void> {
  const page = tab.client.Page as BrowserTab["client"]["Page"] & Readonly<{ bringToFront(): Promise<void> }>;
  await page.bringToFront();
}

async function centreOf(options: Readonly<{ tab: BrowserTab; finder: string }>): Promise<Readonly<{ x: number; y: number }>> {
  const text = await options.tab.evaluate(`(() => { const box = (${options.finder}).getBoundingClientRect(); return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 }); })()`);
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("x" in value) || !("y" in value) || typeof value.x !== "number" || typeof value.y !== "number") throw new Error(`no position: ${text}`);
  return { x: value.x, y: value.y };
}

main().catch((cause: unknown) => {
  process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
  process.exit(1);
});
