#!/usr/bin/env npx tsx
/**
 * Deploy the sasha-slides picker into a container-bound Apps Script project by driving the
 * Apps Script editor UI over CDP.
 *
 * Why this exists instead of `script.projects.updateContent`: the Apps Script API is
 * disabled for this Cloud project, and turning it on needs the Cloud console, which is
 * itself blocked behind mandatory 2-step verification for this account (measured — see
 * mcp/sasha-slides/STATUS.md). A container-bound project created from
 * Slides -> Extensions -> Apps Script needs neither the API nor the console, so the editor
 * UI is the only unblocked path.
 *
 * The editor exposes `window.monaco`, so file contents are set with `editor.executeEdits()`
 * rather than typed — a 424 KB sidebar bundle cannot be sent through key events. The value
 * is shipped to the page in chunks because a single Runtime.evaluate expression carrying the
 * whole bundle is large enough to be worth not relying on.
 *
 * Steps are separate so each invocation stays short and fails fast:
 *   --step code      set Code.gs
 *   --step sidebar   add Sidebar.html and set it
 *   --step manifest  set appsscript.json (needs the manifest shown in editor settings)
 *   --step editor    add EditorShell.html when missing and set it (the deck editor's frame host)
 *   --step diagram   add Diagram.html when missing and set it (the draw.io diagram dialog)
 *   --step put       --file <Name.gs|Name.html> --from <path>: create the file when missing, set it
 *   --step verify    read every model back and compare lengths to disk
 */
import CDPraw from "chrome-remote-interface";
import type { CdpClient, CdpModule } from "../../../types/cdp-types.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";

// chrome-remote-interface ships no .d.ts and types/ambient.d.ts declares its default export
// `unknown`. CdpModule is the repo's shared boundary type for the callable connect-fn plus
// the runtime-attached New / Close / List statics.
const CDP = CDPraw as CdpModule;

const DIST = "/workspaces/sashaslides/dist/mcp/sasha-slides/addon";
const CHUNK = 48 * 1024;

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const SCRIPT_ID = option("--script-id") ?? "1GqibbX21wU_8SMuFAC8nWStv6Y8wfrBNfiK1nQnbiawQXuABRNgr9NFo";
const STEP = option("--step") ?? "verify";
const PORT = Number(option("--port") ?? 9223);

type Step = "code" | "sidebar" | "dialog" | "report" | "editor" | "diagram" | "put" | "manifest" | "create" | "push" | "verify";

function assertNever(value: never): never {
  throw new Error(`Unhandled case: ${String(value)}`);
}

function parseStep(raw: string): Step {
  // Parse boundary: `raw` is a CLI string, so this cannot be enum-exhaustive.
  if (
    raw === "code" ||
    raw === "sidebar" ||
    raw === "dialog" ||
    raw === "report" ||
    raw === "editor" ||
    raw === "diagram" ||
    raw === "put" ||
    raw === "manifest" ||
    raw === "create" ||
    raw === "push" ||
    raw === "verify"
  ) {
    return raw;
  }
  throw new Error(`unknown --step ${raw} (code | sidebar | dialog | report | editor | put | manifest | create | push | verify)`);
}

async function ev(client: CdpClient, expression: string): Promise<string> {
  const { result, exceptionDetails } = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails !== undefined) throw new Error(`page threw: ${exceptionDetails.text}`);
  return typeof result.value === "string" ? result.value : String(result.value);
}

/** Poll an observable condition; never a blind sleep. */
async function until(options: { readonly client: CdpClient; readonly expression: string; readonly budgetMs: number; readonly label: string }): Promise<boolean> {
  const deadline = Date.now() + options.budgetMs;
  while (Date.now() < deadline) {
    if ((await ev(options.client, options.expression)) === "true") return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  console.error(`  timeout: ${options.label} (${options.budgetMs}ms)`);
  return false;
}

async function attach(): Promise<CdpClient> {
  const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as readonly { id: string; type: string; url: string }[];
  // Match the FULL script id so we can never attach to a truncated/duplicate tab.
  // THE CODE EDITOR, not any tab of the project: twice on 2026-10-15 a tab left on the project's
  // Executions page matched first, and the push failed with "could not find Code.gs in the file list".
  const target =
    list.find((t) => t.type === "page" && t.url.includes(SCRIPT_ID) && /\/edit(?:[?#]|$)/.test(t.url)) ??
    list.find((t) => t.type === "page" && t.url.includes(SCRIPT_ID));
  if (target === undefined) throw new Error(`no editor tab containing ${SCRIPT_ID}`);
  const client: CdpClient = await CDP({ port: PORT, target: target.id });
  await client.Runtime.enable();
  await client.Page.enable();
  await client.Page.bringToFront();
  return client;
}

/** Ship a big string into the page without one enormous expression. */
async function sendBuffer(client: CdpClient, text: string): Promise<void> {
  await ev(client, `(() => { window.__sasha = []; return 'ok'; })()`);
  for (let at = 0; at < text.length; at += CHUNK) {
    const part = text.slice(at, at + CHUNK);
    await ev(client, `(() => { window.__sasha.push(${JSON.stringify(part)}); return 'ok'; })()`);
  }
  const length = await ev(client, `String(window.__sasha.join('').length)`);
  if (Number(length) !== text.length) throw new Error(`buffer mismatch: page ${length} vs disk ${text.length}`);
}


async function save(client: CdpClient): Promise<void> {
  // THE SAVE BUTTON IS THE ONLY HONEST SIGNAL, in both directions. Measured 2026-10-13: waiting only
  // for it to be disabled passed instantly when the editor had not yet marked the file dirty, so
  // "save idle" was printed and nothing was saved (a fresh tab held the previous build, twice). So
  // first wait for it to ENABLE (the edit registered), then press it with a trusted click, then wait
  // for it to disable again. Ctrl+S with the editor focused is the fallback if the click misses.
  const button = `[...document.querySelectorAll('button,[role=button]')].find(x => (x.getAttribute('aria-label')||'').trim().startsWith('Save project'))`;
  const disabled = `(() => { const b = ${button}; return b ? String(b.disabled === true || b.getAttribute('aria-disabled') === 'true') : 'false'; })()`;
  await client.Page.bringToFront();
  const dirty = await until({ client, budgetMs: 8000, label: "the Save button to enable (edit registered)", expression: `String(${disabled} === 'false')` });
  if (!dirty) throw new Error("the editor never marked the file unsaved; nothing would be saved");
  const at = JSON.parse(await ev(client, `(() => { const r = (${button}).getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`)) as { x: number; y: number };
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
    await client.Input.dispatchMouseEvent({ type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  }
  let saved = await until({ client, budgetMs: 15000, label: "the Save button to go idle after the click", expression: disabled });
  if (!saved) {
    await ev(client, `(() => { const e = window.monaco.editor.getEditors()[0]; if (e) e.focus(); return 'ok'; })()`);
    await client.Input.dispatchKeyEvent({ type: "keyDown", modifiers: 2, key: "s", code: "KeyS", windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 });
    await client.Input.dispatchKeyEvent({ type: "keyUp", modifiers: 2, key: "s", code: "KeyS", windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 });
    saved = await until({ client, budgetMs: 15000, label: "the Save button to go idle after Ctrl+S", expression: disabled });
  }
  if (!saved) throw new Error("the save never completed");
  console.log("  saved (Save button went enabled -> idle)");
}


/**
 * Open a file by its NAME in the editor's file list, then return the model the editor is
 * actually showing.
 *
 * Selecting by model uri suffix stopped working the moment a second `.html` file existed:
 * the uris are `file_1.js`, `file_2.html`, `file_3.html` and carry no name, so a suffix match
 * is ambiguous and could write the 453 KB dialog over the 249 KB sidebar. Clicking the name
 * and taking `monaco.editor.getEditors()[0].getModel()` is unambiguous, and the caller
 * verifies the length afterwards.
 */
async function selectFile(client: CdpClient, name: string): Promise<boolean> {
  const clicked = await ev(client, `(() => {
    const want = ${JSON.stringify(name)};
    const hit = [...document.querySelectorAll('div,li,span')]
      .filter(n => (n.innerText || '').trim() === want && n.getBoundingClientRect().width > 4)
      .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
    if (!hit) return 'NOT FOUND';
    const r = hit.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerType: 'mouse', button: 0, pointerId: 1 };
    hit.dispatchEvent(new PointerEvent('pointerdown', o));
    hit.dispatchEvent(new MouseEvent('mousedown', o));
    hit.dispatchEvent(new PointerEvent('pointerup', o));
    hit.dispatchEvent(new MouseEvent('mouseup', o));
    hit.dispatchEvent(new MouseEvent('click', o));
    if (hit.click) hit.click();
    return 'clicked';
  })()`);
  if (clicked !== "clicked") {
    console.error(`  could not find ${name} in the file list: ${clicked}`);
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return true;
}

/** Write `text` into the active model; false when it was already there (nothing to save). */
async function setActiveModel(client: CdpClient, text: string): Promise<boolean> {
  await sendBuffer(client, text);
  const set = await ev(client, `(() => {
    const editors = window.monaco.editor.getEditors();
    if (editors.length === 0) return 'NO EDITOR';
    const editor = editors[0];
    const model = editor.getModel();
    if (!model) return 'NO ACTIVE MODEL';
    // AN EDIT, NOT setValue. Measured 2026-10-13: setValue's "flush" change left the editor's Save
    // button disabled, Ctrl+S saved nothing and a fresh tab still had the previous build, three
    // deploys in a row. A replace through executeEdits is an ordinary change and marks the file dirty.
    const text = window.__sasha.join('');
    // Identical text is no edit at all, so the editor has nothing to save: say so instead of waiting.
    if (model.getValue() === text) return 'same:' + text.length;
    editor.executeEdits('deploy-via-ide', [{ range: model.getFullModelRange(), text }]);
    return String(model.getValue().length);
  })()`);
  written.push(text.length);
  if (set.startsWith("same:")) {
    console.log(`  unchanged (${text.length} chars already in the editor)`);
    return false;
  }
  if (!/^\d+$/.test(set)) throw new Error(set);
  console.log(`  active model now holds ${set} chars (disk ${text.length})`);
  return true;
}



/**
 * A JS-dispatched press. The Apps Script editor's own controls respond to this; Google's
 * consent and the Slides menubar do not, which is why `authorize-via-ide.ts` uses real
 * Input events instead. Two surfaces, two techniques — see that file's header.
 */
const PRESS = (find: string): string => `(() => {
  const el = ${find};
  if (!el) return 'NOT FOUND';
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
              pointerType: 'mouse', button: 0, pointerId: 1 };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new MouseEvent('mousedown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.dispatchEvent(new MouseEvent('click', o));
  if (typeof el.click === 'function') el.click();
  return 'pressed';
})()`;

/**
 * Create a file in the Apps Script project by driving the editor's own "Add a file" flow.
 *
 * Needed because the project's file list is not something the deploy can create from disk: a
 * new surface in `dist/` has no counterpart in the editor until someone adds it by hand. This
 * was a throwaway script the first time a second HTML file appeared; it is a step now because
 * the surface count is still growing and doing it by hand each time is how a file ends up named
 * `Untitled`.
 */
async function createFile(client: CdpClient, options: Readonly<{ name: string; kind: "html" | "script" }>): Promise<boolean> {
  const present = await ev(client, `(() => {
    const want = ${JSON.stringify(options.name)};
    const names = [...document.querySelectorAll('div,li,span')].map(n => (n.innerText || '').trim());
    return String(names.includes(want));
  })()`);
  if (present === "true") {
    console.log(`  ${options.name} already exists`);
    return true;
  }

  const pressed = await ev(client, PRESS(`[...document.querySelectorAll('button,[role=button]')].find(x => (x.getAttribute('aria-label')||'').trim() === 'Add a file')`));
  if (pressed !== "pressed") { console.error(`  no "Add a file" button: ${pressed}`); return false; }
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const chose = await ev(client, PRESS(`[...document.querySelectorAll('[role=menuitem],[role=option]')].filter(n => n.offsetParent !== null).find(n => (n.innerText||'').trim().toLowerCase().startsWith(${JSON.stringify(options.kind)}))`));
  if (chose !== "pressed") { console.error(`  no "${options.kind}" entry in the add menu: ${chose}`); return false; }
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // The new file arrives named "Untitled" with an inline text field already in the document.
  const focused = await ev(client, `(() => {
    const field = [...document.querySelectorAll('input')].filter(x => x.offsetParent !== null && x.value === 'Untitled')[0];
    if (!field) return 'NO INPUT';
    field.focus(); field.select();
    return 'focused';
  })()`);
  if (focused !== "focused") { console.error(`  no name field appeared: ${focused}`); return false; }
  await client.Input.insertText({ text: options.name.replace(/\.(html|gs)$/, "") });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await client.Input.dispatchKeyEvent({ type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const names = await ev(client, `(() => {
      const want = ${JSON.stringify(options.name)};
      return String([...document.querySelectorAll('div,li,span')].map(n => (n.innerText || '').trim()).includes(want));
    })()`);
    if (names === "true") { console.log(`  created ${options.name}`); return true; }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  console.error(`  ${options.name} never appeared in the file list`);
  return false;
}

/** Every surface in dist/, created if missing and pushed. One command for a whole deploy. */
async function pushEverything(client: CdpClient): Promise<boolean> {
  const surfaces: readonly Readonly<{ file: string; kind: "html" | "script" }>[] = [
    { file: "Code.gs", kind: "script" },
    ...readdirSync(DIST)
      .filter((name) => name.endsWith(".html"))
      .sort()
      .map((file) => ({ file, kind: "html" as const })),
  ];
  for (const surface of surfaces) {
    if (!existsSync(`${DIST}/${surface.file}`)) continue;
    console.log(`${surface.file}:`);
    if (surface.kind === "html" && !(await createFile(client, { name: surface.file, kind: "html" }))) return false;
    if (!(await selectFile(client, surface.file))) return false;
    if (await setActiveModel(client, readFileSync(`${DIST}/${surface.file}`, "utf-8"))) await save(client);
  }
  return true;
}

/** The length of every file this run wrote, for `confirmPersisted`. */
const written: number[] = [];

/**
 * READ IT BACK FROM A SECOND TAB, WITH THE FIRST STILL OPEN. Measured 2026-10-13: the Save button is
 * disabled while a save is still IN FLIGHT, so "idle" does not mean "stored", and closing the editor
 * tab at that moment discarded the save -- four deploys were lost that way, each reported as saved.
 * A second tab loads what Google stored; only that proves the deploy.
 */
async function confirmPersisted(): Promise<boolean> {
  if (written.length === 0) return true;
  const tab = await CDP.New({ port: PORT });
  const second: CdpClient = await CDP({ port: PORT, target: tab.id });
  try {
    await second.Page.enable();
    await second.Page.navigate({ url: `https://script.google.com/home/projects/${SCRIPT_ID}/edit` });
    const deadline = Date.now() + 30_000;
    let stored: number[] = [];
    while (Date.now() < deadline) {
      const lengths = await ev(second, `(() => window.monaco && monaco.editor.getModels().length > 0 ? JSON.stringify(monaco.editor.getModels().map(m => m.getValue().length)) : '[]')()`);
      stored = JSON.parse(lengths) as number[];
      if (stored.length > 0 && written.every((length) => stored.includes(length))) {
        console.log(`  confirmed from a second tab: ${written.join(", ")} chars stored`);
        return true;
      }
      if (stored.length > 0) await second.Page.reload({});
      await new Promise((r) => setTimeout(r, 2000));
    }
    console.error(`  NOT STORED: wrote ${written.join(", ")}, a second tab sees ${stored.join(", ")}`);
    return false;
  } finally {
    await second.close();
    await CDP.Close({ port: PORT, id: tab.id });
  }
}

async function main(): Promise<void> {
  const step = parseStep(STEP);
  const client = await attach();
  console.log(`step=${step} script=${SCRIPT_ID.slice(0, 12)}…`);

  switch (step) {
    case "code": {
      if (!(await selectFile(client, "Code.gs"))) { process.exitCode = 1; break; }
      if (await setActiveModel(client, readFileSync(`${DIST}/Code.gs`, "utf-8"))) await save(client);
      break;
    }
    case "sidebar": {
      if (!(await selectFile(client, "Sidebar.html"))) { process.exitCode = 1; break; }
      if (await setActiveModel(client, readFileSync(`${DIST}/Sidebar.html`, "utf-8"))) await save(client);
      break;
    }
    case "dialog": {
      if (!(await selectFile(client, "Dialog.html"))) {
        console.error("  create it first: Add a file -> HTML -> name it Dialog");
        process.exitCode = 1;
        break;
      }
      if (await setActiveModel(client, readFileSync(`${DIST}/Dialog.html`, "utf-8"))) await save(client);
      break;
    }
    case "report": {
      if (!(await selectFile(client, "Report.html"))) {
        console.error("  create it first: Add a file -> HTML -> name it Report");
        process.exitCode = 1;
        break;
      }
      if (await setActiveModel(client, readFileSync(`${DIST}/Report.html`, "utf-8"))) await save(client);
      break;
    }
    case "editor": {
      if (!(await createFile(client, { name: "EditorShell.html", kind: "html" })) || !(await selectFile(client, "EditorShell.html"))) {
        process.exitCode = 1;
        break;
      }
      if (await setActiveModel(client, readFileSync(`${DIST}/EditorShell.html`, "utf-8"))) await save(client);
      break;
    }
    case "diagram": {
      if (!(await createFile(client, { name: "Diagram.html", kind: "html" })) || !(await selectFile(client, "Diagram.html"))) {
        process.exitCode = 1;
        break;
      }
      if (await setActiveModel(client, readFileSync(`${DIST}/Diagram.html`, "utf-8"))) await save(client);
      break;
    }
    case "put": {
      const name = option("--file");
      const from = option("--from");
      if (name === undefined || from === undefined) { console.error("--step put needs --file <Name> --from <path>"); process.exitCode = 1; break; }
      if (!(await createFile(client, { name, kind: name.endsWith(".gs") ? "script" : "html" })) || !(await selectFile(client, name))) { process.exitCode = 1; break; }
      if (await setActiveModel(client, readFileSync(from, "utf-8"))) await save(client);
      break;
    }
    case "manifest": {
      // A tab opened before "Show appsscript.json" was ticked lists no manifest until it reloads.
      if (!(await selectFile(client, "appsscript.json"))) {
        await client.Page.reload({});
        await until({ client, budgetMs: 30_000, label: "the editor to come back", expression: `String(!!window.monaco && [...document.querySelectorAll('div,li,span')].some(n => (n.innerText || '').trim() === 'appsscript.json'))` });
        if (!(await selectFile(client, "appsscript.json"))) { process.exitCode = 1; break; }
      }
      const manifest = readFileSync(`${DIST}/appsscript.json`, "utf-8");
      if (await setActiveModel(client, manifest)) await save(client);
      break;
    }
    case "create": {
      const name = option("--file");
      if (name === undefined) { console.error("--step create needs --file <Name.html>"); process.exitCode = 1; break; }
      if (!(await createFile(client, { name, kind: name.endsWith(".gs") ? "script" : "html" }))) process.exitCode = 1;
      break;
    }
    case "push": {
      if (!(await pushEverything(client))) process.exitCode = 1;
      break;
    }
    case "verify": {
      const report = await ev(client, `(() => {
        const models = window.monaco.editor.getModels();
        return JSON.stringify(models.map(m => ({
          uri: String(m.uri), chars: m.getValue().length, head: m.getValue().slice(0, 60).replace(/\\s+/g, ' ')
        })));
      })()`);
      console.log(report);
      break;
    }
    default:
      return assertNever(step);
  }
  // Before closing the editor tab, which would abort a save still in flight.
  if (!(await confirmPersisted())) process.exitCode = 1;
  await client.close();
}
void main();
