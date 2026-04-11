/**
 * Fresh import into the empty original presentation.
 * - Open File > Import slides
 * - Click RobPresentation in picker
 * - Click Select in picker
 * - Select all slides in thumbnail dialog
 * - Click Import slides (via PointerEvent)
 * - Verify final slide count
 */
import CDP from "chrome-remote-interface";
import { writeFileSync } from "node:fs";

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" &&
      t.url.includes("1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY")
  );
  if (!tab) { console.error("No original tab"); process.exit(1); }

  const client = await CDP({ target: tab });
  const { Runtime, Input, Target, Page } = client;
  await Target.activateTarget({ targetId: tab.id });
  await Page.enable();
  await sleep(300);

  // Step 1: Click File menu
  console.log("Opening File menu...");
  const fileBtn = await Runtime.evaluate({
    expression: `(() => {
      const items = document.querySelectorAll('[role="menubar"] [role="menuitem"]');
      for (const i of items) {
        if (i.textContent?.trim() === 'File') {
          const r = i.getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });
  if (!fileBtn.result.value) { console.error("No File menu"); process.exit(1); }
  const fp = fileBtn.result.value as any;
  await Input.dispatchMouseEvent({ type: "mousePressed", x: fp.x, y: fp.y, button: "left", clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: fp.x, y: fp.y, button: "left", clickCount: 1 });
  await sleep(400);

  // Step 2: Click Import slides menu item
  const imp = await Runtime.evaluate({
    expression: `(() => {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const i of items) {
        if ((i.textContent?.trim() || '').startsWith('Import slides')) {
          const r = i.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });
  if (!imp.result.value) { console.error("No Import slides item"); process.exit(1); }
  const ip = imp.result.value as any;
  await Input.dispatchMouseEvent({ type: "mousePressed", x: ip.x, y: ip.y, button: "left", clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: ip.x, y: ip.y, button: "left", clickCount: 1 });
  console.log("Waiting for picker dialog...");
  await sleep(3000);

  // Step 3: Click RobPresentation at known coords (from earlier)
  console.log("Clicking RobPresentation thumbnail...");
  await Input.dispatchMouseEvent({ type: "mousePressed", x: 549, y: 313, button: "left", clickCount: 2 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: 549, y: 313, button: "left", clickCount: 2 });
  console.log("Waiting for thumbnails dialog...");
  await sleep(4000);

  // Step 4: Select all slides button via PointerEvent
  console.log("Clicking Select all slides (pointer events)...");
  await Runtime.evaluate({
    expression: `(() => {
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        if (b.textContent?.trim() === 'Select all slides') {
          const r = b.getBoundingClientRect();
          if (r.width > 0) {
            const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, pointerType: 'mouse', button: 0, pointerId: 1 };
            b.dispatchEvent(new PointerEvent('pointerdown', opts));
            b.dispatchEvent(new MouseEvent('mousedown', opts));
            b.dispatchEvent(new PointerEvent('pointerup', opts));
            b.dispatchEvent(new MouseEvent('mouseup', opts));
            b.dispatchEvent(new MouseEvent('click', opts));
            b.click();
            return true;
          }
        }
      }
      return false;
    })()`,
    returnByValue: true,
  });
  await sleep(500);

  // Step 5: Click Import slides button (y > 400) via pointer events
  console.log("Clicking Import slides button (pointer events)...");
  await Runtime.evaluate({
    expression: `(() => {
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        if (b.textContent?.trim() === 'Import slides') {
          const r = b.getBoundingClientRect();
          if (r.y > 400 && r.width > 0) {
            const opts = { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2, pointerType: 'mouse', button: 0, pointerId: 1 };
            b.dispatchEvent(new PointerEvent('pointerdown', opts));
            b.dispatchEvent(new MouseEvent('mousedown', opts));
            b.dispatchEvent(new PointerEvent('pointerup', opts));
            b.dispatchEvent(new MouseEvent('mouseup', opts));
            b.dispatchEvent(new MouseEvent('click', opts));
            b.click();
            return true;
          }
        }
      }
      return false;
    })()`,
    returnByValue: true,
  });

  // Poll for completion
  console.log("Polling for import completion...");
  const start = Date.now();
  while (Date.now() - start < 8000) {
    const c = await Runtime.evaluate({
      expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
      returnByValue: true,
    });
    const n = c.result.value as number;
    if (n >= 10) {
      console.log(`  Count: ${n}, likely done`);
      break;
    }
    await sleep(200);
  }
  await sleep(1000);

  // Final count
  const finalCount = await Runtime.evaluate({
    expression: `(() => {
      const fs = document.querySelector('.punch-filmstrip-scroll');
      if (fs) fs.scrollTop = fs.scrollHeight;
      return document.querySelectorAll('.punch-filmstrip-thumbnail').length;
    })()`,
    returnByValue: true,
  });
  console.log(`Final slide count: ${finalCount.result.value}`);

  // Scroll back
  await Runtime.evaluate({
    expression: `document.querySelector('.punch-filmstrip-scroll')?.scrollTo({ top: 0 })`,
  });
  await sleep(300);

  // Screenshot
  const ss = await Page.captureScreenshot({ format: "png" });
  writeFileSync("/workspaces/sashaslides/presentations/1/screenshots/fresh_import.png", Buffer.from(ss.data, "base64"));
  console.log("Screenshot: fresh_import.png");

  await client.close();
}
main().catch(console.error);
