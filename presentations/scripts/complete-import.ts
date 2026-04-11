/**
 * Complete a stuck Import Slides dialog: select all + import button via
 * PointerEvent dispatches. Fast-fail polling.
 */
import CDP from "chrome-remote-interface";
import { writeFileSync } from "node:fs";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY")
  );
  if (!tab) { console.error("No original tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Runtime, Target, Page } = client;
  await Target.activateTarget({ targetId: tab.id });
  await Page.enable();
  await sleep(300);

  // Click Select all slides via PointerEvent
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

  // Click Import slides button via PointerEvent
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

  // Fast-fail polling: wait up to 6s for slide count to reach >= 20
  const start = Date.now();
  let lastCount = 0;
  while (Date.now() - start < 8000) {
    const c = await Runtime.evaluate({
      expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
      returnByValue: true,
    });
    const n = c.result.value as number;
    if (n !== lastCount) {
      console.log(`  Count: ${n}`);
      lastCount = n;
    }
    if (n >= 20) break;
    await sleep(200);
  }

  // Final count after scroll
  await Runtime.evaluate({
    expression: `document.querySelector('.punch-filmstrip-scroll')?.scrollTo({top: 99999})`,
  });
  await sleep(300);
  const fin = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  console.log(`Final: ${fin.result.value} slides`);

  await Runtime.evaluate({
    expression: `document.querySelector('.punch-filmstrip-scroll')?.scrollTo({top: 0})`,
  });
  await sleep(300);

  const ss = await Page.captureScreenshot({ format: "png" });
  writeFileSync("/workspaces/sashaslides/presentations/1/screenshots/import_done.png", Buffer.from(ss.data, "base64"));
  console.log("Screenshot: import_done.png");

  await client.close();
}
main().catch(console.error);
