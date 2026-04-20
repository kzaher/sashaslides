#!/usr/bin/env npx tsx
/**
 * filtered-rating-server.ts — SxS rating UI for a single bug_solving task.
 *
 * Shows, per slide: original HTML screenshot (Chrome) vs the task's freshly
 * uploaded Slides render, plus two reveals ("Show analysis", "Show diff")
 * that pull from the worker's analysis.md and the per-slide diff file.
 *
 * Per-slide links to the HTML source and the Google Slides page live at the
 * top of each card when the relevant inputs are wired:
 *   * HTML source link:  --html-dir + "${slide_id}.html" (or --fixtures alias)
 *   * Google Slides link: read from <thumbnails>/manifest.json, which
 *     upload-and-scrape.ts now writes with presentation_id + parallel
 *     slide_object_ids so we can build `…/edit#slide=id.<oid>` deep links.
 *
 * UI is Preact (ships from esm.sh, no bundler) so reveal toggles are
 * component-local state that survives any re-render — same pattern as the
 * structured-prompting engine monitor.
 *
 * Usage:
 *   npx tsx filtered-rating-server.ts --port 4701 \
 *       --slides slide_04,slide_11 \
 *       --analysis /workspace/scratch/analysis.md \
 *       --diffs /workspace/scratch/diffs \
 *       --thumbnails /workspace/scratch/thumbnails \
 *       [--originals /tmp/sxs-complex/originals] \
 *       [--html-dir renderer/html2slides/e2e/fixtures-complex] \
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
  html_dir: string | null;
  task_title: string;
}

function parseArgs(argv: string[]): Args {
  const a: any = {
    originals: "/tmp/sxs-complex/originals",
    html_dir: null,
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
    else if (v === "--html-dir" || v === "--fixtures") a.html_dir = resolve(argv[++i]);
    else if (v === "--task-title") a.task_title = argv[++i];
  }
  if (!a.port || !a.slides || !a.analysis || !a.diffs || !a.thumbnails) {
    throw new Error(
      "usage: --port N --slides csv --analysis md --diffs dir --thumbnails dir " +
      "[--originals dir] [--html-dir dir] [--task-title str]",
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
      if (inSection) break;
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

interface Manifest {
  presentation_id?: string;
  slides?: string[];
  slide_object_ids?: string[];
}

/** Read <thumbnails>/manifest.json if present. Built by upload-and-scrape.ts
 *  step [3/3]; absent means upload hasn't completed yet (server booted
 *  during retry, or retry is stuck at step 2). Link panel just hides in that
 *  case rather than erroring. */
function readManifest(thumbnailsDir: string): Manifest {
  const p = join(thumbnailsDir, "manifest.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Manifest;
  } catch {
    return {};
  }
}

const args = parseArgs(process.argv.slice(2));

/** Per-slide payload the browser receives on /api/slides. Everything the UI
 *  needs to render one card — avoids any server-rendered HTML the client
 *  would have to pry apart. */
interface SlidePayload {
  id: string;
  original: string | null;
  rendered: string | null;
  htmlPath: string | null;        // abs path, used by the /html endpoint
  slidesUrl: string | null;       // deep link into Google Slides
}

function buildPayload(): { task_title: string; slides: SlidePayload[] } {
  const manifest = readManifest(args.thumbnails);
  const slideToOid = new Map<string, string>();
  if (manifest.slides && manifest.slide_object_ids) {
    for (let i = 0; i < manifest.slides.length; i++) {
      const oid = manifest.slide_object_ids[i];
      if (oid) slideToOid.set(manifest.slides[i], oid);
    }
  }
  const slides = args.slides.map<SlidePayload>(id => {
    const original = join(args.originals, `${id}.png`);
    const rendered = join(args.thumbnails, `${id}.png`);
    const htmlPath = args.html_dir ? join(args.html_dir, `${id}.html`) : null;
    const oid = slideToOid.get(id);
    const slidesUrl = manifest.presentation_id
      ? `https://docs.google.com/presentation/d/${manifest.presentation_id}/edit` +
        (oid ? `#slide=id.${oid}` : "")
      : null;
    return {
      id,
      original: existsSync(original) ? original : null,
      rendered: existsSync(rendered) ? rendered : null,
      htmlPath: htmlPath && existsSync(htmlPath) ? htmlPath : null,
      slidesUrl,
    };
  });
  return { task_title: args.task_title, slides };
}

const CLIENT_SCRIPT = `
import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect } from "https://esm.sh/preact@10/hooks";

// Reveal that fetches its body lazily on first open AND caches it in
// component-local state, so toggling it closed/open again doesn't re-hit
// the server. Because Preact reconciles by position + type, this state
// survives App-level re-renders.
function Reveal(props) {
  const { kind, slideId, label, accent } = props;
  const [shown, setShown] = useState(false);
  const [body, setBody] = useState(null);
  const [err, setErr] = useState(null);
  const toggle = async () => {
    const next = !shown;
    setShown(next);
    if (next && body == null && err == null) {
      try {
        const r = await fetch("/" + kind + "?slide=" + encodeURIComponent(slideId));
        const text = await r.text();
        if (!r.ok) throw new Error(text);
        setBody(text);
      } catch (e) {
        setErr(String(e && e.message ? e.message : e));
      }
    }
  };
  return h("div", null,
    h("button", {
      class: "reveal-btn" + (shown ? " active" : ""),
      onClick: toggle,
    }, (shown ? "Hide " : "Show ") + label),
    shown && h("div", { class: "reveal-panel accent-" + accent },
      err != null
        ? h("div", { class: "err" }, err)
        : body == null
          ? h("div", { class: "muted" }, "loading…")
          : h("pre", null, body),
    ),
  );
}

function SlideCard(props) {
  const s = props.slide;
  return h("div", { class: "slide-card", id: s.id },
    h("div", { class: "card-head" },
      h("h2", null, s.id),
      h("div", { class: "links" },
        s.htmlPath && h("a", {
          href: "/html?slide=" + encodeURIComponent(s.id),
          target: "_blank",
        }, "View HTML Source"),
        s.slidesUrl && h("a", { href: s.slidesUrl, target: "_blank" },
          "Open in Google Slides"),
      ),
    ),
    h("div", { class: "pair" },
      h("div", { class: "panel original" },
        h("span", { class: "label" }, "original (Chrome)"),
        s.original
          ? h("img", { src: "/img?path=" + encodeURIComponent(s.original) })
          : h("div", { class: "empty-panel" }, "original not found for " + s.id),
      ),
      h("div", { class: "panel rendered" },
        h("span", { class: "label" }, "rendered (Slides, fixed)"),
        s.rendered
          ? h("img", { src: "/img?path=" + encodeURIComponent(s.rendered) })
          : h("div", { class: "empty-panel" }, "rendered not found for " + s.id),
      ),
    ),
    h("div", { class: "buttons" },
      h(Reveal, { kind: "analysis", slideId: s.id, label: "analysis", accent: "orange" }),
      h(Reveal, { kind: "diff", slideId: s.id, label: "diff analysis", accent: "yellow" }),
    ),
  );
}

function App() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    fetch("/api/slides")
      .then(r => r.ok ? r.json() : r.text().then(t => { throw new Error(t); }))
      .then(setData)
      .catch(e => setErr(String(e && e.message ? e.message : e)));
  }, []);
  if (err) return h("div", { class: "header" }, h("h1", null, "error: " + err));
  if (!data) return h("div", { class: "header" }, h("h1", null, "loading…"));
  return h("div", null,
    h("div", { class: "header" },
      h("h1", null, data.task_title),
      h("div", { class: "subtitle" }, data.slides.length + " slide(s)"),
    ),
    data.slides.map(s => h(SlideCard, { key: s.id, slide: s })),
  );
}

render(h(App), document.body);
`;

const HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${htmlEscape(args.task_title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; }
  .header { padding: 16px 24px; background: #16213e; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .subtitle { font-size: 13px; color: #888; margin-top: 4px; }
  .slide-card { padding: 16px 24px; border-bottom: 1px solid #2a2a4e; }
  .card-head { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
  .card-head h2 { font-size: 16px; color: #4a90d9; }
  .links { display: flex; gap: 12px; font-size: 13px; }
  .links a { color: #4a90d9; text-decoration: none; padding: 2px 8px; border-radius: 4px; background: #0f1a30; }
  .links a:hover { background: #4a90d9; color: white; }
  .pair { display: flex; gap: 4px; align-items: flex-start; }
  .panel { width: 49%; position: relative; }
  .panel img { width: 100%; border: 2px solid #333; border-radius: 4px; display: block; background: #0f1a30; }
  .panel.original img { border-color: #4a90d9; }
  .panel.rendered img { border-color: #27ae60; }
  .panel .label { position: absolute; top: 4px; left: 4px; background: rgba(0,0,0,0.7); color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.5px; z-index: 1; }
  .empty-panel { width: 100%; height: 200px; border: 2px dashed #555; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #666; font-size: 13px; padding: 0 16px; text-align: center; }
  .buttons { display: flex; gap: 8px; padding: 12px 0 4px; }
  .reveal-btn { background: #2a2a4e; color: #e0e0e0; border: 1px solid #444; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; font-family: inherit; }
  .reveal-btn:hover { background: #3a3a5e; }
  .reveal-btn.active { background: #4a90d9; border-color: #4a90d9; color: white; }
  .reveal-panel { margin-top: 8px; padding: 12px; background: #0f1a30; border-left: 4px solid #4a90d9; border-radius: 0 6px 6px 0; }
  .reveal-panel.accent-orange { border-left-color: #e67e22; }
  .reveal-panel.accent-yellow { border-left-color: #f1c40f; }
  .reveal-panel pre { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, "SF Mono", monospace; font-size: 12px; color: #ccc; max-height: 400px; overflow-y: auto; }
  .reveal-panel .muted { color: #666; font-style: italic; }
  .reveal-panel .err { color: #e94560; }
</style></head><body>
<script type="module">${CLIENT_SCRIPT}</script>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${args.port}`);

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
    return;
  }

  if (url.pathname === "/api/slides") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(buildPayload()));
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

  if (url.pathname === "/html") {
    // Serve the HTML source file by slide id so the browser URL stays
    // opaque — the filesystem path never leaks into hrefs.
    const slideId = url.searchParams.get("slide") || "";
    if (!args.html_dir) { res.writeHead(404); res.end("--html-dir not configured"); return; }
    const htmlPath = join(args.html_dir, `${slideId}.html`);
    if (!existsSync(htmlPath) || !htmlPath.endsWith(".html")) {
      res.writeHead(404); res.end(`no html for ${slideId}`); return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(htmlPath));
    return;
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
  console.log(`  html-dir:   ${args.html_dir ?? "(not set — HTML source links hidden)"}`);
  const manifest = readManifest(args.thumbnails);
  console.log(`  manifest:   ${manifest.presentation_id
    ? `presentation ${manifest.presentation_id} (${manifest.slide_object_ids?.length ?? 0} slide-oids)`
    : "not yet written (upload step hasn't run?)"}`);
});
