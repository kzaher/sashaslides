#!/usr/bin/env npx tsx
/**
 * build.ts — Bundles the browser-side html2slides app into a single
 * self-contained html2slides.html. Drop HTML files on the page → download .pptx.
 *
 * Inputs (all compiled/inlined at build time):
 *   - extract-dom.ts       → JS string, substituted into main.ts via esbuild define
 *   - main.ts              → IIFE bundle, with Node-only imports aliased to stubs
 *   - pptxgenjs.bundle.js  → attaches window.PptxGenJS
 *   - jszip.min.js         → attaches window.JSZip
 *
 * Output (mirrors the source path under the repo-root dist/ — gitignored):
 *   - dist/renderer/html2slides/browser/html2slides.html (self-contained, no network deps)
 */
import { build, transformSync } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");

function readText(p: string): string { return readFileSync(p, "utf-8"); }

async function main() {
  // 1. Compile extract-dom.ts → JS string. Same options as convert-pptx-lib.ts.
  const extractTs = readText(join(HERE, "..", "extract-dom.ts"));
  const extractJs = transformSync(extractTs, { loader: "ts", target: "es2020" }).code;
  console.log(`extract-dom.ts → ${extractJs.length.toLocaleString()} bytes JS`);

  // 2. Bundle main.ts. Node-only modules are aliased to per-stub files so the
  //    convert-pptx-lib top-level imports don't blow up the browser bundle.
  //    `define` substitutes the extract-dom JS string at every use site.
  const stubEmpty = join(HERE, "stubs", "empty.ts");
  const stubModule = join(HERE, "stubs", "module.ts");
  const result = await build({
    entryPoints: [join(HERE, "main.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: false,
    sourcemap: false,
    alias: {
      "fs": stubEmpty,
      "path": stubEmpty,
      "stream": stubEmpty,
      "url": stubEmpty,
      "module": stubModule,
      "chrome-remote-interface": stubEmpty,
      "googleapis": stubEmpty,
      "esbuild": stubEmpty,
      // pptxgenjs + jszip are inlined as vendor <script> tags below; alias the
      // module specifiers to thin stubs that read window.PptxGenJS / window.JSZip
      // so esbuild doesn't bundle the ~560 KB of source twice.
      "pptxgenjs": join(HERE, "stubs", "pptxgenjs-global.ts"),
      "jszip": join(HERE, "stubs", "jszip-global.ts"),
    },
    define: {
      __EXTRACT_JS_LITERAL__: JSON.stringify(extractJs),
    },
    logLevel: "info",
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error("esbuild produced no output");
  }
  const mainJs = result.outputFiles[0].text;
  console.log(`main bundle → ${mainJs.length.toLocaleString()} bytes JS`);

  // 3. Read vendor bundles + the slides-scraper snippet (verbatim text shown
  //    in a copyable textarea on the page).
  const pptxBundle = readText(join(ROOT, "node_modules/pptxgenjs/dist/pptxgen.bundle.js"));
  const jszipBundle = readText(join(ROOT, "node_modules/jszip/dist/jszip.min.js"));
  const scrapeSnippet = readText(join(HERE, "scrape-slides.snippet.js"));
  console.log(`pptxgenjs vendor → ${pptxBundle.length.toLocaleString()} bytes`);
  console.log(`jszip vendor     → ${jszipBundle.length.toLocaleString()} bytes`);
  console.log(`scrape snippet   → ${scrapeSnippet.length.toLocaleString()} bytes`);

  // HTML-escape the snippet for safe inclusion inside <textarea>.
  const escSnippet = scrapeSnippet
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 4. Assemble final HTML. The drop-zone UI + log/progress + the four scripts
  //    inlined in order (vendors first so window.PptxGenJS / window.JSZip
  //    exist before main runs).
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>html2slides — drag &amp; drop HTML → .pptx</title>
<style>
  * { box-sizing: border-box; }
  body { font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         margin: 0; padding: 24px; max-width: 900px; margin-inline: auto; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: #666; margin: 0 0 20px; }
  #dropzone { border: 2px dashed #bbb; border-radius: 10px; padding: 48px 24px;
              text-align: center; color: #555; cursor: pointer; transition: all .15s; }
  #dropzone.hover { border-color: #3b82f6; background: #eff6ff; color: #1d4ed8; }
  #dropzone strong { color: #111; }
  #picker { display: none; }
  .row { display: flex; gap: 8px; margin: 14px 0; align-items: center; }
  button { padding: 7px 14px; font: inherit; border: 1px solid #ccc; background: white;
           border-radius: 6px; cursor: pointer; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  button.primary { background: #2563eb; color: white; border-color: #2563eb; }
  button.primary:disabled { background: #93c5fd; border-color: #93c5fd; }
  #file-list { margin: 0; padding: 0 0 0 22px; max-height: 140px; overflow: auto;
               font: 12px/1.5 ui-monospace, monospace; color: #444; }
  #file-list li { list-style: disc; }
  #progress-wrap { height: 6px; background: #eee; border-radius: 3px; overflow: hidden; margin: 6px 0; }
  #progress-bar { height: 100%; background: #2563eb; width: 0%; transition: width .15s; }
  #progress-label { font: 12px/1 ui-monospace, monospace; color: #666; min-height: 14px; }
  #log { font: 11px/1.45 ui-monospace, monospace; background: #0b1020; color: #cbd5e1;
         padding: 10px; border-radius: 6px; height: 220px; overflow: auto; margin-top: 8px; }
  #log .warn { color: #fbbf24; }
  #log .error { color: #f87171; }
  details.scraper { margin-top: 28px; border-top: 1px solid #eee; padding-top: 18px; }
  details.scraper summary { cursor: pointer; font-weight: 600; }
  details.scraper p { color: #555; margin: 6px 0 10px; }
  details.scraper textarea { width: 100%; min-height: 220px; font: 11px/1.4 ui-monospace, monospace;
                             background: #0b1020; color: #cbd5e1; border: 0; padding: 10px;
                             border-radius: 6px; resize: vertical; }
  details.scraper .row { margin-top: 8px; }
  #copy-snippet.copied { background: #16a34a; color: white; border-color: #16a34a; }
</style>
</head>
<body>
<h1>html2slides</h1>
<p class="sub">Drop one or more HTML slide files, or paste HTML with Ctrl+V. They'll be converted to a single .pptx — all processing happens locally in this page. The result is downloaded and copied to your clipboard.</p>

<div id="dropzone">
  <strong>Drop .html files here</strong>, click to pick, or paste HTML (Ctrl+V).<br>
  <span id="file-count">0</span> file(s) queued.
</div>
<input type="file" id="picker" accept=".html,.htm" multiple>
<ul id="file-list"></ul>

<div class="row">
  <button id="convert-btn" class="primary" disabled>Convert → .pptx</button>
  <button id="clear-btn">Clear</button>
</div>

<div id="progress-wrap"><div id="progress-bar"></div></div>
<div id="progress-label"></div>
<div id="log"></div>

<details class="scraper" id="bridge-section">
  <summary>CLI bridge — watch a directory for JSON-RPC requests</summary>
  <p>Pick a watch directory (default for the CLI: <code>/tmp/html2slides</code>).
     This page will monitor for <code>request.&lt;id&gt;/request.json</code> files
     produced by the <code>html2slides-cli</code> bash script, run the conversion,
     and write back <code>result.pptx</code> + <code>request.json.result.json</code>.</p>
  <div class="row">
    <button id="bridge-pick">Pick watch directory…</button>
    <span id="bridge-label" style="font:11px ui-monospace, monospace; color:#666"></span>
  </div>
</details>

<details class="scraper">
  <summary>Download an existing Google Slides deck as PNGs</summary>
  <p>Open the target Google Slides deck in another tab, open DevTools (F12) →
     Console, paste the snippet below, press Enter. Handles HTTP 429 throttling
     automatically.</p>
  <textarea id="scrape-snippet" readonly spellcheck="false">${escSnippet}</textarea>
  <div class="row">
    <button id="copy-snippet">Copy to clipboard</button>
  </div>
</details>

<script>
(function(){
  const btn = document.getElementById('copy-snippet');
  const ta  = document.getElementById('scrape-snippet');
  btn?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ta.value); }
    catch { ta.select(); document.execCommand('copy'); }
    btn.textContent = 'Copied ✓';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy to clipboard'; btn.classList.remove('copied'); }, 1800);
  });
})();
</script>

<script>
${jszipBundle}
</script>
<script>
${pptxBundle}
</script>
<script>
${mainJs}
</script>
</body>
</html>`;

  const distDir = join(ROOT, "dist", "renderer", "html2slides", "browser");
  mkdirSync(distDir, { recursive: true });
  const outPath = join(distDir, "html2slides.html");
  writeFileSync(outPath, html);
  const totalKb = (html.length / 1024).toFixed(0);
  console.log(`\n✓ wrote ${outPath} (${totalKb} KB)`);
}

main().catch((e) => {
  console.error("build failed:", e);
  process.exit(1);
});
