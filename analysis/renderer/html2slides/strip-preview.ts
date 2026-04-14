#!/usr/bin/env npx tsx
/**
 * Strip preview wrapper from HTML slides — makes them render-ready.
 *
 * Converts preview-styled slides (body centers a .slide div with border-radius/shadow)
 * into flat slides where body IS the slide at 1280x720.
 *
 * Usage: npx tsx strip-preview.ts <input-dir> [output-dir]
 *   If output-dir is omitted, overwrites in place.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join, resolve } from "path";

const inputDir = resolve(process.argv[2] || ".");
const outputDir = resolve(process.argv[3] || inputDir);
mkdirSync(outputDir, { recursive: true });

const TARGET_W = 1280;
const TARGET_H = 720;

const files = readdirSync(inputDir).filter(f => f.endsWith(".html")).sort();
console.log(`Stripping preview wrapper from ${files.length} slides`);

for (const f of files) {
  let html = readFileSync(join(inputDir, f), "utf-8");

  // 1. Replace body styling: remove centering, set to slide dimensions
  html = html.replace(
    /body\s*\{[^}]*\}/,
    `body {
  font-family: 'Google Sans', 'Google Sans Text', 'Segoe UI', Roboto, sans-serif;
  width: ${TARGET_W}px;
  height: ${TARGET_H}px;
  overflow: hidden;
  margin: 0;
  padding: 0;
  color: #202124;
}`
  );

  // 2. Replace .slide class: remove border-radius, box-shadow, make it fill body
  html = html.replace(
    /\.slide\s*\{[^}]*\}/,
    `.slide {
  width: ${TARGET_W}px;
  height: ${TARGET_H}px;
  background: #ffffff;
  overflow: hidden;
  position: relative;
  display: flex;
  flex-direction: column;
}`
  );

  // 3. Update CSS variables for slide dimensions
  html = html.replace(/--slide-width:\s*\d+px/, `--slide-width: ${TARGET_W}px`);
  html = html.replace(/--slide-height:\s*\d+px/, `--slide-height: ${TARGET_H}px`);

  // 4. Update viewport meta
  html = html.replace(/width=\d+/, `width=${TARGET_W}`);

  writeFileSync(join(outputDir, f), html);
  console.log(`  ${f}`);
}

console.log(`\nDone! ${files.length} slides → ${outputDir}`);
