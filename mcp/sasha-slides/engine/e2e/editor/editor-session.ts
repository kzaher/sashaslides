// THE EDITOR'S END-TO-END PLUMBING: bundle the chrome harness (served by ../../serve-directory.ts)
// and drive Chrome through ../shared/chrome-session.ts -- one fresh tab per scenario, closed
// afterwards. Timeouts are seconds and every wait polls observable page state (the project's rules):
// a step that does not answer in a couple of seconds is reported, never waited out.

import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectBrowser, type Tab } from "../shared/chrome-session.ts";
import { editorPageMarkup, editorStylesheet } from "../../src/view/application/editor-page.ts";

export const VIEWPORT = { width: 1440, height: 900 } as const;

const ENGINE_DIRECTORY = fileURLToPath(new URL("../../", import.meta.url));

/** Bundles the harness into `directory` (index.html, editor.css, harness.js). */
export async function buildHarness(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await build({
    entryPoints: [join(ENGINE_DIRECTORY, "e2e/editor/harness-entry.ts")],
    bundle: true,
    format: "esm",
    target: "es2022",
    outfile: join(directory, "harness.js"),
    jsx: "automatic",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  await writeFile(join(directory, "editor.css"), editorStylesheet());
  await writeFile(join(directory, "index.html"), editorPageMarkup({ title: "Sasha editor harness", stylesheetPath: "editor.css", scriptPath: "harness.js", configuration: {} }));
}

export type PageOptions = Readonly<{ address: string; scheme: "light" | "dark"; reducedMotion: boolean; viewport?: Readonly<{ width: number; height: number }> }>;

/** Opens `address` in a fresh tab (1440 x 900 unless told otherwise) with the given media, runs `body`, closes the tab. */
export async function withPage<TResult>(options: PageOptions, body: (tab: Tab) => Promise<TResult>): Promise<TResult> {
  await using browser = await connectBrowser();
  const tab = await browser.openTab({ ...(options.viewport ?? VIEWPORT), scheme: options.scheme, reducedMotion: options.reducedMotion });
  await tab.navigate(options.address);
  return await body(tab);
}

/** Ready: the slide is drawn and the fonts have loaded (or two seconds passed). */
export const READY_EXPRESSION = `document.querySelector("[data-sasha-slide-id]") !== null && window.sashaHarness !== undefined`;

export async function settle(tab: Tab): Promise<void> {
  await tab.waitFor(READY_EXPRESSION, 4000);
  await tab.evaluate(`Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]).then(() => true)`);
  // Finite animations (a menu popping in) finish before the shot; the calm wash runs forever.
  await tab.evaluate(`Promise.race([Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))), new Promise((resolve) => setTimeout(resolve, 1500))]).then(() => true)`);
  await tab.evaluate(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
}
