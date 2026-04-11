/**
 * Clicks "Select all slides" then "Import slides" to complete the import.
 * After import, deletes the original 19 plain slides (they'll be at the start).
 * Then takes screenshots of slides 1, 4, 8, 15 for verification.
 */

import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function pressKey(input: any, key: string, keyCode: number, modifiers = 0) {
  await input.dispatchKeyEvent({ type: "rawKeyDown", key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
  await sleep(30);
  await input.dispatchKeyEvent({ type: "keyUp", key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
}

async function clickAt(input: any, x: number, y: number) {
  await input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(50);
  await input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("1xegFC0RQiZd")
  );
  if (!tab) { console.error("No tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Runtime, Input, Target, Page } = client;
  await Page.enable();
  await Target.activateTarget({ targetId: tab.id });
  await sleep(500);

  // Click "Select all slides" at (813, 93) (center of button, not edge)
  console.log("Clicking 'Select all slides'...");
  const selectAllResult = await Runtime.evaluate({
    expression: `(() => {
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        if (b.textContent?.trim() === 'Select all slides') {
          const r = b.getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });
  if (selectAllResult.result.value) {
    const pos = selectAllResult.result.value as { x: number; y: number };
    await clickAt(Input, pos.x, pos.y);
    console.log(`  Clicked at ${pos.x}, ${pos.y}`);
  } else {
    console.log("  Not found — trying fallback coords");
    await clickAt(Input, 813, 93);
  }
  await sleep(800);

  // Click "Import slides" button (at the bottom)
  console.log("Clicking 'Import slides' button...");
  const importResult = await Runtime.evaluate({
    expression: `(() => {
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        if (b.textContent?.trim() === 'Import slides') {
          const r = b.getBoundingClientRect();
          if (r.y > 400) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });
  if (importResult.result.value) {
    const pos = importResult.result.value as { x: number; y: number };
    await clickAt(Input, pos.x, pos.y);
    console.log(`  Clicked at ${pos.x}, ${pos.y}`);
  } else {
    console.log("  Not found — fallback");
    await clickAt(Input, 897, 575);
  }

  // Wait for import (can take a while for 19 slides with images)
  console.log("Waiting for import to complete (45s)...");
  await sleep(45000);

  // Count slides - scroll to bottom first to render all thumbnails
  await Runtime.evaluate({
    expression: `(() => {
      const fs = document.querySelector('.punch-filmstrip-scroll');
      if (fs) fs.scrollTop = fs.scrollHeight;
    })()`,
  });
  await sleep(800);
  let countResult = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  let slideCount = countResult.result.value as number;
  console.log(`Slide count after import: ${slideCount}`);

  // Delete first N slides where N = count - 19
  if (slideCount > 19) {
    const toDelete = slideCount - 19;
    console.log(`Deleting ${toDelete} slides...`);

    for (let i = 0; i < toDelete; i++) {
      console.log(`  Deleting slide ${i + 1}/${toDelete}...`);

      // Scroll to top to ensure first thumbnail is visible
      await Runtime.evaluate({
        expression: `(() => {
          const fs = document.querySelector('.punch-filmstrip-scroll');
          if (fs) fs.scrollTop = 0;
        })()`,
      });
      await sleep(300);

      // Click first thumbnail
      const thumbResult = await Runtime.evaluate({
        expression: `(() => {
          const thumb = document.querySelector('.punch-filmstrip-thumbnail');
          if (!thumb) return null;
          const r = thumb.getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        })()`,
        returnByValue: true,
      });

      if (thumbResult.result.value) {
        const pos = thumbResult.result.value as { x: number; y: number };
        await clickAt(Input, pos.x, pos.y);
        await sleep(300);
      }

      // Press Delete key
      await pressKey(Input, "Delete", 46);
      await sleep(700);

      // Recount
      countResult = await Runtime.evaluate({
        expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
        returnByValue: true,
      });
      slideCount = countResult.result.value as number;
      console.log(`    Slide count now: ${slideCount}`);

      if (slideCount === 19) break;
    }
  }

  console.log(`Final slide count: ${slideCount}`);

  // Create screenshots directory
  const screenshotDir = "/workspaces/sashaslides/presentations/1/screenshots";
  mkdirSync(screenshotDir, { recursive: true });

  // Take screenshots of slides 1, 4, 8, 15
  const slidesToCapture = [1, 4, 8, 15];

  for (const slideNum of slidesToCapture) {
    console.log(`Capturing screenshot for slide ${slideNum}...`);

    // Click the corresponding thumbnail
    const thumbResult = await Runtime.evaluate({
      expression: `(() => {
        const thumbs = document.querySelectorAll('.punch-filmstrip-thumbnail');
        if (thumbs.length < ${slideNum}) return null;
        const thumb = thumbs[${slideNum - 1}];
        const r = thumb.getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y + r.height/2 };
      })()`,
      returnByValue: true,
    });

    if (thumbResult.result.value) {
      const pos = thumbResult.result.value as { x: number; y: number };
      await clickAt(Input, pos.x, pos.y);
      await sleep(500);

      // Capture screenshot
      const screenshotResult = await Page.captureScreenshot({ format: "png" });
      const buffer = Buffer.from(screenshotResult.data, "base64");
      const filename = `${screenshotDir}/imported_slide_${String(slideNum).padStart(2, "0")}.png`;
      writeFileSync(filename, buffer);
      console.log(`  Saved: ${filename}`);
    }
  }

  // Scroll back to top
  await Runtime.evaluate({
    expression: `(() => {
      const fs = document.querySelector('.punch-filmstrip-scroll');
      if (fs) fs.scrollTop = 0;
    })()`,
  });
  await sleep(500);

  await client.close();
  console.log("Done!");
}
main().catch(console.error);
