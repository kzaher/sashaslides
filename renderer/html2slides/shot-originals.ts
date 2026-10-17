#!/usr/bin/env npx tsx
import CDPraw from "chrome-remote-interface";
import { readdirSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import type { CdpModule } from "../../types/cdp-types.ts";

// chrome-remote-interface ships no .d.ts; its default export is declared
// `unknown` (types/ambient.d.ts). Narrow it to the shared typed boundary once.
const CDP = CDPraw as CdpModule;

// HTML2SLIDES_CHROME_PORT selects the browser, as in convert-pptx-io.ts.
const PORT = Number(process.env.HTML2SLIDES_CHROME_PORT ?? "9222");
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
