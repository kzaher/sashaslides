import CDP from "chrome-remote-interface";
import { writeFileSync } from "node:fs";

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" &&
      t.url.includes("docs.google.com/presentation") &&
      !t.url.includes("1xegFC0RQiZd")
  );
  if (!tab) { console.error("No new pres tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Runtime, Input, Page } = client;
  await Page.enable();

  // Reload to see updated content
  await Page.reload();
  await new Promise(r => setTimeout(r, 6000));

  // Dismiss any dialog
  const gotItResult = await Runtime.evaluate({
    expression: `(() => {
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        if (b.textContent?.trim() === 'Got it') {
          const r = b.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });
  if (gotItResult.result.value) {
    const pos = gotItResult.result.value as { x: number; y: number };
    await Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await new Promise(r => setTimeout(r, 500));
  }

  // Screenshot several slides
  for (const n of [1, 4, 8, 13, 17, 19]) {
    await Runtime.evaluate({
      expression: `(() => {
        const thumbs = document.querySelectorAll('.punch-filmstrip-thumbnail');
        const idx = ${n - 1};
        if (thumbs[idx]) {
          thumbs[idx].scrollIntoView({ block: 'center' });
          const r = thumbs[idx].getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
        return null;
      })()`,
      returnByValue: true,
    }).then(async (r) => {
      const pos = r.result.value as { x: number; y: number } | null;
      if (pos) {
        await Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
        await Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
      }
    });
    await new Promise(r => setTimeout(r, 1500));

    const screenshot = await Page.captureScreenshot({ format: "png" });
    const path = `/workspaces/sashaslides/presentations/1/screenshots/final_slide_${String(n).padStart(2, "0")}.png`;
    writeFileSync(path, Buffer.from(screenshot.data, "base64"));
    console.log(`Saved slide ${n}`);
  }

  await client.close();
}
main().catch(console.error);
