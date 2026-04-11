/**
 * Opens Import slides dialog and takes a screenshot to see what's in it.
 */
import CDP from "chrome-remote-interface";
import { writeFileSync } from "node:fs";

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
  await new Promise(r => setTimeout(r, 1000));

  // Open File menu
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
  const pos = fileResult.result.value as { x: number; y: number };
  await Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await new Promise(r => setTimeout(r, 500));

  // Click Import slides
  const importResult = await Runtime.evaluate({
    expression: `(() => {
      const items = document.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        if (item.textContent?.trim().startsWith('Import slides')) {
          const r = item.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });
  const ipos = importResult.result.value as { x: number; y: number };
  await Input.dispatchMouseEvent({ type: "mousePressed", x: ipos.x, y: ipos.y, button: "left", clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: ipos.x, y: ipos.y, button: "left", clickCount: 1 });
  await new Promise(r => setTimeout(r, 5000));

  // Take screenshot
  const ss = await Page.captureScreenshot({ format: "png" });
  writeFileSync("/workspaces/sashaslides/presentations/1/screenshots/import_dialog.png", Buffer.from(ss.data, "base64"));
  console.log("Screenshot saved: import_dialog.png");

  // List all iframes and buttons in the dialog
  const dialogInfo = await Runtime.evaluate({
    expression: `(() => {
      const iframes = [];
      document.querySelectorAll('iframe').forEach(f => {
        const r = f.getBoundingClientRect();
        iframes.push({ src: (f.src || '').slice(0, 100), w: r.width, h: r.height, x: r.x, y: r.y });
      });
      const buttons = [];
      document.querySelectorAll('button, [role="button"]').forEach(b => {
        const t = (b.textContent || '').trim();
        const r = b.getBoundingClientRect();
        if (t && r.width > 0 && r.height > 0 && r.y > 50) {
          buttons.push({ text: t.slice(0, 40), x: Math.round(r.x), y: Math.round(r.y) });
        }
      });
      // Also look for any dialogs or modals
      const dialogs = [];
      document.querySelectorAll('[role="dialog"], .modal, [class*="dialog"], [class*="modal"]').forEach(d => {
        const r = d.getBoundingClientRect();
        dialogs.push({ cls: (d.className || '').toString().slice(0, 60), w: r.width, h: r.height });
      });
      return { iframes, buttons: buttons.slice(0, 30), dialogs };
    })()`,
    returnByValue: true,
  });
  console.log("Dialog info:", JSON.stringify(dialogInfo.result.value, null, 2));

  await client.close();
}
main().catch(console.error);
