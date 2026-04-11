import CDP from "chrome-remote-interface";

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const driveTab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("drive.google.com")
  );
  if (!driveTab) { console.error("No drive tab"); process.exit(1); }
  const client = await CDP({ target: driveTab });
  const { Runtime, Input } = client;

  // Find a "Replace" or "Upload" button
  const btnResult = await Runtime.evaluate({
    expression: `(() => {
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        const text = b.textContent?.trim() || '';
        if (text === 'Replace existing file' || text === 'Replace' || text === 'Upload') {
          const r = b.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2, text };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (btnResult.result.value) {
    const pos = btnResult.result.value as { x: number; y: number; text: string };
    console.log(`Clicking "${pos.text}"...`);
    await Input.dispatchMouseEvent({ type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1 });
  } else {
    console.log("No Replace button found");
  }

  await new Promise(r => setTimeout(r, 10000));

  await client.close();
}
main();
