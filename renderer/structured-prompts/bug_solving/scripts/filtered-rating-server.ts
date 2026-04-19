#!/usr/bin/env npx tsx
/**
 * filtered-rating-server.ts — SxS rating UI for a single bug_solving task.
 *
 * Variant of renderer/html2slides/rating-server.ts that:
 *   - only shows the slides named in --slides,
 *   - pulls rendered thumbnails from --thumbnails (one per named slide),
 *   - pulls "original" HTML screenshots from the standard location
 *     (/tmp/sxs-complex/originals/<slide_id>.png) so the reviewer sees the
 *     Chrome ground truth next to the task's new render,
 *   - exposes two additional buttons per slide:
 *       · Show analysis   → renders the <slide_id> section of --analysis md
 *       · Show diff       → renders --diffs/<slide_id>.diff verbatim
 *
 * Usage:
 *   npx tsx filtered-rating-server.ts --port 4701 \
 *       --slides slide_04,slide_11 \
 *       --analysis /workspace/scratch/analysis.md \
 *       --diffs /workspace/scratch/diffs \
 *       --thumbnails /workspace/scratch/thumbnails \
 *       [--originals /tmp/sxs-complex/originals] \
 *       [--task-title "bug_solving: clipping"]
 */
import { createServer } from "http";
import { readFileSync, existsSync, statSync } from "fs";
import { resolve, join } from "path";

interface Args {
  port: number;
  slides: string[];
  analysis: string;
  diffs: string;
  thumbnails: string;
  originals: string;
  task_title: string;
}

function parseArgs(argv: string[]): Args {
  const a: any = {
    originals: "/tmp/sxs-complex/originals",
    task_title: "bug_solving",
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--port") a.port = +argv[++i];
    else if (v === "--slides") a.slides = argv[++i].split(",").map((s: string) => s.trim());
    else if (v === "--analysis") a.analysis = resolve(argv[++i]);
    else if (v === "--diffs") a.diffs = resolve(argv[++i]);
    else if (v === "--thumbnails") a.thumbnails = resolve(argv[++i]);
    else if (v === "--originals") a.originals = resolve(argv[++i]);
    else if (v === "--task-title") a.task_title = argv[++i];
  }
  if (!a.port || !a.slides || !a.analysis || !a.diffs || !a.thumbnails) {
    throw new Error(
      "usage: --port N --slides csv --analysis md --diffs dir --thumbnails dir " +
      "[--originals dir] [--task-title str]",
    );
  }
  return a as Args;
}

/** Parse a markdown file and return the body of the H2 section whose heading
 *  contains `slideId`. Returns null when no such section exists. */
function sectionFor(markdown: string, slideId: string): string | null {
  const lines = markdown.split(/\r?\n/);
  let inSection = false;
  const out: string[] = [];
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) {
      if (inSection) break; // hit next H2
      inSection = h2[1].includes(slideId);
      if (inSection) out.push(line);
      continue;
    }
    if (inSection) out.push(line);
  }
  return inSection ? out.join("\n").trim() : null;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const args = parseArgs(process.argv.slice(2));

const PAGE = (slides: Array<{ id: string; original: string | null; rendered: string | null }>) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${htmlEscape(args.task_title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; }
  .header { padding: 16px 24px; background: #16213e; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header .subtitle { font-size: 13px; color: #888; margin-top: 4px; }
  .slide-card { padding: 16px 24px; border-bottom: 1px solid #2a2a4e; }
  .slide-card h2 { font-size: 16px; color: #4a90d9; margin-bottom: 8px; }
  .pair { display: flex; gap: 4px; align-items: flex-start; }
  .panel { width: 49%; position: relative; }
  .panel img { width: 100%; border: 2px solid #333; border-radius: 4px; display: block; background: #0f1a30; }
  .panel.original img { border-color: #4a90d9; }
  .panel.rendered img { border-color: #27ae60; }
  .panel .label { position: absolute; top: 4px; left: 4px; background: rgba(0,0,0,0.7); color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.5px; }
  .empty-panel { width: 100%; height: 200px; border: 2px dashed #555; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #666; font-size: 13px; }
  .buttons { display: flex; gap: 8px; padding: 12px 0 4px; }
  .buttons button { background: #2a2a4e; color: #e0e0e0; border: 1px solid #444; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; }
  .buttons button:hover { background: #3a3a5e; }
  .buttons button.active { background: #4a90d9; border-color: #4a90d9; color: white; }
  .reveal { display: none; margin-top: 8px; padding: 12px; background: #0f1a30; border-left: 4px solid #4a90d9; border-radius: 0 6px 6px 0; }
  .reveal.show { display: block; }
  .reveal.analysis { border-left-color: #e67e22; }
  .reveal.diff { border-left-color: #f1c40f; }
  .reveal pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, "SF Mono", monospace; font-size: 12px; color: #ccc; max-height: 400px; overflow-y: auto; }
  .missing { color: #e94560; font-style: italic; }
</style></head><body>
<div class="header">
  <h1>${htmlEscape(args.task_title)}</h1>
  <div class="subtitle">${slides.length} slide(s) · analysis: ${htmlEscape(args.analysis)} · diffs: ${htmlEscape(args.diffs)}</div>
</div>
${slides.map((s, i) => `
  <div class="slide-card" id="${s.id}">
    <h2>${s.id}</h2>
    <div class="pair">
      <div class="panel original">
        <span class="label">original (Chrome)</span>
        ${s.original ? `<img src="/img?path=${encodeURIComponent(s.original)}">` : `<div class="empty-panel">original not found at ${htmlEscape(args.originals)}/${s.id}.png</div>`}
      </div>
      <div class="panel rendered">
        <span class="label">rendered (Slides, fixed)</span>
        ${s.rendered ? `<img src="/img?path=${encodeURIComponent(s.rendered)}">` : `<div class="empty-panel">rendered not found at ${htmlEscape(args.thumbnails)}/${s.id}.png</div>`}
      </div>
    </div>
    <div class="buttons">
      <button data-reveal="analysis-${i}">Show analysis</button>
      <button data-reveal="diff-${i}">Show diff analysis</button>
    </div>
    <div class="reveal analysis" id="analysis-${i}"><pre id="analysis-${i}-body">loading…</pre></div>
    <div class="reveal diff" id="diff-${i}"><pre id="diff-${i}-body">loading…</pre></div>
  </div>
`).join("")}
<script>
const SLIDES = ${JSON.stringify(slides.map(s => s.id))};
document.querySelectorAll("button[data-reveal]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const id = btn.getAttribute("data-reveal");
    const panel = document.getElementById(id);
    if (!panel) return;
    const wasOpen = panel.classList.contains("show");
    panel.classList.toggle("show");
    btn.classList.toggle("active", !wasOpen);
    if (!wasOpen) {
      const body = document.getElementById(id + "-body");
      const kind = id.startsWith("analysis-") ? "analysis" : "diff";
      const idx = +id.split("-")[1];
      const slideId = SLIDES[idx];
      const resp = await fetch("/" + kind + "?slide=" + encodeURIComponent(slideId));
      body.textContent = await resp.text();
    }
  });
});
</script>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${args.port}`);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    const slides = args.slides.map(id => {
      const original = join(args.originals, `${id}.png`);
      const rendered = join(args.thumbnails, `${id}.png`);
      return {
        id,
        original: existsSync(original) ? original : null,
        rendered: existsSync(rendered) ? rendered : null,
      };
    });
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(PAGE(slides));
    return;
  }
  if (url.pathname === "/img") {
    const p = url.searchParams.get("path") || "";
    if (existsSync(p) && p.endsWith(".png")) {
      const st = statSync(p);
      const etag = `"${st.mtimeMs.toFixed(0)}-${st.size}"`;
      if (req.headers["if-none-match"] === etag) { res.writeHead(304); res.end(); return; }
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "no-cache, must-revalidate",
        "ETag": etag,
      });
      res.end(readFileSync(p));
      return;
    }
    res.writeHead(404); res.end("not found"); return;
  }
  if (url.pathname === "/analysis") {
    const slideId = url.searchParams.get("slide") || "";
    if (!existsSync(args.analysis)) {
      res.writeHead(404); res.end(`analysis.md not found: ${args.analysis}`); return;
    }
    const body = readFileSync(args.analysis, "utf-8");
    const section = sectionFor(body, slideId);
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(section ?? `(no section found for ${slideId} in analysis.md)`);
    return;
  }
  if (url.pathname === "/diff") {
    const slideId = url.searchParams.get("slide") || "";
    const diffPath = join(args.diffs, `${slideId}.diff`);
    const summaryPath = join(args.diffs, `${slideId}.summary.json`);
    let body = "";
    if (existsSync(diffPath)) body += readFileSync(diffPath, "utf-8");
    else body += `(no diff file for ${slideId} at ${diffPath})`;
    if (existsSync(summaryPath)) {
      body += "\n\n--- summary.json ---\n" + readFileSync(summaryPath, "utf-8");
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(body);
    return;
  }
  res.writeHead(404); res.end("not found");
});

server.listen(args.port, () => {
  console.log(`filtered-rating-server: http://localhost:${args.port}`);
  console.log(`  slides:     ${args.slides.join(", ")}`);
  console.log(`  analysis:   ${args.analysis}`);
  console.log(`  diffs:      ${args.diffs}`);
  console.log(`  thumbnails: ${args.thumbnails}`);
  console.log(`  originals:  ${args.originals}`);
});
