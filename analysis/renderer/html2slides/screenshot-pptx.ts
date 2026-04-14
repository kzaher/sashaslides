#!/usr/bin/env npx tsx
/**
 * screenshot-pptx.ts — Upload .pptx to Drive, open as Slides, screenshot each slide
 *
 * Usage: npx tsx screenshot-pptx.ts <pptx-path> <output-dir> [--presentation <existing-id>]
 */

import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, resolve, basename } from "path";

const CDP_PORT = 9222;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function uploadAndOpen(pptxPath: string): Promise<string> {
  // Use existing upload logic from presentations/scripts/
  const uploadScript = "/workspaces/sashaslides/presentations/scripts/upload-pptx-to-slides.ts";
  if (!existsSync(uploadScript)) {
    console.error("upload-pptx-to-slides.ts not found");
    process.exit(1);
  }

  const { execSync } = await import("child_process");
  execSync(`cd /workspaces/sashaslides/presentations/scripts && npx tsx upload-pptx-to-slides.ts "${resolve(pptxPath)}"`, {
    timeout: 60000, encoding: "utf-8", stdio: "inherit"
  });

  // Find the new Slides tab
  await sleep(5000);
  const targets = await CDP.List({ port: CDP_PORT });
  const tab = targets.find((t: any) => t.url.includes("docs.google.com/presentation"));
  return tab?.id || "";
}

async function screenshotSlides(tabId: string, outputDir: string, slideCount: number): Promise<number> {
  const targets = await CDP.List({ port: CDP_PORT });
  const tab = targets.find((t: any) => t.id === tabId || t.url.includes("docs.google.com/presentation"));
  if (!tab) return 0;

  const client = await CDP({ target: tab, port: CDP_PORT });
  const { Page, Runtime, Emulation } = client;
  await Page.enable();
  await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await sleep(2000);

  // Force-render all thumbnails
  await Runtime.evaluate({ expression: `document.querySelector('.punch-filmstrip-scroll')?.scrollTop = 99999` });
  await sleep(500);

  const { result: countResult } = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  const count = countResult.value || slideCount;

  mkdirSync(outputDir, { recursive: true });
  let captured = 0;

  for (let i = 0; i < count; i++) {
    // Click thumbnail
    await Runtime.evaluate({
      expression: `(() => {
        const thumbs = document.querySelectorAll('.punch-filmstrip-thumbnail');
        const t = thumbs[${i}];
        if (!t) return;
        t.scrollIntoView({ block: 'center' });
        const r = t.getBoundingClientRect();
        const opts = { bubbles:true, cancelable:true, clientX:r.x+r.width/2, clientY:r.y+r.height/2, pointerType:'mouse', button:0, pointerId:1 };
        t.dispatchEvent(new PointerEvent('pointerdown', opts));
        t.dispatchEvent(new MouseEvent('mousedown', opts));
        t.dispatchEvent(new PointerEvent('pointerup', opts));
        t.dispatchEvent(new MouseEvent('mouseup', opts));
        t.dispatchEvent(new MouseEvent('click', opts));
      })()`,
    });
    await sleep(600);

    // Screenshot canvas
    const { result: canvasResult } = await Runtime.evaluate({
      expression: `(() => {
        const c = document.querySelector('.punch-viewer-svgpage-svgcontainer');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()`,
      returnByValue: true,
    });

    if (canvasResult.value) {
      const ss = await Page.captureScreenshot({
        format: "png",
        clip: { ...canvasResult.value, scale: 2 },
        captureBeyondViewport: true,
      });
      writeFileSync(join(outputDir, `slide_${String(i + 1).padStart(2, "0")}.png`), Buffer.from(ss.data, "base64"));
      captured++;
    }
  }

  await client.close();
  return captured;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: npx tsx screenshot-pptx.ts <pptx-path> <output-dir>");
    process.exit(1);
  }

  const pptxPath = args[0];
  const outputDir = args[1];
  mkdirSync(outputDir, { recursive: true });

  console.log(`Uploading ${basename(pptxPath)} to Drive...`);
  const tabId = await uploadAndOpen(pptxPath);

  console.log(`Screenshotting slides...`);
  const count = await screenshotSlides(tabId, outputDir, 20);
  console.log(`  ${count} slides captured → ${outputDir}/`);
}

main().catch(err => { console.error(err); process.exit(1); });
