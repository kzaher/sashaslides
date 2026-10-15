// THE PRESENTER IN CHROME, end to end (acceptance tests 8, 10, 11 and 12): builds the runner page
// (build-presenter.ts) and the scenario page (src/presenter/testing/browser-scenarios.tsx), serves
// them on two sites, and drives Chrome over the debugging protocol.
//
//   suite    the in-browser checks (runner frame attributes, no frame for built-ins, an in-page
//            built-in on the real stage, the speaker view in a given window with requestFullscreen
//            and window.open spied, TransitionPreview's onEnded and restart)
//   show     the ink-wipe example through the runner on the second site, with a mid-transition
//            screenshot of the clip reveal; the push built-in bundled as a script through the same
//            runner; a busy-loop script that must be cut as `stalled` within the stall budget while
//            the host keeps running timers and handling input (proof the runner is out of process)
//   speaker  a screenshot of the speaker view
//
// Usage (every command under the watchdog, per the project rules):
//   npx tsx e2e/presenter/presenter-e2e.ts --chrome http://127.0.0.1:9223 --screenshots <directory>
// Screenshots are written to <directory> for inspection; the summary is printed as JSON, and the
// exit status is 1 when any check failed.

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildPresenterAssets } from "../../build-presenter.ts";
import { ChromeConnection, ChromePage } from "./cdp-client.ts";
import { serveTwoSites, type TwoSites } from "./two-sites.ts";

type Check = Readonly<{ name: string; ok: boolean; detail: string }>;

const VIEWPORT = { width: 1280, height: 720 } as const;
/** Ping interval + stall timeout + one fast tick of the presenter's clock + the driver's polling. */
const STALL_BUDGET_MILLISECONDS = 250 + 2000 + 100 + 400;

await main();

async function main(): Promise<void> {
  const chromeAddress = argument("--chrome") ?? "http://127.0.0.1:9223";
  const screenshots = argument("--screenshots") ?? "/tmp/sasha-engine-e2e/presenter";
  await mkdir(screenshots, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "sasha-presenter-e2e-"));
  progress(`building into ${work}`);
  const built = await buildPages(work);
  await using sites = await serveTwoSites({ editorDirectory: join(work, "editor"), runnerDirectory: join(work, "runner"), runnerContentSecurityPolicy: built.runnerContentSecurityPolicy });
  progress(`editor ${sites.editorAddress}, runner ${sites.runnerAddress}`);
  using connection = await ChromeConnection.open({ debuggingAddress: chromeAddress });
  const checks: Check[] = [];
  checks.push(...(await suite({ connection, sites })));
  checks.push(...(await show({ connection, sites, screenshots })));
  checks.push(...(await speaker({ connection, sites, screenshots })));
  console.log(JSON.stringify({ screenshots, checks }, null, 2));
  process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
}

async function buildPages(work: string): Promise<Readonly<{ runnerContentSecurityPolicy: string }>> {
  const runner = await buildPresenterAssets({ outputDirectory: join(work, "runner"), minify: false });
  const editor = join(work, "editor");
  await mkdir(editor, { recursive: true });
  const source = (path: string): string => fileURLToPath(new URL(`../../src/presenter/testing/${path}`, import.meta.url));
  await build({
    entryPoints: [source("browser-scenarios.tsx")],
    outfile: join(editor, "scenarios.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  await build({ entryPoints: [source("builtin-push-script.ts")], outfile: join(editor, "builtin-push-script.js"), bundle: true, format: "iife", platform: "browser", target: "es2022", logLevel: "warning" });
  await writeFile(
    join(editor, "index.html"),
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Presenter scenarios</title></head><body><div id="application"></div><script src="scenarios.js"></script></body></html>\n`,
  );
  return { runnerContentSecurityPolicy: runner.runnerContentSecurityPolicy };
}

async function suite(options: Readonly<{ connection: ChromeConnection; sites: TwoSites }>): Promise<readonly Check[]> {
  progress("suite");
  await using page = await ChromePage.open({ connection: options.connection, ...VIEWPORT });
  await page.navigate(scenarioAddress({ sites: options.sites, scenario: "suite" }));
  const results = await page.waitFor<readonly Check[]>({ expression: "window.sashaSuite && window.sashaSuite.done && window.sashaSuite.results", what: "the in-browser suite", timeoutMilliseconds: 30_000 });
  return results.map((result) => ({ ...result, name: `browser: ${result.name}` }));
}

async function show(options: Readonly<{ connection: ChromeConnection; sites: TwoSites; screenshots: string }>): Promise<readonly Check[]> {
  progress("show");
  const checks: Check[] = [];
  await using page = await ChromePage.open({ connection: options.connection, ...VIEWPORT });
  await page.navigate(scenarioAddress({ sites: options.sites, scenario: "show" }));
  const shot = async (name: string): Promise<void> => writeFile(join(options.screenshots, name), await page.screenshot());
  const root = "document.querySelector('.sasha-presentation')";
  const attribute = (name: string): Promise<string> => page.evaluate<string>(`${root}?.getAttribute('${name}') ?? ''`);
  await page.waitFor({ expression: `${root}?.dataset.screen === 'slide' && document.visibilityState === 'visible'`, what: "the first slide", timeoutMilliseconds: 5000 });
  await page.waitFor({ expression: "document.querySelector('iframe.sasha-runner-frame') !== null", what: "the warm spare runner", timeoutMilliseconds: 3000 });
  await page.movePointer({ x: 640, y: 400 });
  await shot("01-first-slide-with-controls.png");

  progress("ink wipe through the runner");
  await page.pressKey("ArrowRight");
  await page.waitFor({ expression: `${root}?.dataset.runPhase === 'running'`, what: "the ink wipe running", timeoutMilliseconds: 4000 });
  await delay(1000);
  await shot("02-ink-wipe-mid-transition.png");
  await page.waitFor({ expression: `${root}?.dataset.screen === 'slide' && ${root}?.dataset.slideId === 'slide_b'`, what: "the ink wipe finishing", timeoutMilliseconds: 5000 });
  const afterInk = await attribute("data-last-fallback");
  checks.push({ name: "the ink-wipe example runs through the runner on the second site and finishes", ok: afterInk === "", detail: `fallback after the ink wipe: ${JSON.stringify(afterInk)}` });

  progress("built-in push through the runner");
  await page.pressKey("ArrowRight");
  await page.waitFor({ expression: `${root}?.dataset.runPhase === 'running'`, what: "the push script running", timeoutMilliseconds: 4000 });
  await delay(450);
  await shot("03-builtin-push-through-runner-mid.png");
  await page.waitFor({ expression: `${root}?.dataset.screen === 'slide' && ${root}?.dataset.slideId === 'slide_c'`, what: "the push finishing", timeoutMilliseconds: 5000 });
  const afterPush = await attribute("data-last-fallback");
  checks.push({ name: "a built-in also runs through the runner over the protocol", ok: afterPush === "", detail: `fallback after the push: ${JSON.stringify(afterPush)}` });

  progress("busy loop");
  await page.pressKey("ArrowRight");
  await page.waitFor({ expression: `${root}?.dataset.runPhase === 'running'`, what: "the busy loop running", timeoutMilliseconds: 4000 });
  const runningAt = Date.now();
  const heartbeatBefore = await page.evaluate<number>("window.sashaHeartbeat");
  const movesBefore = await page.evaluate<number>("window.sashaPointerMoves");
  await delay(800);
  for (const x of [300, 500, 700]) await page.movePointer({ x, y: 300 });
  const heartbeatDuring = await page.evaluate<number>("window.sashaHeartbeat");
  const movesDuring = await page.evaluate<number>("window.sashaPointerMoves");
  // The busy script declares 6 seconds, so only a stall (not an overrun) can end it this early.
  await page.waitFor({ expression: `${root}?.dataset.lastFallback !== ''`, what: "the stall cut", timeoutMilliseconds: 6000 });
  const reason = await attribute("data-last-fallback");
  const cutAfter = Date.now() - runningAt;
  const landedOn = await attribute("data-slide-id");
  await shot("04-after-the-stall-cut.png");
  checks.push({
    name: "a busy-loop script stalls and the presenter cuts within the stall budget",
    ok: reason === "stalled" && cutAfter <= STALL_BUDGET_MILLISECONDS && landedOn === "slide_d",
    detail: `${reason} ${cutAfter} milliseconds after the frame showed (budget ${STALL_BUDGET_MILLISECONDS}); on ${landedOn}`,
  });
  checks.push({
    name: "the host keeps running timers and handling input while the runner spins (another process)",
    ok: heartbeatDuring - heartbeatBefore >= 8 && movesDuring - movesBefore >= 3,
    detail: `host heartbeat +${heartbeatDuring - heartbeatBefore} in 0.8 seconds, pointer moves +${movesDuring - movesBefore}`,
  });

  progress("end screen");
  await page.pressKey("ArrowRight");
  await page.waitFor({ expression: `${root}?.dataset.slideId === 'slide_e' && ${root}?.dataset.screen === 'slide'`, what: "the last slide", timeoutMilliseconds: 3000 });
  await page.pressKey("ArrowRight");
  await page.waitFor({ expression: `${root}?.dataset.screen === 'end'`, what: "the end screen", timeoutMilliseconds: 3000 });
  await delay(400);
  await shot("05-end-screen.png");
  return checks;
}

async function speaker(options: Readonly<{ connection: ChromeConnection; sites: TwoSites; screenshots: string }>): Promise<readonly Check[]> {
  progress("speaker view");
  await using page = await ChromePage.open({ connection: options.connection, ...VIEWPORT });
  await page.navigate(scenarioAddress({ sites: options.sites, scenario: "speaker" }));
  const speakerReady = "document.getElementById('speaker-window')?.contentDocument?.querySelector('[data-speaker-notes]') ? true : false";
  try {
    await page.waitFor({ expression: speakerReady, what: "the speaker view", timeoutMilliseconds: 5000 });
  } catch (error) {
    const evidence = await page.evaluate<string>(
      "JSON.stringify({ frames: document.querySelectorAll('iframe').length, speakerBody: (document.getElementById('speaker-window')?.contentDocument?.body?.innerHTML ?? 'none').slice(0, 300), root: document.querySelector('.sasha-presentation')?.outerHTML.slice(0, 300) ?? 'none' })",
    );
    return [{ name: "the speaker view renders in its window", ok: false, detail: `${String(error)}; ${evidence}` }];
  }
  await delay(600);
  await writeFile(join(options.screenshots, "06-speaker-view.png"), await page.screenshot());
  return [];
}

function scenarioAddress(options: Readonly<{ sites: TwoSites; scenario: string }>): string {
  return `${options.sites.editorAddress}/index.html?scenario=${options.scenario}&runner=${encodeURIComponent(`${options.sites.runnerAddress}/index.html`)}`;
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function progress(message: string): void {
  console.error(`[presenter-e2e ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

/** A deliberate pause to capture a moment of an animation; never used to wait for state. */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
