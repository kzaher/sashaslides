import CDP from "chrome-remote-interface";
import { writeFileSync } from "node:fs";

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY")
  );
  if (!tab) { console.error("No original tab"); process.exit(1); }

  const client = await CDP({ target: tab });
  const { Runtime, Input, Page, Target } = client;
  await Page.enable();
  await Target.activateTarget({ targetId: tab.id });
  await new Promise(r => setTimeout(r, 1000));

  // Scroll filmstrip to top then count all slides
  await Runtime.evaluate({
    expression: `(() => {
      const filmstrip = document.querySelector('.punch-filmstrip-scroll');
      if (filmstrip) filmstrip.scrollTop = 0;
    })()`,
  });
  await new Promise(r => setTimeout(r, 800));

  // Scroll to bottom to force all thumbnails to render
  await Runtime.evaluate({
    expression: `(() => {
      const filmstrip = document.querySelector('.punch-filmstrip-scroll');
      if (filmstrip) filmstrip.scrollTop = filmstrip.scrollHeight;
    })()`,
  });
  await new Promise(r => setTimeout(r, 800));

  const count = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  console.log(`Slide count: ${count.result.value}`);

  // Scroll back to top
  await Runtime.evaluate({
    expression: `(() => {
      const filmstrip = document.querySelector('.punch-filmstrip-scroll');
      if (filmstrip) filmstrip.scrollTop = 0;
    })()`,
  });
  await new Promise(r => setTimeout(r, 500));

  // Take screenshot of current view
  const screenshot = await Page.captureScreenshot({ format: "png" });
  writeFileSync("/workspaces/sashaslides/presentations/1/screenshots/original_state.png", Buffer.from(screenshot.data, "base64"));
  console.log("Screenshot: original_state.png");

  await client.close();
}
main().catch(console.error);
