/**
 * render-whiteboard.ts
 *
 * Renders slides.md as whiteboard-style images using HTML/CSS in Chrome.
 * Each slide is rendered at 1280x720 and saved as a PNG.
 *
 * Usage: npx tsx render-whiteboard.ts <slides.md> [output-dir]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import CDP from "chrome-remote-interface";

// ── Slide parsing ──────────────────────────────────────────────────────────

type SlideData = {
  title: string;
  subtitle: string;
  bodyLines: string[];
  table: { headers: string[]; rows: string[][] } | null;
  notes: string;
  isSectionHeader: boolean;
  isTitleSlide: boolean;
  isClosing: boolean;
};

function parseSlides(md: string): SlideData[] {
  const blocks = md.split(/\n---\n/);
  const slides: SlideData[] = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;

    let title = "";
    let subtitle = "";
    const bodyLines: string[] = [];
    const notes: string[] = [];
    let isSectionHeader = false;
    let table: SlideData["table"] = null;
    let inTable = false;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];

      if (line.startsWith(">")) {
        notes.push(line.replace(/^>\s*/, ""));
        continue;
      }

      // Table
      if (line.includes("|") && !line.startsWith("#")) {
        const cells = line
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean);
        if (/^[\s|:-]+$/.test(line)) {
          continue;
        }
        if (!inTable) {
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

      if (/^#{1,2}\s/.test(line)) {
        const text = line.replace(/^#+\s+/, "").replace(/\*\*/g, "");
        if (text.startsWith("PART ")) {
          isSectionHeader = true;
          continue;
        }
        if (!title) {
          title = text;
        } else if (!subtitle) {
          subtitle = text;
        }
        continue;
      }

      bodyLines.push(line);
    }

    const isTitleSlide =
      lines[0]?.startsWith("# ") && bodyLines.length === 0 && !isSectionHeader && !table;
    const isClosing = title.toLowerCase().includes("thank you");

    if (notes.length > 0 && !subtitle) {
      subtitle = notes[0];
    }

    slides.push({
      title,
      subtitle: isTitleSlide ? notes.join(" | ") || subtitle : subtitle,
      bodyLines,
      table,
      notes: notes.join("\n"),
      isSectionHeader,
      isTitleSlide,
      isClosing,
    });
  }

  return slides;
}

// ── HTML generation ────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBodyLine(line: string): string {
  let text = escapeHtml(line);
  // Bold markers
  text = text.replace(/\*\*(.+?)\*\*/g, '<span class="bold">$1</span>');
  // Bullet points
  if (text.startsWith("- ") || text.startsWith("• ")) {
    text = '<span class="bullet">•</span> ' + text.slice(2);
  }
  // Numbered items
  const numMatch = text.match(/^(\d+)\.\s/);
  if (numMatch) {
    text =
      '<span class="num">' + numMatch[1] + ".</span> " + text.slice(numMatch[0].length);
  }
  return text;
}

function generateSlideHtml(slide: SlideData, index: number): string {
  // Pick whiteboard variant based on slide type and index
  const bgVariant = (index % 2 === 0) ? "clean" : "marks";
  const titleColor = slide.isSectionHeader ? "#1a5276" : (index % 3 === 0 ? "#c0392b" : "#1a5276");
  const subtitleColor = slide.isSectionHeader ? "#2c3e50" : "#555";

  let contentHtml = "";

  if (slide.isTitleSlide || slide.isClosing) {
    contentHtml = `
      <div class="title-slide">
        <div class="icon lightbulb">💡</div>
        <div class="main-title" style="color: ${titleColor}">${escapeHtml(slide.title)}</div>
        ${slide.subtitle ? `<div class="arrow-right">→</div><div class="sub-title">${escapeHtml(slide.subtitle)}</div>` : ""}
      </div>
    `;
  } else if (slide.isSectionHeader) {
    contentHtml = `
      <div class="section-slide">
        <div class="section-divider"></div>
        <div class="section-title" style="color: ${titleColor}">${escapeHtml(slide.title)}</div>
        <div class="section-divider bottom"></div>
      </div>
    `;
  } else {
    // Regular content slide
    const hasTable = slide.table !== null;
    const hasBody = slide.bodyLines.length > 0;

    let bodyHtml = "";
    if (hasBody) {
      const formattedLines = slide.bodyLines.map((l) => {
        const formatted = formatBodyLine(l);
        // Detect section headers within body (bold-only lines)
        if (l.match(/^\*\*.+\*\*$/) || l.match(/^\*\*.+:\*\*$/)) {
          return `<div class="body-section-header">${formatted}</div>`;
        }
        return `<div class="body-line">${formatted}</div>`;
      });
      bodyHtml = formattedLines.join("\n");
    }

    let tableHtml = "";
    if (hasTable && slide.table) {
      const t = slide.table;
      tableHtml = `<div class="wb-table">
        <div class="table-row header">
          ${t.headers.map((h) => `<div class="table-cell">${escapeHtml(h).replace(/\*\*/g, "")}</div>`).join("")}
        </div>
        ${t.rows
          .map(
            (row) =>
              `<div class="table-row">${row.map((c) => `<div class="table-cell">${escapeHtml(c).replace(/\*\*/g, "")}</div>`).join("")}</div>`
          )
          .join("\n")}
      </div>`;
    }

    const layoutClass = hasTable && hasBody ? "split" : hasTable ? "table-only" : "body-only";

    contentHtml = `
      <div class="content-slide ${layoutClass}">
        <div class="slide-title" style="color: ${titleColor}">
          ${escapeHtml(slide.title)}
          <div class="title-underline" style="background: ${titleColor}"></div>
        </div>
        <div class="slide-body-area">
          ${bodyHtml ? `<div class="body-content">${bodyHtml}</div>` : ""}
          ${tableHtml}
        </div>
      </div>
    `;
  }

  // Decorative elements based on slide type
  let decoHtml = "";
  if (bgVariant === "marks") {
    decoHtml = `
      <div class="deco deco-tl">≈ notes</div>
      <div class="deco deco-tr">→ ∝ λ</div>
    `;
  }

  return `
    <div class="whiteboard-slide" id="slide-${index}">
      <div class="wb-frame">
        <div class="wb-surface ${bgVariant}">
          ${decoHtml}
          ${contentHtml}
        </div>
        <div class="wb-tray">
          <div class="marker blue"></div>
          <div class="marker red"></div>
          <div class="marker black"></div>
          <div class="marker green"></div>
          <div class="eraser"></div>
        </div>
      </div>
    </div>
  `;
}

function generateFullHtml(slides: SlideData[]): string {
  const slidesHtml = slides.map((s, i) => generateSlideHtml(s, i)).join("\n");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@400;600;700&family=Kalam:wght@300;400;700&family=Patrick+Hand&display=swap');

* { margin: 0; padding: 0; box-sizing: border-box; }

.whiteboard-slide {
  width: 1280px;
  height: 720px;
  overflow: hidden;
  position: relative;
}

.wb-frame {
  width: 100%; height: 100%;
  background: #d4d4d4;
  display: flex;
  flex-direction: column;
  padding: 8px 10px 0 10px;
}

.wb-surface {
  flex: 1;
  background: linear-gradient(180deg, #f8f8f6 0%, #f0efe8 40%, #eae8e0 100%);
  border: 3px solid #b8b8b8;
  border-radius: 3px;
  position: relative;
  padding: 40px 50px;
  overflow: hidden;
  /* subtle whiteboard texture */
  box-shadow: inset 0 0 80px rgba(0,0,0,0.04), inset 0 2px 4px rgba(0,0,0,0.06);
}

.wb-surface::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  background:
    radial-gradient(ellipse at 15% 10%, rgba(255,255,255,0.7) 0%, transparent 50%),
    radial-gradient(ellipse at 85% 10%, rgba(255,255,255,0.5) 0%, transparent 40%);
  pointer-events: none;
  z-index: 1;
}

.wb-surface > * { position: relative; z-index: 2; }

.wb-surface.marks::after {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; bottom: 0;
  background:
    linear-gradient(25deg, transparent 95%, rgba(150,150,200,0.06) 95%, rgba(150,150,200,0.06) 95.5%, transparent 95.5%),
    linear-gradient(-15deg, transparent 93%, rgba(180,150,150,0.05) 93%, rgba(180,150,150,0.05) 93.3%, transparent 93.3%);
  pointer-events: none;
  z-index: 0;
}

.wb-tray {
  height: 32px;
  background: linear-gradient(180deg, #c0c0c0, #a0a0a0);
  border-radius: 0 0 4px 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 4px 20px;
  border-top: 2px solid #999;
}

.marker {
  width: 60px; height: 14px;
  border-radius: 7px 2px 2px 7px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.3);
}
.marker.blue { background: linear-gradient(90deg, #1a5276, #2980b9); }
.marker.red { background: linear-gradient(90deg, #922b21, #e74c3c); }
.marker.black { background: linear-gradient(90deg, #1c1c1c, #444); }
.marker.green { background: linear-gradient(90deg, #1e8449, #27ae60); }
.eraser {
  width: 50px; height: 20px;
  background: linear-gradient(180deg, #ddd, #aaa);
  border-radius: 3px;
  box-shadow: 0 1px 2px rgba(0,0,0,0.3);
}

/* Decorative faint marks */
.deco {
  position: absolute;
  font-family: 'Patrick Hand', cursive;
  font-size: 14px;
  color: rgba(100,100,150,0.15);
  z-index: 0 !important;
}
.deco-tl { top: 12px; left: 15px; transform: rotate(-5deg); }
.deco-tr { top: 15px; right: 20px; transform: rotate(3deg); }

/* ── Title Slide ───────────────────────────────────── */
.title-slide {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  text-align: center;
}
.title-slide .icon {
  font-size: 64px;
  margin-bottom: 10px;
  filter: drop-shadow(1px 1px 1px rgba(0,0,0,0.1));
}
.title-slide .main-title {
  font-family: 'Caveat', cursive;
  font-size: 64px;
  font-weight: 700;
  line-height: 1.15;
  text-shadow: 1px 1px 0 rgba(0,0,0,0.05);
  max-width: 900px;
}
.title-slide .arrow-right {
  font-size: 36px;
  color: #c0392b;
  margin: 8px 0;
  font-family: 'Caveat', cursive;
}
.title-slide .sub-title {
  font-family: 'Kalam', cursive;
  font-size: 30px;
  color: #555;
  max-width: 800px;
}

/* ── Section Header ────────────────────────────────── */
.section-slide {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.section-title {
  font-family: 'Caveat', cursive;
  font-size: 58px;
  font-weight: 700;
  text-align: center;
  max-width: 900px;
  line-height: 1.2;
}
.section-divider {
  width: 400px;
  height: 4px;
  background: linear-gradient(90deg, transparent, #2980b9, transparent);
  border-radius: 2px;
  margin: 18px 0;
}
.section-divider.bottom {
  background: linear-gradient(90deg, transparent, #c0392b, transparent);
}

/* ── Content Slide ─────────────────────────────────── */
.content-slide {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.slide-title {
  font-family: 'Caveat', cursive;
  font-size: 42px;
  font-weight: 700;
  margin-bottom: 4px;
  line-height: 1.15;
  position: relative;
}
.title-underline {
  height: 3px;
  border-radius: 2px;
  margin-top: 2px;
  width: 100%;
  opacity: 0.6;
}
.slide-body-area {
  flex: 1;
  display: flex;
  gap: 30px;
  padding-top: 15px;
  overflow: hidden;
}
.body-only .slide-body-area { flex-direction: column; }
.table-only .slide-body-area { flex-direction: column; }
.split .body-content { flex: 1; }
.split .wb-table { flex: 1; }

.body-content {
  font-family: 'Kalam', cursive;
  font-size: 22px;
  color: #2c3e50;
  line-height: 1.5;
}
.body-line {
  margin-bottom: 4px;
  padding-left: 5px;
}
.body-section-header {
  font-family: 'Caveat', cursive;
  font-weight: 700;
  font-size: 26px;
  color: #c0392b;
  margin-top: 10px;
  margin-bottom: 2px;
}
.body-line .bullet {
  color: #2980b9;
  font-size: 26px;
  font-weight: bold;
}
.body-line .num {
  color: #2980b9;
  font-weight: bold;
}
.body-line .bold {
  font-weight: 700;
  color: #1a5276;
}

/* ── Table ─────────────────────────────────────────── */
.wb-table {
  font-family: 'Kalam', cursive;
  font-size: 19px;
  border: 2px solid #2c3e50;
  border-radius: 6px;
  overflow: hidden;
  align-self: flex-start;
}
.table-row {
  display: flex;
}
.table-row.header {
  background: rgba(26,82,118,0.12);
  font-weight: 700;
  color: #1a5276;
  font-family: 'Caveat', cursive;
  font-size: 21px;
}
.table-cell {
  flex: 1;
  padding: 6px 14px;
  border-right: 1px solid rgba(44,62,80,0.2);
  border-bottom: 1px solid rgba(44,62,80,0.15);
  min-width: 100px;
}
.table-cell:last-child { border-right: none; }
.table-row:last-child .table-cell { border-bottom: none; }

/* ── Closing slide ──── */
.title-slide .main-title:has(+ .arrow-right) { }
</style>
</head>
<body style="margin:0; padding:0; background:#333;">
${slidesHtml}
</body>
</html>`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const slidesPath = process.argv[2] ?? "presentations/1/slides.md";
  const outputDir = process.argv[3] ?? "presentations/1/whiteboard";

  const markdown = readFileSync(slidesPath, "utf-8");
  const slides = parseSlides(markdown);
  console.log(`Parsed ${slides.length} slides`);

  mkdirSync(outputDir, { recursive: true });

  // Write the HTML
  const html = generateFullHtml(slides);
  const htmlPath = `${outputDir}/slides.html`;
  writeFileSync(htmlPath, html);
  console.log(`HTML written to ${htmlPath}`);

  // Open in Chrome and screenshot each slide
  console.log("Connecting to Chrome...");
  const targets = await CDP.List({ port: 9222 });

  // Create a new tab for rendering
  const newTarget = await CDP.New({
    port: 9222,
    url: `file://${process.cwd()}/${htmlPath}`,
  });
  console.log(`Opened rendering tab: ${newTarget.id}`);

  const client = await CDP({ target: newTarget });
  const { Page, Runtime, Emulation } = client;

  await Page.enable();
  await Emulation.setDeviceMetricsOverride({
    width: 1280,
    height: 720,
    deviceScaleFactor: 2,
    mobile: false,
  });

  // Wait for fonts to load
  await Page.loadEventFired();
  await Runtime.evaluate({
    expression: "document.fonts.ready.then(() => new Promise(r => setTimeout(r, 2000)))",
    awaitPromise: true,
  });

  // Screenshot each slide
  for (let i = 0; i < slides.length; i++) {
    console.log(`  Rendering slide ${i + 1}/${slides.length}: ${slides[i].title || "(section)"}`);

    // Get the element's position on the page
    const posResult = await Runtime.evaluate({
      expression: `
        (() => {
          const el = document.getElementById('slide-${i}');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
        })()
      `,
      returnByValue: true,
    });

    const pos = posResult.result.value as { x: number; y: number; w: number; h: number } | null;
    if (!pos) {
      console.log(`    Slide element not found, skipping`);
      continue;
    }

    // Use clip with absolute page coordinates (captureBeyondViewport clips from page origin)
    const screenshot = await Page.captureScreenshot({
      format: "png",
      clip: { x: pos.x, y: pos.y, width: 1280, height: 720, scale: 1 },
      captureBeyondViewport: true,
    });

    const filePath = `${outputDir}/slide_${String(i + 1).padStart(2, "0")}.png`;
    writeFileSync(filePath, Buffer.from(screenshot.data, "base64"));
  }

  // Close the rendering tab
  await CDP.Close({ port: 9222, id: newTarget.id });
  await client.close();

  console.log(`\nDone! ${slides.length} whiteboard slides saved to ${outputDir}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
