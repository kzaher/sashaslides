/**
 * push-slides-keyboard.ts
 *
 * Drives Google Slides editor directly via Chrome DevTools Protocol keyboard input.
 * No REST API auth needed — uses the logged-in browser session.
 *
 * Strategy:
 * 1. Delete all existing slides (select all + delete via keyboard)
 * 2. For each slide in slides.md:
 *    a. Create new slide (Ctrl+M)
 *    b. Click on title placeholder, type title
 *    c. Click on body placeholder, type body
 *
 * Usage: npx tsx push-slides-keyboard.ts <slides.md> <presentation-url>
 */

import { readFileSync } from "node:fs";
import CDP from "chrome-remote-interface";

// ── Types ──────────────────────────────────────────────────────────────────

type ParsedSlide = Readonly<{
  title: string;
  body: string[];
  speakerNotes: string;
  table: Readonly<{ headers: string[]; rows: string[][] }> | null;
  isSectionHeader: boolean;
}>;

// ── Markdown Parsing ───────────────────────────────────────────────────────

function parseSlidesMd(markdown: string): ParsedSlide[] {
  const raw = markdown.split(/\n---\n/);
  const slides: ParsedSlide[] = [];

  for (const block of raw) {
    const lines = block.trim().split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;

    let title = "";
    const body: string[] = [];
    const notes: string[] = [];
    let isSectionHeader = false;
    let table: ParsedSlide["table"] = null;
    let inTable = false;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];

      // Speaker notes
      if (line.startsWith(">")) {
        notes.push(line.replace(/^>\s*/, ""));
        continue;
      }

      // Table detection
      if (line.includes("|") && !line.startsWith("#")) {
        const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
        if (/^[\s|:-]+$/.test(line)) {
          continue; // separator row
        }
        if (!inTable) {
          // Check if next line is separator → this is header
          const next = lines[li + 1];
          if (next && /^[\s|:-]+$/.test(next)) {
            table = { headers: cells, rows: [] };
            inTable = true;
            continue;
          }
        }
        if (inTable && table) {
          table = { ...table, rows: [...table.rows, cells] };
          continue;
        }
      } else {
        inTable = false;
      }

      // Headings
      if (/^#{1,2}\s/.test(line)) {
        const level = line.match(/^(#+)/)?.[1].length ?? 1;
        const text = line.replace(/^#+\s+/, "").replace(/\*\*/g, "");
        if (text.startsWith("PART ")) {
          isSectionHeader = true;
          continue;
        }
        title = text;
        continue;
      }

      // Body lines
      const cleaned = line
        .replace(/^\*\*(.+?)\*\*$/, "$1")
        .replace(/\*\*/g, "")
        .replace(/^- /, "\u2022 ");
      body.push(cleaned);
    }

    slides.push({
      title,
      body,
      speakerNotes: notes.join("\n"),
      table,
      isSectionHeader: isSectionHeader && title !== "",
    });
  }

  return slides;
}

// ── CDP Helpers ────────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function typeText(client: CDP.Client, text: string) {
  const { Input } = client;
  // Use insertText which works with Google Slides' input handling
  await Input.insertText({ text });
}

async function pressKey(
  client: CDP.Client,
  key: string,
  modifiers: number = 0,
  keyCode?: number
) {
  const { Input } = client;
  await Input.dispatchKeyEvent({
    type: "rawKeyDown",
    key,
    windowsVirtualKeyCode: keyCode ?? key.charCodeAt(0),
    nativeVirtualKeyCode: keyCode ?? key.charCodeAt(0),
    modifiers,
  });
  await sleep(20);
  await Input.dispatchKeyEvent({
    type: "keyUp",
    key,
    windowsVirtualKeyCode: keyCode ?? key.charCodeAt(0),
    nativeVirtualKeyCode: keyCode ?? key.charCodeAt(0),
    modifiers,
  });
}

async function clickAt(client: CDP.Client, x: number, y: number) {
  const { Input } = client;
  await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await sleep(50);
  await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

// Modifier flags
const CTRL = 2;

async function selectAll(client: CDP.Client) {
  await pressKey(client, "a", CTRL, 65);
}

async function newSlide(client: CDP.Client) {
  await pressKey(client, "m", CTRL, 77);
}

async function pressTab(client: CDP.Client) {
  await pressKey(client, "Tab", 0, 9);
}

async function pressEnter(client: CDP.Client) {
  await pressKey(client, "Enter", 0, 13);
}

async function pressEscape(client: CDP.Client) {
  await pressKey(client, "Escape", 0, 27);
}

async function pressBackspace(client: CDP.Client) {
  await pressKey(client, "Backspace", 0, 8);
}

async function pressDelete(client: CDP.Client) {
  await pressKey(client, "Delete", 0, 46);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npx tsx push-slides-keyboard.ts <slides.md> [presentation-url]");
    process.exit(1);
  }

  const slidesPath = args[0];
  const markdown = readFileSync(slidesPath, "utf-8");
  const parsedSlides = parseSlidesMd(markdown);

  console.log(`Parsed ${parsedSlides.length} slides from ${slidesPath}`);
  for (let i = 0; i < parsedSlides.length; i++) {
    const s = parsedSlides[i];
    console.log(`  [${i}] ${s.isSectionHeader ? "SEC: " : ""}${s.title || "(blank)"} — ${s.body.length} body lines${s.table ? " + table" : ""}`);
  }

  console.log("\nConnecting to Chrome...");
  const targets = await CDP.List({ port: 9222 });
  const tab = targets.find((t: { url: string }) =>
    t.url.includes("docs.google.com/presentation")
  );
  if (!tab) {
    console.error("No Google Slides tab open. Navigate to the presentation first.");
    process.exit(1);
  }

  const client = await CDP({ target: tab });
  const { Runtime, Input } = client;

  console.log(`Connected to: ${tab.url.slice(0, 80)}`);

  // Helper: double-click at coordinates (enters text editing in Slides)
  async function doubleClickAt(x: number, y: number) {
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await sleep(100);
    await Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 2 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 2 });
    await sleep(500);
  }

  // Step 1: Clear all existing slides via filmstrip
  console.log("\nStep 1: Clearing existing slides...");
  const filmstripResult = await Runtime.evaluate({
    expression: `
      (() => {
        const thumb = document.querySelector('.punch-filmstrip-thumbnail');
        if (thumb) {
          const r = thumb.getBoundingClientRect();
          return { x: r.x + r.width/2, y: r.y + r.height/2 };
        }
        return null;
      })()
    `,
    returnByValue: true,
  });
  const filmPos = filmstripResult.result.value as { x: number; y: number } | null;
  if (filmPos) {
    await clickAt(client, filmPos.x, filmPos.y);
    await sleep(300);
    await selectAll(client);
    await sleep(300);
    await pressBackspace(client);
    await sleep(1500);
  }

  // Step 2: Get slide area coordinates
  const slideAreaResult = await Runtime.evaluate({
    expression: `
      (() => {
        const svgs = document.querySelectorAll('.workspace svg');
        for (const svg of svgs) {
          const r = svg.getBoundingClientRect();
          if (r.width > 300 && r.height > 150) {
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          }
        }
        return null;
      })()
    `,
    returnByValue: true,
  });
  const slideArea = slideAreaResult.result.value as { x: number; y: number; w: number; h: number } | null;
  if (!slideArea) {
    console.error("Could not find slide editing area");
    await client.close();
    return;
  }
  console.log(`Slide area: ${slideArea.w}x${slideArea.h} at (${slideArea.x}, ${slideArea.y})`);

  console.log("Step 2: Creating slides...\n");

  for (let i = 0; i < parsedSlides.length; i++) {
    const slide = parsedSlides[i];

    if (i > 0) {
      // Escape to slide level first, then create new slide
      await pressEscape(client);
      await sleep(200);
      await pressEscape(client);
      await sleep(200);
      await newSlide(client);
      await sleep(1200);
    }

    console.log(`  Slide ${i + 1}/${parsedSlides.length}: ${slide.title || "(blank)"}`);

    // Focus the main slide canvas (not filmstrip)
    const cx = slideArea.x + slideArea.w / 2;
    const cy = slideArea.y + slideArea.h / 2;
    await clickAt(client, cx, cy);
    await sleep(300);

    // === TITLE ===
    // Press Enter to enter the first placeholder (title), then type
    await pressKey(client, "Enter", 0, 13);
    await sleep(500);

    if (slide.title) {
      await Input.insertText({ text: slide.title });
      await sleep(300);
    }

    // === BODY ===
    if (slide.body.length > 0 || slide.table) {
      // Escape from text editing, Tab to next placeholder, Enter to edit
      await pressEscape(client);
      await sleep(200);
      await pressTab(client);
      await sleep(300);
      await pressKey(client, "Enter", 0, 13);
      await sleep(300);

      // Build body text
      const bodyLines = [...slide.body];
      if (slide.table) {
        if (bodyLines.length > 0) bodyLines.push("");
        bodyLines.push(slide.table.headers.join("  |  "));
        for (const row of slide.table.rows) {
          bodyLines.push(row.join("  |  "));
        }
      }

      // Type all body content at once using insertText
      const fullBody = bodyLines.join("\n");
      await Input.insertText({ text: fullBody });
      await sleep(300);
    }

    // Escape back to slide level
    await pressEscape(client);
    await sleep(200);
    await pressEscape(client);
    await sleep(200);
  }

  console.log("\nDone! All slides created.");
  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
