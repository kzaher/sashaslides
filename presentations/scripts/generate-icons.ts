/**
 * generate-icons.ts
 *
 * Generates hand-drawn whiteboard-style icons as transparent PNGs using rough.js
 * rendered through Chrome. Creates a library of icons for use in the presentation.
 */

import CDP from "chrome-remote-interface";
import { writeFileSync, mkdirSync } from "node:fs";

type IconDef = {
  name: string;
  /** SVG content (rendered with rough.js wrapping) */
  draw: string;
  color: string;
};

// Each icon is defined by a function call sequence on a roughCanvas
// Coordinates are in a 200x200 viewport
const ICONS: IconDef[] = [
  {
    name: "lightbulb",
    color: "#f1c40f",
    draw: `
      // Bulb body (circle)
      rc.circle(100, 80, 80, { fill: '#f1c40f', fillStyle: 'solid', stroke: '#333', strokeWidth: 3, roughness: 1.5 });
      // Filament inside
      rc.line(85, 80, 100, 100, { stroke: '#333', strokeWidth: 2, roughness: 1.2 });
      rc.line(115, 80, 100, 100, { stroke: '#333', strokeWidth: 2, roughness: 1.2 });
      // Base lines
      rc.line(80, 130, 120, 130, { stroke: '#333', strokeWidth: 3, roughness: 1.5 });
      rc.line(82, 140, 118, 140, { stroke: '#333', strokeWidth: 3, roughness: 1.5 });
      rc.line(88, 150, 112, 150, { stroke: '#333', strokeWidth: 3, roughness: 1.5 });
      // Bottom contact
      rc.line(94, 160, 106, 168, { stroke: '#333', strokeWidth: 3, roughness: 1.5 });
      rc.line(106, 160, 94, 168, { stroke: '#333', strokeWidth: 3, roughness: 1.5 });
      // Light rays
      rc.line(20, 80, 40, 80, { stroke: '#f1c40f', strokeWidth: 3, roughness: 1.5 });
      rc.line(160, 80, 180, 80, { stroke: '#f1c40f', strokeWidth: 3, roughness: 1.5 });
      rc.line(35, 35, 50, 50, { stroke: '#f1c40f', strokeWidth: 3, roughness: 1.5 });
      rc.line(165, 35, 150, 50, { stroke: '#f1c40f', strokeWidth: 3, roughness: 1.5 });
      rc.line(100, 15, 100, 35, { stroke: '#f1c40f', strokeWidth: 3, roughness: 1.5 });
    `,
  },
  {
    name: "magnifying_glass",
    color: "#2980b9",
    draw: `
      // Lens (circle)
      rc.circle(80, 80, 90, { stroke: '#1a5276', strokeWidth: 5, roughness: 1.5 });
      // Inner highlight
      rc.circle(80, 80, 60, { stroke: '#5dade2', strokeWidth: 2, roughness: 1.2 });
      // Handle
      rc.line(120, 120, 175, 175, { stroke: '#1a5276', strokeWidth: 8, roughness: 1.5 });
      rc.line(125, 115, 180, 170, { stroke: '#1a5276', strokeWidth: 4, roughness: 1.2 });
    `,
  },
  {
    name: "bar_chart",
    color: "#2980b9",
    draw: `
      // Axes
      rc.line(30, 30, 30, 170, { stroke: '#333', strokeWidth: 3, roughness: 1.2 });
      rc.line(30, 170, 180, 170, { stroke: '#333', strokeWidth: 3, roughness: 1.2 });
      // Bars
      rc.rectangle(50, 110, 25, 60, { fill: '#3498db', fillStyle: 'hachure', hachureGap: 4, stroke: '#1a5276', strokeWidth: 2, roughness: 1.5 });
      rc.rectangle(85, 80, 25, 90, { fill: '#3498db', fillStyle: 'hachure', hachureGap: 4, stroke: '#1a5276', strokeWidth: 2, roughness: 1.5 });
      rc.rectangle(120, 50, 25, 120, { fill: '#3498db', fillStyle: 'hachure', hachureGap: 4, stroke: '#1a5276', strokeWidth: 2, roughness: 1.5 });
      rc.rectangle(155, 90, 25, 80, { fill: '#3498db', fillStyle: 'hachure', hachureGap: 4, stroke: '#1a5276', strokeWidth: 2, roughness: 1.5 });
    `,
  },
  {
    name: "line_chart",
    color: "#27ae60",
    draw: `
      // Axes
      rc.line(30, 30, 30, 170, { stroke: '#333', strokeWidth: 3, roughness: 1.2 });
      rc.line(30, 170, 180, 170, { stroke: '#333', strokeWidth: 3, roughness: 1.2 });
      // Trending line
      rc.line(40, 140, 70, 120, { stroke: '#27ae60', strokeWidth: 4, roughness: 1.5 });
      rc.line(70, 120, 100, 100, { stroke: '#27ae60', strokeWidth: 4, roughness: 1.5 });
      rc.line(100, 100, 130, 70, { stroke: '#27ae60', strokeWidth: 4, roughness: 1.5 });
      rc.line(130, 70, 165, 40, { stroke: '#27ae60', strokeWidth: 4, roughness: 1.5 });
      // Arrow
      rc.line(165, 40, 155, 35, { stroke: '#27ae60', strokeWidth: 4, roughness: 1.2 });
      rc.line(165, 40, 160, 50, { stroke: '#27ae60', strokeWidth: 4, roughness: 1.2 });
    `,
  },
  {
    name: "warning",
    color: "#c0392b",
    draw: `
      // Triangle
      rc.polygon([[100, 30], [180, 160], [20, 160]], { stroke: '#c0392b', strokeWidth: 5, roughness: 1.8 });
      // Exclamation mark — vertical line
      rc.line(100, 70, 100, 120, { stroke: '#c0392b', strokeWidth: 7, roughness: 1.5 });
      // Exclamation dot
      rc.circle(100, 140, 10, { fill: '#c0392b', fillStyle: 'solid', stroke: '#c0392b', strokeWidth: 2, roughness: 1.2 });
    `,
  },
  {
    name: "target",
    color: "#c0392b",
    draw: `
      // Outer rings
      rc.circle(100, 100, 160, { stroke: '#1a5276', strokeWidth: 4, roughness: 1.5 });
      rc.circle(100, 100, 110, { stroke: '#1a5276', strokeWidth: 3, roughness: 1.5 });
      rc.circle(100, 100, 60, { stroke: '#1a5276', strokeWidth: 3, roughness: 1.5 });
      // Bullseye
      rc.circle(100, 100, 20, { fill: '#c0392b', fillStyle: 'solid', stroke: '#c0392b', strokeWidth: 2, roughness: 1.2 });
      // Arrow shaft
      rc.line(50, 50, 95, 95, { stroke: '#c0392b', strokeWidth: 5, roughness: 1.5 });
      // Arrow head
      rc.line(85, 100, 95, 95, { stroke: '#c0392b', strokeWidth: 4, roughness: 1.2 });
      rc.line(100, 85, 95, 95, { stroke: '#c0392b', strokeWidth: 4, roughness: 1.2 });
      // Fletching
      rc.line(40, 40, 55, 55, { stroke: '#c0392b', strokeWidth: 3, roughness: 1.2 });
      rc.line(40, 60, 55, 45, { stroke: '#c0392b', strokeWidth: 3, roughness: 1.2 });
    `,
  },
  {
    name: "clock",
    color: "#1a5276",
    draw: `
      // Outer circle
      rc.circle(100, 100, 160, { stroke: '#1a5276', strokeWidth: 5, roughness: 1.5 });
      // Inner ring
      rc.circle(100, 100, 145, { stroke: '#1a5276', strokeWidth: 2, roughness: 1.2 });
      // Hour markers (12, 3, 6, 9)
      rc.line(100, 30, 100, 45, { stroke: '#333', strokeWidth: 3, roughness: 1.2 });
      rc.line(170, 100, 155, 100, { stroke: '#333', strokeWidth: 3, roughness: 1.2 });
      rc.line(100, 170, 100, 155, { stroke: '#333', strokeWidth: 3, roughness: 1.2 });
      rc.line(30, 100, 45, 100, { stroke: '#333', strokeWidth: 3, roughness: 1.2 });
      // Hour hand
      rc.line(100, 100, 100, 60, { stroke: '#c0392b', strokeWidth: 5, roughness: 1.2 });
      // Minute hand
      rc.line(100, 100, 140, 110, { stroke: '#c0392b', strokeWidth: 4, roughness: 1.2 });
      // Center
      rc.circle(100, 100, 8, { fill: '#c0392b', fillStyle: 'solid', stroke: '#c0392b', strokeWidth: 2, roughness: 1.2 });
    `,
  },
  {
    name: "soccer_ball",
    color: "#27ae60",
    draw: `
      // Ball outline
      rc.circle(100, 100, 160, { stroke: '#1a5276', strokeWidth: 5, roughness: 1.5 });
      // Inner pentagon (center)
      rc.polygon([[100, 65], [130, 85], [120, 120], [80, 120], [70, 85]], { fill: '#2c3e50', fillStyle: 'solid', stroke: '#2c3e50', strokeWidth: 3, roughness: 1.5 });
      // Surrounding hexagon edges
      rc.line(100, 65, 100, 35, { stroke: '#2c3e50', strokeWidth: 3, roughness: 1.2 });
      rc.line(130, 85, 165, 75, { stroke: '#2c3e50', strokeWidth: 3, roughness: 1.2 });
      rc.line(120, 120, 145, 145, { stroke: '#2c3e50', strokeWidth: 3, roughness: 1.2 });
      rc.line(80, 120, 55, 145, { stroke: '#2c3e50', strokeWidth: 3, roughness: 1.2 });
      rc.line(70, 85, 35, 75, { stroke: '#2c3e50', strokeWidth: 3, roughness: 1.2 });
    `,
  },
  {
    name: "shield",
    color: "#1a5276",
    draw: `
      // Shield outline
      rc.path('M 100,30 L 160,55 L 160,110 Q 160,160 100,180 Q 40,160 40,110 L 40,55 Z',
        { fill: '#5dade2', fillStyle: 'hachure', hachureGap: 6, stroke: '#1a5276', strokeWidth: 5, roughness: 1.8 });
      // Checkmark
      rc.line(70, 100, 90, 125, { stroke: '#27ae60', strokeWidth: 6, roughness: 1.2 });
      rc.line(90, 125, 130, 75, { stroke: '#27ae60', strokeWidth: 6, roughness: 1.2 });
    `,
  },
  {
    name: "calendar",
    color: "#1a5276",
    draw: `
      // Outer rectangle
      rc.rectangle(30, 50, 140, 130, { fill: '#fff', fillStyle: 'solid', stroke: '#1a5276', strokeWidth: 4, roughness: 1.5 });
      // Top header bar
      rc.rectangle(30, 50, 140, 25, { fill: '#c0392b', fillStyle: 'solid', stroke: '#1a5276', strokeWidth: 4, roughness: 1.5 });
      // Binding rings
      rc.line(60, 30, 60, 60, { stroke: '#333', strokeWidth: 4, roughness: 1.2 });
      rc.line(140, 30, 140, 60, { stroke: '#333', strokeWidth: 4, roughness: 1.2 });
      // Grid lines
      rc.line(30, 100, 170, 100, { stroke: '#1a5276', strokeWidth: 2, roughness: 1.2 });
      rc.line(30, 130, 170, 130, { stroke: '#1a5276', strokeWidth: 2, roughness: 1.2 });
      rc.line(30, 160, 170, 160, { stroke: '#1a5276', strokeWidth: 2, roughness: 1.2 });
      rc.line(65, 80, 65, 180, { stroke: '#1a5276', strokeWidth: 2, roughness: 1.2 });
      rc.line(100, 80, 100, 180, { stroke: '#1a5276', strokeWidth: 2, roughness: 1.2 });
      rc.line(135, 80, 135, 180, { stroke: '#1a5276', strokeWidth: 2, roughness: 1.2 });
    `,
  },
  {
    name: "brain_chip",
    color: "#1a5276",
    draw: `
      // Chip body
      rc.rectangle(50, 50, 100, 100, { fill: '#5dade2', fillStyle: 'hachure', hachureGap: 5, stroke: '#1a5276', strokeWidth: 4, roughness: 1.5 });
      // Inner brain shape
      rc.circle(85, 100, 30, { stroke: '#1a5276', strokeWidth: 2, roughness: 1.5 });
      rc.circle(115, 100, 30, { stroke: '#1a5276', strokeWidth: 2, roughness: 1.5 });
      // Pins
      rc.line(50, 70, 30, 70, { stroke: '#1a5276', strokeWidth: 3, roughness: 1.2 });
      rc.line(50, 100, 30, 100, { stroke: '#1a5276', strokeWidth: 3, roughness: 1.2 });
      rc.line(50, 130, 30, 130, { stroke: '#1a5276', strokeWidth: 3, roughness: 1.2 });
      rc.line(150, 70, 170, 70, { stroke: '#1a5276', strokeWidth: 3, roughness: 1.2 });
      rc.line(150, 100, 170, 100, { stroke: '#1a5276', strokeWidth: 3, roughness: 1.2 });
      rc.line(150, 130, 170, 130, { stroke: '#1a5276', strokeWidth: 3, roughness: 1.2 });
      rc.line(70, 50, 70, 30, { stroke: '#1a5276', strokeWidth: 3, roughness: 1.2 });
      rc.line(100, 50, 100, 30, { stroke: '#1a5276', strokeWidth: 3, roughness: 1.2 });
      rc.line(130, 50, 130, 30, { stroke: '#1a5276', strokeWidth: 3, roughness: 1.2 });
    `,
  },
  {
    name: "money",
    color: "#27ae60",
    draw: `
      // Bill outline
      rc.rectangle(20, 60, 160, 90, { fill: '#a9dfbf', fillStyle: 'solid', stroke: '#1e8449', strokeWidth: 4, roughness: 1.5 });
      // Inner border
      rc.rectangle(30, 70, 140, 70, { stroke: '#1e8449', strokeWidth: 2, roughness: 1.5 });
      // Dollar sign
      rc.circle(100, 105, 35, { stroke: '#1e8449', strokeWidth: 4, roughness: 1.5 });
      rc.line(100, 80, 100, 130, { stroke: '#1e8449', strokeWidth: 5, roughness: 1.2 });
      rc.line(85, 95, 115, 95, { stroke: '#1e8449', strokeWidth: 3, roughness: 1.2 });
      rc.line(85, 115, 115, 115, { stroke: '#1e8449', strokeWidth: 3, roughness: 1.2 });
    `,
  },
  {
    name: "rocket",
    color: "#c0392b",
    draw: `
      // Rocket body
      rc.path('M 100,20 Q 130,60 130,120 L 130,150 L 70,150 L 70,120 Q 70,60 100,20 Z',
        { fill: '#fadbd8', fillStyle: 'solid', stroke: '#c0392b', strokeWidth: 4, roughness: 1.5 });
      // Window
      rc.circle(100, 80, 25, { fill: '#5dade2', fillStyle: 'solid', stroke: '#1a5276', strokeWidth: 3, roughness: 1.5 });
      // Left fin
      rc.polygon([[70, 120], [50, 160], [70, 150]], { fill: '#c0392b', fillStyle: 'solid', stroke: '#922b21', strokeWidth: 3, roughness: 1.5 });
      // Right fin
      rc.polygon([[130, 120], [150, 160], [130, 150]], { fill: '#c0392b', fillStyle: 'solid', stroke: '#922b21', strokeWidth: 3, roughness: 1.5 });
      // Flame
      rc.polygon([[80, 150], [100, 185], [120, 150]], { fill: '#f1c40f', fillStyle: 'solid', stroke: '#e67e22', strokeWidth: 3, roughness: 1.8 });
    `,
  },
  {
    name: "arrow_right",
    color: "#1a5276",
    draw: `
      // Long curved arrow
      rc.path('M 30,100 Q 100,60 170,100', { stroke: '#1a5276', strokeWidth: 6, roughness: 1.5 });
      // Arrow head
      rc.line(170, 100, 150, 85, { stroke: '#1a5276', strokeWidth: 6, roughness: 1.2 });
      rc.line(170, 100, 150, 115, { stroke: '#1a5276', strokeWidth: 6, roughness: 1.2 });
    `,
  },
];

async function main() {
  const outputDir = "/workspaces/sashaslides/presentations/1/icons";
  mkdirSync(outputDir, { recursive: true });

  // Build the HTML page that renders all icons.
  // Need to wrap rough calls so that the result of each call is appended to the SVG.
  // We do this by intercepting rc methods.
  const iconsHtml = ICONS.map((icon, i) => `
    <div class="icon-container" id="icon-${i}">
      <svg id="svg-${i}" width="200" height="200" viewBox="0 0 200 200"></svg>
    </div>
    <script>
      window.addEventListener('load', function() {
        const svg = document.getElementById('svg-${i}');
        const realRc = rough.svg(svg);
        // Wrap each method to auto-append
        const rc = {};
        ['circle', 'rectangle', 'line', 'polygon', 'path', 'ellipse', 'arc', 'curve', 'linearPath'].forEach(function(m) {
          rc[m] = function() {
            const node = realRc[m].apply(realRc, arguments);
            if (node) svg.appendChild(node);
            return node;
          };
        });
        try {
          ${icon.draw}
        } catch(e) {
          console.error('Icon ${icon.name} error:', e);
        }
      });
    </script>
  `).join("\n");

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.js"></script>
<style>
  body { background: transparent; margin: 0; padding: 0; }
  .icon-container {
    width: 200px;
    height: 200px;
    background: transparent;
    margin: 0;
    padding: 0;
    display: block;
  }
  svg { background: transparent; display: block; }
</style>
</head>
<body>
${iconsHtml}
</body>
</html>`;

  const htmlPath = `${outputDir}/icons.html`;
  writeFileSync(htmlPath, html);
  console.log(`HTML written to ${htmlPath}`);

  // Render in Chrome
  console.log("Connecting to Chrome...");
  const newTarget = await CDP.New({
    port: 9222,
    url: `file://${htmlPath}`,
  });

  const client = await CDP({ target: newTarget });
  const { Page, Runtime, Emulation } = client;
  await Page.enable();

  await Emulation.setDeviceMetricsOverride({
    width: 240,
    height: 240,
    deviceScaleFactor: 2,
    mobile: false,
  });

  await Page.loadEventFired();

  // Wait for rough.js to load and render
  await Runtime.evaluate({
    expression: "new Promise(r => setTimeout(r, 2000))",
    awaitPromise: true,
  });

  // Set transparent background
  await Emulation.setDefaultBackgroundColorOverride({
    color: { r: 0, g: 0, b: 0, a: 0 },
  });

  // Screenshot each icon
  for (let i = 0; i < ICONS.length; i++) {
    const icon = ICONS[i];
    console.log(`  Rendering ${icon.name}...`);

    const posResult = await Runtime.evaluate({
      expression: `(() => {
        const el = document.getElementById('icon-${i}');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
      })()`,
      returnByValue: true,
    });

    const pos = posResult.result.value as { x: number; y: number; w: number; h: number };
    if (!pos) {
      console.log(`    skipped (no element)`);
      continue;
    }

    const screenshot = await Page.captureScreenshot({
      format: "png",
      clip: { x: pos.x, y: pos.y, width: pos.w, height: pos.h, scale: 1 },
      captureBeyondViewport: true,
    });

    const path = `${outputDir}/${icon.name}.png`;
    writeFileSync(path, Buffer.from(screenshot.data, "base64"));
  }

  await CDP.Close({ port: 9222, id: newTarget.id });
  await client.close();

  console.log(`\nDone! ${ICONS.length} icons saved to ${outputDir}/`);
}

main().catch(console.error);
