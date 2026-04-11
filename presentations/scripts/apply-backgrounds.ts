/**
 * apply-backgrounds.ts
 *
 * For each slide in the Google Slides presentation, removes existing text
 * placeholders and sets the whiteboard image as the slide background
 * by inserting a full-slide image.
 *
 * Approach: For each slide, use keyboard shortcut to insert an image from URL
 * (the images are served via a local HTTP server).
 *
 * Usage: npx tsx apply-backgrounds.ts [image-dir] [slide-count]
 */

import CDP from "chrome-remote-interface";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pressKey(input: any, key: string, keyCode: number, modifiers = 0) {
  await input.dispatchKeyEvent({
    type: "rawKeyDown",
    key,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
  });
  await sleep(30);
  await input.dispatchKeyEvent({
    type: "keyUp",
    key,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    modifiers,
  });
}

async function clickAt(input: any, x: number, y: number) {
  await input.dispatchMouseEvent({
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sleep(30);
  await input.dispatchMouseEvent({
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

async function main() {
  const imageDir = resolve(process.argv[2] ?? "presentations/1/whiteboard");
  const slideCount = parseInt(process.argv[3] ?? "19", 10);

  // Start a local HTTP server to serve the images
  const server = createServer((req, res) => {
    const filePath = resolve(imageDir, req.url!.slice(1));
    if (existsSync(filePath)) {
      const data = readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": data.length,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(data);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  const PORT = 8765;
  server.listen(PORT, () => {
    console.log(`Image server on http://localhost:${PORT}`);
  });

  // Connect to Chrome
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find(
    (t: { type: string; url: string }) =>
      t.type === "page" && t.url.includes("docs.google.com/presentation")
  );
  if (!tab) {
    console.error("No Slides tab found");
    process.exit(1);
  }

  const client = await CDP({ target: tab });
  const { Runtime, Input } = client;

  // Navigate to slide 1 first
  console.log("Navigating to slide 1...");
  await Runtime.evaluate({
    expression: `(() => {
      const thumbs = document.querySelectorAll('.punch-filmstrip-thumbnail');
      if (thumbs[0]) {
        thumbs[0].scrollIntoView({ block: 'center' });
        const r = thumbs[0].getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y + r.height/2 };
      }
      return null;
    })()`,
    returnByValue: true,
  }).then(async (r) => {
    const pos = r.result.value as { x: number; y: number } | null;
    if (pos) await clickAt(Input, pos.x, pos.y);
  });
  await sleep(800);

  for (let i = 0; i < slideCount; i++) {
    const slideNum = i + 1;
    const imageName = `slide_${String(slideNum).padStart(2, "0")}.png`;
    const imageUrl = `http://localhost:${PORT}/${imageName}`;

    console.log(`Slide ${slideNum}/${slideCount}: applying ${imageName}`);

    // Navigate to this slide's thumbnail
    const navResult = await Runtime.evaluate({
      expression: `(() => {
        const thumbs = document.querySelectorAll('.punch-filmstrip-thumbnail');
        const idx = ${i};
        if (thumbs[idx]) {
          thumbs[idx].scrollIntoView({ block: 'center' });
          const r = thumbs[idx].getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
        return null;
      })()`,
      returnByValue: true,
    });
    const navPos = navResult.result.value as { x: number; y: number } | null;
    if (navPos) await clickAt(Input, navPos.x, navPos.y);
    await sleep(500);

    // First, select all elements on this slide and delete them (clear placeholders)
    // Click the slide canvas to focus it
    const areaResult = await Runtime.evaluate({
      expression: `(() => {
        const svgs = document.querySelectorAll('.workspace svg');
        for (const svg of svgs) {
          const r = svg.getBoundingClientRect();
          if (r.width > 300 && r.height > 150) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
        return null;
      })()`,
      returnByValue: true,
    });
    const areaPos = areaResult.result.value as { x: number; y: number } | null;
    if (areaPos) {
      await clickAt(Input, areaPos.x, areaPos.y);
      await sleep(200);

      // Select all elements on this slide
      await pressKey(Input, "a", 65, 2); // Ctrl+A
      await sleep(200);

      // Delete them
      await pressKey(Input, "Delete", 46);
      await sleep(300);
    }

    // Now insert image via Insert > Image > By URL
    // Use the menu: Insert menu
    const insertMenuResult = await Runtime.evaluate({
      expression: `(() => {
        // Find the "Insert" menu item
        const menus = document.querySelectorAll('.menu-button');
        for (const m of menus) {
          if (m.textContent?.trim() === 'Insert') {
            const r = m.getBoundingClientRect();
            return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        // Try aria approach
        const menubar = document.querySelector('[role="menubar"]');
        if (menubar) {
          const items = menubar.querySelectorAll('[role="menuitem"]');
          for (const item of items) {
            if (item.textContent?.trim() === 'Insert') {
              const r = item.getBoundingClientRect();
              return { x: r.x + r.width/2, y: r.y + r.height/2 };
            }
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    const insertPos = insertMenuResult.result.value as { x: number; y: number } | null;
    if (!insertPos) {
      console.log("  Could not find Insert menu, skipping");
      continue;
    }

    // Click Insert menu
    await clickAt(Input, insertPos.x, insertPos.y);
    await sleep(600);

    // Find "Image" submenu
    const imageMenuResult = await Runtime.evaluate({
      expression: `(() => {
        const items = document.querySelectorAll('[role="menuitem"]');
        for (const item of items) {
          const text = item.textContent?.trim();
          if (text === 'Image' || text?.startsWith('Image')) {
            const r = item.getBoundingClientRect();
            if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    if (!imageMenuResult.result.value) {
      console.log("  Could not find Image menu item, pressing Escape");
      await pressKey(Input, "Escape", 27);
      await sleep(300);
      continue;
    }

    const imagePos = imageMenuResult.result.value as { x: number; y: number };
    await clickAt(Input, imagePos.x, imagePos.y);
    await sleep(500);

    // Find "By URL" option in submenu
    const byUrlResult = await Runtime.evaluate({
      expression: `(() => {
        const items = document.querySelectorAll('[role="menuitem"]');
        for (const item of items) {
          const text = item.textContent?.trim();
          if (text && (text.includes('By URL') || text.includes('by URL'))) {
            const r = item.getBoundingClientRect();
            if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    if (!byUrlResult.result.value) {
      console.log("  Could not find 'By URL' option, pressing Escape");
      await pressKey(Input, "Escape", 27);
      await sleep(200);
      await pressKey(Input, "Escape", 27);
      await sleep(300);
      continue;
    }

    const byUrlPos = byUrlResult.result.value as { x: number; y: number };
    await clickAt(Input, byUrlPos.x, byUrlPos.y);
    await sleep(800);

    // Now a dialog should appear with a URL input field
    // Find the text input and type the URL
    const inputResult = await Runtime.evaluate({
      expression: `(() => {
        // Look for URL input in the dialog
        const inputs = document.querySelectorAll('input[type="text"], input[type="url"], input:not([type])');
        for (const inp of inputs) {
          const r = inp.getBoundingClientRect();
          if (r.width > 100 && r.height > 0) {
            return { x: r.x + r.width/2, y: r.y + r.height/2, tag: inp.tagName, placeholder: inp.getAttribute('placeholder') || '' };
          }
        }
        // Try finding by dialog context
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog) {
          const inp = dialog.querySelector('input');
          if (inp) {
            const r = inp.getBoundingClientRect();
            return { x: r.x + r.width/2, y: r.y + r.height/2, tag: 'dialog-input' };
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    if (!inputResult.result.value) {
      console.log("  Could not find URL input field, pressing Escape");
      await pressKey(Input, "Escape", 27);
      await sleep(300);
      continue;
    }

    const inputPos = inputResult.result.value as { x: number; y: number };
    await clickAt(Input, inputPos.x, inputPos.y);
    await sleep(200);

    // Clear any existing text and type the URL
    await pressKey(Input, "a", 65, 2); // Ctrl+A
    await sleep(100);
    await Input.insertText({ text: imageUrl });
    await sleep(500);

    // Press Enter or click "Insert" button
    // First try finding an Insert button in the dialog
    const insertBtnResult = await Runtime.evaluate({
      expression: `(() => {
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
          const text = btn.textContent?.trim();
          if (text === 'Insert' || text === 'INSERT') {
            const r = btn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    if (insertBtnResult.result.value) {
      const btnPos = insertBtnResult.result.value as { x: number; y: number };
      await clickAt(Input, btnPos.x, btnPos.y);
    } else {
      // Fall back to pressing Enter
      await pressKey(Input, "Enter", 13);
    }

    await sleep(1500);

    // The image should now be inserted. Press Escape to deselect.
    await pressKey(Input, "Escape", 27);
    await sleep(300);

    console.log(`  Done`);
  }

  server.close();
  await client.close();
  console.log("\nAll backgrounds applied!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
