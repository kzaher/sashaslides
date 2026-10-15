// ACCEPTANCE 8: the editor chrome at 1440 x 900 in the light and dark schemes, one PNG per scenario,
// for a sub-agent to inspect (never the orchestrator); plus the computed-style facts a screenshot
// cannot prove -- no `backdrop-filter` on any panel, popover or dialog, and the calm wash animating
// only when motion is allowed.
//
//   npx tsx e2e/editor/screenshots.ts <output directory>
//
// Chrome must be listening on 127.0.0.1:9223. Whole run: under 90 seconds.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessScenario } from "../../src/view/testing/chrome-harness.tsx";
import { buildHarness, evaluate, screenshot, serveDirectory, settle, withPage } from "./editor-session.ts";

const SHOTS: readonly Readonly<{ scenario: HarnessScenario; scheme: "light" | "dark" }>[] = [
  { scenario: "editor", scheme: "light" },
  { scenario: "editor", scheme: "dark" },
  { scenario: "menuOverBlack", scheme: "light" },
  { scenario: "menuOverBlack", scheme: "dark" },
  { scenario: "contextMenu", scheme: "light" },
  { scenario: "scriptDialog", scheme: "light" },
  { scenario: "scriptDialog", scheme: "dark" },
  { scenario: "comments", scheme: "light" },
  { scenario: "comments", scheme: "dark" },
  { scenario: "text", scheme: "light" },
  { scenario: "filmstrip", scheme: "light" },
  { scenario: "addon", scheme: "dark" },
];

const output = process.argv[2] ?? join(tmpdir(), "sasha-engine-e2e");
await mkdir(output, { recursive: true });
const bundle = join(tmpdir(), "sasha-editor-harness");
await buildHarness(bundle);
await using server = await serveDirectory(bundle);

const report: Record<string, unknown>[] = [];
for (const shot of SHOTS) {
  const address = `${server.address}?scenario=${shot.scenario}`;
  const facts = await withPage({ address, scheme: shot.scheme, reducedMotion: false }, async (client) => {
    await settle(client);
    const path = join(output, `${shot.scenario}-${shot.scheme}.png`);
    await screenshot(client, path);
    const blurred = await evaluate(client, `[...document.querySelectorAll(".sasha-panel, .sasha-popover, .sasha-dialog, .sasha-card")].map((element) => getComputedStyle(element).backdropFilter).filter((value) => value !== "none")`);
    const wash = await evaluate(client, `getComputedStyle(document.querySelector(".sasha-calm-ground"), "::before").animationName`);
    const thumbnails = await evaluate(client, `document.querySelectorAll("[data-sasha-thumbnail]").length`);
    return { path, blurred, wash, thumbnails };
  });
  report.push({ ...shot, ...facts });
}

const reduced = await withPage({ address: `${server.address}?scenario=editor`, scheme: "light", reducedMotion: true }, async (client) => {
  await settle(client);
  return { wash: await evaluate(client, `getComputedStyle(document.querySelector(".sasha-calm-ground"), "::before").animationName`) };
});

console.log(JSON.stringify({ shots: report, reducedMotion: reduced }, null, 2));
const failures = [
  ...report.filter((entry) => Array.isArray(entry["blurred"]) && entry["blurred"].length > 0).map((entry) => `${String(entry["scenario"])}: backdrop-filter on chrome`),
  ...report.filter((entry) => entry["wash"] !== "sasha-calm-hue").map((entry) => `${String(entry["scenario"])}: the wash is not animating`),
  ...(reduced.wash === "none" ? [] : ["reduced motion: the wash still animates"]),
];
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
