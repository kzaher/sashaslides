import CDP from "chrome-remote-interface";
import * as fs from "fs";
import * as path from "path";

const DIALOG_TIMEOUT = 3000;
const POLL_INTERVAL = 100;

async function main() {
  const startTime = Date.now();
  console.log("Starting thumbnail click script...");

  let client: CDP.Client | null = null;
  let Runtime: any, Page: any, Input: any;

  try {
    // 1. Connect to Chrome port 9222
    client = await CDP({ port: 9222 });
    console.log("Connected to Chrome on port 9222");

    ({ Runtime, Page, Input } = client);

    // Find and activate the 1xegFC0RQiZd tab
    const tabs = await CDP.List({ port: 9222 });
    const targetTab = tabs.find((t) => t.url.includes("1xegFC0RQiZd"));
    if (!targetTab) {
      throw new Error("Tab with 1xegFC0RQiZd not found");
    }
    console.log("Found target tab:", targetTab.id);

    // Close current client and connect to target tab
    await client.close();
    client = await CDP({ port: 9222, target: targetTab.webSocketDebuggerUrl });
    ({ Runtime, Page, Input } = client);

    // Enable Page domain
    await Page.enable();
    console.log("Page domain enabled");

    // 2. Inspect dialog's slide thumbnails
    console.log("\nStep 2: Inspecting dialog...");
    const inspectResult = await Runtime.evaluate({
      expression: `(() => {
    // Look for clickable slide thumbnails in the dialog
    const selectors = [
      '.docs-importslidesdialog-item',
      '[class*="importslide"]',
      '[class*="import-slide"]',
      '[class*="slide-thumbnail"]',
      '.google-picker .modal-dialog img',
      '[role="dialog"] [role="button"]',
      '[role="dialog"] img',
    ];
    const results = {};
    for (const s of selectors) {
      const els = document.querySelectorAll(s);
      if (els.length > 0) results[s] = els.length;
    }
    // Also find numbered thumbnails by looking for elements inside the dialog with a small rect
    const dialog = document.querySelector('[role="dialog"], .google-picker.modal-dialog');
    if (dialog) {
      const all = dialog.querySelectorAll('*');
      let imgLike = 0;
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.width > 80 && r.width < 200 && r.height > 60 && r.height < 150) imgLike++;
      }
      results.dialogMediumElements = imgLike;
    }
    return results;
  })()`,
      returnByValue: true,
    });
    console.log("DOM inspection:", inspectResult.result.value);

    // 3. Click thumbnails based on inspection
    console.log("\nStep 3: Clicking thumbnails...");
    let clickedCount = 0;

    // Try multiple selector strategies
    const selectors = [
      ".docs-importslidesdialog-item",
      "[class*='importslide-item']",
      "[class*='import-slide-item']",
      "[role='dialog'] [role='button']",
    ];

    for (const selector of selectors) {
      try {
        const result = await Runtime.evaluate({
          expression: `(() => {
        const els = document.querySelectorAll('${selector}');
        if (els.length === 0) return 0;
        let count = 0;
        for (const el of els) {
          el.click();
          count++;
        }
        return count;
      })()`,
          returnByValue: true,
        });

        const clicked = result.result.value;
        if (clicked && clicked > 0) {
          clickedCount = clicked;
          console.log(`Clicked ${clicked} elements using selector: ${selector}`);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    if (clickedCount === 0) {
      console.log("No thumbnails clicked via selectors, trying Ctrl+A approach...");
      // 4. Try Ctrl+A keyboard approach
      await Runtime.evaluate({
        expression: `document.querySelector('[role="dialog"]')?.focus()`,
      });
      await Input.dispatchKeyEvent({
        type: "rawKeyDown",
        key: "a",
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      await Input.dispatchKeyEvent({
        type: "keyUp",
        key: "a",
        windowsVirtualKeyCode: 65,
        modifiers: 2,
      });
      console.log("Ctrl+A dispatched to dialog");
    }

    // Wait a bit for clicks to register
    await new Promise((resolve) => setTimeout(resolve, 200));

    // 5. Find and click the "Import slides" button
    console.log("\nStep 5: Clicking Import button...");
    const buttonClicked = await Runtime.evaluate({
      expression: `(() => {
    // Find import button
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(el => {
      const rect = el.getBoundingClientRect();
      const text = el.textContent.toLowerCase();
      return (rect.y > 400 && text.includes('import')) || text === 'import';
    });

    if (buttons.length > 0) {
      buttons[0].click();
      return true;
    }
    return false;
  })()`,
      returnByValue: true,
    });
    console.log("Import button clicked:", buttonClicked.result.value);

    // 6. Poll for dialog closure
    console.log("\nStep 6: Polling for dialog closure...");
    let dialogClosed = false;
    const pollStartTime = Date.now();

    while (Date.now() - pollStartTime < DIALOG_TIMEOUT) {
      const isDialogVisible = await Runtime.evaluate({
        expression: `(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      return dialog.offsetHeight > 0;
    })()`,
        returnByValue: true,
      });

      if (!isDialogVisible.result.value) {
        dialogClosed = true;
        console.log("Dialog closed!");
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }

    if (!dialogClosed) {
      console.log("Dialog still visible after polling");
    }

    // Wait a bit for page to settle
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 7. Screenshot
    console.log("\nStep 7: Taking screenshot...");
    const screenshotDir = path.join(
      "/workspaces/sashaslides/presentations/1/screenshots"
    );
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }

    const screenshot = await Page.captureScreenshot({
      format: "png",
    });

    const screenshotPath = path.join(
      screenshotDir,
      "thumbnail_click_result.png"
    );
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    console.log("Screenshot saved to:", screenshotPath);

    // 8. Count slides in filmstrip
    console.log("\nStep 8: Counting filmstrip thumbnails...");
    const slideCount = await Runtime.evaluate({
      expression: `(() => {
    // First try to scroll filmstrip to ensure all thumbnails are visible
    const filmstrip = document.querySelector('[class*="filmstrip"], [class*="thumbnail-strip"]');
    if (filmstrip) {
      filmstrip.scrollLeft = 0;
      filmstrip.scrollTop = 0;
    }

    const thumbnails = document.querySelectorAll('.punch-filmstrip-thumbnail');
    return thumbnails.length;
  })()`,
      returnByValue: true,
    });

    console.log("Final slide count:", slideCount.result.value);

    const totalRuntime = Date.now() - startTime;
    console.log("\n=== SUMMARY ===");
    console.log("DOM inspection results: checked multiple selectors");
    console.log("Thumbnails clicked:", clickedCount);
    console.log("Dialog closed:", dialogClosed);
    console.log("Final slide count:", slideCount.result.value);
    console.log("Screenshot saved: true");
    console.log("Total runtime:", totalRuntime, "ms");
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : error);
    throw error;
  } finally {
    if (client) {
      await client.close();
    }
  }
}

main().catch((error) => {
  process.exit(1);
});
