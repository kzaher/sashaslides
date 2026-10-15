// ACCEPTANCE 9: with 200 elements on the slide and the calm wash running, one pointer move during a
// drag -- event, reduce, render -- stays under 4 milliseconds of main-thread time. The canvas marks
// each move before it dispatches and measures it in the layout effect of the render it caused
// (editable-canvas.tsx); this driver drags one element 80 steps with real input events and reads
// those measures back. It also checks the wash is paused while the drag lasts.
//
//   npx tsx e2e/editor/drag-budget.ts
//
// Chrome must be listening on 127.0.0.1:9223. Whole run: under 30 seconds.

import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildHarness, evaluate, serveDirectory, settle, withPage } from "./editor-session.ts";

const BUDGET_MILLISECONDS = 4;
const STEPS = 80;
const WARM_UP_STEPS = 5;

const bundle = join(tmpdir(), "sasha-editor-harness");
await buildHarness(bundle);
await using server = await serveDirectory(bundle);

const result = await withPage({ address: `${server.address}?scenario=drag`, scheme: "light", reducedMotion: false }, async (client) => {
  await settle(client);
  const elementCount = await evaluate(client, `document.querySelectorAll(".sasha-view-canvas-area .sasha-slide-root [data-sasha-element-id]").length`);
  const start = await evaluate(client, `(() => { const box = document.querySelectorAll(".sasha-view-canvas-area .sasha-slide-root [data-sasha-element-kind='shape']")[44].getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })()`);
  if (typeof start !== "object" || start === null) throw new Error("No element to drag");
  const x = Number(Reflect.get(start, "x"));
  const y = Number(Reflect.get(start, "y"));
  await evaluate(client, `performance.clearMeasures(); true`);
  await client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  let gestureDuringDrag = "";
  for (let step = 1; step <= STEPS; step += 1) {
    await client.Input.dispatchMouseEvent({ type: "mouseMoved", x: x + step * 3, y: y + step * 1.5, button: "left", buttons: 1 });
    if (step === STEPS / 2) gestureDuringDrag = String(await evaluate(client, `document.querySelector(".sasha-engine").getAttribute("data-gesture")`));
  }
  await client.Input.dispatchMouseEvent({ type: "mouseReleased", x: x + STEPS * 3, y: y + STEPS * 1.5, button: "left", buttons: 0, clickCount: 1 });
  const durations = await evaluate(client, `performance.getEntriesByName("sasha-pointer-move").map((entry) => entry.duration)`);
  const wash = await evaluate(client, `getComputedStyle(document.querySelector(".sasha-calm-ground"), "::before").animationName`);
  const gestureAfter = await evaluate(client, `document.querySelector(".sasha-engine").getAttribute("data-gesture")`);
  return { elementCount, durations: Array.isArray(durations) ? durations.map(Number) : [], wash, gestureDuringDrag, gestureAfter };
});

const measured = result.durations.slice(WARM_UP_STEPS);
const sorted = [...measured].sort((first, second) => first - second);
const percentile = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Number.NaN;
const summary = {
  elementsOnSlide: result.elementCount,
  washAnimation: result.wash,
  gestureDuringDrag: result.gestureDuringDrag,
  gestureAfter: result.gestureAfter,
  moves: result.durations.length,
  measuredAfterWarmUp: measured.length,
  medianMilliseconds: Number(percentile(0.5).toFixed(3)),
  ninetyFifthPercentileMilliseconds: Number(percentile(0.95).toFixed(3)),
  maximumMilliseconds: Number((sorted[sorted.length - 1] ?? Number.NaN).toFixed(3)),
  firstMovesMilliseconds: result.durations.slice(0, WARM_UP_STEPS).map((value) => Number(value.toFixed(3))),
};
console.log(JSON.stringify(summary, null, 2));
const failures = [
  ...(result.elementCount === 200 ? [] : [`expected 200 elements on the slide, found ${String(result.elementCount)}`]),
  ...(measured.length >= STEPS - WARM_UP_STEPS - 5 ? [] : [`only ${measured.length} moves were measured`]),
  ...(summary.maximumMilliseconds < BUDGET_MILLISECONDS ? [] : [`a pointer move took ${summary.maximumMilliseconds} milliseconds (budget ${BUDGET_MILLISECONDS})`]),
  ...(result.wash === "sasha-calm-hue" ? [] : ["the calm wash was not running"]),
  ...(result.gestureDuringDrag === "active" ? [] : ["the wash was not paused during the drag"]),
];
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
