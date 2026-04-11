/**
 * Close broken tabs and screenshot the actual original presentation.
 */
import CDP from "chrome-remote-interface";
import { writeFileSync } from "node:fs";

async function main() {
  const targets = await CDP.List({ port: 9222 });

  // Close all truncated 1xegFC0RQiZd/edit tabs (they're 404s)
  for (const t of targets) {
    if (t.type === "page" && t.url === "https://docs.google.com/presentation/d/1xegFC0RQiZd/edit") {
      console.log(`Closing broken tab: ${t.id}`);
      await CDP.Close({ port: 9222, id: t.id });
    }
  }

  // Find the real original presentation tab
  const updated = await CDP.List({ port: 9222 });
  const origTab = updated.find(
    (t: { type: string; url: string }) =>
      t.type === "page" &&
      t.url.includes("1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY")
  );

  if (!origTab) {
    console.error("No original tab found!");
    process.exit(1);
  }
  console.log(`Found original tab: ${origTab.url.slice(0, 80)}`);

  const client = await CDP({ target: origTab });
  const { Runtime, Target, Page } = client;
  await Target.activateTarget({ targetId: origTab.id });
  await Page.enable();
  await new Promise(r => setTimeout(r, 400));

  // Count slides
  const count = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  console.log(`Slide count: ${count.result.value}`);

  // Screenshot
  const ss = await Page.captureScreenshot({ format: "png" });
  writeFileSync("/workspaces/sashaslides/presentations/1/screenshots/real_original_state.png", Buffer.from(ss.data, "base64"));
  console.log("Screenshot: real_original_state.png");

  await client.close();
}

main().catch(console.error);
