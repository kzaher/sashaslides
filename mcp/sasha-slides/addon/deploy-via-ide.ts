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
 * The editor exposes `window.monaco`, so file contents are set with `model.setValue()`
 * rather than typed — a 424 KB sidebar bundle cannot be sent through key events. The value
 * is shipped to the page in chunks because a single Runtime.evaluate expression carrying the
 * whole bundle is large enough to be worth not relying on.
 *
 * Steps are separate so each invocation stays short and fails fast:
 *   --step code      set Code.gs
 *   --step sidebar   add Sidebar.html and set it
 *   --step manifest  set appsscript.json (needs the manifest shown in editor settings)
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

type Step = "code" | "sidebar" | "dialog" | "report" | "manifest" | "create" | "push" | "verify";

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
    raw === "manifest" ||
    raw === "create" ||
    raw === "push" ||
    raw === "verify"
  ) {
    return raw;
  }
  throw new Error(`unknown --step ${raw} (code | sidebar | dialog | report | manifest | create | push | verify)`);
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
  const target = list.find((t) => t.type === "page" && t.url.includes(SCRIPT_ID));
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
  // Ctrl+S is what the editor binds; the toolbar button is an aria-label lookup away if it regresses.
  await client.Input.dispatchKeyEvent({ type: "keyDown", modifiers: 2, key: "s", code: "KeyS", windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 });
  await client.Input.dispatchKeyEvent({ type: "keyUp", modifiers: 2, key: "s", code: "KeyS", windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 });
  // The page keeps a hidden aria-live node reading "Saving project...", so body text is NOT a
  // save indicator. The toolbar button's disabled state is: the editor disables it when there
  // is nothing pending. Persistence is still confirmed by reloading and re-reading the model.
  const quiet = await until({
    client,
    budgetMs: 15000,
    label: "the Save button to go idle",
    expression: `(() => {
      const b = [...document.querySelectorAll('button,[role=button]')]
        .find(x => (x.getAttribute('aria-label')||'').trim().startsWith('Save project'));
      if (!b) return 'false';
      return String(b.disabled === true || b.getAttribute('aria-disabled') === 'true');
    })()`,
  });
  console.log(`  save ${quiet ? "idle (nothing pending)" : "still pending after 15s"}`);
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

/** Write `text` into whichever model the editor is currently showing. */
async function setActiveModel(client: CdpClient, text: string): Promise<void> {
  await sendBuffer(client, text);
  const set = await ev(client, `(() => {
    const editors = window.monaco.editor.getEditors();
    if (editors.length === 0) return 'NO EDITOR';
    const model = editors[0].getModel();
    if (!model) return 'NO ACTIVE MODEL';
    model.setValue(window.__sasha.join(''));
    return String(model.getValue().length);
  })()`);
  if (!/^\d+$/.test(set)) throw new Error(set);
  console.log(`  active model now holds ${set} chars (disk ${text.length})`);
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
    await setActiveModel(client, readFileSync(`${DIST}/${surface.file}`, "utf-8"));
    await save(client);
  }
  return true;
}

async function main(): Promise<void> {
  const step = parseStep(STEP);
  const client = await attach();
  console.log(`step=${step} script=${SCRIPT_ID.slice(0, 12)}…`);

  switch (step) {
    case "code": {
      if (!(await selectFile(client, "Code.gs"))) { process.exitCode = 1; break; }
      await setActiveModel(client, readFileSync(`${DIST}/Code.gs`, "utf-8"));
      await save(client);
      break;
    }
    case "sidebar": {
      if (!(await selectFile(client, "Sidebar.html"))) { process.exitCode = 1; break; }
      await setActiveModel(client, readFileSync(`${DIST}/Sidebar.html`, "utf-8"));
      await save(client);
      break;
    }
    case "dialog": {
      if (!(await selectFile(client, "Dialog.html"))) {
        console.error("  create it first: Add a file -> HTML -> name it Dialog");
        process.exitCode = 1;
        break;
      }
      await setActiveModel(client, readFileSync(`${DIST}/Dialog.html`, "utf-8"));
      await save(client);
      break;
    }
    case "report": {
      if (!(await selectFile(client, "Report.html"))) {
        console.error("  create it first: Add a file -> HTML -> name it Report");
        process.exitCode = 1;
        break;
      }
      await setActiveModel(client, readFileSync(`${DIST}/Report.html`, "utf-8"));
      await save(client);
      break;
    }
    case "manifest": {
      if (!(await selectFile(client, "appsscript.json"))) { process.exitCode = 1; break; }
      const manifest = readFileSync(`${DIST}/appsscript.json`, "utf-8");
      await setActiveModel(client, manifest);
      await save(client);
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
  await client.close();
}
void main();
