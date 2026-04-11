import CDP from "chrome-remote-interface";
import { writeFileSync } from "node:fs";

async function main() {
  const nums = process.argv.slice(2).map(Number);
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("1xegFC0RQiZd-WaRogVOfSHVqmOFUVPbHUsOHSzPKUUY")
  );
  if (!tab) { console.error("No tab"); process.exit(1); }
  const client = await CDP({ target: tab });
  const { Runtime, Input, Page, Target } = client;
  await Target.activateTarget({ targetId: tab.id });
  await Page.enable();
  await new Promise(r => setTimeout(r, 400));

  for (const n of nums) {
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
      const pos = r.result.value as any;
      if (pos) {
        await Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
        await Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
      }
    });
    await new Promise(r => setTimeout(r, 900));
    const ss = await Page.captureScreenshot({ format: "png" });
    writeFileSync(`/workspaces/sashaslides/presentations/1/screenshots/v3_slide_${String(n).padStart(2, "0")}.png`, Buffer.from(ss.data, "base64"));
    console.log(`Saved slide ${n}`);
  }
  await client.close();
}
main().catch(console.error);
