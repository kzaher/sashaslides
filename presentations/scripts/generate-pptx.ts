/**
 * generate-pptx.ts
 *
 * Generates a fully-styled .pptx file from slides.md with whiteboard look:
 * - Off-white whiteboard background
 * - Caveat font for titles (handwriting)
 * - Patrick Hand for body text
 * - Blue/red color scheme
 *
 * Usage: npx tsx generate-pptx.ts <slides.md> <output.pptx>
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pptxgenModule from "pptxgenjs";
const pptxgen: any = (pptxgenModule as any).default || pptxgenModule;

const ICON_DIR = resolve("/workspaces/sashaslides/presentations/1/icons");
const ASSET_DIR = resolve("/workspaces/sashaslides/presentations/1/assets");

// Showcase slides to insert at the beginning (after title slide).
// Each references a PNG from assets/showcases/
const SHOWCASE_SLIDES = [
  { name: "showcase_intro",     title: "The Whiteboard Graph Library" },
  { name: "showcase_bar",       title: "Bar Chart" },
  { name: "showcase_line",      title: "Line Chart" },
  { name: "showcase_pie",       title: "Pie Chart" },
  { name: "showcase_flow",      title: "Flow Diagram" },
  { name: "showcase_pillars",   title: "Pillars" },
  { name: "showcase_hubspoke",  title: "Hub & Spoke" },
  { name: "showcase_roadmap",   title: "Roadmap" },
];

// Icon mapping: which icon to display on each slide (by slide index, 0-based)
// Icons are placed in the top-right corner of content slides, inside the frame
const ICON_X = 10.9;   // top-right x (inside the safe area)
const ICON_Y = 0.75;   // top-right y (inside the frame)
const ICON_SIZE = 1.5;
const CENTER_ICON_X = 13.33 / 2 - 0.5;
const CENTER_ICON_Y = 1.6;
const CENTER_ICON_SIZE = 1.0;

const SLIDE_ICONS: Record<number, { name: string; x?: number; y?: number; w?: number; h?: number }> = {
  0: { name: "lightbulb", x: CENTER_ICON_X, y: CENTER_ICON_Y, w: CENTER_ICON_SIZE, h: CENTER_ICON_SIZE }, // title slide
  1: { name: "arrow_right", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // agenda
  // slide 2 (index 2) is section header — skip
  3: { name: "warning", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // The Problem
  4: { name: "magnifying_glass", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // Three Real-Time Signals
  5: { name: "line_chart", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // Results
  // slide 6 (index 6) is section header — skip
  7: { name: "clock", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // Skip SGM
  8: { name: "brain_chip", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // Small models
  9: { name: "bar_chart", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // Fewer results
  10: { name: "money", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // Combined impact
  // slide 11 (index 11) is section header — skip
  12: { name: "soccer_ball", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // The Opportunity
  13: { name: "rocket", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // Generative UI how it works
  14: { name: "target", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // What we're building
  15: { name: "arrow_right", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // Personalization
  16: { name: "calendar", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // Timeline
  17: { name: "shield", x: ICON_X, y: ICON_Y, w: ICON_SIZE, h: ICON_SIZE }, // Risks & Asks
  18: { name: "target", x: CENTER_ICON_X, y: CENTER_ICON_Y, w: CENTER_ICON_SIZE, h: CENTER_ICON_SIZE }, // Thank You
};

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
        const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
        if (/^[\s|:-]+$/.test(line)) continue;
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

      // Headings
      if (/^#{1,2}\s/.test(line)) {
        const text = line.replace(/^#+\s+/, "").replace(/\*\*/g, "");
        if (text.startsWith("PART ")) {
          isSectionHeader = true;
          continue;
        }
        if (!title) title = text;
        else if (!subtitle) subtitle = text;
        continue;
      }

      bodyLines.push(line);
    }

    const isTitleSlide =
      lines[0]?.startsWith("# ") && bodyLines.length === 0 && !isSectionHeader && !table;
    const isClosing = title.toLowerCase().includes("thank you");

    if (notes.length > 0 && !subtitle) subtitle = notes[0];
    if (isTitleSlide && notes.length > 0) subtitle = notes.join(" | ");

    slides.push({
      title,
      subtitle,
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

// ── Strip markdown formatting markers from text ────────────────────────────

function cleanText(s: string): string {
  return s.replace(/\*\*/g, "");
}

// ── Format body line for pptx (handles bullets, bold) ──────────────────────

function formatBodyText(line: string): { text: string; bold: boolean; bullet: boolean } {
  let text = line;
  let bullet = false;
  let bold = false;

  if (text.startsWith("- ") || text.startsWith("• ")) {
    text = text.slice(2);
    bullet = true;
  }

  // Numbered list
  const numMatch = text.match(/^(\d+)\.\s+(.*)/);
  if (numMatch) {
    text = numMatch[2];
    bullet = true;
  }

  // Bold-only line (header within body)
  if (line.match(/^\*\*[^*]+\*\*$/) || line.match(/^\*\*[^*]+:\*\*$/)) {
    bold = true;
  }

  text = cleanText(text);
  return { text, bold, bullet };
}

// ── Main generation ────────────────────────────────────────────────────────

async function main() {
  const slidesPath = process.argv[2] ?? "presentations/1/slides.md";
  const outputPath = process.argv[3] ?? "presentations/1/RobPresentation.pptx";

  const markdown = readFileSync(slidesPath, "utf-8");
  const slides = parseSlides(markdown);
  console.log(`Parsed ${slides.length} slides`);

  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 inches (16:9)
  pres.title = "Gemini Search Q2 Update for Rob";
  pres.author = "Search Triggering & Optimization Team";

  // Whiteboard color palette
  const BG_COLOR = "F0EFE8"; // off-white
  const TITLE_BLUE = "1A5276";
  const TITLE_RED = "C0392B";
  const BODY_DARK = "2C3E50";
  const SUBTITLE_GRAY = "555555";
  const BORDER_GRAY = "B0B0B0";

  // Whiteboard fonts (Google Slides supports both natively)
  const TITLE_FONT = "Caveat";
  const BODY_FONT = "Patrick Hand";

  // Use the real whiteboard photo as the background image
  const WHITEBOARD_BG = resolve("/workspaces/sashaslides/presentation-templates/whiteboard/whiteboard_background.png");

  pres.defineSlideMaster({
    title: "WHITEBOARD",
    background: { color: "e8e8e8" }, // gray wall fallback if image missing
    objects: [
      {
        image: {
          path: WHITEBOARD_BG,
          x: 0,
          y: 0,
          w: 13.33,
          h: 7.5,
        },
      },
    ],
  });

  // Usable writing area inside the whiteboard frame (avoid frame + marker tray)
  // Frame ~ 0.5" on left/right/top, marker tray ~ 1" on bottom
  const SAFE_X = 0.9;
  const SAFE_Y = 0.7;
  const SAFE_W = 13.33 - 2 * SAFE_X;
  const SAFE_H = 7.5 - SAFE_Y - 1.2; // leave 1.2" at bottom for marker tray
  const SAFE_RIGHT = SAFE_X + SAFE_W;
  const SAFE_BOTTOM = SAFE_Y + SAFE_H;

  // ── Split original slides: title slide stays first, rest come after showcases ──
  // We want: [title] [showcase slides] [rest of content]
  const hasTitleSlide = slides.length > 0 && slides[0].isTitleSlide;
  const titleSlideData = hasTitleSlide ? slides[0] : null;
  const contentSlidesData = hasTitleSlide ? slides.slice(1) : slides;

  // Helper to render a single parsed slide (used for both title and content)
  // We'll render the title first, then showcases, then content.
  const renderOrder: Array<
    | { kind: "original"; data: SlideData; originalIndex: number }
    | { kind: "showcase"; name: string; title: string }
  > = [];

  if (titleSlideData) {
    renderOrder.push({ kind: "original", data: titleSlideData, originalIndex: 0 });
  }
  for (const sc of SHOWCASE_SLIDES) {
    renderOrder.push({ kind: "showcase", name: sc.name, title: sc.title });
  }
  const startIdx = hasTitleSlide ? 1 : 0;
  for (let j = 0; j < contentSlidesData.length; j++) {
    renderOrder.push({ kind: "original", data: contentSlidesData[j], originalIndex: startIdx + j });
  }

  for (let orderIdx = 0; orderIdx < renderOrder.length; orderIdx++) {
    const entry = renderOrder[orderIdx];

    if (entry.kind === "showcase") {
      // Full-slide showcase: place the rendered PNG inside the safe area.
      // altText stores the graph key so redraw-graphs can identify it and
      // so users can inspect/edit via right-click > Alt text in Slides.
      const slide = pres.addSlide({ masterName: "WHITEBOARD" });
      slide.addImage({
        path: `${ASSET_DIR}/showcases/${entry.name}.png`,
        x: SAFE_X,
        y: SAFE_Y,
        w: SAFE_W,
        h: SAFE_H,
        altText: `graph:${entry.name}`,
      } as any);
      continue;
    }

    const s = entry.data;
    const i = entry.originalIndex; // index into SLIDE_ICONS (based on original slides.md)
    const slide = pres.addSlide({ masterName: "WHITEBOARD" });

    if (s.notes) {
      slide.addNotes(s.notes);
    }

    // Add icon for this slide if configured
    const iconCfg = SLIDE_ICONS[i];
    if (iconCfg) {
      const iconPath = `${ICON_DIR}/${iconCfg.name}.png`;
      slide.addImage({
        path: iconPath,
        x: iconCfg.x ?? 11.3,
        y: iconCfg.y ?? 0.3,
        w: iconCfg.w ?? 1.6,
        h: iconCfg.h ?? 1.6,
      });
    }

    if (s.isTitleSlide || s.isClosing) {
      // Title slide layout — centered
      const titleColor = TITLE_RED;

      slide.addText(s.title, {
        x: SAFE_X,
        y: SAFE_Y + SAFE_H * 0.3,
        w: SAFE_W,
        h: 1.5,
        fontFace: TITLE_FONT,
        fontSize: 56,
        bold: true,
        color: titleColor,
        align: "center",
        valign: "middle",
      });

      // Decorative arrow
      slide.addText("→", {
        x: SAFE_X + SAFE_W / 2 - 0.5,
        y: SAFE_Y + SAFE_H * 0.55,
        w: 1,
        h: 0.5,
        fontFace: TITLE_FONT,
        fontSize: 32,
        color: titleColor,
        align: "center",
      });

      if (s.subtitle) {
        slide.addText(cleanText(s.subtitle), {
          x: SAFE_X,
          y: SAFE_Y + SAFE_H * 0.65,
          w: SAFE_W,
          h: 0.8,
          fontFace: BODY_FONT,
          fontSize: 26,
          color: SUBTITLE_GRAY,
          align: "center",
        });
      }
    } else if (s.isSectionHeader) {
      // Section header — centered with hand-drawn dividers
      const midY = SAFE_Y + SAFE_H / 2;
      const divW = SAFE_W * 0.5;
      const divH = divW * (80 / 2400); // preserve PNG aspect (2400x80)
      slide.addImage({
        path: `${ASSET_DIR}/underline.png`,
        x: SAFE_X + SAFE_W * 0.25,
        y: midY - 0.55,
        w: divW,
        h: divH,
      });

      slide.addText(cleanText(s.title), {
        x: SAFE_X,
        y: midY - 0.65,
        w: SAFE_W,
        h: 1.3,
        fontFace: TITLE_FONT,
        fontSize: 50,
        bold: true,
        color: TITLE_BLUE,
        align: "center",
        valign: "middle",
      });

      slide.addImage({
        path: `${ASSET_DIR}/underline-red.png`,
        x: SAFE_X + SAFE_W * 0.25,
        y: midY + 0.78,
        w: divW,
        h: divH,
      });
    } else {
      // Regular content slide
      const titleColor = TITLE_BLUE;
      // If an icon is placed in the top-right, make room for it
      const hasIconTopRight = iconCfg && iconCfg.x && iconCfg.x > 8;
      const titleW = hasIconTopRight ? SAFE_W - 1.8 : SAFE_W;

      // Title
      slide.addText(cleanText(s.title), {
        x: SAFE_X,
        y: SAFE_Y,
        w: titleW,
        h: 0.75,
        fontFace: TITLE_FONT,
        fontSize: 34,
        bold: true,
        color: titleColor,
        align: "left",
      });

      // Hand-drawn title underline (rendered via rough.js)
      const underlinePath = `${ASSET_DIR}/underline.png`;
      const ulH = titleW * (80 / 2400); // preserve 2400x80 aspect
      slide.addImage({
        path: underlinePath,
        x: SAFE_X,
        y: SAFE_Y + 0.7,
        w: titleW,
        h: ulH,
      });

      const hasTable = s.table !== null;
      const hasBody = s.bodyLines.length > 0;

      // Body content
      if (hasBody) {
        const bodyTextRuns = s.bodyLines.map((line) => {
          const f = formatBodyText(line);
          return {
            text: (f.bullet ? "• " : "") + f.text,
            options: {
              fontFace: BODY_FONT,
              fontSize: f.bold ? 20 : 16,
              color: f.bold ? TITLE_RED : BODY_DARK,
              bold: f.bold,
              breakLine: true,
            },
          };
        });

        const contentY = SAFE_Y + 1.0;
        const contentH = SAFE_BOTTOM - contentY;
        const bodyW = hasTable ? SAFE_W * 0.48 : SAFE_W;
        slide.addText(bodyTextRuns as any, {
          x: SAFE_X,
          y: contentY,
          w: bodyW,
          h: contentH,
          valign: "top",
        });
      }

      // Hand-drawn table (pre-rendered PNG from assets/tables/)
      if (hasTable && s.table) {
        const contentY = SAFE_Y + 1.0;
        const tableImgPath = `${ASSET_DIR}/tables/table_${String(i).padStart(2, "0")}.png`;
        const hasBodyContent = s.bodyLines.length > 0;

        // The rendered table PNG was built 620 wide (half-width) or 1200 wide (full).
        // Target display width in inches:
        const tableW = hasBodyContent ? SAFE_W * 0.48 : SAFE_W;
        // Keep aspect ratio from the rendered PNG (rows * 55 + 70 px, width 620 or 1200)
        const pxW = hasBodyContent ? 620 : 1200;
        const pxH = 70 + s.table.rows.length * 55;
        const tableH = (pxH / pxW) * tableW;
        const tableX = hasBodyContent ? SAFE_X + SAFE_W * 0.5 + 0.2 : SAFE_X;

        slide.addImage({
          path: tableImgPath,
          x: tableX,
          y: contentY,
          w: tableW,
          h: tableH,
        });
      }
    }
  }

  await pres.writeFile({ fileName: outputPath });
  console.log(`Wrote ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
