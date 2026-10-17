#!/usr/bin/env npx tsx
/**
 * shot-originals.ts <html-dir> <out-dir> — the HTML truth of the goldens gate: every fixture at
 * 1280 x 720, device scale 2, written as slide_NN.png in file order.
 *
 * Captured by reverse/chrome-capture.ts, the one HTML screenshotter: it subscribes to the load
 * event before navigating and polls font readiness instead of sleeping. HTML2SLIDES_CHROME_PORT
 * selects the browser, as in convert-pptx-io.ts.
 */
import { readdirSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { openChromeTab } from "./reverse/chrome-capture.ts";

const port = Number(process.env.HTML2SLIDES_CHROME_PORT ?? "9222");
const dir = resolve(process.argv[2] ?? ".");
const out = resolve(process.argv[3] ?? "originals");
mkdirSync(out, { recursive: true });
const files = readdirSync(dir).filter((f) => f.endsWith(".html")).sort();

async function main(): Promise<void> {
  await using tab = await openChromeTab({ port, deviceScaleFactor: 2 });
  for (const [i, file] of files.entries()) {
    const outPath = join(out, `slide_${String(i + 1).padStart(2, "0")}.png`);
    const capture = await tab.capture({ address: pathToFileURL(join(dir, file)).href });
    writeFileSync(outPath, capture.png);
    console.log(`  ${file} -> ${outPath}${capture.readiness === "ready" ? "" : " (fonts never finished loading)"}`);
  }
}

main().catch((cause: unknown) => {
  console.error(cause);
  process.exit(1);
});
