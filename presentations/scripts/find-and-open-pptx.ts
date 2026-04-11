/**
 * Find the uploaded RobPresentation.pptx in Drive, get its file ID,
 * and open it as a Google Slides presentation.
 */

import CDP from "chrome-remote-interface";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const driveTab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("drive.google.com")
  );

  if (!driveTab) {
    console.error("No Drive tab found");
    process.exit(1);
  }

  const client = await CDP({ target: driveTab });
  const { Runtime, Page } = client;
  await Page.enable();

  // Refresh Drive to show the new file
  await Page.reload();
  await Page.loadEventFired();
  await sleep(5000);

  // Try to find the file ID by inspecting all elements with data-id attribute
  const fileResult = await Runtime.evaluate({
    expression: `(() => {
      // Look for all data-id attributes (Drive files have these)
      const items = document.querySelectorAll('[data-id]');
      const found = [];
      for (const item of items) {
        const text = (item.textContent || '').trim();
        const id = item.getAttribute('data-id');
        if (text.includes('RobPresentation') || text.includes('.pptx')) {
          found.push({ id, text: text.slice(0, 80) });
        }
      }

      // Also check tooltips
      const tooltips = document.querySelectorAll('[data-tooltip]');
      for (const t of tooltips) {
        const tt = t.getAttribute('data-tooltip') || '';
        if (tt.includes('RobPresentation') || tt.includes('.pptx')) {
          // Walk up to find data-id
          let parent = t.parentElement;
          while (parent && !parent.hasAttribute('data-id')) {
            parent = parent.parentElement;
          }
          if (parent) {
            found.push({ id: parent.getAttribute('data-id'), text: tt });
          }
        }
      }

      return found;
    })()`,
    returnByValue: true,
  });

  console.log("Found files:", fileResult.result.value);

  const files = fileResult.result.value as Array<{ id: string; text: string }>;
  if (!files || files.length === 0) {
    console.error("No matching files found in Drive");

    // Show what's actually in Drive
    const allFiles = await Runtime.evaluate({
      expression: `(() => {
        const items = document.querySelectorAll('[data-id]');
        return Array.from(items).slice(0, 30).map(i => ({
          id: i.getAttribute('data-id')?.slice(0, 30),
          text: (i.textContent || '').trim().slice(0, 60)
        }));
      })()`,
      returnByValue: true,
    });
    console.log("All Drive items:", allFiles.result.value);
    process.exit(1);
  }

  const fileId = files[0].id;
  console.log(`File ID: ${fileId}`);

  // Open as Google Slides
  const slidesUrl = `https://docs.google.com/presentation/d/${fileId}/edit`;
  console.log(`Opening: ${slidesUrl}`);

  const newTarget = await CDP.New({ port: 9222, url: slidesUrl });
  console.log(`Opened tab: ${newTarget.id}`);

  await sleep(5000);

  // Check if it loaded as Slides (or if Drive returned a "convert" prompt)
  const newClient = await CDP({ target: newTarget });
  const titleResult = await newClient.Runtime.evaluate({
    expression: "document.title",
    returnByValue: true,
  });
  console.log("New tab title:", titleResult.result.value);

  await newClient.close();
  await client.close();
}

main().catch(console.error);
