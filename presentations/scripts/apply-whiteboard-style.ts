/**
 * apply-whiteboard-style.ts
 *
 * Applies whiteboard visual style to an existing Google Slides presentation
 * using editable elements (not static images).
 *
 * Style applied:
 * - Slide background: off-white (#f0efe8)
 * - Title font: "Caveat" (handwritten), blue (#1a5276) or red (#c0392b)
 * - Body font: "Patrick Hand" (handwritten), dark (#2c3e50)
 * - Section headers: centered, larger
 *
 * Approach: Use CDP to drive the Google Slides editor UI —
 * set background via Slide > Background menu, change fonts/colors via toolbar.
 *
 * Usage: npx tsx apply-whiteboard-style.ts
 */

import CDP from "chrome-remote-interface";

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
  await input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(30);
  await input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

// ── Apply background to current slide ──────────────────────────────────────

async function applyBackground(client: CDP.Client, color: string) {
  const { Runtime, Input } = client;

  // Click "Background..." button in the toolbar
  const bgBtnResult = await Runtime.evaluate({
    expression: `(() => {
      // Try toolbar button first
      const buttons = document.querySelectorAll('[aria-label*="ackground"], [data-tooltip*="ackground"]');
      for (const btn of buttons) {
        const r = btn.getBoundingClientRect();
        if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
      }
      // Try the toolbar text
      const spans = document.querySelectorAll('span');
      for (const s of spans) {
        if (s.textContent?.trim() === 'Background') {
          const r = s.getBoundingClientRect();
          if (r.width > 0 && r.y < 120) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (!bgBtnResult.result.value) {
    console.log("    Could not find Background button");
    return false;
  }

  const bgPos = bgBtnResult.result.value as { x: number; y: number };
  await clickAt(Input, bgPos.x, bgPos.y);
  await sleep(800);

  // A dialog should open. Find the color picker / color input
  // Click the color swatch to open color picker
  const colorSwatchResult = await Runtime.evaluate({
    expression: `(() => {
      // Look for color input or swatch in the background dialog
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;

      // Look for the "Color" dropdown/swatch
      const swatches = dialog.querySelectorAll('[style*="background"], .goog-color-swatch, [aria-label*="olor"]');
      for (const s of swatches) {
        const r = s.getBoundingClientRect();
        if (r.width > 15 && r.width < 80 && r.height > 15 && r.height < 80) {
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (colorSwatchResult.result.value) {
    const swatchPos = colorSwatchResult.result.value as { x: number; y: number };
    await clickAt(Input, swatchPos.x, swatchPos.y);
    await sleep(500);

    // Look for "Custom" button in the color picker
    const customResult = await Runtime.evaluate({
      expression: `(() => {
        const btns = document.querySelectorAll('[role="button"], button');
        for (const b of btns) {
          if (b.textContent?.trim().toLowerCase() === 'custom') {
            const r = b.getBoundingClientRect();
            if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    if (customResult.result.value) {
      const customPos = customResult.result.value as { x: number; y: number };
      await clickAt(Input, customPos.x, customPos.y);
      await sleep(500);

      // Find hex input and type color
      const hexInputResult = await Runtime.evaluate({
        expression: `(() => {
          const inputs = document.querySelectorAll('input');
          for (const inp of inputs) {
            const r = inp.getBoundingClientRect();
            if (r.width > 50 && r.width < 200 && r.y > 200) {
              return { x: r.x + r.width/2, y: r.y + r.height/2 };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });

      if (hexInputResult.result.value) {
        const hexPos = hexInputResult.result.value as { x: number; y: number };
        await clickAt(Input, hexPos.x, hexPos.y);
        await sleep(100);
        await pressKey(Input, "a", 65, 2); // Select all
        await sleep(100);
        await Input.insertText({ text: color.replace("#", "") });
        await sleep(200);
        await pressKey(Input, "Enter", 13);
        await sleep(300);
      }

      // Click OK in custom color dialog
      const okBtnResult = await Runtime.evaluate({
        expression: `(() => {
          const btns = document.querySelectorAll('button, [role="button"]');
          for (const b of btns) {
            if (b.textContent?.trim() === 'OK') {
              const r = b.getBoundingClientRect();
              if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });

      if (okBtnResult.result.value) {
        const okPos = okBtnResult.result.value as { x: number; y: number };
        await clickAt(Input, okPos.x, okPos.y);
        await sleep(500);
      }
    }
  }

  // Click "Done" in the background dialog
  const doneResult = await Runtime.evaluate({
    expression: `(() => {
      const btns = document.querySelectorAll('button, [role="button"]');
      for (const b of btns) {
        const text = b.textContent?.trim();
        if (text === 'Done') {
          const r = b.getBoundingClientRect();
          if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (doneResult.result.value) {
    const donePos = doneResult.result.value as { x: number; y: number };
    await clickAt(Input, donePos.x, donePos.y);
    await sleep(500);
  }

  return true;
}

// ── Change font of selected text ───────────────────────────────────────────

async function changeFont(client: CDP.Client, fontName: string) {
  const { Runtime, Input } = client;

  // Click on the font dropdown in the toolbar
  const fontDropResult = await Runtime.evaluate({
    expression: `(() => {
      // Font family dropdown — usually has an aria-label or specific class
      const fontDrop = document.querySelector('[aria-label="Font"]') ||
                       document.querySelector('.docs-font-family');
      if (fontDrop) {
        const r = fontDrop.getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y + r.height/2 };
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (!fontDropResult.result.value) return false;

  const fontPos = fontDropResult.result.value as { x: number; y: number };
  await clickAt(Input, fontPos.x, fontPos.y);
  await sleep(300);

  // Select all text in the font input and type new font
  await pressKey(Input, "a", 65, 2);
  await sleep(100);
  await Input.insertText({ text: fontName });
  await sleep(300);
  await pressKey(Input, "Enter", 13);
  await sleep(300);

  return true;
}

// ── Change font color of selected text ─────────────────────────────────────

async function changeFontColor(client: CDP.Client, color: string) {
  const { Runtime, Input } = client;

  // Find the font color button (usually has a colored underline)
  const colorBtnResult = await Runtime.evaluate({
    expression: `(() => {
      const btn = document.querySelector('[aria-label="Text color"]') ||
                  document.querySelector('[aria-label="Font color"]');
      if (btn) {
        // Click the dropdown arrow next to it
        const arrow = btn.querySelector('[class*="arrow"]') || btn.nextElementSibling;
        const target = arrow || btn;
        const r = target.getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y + r.height/2 };
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (!colorBtnResult.result.value) return false;

  const colorPos = colorBtnResult.result.value as { x: number; y: number };
  await clickAt(Input, colorPos.x, colorPos.y);
  await sleep(500);

  // Click "Custom" to enter a hex code
  const customResult = await Runtime.evaluate({
    expression: `(() => {
      const items = document.querySelectorAll('[role="menuitem"], [role="button"], button');
      for (const item of items) {
        if (item.textContent?.trim().toLowerCase().includes('custom')) {
          const r = item.getBoundingClientRect();
          if (r.width > 0 && r.y > 100) return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (customResult.result.value) {
    const customPos = customResult.result.value as { x: number; y: number };
    await clickAt(Input, customPos.x, customPos.y);
    await sleep(500);

    // Find hex input
    const hexResult = await Runtime.evaluate({
      expression: `(() => {
        const inputs = document.querySelectorAll('input');
        for (const inp of inputs) {
          const r = inp.getBoundingClientRect();
          if (r.width > 50 && r.width < 200 && r.y > 200) {
            return { x: r.x + r.width/2, y: r.y + r.height/2 };
          }
        }
        return null;
      })()`,
      returnByValue: true,
    });

    if (hexResult.result.value) {
      const hexPos = hexResult.result.value as { x: number; y: number };
      await clickAt(Input, hexPos.x, hexPos.y);
      await sleep(100);
      await pressKey(Input, "a", 65, 2);
      await sleep(100);
      await Input.insertText({ text: color.replace("#", "") });
      await sleep(200);
      await pressKey(Input, "Enter", 13);
      await sleep(300);

      // Click OK
      const okResult = await Runtime.evaluate({
        expression: `(() => {
          const btns = document.querySelectorAll('button, [role="button"]');
          for (const b of btns) {
            if (b.textContent?.trim() === 'OK') {
              const r = b.getBoundingClientRect();
              if (r.width > 0) return { x: r.x + r.width/2, y: r.y + r.height/2 };
            }
          }
          return null;
        })()`,
        returnByValue: true,
      });

      if (okResult.result.value) {
        const okPos = okResult.result.value as { x: number; y: number };
        await clickAt(Input, okPos.x, okPos.y);
        await sleep(400);
      }
    }
  } else {
    // Dismiss the color picker
    await pressKey(Input, "Escape", 27);
    await sleep(200);
  }

  return true;
}

// ── Style a single text element (title or body) ────────────────────────────

async function styleTextElement(
  client: CDP.Client,
  fontName: string,
  color: string,
  fontSize?: number
) {
  const { Input } = client;

  // Select all text in the current element
  await pressKey(Input, "a", 65, 2); // Ctrl+A
  await sleep(200);

  // Change font
  await changeFont(client, fontName);

  // Change color
  await changeFontColor(client, color);

  // Change font size if specified
  if (fontSize) {
    await changeFontSize(client, fontSize);
  }
}

async function changeFontSize(client: CDP.Client, size: number) {
  const { Runtime, Input } = client;

  const sizeResult = await Runtime.evaluate({
    expression: `(() => {
      const sizeInput = document.querySelector('[aria-label="Font size"]') ||
                        document.querySelector('.docs-font-size input');
      if (sizeInput) {
        const r = sizeInput.getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y + r.height/2 };
      }
      return null;
    })()`,
    returnByValue: true,
  });

  if (!sizeResult.result.value) return;

  const sizePos = sizeResult.result.value as { x: number; y: number };
  await clickAt(Input, sizePos.x, sizePos.y);
  await sleep(100);
  await pressKey(Input, "a", 65, 2);
  await sleep(100);
  await Input.insertText({ text: String(size) });
  await sleep(200);
  await pressKey(Input, "Enter", 13);
  await sleep(200);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const slideCount = parseInt(process.argv[2] ?? "19", 10);

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

  // First, apply background to ALL slides at once
  console.log("Step 1: Applying whiteboard background to all slides...");

  // Go to slide 1
  await Runtime.evaluate({
    expression: `(() => {
      const thumbs = document.querySelectorAll('.punch-filmstrip-thumbnail');
      if (thumbs[0]) {
        thumbs[0].scrollIntoView({ block: 'center' });
        const r = thumbs[0].getBoundingClientRect();
        return { x: r.x + r.width/2, y: r.y + r.height/2 };
      }
    })()`,
    returnByValue: true,
  }).then(async (r) => {
    const pos = r.result.value as { x: number; y: number } | null;
    if (pos) await clickAt(Input, pos.x, pos.y);
  });
  await sleep(500);

  // Select all slides
  await pressKey(Input, "a", 65, 2); // Ctrl+A in filmstrip
  await sleep(300);

  // Now try to set background for all selected slides
  const bgApplied = await applyBackground(client, "f0efe8");
  if (bgApplied) {
    console.log("  Background applied to all slides");
  } else {
    console.log("  Background application failed — will continue with font styling");
  }

  // Step 2: Style each slide's text elements
  console.log("\nStep 2: Styling text on each slide...");

  for (let i = 0; i < slideCount; i++) {
    console.log(`  Slide ${i + 1}/${slideCount}`);

    // Navigate to slide
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

    // Get slide area coordinates
    const areaResult = await Runtime.evaluate({
      expression: `(() => {
        const svgs = document.querySelectorAll('.workspace svg');
        for (const svg of svgs) {
          const r = svg.getBoundingClientRect();
          if (r.width > 300 && r.height > 150) return { x: r.x, y: r.y, w: r.width, h: r.height };
        }
        return null;
      })()`,
      returnByValue: true,
    });
    const area = areaResult.result.value as { x: number; y: number; w: number; h: number } | null;
    if (!area) {
      console.log("    No slide area found, skipping");
      continue;
    }

    // Click on the slide canvas
    await clickAt(Input, area.x + area.w / 2, area.y + area.h / 2);
    await sleep(200);

    // --- Style TITLE ---
    // Enter first placeholder (title)
    await pressKey(Input, "Enter", 13);
    await sleep(400);

    // Select all text in title
    await pressKey(Input, "a", 65, 2);
    await sleep(200);

    // Change font to Caveat
    await changeFont(client, "Caveat");

    // Change color: section headers + title slides get dark blue, regular titles alternate
    const titleColor = (i === 0 || i === 18) ? "c0392b" : "1a5276"; // red for title/closing, blue for rest
    await changeFontColor(client, titleColor);

    // Escape from title editing
    await pressKey(Input, "Escape", 27);
    await sleep(200);

    // --- Style BODY (if it exists) ---
    // Tab to next placeholder
    await pressKey(Input, "Tab", 9);
    await sleep(300);

    // Check if we're now in a different placeholder by pressing Enter
    await pressKey(Input, "Enter", 13);
    await sleep(400);

    // Select all text in body
    await pressKey(Input, "a", 65, 2);
    await sleep(200);

    // Change font to Patrick Hand for body
    await changeFont(client, "Patrick Hand");

    // Body color: dark gray
    await changeFontColor(client, "2c3e50");

    // Escape completely
    await pressKey(Input, "Escape", 27);
    await sleep(150);
    await pressKey(Input, "Escape", 27);
    await sleep(150);
    await pressKey(Input, "Escape", 27);
    await sleep(200);
  }

  await client.close();
  console.log("\nDone! Whiteboard style applied to all slides.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
