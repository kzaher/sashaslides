/**
 * apply-via-apps-script.ts
 *
 * Opens the Apps Script editor bound to the presentation,
 * writes a function that applies whiteboard styling (background, fonts, colors),
 * then executes it.
 *
 * This is the programmatic approach — Apps Script has full native Slides API access.
 */

import CDP from "chrome-remote-interface";
import { readFileSync } from "node:fs";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// The Apps Script code that will apply whiteboard formatting
const APPS_SCRIPT_CODE = `
function applyWhiteboardStyle() {
  var pres = SlidesApp.getActivePresentation();
  var slides = pres.getSlides();

  // Whiteboard background color (off-white)
  var bgColor = '#f0efe8';

  // Title style: Caveat font, dark blue
  var titleFontFamily = 'Caveat';
  var titleColor = '#1a5276';
  var sectionTitleColor = '#1a5276';
  var titleSlideColor = '#c0392b';

  // Body style: Patrick Hand font, dark slate
  var bodyFontFamily = 'Patrick Hand';
  var bodyColor = '#2c3e50';

  for (var i = 0; i < slides.length; i++) {
    var slide = slides[i];

    // Set background color
    slide.getBackground().setSolidFill(bgColor);

    // Get all shapes (text elements) on the slide
    var shapes = slide.getShapes();

    for (var j = 0; j < shapes.length; j++) {
      var shape = shapes[j];
      var textRange = shape.getText();
      var text = textRange.asString().trim();

      if (text.length === 0) continue;

      // Determine if this is a title or body element based on placeholder type
      var placeholderType = null;
      try {
        placeholderType = shape.getPlaceholderType();
      } catch (e) {
        // Not a placeholder
      }

      var isTitle = (placeholderType === SlidesApp.PlaceholderType.TITLE ||
                     placeholderType === SlidesApp.PlaceholderType.CENTERED_TITLE);
      var isSubtitle = (placeholderType === SlidesApp.PlaceholderType.SUBTITLE);
      var isBody = (placeholderType === SlidesApp.PlaceholderType.BODY);

      // If no placeholder type, guess from position (top = title, bottom = body)
      if (!placeholderType || placeholderType === SlidesApp.PlaceholderType.NONE) {
        var top = shape.getTop();
        isTitle = (top < 150); // rough heuristic: title is near top
        isBody = !isTitle;
      }

      var style = textRange.getTextStyle();

      if (isTitle || isSubtitle) {
        style.setFontFamily(titleFontFamily);
        // Title slide (first) and closing slide (last) get red
        if (i === 0 || i === slides.length - 1) {
          style.setForegroundColor(titleSlideColor);
        } else {
          style.setForegroundColor(titleColor);
        }
        // Make titles bigger
        if (isTitle) {
          style.setFontSize(36);
          style.setBold(true);
        }
        if (isSubtitle) {
          style.setFontFamily(bodyFontFamily);
          style.setFontSize(20);
          style.setForegroundColor('#555555');
        }
      } else {
        // Body text
        style.setFontFamily(bodyFontFamily);
        style.setForegroundColor(bodyColor);
        style.setFontSize(16);
      }
    }

    Logger.log('Styled slide ' + (i + 1) + '/' + slides.length);
  }

  Logger.log('Done! Whiteboard style applied to all ' + slides.length + ' slides.');
}
`;

async function pressKey(input: any, key: string, keyCode: number, modifiers = 0) {
  await input.dispatchKeyEvent({ type: "rawKeyDown", key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
  await sleep(30);
  await input.dispatchKeyEvent({ type: "keyUp", key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
}

async function clickAt(input: any, x: number, y: number) {
  await input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(30);
  await input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function main() {
  console.log("Connecting to Chrome...");
  const targets = await CDP.List({ port: 9222 });
  const slidesTab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("docs.google.com/presentation")
  );
  if (!slidesTab) {
    console.error("No Slides tab found");
    process.exit(1);
  }

  const client = await CDP({ target: slidesTab });
  const { Runtime, Input, Page } = client;
  await Page.enable();

  // Step 1: Open Apps Script editor via Extensions menu
  console.log("Opening Extensions > Apps Script...");

  const extResult = await Runtime.evaluate({
    expression: `(() => {
      const menubar = document.querySelector('[role="menubar"]');
      if (!menubar) return null;
      const items = menubar.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        if (item.textContent?.trim() === 'Extensions') {
          const r = item.getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (!extResult.result.value) {
    console.error("Could not find Extensions menu");
    process.exit(1);
  }

  const extPos = extResult.result.value as { x: number; y: number };
  await clickAt(Input, extPos.x, extPos.y);
  await sleep(800);

  // Click "Apps Script"
  const asResult = await Runtime.evaluate({
    expression: `(() => {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        if (item.textContent?.trim().includes('Apps Script')) {
          const r = item.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (!asResult.result.value) {
    console.error("Could not find Apps Script menu item");
    await pressKey(Input, "Escape", 27);
    process.exit(1);
  }

  const asPos = asResult.result.value as { x: number; y: number };
  await clickAt(Input, asPos.x, asPos.y);
  console.log("  Clicked Apps Script — waiting for new tab...");
  await sleep(5000);

  // Step 2: Find and connect to the Apps Script editor tab
  const allTargets = await CDP.List({ port: 9222 });
  const scriptTab = allTargets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("script.google.com")
  );

  if (!scriptTab) {
    console.error("Apps Script tab did not open. Available tabs:");
    for (const t of allTargets) {
      console.log(`  ${t.type}: ${t.url?.slice(0, 80)}`);
    }
    process.exit(1);
  }

  console.log(`  Connected to Apps Script: ${scriptTab.url.slice(0, 80)}`);
  const scriptClient = await CDP({ target: scriptTab });
  const scriptRuntime = scriptClient.Runtime;
  const scriptInput = scriptClient.Input;
  const scriptPage = scriptClient.Page;
  await scriptPage.enable();

  // Wait for the editor to load
  await sleep(5000);

  // Step 3: Clear existing code and paste our script
  console.log("Writing Apps Script code...");

  // The Apps Script editor uses Monaco/CodeMirror. Find the editor area.
  // Try to select all existing code and replace it.

  // Click on the editor area first
  const editorResult = await scriptRuntime.evaluate({
    expression: `(() => {
      // Monaco editor
      const editor = document.querySelector('.monaco-editor .view-lines') ||
                     document.querySelector('.monaco-editor') ||
                     document.querySelector('[role="code"]') ||
                     document.querySelector('.CodeMirror');
      if (editor) {
        const r = editor.getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y + r.height/2, cls: editor.className.slice(0, 50) };
      }
      // Fallback: look for any large textarea or contenteditable
      const areas = document.querySelectorAll('textarea, [contenteditable="true"]');
      for (const a of areas) {
        const r = a.getBoundingClientRect();
        if (r.width > 300 && r.height > 200) {
          return { x: r.x + r.width/2, y: r.y + r.height/2, cls: 'textarea' };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (!editorResult.result.value) {
    console.log("  Could not find editor area. Waiting more and retrying...");
    await sleep(5000);
  }

  const editorPos = editorResult.result.value as { x: number; y: number; cls: string } | null;
  if (editorPos) {
    console.log(`  Found editor: ${editorPos.cls}`);
    await clickAt(scriptInput, editorPos.x, editorPos.y);
    await sleep(300);
  }

  // Select all (Ctrl+A) and replace with our code
  await pressKey(scriptInput, "a", 65, 2); // Ctrl+A
  await sleep(300);

  // Delete selected
  await pressKey(scriptInput, "Backspace", 8);
  await sleep(300);

  // Type our script using insertText
  await scriptInput.insertText({ text: APPS_SCRIPT_CODE.trim() });
  await sleep(1000);

  // Step 4: Save the script (Ctrl+S)
  console.log("Saving script...");
  await pressKey(scriptInput, "s", 83, 2); // Ctrl+S
  await sleep(3000);

  // Step 5: Run the function
  console.log("Running applyWhiteboardStyle()...");

  // Click the "Run" button or use the menu
  const runBtnResult = await scriptRuntime.evaluate({
    expression: `(() => {
      // Look for the Run button (play/triangle icon)
      const buttons = document.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const label = btn.getAttribute('aria-label') || btn.textContent?.trim() || '';
        if (label === 'Run' || label.includes('Run') || label === 'Execute') {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.y < 100) return { x: r.x + r.width/2, y: r.y + r.height/2, label };
        }
      }
      // Try the toolbar icons
      const icons = document.querySelectorAll('[data-tooltip*="Run"], [aria-label*="Run"]');
      for (const icon of icons) {
        const r = icon.getBoundingClientRect();
        if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2, label: 'icon' };
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (runBtnResult.result.value) {
    const runPos = runBtnResult.result.value as { x: number; y: number; label: string };
    console.log(`  Found Run button: "${runPos.label}"`);
    await clickAt(scriptInput, runPos.x, runPos.y);
    await sleep(2000);

    // May need to authorize — check for auth dialog
    const authResult = await scriptRuntime.evaluate({
      expression: `(() => {
        const btns = document.querySelectorAll('button, [role="button"]');
        for (const btn of btns) {
          const text = btn.textContent?.trim();
          if (text === 'Review permissions' || text === 'Continue' || text === 'Allow' || text === 'Authorize') {
            const r = btn.getBoundingClientRect();
            if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2, text };
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    if (authResult.result.value) {
      const authPos = authResult.result.value as { x: number; y: number; text: string };
      console.log(`  Auth dialog: clicking "${authPos.text}"`);
      await clickAt(scriptInput, authPos.x, authPos.y);
      await sleep(3000);

      // May get a second auth screen — "Advanced" > "Go to (unsafe)" flow
      // Keep clicking through auth dialogs
      for (let attempt = 0; attempt < 5; attempt++) {
        const nextResult = await scriptRuntime.evaluate({
          expression: `(() => {
            const allTargets = [...document.querySelectorAll('button, [role="button"], a')];
            const keywords = ['Allow', 'Continue', 'Advanced', 'Go to', 'Authorize', 'Review permissions'];
            for (const el of allTargets) {
              const text = el.textContent?.trim() || '';
              if (keywords.some(k => text.includes(k))) {
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return { x: r.x + r.width/2, y: r.y + r.height/2, text: text.slice(0, 40) };
              }
            }
            return null;
          })()`,
          returnByValue: true,
        });

        if (nextResult.result.value) {
          const nextPos = nextResult.result.value as { x: number; y: number; text: string };
          console.log(`  Auth step: clicking "${nextPos.text}"`);
          await clickAt(scriptInput, nextPos.x, nextPos.y);
          await sleep(3000);
        } else {
          break;
        }
      }
    }

    // Wait for execution to complete
    console.log("  Waiting for execution to complete...");
    await sleep(15000);

    // Check execution log
    const logResult = await scriptRuntime.evaluate({
      expression: `(() => {
        // Look for execution log output
        const logs = document.querySelectorAll('[class*="log"], [class*="output"], [class*="console"]');
        const texts = [];
        for (const log of logs) {
          const text = log.textContent?.trim();
          if (text && text.length > 5) texts.push(text.slice(0, 200));
        }
        return texts.join('\\n') || 'no logs found';
      })()`,
      returnByValue: true,
    });
    console.log("  Execution output:", logResult.result.value);
  } else {
    console.log("  Could not find Run button. Try running manually in the Apps Script editor.");
  }

  // Close the Apps Script tab
  await CDP.Close({ port: 9222, id: scriptTab.id });
  await scriptClient.close();
  await client.close();

  console.log("\nDone!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
