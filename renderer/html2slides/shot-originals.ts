#!/usr/bin/env npx tsx
import CDPDefault from "chrome-remote-interface";
import { readdirSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";

// chrome-remote-interface ships no .d.ts (its default export types as
// `unknown` via types/ambient.d.ts). Narrow the boundary into the methods we
// actually invoke — the only place untyped CDP becomes typed.
interface CDPTarget { id: string; url: string; type: string }
interface CDPEmulation {
  setDeviceMetricsOverride(opts: { width: number; height: number; deviceScaleFactor: number; mobile: boolean }): Promise<unknown>;
}
interface CDPPage {
  enable(): Promise<unknown>;
  navigate(opts: { url: string }): Promise<unknown>;
  loadEventFired(): Promise<unknown>;
  captureScreenshot(opts?: { format?: string; clip?: { x: number; y: number; width: number; height: number; scale?: number } }): Promise<{ data: string }>;
}
interface CDPClient {
  Page: CDPPage;
  Emulation: CDPEmulation;
  close(): Promise<void>;
}
interface CDPModule {
  (opts?: { target?: { id: string; url: string }; port?: number }): Promise<CDPClient>;
  New(opts: { port: number; url?: string }): Promise<CDPTarget>;
  Close(opts: { port: number; id: string }): Promise<void>;
}
const CDP = CDPDefault as CDPModule;

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
