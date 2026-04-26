#!/usr/bin/env npx tsx
/**
 * filtered-rating-server.ts — SxS rating UI for a single bug_solving task.
 *
 * Shows, per slide: original HTML screenshot (Chrome) vs the task's freshly
 * uploaded Slides render, plus the full review toolset the main
 * rating-server offers: Good/Bad/Skip buttons, a comment box, an
 * annotation canvas over the rendered image, a client-side diff overlay,
 * and task-specific "Show analysis" / "Show diff" reveals per slide.
 *
 * Per-slide links to the HTML source and the Google Slides page appear at
 * the top of each card when the relevant inputs are wired:
 *   * HTML source link:  --html-dir + "${slide_id}.html" (or --fixtures alias)
 *   * Google Slides link: read from <thumbnails>/manifest.json, which
 *     upload-and-scrape.ts writes with presentation_id + parallel
 *     slide_object_ids so we can build `…/edit#slide=id.<oid>` deep links.
 *
 * Ratings (status + comment + annotation png) persist to
 * <thumbnails>/../ratings.json so a subsequent bug_solving retry can read
 * them. UI is Preact (esm.sh, no bundler) so reveal + draw state survives
 * re-renders.
 *
 * Usage:
 *   npx tsx filtered-rating-server.ts --port 4701 \
 *       --slides slide_04,slide_11 \
 *       --analysis /workspace/scratch/analysis.md \
 *       --diffs /workspace/scratch/diffs \
 *       --thumbnails /workspace/scratch/thumbnails \
 *       [--originals /tmp/sxs-complex/originals] \
 *       [--html-dir renderer/html2slides/e2e/fixtures] \
 *       [--ratings-file /workspace/scratch/ratings.json] \
 *       [--task-title "bug_solving: clipping"]
 */
import { createServer } from "http";
import {
  readFileSync, writeFileSync, existsSync, statSync, mkdirSync,
} from "fs";
import { resolve, join, dirname } from "path";

interface Args {
  port: number;
  slides: string[];
  analysis: string;
  diffs: string;
  thumbnails: string;
  originals: string;
  html_dir: string | null;
  ratings_file: string | null;
  task_title: string;
  baseline_dir: string | null;        // pre-fix Slides-rendered thumbs (shared across wave)
}

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {
    originals: "/tmp/sxs-complex/originals",
    html_dir: null,
    ratings_file: null,
    task_title: "bug_solving",
    baseline_dir: null,
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
    else if (v === "--ratings-file") a.ratings_file = resolve(argv[++i]);
    else if (v === "--task-title") a.task_title = argv[++i];
    else if (v === "--baseline-dir") a.baseline_dir = resolve(argv[++i]);
  }
  if (!a.port || !a.slides || !a.analysis || !a.diffs || !a.thumbnails) {
    throw new Error(
      "usage: --port N --slides csv --analysis md --diffs dir --thumbnails dir " +
      "[--originals dir] [--html-dir dir] [--ratings-file file] [--task-title str] " +
      "[--baseline-dir dir]",
    );
  }
  // Default ratings file sits beside the scratch dir so a future retry can
  // read the user's verdicts alongside analysis.md.
  if (!a.ratings_file) {
    a.ratings_file = resolve(dirname(a.thumbnails!), "ratings.json");
  }
  // Required fields are guaranteed populated by the validation above; the
  // optional/defaulted ones are also populated. We materialize the final
  // Args by spreading the partial — TypeScript narrows the assertion via
  // the explicit return-type annotation.
  return {
    port: a.port!,
    slides: a.slides!,
    analysis: a.analysis!,
    diffs: a.diffs!,
    thumbnails: a.thumbnails!,
    originals: a.originals!,
    html_dir: a.html_dir!,
    ratings_file: a.ratings_file,
    task_title: a.task_title!,
    baseline_dir: a.baseline_dir!,
  };
}

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

function readManifest(thumbnailsDir: string): Manifest {
  const p = join(thumbnailsDir, "manifest.json");
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")) as Manifest; } catch { return {}; }
}

type Rating = { status: "good" | "bad"; comment?: string; ratedAt: string; annotation?: string };
function readRatings(path: string): Record<string, Rating> {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return {}; }
}
function writeRatings(path: string, ratings: Record<string, Rating>) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ratings, null, 2));
}

const args = parseArgs(process.argv.slice(2));

interface RenderedRegion { x: number; y: number; w: number; h: number; kind: string; }

interface SlidePayload {
  id: string;
  original: string | null;
  baseline: string | null;           // pre-fix Slides render (main's output); null = toggle disabled
  rendered: string | null;
  htmlPath: string | null;
  slidesUrl: string | null;
  status: "pending" | "good" | "bad";
  comment: string | null;
  annotationPng: string | null;
  renderedRegions: RenderedRegion[] | null;
  // Original SxS bug context (the user comment + annotation that drove this
  // task into the wave). Surfaced as a sticky banner on the card so the
  // reviewer can rate the fix without context-hunting in ratings.json.
  originalUserComment: string | null;
  originalAnnotationPng: string | null;
}

interface BugContext {
  cluster_description: string;
  slides: Record<string, { user_comment: string; annotation_png: string | null }>;
}

function readBugContext(scratchDir: string): BugContext | null {
  const p = join(scratchDir, "bug-context.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")) as BugContext; } catch { return null; }
}

function readRenderedRegions(thumbnailsDir: string): Record<string, RenderedRegion[]> {
  const p = join(thumbnailsDir, "rendered-regions.json");
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

function buildPayload(): {
  task_title: string;
  cluster_description: string | null;
  slides: SlidePayload[];
} {
  const manifest = readManifest(args.thumbnails);
  const slideToOid = new Map<string, string>();
  if (manifest.slides && manifest.slide_object_ids) {
    for (let i = 0; i < manifest.slides.length; i++) {
      const oid = manifest.slide_object_ids[i];
      if (oid) slideToOid.set(manifest.slides[i], oid);
    }
  }
  const ratings = readRatings(args.ratings_file!);
  const regions = readRenderedRegions(args.thumbnails);
  // bug-context.json sits next to ratings.json (the scratch dir). It carries
  // the cluster hypothesis + the original SxS user comments that motivated
  // the task — surfaced in the UI so the reviewer doesn't have to dig.
  const bugCtx = readBugContext(dirname(args.ratings_file!));
  // rendered-regions.json keys are the pptx output index (slide_01, slide_02,
  // ...) from convert-pptx.ts — not the fixture id. In the filtered server
  // each args.slides[i] maps 1:1 to pptx slot i+1.
  const slides = args.slides.map<SlidePayload>((id, i) => {
    const original = join(args.originals, `${id}.png`);
    const rendered = join(args.thumbnails, `${id}.png`);
    const baseline = args.baseline_dir ? join(args.baseline_dir, `${id}.png`) : null;
    const htmlPath = args.html_dir ? join(args.html_dir, `${id}.html`) : null;
    const oid = slideToOid.get(id);
    const slidesUrl = manifest.presentation_id
      ? `https://docs.google.com/presentation/d/${manifest.presentation_id}/edit` +
        (oid ? `#slide=id.${oid}` : "")
      : null;
    const r = ratings[id];
    const annotPath = join(dirname(args.ratings_file!), "annotations", `${id}.png`);
    const regionsKey = `slide_${String(i + 1).padStart(2, "0")}`;
    const regionsForSlide = regions[regionsKey] ?? regions[id];
    const bug = bugCtx?.slides[id];
    return {
      id,
      original: existsSync(original) ? original : null,
      baseline: baseline && existsSync(baseline) ? baseline : null,
      rendered: existsSync(rendered) ? rendered : null,
      htmlPath: htmlPath && existsSync(htmlPath) ? htmlPath : null,
      slidesUrl,
      status: r?.status ?? "pending",
      comment: r?.comment || null,
      annotationPng: r?.annotation && existsSync(r.annotation) ? r.annotation
        : existsSync(annotPath) ? annotPath : null,
      renderedRegions: regionsForSlide ?? [],
      originalUserComment: bug?.user_comment || null,
      originalAnnotationPng: bug?.annotation_png && existsSync(bug.annotation_png)
        ? bug.annotation_png : null,
    };
  });
  return {
    task_title: args.task_title,
    cluster_description: bugCtx?.cluster_description ?? null,
    slides,
  };
}

const CLIENT_SCRIPT = `
import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect, useRef, useCallback } from "https://esm.sh/preact@10/hooks";

// Reveal that lazily fetches + caches its body on first open. Component-
// local state survives parent re-renders because Preact reconciles by
// position + type.
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

// Drawing canvas: pointer capture, stroke history with Ctrl+Z undo, and
// annotation bootstrap from a saved PNG. Imperative handles returned via
// ref so the parent card can call toDataURL() when saving a Bad rating.
function useDrawingCanvas(canvasRef, imgRef, savedAnnotationUrl, drawMode, colorRef, sizeRef) {
  const historyRef = useRef([]);
  const strokesRef = useRef(false);
  const drawModeRef = useRef(drawMode);
  drawModeRef.current = drawMode;

  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    canvas.style.pointerEvents = drawModeRef.current ? "auto" : "none";
    strokesRef.current = false;
    historyRef.current = [];
    const init = () => {
      canvas.width = img.naturalWidth || img.clientWidth;
      canvas.height = img.naturalHeight || img.clientHeight;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (savedAnnotationUrl) {
        const saved = new Image();
        saved.onload = () => {
          ctx.drawImage(saved, 0, 0, canvas.width, canvas.height);
          strokesRef.current = true;
        };
        saved.src = savedAnnotationUrl;
      }
    };
    if (img.complete && img.naturalWidth) init();
    else img.addEventListener("load", init, { once: true });

    let drawing = false;
    const getPos = (e) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (canvas.width / r.width),
        y: (e.clientY - r.top) * (canvas.height / r.height),
      };
    };
    const onDown = (e) => {
      if (!drawModeRef.current) return;
      drawing = true;
      canvas.setPointerCapture(e.pointerId);
      const ctx = canvas.getContext("2d");
      historyRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (historyRef.current.length > 50) historyRef.current.shift();
      ctx.strokeStyle = (colorRef.current && colorRef.current.value) || "#e94560";
      const baseW = parseFloat((sizeRef.current && sizeRef.current.value) || "6");
      ctx.lineWidth = baseW * (canvas.width / canvas.getBoundingClientRect().width);
      const p = getPos(e);
      ctx.beginPath(); ctx.moveTo(p.x, p.y);
    };
    const onMove = (e) => {
      if (!drawing) return;
      const ctx = canvas.getContext("2d");
      const p = getPos(e);
      ctx.lineTo(p.x, p.y); ctx.stroke();
      strokesRef.current = true;
    };
    const onUp = () => { drawing = false; };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, [savedAnnotationUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) canvas.style.pointerEvents = drawMode ? "auto" : "none";
  }, [drawMode]);

  return {
    hasStrokes: () => strokesRef.current,
    toDataURL: () => {
      const c = canvasRef.current;
      return c ? c.toDataURL("image/png") : null;
    },
    clear: () => {
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext("2d");
      ctx.clearRect(0, 0, c.width, c.height);
      strokesRef.current = false;
      historyRef.current = [];
    },
    undo: () => {
      const c = canvasRef.current;
      if (!c || historyRef.current.length === 0) return;
      const ctx = c.getContext("2d");
      const prev = historyRef.current.pop();
      ctx.clearRect(0, 0, c.width, c.height);
      if (prev) ctx.putImageData(prev, 0, 0);
      strokesRef.current = historyRef.current.length > 0 || !!prev;
    },
  };
}

// Per-pixel diff between two <img>s, painted as red overlay on the original
// panel. Both images downscaled to a shared 1600x900 grid before compare so
// different source resolutions line up 1:1.
function useClientSideDiff(origImgRef, slidesImgRef, diffCanvasRef, enabled, slideId) {
  useEffect(() => {
    if (!enabled) return;
    const o = origImgRef.current, s = slidesImgRef.current, d = diffCanvasRef.current;
    if (!o || !s || !d) return;
    const wait = (img) => new Promise((r) => {
      if (img.complete && img.naturalWidth) r();
      else img.addEventListener("load", () => r(), { once: true });
    });
    let cancelled = false;
    Promise.all([wait(o), wait(s)]).then(() => {
      if (cancelled) return;
      const W = 1600, H = 900, TH = 10;
      const ac = document.createElement("canvas"); ac.width = W; ac.height = H;
      ac.getContext("2d").drawImage(o, 0, 0, W, H);
      const aData = ac.getContext("2d").getImageData(0, 0, W, H).data;
      const bc = document.createElement("canvas"); bc.width = W; bc.height = H;
      bc.getContext("2d").drawImage(s, 0, 0, W, H);
      const bData = bc.getContext("2d").getImageData(0, 0, W, H).data;
      d.width = W; d.height = H;
      const octx = d.getContext("2d");
      const diff = octx.createImageData(W, H), dData = diff.data;
      for (let i = 0; i < aData.length; i += 4) {
        const dr = Math.abs(aData[i] - bData[i]);
        const dg = Math.abs(aData[i + 1] - bData[i + 1]);
        const db = Math.abs(aData[i + 2] - bData[i + 2]);
        if (dr + dg + db > TH) {
          dData[i] = 255; dData[i + 3] = 200;
        }
      }
      octx.putImageData(diff, 0, 0);
    });
    return () => { cancelled = true; };
  }, [enabled, slideId]);
}

function SlideCard(props) {
  const s = props.slide;
  const { onRated } = props;
  const [comment, setComment] = useState(s.comment || "");
  const [showDiff, setShowDiff] = useState(false);
  const [showRendered, setShowRendered] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [loupe, setLoupe] = useState(false);
  const [loupeZoom, setLoupeZoom] = useState(3);
  const [localStatus, setLocalStatus] = useState(s.status);
  const [saving, setSaving] = useState(false);
  // Left-panel comparison source. "original" = Chrome HTML render (ground truth).
  // "baseline" = main's pre-fix Slides render (regression check).
  const [leftSource, setLeftSource] = useState(s.baseline ? "baseline" : "original");

  const origRef = useRef(null);
  const slidesRef = useRef(null);
  const drawRef = useRef(null);
  const diffRef = useRef(null);
  const renderedOverlayRef = useRef(null);
  const origOverlayRef = useRef(null);
  const colorRef = useRef(null);
  const sizeRef = useRef(null);

  const savedAnnot = s.annotationPng
    ? "/img?path=" + encodeURIComponent(s.annotationPng) + "&t=" + Date.now()
    : null;
  const handle = useDrawingCanvas(drawRef, slidesRef, savedAnnot, drawMode, colorRef, sizeRef);
  useClientSideDiff(origRef, slidesRef, diffRef, showDiff, s.id + ":" + leftSource);

  // Render-regions highlight (Slides pane): paints rgb(128,128,128) on each
  // region rect with plus-lighter blend so the image below gets +128/channel —
  // makes rasterized regions literally pop out vs native primitives.
  useEffect(() => {
    const canvas = renderedOverlayRef.current;
    const img = slidesRef.current;
    if (!canvas || !img) return;
    const paint = () => {
      canvas.width = img.naturalWidth || img.clientWidth;
      canvas.height = img.naturalHeight || img.clientHeight;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!showRendered || !s.renderedRegions) return;
      ctx.fillStyle = "rgb(128,128,128)";
      for (const r of s.renderedRegions) {
        ctx.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
      }
    };
    if (img.complete && img.naturalWidth) paint();
    else img.addEventListener("load", paint, { once: true });
  }, [showRendered, s.renderedRegions, s.rendered]);

  // Magnifier loupe. Tracks the cursor on both panels; when hovering, a
  // 200px floating lens shows the pixels under the cursor scaled N×, pulled
  // from the *natural-resolution* source so zooming actually reveals
  // sub-pixel detail instead of the displayed-size fuzz. Uses backgroundImage
  // so we don't need to re-blit on every mousemove.
  useEffect(() => {
    if (!loupe) return;
    const size = 240;
    const bind = (panelEl, imgEl, srcUrl) => {
      if (!panelEl || !imgEl) return () => {};
      const onMove = (e) => {
        const lens = document.getElementById("loupe");
        if (!lens) return;
        const r = imgEl.getBoundingClientRect();
        const relX = e.clientX - r.left;
        const relY = e.clientY - r.top;
        if (relX < 0 || relY < 0 || relX > r.width || relY > r.height) {
          lens.style.display = "none";
          return;
        }
        const nx = (relX / r.width) * imgEl.naturalWidth;
        const ny = (relY / r.height) * imgEl.naturalHeight;
        lens.style.display = "block";
        lens.style.left = (e.clientX - size / 2) + "px";
        lens.style.top = (e.clientY - size / 2) + "px";
        lens.style.width = size + "px";
        lens.style.height = size + "px";
        lens.style.backgroundImage = "url(" + srcUrl + ")";
        lens.style.backgroundSize = (imgEl.naturalWidth * loupeZoom) + "px " + (imgEl.naturalHeight * loupeZoom) + "px";
        lens.style.backgroundPosition = \`-\${nx * loupeZoom - size / 2}px -\${ny * loupeZoom - size / 2}px\`;
      };
      const onLeave = () => { const l = document.getElementById("loupe"); if (l) l.style.display = "none"; };
      panelEl.addEventListener("mousemove", onMove);
      panelEl.addEventListener("mouseleave", onLeave);
      return () => {
        panelEl.removeEventListener("mousemove", onMove);
        panelEl.removeEventListener("mouseleave", onLeave);
      };
    };
    const cleaners = [
      bind(origOverlayRef.current, origRef.current, s.original ? "/img?path=" + encodeURIComponent(s.original) : ""),
      bind(renderedOverlayRef.current && renderedOverlayRef.current.parentElement, slidesRef.current, s.rendered ? "/img?path=" + encodeURIComponent(s.rendered) : ""),
    ];
    return () => { cleaners.forEach(c => c()); };
  }, [loupe, loupeZoom, s.id, s.original, s.rendered]);

  const rate = useCallback(async (status) => {
    setSaving(true);
    try {
      const annotation = handle.hasStrokes() ? handle.toDataURL() : undefined;
      const resp = await fetch("/api/rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: s.id, status,
          comment: (comment || "").trim() || undefined,
          annotation,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setLocalStatus(status);
      if (onRated) onRated();
    } catch (e) {
      alert("save failed: " + (e && e.message ? e.message : e));
    } finally { setSaving(false); }
  }, [handle, comment, s.id, onRated]);

  return h("div", { class: "slide-card", id: s.id },
    h("div", { class: "card-head" },
      h("h2", null, s.id, " ",
        h("span", { class: "status-badge status-" + localStatus }, localStatus),
      ),
      h("div", { class: "links" },
        s.htmlPath && h("a", { href: "/html?slide=" + encodeURIComponent(s.id), target: "_blank" }, "View HTML Source"),
        s.slidesUrl && h("a", { href: s.slidesUrl, target: "_blank" }, "Open in Google Slides"),
      ),
    ),
    s.originalUserComment && h("div", { class: "original-bug" },
      h("span", { class: "original-bug-label" }, "Original bug:"),
      " ",
      h("span", { class: "original-bug-text" }, s.originalUserComment),
      s.originalAnnotationPng && h("a", {
        href: "/img?path=" + encodeURIComponent(s.originalAnnotationPng),
        target: "_blank",
        class: "original-bug-annot",
      }, "[annotation]"),
    ),
    h("div", { class: "pair" },
      h("div", { class: "panel original", ref: origOverlayRef },
        h("span", { class: "label" },
          leftSource === "baseline" ? "baseline (main, pre-fix)" : "original (Chrome)",
        ),
        (() => {
          const leftPath = leftSource === "baseline" ? s.baseline : s.original;
          return leftPath
            ? h("img", {
                ref: origRef,
                key: leftSource,
                src: "/img?path=" + encodeURIComponent(leftPath),
              })
            : h("div", { class: "empty-panel" },
                (leftSource === "baseline" ? "baseline" : "original") + " not found for " + s.id);
        })(),
        showDiff && h("canvas", { class: "diff-overlay", ref: diffRef }),
      ),
      h("div", { class: "panel rendered" },
        h("span", { class: "label" }, "rendered (Slides, fixed)"),
        s.rendered
          ? h("img", { ref: slidesRef, src: "/img?path=" + encodeURIComponent(s.rendered) })
          : h("div", { class: "empty-panel" }, "rendered not found for " + s.id),
        h("canvas", { class: "rendered-overlay", ref: renderedOverlayRef }),
        h("canvas", { class: "draw-canvas", ref: drawRef }),
      ),
    ),
    s.renderedRegions && s.renderedRegions.length > 0 &&
      h("div", { class: "rendered-banner" },
        "⚠ RENDERED CONTENT — " + s.renderedRegions.length + " region(s) emitted as rasterized image instead of native Slides primitives.",
      ),
    h("div", { class: "draw-toolbar" },
      h("label", {
        title: "Left panel: Chrome render of the HTML fixture (ground truth) vs. main's pre-fix Slides render (regression check).",
        style: s.baseline ? "" : "opacity:0.5",
      },
        h("input", {
          type: "checkbox",
          checked: leftSource === "baseline",
          disabled: !s.baseline,
          onChange: (e) => setLeftSource(e.target.checked ? "baseline" : "original"),
        }),
        " Compare vs baseline (main)",
      ),
      h("label", null,
        h("input", { type: "checkbox", checked: showDiff, onChange: (e) => setShowDiff(e.target.checked) }),
        " Show diff overlay",
      ),
      h("label", {
        title: "Adds 128 to each RGB channel of rasterized regions via plus-lighter blend — makes non-native regions visually obvious",
        style: (s.renderedRegions && s.renderedRegions.length > 0) ? "" : "opacity:0.5",
      },
        h("input", {
          type: "checkbox",
          checked: showRendered,
          disabled: !(s.renderedRegions && s.renderedRegions.length > 0),
          onChange: (e) => setShowRendered(e.target.checked),
        }),
        " Highlight rendered regions (" + ((s.renderedRegions && s.renderedRegions.length) || 0) + ")",
      ),
      h("label", null,
        h("input", { type: "checkbox", checked: loupe, onChange: (e) => setLoupe(e.target.checked) }),
        " 🔍 Magnifier",
      ),
      loupe && h("label", null,
        h("input", {
          type: "range", min: "2", max: "8", value: loupeZoom,
          onInput: (e) => setLoupeZoom(+e.target.value),
        }), " ", loupeZoom + "×",
      ),
      h("span", { style: "width:16px" }),
      h("button", {
        class: "mini-btn" + (drawMode ? " active" : ""),
        onClick: () => setDrawMode(!drawMode),
      }, "Draw"),
      h("input", { type: "color", ref: colorRef, defaultValue: "#e94560" }),
      h("label", null,
        h("input", { type: "range", ref: sizeRef, min: "2", max: "20", defaultValue: "6" }),
        " px",
      ),
      h("button", { class: "mini-btn", onClick: () => handle.undo() }, "Undo"),
      h("button", { class: "mini-btn", onClick: () => handle.clear() }, "Clear"),
    ),
    h("textarea", {
      class: "comment",
      placeholder: "What's wrong? (optional — saved with Bad ratings)",
      value: comment,
      onInput: (e) => setComment(e.target.value),
      rows: 2,
    }),
    h("div", { class: "actions" },
      h("button", {
        class: "btn btn-good",
        disabled: saving,
        onClick: () => rate("good"),
      }, "Good ✓"),
      h("button", {
        class: "btn btn-bad",
        disabled: saving,
        onClick: () => rate("bad"),
      }, "Bad ✗"),
    ),
    h("div", { class: "reveals" },
      h(Reveal, { kind: "analysis", slideId: s.id, label: "analysis", accent: "orange" }),
      h(Reveal, { kind: "diff", slideId: s.id, label: "diff analysis", accent: "yellow" }),
    ),
  );
}

function App() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const refresh = useCallback(() => {
    fetch("/api/slides")
      .then(r => r.ok ? r.json() : r.text().then(t => { throw new Error(t); }))
      .then(setData)
      .catch(e => setErr(String(e && e.message ? e.message : e)));
  }, []);
  useEffect(() => { refresh(); }, []);
  if (err) return h("div", { class: "header" }, h("h1", null, "error: " + err));
  if (!data) return h("div", { class: "header" }, h("h1", null, "loading…"));
  const good = data.slides.filter(s => s.status === "good").length;
  const bad = data.slides.filter(s => s.status === "bad").length;
  const pending = data.slides.filter(s => s.status === "pending").length;
  return h("div", null,
    h("div", { class: "header" },
      h("h1", null, data.task_title),
      h("div", { class: "subtitle" },
        data.slides.length + " slide(s) · ",
        h("span", { style: "color:#27ae60" }, good + " good"), " · ",
        h("span", { style: "color:#c0392b" }, bad + " bad"), " · ",
        h("span", { style: "color:#888" }, pending + " pending"),
      ),
      data.cluster_description && h("div", { class: "cluster-banner" },
        h("span", { class: "cluster-label" }, "Cluster hypothesis"), " ",
        data.cluster_description,
      ),
    ),
    data.slides.map(s => h(SlideCard, { key: s.id, slide: s, onRated: refresh })),
    // Single floating loupe shared across cards — per-card effect toggles
    // display + repositions it via ref lookup on #loupe.
    h("div", {
      id: "loupe",
      style: "display:none; position:fixed; z-index:9999; border:2px solid #4a90d9; border-radius:50%; box-shadow:0 4px 16px rgba(0,0,0,0.6); pointer-events:none; background-repeat:no-repeat; background-color:#0f1a30;",
    }),
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
  .cluster-banner { margin-top: 10px; padding: 8px 12px; background: #0f1a30; border-left: 3px solid #4a90d9; border-radius: 0 4px 4px 0; font-size: 12px; color: #c0d6e8; line-height: 1.5; }
  .cluster-label { font-weight: 600; color: #4a90d9; text-transform: uppercase; letter-spacing: 0.5px; font-size: 11px; }
  .original-bug { margin: 4px 0 12px; padding: 8px 12px; background: #2e1a1a; border-left: 3px solid #c0392b; border-radius: 0 4px 4px 0; font-size: 13px; line-height: 1.5; }
  .original-bug-label { font-weight: 600; color: #e8a09a; text-transform: uppercase; letter-spacing: 0.5px; font-size: 11px; }
  .original-bug-text { color: #e8d8d6; }
  .original-bug-annot { margin-left: 8px; color: #4a90d9; font-size: 11px; text-decoration: none; }
  .original-bug-annot:hover { text-decoration: underline; }
  .slide-card { padding: 16px 24px; border-bottom: 1px solid #2a2a4e; }
  .card-head { display: flex; align-items: center; gap: 16px; margin-bottom: 8px; }
  .card-head h2 { font-size: 16px; color: #4a90d9; display:flex; align-items:center; gap:10px; }
  .status-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
  .status-good { background: #27ae60; color: white; }
  .status-bad { background: #c0392b; color: white; }
  .status-pending { background: #555; color: #aaa; }
  .links { display: flex; gap: 12px; font-size: 13px; }
  .links a { color: #4a90d9; text-decoration: none; padding: 2px 8px; border-radius: 4px; background: #0f1a30; }
  .links a:hover { background: #4a90d9; color: white; }
  .pair { display: flex; gap: 4px; align-items: flex-start; position: relative; }
  .panel { width: 49%; position: relative; }
  .panel img { width: 100%; border: 2px solid #333; border-radius: 4px; display: block; background: #0f1a30; }
  .panel.original img { border-color: #4a90d9; }
  .panel.rendered img { border-color: #27ae60; }
  .panel .label { position: absolute; top: 4px; left: 4px; background: rgba(0,0,0,0.7); color: #fff; font-size: 11px; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.5px; z-index: 2; }
  .panel canvas.draw-canvas { position: absolute; inset: 2px; width: calc(100% - 4px); height: calc(100% - 4px); cursor: crosshair; touch-action: none; border-radius: 4px; }
  .panel canvas.diff-overlay { position: absolute; inset: 2px; width: calc(100% - 4px); height: calc(100% - 4px); border-radius: 4px; pointer-events: none; }
  .panel canvas.rendered-overlay { position: absolute; inset: 2px; width: calc(100% - 4px); height: calc(100% - 4px); border-radius: 4px; pointer-events: none; mix-blend-mode: plus-lighter; }
  .rendered-banner { margin-top: 8px; padding: 8px 12px; background: #2a1f0a; border-left: 4px solid #f1c40f; color: #ffe9a8; border-radius: 0 6px 6px 0; font-size: 13px; }
  .empty-panel { width: 100%; height: 200px; border: 2px dashed #555; border-radius: 4px; display: flex; align-items: center; justify-content: center; color: #666; font-size: 13px; padding: 0 16px; text-align: center; }
  .draw-toolbar { display: flex; gap: 8px; padding: 10px 0 4px; align-items: center; font-size: 12px; color: #aaa; flex-wrap: wrap; }
  .draw-toolbar label { display: flex; gap: 6px; align-items: center; cursor: pointer; }
  .mini-btn { background: #2a2a4e; color: #e0e0e0; border: 1px solid #444; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; font-family: inherit; }
  .mini-btn:hover { background: #3a3a5e; }
  .mini-btn.active { background: #e94560; border-color: #e94560; color: white; }
  .draw-toolbar input[type=color] { width: 28px; height: 24px; border: 1px solid #444; border-radius: 4px; background: transparent; cursor: pointer; }
  .comment { width: 100%; padding: 10px 12px; margin-top: 8px; border: 1px solid #444; border-radius: 6px; background: #2a2a4e; color: #e0e0e0; font-family: inherit; font-size: 14px; resize: vertical; min-height: 40px; }
  .comment:focus { outline: none; border-color: #4a90d9; }
  .comment::placeholder { color: #666; }
  .actions { display: flex; gap: 12px; padding: 10px 0 0; }
  .btn { padding: 10px 28px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; transition: 0.2s; font-family: inherit; }
  .btn[disabled] { opacity: 0.5; cursor: wait; }
  .btn-good { background: #27ae60; color: white; }
  .btn-good:hover { background: #2ecc71; }
  .btn-bad { background: #c0392b; color: white; }
  .btn-bad:hover { background: #e74c3c; }
  .reveals { display: flex; gap: 8px; padding: 10px 0 0; flex-wrap: wrap; }
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

  if (url.pathname === "/api/rate" && req.method === "POST") {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const { id, status, comment, annotation } = JSON.parse(body);
        if (!id || (status !== "good" && status !== "bad")) {
          res.writeHead(400); res.end("bad request"); return;
        }
        const ratings = readRatings(args.ratings_file!);
        const entry: Rating = { status, ratedAt: new Date().toISOString() };
        if (comment) entry.comment = String(comment);
        if (annotation) {
          const annotDir = join(dirname(args.ratings_file!), "annotations");
          mkdirSync(annotDir, { recursive: true });
          const annotPath = join(annotDir, `${id}.png`);
          const b64 = String(annotation).replace(/^data:image\/png;base64,/, "");
          writeFileSync(annotPath, Buffer.from(b64, "base64"));
          entry.annotation = annotPath;
        }
        ratings[id] = entry;
        writeRatings(args.ratings_file!, ratings);
        console.log(`RATING: ${id} → ${status}${comment ? ` | ${comment}` : ""}${annotation ? " [+annotation]" : ""}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(500); res.end(msg);
      }
    });
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
    // Lead with the worker's analysis for this slide so the reviewer can
    // read the reasoning, then the XML diff, then the structural summary.
    if (existsSync(args.analysis)) {
      const md = readFileSync(args.analysis, "utf-8");
      const section = sectionFor(md, slideId);
      body += `=== analysis (${slideId}) ===\n`;
      body += (section ?? `(no section for ${slideId} in ${args.analysis})`) + "\n\n";
    }
    body += `=== xml diff (${slideId}.diff) ===\n`;
    if (existsSync(diffPath)) body += readFileSync(diffPath, "utf-8");
    else body += `(no diff file for ${slideId} at ${diffPath})`;
    if (existsSync(summaryPath)) {
      body += "\n\n=== structural summary (" + slideId + ".summary.json) ===\n"
        + readFileSync(summaryPath, "utf-8");
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
  console.log(`  html-dir:   ${args.html_dir ?? "(not set)"}`);
  console.log(`  ratings:    ${args.ratings_file}`);
  const manifest = readManifest(args.thumbnails);
  console.log(`  manifest:   ${manifest.presentation_id
    ? `presentation ${manifest.presentation_id} (${manifest.slide_object_ids?.length ?? 0} slide-oids)`
    : "not written yet"}`);
});
