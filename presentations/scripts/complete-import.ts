/**
 * Complete a stuck Import Slides dialog: select all + import button via
 * PointerEvent dispatches. Fast-fail polling.
 */
import { cdp as CDP, jsClick } from "./cdp.ts";
import { writeFileSync } from "node:fs";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY")
  );
  if (!tab) { console.error("No original tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Runtime, Target, Page } = client;
  await Target.activateTarget({ targetId: tab.id });
  await Page.enable();
  await sleep(300);

  // Click Select all slides via PointerEvent
  await jsClick(Runtime, { text: "Select all slides" });
  await sleep(500);

  // Click Import slides button via PointerEvent
  await jsClick(Runtime, { text: "Import slides", minY: 400 });

  // Fast-fail polling: wait up to 6s for slide count to reach >= 20
  const start = Date.now();
  let lastCount = 0;
  while (Date.now() - start < 8000) {
    const c = await Runtime.evaluate({
      expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
      returnByValue: true,
    });
    const n = c.result.value as number;
    if (n !== lastCount) {
      console.log(`  Count: ${n}`);
      lastCount = n;
    }
    if (n >= 20) break;
    await sleep(200);
  }

  // Final count after scroll
  await Runtime.evaluate({
    expression: `document.querySelector('.punch-filmstrip-scroll')?.scrollTo({top: 99999})`,
  });
  await sleep(300);
  const fin = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  console.log(`Final: ${fin.result.value} slides`);

  await Runtime.evaluate({
    expression: `document.querySelector('.punch-filmstrip-scroll')?.scrollTo({top: 0})`,
  });
  await sleep(300);

  const ss = await Page.captureScreenshot({ format: "png" });
  writeFileSync("/workspaces/sashaslides/presentations/1/screenshots/import_done.png", Buffer.from(ss.data, "base64"));
  console.log("Screenshot: import_done.png");

  await client.close();
}
main().catch(console.error);
