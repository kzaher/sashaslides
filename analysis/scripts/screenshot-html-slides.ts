#!/usr/bin/env npx tsx
/**
 * screenshot-html-slides.ts — Render HTML slide files to PNG screenshots via Chrome
 *
 * Usage: npx tsx screenshot-html-slides.ts <html-dir> [output-dir]
 *
 * Captures every slide at 1280x720@2x as <name>.png with the converter's one HTML screenshotter
 * (renderer/html2slides/reverse/chrome-capture.ts: load event subscribed before navigating, font
 * readiness polled, not slept for). TAB_COUNT tabs, each in a window of its own, share the work.
 */

import { writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { openChromeTab } from "../../renderer/html2slides/reverse/chrome-capture.ts";

const CDP_PORT = 9222;
const TAB_COUNT = 5;

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

  console.log(`Screenshotting ${htmlFiles.length} slides (${TAB_COUNT} tabs)`);
  const t0 = Date.now();

  const queue = [...htmlFiles];
  const worker = async (): Promise<void> => {
    await using tab = await openChromeTab({ port: CDP_PORT, deviceScaleFactor: 2 });
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const capture = await tab.capture({ address: pathToFileURL(join(htmlDir, file)).href });
      const outName = file.replace(".html", ".png");
      writeFileSync(join(outputDir, outName), capture.png);
      console.log(`  ${outName}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TAB_COUNT, htmlFiles.length) }, worker));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone! ${htmlFiles.length} screenshots in ${elapsed}s → ${outputDir}/`);
}

main().catch((cause: unknown) => {
  console.error(cause);
  process.exit(1);
});
