/**
 * Two tabs capturing at once, as parallel bug_solving forks do in one Chrome: each capture brings
 * its own tab to the front, which used to hide the other tab and stall its two-frame wait
 * ("two animation frames took longer than 2000 ms"). With a window per tab on the headless Chrome
 * both keep rendering (chrome-capture.ts, ONE WINDOW PER TAB).
 *
 * Needs the headless Chrome on DEFAULT_CAPTURE_CHROME_PORT (reverse-sxs.sh starts it).
 *   npx tsx --test reverse/chrome-capture.e2e.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAPTURE_CHROME_PORT, openChromeTab } from "./chrome-capture.ts";

// Ready a little after load, so one tab is still waiting when the other comes to the front.
const PAGE =
  "data:text/html," +
  encodeURIComponent(
    `<div id="root" data-sasha-export-ready="false" style="width:1280px;height:720px;background:#4338ca">x</div>` +
      `<script>setTimeout(() => document.getElementById("root").setAttribute("data-sasha-export-ready", "true"), 150)</script>`,
  );
const CAPTURES_PER_TAB = 6;

test("two tabs capturing at once both finish ready", { timeout: 60_000 }, async () => {
  await using first = await openChromeTab({ port: DEFAULT_CAPTURE_CHROME_PORT, deviceScaleFactor: 1 });
  await using second = await openChromeTab({ port: DEFAULT_CAPTURE_CHROME_PORT, deviceScaleFactor: 1 });
  const captureRepeatedly = async (tab: typeof first): Promise<string[]> => {
    const readiness: string[] = [];
    for (let index = 0; index < CAPTURES_PER_TAB; index += 1) {
      const capture = await tab.capture({ address: PAGE });
      assert.ok(capture.png.length > 0, "a capture has a picture");
      readiness.push(capture.readiness);
    }
    return readiness;
  };
  const [firstReadiness, secondReadiness] = await Promise.all([captureRepeatedly(first), captureRepeatedly(second)]);
  assert.deepEqual([...firstReadiness, ...secondReadiness], Array(2 * CAPTURES_PER_TAB).fill("ready"));
});
