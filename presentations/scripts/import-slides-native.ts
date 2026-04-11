/**
 * import-slides-native.ts
 *
 * Uses Google Slides' native File > Import slides feature to bring in
 * the whiteboard-styled slides from RobPresentation into the original
 * presentation. This is the proper way to migrate slides with styles.
 *
 * Steps:
 * 1. File menu > Import slides
 * 2. Picker dialog opens: navigate to RobPresentation
 * 3. Thumbnails dialog: click "All" to select all, check "Keep original theme"
 * 4. Click Import slides
 * 5. Delete the original plain slides (they'll be at the start)
 */

import CDP from "chrome-remote-interface";

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

async function findAndClick(runtime: any, input: any, texts: string[], scope = "document"): Promise<string | null> {
  const textList = JSON.stringify(texts);
  const result = await runtime.evaluate({
    expression: `(() => {
      const scope = ${scope};
      const texts = ${textList};
      const candidates = scope.querySelectorAll('[role="menuitem"], [role="button"], button, span, div, a');
      for (const el of candidates) {
        const t = (el.textContent || '').trim();
        if (texts.some(tx => t === tx || t.startsWith(tx + '(') || t.startsWith(tx + ' '))) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
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
    await clickAt(input, pos.x, pos.y);
    return pos.text;
  }
  return null;
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
  await sleep(1000);

  // Count existing slides for later deletion
  const initialCount = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  const originalSlideCount = initialCount.result.value as number;
  console.log(`Original slide count: ${originalSlideCount}`);

  // Step 1: Click File menu
  console.log("Opening File menu...");
  const fileResult = await Runtime.evaluate({
    expression: `(() => {
      const items = document.querySelectorAll('[role="menubar"] [role="menuitem"]');
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
  if (!fileResult.result.value) {
    console.error("File menu not found");
    process.exit(1);
  }
  const filePos = fileResult.result.value as { x: number; y: number };
  await clickAt(Input, filePos.x, filePos.y);
  await sleep(700);

  // Step 2: Click "Import slides"
  const importClicked = await findAndClick(Runtime, Input, ["Import slides"]);
  if (!importClicked) {
    console.error("Import slides not found");
    await pressKey(Input, "Escape", 27);
    process.exit(1);
  }
  console.log(`  Clicked: ${importClicked}`);
  await sleep(4000);

  // Step 3: Now we're in the file picker dialog
  // The picker loads in an iframe. Let's find elements in the main page first
  // (some Slides pickers render in main DOM, some in iframes)
  console.log("In picker dialog, looking for RobPresentation...");

  // Wait for picker to fully load
  await sleep(3000);

  // Try to find a search input in the picker
  const searchInputResult = await Runtime.evaluate({
    expression: `(() => {
      // Look for search-like inputs
      const inputs = document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])');
      for (const inp of inputs) {
        const r = inp.getBoundingClientRect();
        const placeholder = inp.getAttribute('placeholder') || '';
        // Search inputs in picker are typically large-ish
        if (r.width > 150 && r.height > 15 && r.y > 50) {
          return { x: r.x + r.width/2, y: r.y + r.height/2, placeholder };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  console.log("  Search input result:", searchInputResult.result.value);

  // Check all iframes since picker is often in an iframe
  const allTargets = await CDP.List({ port: 9222 });
  console.log("  Total targets:", allTargets.length);
  for (const t of allTargets) {
    if (t.type === "iframe" && t.url !== "about:blank") {
      console.log(`    iframe: ${t.url.slice(0, 100)}`);
    }
  }

  // Try to find picker iframe
  const pickerFrame = allTargets.find(
    (t: any) =>
      t.type === "iframe" &&
      (t.url.includes("picker") || t.url.includes("onepick"))
  );

  if (pickerFrame) {
    console.log(`  Found picker iframe: ${pickerFrame.url.slice(0, 100)}`);
    try {
      const pickerClient = await CDP({ target: pickerFrame });
      const pickerRt = pickerClient.Runtime;

      // Try to find and focus a search input in the iframe
      const focusResult = await pickerRt.evaluate({
        expression: `(() => {
          const inputs = document.querySelectorAll('input');
          for (const inp of inputs) {
            const r = inp.getBoundingClientRect();
            if (r.width > 100) {
              inp.focus();
              return { found: true, placeholder: inp.getAttribute('placeholder') };
            }
          }
          return { found: false };
        })()`,
        returnByValue: true,
      });
      console.log("  Picker iframe focus:", focusResult.result.value);

      await pickerClient.close();
    } catch (e) {
      console.log("  Picker iframe interaction failed:", e);
    }
  }

  // Regardless of focus status, type the file name — the search box often has auto-focus
  await Input.insertText({ text: "RobPresentation" });
  await sleep(2500);

  // Look for the file in the results (in main DOM — picker contents sometimes reflected there)
  console.log("Looking for RobPresentation in results...");
  const fileResult2 = await Runtime.evaluate({
    expression: `(() => {
      const all = document.querySelectorAll('*');
      const candidates = [];
      for (const el of all) {
        if (el.children.length !== 0) continue;
        const text = (el.textContent || '').trim();
        if (text === 'RobPresentation' || text === 'RobPresentation.pptx' || text.startsWith('RobPresentation')) {
          // Walk up to find a clickable container
          let container = el;
          for (let i = 0; i < 5 && container && container.parentElement; i++) {
            const r = container.getBoundingClientRect();
            if (r.width > 150 && r.height > 30) break;
            container = container.parentElement;
          }
          if (container) {
            const r = container.getBoundingClientRect();
            if (r.width > 0) candidates.push({ x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, text: text.slice(0, 40) });
          }
        }
      }
      return candidates;
    })()`,
    returnByValue: true,
  });

  console.log("  Candidates:", fileResult2.result.value);
  const candidates = fileResult2.result.value as Array<{ x: number; y: number; w: number; text: string }>;
  if (candidates && candidates.length > 0) {
    const best = candidates[0];
    console.log(`  Clicking: ${best.text}`);
    await clickAt(Input, best.x, best.y);
    await sleep(800);
  }

  // Click "Select" button
  await sleep(500);
  const selectClicked = await findAndClick(Runtime, Input, ["Select", "SELECT"]);
  if (selectClicked) console.log(`  Clicked: ${selectClicked}`);
  await sleep(4000);

  // Step 4: Now in the "Import slides" dialog — showing thumbnails
  console.log("In thumbnails dialog, clicking 'All'...");
  const allClicked = await findAndClick(Runtime, Input, ["All"]);
  if (allClicked) console.log(`  Clicked: ${allClicked}`);
  await sleep(1000);

  // Make sure "Keep original theme" is checked
  console.log("Checking 'Keep original theme'...");
  const keepThemeResult = await Runtime.evaluate({
    expression: `(() => {
      // Find a label containing "original theme"
      const labels = document.querySelectorAll('label, [role="checkbox"]');
      for (const l of labels) {
        const text = (l.textContent || '').toLowerCase();
        if (text.includes('original theme') || text.includes('keep')) {
          const cb = l.querySelector('input[type="checkbox"], [role="checkbox"]') || l;
          const isChecked = cb.getAttribute('aria-checked') === 'true' || (cb as any).checked;
          const r = cb.getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2, isChecked, text: text.slice(0, 40) };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });
  console.log("  Theme checkbox:", keepThemeResult.result.value);
  const ktState = keepThemeResult.result.value as any;
  if (ktState && !ktState.isChecked) {
    await clickAt(Input, ktState.x, ktState.y);
    await sleep(300);
  }

  // Click "Import slides" button in this dialog
  console.log("Clicking Import slides button...");
  const importBtnClicked = await findAndClick(Runtime, Input, ["Import slides", "IMPORT SLIDES"]);
  if (importBtnClicked) console.log(`  Clicked: ${importBtnClicked}`);

  // Wait for import
  console.log("Waiting for import to complete (30s)...");
  await sleep(30000);

  // Check new count
  await Runtime.evaluate({
    expression: `(() => {
      const fs = document.querySelector('.punch-filmstrip-scroll');
      if (fs) fs.scrollTop = fs.scrollHeight;
    })()`,
  });
  await sleep(500);
  const newCount = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  console.log(`Slide count after import: ${newCount.result.value}`);

  // Scroll back
  await Runtime.evaluate({
    expression: `(() => {
      const fs = document.querySelector('.punch-filmstrip-scroll');
      if (fs) fs.scrollTop = 0;
    })()`,
  });

  await client.close();
  console.log("Done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
