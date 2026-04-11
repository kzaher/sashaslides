/**
 * render-assets.ts
 *
 * Renders hand-drawn whiteboard assets for use in generate-pptx.ts:
 * - underline.png           — one reusable squiggly title underline
 * - tables/table_NN.png     — hand-drawn table per slide that has one
 * - showcases/*.png         — full-slide PNGs presenting each graph type
 *
 * Uses rough.js + whiteboard-graphs.js, rendered in Chrome at high DPI.
 */

import CDP from "chrome-remote-interface";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Slide parsing (same as generate-pptx.ts) ───────────────────────────────

type TableData = { headers: string[]; rows: string[][] } | null;

type ParsedSlide = {
  title: string;
  subtitle: string;
  bodyLines: string[];
  table: TableData;
  notes: string;
  isSectionHeader: boolean;
  isTitleSlide: boolean;
  isClosing: boolean;
};

function parseSlides(md: string): ParsedSlide[] {
  const blocks = md.split(/\n---\n/);
  const slides: ParsedSlide[] = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;

    let title = "";
    let subtitle = "";
    const bodyLines: string[] = [];
    const notes: string[] = [];
    let isSectionHeader = false;
    let table: TableData = null;
    let inTable = false;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];

      if (line.startsWith(">")) {
        notes.push(line.replace(/^>\s*/, ""));
        continue;
      }

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

// ── Asset generation HTML ──────────────────────────────────────────────────

function cleanText(s: string): string {
  return s.replace(/\*\*/g, "");
}

function buildAssetHtml(slides: ParsedSlide[]): string {
  const rows: string[] = [];

  // 1. Fat, rough blue underline — rendered at 2400x80 for crisp roughness
  //    Double-stroked with slightly different seeds for extra marker-pen feel
  rows.push(`
    <div class="asset" id="asset-underline" data-name="underline" data-w="2400" data-h="80">
      <svg width="2400" height="80" viewBox="0 0 2400 80"></svg>
      <script>
        window.addEventListener('load', () => {
          const svg = document.querySelector('#asset-underline svg');
          const rc = WhiteboardGraphs.wrapRough(svg);
          // Two overlapping passes with different seeds create a chunkier marker look
          rc.line(30, 40, 2370, 40, {
            stroke: '#1a5276', strokeWidth: 14, roughness: 4, bowing: 3, seed: 11
          });
          rc.line(30, 44, 2370, 44, {
            stroke: '#1a5276', strokeWidth: 12, roughness: 3.5, bowing: 2.5, seed: 29
          });
        });
      </script>
    </div>
  `);

  // 2. Fat, rough red accent underline
  rows.push(`
    <div class="asset" id="asset-underline-red" data-name="underline-red" data-w="2400" data-h="80">
      <svg width="2400" height="80" viewBox="0 0 2400 80"></svg>
      <script>
        window.addEventListener('load', () => {
          const svg = document.querySelector('#asset-underline-red svg');
          const rc = WhiteboardGraphs.wrapRough(svg);
          rc.line(30, 40, 2370, 40, {
            stroke: '#c0392b', strokeWidth: 14, roughness: 4, bowing: 3, seed: 17
          });
          rc.line(30, 44, 2370, 44, {
            stroke: '#c0392b', strokeWidth: 12, roughness: 3.5, bowing: 2.5, seed: 43
          });
        });
      </script>
    </div>
  `);

  // 2. Hand-drawn table per slide that has one
  for (let i = 0; i < slides.length; i++) {
    const s = slides[i];
    if (!s.table) continue;
    const hasBody = s.bodyLines.length > 0;
    // Width: 580 if alongside body, 1100 if full-width
    const tableW = hasBody ? 620 : 1200;
    const tableH = 70 + s.table.rows.length * 55;
    const id = `asset-table-${i}`;

    const headersJson = JSON.stringify(s.table.headers.map(cleanText));
    const rowsJson = JSON.stringify(s.table.rows.map((r) => r.map(cleanText)));

    rows.push(`
      <div class="asset" id="${id}" data-name="table_${String(i).padStart(2, "0")}" data-w="${tableW}" data-h="${tableH}">
        <svg width="${tableW}" height="${tableH}" viewBox="0 0 ${tableW} ${tableH}"></svg>
        <script>
          window.addEventListener('load', () => {
            const svg = document.querySelector('#${id} svg');
            const rc = WhiteboardGraphs.wrapRough(svg);
            const W = ${tableW}, H = ${tableH};
            const headers = ${headersJson};
            const rows = ${rowsJson};
            const cols = headers.length;
            const colW = (W - 20) / cols;
            const rowH = 52;
            const headerH = 60;

            // Outer frame — fat and rough
            rc.rectangle(10, 10, W - 20, H - 20, {
              stroke: '#2c3e50', strokeWidth: 5, roughness: 2.5, bowing: 2
            });

            // Header background — hachured light blue
            rc.rectangle(10, 10, W - 20, headerH, {
              fill: '#d6eaf8', fillStyle: 'hachure', hachureGap: 6,
              stroke: '#1a5276', strokeWidth: 4, roughness: 2.5
            });

            // Vertical column separators
            for (let c = 1; c < cols; c++) {
              rc.line(10 + c * colW, 10, 10 + c * colW, H - 10, {
                stroke: '#2c3e50', strokeWidth: 3.5, roughness: 2.2, bowing: 1.5
              });
            }

            // Horizontal row separators
            rc.line(10, 10 + headerH, W - 10, 10 + headerH, {
              stroke: '#2c3e50', strokeWidth: 5, roughness: 2.5, bowing: 1.5
            });
            for (let r = 1; r < rows.length; r++) {
              rc.line(10, 10 + headerH + r * rowH, W - 10, 10 + headerH + r * rowH, {
                stroke: '#2c3e50', strokeWidth: 3, roughness: 2, bowing: 1.5
              });
            }

            // Header text
            headers.forEach((h, ci) => {
              WhiteboardGraphs.addText(svg, 10 + ci * colW + colW / 2, 10 + headerH / 2 + 10, h, {
                fontFamily: 'Caveat, cursive',
                fontSize: 28,
                color: '#1a5276',
                bold: true,
                anchor: 'middle',
              });
            });

            // Data rows
            rows.forEach((row, ri) => {
              row.forEach((cell, ci) => {
                WhiteboardGraphs.addText(svg, 10 + ci * colW + colW / 2, 10 + headerH + ri * rowH + rowH / 2 + 8, cell, {
                  fontFamily: 'Patrick Hand, cursive',
                  fontSize: 22,
                  color: '#2c3e50',
                  anchor: 'middle',
                });
              });
            });
          });
        </script>
      </div>
    `);
  }

  // 3. Showcase slides — driven by graphs.json config (editable by user)
  const showcaseW = 1600;
  const showcaseH = 900;

  // Default graph dimensions per type
  const DEFAULT_GRAPH_SIZE: Record<string, { w: number; h: number }> = {
    barChart:    { w: 900, h: 580 },
    lineChart:   { w: 900, h: 580 },
    pieChart:    { w: 700, h: 700 },
    flowDiagram: { w: 800, h: 600 },
    pillars:     { w: 800, h: 620 },
    hubSpoke:    { w: 800, h: 700 },
    roadmap:     { w: 1400, h: 450 },
    axes:        { w: 900, h: 600 },
  };

  // Render-call builder: takes a graph config and returns a JS expression string
  // that calls the appropriate WhiteboardGraphs function with the config.
  // Each graph name corresponds to a function in whiteboard-graphs.js.
  function buildRenderCall(type: string, config: any): string {
    switch (type) {
      case "barChart":
        return `WhiteboardGraphs.barChart(g, ${JSON.stringify(config.data)}, ${JSON.stringify(config.opts || {})})`;
      case "lineChart":
        return `WhiteboardGraphs.lineChart(g, ${JSON.stringify(config.data)}, ${JSON.stringify(config.opts || {})})`;
      case "pieChart":
        return `WhiteboardGraphs.pieChart(g, ${JSON.stringify(config.data)}, ${JSON.stringify(config.opts || {})})`;
      case "flowDiagram":
        return `WhiteboardGraphs.flowDiagram(g, ${JSON.stringify(config.nodes)}, ${JSON.stringify(config.edges)}, ${JSON.stringify(config.opts || {})})`;
      case "pillars":
        return `WhiteboardGraphs.pillars(g, ${JSON.stringify(config.pillarLabels)}, ${JSON.stringify(config.opts || {})})`;
      case "hubSpoke":
        return `WhiteboardGraphs.hubSpoke(g, ${JSON.stringify(config.centerLabel)}, ${JSON.stringify(config.spokes)}, ${JSON.stringify(config.opts || {})})`;
      case "roadmap":
        return `WhiteboardGraphs.roadmap(g, ${JSON.stringify(config.stages)}, ${JSON.stringify(config.opts || {})})`;
      default:
        return `/* unknown type ${type} */`;
    }
  }

  // Load graph configs from graphs.json
  const graphsJsonPath = resolve("/workspaces/sashaslides/presentations/1/graphs.json");
  const graphConfigs: Record<string, any> = existsSync(graphsJsonPath)
    ? JSON.parse(readFileSync(graphsJsonPath, "utf-8"))
    : {};
  console.log(`Loaded ${Object.keys(graphConfigs).length} graph configs from ${graphsJsonPath}`);

  for (const [name, cfg] of Object.entries(graphConfigs)) {
    const type = cfg.type as string;
    const size = DEFAULT_GRAPH_SIZE[type] || { w: 900, h: 600 };
    const isIntro = name === "showcase_intro";
    const titleColor = isIntro ? "#c0392b" : "#1a5276";
    const titleSize = isIntro ? 92 : 80;
    const titleAlign = isIntro ? "center" : "left";
    const titlePadding = isIntro ? 80 : 80;

    rows.push(`
      <div class="asset" id="asset-${name}" data-name="${name}" data-w="${showcaseW}" data-h="${showcaseH}">
        <div style="width:${showcaseW}px;height:${showcaseH}px;position:relative;background:transparent;">
          <div style="position:absolute;top:60px;left:${titlePadding}px;right:${titlePadding}px;text-align:${titleAlign};">
            <div style="font-family:'Caveat',cursive;font-size:${titleSize}px;color:${titleColor};font-weight:700;line-height:1">${cfg.title || name}</div>
            <div style="font-family:'Patrick Hand',cursive;font-size:36px;color:#2c3e50;margin-top:8px">${cfg.subtitle || ""}</div>
          </div>
          <svg id="svg-${name}" width="${size.w}" height="${size.h}" viewBox="0 0 ${size.w} ${size.h}"
               style="position:absolute;left:${(showcaseW - size.w) / 2}px;top:${240 + (showcaseH - 240 - size.h) / 2}px"></svg>
        </div>
        <script>
          window.addEventListener('load', () => {
            const g = document.getElementById('svg-${name}');
            ${buildRenderCall(type, cfg)};
          });
        </script>
      </div>
    `);
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.js"></script>
<script src="file:///workspaces/sashaslides/presentation-templates/whiteboard/whiteboard-graphs.js"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@400;700&family=Patrick+Hand&display=swap');
body { margin: 0; padding: 0; background: transparent; }
.asset { background: transparent; display: block; margin: 0; padding: 0; }
.asset svg { display: block; background: transparent; }
</style>
</head>
<body>
${rows.join("\n")}
</body>
</html>`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const slidesPath = process.argv[2] ?? "/workspaces/sashaslides/presentations/1/slides.md";
  const outputDir = process.argv[3] ?? "/workspaces/sashaslides/presentations/1/assets";

  mkdirSync(outputDir, { recursive: true });
  mkdirSync(`${outputDir}/tables`, { recursive: true });
  mkdirSync(`${outputDir}/showcases`, { recursive: true });

  const md = readFileSync(slidesPath, "utf-8");
  const slides = parseSlides(md);
  console.log(`Parsed ${slides.length} slides, ${slides.filter(s => s.table).length} tables`);

  // Write the HTML file with all assets
  const html = buildAssetHtml(slides);
  const htmlPath = `${outputDir}/render.html`;
  writeFileSync(htmlPath, html);
  console.log(`HTML: ${htmlPath}`);

  // Open in Chrome
  const newTarget = await CDP.New({
    port: 9222,
    url: `file://${htmlPath}`,
  });
  const client = await CDP({ target: newTarget });
  const { Page, Runtime, Emulation } = client;
  await Page.enable();

  await Emulation.setDeviceMetricsOverride({
    width: 1920,
    height: 1200,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await Emulation.setDefaultBackgroundColorOverride({ color: { r: 255, g: 255, b: 255, a: 0 } });

  await Page.loadEventFired();
  await Runtime.evaluate({
    expression: "document.fonts.ready.then(() => new Promise(r => setTimeout(r, 1200)))",
    awaitPromise: true,
  });

  // Get list of all assets
  const assets = await Runtime.evaluate({
    expression: `(() => Array.from(document.querySelectorAll('.asset')).map(el => {
      const r = el.getBoundingClientRect();
      return {
        name: el.dataset.name,
        w: parseInt(el.dataset.w),
        h: parseInt(el.dataset.h),
        x: r.x + window.scrollX,
        y: r.y + window.scrollY,
      };
    }))()`,
    returnByValue: true,
  });

  const list = assets.result.value as Array<{ name: string; w: number; h: number; x: number; y: number }>;
  console.log(`Rendering ${list.length} assets`);

  for (const a of list) {
    const ss = await Page.captureScreenshot({
      format: "png",
      clip: { x: a.x, y: a.y, width: a.w, height: a.h, scale: 1 },
      captureBeyondViewport: true,
    });
    let subdir = "";
    if (a.name.startsWith("table_")) subdir = "tables/";
    else if (a.name.startsWith("showcase_")) subdir = "showcases/";
    const path = `${outputDir}/${subdir}${a.name}.png`;
    writeFileSync(path, Buffer.from(ss.data, "base64"));
    console.log(`  ${a.name} (${a.w}x${a.h}) → ${path}`);
  }

  await CDP.Close({ port: 9222, id: newTarget.id });
  await client.close();
  console.log("\nDone!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
