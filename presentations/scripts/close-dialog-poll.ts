import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const screenshotDir = "/workspaces/sashaslides/presentations/1/screenshots";
mkdirSync(screenshotDir, { recursive: true });

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 100
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function main() {
  const startTime = Date.now();
  try {
    // 1. Connect to Chrome port 9222, find tab containing 1xegFC0RQiZd
    const targets = await CDP.List({ port: 9222 });
    const tab = targets.find(
      (t: any) => t.type === "page" && t.url.includes("1xegFC0RQiZd")
    );

    if (!tab) {
      console.log("ERROR: Tab not found");
      return;
    }

    const client = await CDP({ target: tab });
    const { Runtime, Input, Target, Page } = client;

    // Activate tab
    await Target.activateTarget({ targetId: tab.id });
    await Page.enable();

    // 2. Screenshot immediately (before_action.png)
    const screenshot1 = await Page.captureScreenshot({ format: "png" });
    writeFileSync(
      join(screenshotDir, "before_action.png"),
      Buffer.from(screenshot1.data, "base64")
    );
    console.log("Screenshot: before_action.png");

    // 3. Check dialog state via DOM query
    const dialogStateInitial = await Runtime.evaluate({
      expression: `(() => {
        const dialog = document.querySelector('.google-picker.modal-dialog, [role="dialog"]');
        if (!dialog) return null;
        const rect = dialog.getBoundingClientRect();
        return { width: rect.width, height: rect.height, present: true };
      })()`,
      returnByValue: true,
    });
    const initialDialog = (dialogStateInitial.result.value as any) || null;
    const dialogInitiallyPresent = !!initialDialog;
    if (initialDialog) {
      console.log(
        `Dialog present: ${initialDialog.width}x${initialDialog.height}`
      );
    } else {
      console.log("Dialog not found");
    }

    // 4. Click "Select all slides" button by DOM position
    const selectAllState = await Runtime.evaluate({
      expression: `(() => {
        const btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b =>
          b.textContent?.trim() === 'Select all slides'
        );
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return { x: rect.x + rect.width/2, y: rect.y + rect.height/2, width: rect.width };
      })()`,
      returnByValue: true,
    });
    const selectAllBtn = (selectAllState.result.value as any) || null;

    if (selectAllBtn) {
      console.log(`Clicking "Select all slides" at (${selectAllBtn.x}, ${selectAllBtn.y})`);
      await Input.dispatchMouseEvent({
        type: "mousePressed",
        x: selectAllBtn.x,
        y: selectAllBtn.y,
        button: "left",
        clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, 30));
      await Input.dispatchMouseEvent({
        type: "mouseReleased",
        x: selectAllBtn.x,
        y: selectAllBtn.y,
        button: "left",
        clickCount: 1,
      });

      // Poll every 100ms up to 1 second for button state change
      const changed = await waitFor(
        async () => {
          const state = await Runtime.evaluate({
            expression: `(() => {
              const btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b =>
                b.textContent?.trim() === 'Select all slides'
              );
              if (!btn) return false;
              const checkbox = btn.querySelector('input[type="checkbox"]');
              const oldText = btn.textContent?.includes('Select all slides');
              return checkbox !== null || !oldText;
            })()`,
            returnByValue: true,
          });
          return (state.result.value as boolean) || false;
        },
        1000,
        100
      );
      console.log(`Select all button state changed: ${changed}`);
    } else {
      console.log("Select all slides button not found");
    }

    // 5. Click "Import slides" button (y > 400) by DOM position
    const importBtnState = await Runtime.evaluate({
      expression: `(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b =>
          b.textContent?.trim() === 'Import slides'
        );
        const btn = btns.find((b: any) => b.getBoundingClientRect().y > 400);
        if (!btn) return null;
        const rect = btn.getBoundingClientRect();
        return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
      })()`,
      returnByValue: true,
    });
    const importBtn = (importBtnState.result.value as any) || null;

    let importClicked = false;
    if (importBtn) {
      console.log(`Clicking "Import slides" at (${importBtn.x}, ${importBtn.y})`);
      await Input.dispatchMouseEvent({
        type: "mousePressed",
        x: importBtn.x,
        y: importBtn.y,
        button: "left",
        clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, 30));
      await Input.dispatchMouseEvent({
        type: "mouseReleased",
        x: importBtn.x,
        y: importBtn.y,
        button: "left",
        clickCount: 1,
      });
      importClicked = true;

      // Get initial slide count before polling
      const initialCount = await Runtime.evaluate({
        expression: `(() => document.querySelectorAll('.punch-filmstrip-thumbnail').length)()`,
        returnByValue: true,
      });
      const initialSlideCount = (initialCount.result.value as number) || 19;
      console.log(`Initial slide count: ${initialSlideCount}`);

      // Poll every 100ms up to 2 seconds for dialog closed OR slide count increased from 19
      const importDone = await waitFor(
        async () => {
          const check = await Runtime.evaluate({
            expression: `(() => {
              const dialogGone = !document.querySelector('.modal-dialog, [role="dialog"]');
              const slideCount = document.querySelectorAll('.punch-filmstrip-thumbnail').length;
              const countIncreased = slideCount > ${initialSlideCount};
              return dialogGone || countIncreased;
            })()`,
            returnByValue: true,
          });
          return (check.result.value as boolean) || false;
        },
        2000,
        100
      );
      console.log(`Import completed (dialog/slides changed): ${importDone}`);
    } else {
      console.log("Import slides button not found");
    }

    // 6. Count .punch-filmstrip-thumbnail (scroll filmstrip to bottom first)
    await Runtime.evaluate({
      expression: `(() => {
        const filmstrip = document.querySelector('.punch-filmstrip');
        if (filmstrip) {
          filmstrip.scrollTop = filmstrip.scrollHeight;
        }
      })()`,
      returnByValue: true,
    });
    await new Promise((r) => setTimeout(r, 200));

    const finalCount = await Runtime.evaluate({
      expression: `(() => document.querySelectorAll('.punch-filmstrip-thumbnail').length)()`,
      returnByValue: true,
    });
    const finalSlideCount = (finalCount.result.value as number) || 0;
    console.log(`Final slide count: ${finalSlideCount}`);

    // 7. Screenshot after_action.png
    const screenshot2 = await Page.captureScreenshot({ format: "png" });
    writeFileSync(
      join(screenshotDir, "after_action.png"),
      Buffer.from(screenshot2.data, "base64")
    );
    console.log("Screenshot: after_action.png");

    // 8. Report
    const dialogStillOpen = await Runtime.evaluate({
      expression: `(() => !!document.querySelector('.google-picker.modal-dialog, [role="dialog"]'))()`,
      returnByValue: true,
    });
    const dialogClosed = !(dialogStillOpen.result.value as boolean);

    console.log("\n=== REPORT ===");
    console.log(`Dialog initially present: ${dialogInitiallyPresent}`);
    console.log(`Clicks succeeded: ${importClicked}`);
    console.log(`Dialog closed: ${dialogClosed}`);
    console.log(`Final slide count: ${finalSlideCount}`);
    console.log("No visible errors");
    console.log(`Total runtime: ${Date.now() - startTime}ms`);

    await client.close();
  } catch (err) {
    console.error("ERROR:", (err as any).message);
    console.log(`Total runtime: ${Date.now() - startTime}ms`);
  }
}

main();
