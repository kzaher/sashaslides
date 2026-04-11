/**
 * screenshot-slides.ts
 *
 * Screenshots all slides from a Google Slides presentation using
 * Chrome DevTools Protocol. Saves PNGs to an output directory.
 *
 * Usage: npx tsx presentations/scripts/screenshot-slides.ts <presentation-url> [output-dir]
 */

import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npx tsx screenshot-slides.ts <presentation-url> [output-dir]");
    process.exit(1);
  }

  const presentationUrl = args[0];
  const outputDir = args[1] ?? "presentations/1/screenshots";

  const match = presentationUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    console.error("Invalid presentation URL");
    process.exit(1);
  }
  const presentationId = match[1];

  mkdirSync(outputDir, { recursive: true });

  console.log("Connecting to Chrome...");
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find((t: { url: string }) =>
    t.url.includes("docs.google.com/presentation")
  ) || targets[0];

  if (!tab) {
    console.error("No Chrome tabs found.");
    process.exit(1);
  }

  const client = await CDP({ target: tab });
  const { Page, Runtime, Emulation } = client;

  await Page.enable();
  await Emulation.setDeviceMetricsOverride({
    width: 1280,
    height: 720,
    deviceScaleFactor: 2,
    mobile: false,
  });

  // Navigate to the presentation in present mode for clean screenshots
  const presentUrl = `https://docs.google.com/presentation/d/${presentationId}/preview`;
  console.log(`Navigating to ${presentUrl}`);
  await Page.navigate({ url: presentUrl });
  await Page.loadEventFired();

  // Wait for initial render
  await Runtime.evaluate({
    expression: "new Promise(r => setTimeout(r, 4000))",
    awaitPromise: true,
  });

  // Get number of slides by checking the page
  const slideCountResult = await Runtime.evaluate({
    expression: `
      // Try to find slide count from the filmstrip or navigation
      (function() {
        // In preview mode, slides are rendered as pages
        const pages = document.querySelectorAll('.punch-viewer-page');
        if (pages.length > 0) return pages.length;
        // Fallback: try the filmstrip
        const filmstrip = document.querySelectorAll('[class*="filmstrip"] [class*="slide"]');
        if (filmstrip.length > 0) return filmstrip.length;
        return 0;
      })()
    `,
    returnByValue: true,
  });

  let slideCount = slideCountResult.result.value as number;
  console.log(`Detected ${slideCount} slides`);

  if (slideCount === 0) {
    // Fallback: use Slides API to count
    console.log("Trying Slides API to count slides...");
    const apiResult = await Runtime.evaluate({
      expression: `
        fetch("https://slides.googleapis.com/v1/presentations/${presentationId}",
          { credentials: "include" })
        .then(r => r.json())
        .then(d => d.slides ? d.slides.length : 0)
      `,
      awaitPromise: true,
      returnByValue: true,
    });
    slideCount = apiResult.result.value as number;
    console.log(`API says ${slideCount} slides`);
  }

  if (slideCount === 0) {
    console.log("Could not determine slide count. Taking one screenshot.");
    slideCount = 1;
  }

  // Screenshot the preview page — each slide is a visible section
  // In preview mode we can scroll to each slide
  for (let i = 0; i < slideCount; i++) {
    console.log(`Screenshotting slide ${i + 1}/${slideCount}...`);

    // Scroll to the slide in preview mode
    await Runtime.evaluate({
      expression: `
        (function() {
          const pages = document.querySelectorAll('.punch-viewer-page');
          if (pages[${i}]) {
            pages[${i}].scrollIntoView({ behavior: 'instant' });
            return true;
          }
          return false;
        })()
      `,
      awaitPromise: false,
      returnByValue: true,
    });

    // Brief wait for render
    await Runtime.evaluate({
      expression: "new Promise(r => setTimeout(r, 1000))",
      awaitPromise: true,
    });

    const screenshot = await Page.captureScreenshot({
      format: "png",
      captureBeyondViewport: false,
    });

    const filePath = `${outputDir}/slide_${String(i + 1).padStart(2, "0")}.png`;
    writeFileSync(filePath, Buffer.from(screenshot.data, "base64"));
    console.log(`  Saved: ${filePath}`);
  }

  await client.close();
  console.log(`\nDone! ${slideCount} screenshots saved to ${outputDir}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
