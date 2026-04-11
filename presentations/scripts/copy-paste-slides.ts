/**
 * copy-paste-slides.ts
 *
 * Copies all slides from the styled RobPresentation and pastes them into
 * the original presentation via CDP keyboard shortcuts. Google Slides preserves
 * styles, fonts, colors, and images when pasting slides.
 *
 * Steps:
 * 1. Focus the styled presentation tab, click filmstrip, Ctrl+A to select all slides, Ctrl+C
 * 2. Switch to original presentation, click filmstrip, Ctrl+A, Delete (removes all but 1)
 * 3. Ctrl+V to paste the 19 styled slides
 * 4. Delete the leftover first slide
 */

import CDP from "chrome-remote-interface";

const ORIGINAL_ID = "1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY";
const STYLED_ID = "1yYcZXgK2MGr7kdvt613iX7f7GJwmnG1D";

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

async function findFilmstripFirstThumb(runtime: any): Promise<{ x: number; y: number } | null> {
  const result = await runtime.evaluate({
    expression: `(() => {
      const thumb = document.querySelector('.punch-filmstrip-thumbnail');
      if (!thumb) return null;
      const r = thumb.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`,
    returnByValue: true,
  });
  return result.result.value || null;
}

async function getSlideCount(runtime: any): Promise<number> {
  const result = await runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  return result.result.value as number;
}

async function focusPresentationTab(id: string): Promise<CDP.Client> {
  const targets = await CDP.List({ port: 9222 });
  let tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes(id)
  );

  if (!tab) {
    console.log(`Opening presentation ${id}...`);
    tab = await CDP.New({
      port: 9222,
      url: `https://docs.google.com/presentation/d/${id}/edit`,
    });
    await sleep(6000);
  }

  const client = await CDP({ target: tab });
  const { Page, Target } = client;
  await Page.enable();

  // Bring this tab to foreground
  await Target.activateTarget({ targetId: tab.id });
  await sleep(800);

  return client;
}

async function main() {
  console.log("=== Step 1: Copy all slides from styled presentation ===");
  const styledClient = await focusPresentationTab(STYLED_ID);
  const styledRuntime = styledClient.Runtime;
  const styledInput = styledClient.Input;

  // Dismiss any "Welcome to Office" popup
  const dismissResult = await styledRuntime.evaluate({
    expression: `(() => {
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        if (b.textContent?.trim() === 'Got it') {
          const r = b.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });
  if (dismissResult.result.value) {
    const pos = dismissResult.result.value as { x: number; y: number };
    await clickAt(styledInput, pos.x, pos.y);
    await sleep(800);
  }

  // Click on first thumbnail in filmstrip
  const styledFirst = await findFilmstripFirstThumb(styledRuntime);
  if (!styledFirst) {
    console.error("Could not find filmstrip in styled presentation");
    process.exit(1);
  }

  const styledSlideCount = await getSlideCount(styledRuntime);
  console.log(`Styled presentation has ${styledSlideCount} slides`);

  await clickAt(styledInput, styledFirst.x, styledFirst.y);
  await sleep(500);

  // Ctrl+A to select all slides in filmstrip
  await pressKey(styledInput, "a", 65, 2);
  await sleep(400);

  // Ctrl+C to copy
  await pressKey(styledInput, "c", 67, 2);
  await sleep(1200);
  console.log("  Copied all slides to clipboard");

  await styledClient.close();

  console.log("\n=== Step 2: Clear & paste into original presentation ===");
  const origClient = await focusPresentationTab(ORIGINAL_ID);
  const origRuntime = origClient.Runtime;
  const origInput = origClient.Input;

  // Get original slide count
  const origSlideCount = await getSlideCount(origRuntime);
  console.log(`Original presentation has ${origSlideCount} slides`);

  // Click on first thumbnail
  const origFirst = await findFilmstripFirstThumb(origRuntime);
  if (!origFirst) {
    console.error("Could not find filmstrip in original presentation");
    process.exit(1);
  }

  await clickAt(origInput, origFirst.x, origFirst.y);
  await sleep(500);

  // Paste — this should insert the copied slides AFTER the current slide
  await pressKey(origInput, "v", 86, 2);
  console.log("  Pasting slides (may take a moment)...");
  await sleep(8000);

  // Check new count
  const afterPasteCount = await getSlideCount(origRuntime);
  console.log(`After paste: ${afterPasteCount} slides`);

  if (afterPasteCount > styledSlideCount) {
    // Need to delete the original slide(s) that remained
    // They're the first `origSlideCount` slides (before the pasted ones)
    console.log(`Deleting ${origSlideCount} original slide(s)...`);

    for (let i = 0; i < origSlideCount; i++) {
      // Click on the first thumbnail (always index 0 since we delete as we go)
      const first = await findFilmstripFirstThumb(origRuntime);
      if (!first) break;
      await clickAt(origInput, first.x, first.y);
      await sleep(300);
      // Delete
      await pressKey(origInput, "Delete", 46);
      await sleep(600);
    }

    const finalCount = await getSlideCount(origRuntime);
    console.log(`Final slide count: ${finalCount}`);
  }

  await origClient.close();
  console.log("\nDone! The original presentation now has the whiteboard styling.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
