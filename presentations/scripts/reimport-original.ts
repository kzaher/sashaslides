/**
 * Delete all slides from the original presentation, then import fresh from
 * the updated RobPresentation. Uses the working File > Import slides flow.
 */
import CDP from "chrome-remote-interface";
import { writeFileSync } from "node:fs";

const ORIG_ID = "1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes(ORIG_ID)
  );
  if (!tab) { console.error("No original tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Runtime, Input, Target, Page } = client;
  await Target.activateTarget({ targetId: tab.id });
  await Page.enable();
  await sleep(400);

  // Step 1: Delete all existing slides via filmstrip Ctrl+A + Delete
  console.log("Deleting all existing slides...");

  // Scroll to top and click first thumbnail
  await Runtime.evaluate({
    expression: `document.querySelector('.punch-filmstrip-scroll')?.scrollTo({top: 0})`,
  });
  await sleep(200);
  const first = await Runtime.evaluate({
    expression: `(() => {
      const t = document.querySelector('.punch-filmstrip-thumbnail');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`,
    returnByValue: true,
  });
  if (first.result.value) {
    const pos = first.result.value as any;
    await Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await sleep(300);
    // Ctrl+A in filmstrip selects all slides
    await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "a", windowsVirtualKeyCode: 65, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: "keyUp", key: "a", windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(300);
    // Delete
    await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "Delete", windowsVirtualKeyCode: 46 });
    await Input.dispatchKeyEvent({ type: "keyUp", key: "Delete", windowsVirtualKeyCode: 46 });
    await sleep(800);
  }

  const afterDel = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  console.log(`After delete: ${afterDel.result.value} slides`);

  // Step 2: File > Import slides
  console.log("Opening File > Import slides...");
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
  const fp = fileBtn.result.value as any;
  await Input.dispatchMouseEvent({ type: "mousePressed", x: fp.x, y: fp.y, button: "left", clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: fp.x, y: fp.y, button: "left", clickCount: 1 });
  await sleep(400);

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
  const ip = imp.result.value as any;
  await Input.dispatchMouseEvent({ type: "mousePressed", x: ip.x, y: ip.y, button: "left", clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: ip.x, y: ip.y, button: "left", clickCount: 1 });
  await sleep(3000);

  // Step 3: Double-click RobPresentation thumbnail
  console.log("Opening RobPresentation...");
  await Input.dispatchMouseEvent({ type: "mousePressed", x: 549, y: 313, button: "left", clickCount: 2 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: 549, y: 313, button: "left", clickCount: 2 });
  await sleep(4000);

  // Step 4: Select all + Import via PointerEvent
  console.log("Selecting all and importing...");
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

  // Poll for completion (fast-fail)
  console.log("Polling for import...");
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const c = await Runtime.evaluate({
      expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
      returnByValue: true,
    });
    const n = c.result.value as number;
    if (n >= 15) {
      console.log(`  Count: ${n}, done`);
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
  console.log(`Final: ${finalCount.result.value} slides`);
  await Runtime.evaluate({
    expression: `document.querySelector('.punch-filmstrip-scroll')?.scrollTo({top: 0})`,
  });
  await sleep(300);

  const ss = await Page.captureScreenshot({ format: "png" });
  writeFileSync("/workspaces/sashaslides/presentations/1/screenshots/original_fixed.png", Buffer.from(ss.data, "base64"));
  console.log("Screenshot: original_fixed.png");

  await client.close();
}
main().catch(console.error);
