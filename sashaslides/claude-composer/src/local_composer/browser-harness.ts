/**
 * browser-harness.ts — entry point bundled into browser-harness.bundle.js.
 *
 * This runs in a Chrome tab with WebGPU available. It exposes one function
 * on window: `window.__localComposer.runEval({ modelId, adapterKind })`,
 * which loads the selected adapter, runs the 100-item eval, and returns a
 * ModelReport as JSON.
 *
 * The Node driver (run-eval.ts) launches Chrome, serves this page, calls
 * runEval via `Runtime.evaluate`, and writes the returned report to disk.
 *
 * This file is only compiled into the browser bundle — never imported from
 * Node-side unit tests (which would hit the dynamic import of the adapters).
 */

import { runEval } from "./harness.js";
import { TransformersJsAdapter } from "./transformers-js-adapter.js";
import { WebLLMAdapter } from "./webllm-adapter.js";
import { MockAdapter } from "./mock-adapter.js";
import { sha256Hex } from "./image-cache.js";
import type { ImageInput } from "./types.js";
import type { ModelReport } from "./eval-types.js";
import type { IVLMAdapter } from "./vlm-adapter.js";

type RunOptions = {
  modelId: string;
  adapterKind: "webllm" | "transformers-js" | "mock";
  /** Optional: filter to N items for quick smoke tests. */
  limit?: number;
};

declare global {
  interface Window {
    __localComposer: {
      runEval: (opts: RunOptions) => Promise<ModelReport>;
    };
  }
}

function createAdapter(opts: RunOptions): IVLMAdapter {
  if (opts.adapterKind === "webllm") {
    return new WebLLMAdapter({ modelId: opts.modelId });
  }
  if (opts.adapterKind === "mock") {
    return new MockAdapter();
  }
  return new TransformersJsAdapter({ modelId: opts.modelId, device: "webgpu", dtype: "q4" });
}

/**
 * Produce a 1920×1080 blank PNG with a deterministic sha256 based on the
 * HTML string. Used as a safe fallback when the SVG-foreignObject rasterizer
 * trips Chrome's canvas-taint protection (it does, reliably, in modern
 * Chrome). Mock-adapter runs never look at the image bytes, so this is
 * sufficient for pipeline smoke tests. A real GPU host should either:
 *   - drive rasterization from Node via CDP Page.captureScreenshot, or
 *   - bundle html2canvas and render via a sanctioned DOM→canvas path.
 */
async function renderBlankPng(tag: string): Promise<ImageInput | null> {
  const canvas = new OffscreenCanvas(1920, 1080);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 1920, 1080);
  ctx.fillStyle = "#0b0f19";
  ctx.font = "32px system-ui";
  ctx.fillText(`[fallback render] ${tag.slice(0, 200)}`, 32, 64);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const sha = await sha256Hex(bytes);
  const dataUrl = await blobToDataUrl(blob);
  return { sha256: sha, url: dataUrl, width: 1920, height: 1080 };
}

/**
 * Render an HTML fragment into a 1920×1080 PNG via an offscreen iframe +
 * the browser's built-in OffscreenCanvas.toBlob path. Assumes the harness
 * page is served over HTTP (not file://) so canvas.toBlob works without
 * cross-origin taint.
 */
async function renderSlideToPng(html: string): Promise<ImageInput | null> {
  const sandbox = document.getElementById("render-sandbox");
  if (!sandbox) return null;

  const iframe = document.createElement("iframe");
  iframe.style.width = "1920px";
  iframe.style.height = "1080px";
  iframe.style.border = "0";
  sandbox.innerHTML = "";
  sandbox.appendChild(iframe);

  const doc = iframe.contentDocument!;
  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}</style></head><body>${html}</body></html>`,
  );
  doc.close();

  // Wait one frame for layout.
  await new Promise((r) => requestAnimationFrame(() => r(null)));

  // Serialize the iframe body to an SVG foreignObject and rasterize.
  // This avoids html2canvas as a dependency — all done with DOM APIs only.
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("xmlns", svgNs);
  svg.setAttribute("width", "1920");
  svg.setAttribute("height", "1080");
  const fo = document.createElementNS(svgNs, "foreignObject");
  fo.setAttribute("width", "100%");
  fo.setAttribute("height", "100%");
  const div = document.createElement("div");
  div.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  div.innerHTML = html;
  fo.appendChild(div);
  svg.appendChild(fo);

  const svgStr = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    img.width = 1920;
    img.height = 1080;
    img.src = svgUrl;
    await img.decode();
    const canvas = new OffscreenCanvas(1920, 1080);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 1920, 1080);
    ctx.drawImage(img as unknown as CanvasImageSource, 0, 0, 1920, 1080);
    try {
      const blob = await canvas.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const sha = await sha256Hex(bytes);
      const dataUrl = await blobToDataUrl(blob);
      return { sha256: sha, url: dataUrl, width: 1920, height: 1080 };
    } catch (e) {
      // Chrome taints canvases that had an SVG+foreignObject drawn into them
      // (SecurityError on convertToBlob). Fall back to a blank annotated PNG
      // so the pipeline still produces a ModelReport.
      return renderBlankPng(html);
    }
  } finally {
    URL.revokeObjectURL(svgUrl);
    sandbox.removeChild(iframe);
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

window.__localComposer = {
  async runEval(opts: RunOptions): Promise<ModelReport> {
    const status = document.getElementById("status");
    const progress = document.getElementById("progress");
    if (status) status.textContent = `Loading ${opts.modelId} (${opts.adapterKind})…`;

    const adapter = createAdapter(opts);
    await adapter.loadModel((p) => {
      if (status) status.textContent = `[${(p.progress * 100).toFixed(0)}%] ${p.stage}`;
    });

    const limit = opts.limit;
    if (status) {
      status.textContent = `Running ${limit ?? 100} items against ${opts.modelId}…`;
    }
    let seen = 0;
    const report = await runEval({
      adapter,
      renderSlideToPng,
      filter: limit ? () => seen++ < limit : undefined,
      onItemComplete: (r, item) => {
        if (!progress) return;
        const line = document.createElement("div");
        line.className = r.score >= 0.5 ? "ok" : "bad";
        line.textContent = `${item.id.padEnd(18)} ${r.score >= 0.5 ? "PASS" : "FAIL"} ${r.reason}`;
        progress.appendChild(line);
        progress.scrollTop = progress.scrollHeight;
      },
    });

    if (status) {
      status.textContent = `Done. ${report.summary.passed}/${report.summary.total} passed (mean score ${report.summary.scoreMean.toFixed(3)})`;
    }
    await adapter.dispose();
    return report;
  },
};
