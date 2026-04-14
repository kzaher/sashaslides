#!/usr/bin/env npx tsx
/**
 * extract-slides.ts — Screenshot all slides + extract structured content from Google Slides
 *
 * Usage: npx tsx extract-slides.ts <presentation-url-or-id> [output-dir]
 *
 * Outputs:
 *   <output-dir>/slide_NN.png          — screenshot of each slide
 *   <output-dir>/structure.json        — full structured content (text, shapes, styles, positions)
 *   <output-dir>/storyline.md          — extracted storyline (titles + key points in order)
 */

import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const SLIDE_WIDTH = 1280;
const SLIDE_HEIGHT = 720;
const CDP_PORT = 9222;

interface SlideElement {
  type: "text" | "image" | "shape" | "table" | "chart" | "group" | "unknown";
  bounds: { x: number; y: number; w: number; h: number };
  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontWeight?: string;
  color?: string;
  backgroundColor?: string;
  role?: "title" | "subtitle" | "body" | "label" | "unknown";
  shapeType?: string;
  tableData?: { rows: number; cols: number; cells: string[][] };
  children?: SlideElement[];
}

interface ExtractedSlide {
  index: number;
  title: string;
  elements: SlideElement[];
  speakerNotes: string;
  thumbnailPath: string;
}

interface ExtractionResult {
  presentationId: string;
  presentationTitle: string;
  slideCount: number;
  slides: ExtractedSlide[];
  extractedAt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractId(urlOrId: string): string {
  const m = urlOrId.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(urlOrId)) return urlOrId;
  throw new Error(`Cannot extract presentation ID from: ${urlOrId}`);
}

async function waitForSelector(
  Runtime: any,
  selector: string,
  timeoutMs = 5000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { result } = await Runtime.evaluate({
      expression: `!!document.querySelector('${selector}')`,
      returnByValue: true,
    });
    if (result.value) return true;
    await sleep(200);
  }
  return false;
}

async function getSlideCount(Runtime: any): Promise<number> {
  // Scroll filmstrip to force-render all thumbnails
  await Runtime.evaluate({
    expression: `
      (() => {
        const scroll = document.querySelector('.punch-filmstrip-scroll');
        if (scroll) scroll.scrollTop = 99999;
      })()
    `,
  });
  await sleep(500);

  const { result } = await Runtime.evaluate({
    expression: `document.querySelectorAll('.punch-filmstrip-thumbnail').length`,
    returnByValue: true,
  });
  return result.value || 0;
}

async function extractSlideContent(Runtime: any, slideIndex: number): Promise<SlideElement[]> {
  const { result } = await Runtime.evaluate({
    expression: `
      (() => {
        const elements = [];
        // Get all SVG groups on the current slide canvas
        const workspace = document.querySelector('.punch-viewer-svgpage-svgcontainer');
        if (!workspace) return JSON.stringify(elements);

        const svgRoot = workspace.querySelector('svg');
        if (!svgRoot) return JSON.stringify(elements);

        const viewBox = svgRoot.getAttribute('viewBox') || '0 0 960 540';
        const [, , vbW, vbH] = viewBox.split(' ').map(Number);

        // Find all text elements
        const textEls = svgRoot.querySelectorAll('text, foreignObject');
        for (const el of textEls) {
          const bbox = el.getBoundingClientRect();
          const svgBBox = svgRoot.getBoundingClientRect();
          const relX = (bbox.left - svgBBox.left) / svgBBox.width;
          const relY = (bbox.top - svgBBox.top) / svgBBox.height;
          const relW = bbox.width / svgBBox.width;
          const relH = bbox.height / svgBBox.height;

          const text = el.textContent?.trim() || '';
          if (!text) continue;

          const style = window.getComputedStyle(el);
          const fontSize = parseFloat(style.fontSize) || 0;

          elements.push({
            type: 'text',
            bounds: { x: relX, y: relY, w: relW, h: relH },
            text: text.substring(0, 500),
            fontSize: fontSize,
            fontFamily: style.fontFamily || '',
            fontWeight: style.fontWeight || 'normal',
            color: style.color || style.fill || '',
            role: relY < 0.2 && fontSize > 20 ? 'title' :
                  relY < 0.3 && fontSize > 16 ? 'subtitle' : 'body'
          });
        }

        // Find shape elements (rects, ellipses, paths)
        const shapes = svgRoot.querySelectorAll('rect, ellipse, circle, polygon, path');
        for (const shape of shapes) {
          const bbox = shape.getBoundingClientRect();
          const svgBBox = svgRoot.getBoundingClientRect();
          if (bbox.width < 5 || bbox.height < 5) continue;

          const relX = (bbox.left - svgBBox.left) / svgBBox.width;
          const relY = (bbox.top - svgBBox.top) / svgBBox.height;
          const relW = bbox.width / svgBBox.width;
          const relH = bbox.height / svgBBox.height;

          // Skip very large background rects
          if (relW > 0.95 && relH > 0.95) continue;

          const fill = shape.getAttribute('fill') || window.getComputedStyle(shape).fill;
          const stroke = shape.getAttribute('stroke') || window.getComputedStyle(shape).stroke;

          elements.push({
            type: 'shape',
            bounds: { x: relX, y: relY, w: relW, h: relH },
            shapeType: shape.tagName.toLowerCase(),
            color: stroke || '',
            backgroundColor: fill || ''
          });
        }

        // Find images
        const images = svgRoot.querySelectorAll('image');
        for (const img of images) {
          const bbox = img.getBoundingClientRect();
          const svgBBox = svgRoot.getBoundingClientRect();
          const relX = (bbox.left - svgBBox.left) / svgBBox.width;
          const relY = (bbox.top - svgBBox.top) / svgBBox.height;
          const relW = bbox.width / svgBBox.width;
          const relH = bbox.height / svgBBox.height;

          elements.push({
            type: 'image',
            bounds: { x: relX, y: relY, w: relW, h: relH }
          });
        }

        return JSON.stringify(elements);
      })()
    `,
    returnByValue: true,
  });

  try {
    return JSON.parse(result.value || "[]");
  } catch {
    return [];
  }
}

async function extractSpeakerNotes(Runtime: any): Promise<string> {
  const { result } = await Runtime.evaluate({
    expression: `
      (() => {
        // Speaker notes panel
        const notesEl = document.querySelector('.punch-viewer-speaker-notes-text');
        if (notesEl) return notesEl.textContent?.trim() || '';
        // Alternative selector
        const alt = document.querySelector('[aria-label="Speaker notes"]');
        if (alt) return alt.textContent?.trim() || '';
        return '';
      })()
    `,
    returnByValue: true,
  });
  return result.value || "";
}

async function navigateToSlide(
  Runtime: any,
  Input: any,
  slideIndex: number
): Promise<void> {
  // Click on filmstrip thumbnail
  await Runtime.evaluate({
    expression: `
      (() => {
        const scroll = document.querySelector('.punch-filmstrip-scroll');
        if (scroll) scroll.scrollTop = 0;
      })()
    `,
  });
  await sleep(200);

  // Scroll to make the target thumbnail visible
  await Runtime.evaluate({
    expression: `
      (() => {
        const thumbs = document.querySelectorAll('.punch-filmstrip-thumbnail');
        if (thumbs[${slideIndex}]) {
          thumbs[${slideIndex}].scrollIntoView({ block: 'center' });
        }
      })()
    `,
  });
  await sleep(300);

  // Click the thumbnail
  await Runtime.evaluate({
    expression: `
      (() => {
        const thumbs = document.querySelectorAll('.punch-filmstrip-thumbnail');
        const thumb = thumbs[${slideIndex}];
        if (!thumb) return false;
        const r = thumb.getBoundingClientRect();
        const opts = {
          bubbles: true, cancelable: true,
          clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
          pointerType: 'mouse', button: 0, pointerId: 1
        };
        thumb.dispatchEvent(new PointerEvent('pointerdown', opts));
        thumb.dispatchEvent(new MouseEvent('mousedown', opts));
        thumb.dispatchEvent(new PointerEvent('pointerup', opts));
        thumb.dispatchEvent(new MouseEvent('mouseup', opts));
        thumb.dispatchEvent(new MouseEvent('click', opts));
        return true;
      })()
    `,
    returnByValue: true,
  });
  await sleep(500);
}

async function screenshotSlide(Page: any, outputPath: string): Promise<void> {
  const { result } = await (Page as any).evaluate
    ? { result: { value: null } }
    : { result: { value: null } };

  const screenshot = await Page.captureScreenshot({
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(outputPath, Buffer.from(screenshot.data, "base64"));
}

async function getMainCanvasClip(Runtime: any): Promise<{
  x: number;
  y: number;
  width: number;
  height: number;
} | null> {
  const { result } = await Runtime.evaluate({
    expression: `
      (() => {
        const canvas = document.querySelector('.punch-viewer-svgpage-svgcontainer');
        if (!canvas) return null;
        const r = canvas.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })()
    `,
    returnByValue: true,
  });
  return result.value;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error(
      "Usage: npx tsx extract-slides.ts <presentation-url-or-id> [output-dir]"
    );
    process.exit(1);
  }

  const presId = extractId(args[0]);
  const outputDir = args[1] || `./extraction_${presId}`;

  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  console.log(`Extracting presentation: ${presId}`);
  console.log(`Output directory: ${outputDir}`);

  // Find or open the presentation tab
  const targets = await CDP.List({ port: CDP_PORT });
  let tab = targets.find(
    (t: any) => t.url.includes(presId) && t.url.includes("presentation")
  );

  if (!tab) {
    console.log("Opening presentation in new tab...");
    tab = await (CDP as any).New({
      port: CDP_PORT,
      url: `https://docs.google.com/presentation/d/${presId}/edit`,
    });
    await sleep(5000);
  }

  const client = await CDP({ target: tab, port: CDP_PORT });
  const { Page, Runtime, Input, Emulation } = client;

  await Page.enable();
  await Runtime.enable();
  await Emulation.setDeviceMetricsOverride({
    width: SLIDE_WIDTH,
    height: SLIDE_HEIGHT,
    deviceScaleFactor: 2,
    mobile: false,
  });

  await sleep(2000);

  // Wait for filmstrip
  const hasFilmstrip = await waitForSelector(
    Runtime,
    ".punch-filmstrip-thumbnail",
    10000
  );
  if (!hasFilmstrip) {
    console.error("Could not find filmstrip. Is the presentation loaded?");
    await client.close();
    process.exit(1);
  }

  // Force-render all thumbnails and count
  const slideCount = await getSlideCount(Runtime);
  console.log(`Found ${slideCount} slides`);

  // Get presentation title
  const { result: titleResult } = await Runtime.evaluate({
    expression: `document.querySelector('[aria-label="Rename"]')?.value || document.title || 'Untitled'`,
    returnByValue: true,
  });
  const presTitle = titleResult.value || "Untitled";

  const slides: ExtractedSlide[] = [];

  for (let i = 0; i < slideCount; i++) {
    console.log(`Processing slide ${i + 1}/${slideCount}...`);

    // Navigate to slide
    await navigateToSlide(Runtime, Input, i);
    await sleep(800);

    // Screenshot the main canvas area
    const clip = await getMainCanvasClip(Runtime);
    const screenshotPath = join(outputDir, `slide_${String(i).padStart(2, "0")}.png`);

    if (clip) {
      const screenshot = await Page.captureScreenshot({
        format: "png",
        clip: { ...clip, scale: 2 },
        captureBeyondViewport: true,
      });
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    } else {
      const screenshot = await Page.captureScreenshot({ format: "png" });
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
    }

    // Extract structured content
    const elements = await extractSlideContent(Runtime, i);
    const notes = await extractSpeakerNotes(Runtime);

    // Determine title from elements
    const titleEl = elements.find(
      (e) => e.role === "title" || (e.type === "text" && (e.fontSize || 0) > 20)
    );
    const title = titleEl?.text || `Slide ${i + 1}`;

    slides.push({
      index: i,
      title,
      elements,
      speakerNotes: notes,
      thumbnailPath: `slide_${String(i).padStart(2, "0")}.png`,
    });
  }

  // Build result
  const result: ExtractionResult = {
    presentationId: presId,
    presentationTitle: presTitle,
    slideCount,
    slides,
    extractedAt: new Date().toISOString(),
  };

  // Write structure.json
  writeFileSync(
    join(outputDir, "structure.json"),
    JSON.stringify(result, null, 2)
  );

  // Write storyline.md
  let storyline = `# ${presTitle}\n\n`;
  storyline += `*Extracted: ${result.extractedAt}*\n`;
  storyline += `*Slides: ${slideCount}*\n\n---\n\n`;

  for (const slide of slides) {
    storyline += `## Slide ${slide.index + 1}: ${slide.title}\n\n`;

    const bodyEls = slide.elements.filter(
      (e) => e.type === "text" && e.role !== "title"
    );
    for (const el of bodyEls) {
      if (el.text) {
        storyline += `- ${el.text}\n`;
      }
    }

    if (slide.speakerNotes) {
      storyline += `\n> *Notes: ${slide.speakerNotes}*\n`;
    }
    storyline += "\n";
  }

  writeFileSync(join(outputDir, "storyline.md"), storyline);

  console.log(`\nExtraction complete!`);
  console.log(`  Screenshots: ${slideCount} PNG files`);
  console.log(`  Structure:   ${outputDir}/structure.json`);
  console.log(`  Storyline:   ${outputDir}/storyline.md`);

  await client.close();
}

main().catch((err) => {
  console.error("Extraction failed:", err);
  process.exit(1);
});
