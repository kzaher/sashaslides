/**
 * open-uploaded-pptx.ts
 *
 * Opens the most recently uploaded .pptx file from Drive in Google Slides.
 * Searches for RobPresentation.pptx and opens it.
 */

import CDP from "chrome-remote-interface";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function clickAt(input: any, x: number, y: number, dbl = false) {
  await input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: dbl ? 2 : 1 });
  await sleep(30);
  await input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: dbl ? 2 : 1 });
}

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const driveTab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("drive.google.com")
  );

  if (!driveTab) {
    console.error("No Drive tab open. Run upload-pptx-to-slides.ts first.");
    process.exit(1);
  }

  const client = await CDP({ target: driveTab });
  const { Runtime, Input } = client;

  // Find the RobPresentation.pptx file in Drive
  const fileResult = await Runtime.evaluate({
    expression: `(() => {
      // Drive shows files as rows or grid items
      const items = document.querySelectorAll('[role="gridcell"], [role="row"], [data-id]');
      for (const item of items) {
        const text = item.textContent || '';
        if (text.includes('RobPresentation')) {
          const r = item.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      // Fallback: search by data-tooltip
      const tooltips = document.querySelectorAll('[data-tooltip*="RobPresentation"]');
      for (const t of tooltips) {
        const r = t.getBoundingClientRect();
        if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (!fileResult.result.value) {
    console.log("Could not find RobPresentation.pptx in Drive view. Searching all files...");
    const allFiles = await Runtime.evaluate({
      expression: `(() => {
        const items = document.querySelectorAll('[data-id], [role="gridcell"]');
        return Array.from(items).slice(0, 20).map(i => (i.textContent || '').slice(0, 60));
      })()`,
      returnByValue: true,
    });
    console.log("Visible items:", allFiles.result.value);
    process.exit(1);
  }

  const filePos = fileResult.result.value as { x: number; y: number };
  console.log(`Found file at ${filePos.x}, ${filePos.y}, double-clicking...`);
  await clickAt(Input, filePos.x, filePos.y, true);
  await sleep(5000);

  // Wait for new tab to open with the presentation
  console.log("Waiting for Slides tab to open...");
  await sleep(3000);

  const allTargets = await CDP.List({ port: 9222 });
  const newSlidesTab = allTargets.find(
    (t: { type: string; url: string; id: string }) =>
      t.type === "page" && t.url.includes("docs.google.com/presentation") && !t.url.includes("1xegFC0RQiZd")
  );

  if (newSlidesTab) {
    console.log(`Opened in Slides: ${newSlidesTab.url}`);
  } else {
    console.log("New Slides tab not found. Available tabs:");
    for (const t of allTargets) {
      console.log(`  ${t.type}: ${t.url?.slice(0, 100)}`);
    }
  }

  await client.close();
}

main().catch(console.error);
