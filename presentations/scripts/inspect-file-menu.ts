import CDP from "chrome-remote-interface";

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
  await new Promise(r => setTimeout(r, 500));

  // Click File menu
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
  const pos = fileResult.result.value as { x: number; y: number } | null;
  if (!pos) { console.error("no file"); return; }

  await Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  await new Promise(r => setTimeout(r, 800));

  // List all menu items visible
  const items = await Runtime.evaluate({
    expression: `(() => {
      const menuItems = document.querySelectorAll('[role="menuitem"]');
      const out = [];
      for (const m of menuItems) {
        const text = (m.textContent || '').trim().slice(0, 50);
        const r = m.getBoundingClientRect();
        if (r.width > 0 && text) {
          out.push({ text, x: Math.round(r.x), y: Math.round(r.y), visible: r.y > 0 });
        }
      }
      return out;
    })()`,
    returnByValue: true,
  });
  console.log("Menu items:");
  for (const it of (items.result.value as any[])) {
    console.log(`  ${it.visible ? '*' : ' '} [${it.x},${it.y}] ${it.text}`);
  }

  // Dismiss menu
  await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "Escape", windowsVirtualKeyCode: 27 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 });

  await client.close();
}
main().catch(console.error);
