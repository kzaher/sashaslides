/**
 * filtered-rating-server-lib.ts — library form of filtered-rating-server.
 *
 * Exposes startFilteredRatingServer(args) so callers can boot the same
 * SxS rating UI in-process. The thin CLI in filtered-rating-server.ts
 * still exists for backwards compatibility (nohup npx tsx ...) and just
 * forwards parsed argv into this lib.
 *
 * NO top-level execution: importing this module must not start a listener,
 * so other tooling can pull in the helpers / types without side effects.
 */
import { createServer, Server } from "http";
import {
  readFileSync, writeFileSync, existsSync, statSync, mkdirSync, readdirSync, unlinkSync,
} from "fs";
import { join, dirname } from "path";
import { PNG } from "pngjs";

/**
 * Compute the bounding box of opaque pixels in a PNG. Returns null if the
 * annotation is fully transparent (no strokes drawn). Used to find what
 * the reviewer marked so we can generate a focused zoom-crop.
 *
 * `padding` (in input pixels) is added on all sides; the bbox is clamped
 * to the image bounds. `alphaThreshold` (0-255) ignores fully-transparent
 * pixels but keeps anti-aliased edges.
 */
function annotationBbox(
  annotationPngBytes: Buffer,
  padding = 20,
  alphaThreshold = 8,
): { x: number; y: number; w: number; h: number; canvasW: number; canvasH: number } | null {
  const png = PNG.sync.read(annotationPngBytes);
  const W = png.width, H = png.height;
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = (y * W + x) * 4 + 3; // alpha channel
      if (png.data[idx] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY < 0) return null;
  return {
    x: Math.max(0, minX - padding),
    y: Math.max(0, minY - padding),
    w: Math.min(W, maxX + padding) - Math.max(0, minX - padding),
    h: Math.min(H, maxY + padding) - Math.max(0, minY - padding),
    canvasW: W,
    canvasH: H,
  };
}

/**
 * Crop `srcPngBytes` to the bbox (expressed in annotation-canvas
 * coordinates) and scale UP using nearest-neighbour so the output's
 * longest edge approaches `targetLongestEdge`. The zoom is computed
 * dynamically from the bbox size: small marks (e.g. circling a 1-pixel
 * border line) get a high zoom, large marks (e.g. circling a whole
 * row) get a low zoom — both end up roughly the same size on screen.
 * Zoom is clamped to [`minZoom`, `maxZoom`] (1× to 10× by default)
 * and forced to an integer so nearest-neighbour stays crisp.
 *
 * Returns the encoded PNG bytes.
 */
function zoomCropPng(
  srcPngBytes: Buffer,
  bbox: { x: number; y: number; w: number; h: number; canvasW: number; canvasH: number },
  targetLongestEdge = 1200,
  minZoom = 1,
  maxZoom = 10,
): Buffer {
  const src = PNG.sync.read(srcPngBytes);
  // The annotation canvas may be at a different resolution than the
  // source thumbnail (e.g. annotation = 1280×720, thumb = 1600×900).
  // Scale the bbox into source coordinates.
  const sx = src.width / bbox.canvasW;
  const sy = src.height / bbox.canvasH;
  const cropX = Math.max(0, Math.round(bbox.x * sx));
  const cropY = Math.max(0, Math.round(bbox.y * sy));
  const cropW = Math.max(1, Math.min(src.width  - cropX, Math.round(bbox.w * sx)));
  const cropH = Math.max(1, Math.min(src.height - cropY, Math.round(bbox.h * sy)));
  const longest = Math.max(cropW, cropH);
  const zoomRaw = Math.floor(targetLongestEdge / longest);
  const zoom = Math.max(minZoom, Math.min(maxZoom, zoomRaw || 1));
  const outW = cropW * zoom, outH = cropH * zoom;
  const out = new PNG({ width: outW, height: outH });
  for (let oy = 0; oy < outH; oy++) {
    const srcY = cropY + Math.floor(oy / zoom);
    for (let ox = 0; ox < outW; ox++) {
      const srcX = cropX + Math.floor(ox / zoom);
      const si = (srcY * src.width + srcX) * 4;
      const oi = (oy   * outW       + ox  ) * 4;
      out.data[oi    ] = src.data[si    ];
      out.data[oi + 1] = src.data[si + 1];
      out.data[oi + 2] = src.data[si + 2];
      out.data[oi + 3] = src.data[si + 3];
    }
  }
  return PNG.sync.write(out);
}

/**
 * Read an existing zoom-crops directory and list the crop PNGs for a
 * given slide. Multiple crops per slide are supported (named
 * `<slide_id>.png`, `<slide_id>-2.png`, …). Used by buildPayload to
 * surface what the reviewer flagged.
 */
function listZoomCrops(zoomDir: string, slideId: string): string[] {
  if (!existsSync(zoomDir)) return [];
  const entries = readdirSync(zoomDir);
  const out: string[] = [];
  for (const f of entries) {
    if (f === `${slideId}.png` || f.startsWith(`${slideId}-`)) {
      out.push(join(zoomDir, f));
    }
  }
  return out.sort();
}

export interface Args {
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
  bug_context: string | null;         // explicit path to bug-context.json
}

export function sectionFor(markdown: string, slideId: string): string | null {
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

export function htmlEscape(s: string): string {
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

export function readManifest(thumbnailsDir: string): Manifest {
  const p = join(thumbnailsDir, "manifest.json");
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")) as Manifest; } catch { return {}; }
}

type Rating = { status: "good" | "bad"; comment?: string; ratedAt: string; annotation?: string };
export function readRatings(path: string): Record<string, Rating> {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return {}; }
}
export function writeRatings(path: string, ratings: Record<string, Rating>) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ratings, null, 2));
}

export interface FilteredRatingServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startFilteredRatingServer(args: Args): Promise<FilteredRatingServerHandle> {
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
    // 3× zoom-ins of regions the reviewer marked (one per side of the
    // annotation: rendered + original). Generated server-side after each
    // Bad rating with strokes; surfaced as a strip under the SxS so the
    // reviewer can sanity-check what they flagged, AND so the worker's
    // visual-verification prompt downstream gets the same focused pixels
    // (no more "vision missed a 1-px line" verdicts).
    zoomCrops: string[];
  }

  interface BugContext {
    cluster_description: string;
    slides: Record<string, { user_comment: string; annotation_png: string | null }>;
  }

  /**
   * Resolve bug-context.json. Preferred: caller passes --bug-context with
   * an absolute path to the file. Fallback: walk up from scratch dir up to
   * 3 levels looking for bug-context.json (covers the case where ratings
   * live in <scratch>/after/ratings.json but bug-context.json is in
   * <scratch>/bug-context.json).
   */
  function readBugContext(explicitPath: string | null, scratchDir: string): BugContext | null {
    const candidates = explicitPath ? [explicitPath] : [];
    let cur = scratchDir;
    for (let i = 0; i < 4; i++) {
      candidates.push(join(cur, "bug-context.json"));
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try { return JSON.parse(readFileSync(p, "utf-8")) as BugContext; } catch { /* try next */ }
    }
    return null;
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
    const bugCtx = readBugContext(args.bug_context, dirname(args.ratings_file!));
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
      const zoomDir = join(dirname(args.ratings_file!), "zoom-crops");
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
        zoomCrops: listZoomCrops(zoomDir, id),
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

// Drawing canvas: tracks each annotation as a typed shape object so
// the server can crop per-annotation (pencil shapes get padding from
// the settings input; rectangle shapes get NO padding — the rect IS
// the bbox). The visual canvas is repainted from the shape list, so
// undo/clear can be trivial array operations.
//
// Shape:
//   { kind: "pencil", points: [{x,y}...], color, width }
//   { kind: "rect",   x, y, w, h, color, width }
function useDrawingCanvas(canvasRef, imgRef, savedAnnotationUrl, drawMode, toolRef, colorRef, sizeRef) {
  const shapesRef = useRef([]);              // committed shapes
  const liveRef = useRef(null);              // shape currently being drawn
  const drawModeRef = useRef(drawMode);
  drawModeRef.current = drawMode;
  const dpiScaleRef = useRef(1);

  const repaint = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const paintShape = (sh) => {
      ctx.strokeStyle = sh.color || "#e94560";
      ctx.lineWidth = sh.width || 4;
      if (sh.kind === "pencil") {
        const pts = sh.points;
        if (pts.length < 1) return;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      } else if (sh.kind === "rect") {
        ctx.strokeRect(sh.x, sh.y, sh.w, sh.h);
      }
    };
    for (const sh of shapesRef.current) paintShape(sh);
    if (liveRef.current) paintShape(liveRef.current);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    canvas.style.pointerEvents = drawModeRef.current ? "auto" : "none";
    shapesRef.current = [];
    liveRef.current = null;
    const init = () => {
      canvas.width = img.naturalWidth || img.clientWidth;
      canvas.height = img.naturalHeight || img.clientHeight;
      dpiScaleRef.current = canvas.width / canvas.getBoundingClientRect().width;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (savedAnnotationUrl) {
        // Saved annotation rehydrates as a single immutable "background"
        // image — the shape list stays empty so new shapes don't replay
        // the saved pixels. We treat the saved annotation as decorative.
        const saved = new Image();
        saved.onload = () => {
          ctx.drawImage(saved, 0, 0, canvas.width, canvas.height);
        };
        saved.src = savedAnnotationUrl;
      }
    };
    if (img.complete && img.naturalWidth) init();
    else img.addEventListener("load", init, { once: true });

    const getPos = (e) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - r.left) * (canvas.width / r.width),
        y: (e.clientY - r.top) * (canvas.height / r.height),
      };
    };
    const onDown = (e) => {
      if (!drawModeRef.current) return;
      canvas.setPointerCapture(e.pointerId);
      const tool = (toolRef.current && toolRef.current.value) || "pencil";
      const color = (colorRef.current && colorRef.current.value) || "#e94560";
      const baseW = parseFloat((sizeRef.current && sizeRef.current.value) || "6");
      const width = baseW * dpiScaleRef.current;
      const p = getPos(e);
      if (tool === "rect") {
        liveRef.current = { kind: "rect", x: p.x, y: p.y, w: 0, h: 0, color, width, _startX: p.x, _startY: p.y };
      } else {
        liveRef.current = { kind: "pencil", points: [p], color, width };
      }
      repaint();
    };
    const onMove = (e) => {
      if (!liveRef.current) return;
      const p = getPos(e);
      const sh = liveRef.current;
      if (sh.kind === "rect") {
        sh.x = Math.min(sh._startX, p.x);
        sh.y = Math.min(sh._startY, p.y);
        sh.w = Math.abs(p.x - sh._startX);
        sh.h = Math.abs(p.y - sh._startY);
      } else {
        sh.points.push(p);
      }
      repaint();
    };
    const onUp = () => {
      if (!liveRef.current) return;
      const sh = liveRef.current;
      liveRef.current = null;
      // Drop empty shapes (a click with no drag on rect, or a tap on pencil)
      const ok =
        sh.kind === "rect" ? (sh.w > 2 && sh.h > 2) :
        sh.kind === "pencil" ? sh.points.length >= 2 :
        false;
      if (ok) {
        if (sh.kind === "rect") { delete sh._startX; delete sh._startY; }
        shapesRef.current.push(sh);
      }
      repaint();
    };
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

  // Serialise each shape into a bbox-in-canvas-coords descriptor the
  // server can use directly for cropping. Rectangle shapes report their
  // exact rect; pencil shapes report the bbox of their stroke points.
  const serializeShapes = () => {
    const out = [];
    for (const sh of shapesRef.current) {
      if (sh.kind === "rect") {
        out.push({ kind: "rect", x: sh.x, y: sh.y, w: sh.w, h: sh.h });
      } else if (sh.kind === "pencil") {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of sh.points) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        if (minX !== Infinity) {
          out.push({ kind: "pencil", x: minX, y: minY, w: maxX - minX, h: maxY - minY });
        }
      }
    }
    return out;
  };

  return {
    hasStrokes: () => shapesRef.current.length > 0,
    toDataURL: () => {
      const c = canvasRef.current;
      return c ? c.toDataURL("image/png") : null;
    },
    shapes: () => serializeShapes(),
    canvasSize: () => {
      const c = canvasRef.current;
      return c ? { w: c.width, h: c.height } : { w: 0, h: 0 };
    },
    clear: () => {
      shapesRef.current = [];
      liveRef.current = null;
      repaint();
    },
    undo: () => {
      shapesRef.current.pop();
      repaint();
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
  // Left-panel comparison source. "original" = Chrome HTML render (ground
  // truth — what the post-fix Slides render is supposed to match), "baseline"
  // = main's pre-fix Slides render (regression check). Default to "original"
  // because the primary question on a fix review is "does the post-fix
  // render match the spec?", not "did anything regress vs the prior bad
  // render?". Toggle the checkbox to switch.
  const [leftSource, setLeftSource] = useState("original");

  const origRef = useRef(null);
  const slidesRef = useRef(null);
  const drawRef = useRef(null);
  const diffRef = useRef(null);
  const renderedOverlayRef = useRef(null);
  const origOverlayRef = useRef(null);
  const colorRef = useRef(null);
  const sizeRef = useRef(null);
  const toolRef = useRef(null);
  const padRef = useRef(null);

  // Drawing canvas seed: prefer this task's saved annotation (the user
  // came back after rating Bad and we restore their strokes). Fall back
  // to the bug-context annotation from the prior SxS — those red marks
  // ARE the spec for what's wrong, so they belong on the image
  // immediately, not behind a "[annotation]" link.
  const savedAnnot = s.annotationPng
    ? "/img?path=" + encodeURIComponent(s.annotationPng) + "&t=" + Date.now()
    : (s.originalAnnotationPng
        ? "/img?path=" + encodeURIComponent(s.originalAnnotationPng) + "&t=" + Date.now()
        : null);
  const handle = useDrawingCanvas(drawRef, slidesRef, savedAnnot, drawMode, toolRef, colorRef, sizeRef);
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

  // Magnifier loupe. Listens at the DOCUMENT level so the draw-canvas's
  // pointer-events:auto (when drawMode is on) can't block it — previous
  // version bound mousemove on the panel and stopped working the moment
  // you toggled Draw. Detects which image to magnify by hit-testing the
  // cursor against the natural-resolution bounding rects of the per-card
  // <img> refs. Uses backgroundImage so we don't re-blit per mousemove.
  useEffect(() => {
    if (!loupe) return;
    const size = 240;
    const targets = [
      { img: origRef.current,   srcPath: s.original },
      { img: slidesRef.current, srcPath: s.rendered },
    ].filter((t) => t.img && t.srcPath);
    if (targets.length === 0) return () => {};
    const lens = document.getElementById("loupe");
    if (!lens) return () => {};
    const onMove = (e) => {
      for (const { img, srcPath } of targets) {
        const r = img.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right) continue;
        if (e.clientY < r.top  || e.clientY > r.bottom) continue;
        const nx = ((e.clientX - r.left) / r.width)  * img.naturalWidth;
        const ny = ((e.clientY - r.top)  / r.height) * img.naturalHeight;
        const srcUrl = "/img?path=" + encodeURIComponent(srcPath);
        lens.style.display = "block";
        lens.style.left = (e.clientX - size / 2) + "px";
        lens.style.top  = (e.clientY - size / 2) + "px";
        lens.style.width  = size + "px";
        lens.style.height = size + "px";
        lens.style.backgroundImage = "url(" + srcUrl + ")";
        lens.style.backgroundSize = (img.naturalWidth * loupeZoom) + "px " + (img.naturalHeight * loupeZoom) + "px";
        lens.style.backgroundPosition = \`-\${nx * loupeZoom - size / 2}px -\${ny * loupeZoom - size / 2}px\`;
        return;
      }
      lens.style.display = "none";
    };
    document.addEventListener("mousemove", onMove, true); // capture so canvas can't swallow
    return () => {
      document.removeEventListener("mousemove", onMove, true);
      if (lens) lens.style.display = "none";
    };
  }, [loupe, loupeZoom, s.id, s.original, s.rendered]);

  const rate = useCallback(async (status) => {
    setSaving(true);
    try {
      const hasShapes = handle.hasStrokes();
      const annotation = hasShapes ? handle.toDataURL() : undefined;
      const shapes = hasShapes ? handle.shapes() : undefined;
      const canvasSize = hasShapes ? handle.canvasSize() : undefined;
      const padding = padRef.current ? parseInt(padRef.current.value, 10) || 0 : 20;
      const resp = await fetch("/api/rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: s.id, status,
          comment: (comment || "").trim() || undefined,
          annotation,
          shapes,
          canvasSize,
          pencilPadding: padding,
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
      h("label", { title: "Tool: ✏ pencil strokes (zoom-crop = stroke bbox + pencil padding) vs ▭ rectangle (zoom-crop = rect itself, no padding)" },
        " tool ",
        h("select", { ref: toolRef, defaultValue: "pencil" },
          h("option", { value: "pencil" }, "✏ pencil"),
          h("option", { value: "rect" }, "▭ rectangle"),
        ),
      ),
      h("input", { type: "color", ref: colorRef, defaultValue: "#e94560" }),
      h("label", null,
        h("input", { type: "range", ref: sizeRef, min: "2", max: "20", defaultValue: "6" }),
        " px",
      ),
      h("label", { title: "Padding (in input pixels) added around each PENCIL annotation's bbox when generating zoom-crops. Rectangle annotations are NOT padded — the rect IS the crop." },
        " pencil padding ",
        h("input", { type: "number", ref: padRef, min: "0", max: "200", defaultValue: "20", style: "width:60px" }),
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
    s.zoomCrops && s.zoomCrops.length > 0 &&
      h("div", { class: "zoom-crops" },
        h("div", { class: "zoom-crops-label" },
          "🔍 Zoom-ins of marked region (" + s.zoomCrops.length + " crop(s) — pencil padded, rectangle untouched):",
        ),
        h("div", { class: "zoom-crops-row" },
          s.zoomCrops.map((p) => {
            const m = p.match(/-(rendered|original)\.png$/);
            const role = m ? m[1] : "crop";
            return h("figure", { class: "zoom-crop" },
              h("figcaption", null, role + " · " + (p.split("/").pop() || "")),
              h("img", { src: "/img?path=" + encodeURIComponent(p) + "&t=" + Date.now() }),
            );
          }),
        ),
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
  .zoom-crops { margin-top: 10px; padding: 10px 12px; background: #0e1f2e; border-left: 4px solid #3498db; border-radius: 0 6px 6px 0; }
  .zoom-crops-label { font-size: 13px; color: #cfe4f7; margin-bottom: 8px; }
  .zoom-crops-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .zoom-crop { margin: 0; background: #050a0e; padding: 6px; border-radius: 4px; }
  .zoom-crop figcaption { color: #7dafd5; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .zoom-crop img { display: block; max-width: 100%; max-height: 380px; image-rendering: pixelated; border: 1px solid #1f2933; }
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

  const server: Server = createServer((req, res) => {
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
          const { id, status, comment, annotation, shapes, canvasSize, pencilPadding } = JSON.parse(body);
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
            const annotBytes = Buffer.from(b64, "base64");
            writeFileSync(annotPath, annotBytes);
            entry.annotation = annotPath;

            // Generate zoom-crops PER ANNOTATION. The client sends a typed
            // shape list (kind: "pencil"|"rect" + bbox in canvas coords).
            // Pencil shapes get padded by `pencilPadding` (default 20px);
            // rectangle shapes get NO padding — the rect IS the crop.
            // Each annotation produces one crop per side (rendered +
            // original), saved as `<slide>-<idx>-rendered.png` etc., so
            // the UI can show them all and the worker prompt downstream
            // can attach each one independently.
            const zoomDir = join(dirname(args.ratings_file!), "zoom-crops");
            try {
              // First, wipe any pre-existing crops for this slide so a
              // re-rate with fewer shapes doesn't leave stale ones around.
              if (existsSync(zoomDir)) {
                for (const f of readdirSync(zoomDir)) {
                  if (f === `${id}.png` || f.startsWith(`${id}-`)) {
                    try { unlinkSync(join(zoomDir, f)); } catch { /* swallow */ }
                  }
                }
              }
            } catch { /* swallow */ }
            const padPx = typeof pencilPadding === "number" ? pencilPadding : 20;
            const canvasW = canvasSize?.w || 0;
            const canvasH = canvasSize?.h || 0;
            const shapeList = Array.isArray(shapes) && canvasW > 0 && canvasH > 0
              ? shapes
              : null;

            // Fallback path: no explicit shape list (old clients). Crop
            // the whole annotation bbox with padding=20.
            const useFallback = !shapeList || shapeList.length === 0;
            try {
              mkdirSync(zoomDir, { recursive: true });
              const renderedPath = join(args.thumbnails, `${id}.png`);
              const originalPath = join(args.originals, `${id}.png`);
              const writeCrop = (
                idx: number, side: "rendered" | "original",
                srcPath: string, bbox: { x: number; y: number; w: number; h: number; canvasW: number; canvasH: number },
              ) => {
                if (!existsSync(srcPath)) return;
                const out = zoomCropPng(readFileSync(srcPath), bbox);
                writeFileSync(join(zoomDir, `${id}-${String(idx).padStart(2, "0")}-${side}.png`), out);
              };
              if (useFallback) {
                const bb = annotationBbox(annotBytes, padPx, 8);
                if (bb) {
                  writeCrop(1, "rendered", renderedPath, bb);
                  writeCrop(1, "original", originalPath, bb);
                  // eslint-disable-next-line no-console
                  console.log(`  zoom-crops: ${id} 1 fallback bbox → ${zoomDir}/`);
                }
              } else {
                let written = 0;
                for (let i = 0; i < shapeList.length; i++) {
                  const sh = shapeList[i];
                  if (typeof sh?.x !== "number" || typeof sh?.y !== "number") continue;
                  const pad = sh.kind === "pencil" ? padPx : 0;
                  const x = Math.max(0, Math.round(sh.x - pad));
                  const y = Math.max(0, Math.round(sh.y - pad));
                  const w = Math.min(canvasW - x, Math.round(sh.w + 2 * pad));
                  const h = Math.min(canvasH - y, Math.round(sh.h + 2 * pad));
                  if (w <= 1 || h <= 1) continue;
                  const bb = { x, y, w, h, canvasW, canvasH };
                  writeCrop(i + 1, "rendered", renderedPath, bb);
                  writeCrop(i + 1, "original", originalPath, bb);
                  written++;
                }
                // eslint-disable-next-line no-console
                console.log(`  zoom-crops: ${id} ${written} shapes (padPx=${padPx}) → ${zoomDir}/`);
              }
            } catch (e: unknown) {
              // eslint-disable-next-line no-console
              console.warn(`  zoom-crops failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
            }
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

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(args.port, () => {
      server.removeListener("error", rejectListen);
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
      resolveListen();
    });
  });

  return {
    port: args.port,
    url: `http://localhost:${args.port}`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((err) => err ? rejectClose(err) : resolveClose());
    }),
  };
}
