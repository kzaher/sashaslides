import CDP from "chrome-remote-interface";

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) => t.type === "page" && t.url.includes("docs.google.com/presentation")
  );
  if (!tab) { console.error("No Slides tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Runtime, Input } = client;

  // Click first thumbnail to navigate to slide 1
  const posResult = await Runtime.evaluate({
    expression: `(() => {
      const thumbs = document.querySelectorAll(".punch-filmstrip-thumbnail");
      if (thumbs[0]) {
        thumbs[0].scrollIntoView({ block: "center" });
        const r = thumbs[0].getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y + r.height/2 };
      }
      return null;
    })()`,
    returnByValue: true,
  });
  const pos = posResult.result.value as { x: number; y: number } | null;
  if (pos) {
    await Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  }
  await sleep(800);

  // Click on the main slide canvas area to focus it (not the filmstrip)
  const areaResult = await Runtime.evaluate({
    expression: `(() => {
      const svgs = document.querySelectorAll(".workspace svg");
      for (const svg of svgs) {
        const r = svg.getBoundingClientRect();
        if (r.width > 300 && r.height > 150) return { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      return null;
    })()`,
    returnByValue: true,
  });
  const area = areaResult.result.value as { x: number; y: number; w: number; h: number };
  if (!area) { console.error("no slide area"); await client.close(); return; }

  // Click the slide canvas to focus it
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  await Input.dispatchMouseEvent({ type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
  await sleep(500);

  // Press Enter to select first placeholder, then Enter again to edit it
  // In Google Slides: Enter enters the selected element for editing
  // Tab cycles between placeholders
  await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "Enter", windowsVirtualKeyCode: 13 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(500);

  // Now we should be in the title placeholder editing mode
  // Type the title
  await Input.insertText({ text: "Gemini Search: Q2 Update for Rob" });
  await sleep(300);

  // Tab to subtitle
  // First Escape to exit text editing, then Tab to move to subtitle placeholder
  await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "Escape", windowsVirtualKeyCode: 27 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(200);
  await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "Tab", windowsVirtualKeyCode: 9 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Tab", windowsVirtualKeyCode: 9 });
  await sleep(300);
  // Enter to start editing
  await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "Enter", windowsVirtualKeyCode: 13 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(300);

  // Type subtitle
  await Input.insertText({ text: "Search Triggering & Optimization Team  |  April 2026" });
  await sleep(300);

  // Escape out completely
  await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "Escape", windowsVirtualKeyCode: 27 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(100);
  await Input.dispatchKeyEvent({ type: "rawKeyDown", key: "Escape", windowsVirtualKeyCode: 27 });
  await Input.dispatchKeyEvent({ type: "keyUp", key: "Escape", windowsVirtualKeyCode: 27 });

  console.log("Slide 1 fixed!");
  await client.close();
}
main().catch(console.error);
