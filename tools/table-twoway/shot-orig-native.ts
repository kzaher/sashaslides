/**
 * shot-orig-native.ts — Take a Chrome screenshot of slide_17 fixture at
 * deviceScaleFactor=1.25 so the output PNG is natively 1600x900,
 * matching Google Slides' export resolution. This skips ImageMagick
 * downsampling (Lanczos overshoot at color boundaries was producing
 * fake-diff pixels in the comparison).
 */
import CDP from "chrome-remote-interface";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface CDPStatic {
  New(opts: { port: number; url: string }): Promise<{ id: string }>;
  Close(opts: { port: number; id: string }): Promise<void>;
}
const CDPS = CDP as unknown as CDPStatic;

async function main(): Promise<void> {
  const htmlPath = resolve("renderer/html2slides/e2e/fixtures-basic/slide_17_table_rounded.html");
  const out = "/tmp/br-probe-original-native.png";
  const tab = await CDPS.New({ port: 9222, url: "about:blank" });
  const client = await CDP({ target: tab, port: 9222 });
  const { Page, Emulation } = client;
  await Page.enable();
  await Emulation.setDeviceMetricsOverride({
    width: 1280, height: 720, deviceScaleFactor: 1.25, mobile: false,
  });
  await Page.navigate({ url: `file://${htmlPath}` });
  await Page.loadEventFired();
  await new Promise(r => setTimeout(r, 300));
  const { data } = await Page.captureScreenshot({
    format: "png",
    clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 },
  });
  writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`wrote ${out}`);
  await client.close();
  await CDPS.Close({ port: 9222, id: tab.id });
}
main().catch(e => { console.error(e); process.exit(1); });
