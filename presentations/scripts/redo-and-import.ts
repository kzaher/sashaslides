/**
 * Redoes some undos to get back to a usable state, then uses
 * File > Import Slides with the styled RobPresentation.
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
  if (!tab) { console.error("No original tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Runtime, Input, Target, Page } = client;
  await Page.enable();
  await Target.activateTarget({ targetId: tab.id });
  await sleep(1000);

  // Click in a neutral area to deselect
  const neutralResult = await Runtime.evaluate({
    expression: `(() => {
      const svg = document.querySelector('.workspace svg');
      if (svg) {
        const r = svg.getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y - 20 };
      }
      return null;
    })()`,
    returnByValue: true,
  });
  if (neutralResult.result.value) {
    const pos = neutralResult.result.value as { x: number; y: number };
    await clickAt(Input, pos.x, Math.max(pos.y, 120));
  }
  await sleep(300);

  // Redo 40 times (Ctrl+Shift+Z)
  console.log("Redoing to get back to 19 slides state...");
  for (let i = 0; i < 40; i++) {
    // Ctrl+Shift+Z — modifiers = Ctrl(2) + Shift(8) = 10
    await pressKey(Input, "z", 90, 10);
    await sleep(80);

    if (i % 10 === 9) {
      const count = await Runtime.evaluate({
        expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
        returnByValue: true,
      });
      console.log(`  After ${i + 1} redos: ${count.result.value} slides`);
      if ((count.result.value as number) >= 19) break;
    }
  }

  // Scroll filmstrip to get accurate count
  await Runtime.evaluate({
    expression: `(() => {
      const fs = document.querySelector('.punch-filmstrip-scroll');
      if (fs) fs.scrollTop = fs.scrollHeight;
    })()`,
  });
  await sleep(500);
  const finalCount = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  console.log(`Final: ${finalCount.result.value} slides`);

  // Scroll back
  await Runtime.evaluate({
    expression: `(() => {
      const fs = document.querySelector('.punch-filmstrip-scroll');
      if (fs) fs.scrollTop = 0;
    })()`,
  });
  await sleep(500);

  await client.close();
  console.log("Done!");
}
main().catch(console.error);
