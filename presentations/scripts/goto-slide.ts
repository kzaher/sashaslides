import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";

async function main() {
  const slideNum = parseInt(process.argv[2] ?? "1", 10);
  const outputDir = "/workspaces/sashaslides/presentations/1/screenshots";
  mkdirSync(outputDir, { recursive: true });

  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("docs.google.com/presentation")
  );
  if (!tab) { console.error("No Slides tab"); process.exit(1); }

  const client = await CDP({ target: tab });
  const { Runtime, Input, Page } = client;

  // Navigate to the requested slide by clicking the thumbnail
  await Runtime.evaluate({
    expression: `
      (() => {
        const thumbs = document.querySelectorAll('.punch-filmstrip-thumbnail');
        const idx = ${slideNum - 1};
        if (thumbs[idx]) {
          thumbs[idx].scrollIntoView({ block: 'center' });
          return 'scrolled to ' + idx;
        }
        return 'not found, total=' + thumbs.length;
      })()
    `,
    returnByValue: true,
  });

  await new Promise((r) => setTimeout(r, 500));

  // Click it
  const posResult = await Runtime.evaluate({
    expression: `
      (() => {
        const thumbs = document.querySelectorAll('.punch-filmstrip-thumbnail');
        const el = thumbs[${slideNum - 1}];
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()
    `,
    returnByValue: true,
  });
  const pos = posResult.result.value as { x: number; y: number } | null;
  if (pos) {
    await Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  }

  await new Promise((r) => setTimeout(r, 1000));

  await Page.enable();
  const screenshot = await Page.captureScreenshot({ format: "png" });
  const path = `${outputDir}/slide_${String(slideNum).padStart(2, "0")}.png`;
  writeFileSync(path, Buffer.from(screenshot.data, "base64"));
  console.log(`Screenshot saved: ${path}`);

  await client.close();
}

main().catch(console.error);
