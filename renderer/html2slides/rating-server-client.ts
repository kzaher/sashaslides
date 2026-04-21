/**
 * Browser-side rating UI, written as Preact components so reveal toggles,
 * draw state, and "show diff"/"highlight rendered" preferences survive the
 * per-navigation re-render. The previous imperative version rebuilt the
 * entire DOM via innerHTML on every render(), which worked but made
 * extending the UI (per-card reveals, persistent overlays) risky.
 *
 * Pattern mirrors structured-prompting/src/server-client.ts: ship as a
 * single string that rating-server.ts concatenates into the HTML
 * response; no bundler, two ESM imports from esm.sh.
 */

export const CLIENT_SCRIPT = `
import { h, render } from "https://esm.sh/preact@10";
import { useState, useEffect, useMemo, useRef, useCallback } from "https://esm.sh/preact@10/hooks";

// ---- helpers --------------------------------------------------------------
function humanizeAge(ms) {
  if (ms == null) return "never";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return (s / 3600).toFixed(1) + "h ago";
  return (s / 86400).toFixed(1) + "d ago";
}

function isComparisonVisible(c, showAll) {
  if (showAll) return true;
  return c.status !== "good" || (c.diffStatus && c.diffStatus !== "ok");
}

// ---- drawing canvas hook --------------------------------------------------
// Encapsulates the imperative drawing surface: pointer capture, stroke
// history, undo, annotation bootstrap from a saved PNG. Returns imperative
// handles that the parent component calls on rate() and on toolbar actions.
function useDrawingCanvas(canvasRef, imgRef, savedAnnotationUrl, drawMode) {
  const historyRef = useRef([]);
  const strokesRef = useRef(false);
  const drawModeRef = useRef(drawMode);
  drawModeRef.current = drawMode;

  // Re-init on every new slide. Sizing follows naturalWidth so the saved
  // PNG lines up pixel-perfect with the source render.
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
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
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
      const colorEl = document.getElementById("drawColor");
      const sizeEl = document.getElementById("drawSize");
      ctx.strokeStyle = colorEl ? colorEl.value : "#e94560";
      const baseW = sizeEl ? parseFloat(sizeEl.value) : 6;
      ctx.lineWidth = baseW * (canvas.width / canvas.getBoundingClientRect().width);
      const p = getPos(e);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
    };
    const onMove = (e) => {
      if (!drawing) return;
      const ctx = canvas.getContext("2d");
      const p = getPos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
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

// ---- rendered-regions overlay (imperative, image-load driven) -------------
function RenderedOverlay({ canvasRef, imgRef, regions, show }) {
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const init = () => {
      canvas.width = img.naturalWidth || img.clientWidth;
      canvas.height = img.naturalHeight || img.clientHeight;
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!show || !regions || regions.length === 0) return;
      ctx.fillStyle = "rgb(128,128,128)";
      for (const r of regions) {
        ctx.fillRect(r.x * canvas.width, r.y * canvas.height, r.w * canvas.width, r.h * canvas.height);
      }
    };
    if (img.complete && img.naturalWidth) init();
    else img.addEventListener("load", init, { once: true });
  }, [show, regions]);
  return null;
}

// ---- client-side diff canvas ----------------------------------------------
// Computes the per-pixel diff between the two currently-shown <img>s at a
// shared 1600x900 grid and paints a red overlay on the original panel.
function useClientSideDiff(origImgRef, slidesImgRef, diffCanvasRef, enabled, comparisonId) {
  useEffect(() => {
    if (!enabled) return;
    const o = origImgRef.current;
    const s = slidesImgRef.current;
    const d = diffCanvasRef.current;
    if (!o || !s || !d) return;
    const wait = (img) => new Promise((r) => {
      if (img.complete && img.naturalWidth) r();
      else img.addEventListener("load", () => r(), { once: true });
    });
    let cancelled = false;
    Promise.all([wait(o), wait(s)]).then(() => {
      if (cancelled) return;
      const WORK_W = 1600, WORK_H = 900, THRESHOLD = 10;
      const ac = document.createElement("canvas");
      ac.width = WORK_W; ac.height = WORK_H;
      const actx = ac.getContext("2d");
      actx.drawImage(o, 0, 0, WORK_W, WORK_H);
      const aData = actx.getImageData(0, 0, WORK_W, WORK_H).data;
      const bc = document.createElement("canvas");
      bc.width = WORK_W; bc.height = WORK_H;
      const bctx = bc.getContext("2d");
      bctx.drawImage(s, 0, 0, WORK_W, WORK_H);
      const bData = bctx.getImageData(0, 0, WORK_W, WORK_H).data;
      d.width = WORK_W; d.height = WORK_H;
      const octx = d.getContext("2d");
      const diffImg = octx.createImageData(WORK_W, WORK_H);
      const dData = diffImg.data;
      let count = 0;
      for (let i = 0; i < aData.length; i += 4) {
        const dr = Math.abs(aData[i] - bData[i]);
        const dg = Math.abs(aData[i + 1] - bData[i + 1]);
        const db = Math.abs(aData[i + 2] - bData[i + 2]);
        if (dr + dg + db > THRESHOLD) {
          dData[i] = 255; dData[i + 1] = 0; dData[i + 2] = 0; dData[i + 3] = 200;
          count++;
        }
      }
      octx.putImageData(diffImg, 0, 0);
      console.log("client diff: " + count + " pixels");
    });
    return () => { cancelled = true; };
  }, [enabled, comparisonId]);
}

// ---- slide pair -----------------------------------------------------------
function SlidePair(props) {
  const { comparison, showDiff, showRendered, drawMode, drawHandleRef } = props;
  const origRef = useRef(null);
  const slidesRef = useRef(null);
  const diffRef = useRef(null);
  const drawRef = useRef(null);
  const renderedRef = useRef(null);
  const savedAnnotation = comparison.annotationPng
    ? "/img?path=" + encodeURIComponent(comparison.annotationPng) + "&t=" + Date.now()
    : null;

  const handle = useDrawingCanvas(drawRef, slidesRef, savedAnnotation, drawMode);
  drawHandleRef.current = handle;

  useClientSideDiff(origRef, slidesRef, diffRef, showDiff, comparison.id);

  return h("div", { class: "slide-pair", id: "pair" },
    h("div", { class: "panel original" },
      h("img", {
        id: "originalImg",
        ref: origRef,
        src: "/img?path=" + encodeURIComponent(comparison.originalPng),
      }),
      showDiff && h("canvas", { class: "diff-overlay", id: "diffCanvas", ref: diffRef }),
    ),
    h("div", { class: "panel slides" },
      h("img", {
        id: "slidesImg",
        ref: slidesRef,
        src: "/img?path=" + encodeURIComponent(comparison.slidesPng),
      }),
      comparison.renderedRegions && comparison.renderedRegions.length > 0
        && h("canvas", { class: "rendered-overlay", id: "renderedOverlay", ref: renderedRef }),
      h("canvas", { id: "drawCanvas", ref: drawRef }),
    ),
    h(RenderedOverlay, {
      canvasRef: renderedRef,
      imgRef: slidesRef,
      regions: comparison.renderedRegions,
      show: showRendered,
    }),
  );
}

// ---- banners --------------------------------------------------------------
function RegressionBanner({ comparison }) {
  if (comparison.diffStatus !== "regressed") return null;
  return h("div", { class: "regression-banner" },
    "⚠ REGRESSION — this slide was previously blessed as a golden but now diverges from it by " +
    (comparison.diffPixels || 0) + " pixels. Check the yellow diff panel on the right.");
}

function RenderedBanner({ comparison }) {
  const regs = comparison.renderedRegions;
  if (!regs || regs.length === 0) return null;
  const kinds = {};
  for (const r of regs) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
  const kindStr = Object.keys(kinds).map((k) => k + "×" + kinds[k]).join(", ");
  return h("div", { class: "rendered-banner" },
    "⚠ RENDERED CONTENT — " + regs.length + " region(s) emitted as rasterized image(s) instead of native Slides primitives.",
    h("span", { class: "kinds" }, "(" + kindStr + ") — toggle \\"Highlight rendered regions\\" to see them."));
}

// ---- draw toolbar ---------------------------------------------------------
function DrawToolbar(props) {
  const { showDiff, setShowDiff, showRendered, setShowRendered, drawMode, setDrawMode, onClear } = props;
  return h("div", { class: "draw-toolbar" },
    h("label", { style: "display:flex; gap:6px; align-items:center; cursor:pointer;" },
      h("input", {
        type: "checkbox",
        checked: showDiff,
        onChange: (e) => setShowDiff(e.target.checked),
      }),
      " Show diff at full size (hide small diff panel)",
    ),
    h("span", { style: "width: 24px;" }),
    h("label", {
      style: "display:flex; gap:6px; align-items:center; cursor:pointer;",
      title: "Brightens rasterized regions on the Slides render by adding 128 to all RGB channels (via plus-lighter blend)",
    },
      h("input", {
        type: "checkbox",
        checked: showRendered,
        onChange: (e) => setShowRendered(e.target.checked),
      }),
      " Highlight rendered regions (+128 channels)",
    ),
    h("span", { style: "width: 24px;" }),
    h("span", null, "Draw on Slides render:"),
    h("button", {
      id: "drawToggle",
      class: drawMode ? "active" : "",
      onClick: () => setDrawMode(!drawMode),
    }, "Draw"),
    h("input", { type: "color", id: "drawColor", defaultValue: "#e94560" }),
    h("label", null,
      h("input", { type: "range", id: "drawSize", min: "2", max: "20", defaultValue: "6" }),
      " px",
    ),
    h("button", { onClick: onClear }, "Clear"),
  );
}

// ---- nav ------------------------------------------------------------------
function Nav({ comparisons, currentIdx, onSelect, showAll }) {
  return h("div", { class: "nav" },
    comparisons.map((c, i) => {
      if (!isComparisonVisible(c, showAll)) return null;
      const cls = (i === currentIdx ? "current " : "") +
        "status-" + c.status + " diff-" + (c.diffStatus || "none");
      return h("a", {
        key: c.id,
        href: "#",
        class: cls,
        onClick: (e) => { e.preventDefault(); onSelect(i); },
      }, c.id.replace("slide_", "S"));
    }),
  );
}

// ---- golden report --------------------------------------------------------
function GoldenReport() {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    fetch("/api/summary").then((r) => r.json()).then(setSummary).catch(() => {});
  }, []);
  if (!summary) return h("div", { id: "goldenReport" });
  const age = summary.oldestRenderMs != null
    ? humanizeAge(summary.nowMs - summary.oldestRenderMs)
    : "no render yet";
  return h("div", { id: "goldenReport" },
    h("b", null, "Goldens report"), " — ",
    summary.matching + "/" + summary.goldenTotal + " goldens still pixel-match current render",
    summary.regressed
      ? h("span", null, " · ", h("span", { style: "color:#e94560" }, summary.regressed + " regressed"))
      : null,
    summary.new
      ? h("span", null, " · ", h("span", { style: "color:#8e44ad" }, summary.new + " new (never blessed)"))
      : null,
    " · oldest current-render thumbnail: " + age + " (proves re-scrape)",
  );
}

// ---- app root -------------------------------------------------------------
function App() {
  const [comparisons, setComparisons] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showRendered, setShowRendered] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [comment, setComment] = useState("");
  const drawHandleRef = useRef(null);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/comparisons");
    const data = await r.json();
    setComparisons(data);
    return data;
  }, []);

  useEffect(() => {
    refresh().then((data) => {
      // Auto-select: first visible pending, or first visible.
      const visible = data.filter((c) => isComparisonVisible(c, false));
      const pending = visible.find((c) => c.status === "pending");
      const target = pending || visible[0];
      const idx = target ? data.findIndex((x) => x.id === target.id) : 0;
      setCurrentIdx(idx >= 0 ? idx : 0);
    });
  }, []);

  const current = comparisons[currentIdx];

  // Sync the comment textarea with the current slide's persisted comment.
  useEffect(() => {
    if (current) setComment(current.comment || "");
  }, [current && current.id]);

  const visible = useMemo(
    () => comparisons.filter((c) => isComparisonVisible(c, showAll)),
    [comparisons, showAll],
  );

  const navigate = useCallback((delta) => {
    if (visible.length === 0) return;
    const curId = current && current.id;
    let vIdx = visible.findIndex((c) => c.id === curId);
    if (vIdx < 0) vIdx = 0;
    vIdx = Math.max(0, Math.min(visible.length - 1, vIdx + delta));
    const newIdx = comparisons.findIndex((x) => x.id === visible[vIdx].id);
    setCurrentIdx(newIdx);
  }, [visible, current, comparisons]);

  const rate = useCallback(async (status) => {
    if (!current) return;
    const trimmed = comment.trim();
    const handle = drawHandleRef.current;
    const annotation = handle && handle.hasStrokes() ? handle.toDataURL() : undefined;
    await fetch("/api/rate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: current.id, status,
        comment: trimmed || undefined,
        annotation,
      }),
    });
    // Patch the local comparison so the badge + nav class updates
    // immediately without another round-trip.
    setComparisons((prev) => prev.map((c) =>
      c.id === current.id ? { ...c, status, comment: trimmed || undefined } : c
    ));
    navigate(1);
  }, [current, comment, navigate]);

  // Keyboard shortcuts — effect reattaches whenever rate/navigate close
  // over new state so the handler always sees the current slide.
  useEffect(() => {
    const onKey = (e) => {
      const commentEl = document.getElementById("commentBox");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        drawHandleRef.current && drawHandleRef.current.undo();
        e.preventDefault();
        return;
      }
      if (document.activeElement === commentEl) {
        if (e.key === "Escape") { commentEl.blur(); e.preventDefault(); }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { rate("bad"); e.preventDefault(); }
        return;
      }
      if (e.key === "ArrowRight" || e.key === "n") navigate(1);
      else if (e.key === "ArrowLeft" || e.key === "p") navigate(-1);
      else if (e.key === "g") rate("good");
      else if (e.key === "b") { commentEl && commentEl.focus(); e.preventDefault(); }
      else if (e.key === "Enter") {
        const t = (commentEl && commentEl.value || "").trim();
        if (t) rate("bad");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rate, navigate]);

  if (!current) {
    return h("div", { class: "header" }, h("h1", null, "loading…"));
  }

  // Stats
  const good = comparisons.filter((c) => c.status === "good").length;
  const bad = comparisons.filter((c) => c.status === "bad").length;
  const pending = comparisons.filter((c) => c.status === "pending").length;

  // Badges
  const badge = h("span", { class: "status-badge status-" + current.status }, current.status);
  let diffBadge = null;
  if (current.diffStatus) {
    const diffClass = current.diffStatus === "ok" ? "good" : current.diffStatus;
    diffBadge = h("span", { class: "status-badge status-" + diffClass },
      "⚠ " + current.diffStatus.toUpperCase() +
      (current.diffPixels ? " · " + current.diffPixels + "px" : ""));
  }

  const visIdx = visible.findIndex((x) => x.id === current.id);

  return h("div", null,
    h("div", { class: "header" },
      h("h1", null, "html2slides Fidelity Rating"),
      h("div", { class: "stats" }, good + " good / " + bad + " bad / " + pending + " pending"),
    ),
    h(RegressionBanner, { comparison: current }),
    h(RenderedBanner, { comparison: current }),
    h(Nav, { comparisons, currentIdx, onSelect: setCurrentIdx, showAll }),
    h("div", { class: "labels" },
      h("span", null, "Original HTML"),
      h("span", null, "Google Slides"),
    ),
    h(SlidePair, { comparison: current, showDiff, showRendered, drawMode, drawHandleRef }),
    h(DrawToolbar, {
      showDiff, setShowDiff,
      showRendered, setShowRendered,
      drawMode, setDrawMode,
      onClear: () => drawHandleRef.current && drawHandleRef.current.clear(),
    }),
    h("div", { class: "slide-id" },
      current.id, " ", badge, " ", diffBadge,
      " (" + (visIdx >= 0 ? visIdx + 1 : "-") + "/" + visible.length + " visible, " +
        comparisons.length + " total — ",
      showAll
        ? h("a", { href: "#", onClick: (e) => { e.preventDefault(); setShowAll(false); } }, "only diffs")
        : h("a", { href: "#", onClick: (e) => { e.preventDefault(); setShowAll(true); } }, "show all"),
      ")",
    ),
    h("div", { class: "slide-links" },
      current.htmlFile && h("a", {
        href: "/html?path=" + encodeURIComponent(current.htmlFile),
        target: "_blank",
      }, "View HTML Source"),
      current.slidesUrl && h("a", { href: current.slidesUrl, target: "_blank" },
        "Open in Google Slides"),
    ),
    h("div", { class: "comment-box" },
      h("textarea", {
        id: "commentBox",
        placeholder: "What's wrong? (optional — saved with Bad ratings)",
        rows: 2,
        value: comment,
        onInput: (e) => setComment(e.target.value),
      }),
    ),
    h("div", { class: "actions" },
      h("button", { class: "btn btn-good", onClick: () => rate("good") }, "Good ✓"),
      h("button", { class: "btn btn-bad", onClick: () => rate("bad") }, "Bad ✗"),
      h("button", { class: "btn btn-skip", onClick: () => navigate(1) }, "Skip →"),
    ),
    current.comment && h("div", { class: "saved-comment" },
      h("div", { class: "label" }, "Comment"),
      current.comment,
    ),
    current.analysis && h("div", { class: "analysis" }, current.analysis),
    h(GoldenReport, null),
  );
}

render(h(App), document.body);
`;
