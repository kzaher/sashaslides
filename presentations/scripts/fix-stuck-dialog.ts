import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const screenshotDir = "/workspaces/sashaslides/presentations/1/screenshots";
mkdirSync(screenshotDir, { recursive: true });

async function main() {
  try {
    // Connect to Chrome
    const targets = await CDP.List({ port: 9222 });
    const tab = targets.find(
      (t: any) => t.type === "page" && t.url.includes("1xegFC0RQiZd")
    );

    if (!tab) {
      console.log("Tab not found");
      return;
    }

    const client = await CDP({ target: tab });
    const { Runtime, Input, Target, Page } = client;

    // Activate tab
    await Target.activateTarget({ targetId: tab.id });
    await Page.enable();

    // Wait before screenshot
    await new Promise((r) => setTimeout(r, 1500));

    // Take initial screenshot
    const screenshot1 = await Page.captureScreenshot({ format: "png" });
    writeFileSync(
      join(screenshotDir, "stuck_dialog.png"),
      Buffer.from(screenshot1.data, "base64")
    );
    console.log("Screenshot 1 taken");

    // Helper to find buttons
    async function findButtons(text: string) {
      const r = await Runtime.evaluate({
        expression: `(() => {
          const out = [];
          document.querySelectorAll('button, [role="button"]').forEach(b => {
            if (b.textContent?.trim() === ${JSON.stringify(text)}) {
              const rect = b.getBoundingClientRect();
              if (rect.width > 0) {
                out.push({
                  x: rect.x + rect.width/2,
                  y: rect.y + rect.height/2,
                  width: rect.width,
                  height: rect.height,
                  y_val: rect.y
                });
              }
            }
          });
          return out;
        })()`,
        returnByValue: true,
      });
      return r.result.value || [];
    }

    // Helper to click
    async function click(x: number, y: number) {
      await Input.dispatchMouseEvent({
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
      await new Promise((r) => setTimeout(r, 30));
      await Input.dispatchMouseEvent({
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1,
      });
    }

    // Click "Select all slides"
    console.log("Looking for 'Select all slides' button...");
    const selectAllButtons = await findButtons("Select all slides");
    if (selectAllButtons.length > 0) {
      const btn = selectAllButtons[0];
      console.log(`Found Select all slides at (${btn.x}, ${btn.y})`);
      await click(btn.x, btn.y);
      await new Promise((r) => setTimeout(r, 600));
    } else {
      console.log("No 'Select all slides' button found");
    }

    // Click "Import slides" - find button with y > 500 (dialog at bottom)
    console.log("Looking for 'Import slides' button...");
    const importButtons = await findButtons("Import slides");
    console.log(`Found ${importButtons.length} 'Import slides' buttons`);
    const dialogButton = importButtons.find((b: any) => b.y_val > 500);
    if (dialogButton) {
      console.log(
        `Found Import slides dialog button at (${dialogButton.x}, ${dialogButton.y})`
      );
      await click(dialogButton.x, dialogButton.y);
      await new Promise((r) => setTimeout(r, 500));
    } else {
      console.log("No dialog 'Import slides' button found (y > 500)");
    }

    // Check if dialog closed
    const dialogCheck = await Runtime.evaluate({
      expression: `(() => {
        const modal = document.querySelector('.modal-dialog');
        const dialog = document.querySelector('dialog');
        return { modal: !!modal, dialog: !!dialog };
      })()`,
      returnByValue: true,
    });
    let dialogStillOpen =
      (dialogCheck.result.value as any)?.modal ||
      (dialogCheck.result.value as any)?.dialog;

    // Try Enter key if dialog still open
    if (dialogStillOpen) {
      console.log("Dialog still open, trying Enter key...");
      await Input.dispatchKeyEvent({
        type: "keyDown",
        key: "Enter",
        code: "Enter",
      });
      await new Promise((r) => setTimeout(r, 30));
      await Input.dispatchKeyEvent({
        type: "keyUp",
        key: "Enter",
        code: "Enter",
      });
      await new Promise((r) => setTimeout(r, 500));

      const dialogCheck2 = await Runtime.evaluate({
        expression: `(() => {
          const modal = document.querySelector('.modal-dialog');
          const dialog = document.querySelector('dialog');
          return { modal: !!modal, dialog: !!dialog };
        })()`,
        returnByValue: true,
      });
      dialogStillOpen =
        (dialogCheck2.result.value as any)?.modal ||
        (dialogCheck2.result.value as any)?.dialog;
    }

    // Wait for import
    console.log("Waiting 15 seconds for import...");
    await new Promise((r) => setTimeout(r, 15000));

    // Scroll filmstrip to bottom
    console.log("Scrolling filmstrip to bottom...");
    await Runtime.evaluate({
      expression: `(() => {
        const filmstrip = document.querySelector('.punch-filmstrip');
        if (filmstrip) {
          filmstrip.scrollTop = filmstrip.scrollHeight;
        }
      })()`,
      returnByValue: true,
    });
    await new Promise((r) => setTimeout(r, 500));

    // Count slides
    const slideCount = await Runtime.evaluate({
      expression: `(() => {
        return document.querySelectorAll('.punch-filmstrip-thumbnail').length;
      })()`,
      returnByValue: true,
    });
    const finalSlideCount = slideCount.result.value as number;
    console.log("Slide count:", finalSlideCount);

    // Take final screenshot
    const screenshot2 = await Page.captureScreenshot({ format: "png" });
    writeFileSync(
      join(screenshotDir, "after_import.png"),
      Buffer.from(screenshot2.data, "base64")
    );
    console.log("Screenshot 2 taken");

    // Report
    console.log("\n=== REPORT ===");
    console.log(`Dialog closed: ${!dialogStillOpen}`);
    console.log(`Final slide count: ${finalSlideCount}`);
    console.log("No errors");

    await client.close();
  } catch (err) {
    console.error("Error:", (err as any).message);
  }
}

main();
