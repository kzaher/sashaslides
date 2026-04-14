#!/usr/bin/env npx tsx
/**
 * screenshot-html-slides.ts — Render HTML slide files to PNG screenshots via Chrome
 *
 * Usage: npx tsx screenshot-html-slides.ts <html-dir> [output-dir]
 *
 * Opens slides in Chrome at 1280x720@2x and captures screenshots.
 * Processes slides in parallel batches for speed.
 */

import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, resolve } from "path";

const CDP_PORT = 9222;
const BATCH_SIZE = 5; // parallel tabs at once

async function screenshotOne(filePath: string, outPath: string): Promise<void> {
  const tab = await (CDP as any).New({ port: CDP_PORT, url: `file://${filePath}` });
  try {
    const client = await CDP({ target: tab, port: CDP_PORT });
    const { Page, Emulation, Runtime } = client;
    await Page.enable();
    await Runtime.enable();
    await Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });

    // Wait for fonts instead of sleeping
    await Runtime.evaluate({ expression: `document.fonts.ready.then(() => true)`, awaitPromise: true, returnByValue: true })
      .catch(() => {}); // fallback if no fonts
    // Small settle time for layout
    await new Promise(r => setTimeout(r, 200));

    const screenshot = await Page.captureScreenshot({ format: "png", captureBeyondViewport: false });
    writeFileSync(outPath, Buffer.from(screenshot.data, "base64"));
    await client.close();
  } finally {
    await (CDP as any).Close({ port: CDP_PORT, id: tab.id }).catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npx tsx screenshot-html-slides.ts <html-dir> [output-dir]");
    process.exit(1);
  }

  const htmlDir = resolve(args[0]);
  const outputDir = args[1] ? resolve(args[1]) : join(htmlDir, "screenshots");
  mkdirSync(outputDir, { recursive: true });

  const htmlFiles = readdirSync(htmlDir)
    .filter(f => f.endsWith(".html"))
    .sort();

  if (htmlFiles.length === 0) {
    console.error(`No .html files in ${htmlDir}`);
    process.exit(1);
  }

  console.log(`Screenshotting ${htmlFiles.length} slides (batch size ${BATCH_SIZE})`);
  const t0 = Date.now();

  // Process in parallel batches
  for (let i = 0; i < htmlFiles.length; i += BATCH_SIZE) {
    const batch = htmlFiles.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (file) => {
      const filePath = join(htmlDir, file);
      const outName = file.replace(".html", ".png");
      const outPath = join(outputDir, outName);
      await screenshotOne(filePath, outPath);
      console.log(`  ${outName}`);
    }));
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone! ${htmlFiles.length} screenshots in ${elapsed}s → ${outputDir}/`);
}

main().catch(err => { console.error("Screenshot failed:", err); process.exit(1); });
