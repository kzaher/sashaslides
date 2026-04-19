#!/usr/bin/env npx tsx
import CDP from "chrome-remote-interface";
import { readdirSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";

const PORT = 9222;
const dir = resolve(process.argv[2]);
const out = resolve(process.argv[3]);
mkdirSync(out, { recursive: true });
const files = readdirSync(dir).filter(f => f.endsWith(".html")).sort();

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function shot(htmlPath: string, outPath: string) {
  const target = await CDP.New({ port: PORT, url: "about:blank" });
  const client = await CDP({ target, port: PORT });
  const { Page, Emulation } = client;
  await Page.enable();
  await Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await Page.navigate({ url: "file://" + htmlPath });
  await Page.loadEventFired();
  await sleep(300);
  const { data } = await Page.captureScreenshot({ format: "png", clip: { x:0, y:0, width:1280, height:720, scale:1 } });
  writeFileSync(outPath, Buffer.from(data, "base64"));
  await client.close();
  await CDP.Close({ port: PORT, id: target.id });
}

(async () => {
  for (let i = 0; i < files.length; i++) {
    const htmlPath = join(dir, files[i]);
    const outPath = join(out, `slide_${String(i+1).padStart(2,"0")}.png`);
    await shot(htmlPath, outPath);
    console.log(`  ${files[i]} -> ${outPath}`);
  }
})();
