/**
 * Delete the first slide of the original presentation (a leftover blank).
 */
import CDP from "chrome-remote-interface";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY")
  );
  if (!tab) { console.error("No tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Runtime, Input, Target, Page } = client;
  await Target.activateTarget({ targetId: tab.id });
  await Page.enable();
  await sleep(300);

  // Scroll to top
  await Runtime.evaluate({
    expression: `document.querySelector('.punch-filmstrip-scroll')?.scrollTo({top: 0})`,
  });
  await sleep(200);

  // Click first thumbnail
  const r = await Runtime.evaluate({
    expression: `(() => {
      const t = document.querySelector('.punch-filmstrip-thumbnail');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`,
    returnByValue: true,
  });
  if (!r.result.value) { console.error("no thumbnail"); process.exit(1); }
  const pos = r.result.value as { x: number; y: number };
  await Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await sleep(300);

  // Delete
  await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "Delete", windowsVirtualKeyCode: 46 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Delete", windowsVirtualKeyCode: 46 });
  await sleep(700);

  // Count
  const c = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  console.log(`After delete: ${c.result.value} slides`);
  await client.close();
}
main().catch(console.error);
