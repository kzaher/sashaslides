import CDP from "chrome-remote-interface";
import * as fs from "fs";

const startTime = Date.now();

async function clickAt(client: any, x: number, y: number) {
  const { Input } = client;
  await Input.dispatchMouseEvent({
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await new Promise((r) => setTimeout(r, 40));
  await Input.dispatchMouseEvent({
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function pressDelete(client: any) {
  const { Input } = client;
  await Input.dispatchKeyEvent({
    type: "rawKeyDown",
    key: "Delete",
    windowsVirtualKeyCode: 46,
    nativeVirtualKeyCode: 46,
  });
  await new Promise((r) => setTimeout(r, 30));
  await Input.dispatchKeyEvent({
    type: "keyUp",
    key: "Delete",
    windowsVirtualKeyCode: 46,
    nativeVirtualKeyCode: 46,
  });
}

async function getStartCount(client: any): Promise<number> {
  const { Runtime } = client;
  const result = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  return result.result.value;
}

async function getFirstThumbPosition(client: any): Promise<any> {
  const { Runtime } = client;
  const result = await Runtime.evaluate({
    expression: `(() => {
      const t = document.querySelector('.punch-filmstrip-thumbnail');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: r.x + r.width/2, y: r.y + r.height/2 };
    })()`,
    returnByValue: true,
  });
  return result.result.value;
}

async function countThumbnails(client: any): Promise<number> {
  const { Runtime } = client;
  const result = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  return result.result.value;
}

async function scrollToTop(client: any) {
  const { Runtime } = client;
  await Runtime.evaluate({
    expression: `document.querySelector('.punch-filmstrip-scroll').scrollTop = 0`,
  });
  await new Promise((r) => setTimeout(r, 150));
}

async function takeScreenshot(client: any, path: string) {
  const { Page } = client;
  const result = await Page.captureScreenshot({ format: "png" });
  const buffer = Buffer.from(result.data, "base64");
  fs.writeFileSync(path, buffer);
}

async function main() {
  let client: any;
  try {
    client = await CDP({ port: 9222 });
    const { Page, Input, Runtime } = client;

    await Page.enable();
    console.log("Connected to Google Slides presentation");

    const startCount = await getStartCount(client);
    console.log(`Starting count: ${startCount} slides`);

    let previousCount = startCount;

    for (let i = 0; i < 19; i++) {
      await scrollToTop(client);

      const pos = await getFirstThumbPosition(client);
      if (!pos) {
        console.log(`No more thumbnails at iteration ${i}`);
        break;
      }

      await clickAt(client, pos.x, pos.y);
      await new Promise((r) => setTimeout(r, 200));

      await pressDelete(client);
      await new Promise((r) => setTimeout(r, 400));

      if ((i + 1) % 5 === 0 || i === 18) {
        const count = await countThumbnails(client);
        console.log(`After ${i + 1} deletes: ${count} slides`);

        if (count === previousCount) {
          console.log("Warning: slide count not decreasing, breaking loop");
          break;
        }
        previousCount = count;
      }
    }

    const finalCount = await countThumbnails(client);
    console.log(`Final count: ${finalCount} slides`);

    await takeScreenshot(
      client,
      "/workspaces/sashaslides/presentations/1/screenshots/after_delete.png"
    );
    console.log("Screenshot saved to after_delete.png");

    const runtime = Date.now() - startTime;
    console.log(`Runtime: ${runtime}ms`);
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  } finally {
    if (client) {
      await client.close();
    }
  }
}

main();
