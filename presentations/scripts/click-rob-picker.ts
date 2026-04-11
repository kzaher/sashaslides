/**
 * Clicks the RobPresentation file in the open Import Slides picker,
 * then proceeds through the rest of the import flow.
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

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("1xegFC0RQiZd")
  );
  if (!tab) { console.error("No tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Runtime, Input, Target } = client;
  await Target.activateTarget({ targetId: tab.id });
  await sleep(500);

  // The picker should still be open. Click directly on the RobPresentation thumbnail.
  // Based on screenshot coordinates: approximately (549, 340) on a 1280x720 viewport
  // But coordinates are page-level, and the iframe is at (251, 33)
  // The RobPresentation card is inside the iframe at ~(298, 280) relative to iframe
  // So absolute: (251+298, 33+280) = (549, 313)

  console.log("Clicking RobPresentation thumbnail at (549, 313)...");
  await clickAt(Input, 549, 313);
  await sleep(800);

  // After selecting, look for and click "Select" button
  // In the Google Picker, buttons are at the bottom of the dialog
  console.log("Looking for Select button...");

  // Try to find the picker iframe target
  const allTargets = await CDP.List({ port: 9222 });
  const pickerTarget = allTargets.find(
    (t: any) =>
      (t.type === "iframe" || t.type === "page") &&
      t.url.includes("docs.google.com/picker")
  );

  if (pickerTarget) {
    console.log(`  Picker target: ${pickerTarget.url.slice(0, 100)}`);
    try {
      const pickerClient = await CDP({ target: pickerTarget });
      const pickerRt = pickerClient.Runtime;

      // Find the Select button inside the picker iframe
      const selectBtn = await pickerRt.evaluate({
        expression: `(() => {
          const btns = document.querySelectorAll('button, [role="button"]');
          for (const b of btns) {
            const text = (b.textContent || '').trim();
            if (text === 'Select' || text === 'SELECT' || text === 'Open') {
              const r = b.getBoundingClientRect();
              if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2, text };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });
      console.log("  Select button in iframe:", selectBtn.result.value);

      // The iframe position on the main page is (251, 33), so translate coords
      if (selectBtn.result.value) {
        const sb = selectBtn.result.value as { x: number; y: number; text: string };
        const mainX = sb.x + 251;
        const mainY = sb.y + 33;
        console.log(`  Clicking at main-page coords (${mainX}, ${mainY})`);
        await clickAt(Input, mainX, mainY);
        await sleep(3000);
      }

      await pickerClient.close();
    } catch (e) {
      console.log("  Iframe error:", e);
    }
  } else {
    console.log("  No picker iframe target, trying keyboard Enter...");
    await pressKey(Input, "Enter", 13);
    await sleep(2000);
  }

  // Now the "Import slides" dialog (with thumbnails + "Keep original theme" checkbox) should appear
  await sleep(3000);

  // Screenshot to see state
  const { Page } = client;
  await Page.enable();
  const { writeFileSync } = await import("node:fs");
  const ss = await Page.captureScreenshot({ format: "png" });
  writeFileSync("/workspaces/sashaslides/presentations/1/screenshots/after_select.png", Buffer.from(ss.data, "base64"));
  console.log("Screenshot: after_select.png");

  await client.close();
}
main().catch(console.error);
