/**
 * whiteboard-graphs.js
 *
 * A library for rendering graphs and diagrams in hand-drawn whiteboard style.
 * Uses rough.js to produce sketchy, imperfect lines that look drawn with a marker.
 *
 * Works in the browser. Import rough.js first:
 *   <script src="https://cdn.jsdelivr.net/npm/roughjs@4.6.6/bundled/rough.js"></script>
 *   <script src="./whiteboard-graphs.js"></script>
 *
 * Exposes global `WhiteboardGraphs` with these functions:
 *   - barChart(svg, data, opts)
 *   - lineChart(svg, data, opts)
 *   - pieChart(svg, data, opts)
 *   - flowDiagram(svg, nodes, edges, opts)
 *   - pillars(svg, pillarLabels, opts) — temple/pillar diagram
 *   - hubSpoke(svg, centerLabel, spokes, opts) — hub & spoke
 *   - roadmap(svg, stages, opts) — roadmap with arrow
 *   - axes(svg, opts) — just axes for custom plots
 *
 * Standard colors (whiteboard marker palette):
 *   BLUE:   #1a5276  (headings, primary lines)
 *   RED:    #c0392b  (accents, highlights)
 *   GREEN:  #1e8449  (positive/growth)
 *   BLACK:  #2c3e50  (body text, neutral)
 *   YELLOW: #f1c40f  (warnings, highlights)
 */

(function (global) {
  const COLORS = {
    BLUE: "#1a5276",
    LIGHT_BLUE: "#5dade2",
    RED: "#c0392b",
    GREEN: "#1e8449",
    BLACK: "#2c3e50",
    YELLOW: "#f1c40f",
    ORANGE: "#e67e22",
  };

  /**
   * Wrap a rough.svg() instance so that all calls auto-append their output
   * to the SVG. This is needed because rough.js returns SVG group nodes
   * that must be manually inserted.
   */
  function wrapRough(svg) {
    if (typeof rough === "undefined") {
      throw new Error("rough.js is not loaded — include it before whiteboard-graphs.js");
    }
    const real = rough.svg(svg);
    const methods = [
      "circle",
      "ellipse",
      "rectangle",
      "line",
      "polygon",
      "path",
      "arc",
      "curve",
      "linearPath",
    ];
    const wrapped = {};
    for (const m of methods) {
      wrapped[m] = function (...args) {
        const node = real[m](...args);
        if (node) svg.appendChild(node);
        return node;
      };
    }
    return wrapped;
  }

  /**
   * Add a handwritten text label to an SVG.
   */
  function addText(svg, x, y, text, opts = {}) {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", x);
    t.setAttribute("y", y);
    t.setAttribute("font-family", opts.fontFamily || "Caveat, cursive");
    t.setAttribute("font-size", opts.fontSize || 18);
    t.setAttribute("fill", opts.color || COLORS.BLACK);
    t.setAttribute("text-anchor", opts.anchor || "start");
    if (opts.bold || opts.fontWeight) t.setAttribute("font-weight", opts.fontWeight || "bold");
    if (opts.rotate) {
      t.setAttribute("transform", `rotate(${opts.rotate} ${x} ${y})`);
    }
    t.textContent = text;
    svg.appendChild(t);
    return t;
  }

  /**
   * Bar chart.
   *
   * data: [{ label: string, value: number, color?: string }, ...]
   * opts: {
   *   width, height, padding,
   *   title, xLabel, yLabel,
   *   barColor, fillStyle,
   * }
   */
  function barChart(svg, data, opts = {}) {
    const width = opts.width || parseFloat(svg.getAttribute("viewBox")?.split(" ")[2]) || 400;
    const height = opts.height || parseFloat(svg.getAttribute("viewBox")?.split(" ")[3]) || 300;
    const padding = opts.padding || { top: 40, right: 30, bottom: 50, left: 60 };
    const rc = wrapRough(svg);

    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;
    const maxValue = Math.max(...data.map((d) => d.value));

    // Title
    if (opts.title) {
      addText(svg, width / 2, 24, opts.title, {
        fontSize: 22,
        color: COLORS.BLUE,
        bold: true,
        anchor: "middle",
      });
    }

    // Axes
    rc.line(padding.left, padding.top, padding.left, padding.top + plotH, {
      stroke: COLORS.BLACK,
      strokeWidth: 3,
      roughness: 1.2,
    });
    rc.line(padding.left, padding.top + plotH, padding.left + plotW, padding.top + plotH, {
      stroke: COLORS.BLACK,
      strokeWidth: 3,
      roughness: 1.2,
    });

    // Y axis label
    if (opts.yLabel) {
      addText(svg, 18, padding.top + plotH / 2, opts.yLabel, {
        fontSize: 14,
        color: COLORS.BLACK,
        anchor: "middle",
        rotate: -90,
      });
    }
    // X axis label
    if (opts.xLabel) {
      addText(svg, padding.left + plotW / 2, height - 10, opts.xLabel, {
        fontSize: 14,
        color: COLORS.BLACK,
        anchor: "middle",
      });
    }

    // Bars
    const barCount = data.length;
    const gap = plotW / (barCount * 2 + 1);
    const barW = (plotW - gap * (barCount + 1)) / barCount;

    for (let i = 0; i < barCount; i++) {
      const d = data[i];
      const barH = (d.value / maxValue) * plotH;
      const x = padding.left + gap + i * (barW + gap);
      const y = padding.top + plotH - barH;
      const color = d.color || opts.barColor || COLORS.BLUE;

      rc.rectangle(x, y, barW, barH, {
        fill: color,
        fillStyle: opts.fillStyle || "hachure",
        hachureGap: 5,
        stroke: color,
        strokeWidth: 2,
        roughness: 1.5,
      });

      // Value label on top
      addText(svg, x + barW / 2, y - 5, String(d.value), {
        fontSize: 14,
        color: COLORS.BLACK,
        anchor: "middle",
      });
      // Category label below
      addText(svg, x + barW / 2, padding.top + plotH + 18, d.label, {
        fontSize: 14,
        color: COLORS.BLACK,
        anchor: "middle",
      });
    }

    return svg;
  }

  /**
   * Line chart.
   *
   * data: [{ label: string, value: number }, ...]
   * opts: { width, height, padding, title, xLabel, yLabel, lineColor }
   */
  function lineChart(svg, data, opts = {}) {
    const width = opts.width || parseFloat(svg.getAttribute("viewBox")?.split(" ")[2]) || 400;
    const height = opts.height || parseFloat(svg.getAttribute("viewBox")?.split(" ")[3]) || 300;
    const padding = opts.padding || { top: 40, right: 30, bottom: 50, left: 60 };
    const rc = wrapRough(svg);
    const lineColor = opts.lineColor || COLORS.GREEN;

    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;
    const maxValue = Math.max(...data.map((d) => d.value));
    const minValue = Math.min(...data.map((d) => d.value), 0);

    // Title
    if (opts.title) {
      addText(svg, width / 2, 24, opts.title, {
        fontSize: 22,
        color: COLORS.BLUE,
        bold: true,
        anchor: "middle",
      });
    }

    // Axes
    rc.line(padding.left, padding.top, padding.left, padding.top + plotH, {
      stroke: COLORS.BLACK,
      strokeWidth: 3,
      roughness: 1.2,
    });
    rc.line(padding.left, padding.top + plotH, padding.left + plotW, padding.top + plotH, {
      stroke: COLORS.BLACK,
      strokeWidth: 3,
      roughness: 1.2,
    });

    // Plot points
    const stepX = plotW / Math.max(data.length - 1, 1);
    const range = maxValue - minValue || 1;
    const points = data.map((d, i) => ({
      x: padding.left + i * stepX,
      y: padding.top + plotH - ((d.value - minValue) / range) * plotH,
      value: d.value,
      label: d.label,
    }));

    // Draw line segments
    for (let i = 0; i < points.length - 1; i++) {
      rc.line(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, {
        stroke: lineColor,
        strokeWidth: 4,
        roughness: 1.5,
      });
    }

    // Draw points as small circles
    for (const p of points) {
      rc.circle(p.x, p.y, 12, {
        fill: lineColor,
        fillStyle: "solid",
        stroke: lineColor,
        strokeWidth: 2,
        roughness: 1,
      });
      // Value label
      addText(svg, p.x, p.y - 15, String(p.value), {
        fontSize: 13,
        color: COLORS.BLACK,
        anchor: "middle",
        bold: true,
      });
      // X label
      addText(svg, p.x, padding.top + plotH + 18, p.label, {
        fontSize: 13,
        color: COLORS.BLACK,
        anchor: "middle",
      });
    }

    // Axis labels
    if (opts.yLabel) {
      addText(svg, 18, padding.top + plotH / 2, opts.yLabel, {
        fontSize: 14,
        color: COLORS.BLACK,
        anchor: "middle",
        rotate: -90,
      });
    }
    if (opts.xLabel) {
      addText(svg, padding.left + plotW / 2, height - 10, opts.xLabel, {
        fontSize: 14,
        color: COLORS.BLACK,
        anchor: "middle",
      });
    }

    return svg;
  }

  /**
   * Pie chart.
   *
   * data: [{ label, value, color? }, ...]
   * opts: { width, height, title, cx, cy, radius }
   */
  function pieChart(svg, data, opts = {}) {
    const width = opts.width || parseFloat(svg.getAttribute("viewBox")?.split(" ")[2]) || 400;
    const height = opts.height || parseFloat(svg.getAttribute("viewBox")?.split(" ")[3]) || 400;
    const rc = wrapRough(svg);
    const cx = opts.cx || width / 2;
    const cy = opts.cy || height / 2 + 10;
    const radius = opts.radius || Math.min(width, height) * 0.35;

    if (opts.title) {
      addText(svg, width / 2, 28, opts.title, {
        fontSize: 22,
        color: COLORS.BLUE,
        bold: true,
        anchor: "middle",
      });
    }

    const palette = [COLORS.BLUE, COLORS.RED, COLORS.GREEN, COLORS.YELLOW, COLORS.ORANGE, COLORS.LIGHT_BLUE];
    const total = data.reduce((sum, d) => sum + d.value, 0);

    let startAngle = -Math.PI / 2; // top
    data.forEach((d, i) => {
      const slice = (d.value / total) * Math.PI * 2;
      const endAngle = startAngle + slice;
      const color = d.color || palette[i % palette.length];

      // Build SVG path for pie slice
      const x1 = cx + radius * Math.cos(startAngle);
      const y1 = cy + radius * Math.sin(startAngle);
      const x2 = cx + radius * Math.cos(endAngle);
      const y2 = cy + radius * Math.sin(endAngle);
      const largeArc = slice > Math.PI ? 1 : 0;
      const pathStr = `M ${cx},${cy} L ${x1},${y1} A ${radius},${radius} 0 ${largeArc} 1 ${x2},${y2} Z`;

      rc.path(pathStr, {
        fill: color,
        fillStyle: "hachure",
        hachureGap: 6,
        stroke: color,
        strokeWidth: 3,
        roughness: 1.8,
      });

      // Label
      const midAngle = startAngle + slice / 2;
      const labelR = radius * 1.25;
      const lx = cx + labelR * Math.cos(midAngle);
      const ly = cy + labelR * Math.sin(midAngle);
      const pct = Math.round((d.value / total) * 100);
      addText(svg, lx, ly, `${d.label} (${pct}%)`, {
        fontSize: 14,
        color: COLORS.BLACK,
        anchor: lx < cx ? "end" : "start",
      });

      startAngle = endAngle;
    });

    return svg;
  }

  /**
   * Flow diagram with boxes connected by arrows.
   *
   * nodes: [{ id: string, label: string, x: number, y: number, w?: number, h?: number, color? }, ...]
   * edges: [{ from: id, to: id, label?: string }, ...]
   */
  function flowDiagram(svg, nodes, edges, opts = {}) {
    const rc = wrapRough(svg);

    // Draw nodes
    const nodeMap = {};
    for (const node of nodes) {
      const w = node.w || 120;
      const h = node.h || 60;
      const color = node.color || COLORS.BLUE;
      rc.rectangle(node.x, node.y, w, h, {
        fill: opts.nodeFill || "#eaf4fb",
        fillStyle: "solid",
        stroke: color,
        strokeWidth: 3,
        roughness: 1.5,
      });
      addText(svg, node.x + w / 2, node.y + h / 2 + 5, node.label, {
        fontSize: 16,
        color: COLORS.BLACK,
        anchor: "middle",
        bold: true,
      });
      nodeMap[node.id] = { ...node, w, h, cx: node.x + w / 2, cy: node.y + h / 2 };
    }

    // Draw edges
    for (const edge of edges) {
      const from = nodeMap[edge.from];
      const to = nodeMap[edge.to];
      if (!from || !to) continue;

      // Compute edge start/end at node boundaries
      const dx = to.cx - from.cx;
      const dy = to.cy - from.cy;
      const angle = Math.atan2(dy, dx);

      // Start point: edge of from node
      const fromHW = from.w / 2;
      const fromHH = from.h / 2;
      let sx, sy;
      if (Math.abs(dx) * fromHH > Math.abs(dy) * fromHW) {
        sx = from.cx + Math.sign(dx) * fromHW;
        sy = from.cy + (Math.sign(dx) * fromHW * dy) / dx;
      } else {
        sx = from.cx + (Math.sign(dy) * fromHH * dx) / dy;
        sy = from.cy + Math.sign(dy) * fromHH;
      }

      // End point: edge of to node
      const toHW = to.w / 2;
      const toHH = to.h / 2;
      let ex, ey;
      if (Math.abs(dx) * toHH > Math.abs(dy) * toHW) {
        ex = to.cx - Math.sign(dx) * toHW;
        ey = to.cy - (Math.sign(dx) * toHW * dy) / dx;
      } else {
        ex = to.cx - (Math.sign(dy) * toHH * dx) / dy;
        ey = to.cy - Math.sign(dy) * toHH;
      }

      // Line
      rc.line(sx, sy, ex, ey, {
        stroke: COLORS.BLACK,
        strokeWidth: 3,
        roughness: 1.5,
      });

      // Arrow head
      const arrowLen = 12;
      rc.line(
        ex,
        ey,
        ex - arrowLen * Math.cos(angle - Math.PI / 6),
        ey - arrowLen * Math.sin(angle - Math.PI / 6),
        { stroke: COLORS.BLACK, strokeWidth: 3, roughness: 1.2 }
      );
      rc.line(
        ex,
        ey,
        ex - arrowLen * Math.cos(angle + Math.PI / 6),
        ey - arrowLen * Math.sin(angle + Math.PI / 6),
        { stroke: COLORS.BLACK, strokeWidth: 3, roughness: 1.2 }
      );

      // Edge label
      if (edge.label) {
        addText(svg, (sx + ex) / 2, (sy + ey) / 2 - 5, edge.label, {
          fontSize: 12,
          color: COLORS.RED,
          anchor: "middle",
        });
      }
    }

    return svg;
  }

  /**
   * Temple/pillar diagram — a pediment on top of N pillars with a base.
   *
   * pillarLabels: [string, ...]
   * opts: { width, height, title, topLabel, baseLabel, color }
   */
  function pillars(svg, pillarLabels, opts = {}) {
    const width = opts.width || parseFloat(svg.getAttribute("viewBox")?.split(" ")[2]) || 500;
    const height = opts.height || parseFloat(svg.getAttribute("viewBox")?.split(" ")[3]) || 350;
    const rc = wrapRough(svg);
    const color = opts.color || COLORS.BLUE;
    const redColor = COLORS.RED;

    if (opts.title) {
      addText(svg, width / 2, 28, opts.title, {
        fontSize: 22,
        color: color,
        bold: true,
        anchor: "middle",
      });
    }

    // Pediment (triangle on top)
    const pedY = opts.title ? 50 : 30;
    const pedBaseY = pedY + 50;
    rc.polygon(
      [
        [width / 2, pedY],
        [width * 0.88, pedBaseY],
        [width * 0.12, pedBaseY],
      ],
      { stroke: redColor, strokeWidth: 4, roughness: 1.8 }
    );
    if (opts.topLabel) {
      addText(svg, width / 2, pedY + 35, opts.topLabel, {
        fontSize: 16,
        color: redColor,
        bold: true,
        anchor: "middle",
      });
    }

    // Pillars
    const pillarCount = pillarLabels.length;
    const pillarAreaW = width * 0.6;
    const pillarW = 60;
    const totalGap = pillarAreaW - pillarW * pillarCount;
    const gap = totalGap / (pillarCount - 1 || 1);
    const pillarTopY = pedBaseY + 10;
    const pillarBaseY = height - 80;

    for (let i = 0; i < pillarCount; i++) {
      const x = width * 0.2 + i * (pillarW + gap);
      rc.rectangle(x, pillarTopY, pillarW, pillarBaseY - pillarTopY, {
        stroke: color,
        strokeWidth: 4,
        roughness: 1.5,
      });
      // Capital and base
      rc.line(x - 4, pillarTopY, x + pillarW + 4, pillarTopY, {
        stroke: color,
        strokeWidth: 4,
        roughness: 1.2,
      });
      rc.line(x - 4, pillarBaseY, x + pillarW + 4, pillarBaseY, {
        stroke: color,
        strokeWidth: 4,
        roughness: 1.2,
      });

      // Label inside pillar
      addText(svg, x + pillarW / 2, (pillarTopY + pillarBaseY) / 2, pillarLabels[i], {
        fontSize: 15,
        color: COLORS.BLACK,
        bold: true,
        anchor: "middle",
      });

      // Up-arrow from base to pediment
      rc.line(x + pillarW / 2, pillarBaseY - 20, x + pillarW / 2, pillarTopY + 20, {
        stroke: redColor,
        strokeWidth: 2,
        roughness: 1.2,
      });
      rc.line(
        x + pillarW / 2,
        pillarTopY + 20,
        x + pillarW / 2 - 4,
        pillarTopY + 28,
        { stroke: redColor, strokeWidth: 2, roughness: 1 }
      );
      rc.line(
        x + pillarW / 2,
        pillarTopY + 20,
        x + pillarW / 2 + 4,
        pillarTopY + 28,
        { stroke: redColor, strokeWidth: 2, roughness: 1 }
      );
    }

    // Base
    const baseY = pillarBaseY + 10;
    rc.rectangle(width * 0.15, baseY, width * 0.7, 30, {
      stroke: color,
      strokeWidth: 4,
      roughness: 1.5,
    });
    if (opts.baseLabel) {
      addText(svg, width / 2, baseY + 22, opts.baseLabel, {
        fontSize: 15,
        color: COLORS.BLACK,
        bold: true,
        anchor: "middle",
      });
    }

    return svg;
  }

  /**
   * Hub & spoke diagram — central node with surrounding nodes.
   *
   * spokes: [{ label, color? }, ...]
   * opts: { width, height, title, centerColor }
   */
  function hubSpoke(svg, centerLabel, spokes, opts = {}) {
    const width = opts.width || parseFloat(svg.getAttribute("viewBox")?.split(" ")[2]) || 500;
    const height = opts.height || parseFloat(svg.getAttribute("viewBox")?.split(" ")[3]) || 400;
    const rc = wrapRough(svg);
    const cx = width / 2;
    const cy = height / 2 + (opts.title ? 15 : 0);
    const centerR = 55;
    const spokeR = 180;

    if (opts.title) {
      addText(svg, width / 2, 28, opts.title, {
        fontSize: 22,
        color: COLORS.BLUE,
        bold: true,
        anchor: "middle",
      });
    }

    const palette = [COLORS.BLUE, COLORS.RED, COLORS.GREEN, COLORS.YELLOW, COLORS.ORANGE, COLORS.LIGHT_BLUE];

    // Draw spokes first (so center overlaps them)
    spokes.forEach((spoke, i) => {
      const angle = (i / spokes.length) * Math.PI * 2 - Math.PI / 2;
      const sx = cx + spokeR * Math.cos(angle);
      const sy = cy + spokeR * Math.sin(angle);
      const color = spoke.color || palette[i % palette.length];

      // Line from center to spoke
      rc.line(cx, cy, sx, sy, {
        stroke: COLORS.BLACK,
        strokeWidth: 2,
        roughness: 1.5,
      });

      // Spoke circle
      rc.circle(sx, sy, 70, {
        fill: "#ffffff",
        fillStyle: "solid",
        stroke: color,
        strokeWidth: 4,
        roughness: 1.5,
      });
      addText(svg, sx, sy + 5, spoke.label, {
        fontSize: 14,
        color: color,
        bold: true,
        anchor: "middle",
      });
    });

    // Center node
    rc.rectangle(cx - centerR, cy - centerR / 2, centerR * 2, centerR, {
      fill: opts.centerColor || "#eaf4fb",
      fillStyle: "solid",
      stroke: COLORS.BLUE,
      strokeWidth: 4,
      roughness: 1.5,
    });
    addText(svg, cx, cy + 5, centerLabel, {
      fontSize: 16,
      color: COLORS.BLUE,
      bold: true,
      anchor: "middle",
    });

    return svg;
  }

  /**
   * Roadmap — horizontal arrow with milestone boxes along it.
   *
   * stages: [{ label: string, sublabel?: string, color? }, ...]
   * opts: { width, height, title }
   */
  function roadmap(svg, stages, opts = {}) {
    const width = opts.width || parseFloat(svg.getAttribute("viewBox")?.split(" ")[2]) || 600;
    const height = opts.height || parseFloat(svg.getAttribute("viewBox")?.split(" ")[3]) || 250;
    const rc = wrapRough(svg);
    const palette = [COLORS.BLUE, COLORS.RED, COLORS.GREEN, COLORS.ORANGE, COLORS.LIGHT_BLUE];

    if (opts.title) {
      addText(svg, width / 2, 28, opts.title, {
        fontSize: 22,
        color: COLORS.BLUE,
        bold: true,
        anchor: "middle",
      });
    }

    const roadY = opts.title ? height / 2 + 10 : height / 2;

    // Long arrow from left to right
    rc.line(30, roadY, width - 50, roadY, {
      stroke: COLORS.BLACK,
      strokeWidth: 5,
      roughness: 1.5,
    });
    // Arrow head
    rc.line(width - 50, roadY, width - 70, roadY - 15, {
      stroke: COLORS.BLACK,
      strokeWidth: 5,
      roughness: 1.2,
    });
    rc.line(width - 50, roadY, width - 70, roadY + 15, {
      stroke: COLORS.BLACK,
      strokeWidth: 5,
      roughness: 1.2,
    });

    // Stages
    const stepX = (width - 100) / stages.length;
    stages.forEach((stage, i) => {
      const x = 50 + i * stepX + stepX / 2;
      const above = i % 2 === 0;
      const y = above ? roadY - 60 : roadY + 60;
      const color = stage.color || palette[i % palette.length];

      // Line from road to box
      rc.line(x, roadY, x, above ? y + 20 : y - 20, {
        stroke: color,
        strokeWidth: 2,
        roughness: 1.2,
      });

      // Milestone circle
      rc.circle(x, roadY, 14, {
        fill: color,
        fillStyle: "solid",
        stroke: color,
        strokeWidth: 2,
        roughness: 1,
      });

      // Box
      const boxW = stepX * 0.85;
      const boxH = 50;
      rc.rectangle(x - boxW / 2, above ? y - 15 : y - 15, boxW, boxH, {
        fill: "#ffffff",
        fillStyle: "solid",
        stroke: color,
        strokeWidth: 3,
        roughness: 1.5,
      });
      addText(svg, x, above ? y + 5 : y + 5, stage.label, {
        fontSize: 14,
        color: color,
        bold: true,
        anchor: "middle",
      });
      if (stage.sublabel) {
        addText(svg, x, above ? y + 22 : y + 22, stage.sublabel, {
          fontSize: 11,
          color: COLORS.BLACK,
          anchor: "middle",
        });
      }
    });

    return svg;
  }

  /**
   * Just axes — for building custom plots.
   */
  function axes(svg, opts = {}) {
    const width = opts.width || parseFloat(svg.getAttribute("viewBox")?.split(" ")[2]) || 400;
    const height = opts.height || parseFloat(svg.getAttribute("viewBox")?.split(" ")[3]) || 300;
    const padding = opts.padding || { top: 30, right: 20, bottom: 40, left: 50 };
    const rc = wrapRough(svg);

    rc.line(padding.left, padding.top, padding.left, height - padding.bottom, {
      stroke: COLORS.BLACK,
      strokeWidth: 3,
      roughness: 1.2,
    });
    rc.line(padding.left, height - padding.bottom, width - padding.right, height - padding.bottom, {
      stroke: COLORS.BLACK,
      strokeWidth: 3,
      roughness: 1.2,
    });
    return svg;
  }

  global.WhiteboardGraphs = {
    COLORS,
    wrapRough,
    addText,
    barChart,
    lineChart,
    pieChart,
    flowDiagram,
    pillars,
    hubSpoke,
    roadmap,
    axes,
  };
})(typeof window !== "undefined" ? window : globalThis);
