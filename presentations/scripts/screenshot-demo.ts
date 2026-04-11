import CDP from "chrome-remote-interface";
import { writeFileSync } from "node:fs";

async function main() {
  const newTarget = await CDP.New({
    port: 9222,
    url: "file:///workspaces/sashaslides/presentation-templates/whiteboard/demo.html",
  });
  const client = await CDP({ target: newTarget });
  const { Page, Emulation, Runtime } = client;
  await Page.enable();
  await Emulation.setDeviceMetricsOverride({
    width: 1280,
    height: 1800,
    deviceScaleFactor: 1.5,
    mobile: false,
  });

  await Page.loadEventFired();
  await Runtime.evaluate({
    expression: "document.fonts.ready.then(() => new Promise(r => setTimeout(r, 800)))",
    awaitPromise: true,
  });

  const ss = await Page.captureScreenshot({ format: "png", captureBeyondViewport: true });
  writeFileSync("/workspaces/sashaslides/presentations/1/screenshots/graph_demo.png", Buffer.from(ss.data, "base64"));
  console.log("Saved: graph_demo.png");

  await CDP.Close({ port: 9222, id: newTarget.id });
  await client.close();
}
main().catch(console.error);
