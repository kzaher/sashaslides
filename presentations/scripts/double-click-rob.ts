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
  const { Input, Page, Target, Runtime } = client;
  await Target.activateTarget({ targetId: tab.id });
  await Page.enable();
  await new Promise(r => setTimeout(r, 500));

  // Double-click on the RobPresentation to open it directly
  const x = 549, y = 313;
  console.log(`Double-clicking RobPresentation at (${x}, ${y})`);
  await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await new Promise(r => setTimeout(r, 100));
  await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 2 });
  await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 2 });

  console.log("Waiting for thumbnails dialog...");
  await new Promise(r => setTimeout(r, 8000));

  // Screenshot the result
  const ss = await Page.captureScreenshot({ format: "png" });
  writeFileSync("/workspaces/sashaslides/presentations/1/screenshots/thumbnails_dialog.png", Buffer.from(ss.data, "base64"));
  console.log("Screenshot: thumbnails_dialog.png");

  // Also check what buttons are visible
  const btns = await Runtime.evaluate({
    expression: `(() => {
      const out = [];
      document.querySelectorAll('button, [role="button"], [role="checkbox"], label').forEach(b => {
        const t = (b.textContent || '').trim();
        const r = b.getBoundingClientRect();
        if (t && r.width > 0 && r.height > 0 && r.y > 50 && r.y < 720) {
          out.push({ text: t.slice(0, 50), x: Math.round(r.x), y: Math.round(r.y) });
        }
      });
      return out.slice(0, 30);
    })()`,
    returnByValue: true,
  });
  console.log("Visible buttons/checkboxes:");
  for (const b of (btns.result.value as any[])) {
    console.log(`  [${b.x},${b.y}] ${b.text}`);
  }

  await client.close();
}
main().catch(console.error);
