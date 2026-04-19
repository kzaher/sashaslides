#!/usr/bin/env npx tsx
/**
 * render-preview.ts — Render pptx extraction data back to PNGs for comparison
 *
 * Takes the _extractions.json from convert.ts and renders each slide's elements
 * back to HTML → PNG. This simulates what the .pptx looks like without needing
 * Google Slides or LibreOffice.
 *
 * Usage: npx tsx render-preview.ts <extractions.json> <output-dir>
 */

import CDP from "chrome-remote-interface";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";

const CDP_PORT = 9222;

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function elementToHtml(el: any): string {
  const b = el.bounds;

  switch (el.type) {
    case "rect":
      return `<div style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;background:${el.fill||'transparent'};${el.borderWidth>0?`border:${el.borderWidth}px solid ${el.borderColor||'#ccc'};`:''}${el.borderRadius>0?`border-radius:${el.borderRadius}px;`:''}"></div>`;
    case "line": {
      const isVert = b.h > b.w * 2;
      const lw = isVert ? Math.max(1, b.w) : b.w;
      const lh = isVert ? b.h : Math.max(1, b.h);
      return `<div style="position:absolute;left:${b.x}px;top:${b.y}px;width:${lw}px;height:${lh}px;background:${el.color||'#000'};"></div>`;
    }
    case "text": {
      const s = el.style || {};
      // Build text HTML — use runs if available for per-span styling
      let textHtml: string;
      if (el.runs && el.runs.length > 0) {
        textHtml = el.runs.map((r: any) => {
          const t = (r.text || '').replace(/\n/g, '<br>');
          if (!r.style) return t;
          const rs = r.style;
          const styles = [
            rs.color ? `color:${rs.color}` : '',
            rs.fontWeight === 'bold' ? 'font-weight:bold' : '',
            rs.fontStyle === 'italic' ? 'font-style:italic' : '',
            rs.fontSize && rs.fontSize !== s.fontSize ? `font-size:${rs.fontSize}px` : '',
            rs.textDecoration ? `text-decoration:${rs.textDecoration}` : '',
          ].filter(Boolean).join(';');
          return styles ? `<span style="${styles}">${t}</span>` : t;
        }).join('');
      } else {
        textHtml = (el.text||'').replace(/\n/g, '<br>');
      }
      const tt = s.textTransform ? `text-transform:${s.textTransform};` : '';
      const ls = s.letterSpacing ? `letter-spacing:${s.letterSpacing}px;` : '';
      // Single-line hack: pad width 30% to prevent font-difference wrapping
      const lineH = s.lineHeight || (s.fontSize || 16) * 1.4;
      const isSingleLine = !(el.text||'').includes('\n') && b.h <= lineH * 1.4;
      const align = s.textAlign || 'left';
      let bx = b.x, bw = b.w;
      if (isSingleLine) {
        const extra = b.w * 0.3;
        if (align === 'center') { bx = Math.max(0, b.x - extra/2); bw = Math.min(1280 - bx, b.w + extra); }
        else if (align === 'right') { bx = Math.max(0, b.x - extra); bw = Math.min(1280 - bx, b.w + extra); }
        else { bw = Math.min(1280 - b.x, b.w + extra); }
      }
      return `<div style="position:absolute;left:${bx}px;top:${b.y}px;width:${bw}px;height:${b.h}px;font-family:'${s.fontFamily||'Arial'}',sans-serif;font-size:${s.fontSize||16}px;font-weight:${s.fontWeight||'normal'};font-style:${s.fontStyle||'normal'};color:${s.color||'#333'};text-align:${align};line-height:${s.lineHeight ? s.lineHeight+'px' : '1.2'};${tt}${ls}overflow:visible;white-space:${isSingleLine?'nowrap':'normal'};">${textHtml}</div>`;
    }
    case "table": {
      let html = `<table style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;border-collapse:collapse;">`;
      for (const row of el.rows || []) {
        html += '<tr>';
        for (const cell of row) {
          const cs = cell.style || {};
          html += `<td style="padding:4px 8px;font-family:${cs.fontFamily||'Arial'},sans-serif;font-size:${cs.fontSize||14}px;font-weight:${cs.fontWeight||'normal'};color:${cs.color||'#333'};background:${cs.bgColor||'transparent'};border:1px solid ${cs.borderColor||'#ccc'};text-align:${cs.textAlign||'left'};"${cell.colspan>1?` colspan="${cell.colspan}"`:''}">${cell.text||''}</td>`;
        }
        html += '</tr>';
      }
      html += '</table>';
      return html;
    }
    case "list": {
      const tag = el.ordered ? 'ol' : 'ul';
      const columnCount = el.columnCount || 1;
      const colStyle = columnCount > 1 ? `columns:${columnCount};column-gap:80px;` : '';
      const listStyle = el.listStyleType === 'none' ? 'list-style:none;padding-left:0;' : 'padding-left:20px;';
      let html = `<${tag} style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;margin:0;${listStyle}font-family:${el.style?.fontFamily||'Arial'},sans-serif;font-size:${el.style?.fontSize||16}px;color:${el.style?.color||'#333'};${colStyle}">`;
      for (const item of el.items || []) {
        const spacing = item.spacingAfter ? `padding:${Math.round(item.spacingAfter/2)}px 0;` : '';
        const lh = item.lineHeight ? `line-height:${item.lineHeight}px;` : '';
        html += `<li style="margin-left:${item.level*20}px;font-weight:${item.fontWeight||'normal'};color:${item.color||'#333'};font-size:${item.fontSize||16}px;${lh}${spacing}break-inside:avoid;">${item.text}</li>`;
      }
      html += `</${tag}>`;
      return html;
    }
    case "visual":
      if (el.pngData) {
        return `<img style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;" src="data:image/png;base64,${el.pngData}">`;
      }
      return `<div style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;background:#f0f0f0;border:1px dashed #ccc;display:flex;align-items:center;justify-content:center;font-size:11px;color:#999;">SVG</div>`;
    case "image":
      if (el.src) {
        return `<img style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;" src="${el.src}">`;
      }
      return '';
    default: return '';
  }
}

async function main() {
  const extractionsPath = process.argv[2];
  const outputDir = process.argv[3];
  if (!extractionsPath || !outputDir) {
    console.error("Usage: npx tsx render-preview.ts <extractions.json> <output-dir>");
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });
  const extractions = JSON.parse(readFileSync(extractionsPath, "utf-8"));

  // Collect all unique font families used across all slides
  const allFonts = new Set<string>();
  for (const slide of extractions) {
    for (const el of slide.elements) {
      if (el.style?.fontFamily) allFonts.add(el.style.fontFamily);
      if (el.items) for (const item of el.items) if (item.fontFamily) allFonts.add(item.fontFamily);
    }
  }
  // Build Google Fonts URL with all weights+italic
  const fontFamilies = [...allFonts]
    .filter(f => !['Arial','Helvetica','sans-serif','serif','monospace','-apple-system'].includes(f))
    .map(f => `family=${f.replace(/ /g,'+')}:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400;1,600`)
    .join('&');
  const fontsLink = fontFamilies ? `<link href="https://fonts.googleapis.com/css2?${fontFamilies}&display=swap" rel="stylesheet">` : '';

  for (const slide of extractions) {
    const elements = slide.elements.map(elementToHtml).join('\n');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">${fontsLink}<style>*{margin:0;padding:0;box-sizing:border-box;}body{width:1280px;height:720px;overflow:hidden;position:relative;background:#fff;}</style></head><body>${elements}</body></html>`;

    const tmpPath = join(outputDir, `_tmp_${slide.slide}.html`);
    writeFileSync(tmpPath, html);

    const tab = await (CDP as any).New({ port: CDP_PORT, url: `file://${tmpPath}` });
    await sleep(800);
    const client = await CDP({ target: tab, port: CDP_PORT });
    await client.Page.enable();
    await client.Emulation.setDeviceMetricsOverride({ width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
    await sleep(500);
    const ss = await client.Page.captureScreenshot({ format: "png" });
    writeFileSync(join(outputDir, `slide_${String(slide.slide).padStart(2, '0')}.png`), Buffer.from(ss.data, "base64"));
    await client.close();
    await (CDP as any).Close({ port: CDP_PORT, id: tab.id });

    try { unlinkSync(tmpPath); } catch {}
    console.log(`  slide_${String(slide.slide).padStart(2, '0')}.png`);
  }
}

main().catch(console.error);
