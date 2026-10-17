// ACCEPTANCE 7: measured layout in a real layout engine. A table cell with long text grows its row,
// and the canvas reports the grown height (`layoutMeasured` with the table's row heights); a text
// box set to grow with its text reports the height its text needs. A short row is the control: it
// stays at its stored minimum.
//
//   npx tsx e2e/editor/measurement.ts
//
// Chrome must be listening on 127.0.0.1:9223. Whole run: under 20 seconds.

import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveDirectory } from "../../serve-directory.ts";
import { buildHarness, settle, withPage } from "./editor-session.ts";

const bundle = join(tmpdir(), "sasha-editor-harness");
await buildHarness(bundle);
await using server = await serveDirectory({ directory: bundle, host: "127.0.0.1" });

const measured = await withPage({ address: `${server.address}?scenario=measure`, scheme: "light", reducedMotion: true }, async (tab) => {
  await settle(tab);
  await tab.waitFor(`window.sashaHarness.dispatched.filter((event) => event.kind === "layoutMeasured").length >= 2`, 4000);
  return tab.evaluate(`(() => {
    const state = window.sashaHarness.state();
    const slide = state.document.slides[0];
    const table = slide.elements[0];
    const box = slide.elements[1];
    const events = window.sashaHarness.dispatched.filter((event) => event.kind === "layoutMeasured");
    const last = (id) => events.filter((event) => event.elementId === id).at(-1)?.measurement ?? null;
    return { rowMinimums: table.rows.map((row) => row.minimumHeight), table: last(table.id), boxHeight: box.frame.height, text: last(box.id) };
  })()`);
});

console.log(JSON.stringify(measured, null, 2));
const record = typeof measured === "object" && measured !== null ? measured : {};
const minimums = Reflect.get(record, "rowMinimums");
const table = Reflect.get(record, "table");
const text = Reflect.get(record, "text");
const rows = typeof table === "object" && table !== null ? Reflect.get(table, "rowHeights") : null;
const heights = Array.isArray(rows) ? rows.map((row: unknown) => Number(typeof row === "object" && row !== null ? Reflect.get(row, "height") : Number.NaN)) : [];
const minimum = Array.isArray(minimums) ? minimums.map(Number) : [];
const contentHeight = typeof text === "object" && text !== null ? Number(Reflect.get(text, "contentHeight")) : Number.NaN;
const boxHeight = Number(Reflect.get(record, "boxHeight"));
const failures = [
  ...((heights[1] ?? 0) > (minimum[1] ?? Number.POSITIVE_INFINITY) + 10 ? [] : [`the long row did not grow: ${heights[1]} against a minimum of ${minimum[1]}`]),
  ...(Math.abs((heights[0] ?? 0) - (minimum[0] ?? 0)) <= 1.5 ? [] : [`the short row should stay at its minimum: ${heights[0]} against ${minimum[0]}`]),
  ...(contentHeight > boxHeight + 10 ? [] : [`the growing text box reported ${contentHeight} for a box of ${boxHeight}`]),
];
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("measured layout: the long row grew, the short row stayed, the text box reported its content height");
}
