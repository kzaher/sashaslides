import CDP from "chrome-remote-interface";

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY")
  );
  if (!tab) { console.error("No tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Input, Runtime, Target } = client;

  await Target.activateTarget({ targetId: tab.id });
  await new Promise(r => setTimeout(r, 1000));

  // Click somewhere neutral in the main area first
  const areaResult = await Runtime.evaluate({
    expression: `(() => {
      const svgs = document.querySelectorAll('.workspace svg');
      for (const svg of svgs) {
        const r = svg.getBoundingClientRect();
        if (r.width > 300) return { x: r.x + r.width/2, y: r.y + r.height/2 };
      }
      return null;
    })()`,
    returnByValue: true,
  });
  const area = areaResult.result.value as { x: number; y: number } | null;
  if (area) {
    // Click in an empty area outside the slide to deselect
    await Input.dispatchMouseEvent({ type: "mousePressed", x: area.x, y: 100, button: "left", clickCount: 1 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: area.x, y: 100, button: "left", clickCount: 1 });
  }
  await new Promise(r => setTimeout(r, 300));

  // Press Ctrl+Z many times to undo all recent changes
  console.log("Undoing recent changes...");
  for (let i = 0; i < 60; i++) {
    await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "z", windowsVirtualKeyCode: 90, modifiers: 2 });
    await new Promise(r => setTimeout(r, 20));
    await Input.dispatchKeyEvent({ type: "keyUp", key: "z", windowsVirtualKeyCode: 90, modifiers: 2 });
    await new Promise(r => setTimeout(r, 100));

    if (i % 10 === 9) {
      const count = await Runtime.evaluate({
        expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
        returnByValue: true,
      });
      console.log(`  After ${i + 1} undos: ${count.result.value} slides`);
    }
  }

  // Final count
  const finalCount = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  console.log(`Final count: ${finalCount.result.value} slides`);

  await client.close();
}
main().catch(console.error);
