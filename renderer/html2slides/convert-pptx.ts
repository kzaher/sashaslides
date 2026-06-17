#!/usr/bin/env npx tsx
/**
 * convert-pptx.ts — CLI wrapper around `runConvertPptx`.
 *
 * Pipeline:
 *   1. Extract DOM from HTML files (extract-dom.ts running in Chrome via CDP)
 *   2. Build .pptx with pptxgenjs (exact corner radii, native text, shapes)
 *   3. Upload .pptx to Google Drive as Google Slides presentation (unless --no-upload)
 *
 * All real logic lives in convert-pptx-lib.ts (pure) and convert-pptx-io.ts
 * (side-effectful orchestration). This file only parses argv and forwards.
 *
 * Usage: npx tsx convert-pptx.ts <html-dir> [--title "Name"] [--out /tmp/out.pptx]
 *                                          [--only slide_NN.html[,...]] [--no-upload]
 */

import { runConvertPptx } from "./convert-pptx-io.js";

function parseArgs(argv: readonly string[]): {
  htmlDir: string;
  title: string;
  outPath: string | null;
  noUpload: boolean;
  only: string[] | null;
  tablesFormat: "native" | "baked";
} {
  let htmlDir = "";
  let title = "Presentation";
  let outPath: string | null = null;
  let noUpload = false;
  let only: string[] | null = null;
  let tablesFormat: "native" | "baked" = "native";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--title") title = argv[++i];
    else if (a === "--out") outPath = argv[++i];
    else if (a === "--no-upload") noUpload = true;
    else if (a === "--only") only = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--tables-format") {
      const v = argv[++i];
      if (v !== "native" && v !== "baked") { console.error(`--tables-format must be "native" or "baked", got: ${v}`); process.exit(2); }
      tablesFormat = v;
    }
    else if (!a.startsWith("--") && !htmlDir) htmlDir = a;
    else { console.error("Unknown argument: " + a); process.exit(2); }
  }
  if (!htmlDir) {
    console.error("Usage: convert-pptx.ts <html-dir> [--title ...] [--out ...] [--no-upload] [--only slide_NN.html,...] [--tables-format native|baked]");
    process.exit(2);
  }
  return { htmlDir, title, outPath, noUpload, only, tablesFormat };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await runConvertPptx(args);
}

main().catch(err => { console.error(err); process.exit(1); });
