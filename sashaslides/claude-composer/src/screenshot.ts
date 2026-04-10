/**
 * Chrome DevTools Protocol screenshot capture for Google Slides presentations.
 * Connects to the Chrome instance running in the devcontainer.
 */

import CDP from "chrome-remote-interface";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type ScreenshotOptions = Readonly<{
  /** Chrome DevTools Protocol host. Default: localhost */
  host: string;
  /** Chrome DevTools Protocol port. Default: 9222 */
  port: number;
  /** Viewport width. Default: 1920 */
  width: number;
  /** Viewport height. Default: 1080 */
  height: number;
  /** Image format. Default: png */
  format: "png" | "jpeg";
  /** JPEG quality (1-100). Only used when format=jpeg. Default: 90 */
  quality: number;
}>;

export type SlideScreenshot = Readonly<{
  /** 0-based slide index. */
  slideIndex: number;
  /** Path where the screenshot was saved. */
  filePath: string;
  /** Base64-encoded image data. */
  data: string;
}>;

const DEFAULT_OPTIONS: ScreenshotOptions = {
  host: "localhost",
  port: 9222,
  width: 1920,
  height: 1080,
  format: "png",
  quality: 90,
};

/**
 * Screenshot a single slide from a Google Slides presentation.
 */
export async function screenshotSlide(
  presentationUrl: string,
  slideIndex: number,
  outputPath: string,
  options?: Partial<ScreenshotOptions>
): Promise<SlideScreenshot> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  // Build the slide-specific URL
  // Google Slides URL format: .../edit#slide=id.SLIDE_ID
  // But we can also use the slide index via the present mode trick
  const slideUrl = buildSlideUrl(presentationUrl, slideIndex);

  let client: CDP.Client | null = null;
  try {
    client = await CDP({ host: opts.host, port: opts.port });
    const { Page, Emulation, Runtime } = client;

    await Page.enable();
    await Emulation.setDeviceMetricsOverride({
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Navigate to the slide
    await Page.navigate({ url: slideUrl });
    await Page.loadEventFired();

    // Wait for slides to render (Google Slides is an SPA)
    await Runtime.evaluate({
      expression: `new Promise(resolve => setTimeout(resolve, 3000))`,
      awaitPromise: true,
    });

    // Capture screenshot
    const screenshot = await Page.captureScreenshot({
      format: opts.format,
      quality: opts.format === "jpeg" ? opts.quality : undefined,
    });

    // Save to file
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(screenshot.data, "base64"));

    return {
      slideIndex,
      filePath: outputPath,
      data: screenshot.data,
    };
  } finally {
    if (client) {
      await client.close();
    }
  }
}

/**
 * Screenshot all slides in a presentation.
 */
export async function screenshotAllSlides(
  presentationUrl: string,
  slideCount: number,
  outputDir: string,
  options?: Partial<ScreenshotOptions>
): Promise<readonly SlideScreenshot[]> {
  const results: SlideScreenshot[] = [];
  const ext = options?.format === "jpeg" ? "jpg" : "png";

  for (let i = 0; i < slideCount; i++) {
    const outputPath = `${outputDir}/slide_${String(i).padStart(3, "0")}.${ext}`;
    const result = await screenshotSlide(presentationUrl, i, outputPath, options);
    results.push(result);
  }

  return results;
}

function buildSlideUrl(presentationUrl: string, slideIndex: number): string {
  // Extract presentation ID from URL
  const match = presentationUrl.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    throw new Error(`Invalid presentation URL: ${presentationUrl}`);
  }
  const presentationId = match[1];
  // Use the export/present mode for clean screenshots
  // slide index is 0-based, but the URL param is the slide object ID
  // For now, navigate to the edit view and use slide index
  return `https://docs.google.com/presentation/d/${presentationId}/edit#slide=id.p${slideIndex > 0 ? slideIndex : ""}`;
}
