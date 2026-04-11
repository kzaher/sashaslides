/**
 * import-styled-slides.ts
 *
 * Uses the original presentation's File > Import slides feature to bring in
 * the 19 whiteboard-styled slides from the new presentation. Import slides
 * preserves styles, fonts, colors, backgrounds, and embedded images.
 *
 * Flow:
 * 1. Navigate to the original presentation
 * 2. File > Import slides
 * 3. Select the RobPresentation (styled) file
 * 4. Select all slides → Import
 * 5. Delete the original plain slides
 */

import CDP from "chrome-remote-interface";

const ORIGINAL_PRES_URL = "https://docs.google.com/presentation/d/1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY/edit";
const STYLED_PRES_NAME = "RobPresentation";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function pressKey(input: any, key: string, keyCode: number, modifiers = 0) {
  await input.dispatchKeyEvent({ type: "rawKeyDown", key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
  await sleep(30);
  await input.dispatchKeyEvent({ type: "keyUp", key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
}

async function clickAt(input: any, x: number, y: number) {
  await input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(40);
  await input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function findAndClickByText(client: CDP.Client, texts: string[], opts: { parentSelector?: string; maxY?: number } = {}): Promise<boolean> {
  const { Runtime, Input } = client;
  const parentSel = opts.parentSelector ? JSON.stringify(opts.parentSelector) : "null";
  const maxY = opts.maxY ?? 10000;
  const textList = JSON.stringify(texts);

  const result = await Runtime.evaluate({
    expression: `(() => {
      const texts = ${textList};
      const parent = ${parentSel} ? document.querySelector(${parentSel}) : document;
      if (!parent) return null;
      const candidates = parent.querySelectorAll('[role="menuitem"], [role="button"], button, span, div');
      for (const el of candidates) {
        const t = (el.textContent || '').trim();
        if (texts.some(tx => t === tx || t.startsWith(tx))) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.y < ${maxY}) {
            return { x: r.x + r.width/2, y: r.y + r.height/2, text: t.slice(0, 60) };
          }
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (result.result.value) {
    const pos = result.result.value as { x: number; y: number; text: string };
    console.log(`  Clicking "${pos.text}"`);
    await clickAt(Input, pos.x, pos.y);
    return true;
  }
  return false;
}

async function main() {
  console.log("Connecting to Chrome...");
  const targets = await CDP.List({ port: 9222 });

  // Find (or open) the original presentation tab
  let origTab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY")
  );

  if (!origTab) {
    console.log("Opening original presentation...");
    origTab = await CDP.New({ port: 9222, url: ORIGINAL_PRES_URL });
    await sleep(5000);
  }

  const client = await CDP({ target: origTab });
  const { Runtime, Input, Page } = client;
  await Page.enable();
  await sleep(2000);

  // Make sure the Templates panel is closed so menus are not obscured
  await Runtime.evaluate({
    expression: `(() => {
      const closeBtn = document.querySelector('[aria-label*="Close Templates" i], [aria-label*="Close" i][title*="Templates" i]');
      if (closeBtn) closeBtn.click();
    })()`,
  });
  await sleep(500);

  // Step 1: Click File menu
  console.log("Step 1: Opening File menu...");
  const fileMenuResult = await Runtime.evaluate({
    expression: `(() => {
      const menubar = document.querySelector('[role="menubar"]');
      if (!menubar) return null;
      const items = menubar.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        if (item.textContent?.trim() === 'File') {
          const r = item.getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (!fileMenuResult.result.value) {
    console.error("Could not find File menu");
    process.exit(1);
  }
  const filePos = fileMenuResult.result.value as { x: number; y: number };
  await clickAt(Input, filePos.x, filePos.y);
  await sleep(600);

  // Step 2: Click "Import slides"
  console.log("Step 2: Clicking 'Import slides'...");
  const found = await findAndClickByText(client, ["Import slides"]);
  if (!found) {
    console.error("Could not find 'Import slides' menu item");
    await pressKey(Input, "Escape", 27);
    process.exit(1);
  }
  await sleep(2500);

  // Step 3: In the picker dialog, find and click the RobPresentation file
  console.log("Step 3: Finding RobPresentation in picker...");

  // The picker is usually an iframe
  const pickerFrameResult = await Runtime.evaluate({
    expression: `(() => {
      const iframes = document.querySelectorAll('iframe');
      for (const f of iframes) {
        const r = f.getBoundingClientRect();
        if (r.width > 400 && r.height > 300) {
          return { w: r.width, h: r.height, src: (f.src || '').slice(0, 100) };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });
  console.log("  Picker iframe:", pickerFrameResult.result.value);

  // We need to find the picker iframe as a CDP target and interact with it
  await sleep(1500);

  const allTargets = await CDP.List({ port: 9222 });
  const pickerTarget = allTargets.find(
    (t: any) =>
      t.type === "iframe" &&
      (t.url.includes("docs.google.com/picker") ||
        t.url.includes("picker.google.com") ||
        t.url.includes("docs.google.com") && t.url.includes("picker"))
  );

  if (pickerTarget) {
    console.log(`  Picker target: ${pickerTarget.url.slice(0, 100)}`);
    const pickerClient = await CDP({ target: pickerTarget });
    const pickerRuntime = pickerClient.Runtime;

    // Search for the file via the search box
    const searchResult = await pickerRuntime.evaluate({
      expression: `(() => {
        const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
        for (const inp of inputs) {
          const r = inp.getBoundingClientRect();
          if (r.width > 100) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
        return null;
      })()`,
      returnByValue: true,
    });

    // Click the search input and type the file name
    if (searchResult.result.value) {
      const pos = searchResult.result.value as { x: number; y: number };
      // Mouse coordinates in the iframe context won't map directly; use keyboard
      // Focus the input via document.activeElement approach
      await pickerRuntime.evaluate({
        expression: `(() => {
          const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
          for (const inp of inputs) {
            const r = inp.getBoundingClientRect();
            if (r.width > 100) { inp.focus(); return 'focused'; }
          }
          return 'no input';
        })()`,
        returnByValue: true,
      });
      await sleep(300);
    }

    await pickerClient.close();
  } else {
    console.log("  No picker iframe target found — trying direct DOM interaction");
  }

  // Alternative: use keyboard to type the file name in the search box
  // The picker should have focus somewhere
  await Input.insertText({ text: STYLED_PRES_NAME });
  await sleep(1500);

  // Wait for results then click the first one
  await sleep(2000);

  // Try to click the RobPresentation file that appears
  // The picker results appear inside an iframe — access via main page DOM
  const clickResult = await Runtime.evaluate({
    expression: `(() => {
      // Search for any visible element containing "RobPresentation"
      const all = document.querySelectorAll('*');
      for (const el of all) {
        if (el.children.length === 0) {
          const text = (el.textContent || '').trim();
          if (text === 'RobPresentation' || text === 'RobPresentation.pptx') {
            // Click the parent container
            let clickable = el;
            while (clickable && clickable.getBoundingClientRect().width < 100) {
              clickable = clickable.parentElement;
            }
            if (clickable) {
              const r = clickable.getBoundingClientRect();
              return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width };
            }
          }
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (clickResult.result.value) {
    const pos = clickResult.result.value as { x: number; y: number; w: number };
    console.log(`  Clicking RobPresentation at ${pos.x}, ${pos.y}`);
    await clickAt(Input, pos.x, pos.y);
    await sleep(1000);
  } else {
    console.log("  Could not find RobPresentation in picker view via main DOM");
  }

  // Click "Select" button
  await sleep(500);
  const selectFound = await findAndClickByText(client, ["Select", "SELECT", "Open"]);
  if (selectFound) {
    console.log("  Clicked Select");
  }
  await sleep(3000);

  // Step 4: In the Import Slides dialog, click "Select slides" → "All"
  console.log("Step 4: Selecting all slides to import...");
  // Click "All" link
  const allClicked = await findAndClickByText(client, ["All", "Select all"]);
  if (allClicked) {
    await sleep(800);
  }

  // Keep "Keep original theme" checked (preserves the styling from the source)
  const keepThemeResult = await Runtime.evaluate({
    expression: `(() => {
      const checkboxes = document.querySelectorAll('[role="checkbox"], input[type="checkbox"]');
      for (const cb of checkboxes) {
        const label = cb.closest('label') || cb.parentElement;
        const text = (label?.textContent || '').trim();
        if (text.toLowerCase().includes('keep original theme') || text.toLowerCase().includes('original theme')) {
          const r = cb.getBoundingClientRect();
          const isChecked = cb.getAttribute('aria-checked') === 'true' || (cb as HTMLInputElement).checked;
          return { x: r.x + r.width/2, y: r.y + r.height/2, isChecked };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });
  console.log("  Keep original theme state:", keepThemeResult.result.value);
  const ktState = keepThemeResult.result.value as { x: number; y: number; isChecked: boolean } | null;
  if (ktState && !ktState.isChecked) {
    await clickAt(Input, ktState.x, ktState.y);
    await sleep(300);
  }

  // Click "Import slides" button
  console.log("Step 5: Clicking Import slides button...");
  const imported = await findAndClickByText(client, ["Import slides", "IMPORT SLIDES", "Import"]);
  if (!imported) {
    console.log("  Could not find Import button");
  }

  // Wait for import
  console.log("Waiting for import to complete...");
  await sleep(10000);

  await client.close();
  console.log("\nDone!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
