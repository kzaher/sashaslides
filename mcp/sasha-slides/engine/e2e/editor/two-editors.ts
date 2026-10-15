// ACCEPTANCE 10 (presence): the demo's two editors, on two replicas joined by the model's in-memory
// loopback and presence hub, each show the other's cursor and selection. The driver selects an
// element in one editor and then drags a marquee there (the state module publishes a pointer while
// a gesture lasts), looks for the peer cursor and the peer selection outline in the other -- both
// ways round -- and screenshots the pair at 2400 x 1000, wide enough for two full editors.
//
//   npx tsx build-demo.ts --serve      (once)
//   npx tsx e2e/editor/two-editors.ts <output directory> [demo address]
//
// Chrome must be listening on 127.0.0.1:9223. Whole run: under 30 seconds.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Client } from "chrome-remote-interface";
import { evaluate, screenshot, waitFor, withPage } from "./editor-session.ts";

const output = process.argv[2] ?? join(tmpdir(), "sasha-engine-e2e");
const address = process.argv[3] ?? "http://127.0.0.1:8790/?editors=2";
await mkdir(output, { recursive: true });

const PANE = (index: number): string => `document.querySelectorAll(".sasha-view-demo-pane")[${index}]`;

const facts = await withPage({ address, scheme: "light", reducedMotion: true, viewport: { width: 2400, height: 1000 } }, async (client) => {
  await waitFor(client, `${PANE(1)}?.querySelector(".sasha-view-canvas-area [data-sasha-element-id]") !== null`, 15_000);
  await evaluate(client, `Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 2000))]).then(() => true)`);
  const firstToSecond = await actAndObserve({ client, actor: 0, observer: 1 });
  const secondToFirst = await actAndObserve({ client, actor: 1, observer: 0 });
  const path = join(output, "two-editors.png");
  await screenshot(client, path);
  return { firstToSecond, secondToFirst, path };
});

console.log(JSON.stringify(facts, null, 2));
const failures = [facts.firstToSecond, facts.secondToFirst].flatMap((seen, index) => [
  ...(seen.cursor ? [] : [`editor ${index === 0 ? 2 : 1} does not show the other's cursor`]),
  ...(seen.selection ? [] : [`editor ${index === 0 ? 2 : 1} does not show the other's selection`]),
]);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}

/** Selects the first element on the slide in `actor`, moves over the canvas, then reads `observer`. */
async function actAndObserve(options: Readonly<{ client: Client; actor: number; observer: number }>): Promise<Readonly<{ cursor: boolean; selection: boolean }>> {
  const { client } = options;
  const point = await evaluate(client, `(() => { const box = ${PANE(options.actor)}.querySelector(".sasha-view-canvas-area .sasha-slide-root [data-sasha-element-id]").getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
  const x = Number(typeof point === "object" && point !== null ? Reflect.get(point, "x") : 0);
  const y = Number(typeof point === "object" && point !== null ? Reflect.get(point, "y") : 0);
  await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  const observer = PANE(options.observer);
  const selection = await waitFor(client, `${observer}.querySelector(".sasha-view-peer-selection") !== null`, 4000).then(() => true, () => false);
  const corner = await evaluate(client, `(() => { const box = ${PANE(options.actor)}.querySelector(".sasha-view-canvas-area .sasha-slide-root").getBoundingClientRect(); return { x: box.left + 12, y: box.bottom - 12 }; })()`);
  const cornerX = Number(typeof corner === "object" && corner !== null ? Reflect.get(corner, "x") : 0);
  const cornerY = Number(typeof corner === "object" && corner !== null ? Reflect.get(corner, "y") : 0);
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x: cornerX, y: cornerY, button: "left", buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 6; step += 1) await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: cornerX + step * 10, y: cornerY - step * 6, button: "left", buttons: 1 });
  const cursor = await waitFor(client, `${observer}.querySelector(".sasha-view-peer-cursor") !== null`, 4000).then(() => true, () => false);
  if (options.actor === 0) await screenshot(client, join(output, "two-editors-during-marquee.png"));
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: cornerX + 60, y: cornerY - 36, button: "left", buttons: 0, clickCount: 1 });
  // Select the element again so the closing screenshot shows both selections.
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  return { cursor, selection };
}
